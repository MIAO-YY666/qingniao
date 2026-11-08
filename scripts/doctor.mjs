// ============================================================
// doctor.mjs —— bloom-hub 全栈体检 + 自愈（可定时自动运行）
// ------------------------------------------------------------
// 背景：ensure-running.mjs 曾在「QQ 已在线」分支里引用未定义函数而崩溃，
//       导致管理平台 / 桥接永远起不来；同时注册表自启项与保活任务丢失，
//       机器重启后整栈无人拉起。本脚本把所有已知故障点做成检查项，
//       能修的直接修，修不了明确报 FAIL，并写入 logs/doctor.log。
//
// 检查项：
//   1. config      suite.json 可解析、hub 令牌存在
//   2. state       僵尸锁 / 失效 pid 文件（ensure-running.lock、hub.pid、bridge.lock）
//   3. autostart   注册表 Run 键 + 计划任务（缺失则自动重装）
//   4. qq          QQ 客户端与期望账号账号是否在线（读 SnowLuma 各账号 OneBot 端口）
//   5. snowluma    QQ 协议端 WebUI
//   6. dsh         DeepSeek Harness 桌面客户端进程 + dsh-link 固定入口 :3080
//   7. hub         管理平台 :3160
//   8. bridge      QQ 桥接 :3100（含 dshReady / 模式 / 角色）
//   9. heartbeat   doctor / ensure-running 日志心跳是否还在（保活任务是否真在跑）
//  10. crashlog    保活日志里是否还有旧崩溃（ReferenceError / 异常终止）
//
// 用法：
//   node scripts/doctor.mjs              # 体检 + 自动修复（保活任务用这个）
//   node scripts/doctor.mjs --no-repair  # 只体检不动手
//   node scripts/doctor.mjs --json       # 输出 JSON（给别的程序读）
// 退出码：0 = 全部正常（含已修复）；1 = 仍有 FAIL
// ============================================================

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const DOCTOR_LOG = path.join(LOG_DIR, 'doctor.log');
const LOCK = path.join(ROOT, 'state', 'doctor.lock');
const ENSURE_LOG = path.join(LOG_DIR, 'ensure-running.log');

const args = process.argv.slice(2);
const NO_REPAIR = args.includes('--no-repair');
const JSON_OUT = args.includes('--json');

function timestamp() {
  return new Date().toISOString();
}

function log(line) {
  const text = `${timestamp()} [doctor] ${line}`;
  if (!JSON_OUT) console.log(text);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(DOCTOR_LOG, text + '\n', 'utf8');
  } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function http(url, { method = 'GET', headers = {}, body = null, timeout = 4000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Windows 会复用 PID：残留的 pid 文件可能恰好指向无关进程，只查「进程存在」
// 会误判为仍在运行。hub / 桥接都是 node 起的，用进程名兜底（与 stop-all.bat 一致）。
function pidIsNode(pid) {
  const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 10000);
  return /node\.exe/i.test(r.out);
}

function run(cmd, cmdArgs, timeout = 20000) {
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true });
  return { code: res.status ?? -1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function tasklist(name) {
  const r = run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH']);
  return (r.out.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length > 0;
}

function tailLines(file, n = 300) {
  const text = readText(file);
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).slice(-n);
}

const suite = readJson(path.join(ROOT, 'config', 'suite.json'));
const hubPort = Number(suite?.hub?.port) || 3160;
const linkPort = Number(suite?.paths?.dshLinkPort) || 3080;
const hubToken = (readText(path.join(ROOT, 'state', 'hub-token')) || suite?.hub?.token || '').trim();
const snowlumaDir = suite?.paths?.snowlumaHome || path.join(ROOT, 'SnowLuma');

function coreConfig() {
  return readJson(path.join(ROOT, 'qq-bridge', 'config.json')) || {};
}
function bridgePort() {
  return Number(coreConfig().consolePort) || 3100;
}
function bridgeToken() {
  const cfg = coreConfig();
  return String(cfg.consoleToken || readText(path.join(ROOT, 'qq-bridge', 'state', 'console-token'))).trim();
}

// ---------- 检查 ----------

async function checkConfig() {
  const suiteFile = path.join(ROOT, 'config', 'suite.json');
  if (!suite) return { ok: false, detail: 'suite.json 缺失或不是合法 JSON（整栈无法启动）' };
  const problems = [];
  if (!suite.hub?.token) problems.push('hub.token 为空（首启会自动生成，但平台可能换令牌）');
  if (!suite.paths?.qqExe) problems.push('paths.qqExe 未配置');
  if (!suite.identity?.botQQ) problems.push('identity.botQQ 未配置');
  if (!fs.existsSync(path.join(ROOT, 'config', 'persona.yaml'))) problems.push('persona.yaml 缺失（人格同步会失败）');
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join('；') : `suite.json 正常（hub :${hubPort}，令牌${hubToken ? '已就绪' : '缺失'}）`
  };
}

