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

import { spawn, spawnSync } from 'node:child_process';
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
const HUB_PORT = Number(suite.hub?.port) || 3160;
const LINK_PORT = Number(suite.paths?.dshLinkPort) || 3080;

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

// ---- 共享探活（模块级：ensureQqRunning / ensureDshDesktop 都会用到）----
async function hubUp() {
  // 严格：/healthz 必须 200 且 body.ok === true（缺令牌的 401 不算"在跑"）
  const hb = await healthz(`http://127.0.0.1:${HUB_PORT}/healthz`, 2500);
  if (hb.ok) return true;
  const res = await probe(`http://127.0.0.1:${HUB_PORT}/`, 2000);
  return !!res; // 老版本 hub 没有 /healthz，退回端口级探活
}

/** 读 /healthz：只有 2xx + body.ok 才算健康；401 单独识别，避免被当成"未就绪"去重启客户端 */
async function healthz(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.status >= 200 && res.status < 300 && body?.ok === true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

async function dshWebOk() {
  const hb = await healthz(`http://127.0.0.1:${LINK_PORT}/healthz`, 3000);
  if (hb.status === 401) {
    log('dsh-link /healthz 返回 401：令牌不匹配（不是"未就绪"，不重启客户端；请检查 suite.hub.token 是否为最新）');
    return true; // 鉴权层活着 = 代理进程活着，不该判死
  }
  if (hb.ok) return true;
  if (hb.status === 0) return false;
  // 503 = 代理在跑但目标（桌面端内嵌 web）没就绪
  return false;
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Windows 会复用 PID：pid 活着还要确认是 node 进程，才算真的 hub / 桥接
function pidIsNode(pid) {
  try {
    const child = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10000, windowsHide: true });
    return /node\.exe/i.test(`${child.stdout || ''}${child.stderr || ''}`);
  } catch { return false; }
}

// 读 state/hub.pid 并校验其指向的进程真实存活；cleanup=true 时把失效文件删掉
function checkHubPid({ cleanup = false } = {}) {
  const file = path.join(ROOT, 'state', 'hub.pid');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { return { exists: false }; }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return { exists: true, pid: null };
  const alive = pidAlive(pid);
  const node = alive ? pidIsNode(pid) : false;
  if (cleanup && (!alive || !node)) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  return { exists: true, pid, alive, node };
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
  // 账号感知探测：期望账号的 OneBot 端口（读 SnowLuma 每账号配置）在线即视为就绪；
  // 不在线时：无任何 QQ 实例 → 拉起 QQ 客户端；已有实例但没登期望账号 → 提示手动登录（挂载是自动的）
  const { probeQqAccounts } = await import('./watch-qq.mjs');
  const results = await probeQqAccounts();
  const targetUin = Number(suite.paths?.autoLoginQQ || suite.identity?.botQQ || 0);
  const target = results.find((r) => r.uin === targetUin);
  if (target?.online) {
    log(`期望账号（${targetUin}）QQ 已在线（HTTP:${target.httpPort}）`);
    return true;
  }
  // web 探活：dsh-link 在目标死亡时返回 503；hub 不在线时跳过（避免误杀）
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
    log(`⚠️ 期望账号（${targetUin}）的 QQ 实例不在线（其他 QQ 实例在跑）：需要双开登录她的账号，登录后 SnowLuma 自动挂载`);
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
            log(`OneBot 已就绪且登录账号正确：${uin}（期望账号）`);
          } else {
            log(`⚠️ OneBot 已就绪，但登录账号是 ${uin}，不是期望的 ${AUTO_LOGIN_QQ}（期望账号）。请在 QQ 客户端切换账号，或修改 config/suite.json paths.autoLoginQQ`);
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
    if (await hubUp()) {
      // 连续 3 次都拿不到内嵌 web 才判定死亡：DSH 刚启动或瞬时卡顿时 dsh-link 也会 503，
      // 一次误判就 taskkill 会把人和桥接一起打断，所以这里必须留缓冲。
      let dead = true;
      for (let i = 0; i < 3; i++) {
        if (await dshWebOk()) { dead = false; break; }
        if (i < 2) await sleep(5000);
      }
      if (dead) {
        log('桌面客户端进程在，但内嵌 web 连续 3 次不可用（多因内存挤压），重启客户端…');
        spawn('taskkill', ['/IM', 'DeepSeek Harness.exe', '/T', '/F'], { windowsHide: true });
        await sleep(5000);
      } else {
        log('DeepSeek Harness 桌面客户端已在运行（内嵌 web 正常）');
        return true;
      }
    } else {
      log('DeepSeek Harness 桌面客户端已在运行（hub 未起，跳过内嵌 web 判定）');
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
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const hb = await healthz(`http://127.0.0.1:${LINK_PORT}/healthz`, 2500);
    if (hb.ok || hb.status === 401) {
      log(`桌面客户端内嵌 web 已就绪（经 dsh-link :${LINK_PORT}，用时 ${4 * (i + 1)}s）`);
      return true;
    }
  }
  log('桌面客户端内嵌 web 未在 120s 内就绪（保活任务稍后会再试）');
  return false;
}

