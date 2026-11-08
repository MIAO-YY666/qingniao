// ============================================================
// tts.js —— 语音合成编排（文本 → 24k/mono/s16le wav）
// ------------------------------------------------------------
// 分工：
//   · Python 侧（tools/voice/tts_cli.py）只负责"出音频"，多引擎可换
//   · 这里负责：引擎选择、参数校验、ffmpeg 归一化、产物落盘、失败原因聚合
//
// 纪律：
//   1. 归一化统一用系统 ffmpeg（D:\tools\ffmpeg\bin\ffmpeg.exe），不用 PyAV——
//      之前"没有 ffmpeg 才用 PyAV"的结论是错的，实测 ffmpeg 一直在。
//   2. 失败不静默：返回 {ok:false, error, tries[]}，上层据此降级成文字。
//   3. 产物只落 state/tts-out/（D 盘），调用方用完负责删。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSovits } from './sovits.js';

const MAX_TEXT = 500;

/** persona.yaml 的自研 YAML 解析器不认 null/布尔，会把空值解析成字符串 "null" —— 这里统一当缺失处理。 */
function meaningful(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined' || s === '~') return null;
  return s;
}

function runCli(exe, args, { timeoutMs = 180000, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn(exe, args, {
      windowsHide: true,
      env: {
        ...process.env,
        // 这台机器全局设了 HTTP_PROXY，Python 的 urllib 会把 127.0.0.1 也走代理，
        // 表现为"连不上本机服务"——必须显式放行本地回环
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        // Windows 上 Python 的 stderr 是 GBK，不钉 UTF-8 中文报错会变乱码
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...env
      }
    });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n(超时)', ms: Date.now() - started });
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(e?.message || e), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

export function createTts({ root, suite, log, getPersonaVoice }) {
  const personaVoice = () => {
    try { return getPersonaVoice?.() || {}; } catch { return {}; }
  };
  const outDir = path.join(root, suite?.tts?.outDir || path.join('state', 'tts-out'));
  const cliDir = path.join(root, 'tools', 'voice');
  const py = suite?.tts?.python || path.join(cliDir, '.venv', 'Scripts', 'python.exe');
  const cli = path.join(cliDir, 'tts_cli.py');
  const ffmpeg = suite?.paths?.ffmpeg || 'D:\\tools\\ffmpeg\\bin\\ffmpeg.exe';
  const sovits = createSovits({ root, suite, log });

  /** 音色克隆的参考音频与提示文本：suite.tts.sovits 优先，其次 persona.yaml 的 voice 段 */
  function sovitsRef(personaVoice) {
    const cfg = suite?.tts?.sovits || {};
    const ref = meaningful(cfg.refAudio) || meaningful(personaVoice?.refAudio);
    const prompt = meaningful(cfg.promptText) || meaningful(personaVoice?.promptText);
    if (!ref) return null;
    return { ref: path.isAbsolute(ref) ? ref : path.join(root, ref), prompt: prompt || '' };
  }

  function resolveEngine(explicit, personaVoice) {
    return meaningful(explicit) || meaningful(suite?.tts?.engine) || meaningful(personaVoice?.engine) || 'sapi';
  }

  function resolveVoice(explicit, personaVoice) {
    return meaningful(explicit) || meaningful(suite?.tts?.voice) || meaningful(personaVoice?.voice) || null;
  }

  /** persona.yaml 里 voice.enabled === false 或 suite.tts.enabled === false 时整体关掉语音 */
  function isEnabled(personaVoice) {
    if (suite?.tts?.enabled === false) return false;
    const v = personaVoice?.enabled;
    return !(v === false || String(v).toLowerCase() === 'false');
  }

  function ensureOutDir() {
    fs.mkdirSync(outDir, { recursive: true });
  }

  /** 用 ffmpeg 归一化成 QQ 语音安全格式；失败时保留原文件并记为 degraded */
  async function normalize(src, dest) {
    const args = ['-y', '-loglevel', 'error', '-i', src, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', dest];
    const r = await runCli(ffmpeg, args, { timeoutMs: 60000 });
    if (r.ok && fs.existsSync(dest) && fs.statSync(dest).size > 512) return { ok: true };
    return { ok: false, error: (r.stderr || '').slice(-300) || 'ffmpeg 归一化失败' };
  }

  async function probe() {
    const info = { python: fs.existsSync(py), cli: fs.existsSync(cli), ffmpeg: fs.existsSync(ffmpeg), engines: [] };
    if (!info.cli || !info.python) return { ...info, ready: false, error: '语音 CLI 或 venv 缺失' };
    const r = await runCli(py, [cli, '--list'], { timeoutMs: 30000 });
    try {
      const data = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
      info.engines = data.engines || [];
      info.sapiVoices = data.sapi || [];
    } catch { /* ignore */ }
    return { ...info, ready: info.engines.length > 0 };
  }

  /**
   * 合成一句语音。
   * @returns {Promise<{ok:boolean, path?:string, engine?:string, voice?:string, ms?:number, bytes?:number, error?:string, degraded?:string}>}
   */
  async function synthesize(text, { engine, voice } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, error: 'text 不能为空' };
    if (raw.length > MAX_TEXT) return { ok: false, error: `text 超长（${raw.length} > ${MAX_TEXT} 字）` };
    if (!isEnabled(personaVoice())) {
      return { ok: false, disabled: true, error: '语音已关闭（persona.voice.enabled=false 或 suite.tts.enabled=false）' };
    }
    if (!fs.existsSync(py) || !fs.existsSync(cli)) {
      return { ok: false, error: `语音环境未就绪（${py} / ${cli}）` };
    }

    ensureOutDir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rawPath = path.join(outDir, `raw-${stamp}.wav`);
    const finalPath = path.join(outDir, `tts-${stamp}.wav`);

    const eng0 = resolveEngine(engine, personaVoice());
    const v = resolveVoice(voice, personaVoice());

    let eng = eng0;
    let degraded = null;
    let extraEnv = {};
    if (eng === 'sovits') {
      const ref = sovitsRef(personaVoice());
      if (!ref) {
        eng = 'sapi';
        degraded = '未配置参考音频（suite.tts.sovits.refAudio），已降级到 SAPI';
      } else {
        const up = await sovits.ensureUp();
        if (!up) {
          eng = 'sapi';
          degraded = 'GPT-SoVITS 推理服务未就绪，已降级到 SAPI';
        } else {
          const sc = suite?.tts?.sovits || {};
          extraEnv = {
            BLOOM_SOVITS_URL: `http://127.0.0.1:${sovits.port}`,
            BLOOM_SOVITS_REF: ref.ref,
            BLOOM_SOVITS_PROMPT: ref.prompt,
            // 参考音频是唱歌（约 1.7 字/秒），必须靠语速把输出拉回说话节奏
            BLOOM_SOVITS_SPEED: String(sc.speedFactor ?? 1.5),
            BLOOM_SOVITS_TEMP: String(sc.temperature ?? 0.9),
            BLOOM_SOVITS_REP: String(sc.repetitionPenalty ?? 1.45),
            ...(sc.textSplitMethod ? { BLOOM_SOVITS_SPLIT: String(sc.textSplitMethod) } : {})
          };
        }
      }
      if (degraded) log?.(`[tts] ${degraded}`);
    }

    const args = [cli, '--text', raw, '--out', rawPath, '--engine', eng, '--json'];
    if (v) args.push('--voice', String(v));
    const r = await runCli(py, args, { timeoutMs: 180000, env: extraEnv });
    if (eng === 'sovits' && r.ok) sovits.touch();

    let meta = null;
    try { meta = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { meta = null; }
    if (!r.ok || !meta?.ok || !fs.existsSync(rawPath)) {
      try { fs.rmSync(rawPath, { force: true }); } catch { /* ignore */ }
      return {
        ok: false,
        engine: eng,
        error: (r.stderr || '').trim().slice(-300) || `TTS 退出码 ${r.code}`,
      };
    }

    const norm = await normalize(rawPath, finalPath);
    if (!norm.ok) {
      // 归一化失败不丢内容：直接把原始 wav 当产物返回，并带 degraded 说明
      try { fs.renameSync(rawPath, finalPath); } catch { /* ignore */ }
      log?.(`[tts] 归一化失败，使用原始音频：${norm.error}`);
      return {
        ok: fs.existsSync(finalPath),
        path: finalPath,
        engine: meta.engine || eng,
        voice: meta.voice || v || null,
        bytes: fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0,
        ms: r.ms,
        degraded: [degraded, `未归一化（${norm.error}）`].filter(Boolean).join('；')
      };
    }
    try { fs.rmSync(rawPath, { force: true }); } catch { /* ignore */ }

    return {
      ok: true,
      path: finalPath,
      engine: meta.engine || eng,
      voice: meta.voice || v || null,
      bytes: fs.statSync(finalPath).size,
      ms: r.ms,
      chars: raw.length,
      ...(degraded ? { degraded } : {})
    };
  }

  return { synthesize, probe, isEnabled, outDir, MAX_TEXT, sovits };
}

export default { createTts };