function checkState(allowRepair = true) {
  const issues = [];
  const fixes = [];
  // 1) ensure-running 僵尸锁：上次崩溃留下的时间戳，10 分钟内会让后续保活全部跳过
  const lockFile = path.join(ROOT, 'state', 'ensure-running.lock');
  if (fs.existsSync(lockFile)) {
    const stamp = Number(readText(lockFile).trim());
    if (!Number.isFinite(stamp) || stamp <= 0) {
      if (allowRepair) {
        fs.rmSync(lockFile, { force: true });
        fixes.push('清理内容异常的 ensure-running 锁');
      } else {
        issues.push('ensure-running 锁内容异常');
      }
    } else {
      const ageMin = (Date.now() - stamp) / 60000;
      if (ageMin > 10) {
        if (allowRepair) {
          fs.rmSync(lockFile, { force: true });
          fixes.push(`清理 ensure-running 僵尸锁（${ageMin.toFixed(0)} 分钟前）`);
        } else {
          issues.push(`ensure-running 僵尸锁（${ageMin.toFixed(0)} 分钟前）`);
        }
      }
    }
  }
  // 2) hub / bridge 的 pid 文件（强杀进程会残留；pid 死了或被复用给非 node 进程都视为失效）
  for (const [file, label] of [
    [path.join(ROOT, 'state', 'hub.pid'), 'hub.pid'],
    [path.join(ROOT, 'qq-bridge', 'state', 'bridge.lock'), 'bridge.lock']
  ]) {
    if (!fs.existsSync(file)) continue;
    const pid = Number(readText(file).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const alive = pidAlive(pid);
    if (!alive || !pidIsNode(pid)) {
      const why = alive ? `pid ${pid} 已被其他进程复用（非 node）` : `pid ${pid} 已不存在`;
      if (allowRepair) {
        fs.rmSync(file, { force: true });
        fixes.push(`清理失效 ${label}（${why}）`);
      } else {
        issues.push(`失效 ${label}（${why}）`);
      }
    }
  }
  const ok = issues.length === 0 && fixes.length === 0;
  return {
    ok,
    fixed: fixes.length > 0,
    detail: fixes.length ? fixes.join('；') : (issues.length ? issues.join('；') : '无僵尸锁 / 失效 pid')
  };
}

function readToggles() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'service-toggles.json'), 'utf8'));
    return { autostart: j.autostart !== false, doctor: j.doctor !== false };
  } catch {
    return { autostart: true, doctor: true };
  }
}

/**
 * 探测自启项与保活任务。
 * 用 PowerShell 拿（枚举值是纯 ASCII，schtasks 文本在中文系统上是 GBK 会乱码）。
 * 关键：区分「确实不存在」和「查询本身失败」——后者绝不能当成缺失去重装。
 */
