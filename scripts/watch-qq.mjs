// ============================================================
// watch-qq.mjs —— QQ 多开账号探测（bloom-hub）
// ------------------------------------------------------------
// 双开场景：每个 QQ 账号在 SnowLuma 里有独立的 OneBot 端口
// （读 SnowLuma/config/onebot_<uin>.json）。
// 本脚本定时探测：
//   · 哪些账号在线（按各自 token 问 get_login_info）
//   · 青鸟（期望账号）不在线时：一台 QQ 都没有 → 自动拉起 QQ 客户端
//     （自动登录谁由 QQ 自己记住的会话决定）；已有实例但没登青鸟 →
//     明确提示需要手动登录她的实例（挂载是 SnowLuma hookAutoLoad 自动的）
//   · 青鸟在线而桥接没跑 → 直接拉起桥接
// 用法：
//   node scripts/watch-qq.mjs            # 单次探测
//   node scripts/watch-qq.mjs --loop 60  # 每 60 秒循环
// ============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'suite.json'), 'utf8'));
const SNOWLUMA_DIR = suite.paths?.snowlumaHome || path.join(ROOT, 'SnowLuma');
const QQ_EXE = suite.paths?.qqExe || 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
const TARGET_UIN = Number(suite.paths?.autoLoginQQ || suite.identity?.botQQ || 0);
const CONFIG_DIR = path.join(SNOWLUMA_DIR, 'config');

function log(msg) {
  console.log(`${new Date().toISOString()} [watch-qq] ${msg}`);
}

async function probe(uin, httpPort, token) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${httpPort}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) return { online: false };
    const data = await res.json();
    const uid = data?.data?.user_id ?? null;
    return uid ? { online: true, uin: uid, nickname: data?.data?.nickname } : { online: false };
  } catch {
    return { online: false };
  }
}

function readAccountConfigs() {
  const out = [];
  try {
    for (const f of fs.readdirSync(CONFIG_DIR)) {
      const m = /^onebot_(\d+)\.json$/.exec(f);
      if (!m) continue;
      const uin = Number(m[1]);
      const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));
      const http = cfg.networks?.httpServers?.[0];
      const ws = cfg.networks?.wsServers?.[0];
      if (!http?.port) continue;
      out.push({ uin, httpPort: http.port, token: http.accessToken ?? '', wsPort: ws?.port ?? null, label: `账号${uin}` });
    }
  } catch { /* ignore */ }
  return out;
}

async function qqProcessCount() {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve((out.match(/QQ\.exe/gi) || []).length));
  });
}

function launchQq() {
  if (!fs.existsSync(QQ_EXE)) {
    log(`未找到 QQ 客户端（${QQ_EXE}）`);
    return false;
  }
  log(`没有任何 QQ 实例在跑，启动 QQ 客户端（登录账号由 QQ 记住的自动登录决定）…`);
  const child = spawn(QQ_EXE, [], { cwd: path.dirname(QQ_EXE), detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

async function ensureBridgeIfTargetOnline() {
  let port = 3100;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8'));
    port = cfg.consolePort || 3100;
  } catch { /* ignore */ }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    if (res) return true;
  } catch { /* down */ }
  log('青鸟在线但桥接没跑，拉起桥接…');
  const child = spawn(process.execPath, ['src/bridge.js'], { cwd: path.join(ROOT, 'qq-bridge'), detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return false;
}

export async function probeQqAccounts() {
  const accounts = readAccountConfigs();
  const results = [];
  for (const a of accounts) {
    const r = await probe(a.uin, a.httpPort, a.token);
    results.push({ ...a, ...r });
  }
  return results;
}

export async function watchOnce() {
  const results = await probeQqAccounts();
  for (const r of results) {
    log(r.online
      ? `${r.uin}（${r.nickname}）在线 · HTTP:${r.httpPort} WS:${r.wsPort}`
      : `${r.uin} 离线 · HTTP:${r.httpPort}（端口无响应或 token 不匹配）`);
  }
  const target = results.find((r) => r.uin === TARGET_UIN);
  if (target?.online) {
    await ensureBridgeIfTargetOnline();
    return true;
  }
  const qqCount = await qqProcessCount();
  if (qqCount === 0) {
    launchQq();
  } else {
    log(`青鸟（${TARGET_UIN}）不在线但已有 ${qqCount} 个 QQ 相关进程：需要在 QQ 客户端登录她的实例（多开），登录后 SnowLuma 会自动挂载，本脚本会在下一轮探测到`);
  }
  return false;
}

const args = process.argv.slice(2);
if (process.argv[1] && path.basename(process.argv[1]) === 'watch-qq.mjs') {
  const loopIdx = args.indexOf('--loop');
  if (loopIdx !== -1) {
    const sec = Math.max(10, Number(args[loopIdx + 1]) || 60);
    log(`循环探测模式：每 ${sec} 秒一次（Ctrl+C 退出）`);
    const tick = async () => {
      try { await watchOnce(); } catch (e) { log(`探测异常：${e.message}`); }
    };
    await tick();
    setInterval(tick, sec * 1000);
  } else {
    const ok = await watchOnce();
    process.exitCode = ok ? 0 : 1;
  }
}
