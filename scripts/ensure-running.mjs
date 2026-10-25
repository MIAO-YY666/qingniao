// ============================================================
// ensure-running.mjs —— bloom-hub 整栈保活（自启与手动启动共用）
// ------------------------------------------------------------
// 幂等：哪个组件没起来就拉哪个，已在运行的跳过。
//   1. QQ.exe（官方客户端；账号自动登录由 QQ 自己的「自动登录」勾选负责）
//   2. SnowLuma（hookAutoLoad=true 时自动挂上 QQ 进程，免 WebUI 手动接入）
//   3. 等待 OneBot 端口出现（即 Hook 成功 + QQ 已登录）
//   4. bloom-hub 管理平台 hub（:3160）
//   5. QQ 桥接 core（:3100，单实例锁自保护）
// 用法：node scripts/ensure-running.mjs [--wait-login]
// ============================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'logs', 'ensure-running.log');

function log(msg) {
  const line = `${new Date().toISOString()} [ensure] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch { /* ignore */ }
}

const suite = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'suite.json'), 'utf8'));
const paths = suite.paths || {};
const SNOWLUMA_DIR = paths.snowlumaHome || path.join(ROOT, 'SnowLuma');
const QQ_EXE = paths.qqExe || 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
const AUTO_LOGIN_QQ = paths.autoLoginQQ || suite.identity?.botQQ;

// 桥接 config.json 里有 OneBot 端口与令牌
function onebotHttp() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8'));
    return {
      url: (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      token: cfg.snowluma?.httpAccessToken ?? cfg.snowluma?.accessToken ?? ''
    };
  } catch {
    return { url: 'http://127.0.0.1:3000', token: '' };
  }
}

async function probe(url, timeoutMs = 2500, headers = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

function spawnDetached(cmd, args, cwd, { hidden = true } = {}) {
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: hidden,
    windowsVerbatimArguments: true
  });
  child.unref();
  return child.pid;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 组件启动 ----------

async function ensureSnowluma() {
  const runtime = JSON.parse(fs.readFileSync(path.join(SNOWLUMA_DIR, 'config', 'runtime.json'), 'utf8'));
  const webuiPort = runtime.webuiPort || 5099;
  if (await probe(`http://127.0.0.1:${webuiPort}/`)) {
    log('SnowLuma 已在运行');
    return true;
  }
  log(`启动 SnowLuma（${SNOWLUMA_DIR}）…`);
  spawnDetached(process.execPath, ['index.mjs'], SNOWLUMA_DIR);
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    if (await probe(`http://127.0.0.1:${webuiPort}/`)) {
      log(`SnowLuma WebUI 已就绪（:${webuiPort}，用时 ${2 * (i + 1)}s）`);
      return true;
    }
  }
  log('SnowLuma WebUI 未在 40s 内就绪（可能仍在启动，继续后续步骤）');
  return false;
}

async function ensureQqRunning() {
  if (process.platform !== 'win32') return false;
  // 账号感知探测：青鸟的 OneBot 端口（读 SnowLuma 每账号配置）在线即视为就绪；
  // 不在线时：无任何 QQ 实例 → 拉起 QQ 客户端；已有实例但没登青鸟 → 提示手动登录（挂载是自动的）
  const { probeQqAccounts } = await import('./watch-qq.mjs');
  const results = await probeQqAccounts();
  const targetUin = Number(suite.paths?.autoLoginQQ || suite.identity?.botQQ || 0);
  const target = results.find((r) => r.uin === targetUin);
  if (target?.online) {
    log(`青鸟（${targetUin}）QQ 已在线（HTTP:${target.httpPort}）`);
    return true;
  }
  // web 探活：dsh-link 在目标死亡时返回 503；hub 不在线时跳过（避免误杀）
  async function dshWebOk() {
    try { const r = await probe('http://127.0.0.1:3080/', 3000); return r && r.status !== 503; } catch { return false; }
  }
  async function hubUp() {
    const port = Number(suite.hub?.port) || 3160;
    try { const r = await probe('http://127.0.0.1:' + port + '/', 2000); return !!r; } catch { return false; }
  }
  const running = await new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(/QQ\.exe/gi.test(out)));
  });
  if (!running) {
    const qqExe = suite.paths?.qqExe || 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
    if (fs.existsSync(qqExe)) {
      log('无 QQ 实例，启动 QQ 客户端…');
      spawnDetached(qqExe, [], path.dirname(qqExe), { hidden: false });
      await sleep(5000);
    } else {
      log(`未找到 QQ.exe（${qqExe}），跳过；可在 config/suite.json paths.qqExe 配置`);
    }
  } else {
    log(`⚠️ 青鸟（${targetUin}）的 QQ 实例不在线（其他 QQ 实例在跑）：需要双开登录她的账号，登录后 SnowLuma 自动挂载`);
  }
  return false;
}