function probeAutostart() {
  // 用 COM（Schedule.Service）而不是 Get-ScheduledTask：后者加载模块就要 ~3 秒
  const ps = [
    `$k=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name BloomHub -ErrorAction SilentlyContinue).BloomHub`,
    `if($k){'KEY=1'}else{'KEY=0'}`,
    `$s=New-Object -ComObject Schedule.Service;$s.Connect()`,
    `try{$t=$s.GetFolder('\\').GetTask('BloomHub-KeepAlive');'TASK=1';'STATE='+$t.State}catch{'TASK=0'}`
  ].join(';');
  const r = run('powershell', ['-NoProfile', '-Command', ps], 20000);
  const out = r.out || '';
  const keyM = out.match(/KEY=([01])/);
  const taskM = out.match(/TASK=([01])/);
  if (!keyM || !taskM) {
    return { probeFailed: true, keyExists: null, taskExists: null, taskEnabled: null, state: null, raw: out.trim().slice(0, 200) };
  }
  const stateNum = Number((out.match(/STATE=(\d+)/) || [])[1]);
  const taskExists = taskM[1] === '1';
  return {
    probeFailed: false,
    keyExists: keyM[1] === '1',
    taskExists,
    taskEnabled: taskExists ? stateNum !== 1 : false, // COM: 1 = Disabled
    state: String(stateNum || ''),
    raw: out.trim().slice(0, 200)
  };
}

function checkAutostart() {
  const want = readToggles();
  const p = probeAutostart();
  if (p.probeFailed) {
    // 查不到 ≠ 不存在。这种情况既不算 FAIL，也绝不触发重装（免得在受限环境里乱动系统）
    return {
      ok: true,
      probeFailed: true,
      detail: `无法查询自启状态（${p.raw || 'PowerShell 无输出'}），已跳过检查`,
      parts: { want },
      want
    };
  }
  const issues = [];
  if (want.autostart && !p.keyExists) issues.push('注册表 Run 键缺失');
  if (want.doctor && !p.taskExists) issues.push('保活任务缺失');
  if (want.doctor && p.taskExists && p.taskEnabled === false) issues.push('保活任务被禁用');
  const ok = issues.length === 0;
  return {
    ok,
    probeFailed: false,
    detail: `注册表 Run 键：${p.keyExists ? '存在' : '缺失'}${want.autostart ? '' : '（按设置关闭）'}；` +
      `保活任务：${p.taskExists ? (p.taskEnabled === false ? '已禁用' : '存在') : '缺失'}${want.doctor ? '' : '（按设置关闭）'}` +
      (issues.length ? `；待处理：${issues.join('、')}` : ''),
    parts: { keyOk: p.keyExists, taskOk: p.taskExists, taskEnabled: p.taskEnabled, want },
    want
  };
}

async function checkQq() {
  let accounts = [];
  try {
    const mod = await import('./watch-qq.mjs');
    accounts = await mod.probeQqAccounts();
  } catch (e) {
    return { ok: false, detail: `无法探测 OneBot 账号：${e.message}` };
  }
  const targetUin = Number(suite?.paths?.autoLoginQQ || suite?.identity?.botQQ || 0);
  const target = accounts.find((a) => a.uin === targetUin);
  const qqRunning = tasklist('QQ.exe');
  if (!qqRunning) return { ok: false, detail: 'QQ.exe 未运行（桥接无消息可收）' };
  if (!target) return { ok: false, detail: `SnowLuma 未配置 ${targetUin} 的 OneBot 端口` };
  if (!target.online) {
    return { ok: false, detail: `期望账号（${targetUin}）离线：HTTP:${target.httpPort} 无响应（需在 QQ 客户端登录该账号）` };
  }
  const others = accounts.filter((a) => a.uin !== targetUin).map((a) => `${a.uin}:${a.online ? '在线' : '离线'}`);
  return {
    ok: true,
    detail: `期望账号（${targetUin}）在线 · HTTP:${target.httpPort} WS:${target.wsPort}` + (others.length ? `；其他账号 ${others.join(' / ')}` : '')
  };
}

async function checkSnowluma() {
  const runtime = readJson(path.join(snowlumaDir, 'config', 'runtime.json')) || {};
  const port = Number(runtime.webuiPort) || 5099;
  const res = await http(`http://127.0.0.1:${port}/`, { timeout: 2500 });
  return {
    ok: res.ok,
    detail: res.ok ? `协议端 WebUI :${port} 正常` : `协议端 WebUI :${port} 无响应（SnowLuma 未运行）`
  };
}