async function ensureHub() {
  const port = suite.hub?.port || 3160;
  if (await probe(`http://127.0.0.1:${port}/`)) {
    // 端口有响应 ≠ hub.pid 还可信：强杀 hub 会残留 pid 文件，Windows 复用 PID 后
    // 会让人误判「hub 还在」。失效的 pid 文件顺手清掉，避免后续按 pid 操作时误杀。
    const st = checkHubPid({ cleanup: true });
    if (st.exists && st.pid && (!st.alive || !st.node)) {
      log(`⚠️ :${port} 有响应，但 hub.pid（${st.pid}）${st.alive ? '已被非 node 进程复用' : '进程已死'}，残留文件已清理`);
    }
    log('管理平台 hub 已在运行');
    return true;
  }
  // 端口没响应时残留的 hub.pid 一定是上次强杀留下的，清掉再启动
  const st = checkHubPid({ cleanup: true });
  if (st.exists && st.pid && !st.alive) {
    log(`清理被强杀 hub 残留的 hub.pid（pid ${st.pid} 已死）`);
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

/**
 * B站直播弹幕 sidecar（只收不发）。
 * 复用现有 BloomHub-KeepAlive 周期，不新建计划任务；未启用时什么都不做。
 */
async function ensureLiveSidecar() {
  if (suite.live?.enabled !== true) return null;
  const rooms = (suite.live?.roomIds || []).map(Number).filter((x) => x > 0);
  if (!rooms.length) {
    log('直播已启用但 live.roomIds 为空，跳过 sidecar');
    return false;
  }
  // 心跳新鲜（<90s）就认为在跑
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'live-heartbeat.json'), 'utf8'));
    if (hb?.ok && Date.now() - Number(hb.at) * 1000 < 90 * 1000) {
      log(`直播 sidecar 心跳正常（事件 ${hb.events ?? 0} 条）`);
      return true;
    }
  } catch { /* 没心跳 = 没跑过 */ }

  const py = path.join(ROOT, 'bili-duty', '.venv', 'Scripts', 'python.exe');
  const script = path.join(ROOT, suite.live?.sidecar || 'bili-duty/live_sidecar.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) {
    log('直播 sidecar 缺失（python venv 或 live_sidecar.py 不存在）');
    return false;
  }
  log(`启动直播 sidecar（房间 ${rooms.join(',')}）…`);
  spawnDetached(py, [script], ROOT);
  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'live-heartbeat.json'), 'utf8'));
      if (hb?.ok) {
        log('直播 sidecar 已就绪');
        return true;
      }
    } catch { /* 还没写心跳 */ }
  }
  log('直播 sidecar 未在 16s 内写出心跳（检查 logs/live-sidecar 或手动跑 --health）');
  return false;
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const waitLogin = args.includes('--wait-login') || !!process.env.BLOOM_WAIT_LOGIN;
const force = args.includes('--force');

// 并发锁：开机自启（Run 键）与保活任务可能撞车，10 分钟内的新锁直接跳过。
// --force 用于 doctor / 手动排障时忽略去抖窗口。
const LOCK = path.join(ROOT, 'state', 'ensure-running.lock');
if (!force) {
  try {
    fs.mkdirSync(path.join(LOCK, '..'), { recursive: true });
    const prev = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (Number.isFinite(prev) && Date.now() - prev < 10 * 60 * 1000) {
      log('另一次 ensure-running 刚跑过（<10 分钟），本次跳过');
      process.exit(0);
    }
  } catch { /* 无锁，继续 */ }
}
try { fs.writeFileSync(LOCK, String(Date.now()), 'utf8'); } catch { /* ignore */ }

try {
  log('=== ensure-running 开始 ===');
  await ensureQqRunning();
  await ensureSnowluma();
  if (waitLogin) await waitForOnebotLogin({});
  await ensureDshDesktop();
  await ensureHub();
  await ensureBridge();
  await ensureLiveSidecar();
  log('=== ensure-running 结束 ===');
} catch (e) {
  // 关键：任何一步抛错都不能让后面组件（hub / 桥接）永远起不来，也不能把锁留成僵尸
  log(`❌ ensure-running 异常终止：${e?.stack || e?.message || e}`);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ }
}
