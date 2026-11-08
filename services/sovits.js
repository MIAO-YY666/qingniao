// ============================================================
// sovits.js —— GPT-SoVITS 推理服务（api_v2）的生命周期管理
// ------------------------------------------------------------
// 为什么需要单独一层：api_v2 是一个吃显存的 Python 服务（实测 2.6GB），
// 和 ComfyUI 共用 8GB 卡。常驻不划算，所以做成 **按需拉起 + 空闲关停**：
//   · 合成前 ensureUp()：端口没通就 spawn，轮询 /docs 直到就绪（模型加载约 25-40s）
//   · 每次合成都 touch()，空闲超过 idleStopMin 就关掉，把显存还给生图
//
// 纪律（都来自踩过的坑）：
//   1. 必须清 NO_PROXY —— 这台机器全局设了 HTTP_PROXY，Python 的 urllib
//      会把 127.0.0.1 也塞进代理，导致"连不上自己"
//   2. 必须带 PYTHONPATH —— text/module 包在 GPT_SoVITS/ 下，不在仓库根
//   3. 必须把 ffmpeg 目录加进 PATH —— 2-get-hubert 与部分推理路径会调命令行 ffmpeg
//   4. 关停只杀自己启动的 PID，并且先校验进程名是 python.exe
//      （按端口找 PID 会误杀用户手动开的 ComfyUI，这条教训已经吃过一次）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const DEFAULT_PORT = 9880;
const READY_TIMEOUT_MS = 180000;

export function createSovits({ root, suite, log }) {
  const cfg = suite?.tts?.sovits || {};
  const base = path.join(root, cfg.repo || path.join('tools', 'gptsovits', 'GPT-SoVITS'));
  const py = path.resolve(root, cfg.python || path.join('tools', 'gptsovits', '.venv', 'Scripts', 'python.exe'));
  const configFile = path.join(base, cfg.configFile || path.join('GPT_SoVITS', 'configs', 'tts_infer_bloom.yaml'));
  const port = Number(cfg.port || DEFAULT_PORT);
  const ffmpegDir = path.dirname(suite?.paths?.ffmpeg || 'D:\\tools\\ffmpeg\\bin\\ffmpeg.exe');
  const idleStopMin = Number(cfg.idleStopMin ?? 10);

  let child = null;
  let pid = null;
  let starting = null; // Promise，避免并发起多个
  let idleTimer = null;
  let lastUse = 0;

  const url = (p) => `http://127.0.0.1:${port}${p}`;

  async function probe(timeoutMs = 1500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url('/docs'), { signal: ctrl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  function spawnServer() {
    const env = {
      ...process.env,
      // 别让全局代理把 127.0.0.1 也代理走
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      PYTHONPATH: [base, path.join(base, 'GPT_SoVITS'), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      PATH: [ffmpegDir, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    };
    child = spawn(py, ['api_v2.py', '-c', configFile, '-a', '127.0.0.1', '-p', String(port)], {
      cwd: base,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    pid = child.pid || null;
    let tail = '';
    const keep = (d) => {
      tail = (tail + d.toString()).slice(-2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => {
      log?.(`[sovits] 推理进程退出 code=${code}`);
      if (code !== 0 && tail) log?.(`[sovits] 末尾输出：${tail.slice(-400)}`);
      child = null;
      pid = null;
    });
    log?.(`[sovits] 启动推理服务 pid=${pid} port=${port}`);
  }

  async function ensureUp() {
    if (await probe()) return true;
    if (starting) return starting;
    if (!fs.existsSync(py)) {
      log?.(`[sovits] 缺少 Python：${py}`);
      return false;
    }
    if (!fs.existsSync(configFile)) {
      log?.(`[sovits] 缺少推理配置：${configFile}`);
      return false;
    }
    starting = (async () => {
      spawnServer();
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await probe(1200)) {
          log?.(`[sovits] 就绪（${((Date.now() - (deadline - READY_TIMEOUT_MS)) / 1000).toFixed(0)}s）`);
          touch();
          return true;
        }
        if (!child && !pid) break; // 进程已退出
      }
      log?.('[sovits] 启动超时');
      return false;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function touch() {
    lastUse = Date.now();
    clearIdle();
    if (!(idleStopMin > 0)) return;
    idleTimer = setTimeout(() => {
      log?.(`[sovits] 空闲 ${idleStopMin} 分钟，关停推理服务释放显存`);
      stop().catch(() => {});
    }, idleStopMin * 60000);
    if (idleTimer.unref) idleTimer.unref();
  }

  function imageOf(targetPid) {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', `PID eq ${targetPid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve('');
        const m = stdout.match(/^"([^"]+)"/);
        resolve(m ? m[1] : '');
      });
    });
  }

  async function stop() {
    clearIdle();
    const target = pid;
    if (!target) return { ok: true, note: '未在运行' };
    const img = await imageOf(target);
    // 只杀自己起的 python；进程名不对说明 PID 被复用，宁可不杀
    if (img && !/^python/i.test(img)) {
      log?.(`[sovits] 拒绝关停：PID ${target} 现在是 ${img}，疑似被复用`);
      pid = null;
      return { ok: false, note: `PID ${target} 已被 ${img} 复用，未执行` };
    }
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(target), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    log?.(`[sovits] 已关停 pid=${target}`);
    child = null;
    pid = null;
    return { ok: true };
  }

  async function status() {
    const up = await probe();
    return {
      up,
      pid,
      port,
      idleStopMin,
      idleMs: lastUse ? Date.now() - lastUse : null,
      python: fs.existsSync(py),
      config: fs.existsSync(configFile),
      repo: base
    };
  }

  return { ensureUp, stop, status, probe, touch, port };
}

export default { createSovits };