async function checkDsh() {
  const exe = suite?.paths?.dshDesktopExe || 'D:\\DeepSeekHarness\\DeepSeek Harness.exe';
  const exeName = exe.split('\\').pop();
  const processOk = tasklist(exeName);
  // 走 /healthz 而不是 /：以前把 401 当"非 503 = 健康"，桌面端内嵌 web 没就绪永远测不出来。
  const link = await http(`http://127.0.0.1:${linkPort}/healthz`, { timeout: 3500 });
  let hb = null;
  try { hb = JSON.parse(link.text || 'null'); } catch { hb = null; }
  if (!processOk) return { ok: false, detail: `${exeName} 未运行（QQ 会回「fetch failed」）` };
  if (!link.ok) return { ok: false, detail: `桌面客户端在跑，但 dsh-link :${linkPort} 无响应（hub 未起或 dsh-link 绑定失败）` };
  if (link.status === 401) {
    return { ok: false, detail: `dsh-link :${linkPort} 返回 401：令牌不匹配（不是"未就绪"，请勿重启客户端；检查 state/hub-token 与 suite.hub.token）` };
  }
  if (link.status === 503 || hb?.targetReady !== true) {
    return { ok: false, detail: `dsh-link :${linkPort} 返回 ${link.status}：客户端内嵌 web 尚未就绪（保活会自动重试）` };
  }
  return { ok: true, detail: `桌面客户端在跑，dsh-link :${linkPort} 转发正常（目标端口 ${hb?.targetPort ?? '?'}）` };
}

async function checkHub() {
  const res = await http(`http://127.0.0.1:${hubPort}/healthz`, { timeout: 3000 });
  if (!res.ok) return { ok: false, detail: `管理平台 :${hubPort} 无响应` };
  let hb = null;
  try { hb = JSON.parse(res.text || 'null'); } catch { hb = null; }
  if (res.status !== 200 || hb?.ok !== true) {
    return { ok: false, detail: `管理平台 :${hubPort} /healthz 异常（HTTP ${res.status}）` };
  }
  const issues = Array.isArray(hb.capabilityIssues) ? hb.capabilityIssues : [];
  if (issues.length) {
    return { ok: false, detail: `管理平台在跑，但能力表与代码不一致：${issues.slice(0, 2).join('；')}` };
  }
  const b = hb.checks?.bridge ?? {};
  return {
    ok: true,
    detail: `管理平台正常：http://127.0.0.1:${hubPort} · 桥接=${b.up ? 'up' : 'down'} · DSH=${b.dshReady ? 'ready' : 'not-ready'}`
  };
}

async function checkBridge() {
  const port = bridgePort();
  const base = `http://127.0.0.1:${port}`;
  const up = await http(`${base}/`, { timeout: 2500 });
  if (!up.ok) return { ok: false, detail: `QQ 桥接 :${port} 无响应` };
  const token = bridgeToken();
  const status = await http(`${base}/api/status`, { headers: token ? { 'x-console-token': token } : {}, timeout: 5000 });
  if (!status.ok) return { ok: false, detail: `桥接 :${port} 在跑，但 /api/status 无响应` };
  let data = null;
  try { data = JSON.parse(status.text); } catch { /* ignore */ }
  if (!data) return { ok: false, detail: '桥接 /api/status 返回非 JSON（可能令牌不匹配）' };
  const dshReady = data.dshReady === true;
  return {
    ok: dshReady,
    detail: `桥接 :${port} · 模式=${data.mode ?? '?'} · 角色=${data.role ?? '?'} · DSH=${dshReady ? '已连接' : '未连接（会持续重连）'}`
  };
}