async function waitForOnebotLogin({ timeoutSec = 120 } = {}) {
  const { url, token } = onebotHttp();
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const res = await probe(`${url}/get_login_info`, 2500, headers);
    if (res && res.ok) {
      try {
        const data = await res.json();
        const uin = data?.data?.user_id ?? data?.user_id ?? null;
        if (uin) {
          if (Number(uin) === Number(AUTO_LOGIN_QQ)) {
            log(`OneBot 已就绪且登录账号正确：${uin}（青鸟）`);
          } else {
            log(`⚠️ OneBot 已就绪，但登录账号是 ${uin}，不是期望的 ${AUTO_LOGIN_QQ}（青鸟）。请在 QQ 客户端切换账号，或修改 config/suite.json paths.autoLoginQQ`);
          }
          return { ok: true, uin };
        }
      } catch { /* 继续等 */ }
    }
    await sleep(5000);
  }
  log(`OneBot 在 ${timeoutSec}s 内未就绪：多半是 QQ 客户端停在登录窗（需要扫码/首次点一次「自动登录」），或 hookAutoLoad 未生效。桥接会持续自动重连，登录后无需人工干预。`);
  return { ok: false };
}

async function ensureDshDesktop() {
  // 桥接不再连独立 `dsh web`，而是经 hub 的 dsh-link（固定 3080）转发到
  // 桌面客户端（DeepSeek Harness.exe）的内嵌 web。这里只保证桌面客户端在运行。
  const exe = suite.paths?.dshDesktopExe || 'D:\\DeepSeekHarness\\DeepSeek Harness.exe';
  const running = await new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(/DeepSeek Harness\.exe/i.test(out)));
  });
  if (running) {
    if ((await hubUp()) && !(await dshWebOk())) {
      log('桌面客户端进程在但内嵌 web 已死（多因内存挤压），重启客户端…');
      spawn('taskkill', ['/IM', 'DeepSeek Harness.exe', '/T', '/F'], { windowsHide: true });
      await sleep(5000);
    } else {
      log('DeepSeek Harness 桌面客户端已在运行');
      return true;
    }
  }
  if (!fs.existsSync(exe)) {
    log(`未找到桌面客户端（${exe}），跳过；可在 config/suite.json paths.dshDesktopExe 配置`);
    return false;
  }
  log('启动 DeepSeek Harness 桌面客户端…');
  spawnDetached(exe, [], path.dirname(exe), { hidden: false });
  // 内嵌 web 就绪探测：hub 的 dsh-link（固定 3080）会自动发现它
  const linkPort = Number(suite.paths?.dshLinkPort) || 3080;
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const res = await probe(`http://127.0.0.1:${linkPort}/`, 2500);
    if (res && res.status !== 503) {
      log(`桌面客户端内嵌 web 已就绪（经 dsh-link :${linkPort}，用时 ${4 * (i + 1)}s）`);
      return true;
    }
  }
  log('桌面客户端内嵌 web 未在 120s 内就绪（保活任务稍后会再试）');
  return false;
}

async function ensureHub() {
  const port = suite.hub?.port || 3160;
  if (await probe(`http://127.0.0.1:${port}/`)) {
    log('管理平台 hub 已在运行');
    return true;
  }
  log('启动管理平台 hub…');
  spawnDetached(process.execPath, ['services/hub.js'], ROOT);
  for (let i = 0; i < 15; i++) {
    await sleep(1500);
    if (await probe(`http://127.0.0.1:${port}/`)) {
      log(`管理平台已就绪：http://127.0.0.1:${port}`);
      return true;
    }
  }
  log('管理平台未在 22s 内就绪');
  return false;
}

async function ensureBridge() {
  let port = 3100;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8'));
    port = cfg.consolePort || 3100;
  } catch { /* ignore */ }
  if (await probe(`http://127.0.0.1:${port}/`)) {
    log('QQ 桥接已在运行');
    return true;
  }
  log('启动 QQ 桥接（qq-bridge）…');
  spawnDetached(process.execPath, ['src/bridge.js'], path.join(ROOT, 'qq-bridge'));
  for (let i = 0; i < 15; i++) {
    await sleep(1500);
    if (await probe(`http://127.0.0.1:${port}/`)) {
      log(`QQ 桥接已就绪（:${port}）；它会自动重连 SnowLuma 与 DSH，无需人工干预`);
      return true;
    }
  }
  log('桥接未在 22s 内就绪（检查 logs：qq-bridge/state/bridge.log）');
  return false;
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const waitLogin = args.includes('--wait-login') || !!process.env.BLOOM_WAIT_LOGIN;

// 并发锁：开机自启（Run 键）与 30 分钟保活任务可能撞车，10 分钟内的新锁直接跳过
const LOCK = path.join(ROOT, 'state', 'ensure-running.lock');
try {
  fs.mkdirSync(path.join(LOCK, '..'), { recursive: true });
  const prev = Number(fs.readFileSync(LOCK, 'utf8').trim());
  if (Number.isFinite(prev) && Date.now() - prev < 10 * 60 * 1000) {
    log('另一次 ensure-running 刚跑过（<10 分钟），本次跳过');
    process.exit(0);
  }
} catch { /* 无锁，继续 */ }
try { fs.writeFileSync(LOCK, String(Date.now()), 'utf8'); } catch { /* ignore */ }

log('=== ensure-running 开始 ===');
await ensureQqRunning();
await ensureSnowluma();
if (waitLogin) await waitForOnebotLogin({});
await ensureDshDesktop();
await ensureHub();
await ensureBridge();
try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ }
log('=== ensure-running 结束 ===');