/** B站直播弹幕 sidecar：未启用时直接 OK（不吓人），启用后看心跳新鲜度 */
function checkLive() {
  const cfg = suite?.live || {};
  if (cfg.enabled !== true) return { ok: true, detail: '未启用（suite.json → live.enabled=false）' };
  const hb = readJson(path.join(ROOT, 'state', 'live-heartbeat.json'));
  if (!hb) return { ok: false, detail: '直播已启用但从未采到心跳（sidecar 未启动过）' };
  const ageSec = hb.at ? Math.round(Date.now() / 1000 - Number(hb.at)) : null;
  if (hb.status === 'stopped') return { ok: false, detail: `sidecar 已停止（${hb.error || '无错误信息'}）` };
  if (ageSec !== null && ageSec > 90) return { ok: false, detail: `心跳已 ${ageSec}s 未刷新（>90s 视为失联）` };
  return { ok: true, detail: `采集正常 · 事件 ${hb.events ?? 0} 条 · 丢弃 ${hb.dropped ?? 0} · ${ageSec}s 前心跳` };
}

async function checkPush() {  if (!hubToken) return { ok: false, detail: '缺少 hub 令牌，无法读取推送状态' };
  const res = await http(`http://127.0.0.1:${hubPort}/api/push/status`, { headers: { 'x-hub-token': hubToken }, timeout: 4000 });
  if (!res.ok) return { ok: false, detail: '推送状态接口无响应（hub 可能没起）' };
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* ignore */ }
  if (!data?.ok) return { ok: false, detail: '推送状态返回异常' };
  const last = data.history?.find((h) => h.kind === 'push');
  const queue = Array.isArray(data.queue) ? data.queue.length : 0;
  const next = data.nextWindowStartAt ? `下次谷窗 ${fmtTime(data.nextWindowStartAt)}` : '无谷窗配置';
  return {
    ok: data.enabled !== false,
    detail: `推送${data.enabled === false ? '已关闭' : '在线'}（${data.onlyInValley ? '仅谷时' : '随时'}）` +
      ` · 上次推送 ${last ? `${last.date} ${fmtTime(last.at)}` : '无记录'} · 待发 ${queue} · ${next}`
  };
}

function checkHeartbeat() {
  const now = Date.now();
  const doctorAge = fs.existsSync(DOCTOR_LOG) ? (now - fs.statSync(DOCTOR_LOG).mtimeMs) / 60000 : Infinity;
  const ensureLines = tailLines(ENSURE_LOG, 20);
  const lastEnsureLine = ensureLines.length ? ensureLines[ensureLines.length - 1] : '';
  const m = /^(\S+) \[ensure\] (.*)$/.exec(lastEnsureLine);
  const lastEnsure = m ? `${fmtTime(m[1])} ${m[2]}` : '无记录';
  if (!Number.isFinite(doctorAge)) {
    return { ok: false, detail: 'doctor 日志还不存在（保活任务可能没装）' };
  }
  if (doctorAge > 20) {
    return { ok: false, detail: `doctor 已 ${doctorAge.toFixed(0)} 分钟没跑（保活任务没生效）` };
  }
  return { ok: true, detail: `保活心跳正常（doctor ${doctorAge.toFixed(1)} 分钟前；上次保活 ${lastEnsure}）` };
}

function checkCrashLog() {
  // 只看最近一次 ensure-running 运行（最后一个「开始」标记之后），历史崩溃不重复报
  const lines = tailLines(ENSURE_LOG, 1200);
  const startIdx = lines.map((l) => /=== ensure-running 开始 ===/.test(l)).lastIndexOf(true);
  const current = startIdx >= 0 ? lines.slice(startIdx) : lines.slice(-200);
  const crashes = current.filter((l) => /ReferenceError|异常终止|is not defined/.test(l));
  if (crashes.length) {
    return { ok: false, detail: `最近一次保活有崩溃（${crashes.length} 条，最近：${crashes[crashes.length - 1].slice(0, 120)}）` };
  }
  return { ok: true, detail: '最近一次保活运行无崩溃记录' };
}

// H3 下载看门狗：模型没下齐且下载任务没在跑 → 重新拉起（下载脚本自带断点续传）。
// 曾经出现过计划任务进程被 0xC000013A 终止后无人重启、静默停摆 14 分钟的情况。
function checkH3Download() {
  const dlScript = path.join(ROOT, 'scripts', '_h3-download.sh');
  if (!fs.existsSync(dlScript)) return { ok: true, detail: '无 H3 下载脚本（看门狗不适用）' };
  // 下载完成的唯一权威信号是脚本自己写的「全部文件校验通过」（按字节校验）；
  // 文件存在性判断会误判残缺文件，不用。
  const logTail = tailLines(path.join(LOG_DIR, 'h3-download.log'), 8).join(' ');
  if (/全部文件校验通过|校验通过，全部完成/.test(logTail)) {
    return { ok: true, detail: 'H3 模型下载已完成' };
  }
  // 注意别用 schtasks 文本输出：GBK 编码按 utf8 解出来是乱码；PowerShell 的 State 枚举是纯 ASCII
  const st = run('powershell', ['-NoProfile', '-Command', "(Get-ScheduledTask -TaskName 'BloomHub-H3Download').State"], 15000);
  const running = /Running/i.test(st.out);
  if (running) return { ok: true, detail: 'H3 下载任务运行中' };
  if (NO_REPAIR) return { ok: false, detail: 'H3 下载未完成且计划任务未在运行（--no-repair 不自动拉起）' };
  const start = run('schtasks', ['/run', '/tn', 'BloomHub-H3Download'], 15000);
  const fixed = start.code === 0;
  return {
    ok: false, fixed,
    detail: fixed ? 'H3 下载任务停摆，已重新拉起' : `H3 下载任务停摆且拉起失败（schtasks exit ${start.code}）`
  };
}

async function collect(allowRepair = !NO_REPAIR) {
  return {
    config: await checkConfig(),
    state: checkState(allowRepair),
    autostart: checkAutostart(),
    qq: await checkQq(),
    snowluma: await checkSnowluma(),
    dsh: await checkDsh(),
    hub: await checkHub(),
    bridge: await checkBridge(),
    live: checkLive(),
    push: await checkPush(),
    h3download: checkH3Download(),
    heartbeat: checkHeartbeat(),
    crashlog: checkCrashLog()
  };
}

// ---------- 修复 ----------

function installAutostart(only = 'Both') {
  log(`注册表自启或保活任务缺失，调用 scripts/install-autostart.ps1 -Only ${only} 重装…`);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'install-autostart.ps1')];
  if (only !== 'Both') args.push('-Only', only);
  const r = run('powershell', args, 90000);
  const out = r.out.trim();
  if (out) out.split(/\r?\n/).forEach((l) => log(`  ${l}`));
  return r.code === 0;
}

/** 任务还在但被禁用了 → 直接启用（COM，比 Enable-ScheduledTask 快十倍） */
function enableKeepAlive() {
  const ps = `$s=New-Object -ComObject Schedule.Service;$s.Connect();` +
    `$t=$s.GetFolder('\\').GetTask('BloomHub-KeepAlive');$t.Enabled=$true;'EN='+$t.Enabled`;
  const r = run('powershell', ['-NoProfile', '-Command', ps], 20000);
  if (!/EN=True/.test(r.out)) log(`  启用保活任务失败：${r.out.trim().slice(0, 160)}`);
  return /EN=True/.test(r.out);
}

function runEnsureRunning() {
  log('检测到组件缺失，调起 ensure-running.mjs --force 拉起…');
  const res = spawnSync(process.execPath, ['scripts/ensure-running.mjs', '--force'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (out) out.split(/\r?\n/).forEach((l) => log(`  ${l}`));
  return res.status === 0;
}

// ---------- 主流程 ----------

const heavyChecks = ['qq', 'snowluma', 'hub', 'dsh', 'bridge'];

function componentsDown(report) {
  return heavyChecks.filter((k) => report[k] && !report[k].ok);
}

async function main() {
  // 防止定时任务与手动运行叠加（锁里存 pid:时间戳）
  try {
    const [prevPid, prevAt] = readText(LOCK).trim().split(':').map(Number);
    if (Number.isInteger(prevPid) && prevPid > 0 && Number.isFinite(prevAt) &&
        Date.now() - prevAt < 4 * 60 * 1000 && pidAlive(prevPid)) {
      log('另一个 doctor 还在跑（<4 分钟），本次跳过');
      return 0;
    }
  } catch { /* ignore */ }
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, `${process.pid}:${Date.now()}`, 'utf8');
  } catch { /* ignore */ }

  try {
    let report = await collect();
    const first = JSON.parse(JSON.stringify(report));
    const actions = [];

    if (!NO_REPAIR) {
      if (report.state.fixed) actions.push(report.state.detail);
      if (report.h3download?.fixed) actions.push(report.h3download.detail);
      if (!report.autostart.ok && !report.autostart.probeFailed) {
        const want = report.autostart.want || { autostart: true, doctor: true };
        const parts = report.autostart.parts || {};
        const done = [];
        let ok = true;
        // 只补「本来该有却没有」的那部分，绝不把用户主动关掉的又装回来
        if (want.autostart && !parts.keyOk) {
          ok = installAutostart('Run') && ok;
          done.push('开机自启');
        }
        if (want.doctor && (!parts.taskOk || parts.taskEnabled === false)) {
          ok = (parts.taskOk ? enableKeepAlive() : installAutostart('KeepAlive')) && ok;
          done.push('保活任务');
        }
        actions.push(done.length ? (ok ? `已重新注册：${done.join('、')}` : '自启重装失败（见上方输出）') : '无需处理');
      }
      // 组件缺失：交给 ensure-running（它负责 QQ/SnowLuma/DSH/hub/桥接的顺序与等待）
      if (componentsDown(report).length) {
        const ok = runEnsureRunning();
        actions.push(ok ? '已执行整栈拉起（ensure-running）' : '整栈拉起返回非 0（见上方日志）');
        // 端口刚绑定时偶有 1~2 秒抖动，给组件一点稳定时间再复检
        for (let i = 0; i < 3; i++) {
          await sleep(i === 0 ? 1500 : 3000);
          report = await collect();
          if (!componentsDown(report).length) break;
        }
      }
    }

    const rows = [];
    const order = ['config', 'state', 'autostart', 'qq', 'snowluma', 'dsh', 'hub', 'bridge', 'live', 'push', 'h3download', 'heartbeat', 'crashlog'];
    const titles = {
      config: '配置', state: '运行状态文件', autostart: '开机自启/保活', qq: 'QQ 账号',
      snowluma: 'QQ 协议端', dsh: 'DSH 桌面客户端', hub: '管理平台', bridge: 'QQ 桥接',
      live: 'B站直播采集', push: '谷时推送', h3download: 'H3 下载看门狗', heartbeat: '保活心跳', crashlog: '保活日志'
    };
    let fixedCount = 0;
    let failCount = 0;
    for (const key of order) {
      const now = report[key] || { ok: false, detail: '未检查' };
      const before = first[key] || { ok: false };
      let level = 'OK';
      let detail = now.detail;
      if (!now.ok) { level = 'FAIL'; failCount++; }
      else if (!before.ok) { level = 'FIXED'; fixedCount++; if (before.detail) detail = `已修复：${before.detail}`; }
      rows.push({ key, title: titles[key], level, detail });
    }

    if (JSON_OUT) {
      console.log(JSON.stringify({ at: timestamp(), ok: failCount === 0, results: rows, actions }, null, 2));
    } else {
      log(`=== bloom-hub 体检 ${timestamp()} ===`);
      for (const row of rows) log(`[${row.level.padEnd(5)}] ${row.title}：${row.detail}`);
      if (actions.length) log(`修复动作：${actions.join('；')}`);
      log(`服务入口：管理平台 http://127.0.0.1:${hubPort} · dsh-link http://127.0.0.1:${linkPort} · 桥接控制台 http://127.0.0.1:${bridgePort()}`);
      log(`结论：${rows.length - failCount} 项通过 / ${fixedCount} 项已修复 / ${failCount} 项失败`);
    }
    return failCount === 0 ? 0 : 1;
  } catch (e) {
    log(`doctor 自身异常：${e?.stack || e?.message || e}`);
    return 1;
  } finally {
    try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ }
  }
}

process.exitCode = await main();
