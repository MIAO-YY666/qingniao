// ============================================================
// hub.js —— bloom-hub 管理平台后端（独立进程，默认 127.0.0.1:3160）
// ------------------------------------------------------------
// 职责：
//   · 统一管理身份/峰谷窗口/推送/人格（config/suite.json + persona.yaml）
//   · 管理B站值班（duty/）：配置、状态、日报、判重表
//   · 谷时日报推送（services/push-service.js）
//   · B站发布工坊：发动态 / 发图文（tools/bili_cli.py，走 duty 的 venv）
//   · QQ 社交能力面板（services/qq-social.js，含能力探测）
//   · 探测并展示 core 桥接 / SnowLuma 网关 / DSH 的状态
// 鉴权：访问令牌（suite.hub.token；为空则首次启动自动生成）。
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { valleyStatus } from './scheduler.js';
import { loadPersona, savePersona, compileQQRoleCard, compileDutyAgentsMd, parsePersonaYaml, dumpPersonaYaml } from './persona.js';
import { createQqSocial, readCoreConfig } from './qq-social.js';
import { createPushService } from './push-service.js';
import { createMemoryStore } from './memory.js';
import { createComfy } from './comfy.js';
import { createBiliDraft } from './bili-draft.js';
import { createTts } from './tts.js';
import { createTaskRunner, parseTime, localDateKey, isoWeekKey } from './tasks.js';
import { createRouter } from './router.js';
import { loadCapabilities, assertConsistent } from '../config/capabilities.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_FILE = path.join(ROOT, 'config', 'suite.json');
const HUB_LOG = path.join(ROOT, 'logs', 'hub.log');
const AUTOPOST_STATE = path.join(ROOT, 'state', 'auto-post.json');

// ---------- 基础设施 ----------
function log(msg) {
  const line = `${new Date().toISOString()} [hub] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(HUB_LOG), { recursive: true });
    fs.appendFileSync(HUB_LOG, line + '\n', 'utf8');
  } catch { /* ignore */ }
}

function loadSuite() {
  try {
    return JSON.parse(fs.readFileSync(SUITE_FILE, 'utf8'));
  } catch (e) {
    console.error(`suite.json 读取失败：${e.message}`);
    process.exit(1);
  }
}
function saveSuite(suite) {
  const tmp = `${SUITE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(suite, null, 2), 'utf8');
  fs.renameSync(tmp, SUITE_FILE);
}

const suite = loadSuite();
const personaRef = { current: loadPersona(ROOT) };

// 令牌：空则生成并写回
function ensureToken() {
  if (!suite.hub?.token) {
    suite.hub = suite.hub || {};
    suite.hub.token = crypto.randomBytes(24).toString('base64url');
    saveSuite(suite);
    log(`已自动生成管理平台访问令牌（写入 config/suite.json）`);
  }
  return suite.hub.token;
}
// 令牌：必须可变。以前是 const 快照 + 轮换端点只改 suite.json，
// 结果"轮换成功"但新令牌当场 401、旧令牌继续有效到重启（三个令牌源各不相同）。
let HUB_TOKEN = ensureToken();
// 兼容：state/hub-token 文件（与旧控制台习惯一致）
try {
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'state', 'hub-token'), HUB_TOKEN, 'utf8');
} catch { /* ignore */ }

const PORT = Number(suite.hub?.port) || 3160;
const CORE_DIR = path.join(ROOT, suite.paths?.core || 'qq-bridge');
const DUTY_DIR = path.join(ROOT, suite.paths?.duty || 'bili-duty');

// ---- 生图归档 ----
// 以前出图后立刻 rmSync，图发完就没了，晚上写 B站动态想挑配图也没得挑。
// 现在统一落到 pictures/daily/<日期>/（pictures/ 本身已在 bili 侧图片白名单内），
// comfy-out 里的临时文件移走后即清空；每日 index.json 记录 prompt/时间，方便按内容挑图。
const ARCHIVE_ROOT = path.join(ROOT, 'pictures', 'daily');
function todayYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 把 comfy-out 的成品移进当日归档目录，返回归档后的绝对路径 */
function archiveImage(srcFile, meta = {}) {
  const dir = path.join(ARCHIVE_ROOT, todayYmd());
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(srcFile);
  let dest = path.join(dir, base);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, base.replace(/(\.[a-z0-9]+)$/i, `-${i}$1`));
    i += 1;
  }
  fs.renameSync(srcFile, dest); // 同盘移动，秒级
  try {
    const idxFile = path.join(dir, 'index.json');
    let idx = [];
    try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { idx = []; }
    if (!Array.isArray(idx)) idx = [];
    idx.push({
      file: path.basename(dest),
      at: Date.now(),
      time: new Date().toTimeString().slice(0, 5),
      jobId: meta.jobId || null,
      // prompt = 她自己写的那句（不掺外貌模板），promptFull = 实际送进 CLIPTextEncode 的完整串
      prompt: String(meta.prompt || ''),
      promptFull: String(meta.promptFull ?? meta.prompt ?? ''),
      negative: String(meta.negative || ''),
      width: meta.width ?? null,
      height: meta.height ?? null,
      steps: meta.steps ?? null,
      cfg: meta.cfg ?? null,
      seed: meta.seed ?? null,
      promptId: meta.promptId || null,
      selfImage: meta.selfImage === true,
      sendTo: meta.sendTo ?? null
    });
    fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
  } catch { /* 索引失败不影响主流程 */ }
  return dest;
}
/** 当日归档清单（只含仍然存在的图，按时间先后；给「挑配图」用） */
function listTodayImages(dateStr = todayYmd()) {
  return listDayImages(dateStr).filter((x) => !x.deleted);
}

/** 读某天的 index.json（原始数组） */
function readDayIndex(dateStr) {
  const dir = path.join(ARCHIVE_ROOT, dateStr);
  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { idx = []; }
  return { dir, idx: Array.isArray(idx) ? idx : [] };
}
function writeDayIndex(dir, idx) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
  } catch { /* 索引写失败不影响已删除的文件 */ }
}

/**
 * 某天完整清单（含已删记录）。
 * deleted 由 index.json 里的标记决定；标记为已删但文件还在（比如手工恢复）也算已删。
 */
function listDayImages(dateStr) {
  const { dir, idx } = readDayIndex(dateStr);
  let live = 0;
  const out = [];
  for (const x of idx) {
    if (!x || !x.file) continue;
    const abs = path.join(dir, x.file);
    const exists = fs.existsSync(abs);
    let bytes = 0;
    if (exists) { try { bytes = fs.statSync(abs).size; } catch { bytes = 0; } }
    const deleted = x.deleted === true || !exists;
    if (!deleted) live += 1;
    out.push({
      file: x.file,
      index: deleted ? null : live,
      time: x.time || '',
      at: x.at || 0,
      prompt: x.prompt || '',
      promptFull: x.promptFull || '',
      negative: x.negative || '',
      width: x.width ?? null,
      height: x.height ?? null,
      steps: x.steps ?? null,
      cfg: x.cfg ?? null,
      seed: x.seed ?? null,
      promptId: x.promptId ?? null,
      selfImage: x.selfImage === true,
      sendTo: x.sendTo ?? null,
      jobId: x.jobId ?? null,
      deleted,
      deletedAt: x.deletedAt || null,
      deletedBy: x.deletedBy || null,
      bytes,
      path: abs
    });
  }
  return out;
}

/** 所有有归档的日期（倒序），带汇总 */
function listArchiveDays() {
  let names = [];
  try {
    names = fs.readdirSync(ARCHIVE_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name);
  } catch { names = []; }
  names.sort().reverse();
  return names.map((date) => {
    const all = listDayImages(date);
    const kept = all.filter((x) => !x.deleted);
    return {
      date,
      total: all.length,
      kept: kept.length,
      deleted: all.length - kept.length,
      bytes: kept.reduce((s, x) => s + (x.bytes || 0), 0)
    };
  });
}

/**
 * 删除归档图：真删文件 + 在 index.json 里打【已删】标记（保留记录，便于回看「这天画过什么」）。
 * by: 'admin'（管理端手动）| 'agent'（她自己每周清理）
 */
function deleteArchiveImages(dateStr, files, by = 'admin') {
  const { dir, idx } = readDayIndex(dateStr);
  const targets = new Set((files || []).map((f) => path.basename(String(f))));
  const removed = [];
  for (const x of idx) {
    if (!x || !x.file || !targets.has(x.file)) continue;
    const abs = path.join(dir, x.file);
    try { if (fs.existsSync(abs)) fs.rmSync(abs, { force: true }); } catch { /* 删不掉也照样标记 */ }
    if (x.deleted !== true) {
      x.deleted = true;
      x.deletedAt = Date.now();
      x.deletedBy = by;
      removed.push(x.file);
    }
  }
  writeDayIndex(dir, idx);
  return removed;
}

// ---- 开机自启 / doctor 保活 开关 ----
// 两个东西各自独立：
//   autostart → 注册表 Run 键 BloomHub（登录时隐藏跑 doctor.mjs，把整栈拉起来）
//   doctor    → 计划任务 BloomHub-KeepAlive（每 5 分钟体检 + 自愈）
// 状态存 state/service-toggles.json；doctor.mjs 也会读它，
// 关掉之后 doctor 不会再把自启项偷偷装回来。
const TOGGLES_FILE = path.join(ROOT, 'state', 'service-toggles.json');
const RUN_KEY_NAME = 'BloomHub';
const KEEPALIVE_TASK = 'BloomHub-KeepAlive';

function readToggles() {
  try {
    const j = JSON.parse(fs.readFileSync(TOGGLES_FILE, 'utf8'));
    return {
      autostart: j.autostart !== false, // 默认开
      doctor: j.doctor !== false,
      updatedAt: j.updatedAt ?? null
    };
  } catch {
    return { autostart: true, doctor: true, updatedAt: null };
  }
}
function writeToggles(t) {
  fs.mkdirSync(path.dirname(TOGGLES_FILE), { recursive: true });
  fs.writeFileSync(TOGGLES_FILE, JSON.stringify(t, null, 2), 'utf8');
}
function runCmd(cmd, args, timeout = 20000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
    return { code: r.status === null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  } catch (e) {
    return { code: -1, out: e.message };
  }
}
/** Task Scheduler 的状态枚举 → 文本（COM 返回数字：1=Disabled 2=Queued 3=Ready 4=Running） */
const TASK_STATE_TEXT = { 1: 'Disabled', 2: 'Queued', 3: 'Ready', 4: 'Running' };

/**
 * 走 COM（Schedule.Service）而不是 Get-ScheduledTask：
 * 后者光是加载 ScheduledTasks 模块就要 ~3 秒，COM 只要 ~260ms。
 */
function psTaskProbe() {
  return [
    `$s=New-Object -ComObject Schedule.Service;$s.Connect()`,
    `try{$t=$s.GetFolder('\\').GetTask('${KEEPALIVE_TASK}')`,
    `'TASK=1';'STATE='+$t.State;'NEXT='+$t.NextRunTime.ToString('yyyy-MM-dd HH:mm')}catch{'TASK=0'}`
  ].join(';');
}

/** 解析探测输出（KEY= / TASK= / STATE= / NEXT=），探测与变更共用 */
function parseAutostartProbe(out) {
  const text = String(out || '');
  const keyM = text.match(/KEY=([01])/);
  const taskM = text.match(/TASK=([01])/);
  if (!keyM || !taskM) {
    return { probeFailed: true, runKey: null, task: { exists: null, enabled: null, state: 'unknown', nextRun: null } };
  }
  const stateNum = Number((text.match(/STATE=(\d+)/) || [])[1]);
  const state = TASK_STATE_TEXT[stateNum] || String(stateNum || 'unknown');
  const next = (text.match(/NEXT=(.+)/) || [])[1] || null;
  const exists = taskM[1] === '1';
  return {
    probeFailed: false,
    runKey: keyM[1] === '1',
    task: {
      exists,
      // COM 里 State=1 就是 Disabled
      enabled: exists ? stateNum !== 1 : false,
      state,
      nextRun: next && next !== 'null' && !/^0+/.test(next.trim()) ? next.trim() : null
    }
  };
}

/** 探测自启项与保活任务 */
function probeWindowsAutostart() {
  const ps = [
    `$k=(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${RUN_KEY_NAME}' -ErrorAction SilentlyContinue).${RUN_KEY_NAME}`,
    `if($k){'KEY=1'}else{'KEY=0'}`,
    psTaskProbe()
  ].join(';');
  const r = runCmd('powershell', ['-NoProfile', '-Command', ps], 20000);
  return parseAutostartProbe(r.out);
}
function autostartActual() {
  if (process.platform !== 'win32') {
    return { supported: false, probeFailed: false, runKey: null, task: { exists: null, enabled: null, state: 'n/a', nextRun: null } };
  }
  return { supported: true, ...probeWindowsAutostart() };
}
/**
 * 一次性应用所有开关变更，并在同一次 PowerShell 调用里回报最终状态。
 * 全部走 COM + 注册表 cmdlet：约 300~500ms。
 * （早先用 Get-ScheduledTask 时，光加载 ScheduledTasks 模块就要 3 秒，页面像卡死。）
 */
function applyToggleChanges(changes) {
  const keyPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const runValue = `wscript.exe "${path.join(ROOT, 'autostart.vbs')}"`.replace(/'/g, "''");
  const installScript = path.join(ROOT, 'scripts', 'install-autostart.ps1').replace(/'/g, "''");
  const parts = [`$p='${keyPath}'`];
  if (typeof changes.autostart === 'boolean') {
    parts.push(changes.autostart
      ? `New-ItemProperty -Path $p -Name '${RUN_KEY_NAME}' -Value '${runValue}' -PropertyType String -Force | Out-Null`
      : `Remove-ItemProperty -Path $p -Name '${RUN_KEY_NAME}' -ErrorAction SilentlyContinue`);
  }
  if (typeof changes.doctor === 'boolean') {
    // 任务万一被删了先补装（极少见）
    parts.push(`$s=New-Object -ComObject Schedule.Service;$s.Connect();` +
      `try{$t=$s.GetFolder('\\').GetTask('${KEEPALIVE_TASK}')}catch{` +
      `& powershell -NoProfile -ExecutionPolicy Bypass -File '${installScript}' -Only KeepAlive *> $null;` +
      `$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$s.GetFolder('\\').GetTask('${KEEPALIVE_TASK}')}`);
    parts.push(`$t.Enabled=$${changes.doctor ? 'true' : 'false'}`);
  }
  parts.push(
    `if((Get-ItemProperty -Path $p -Name '${RUN_KEY_NAME}' -ErrorAction SilentlyContinue).${RUN_KEY_NAME}){'KEY=1'}else{'KEY=0'}`,
    psTaskProbe()
  );
  const r = runCmd('powershell', ['-NoProfile', '-Command', parts.join(';')], 90000);
  return parseAutostartProbe(r.out);
}

const qqSocial = createQqSocial(CORE_DIR);

// 语音合成：引擎/persona 里的 voice 段决定用哪套，产物落 state/tts-out/
// QQ 语音出站总开关（与 TTS 本身解耦）：
//   · tts.qqVoice.enabled === false → 只关"给 QQ 发语音"，/api/tts/speak 仍可试听
//   · tts.enabled === false        → 连合成一起关（老开关，保留兼容）
function qqVoiceOffReason() {
  if (suite.tts?.enabled === false) {
    return '语音已在 config/suite.json 关闭（tts.enabled=false）';
  }
  // 默认**关闭**：音色还没做到可用的程度，宁可默认不出声。
  // 注意 `enabled !== true` 而不是 `=== false`——配置缺失时也按关闭处理，
  // 这样即使 suite.json 被重建/丢失，也不会自己开始往群里发语音。
  const q = suite.tts?.qqVoice;
  if (!q || q.enabled !== true) {
    return String(q?.reason || 'QQ 语音出站默认关闭（config/suite.json → tts.qqVoice.enabled 需显式设为 true）');
  }
  return null;
}

const tts = createTts({
  root: ROOT,
  suite,
  log,
  getPersonaVoice: () => personaRef.current?.voice || {}
});

// 语音识别：调 tools/voice/asr_cli.py（sherpa-onnx + SenseVoice，纯 CPU）
const VOICE_PY = path.join(ROOT, 'tools', 'voice', '.venv', 'Scripts', 'python.exe');
const ASR_CLI = path.join(ROOT, 'tools', 'voice', 'asr_cli.py');
async function transcribeFile(absPath) {
  if (!fs.existsSync(VOICE_PY) || !fs.existsSync(ASR_CLI)) {
    return { ok: false, error: '语音环境未安装（tools/voice/.venv 或 asr_cli.py 缺失）' };
  }
  if (!fs.existsSync(absPath)) return { ok: false, error: `音频不存在：${absPath}` };
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(VOICE_PY, [ASR_CLI, '--in', absPath, '--json'], {
      windowsHide: true,
      // Windows 下 Python 的 stderr 默认按 GBK 输出，不钉 UTF-8 会把中文报错读成乱码
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 120000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let meta = null;
      try { meta = JSON.parse((out || '').trim().split('\n').pop() || 'null'); } catch { meta = null; }
      if (code === 0 && meta?.text) {
        resolve({ ok: true, text: meta.text, backend: meta.backend, ms: Date.now() - started, audioSec: meta.audioSec });
      } else {
        resolve({ ok: false, error: (err || '').trim().slice(-300) || `ASR 退出码 ${code}` });
      }
    });
  });
}

const push = createPushService({
  root: ROOT, suite, personaRef, qqSocial, log,
  // 日报是平台直连 OneBot 发出去的，桥接的会话流里本来没有这条记录，
  // 于是 QQ 侧的她「不知道自己推过」。推送成功后回灌一条 isSelf 消息。
  recordPlatformMessage: async ({ target, date, text, silent }) => {
    const core = readCoreConfig(CORE_DIR);
    const port = Number(core.consolePort) || 3100;
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/platform-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': bridgeConsoleToken() },
      body: JSON.stringify({ key: `private:${target}`, date, text: String(text).slice(0, 4000), silent: !!silent }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  // 日报里没写「给他的QQ」段时，把摘要发给桥接，由她按人设生成开场白。
  // 任何失败返回 null，push-service 会自动回退到值班原文 / 模板，不阻断推送。
  generatePushText: async ({ date, items, commented, qqNote }) => {
    const core = readCoreConfig(CORE_DIR);
    const port = Number(core.consolePort) || 3100;
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/generate-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': bridgeConsoleToken() },
      body: JSON.stringify({ date, items, commented, qqNote }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok && typeof data.text === 'string' ? data.text : null;
  }
});
const memoryStore = createMemoryStore({
  root: ROOT,
  backupPath: path.join(os.homedir(), '.qingniao-backup', 'memory'),
  log
});
const comfy = createComfy({ suite: { ...suite, _root: ROOT }, log });

// B站动态「先审后发」：草稿存 state/bili-draft.json，审批走 QQ 私聊
// 审核人 = qq-bridge/config.json → biliReviewerQQ（真人主人），不是 ownerQQ（那是 bot 自己的号）
const biliDraft = createBiliDraft({
  root: ROOT,
  log,
  qqSocial,
  runBiliCli,
  // 动态发布后清理配图：走统一的归档删除，保证 index.json 打上【已删】标记
  deleteImages: (date, files) => deleteArchiveImages(date, files, 'bili'),
  ownerQQ: Number(readCoreConfig(CORE_DIR).biliReviewerQQ)
    || Number(suite.identity?.pushTargetQQ)
    || Number(suite.identity?.ownerQQ)
    || 0
});

// DSH 固定入口：桥接继续连 3080，由 dsh-link 转发到桌面客户端的内嵌 web（动态端口）
async function startDshLink() {
  try {
    const { mintDshAuthCookie } = await import(pathToFileURL(path.join(CORE_DIR, 'src', 'dsh-client.js')).href);
    const { createDshLink } = await import('./dsh-link.js');
    const link = createDshLink({ suite, log, mintCookie: mintDshAuthCookie, token: () => HUB_TOKEN });
    const port = Number(suite.paths?.dshLinkPort) || 3080;
    await link.listen(port, '127.0.0.1');
    await link.discover().catch(() => {});
  } catch (e) {
    log(`dsh-link 启动失败：${e.message}`);
  }
}

// ---------- B站 CLI 调用 ----------
function biliPython() {
  const venvPy = path.join(DUTY_DIR, '.venv', 'Scripts', 'python.exe');
  return fs.existsSync(venvPy) ? venvPy : 'python';
}
function runBiliCli(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(biliPython(), [path.join(ROOT, 'tools', 'bili_cli.py'), ...args], {
      cwd: DUTY_DIR,
      windowsHide: true
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `bili_cli 超时（${timeoutMs}ms）`, stdout: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null');
        resolve(parsed ?? { ok: false, error: `bili_cli 退出码 ${code}`, stdout: out, stderr: err });
      } catch {
        resolve({ ok: code === 0, error: code === 0 ? null : `退出码 ${code}: ${err.slice(-400)}`, stdout: out.slice(-2000), stderr: err.slice(-2000) });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}

// ---------- 探测 ----------
async function probeUrl(url, timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { up: true, code: res.status };
  } catch {
    return { up: false };
  }
}

/**
 * 严格探活：只有 2xx 且 body.ok === true 才算健康。
 * 以前只看"非 503"，结果 dsh-link 缺令牌返 401 也被当成健康（假健康）。
 */
async function probeHealth(url, timeoutMs = 2500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { up: res.status >= 200 && res.status < 300 && body?.ok === true, code: res.status, body };
  } catch (e) {
    return { up: false, code: 0, error: String(e?.message || e) };
  }
}

function bridgeConsoleToken() {
  const cfg = readCoreConfig(CORE_DIR);
  if (cfg.consoleToken) return cfg.consoleToken;
  try {
    return fs.readFileSync(path.join(CORE_DIR, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// 桥接「群友关注度 + 群成员」查询，带 5 秒缓存：
// 管理平台一次加载会同时问 /api/attention 和 /api/qq/allowlist（要拿候选人），
// 不缓存就会并发打两次桥接——而进程内首次连桥接要 3~5 秒，很容易并发超时。
let attentionCache = { at: 0, data: null };
async function bridgeAttentionCached({ maxAgeMs = 5000 } = {}) {
  if (attentionCache.data && Date.now() - attentionCache.at < maxAgeMs) return attentionCache.data;
  const core = readCoreConfig(CORE_DIR);
  const port = Number(core.consolePort) || 3100;
  const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/attention`, {
    headers: { 'x-console-token': bridgeConsoleToken() },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const out = {
    attention: data.attention || {},
    members: Array.isArray(data.members) ? data.members : []
  };
  attentionCache = { at: Date.now(), data: out };
  return out;
}

// ---------- ComfyUI 异步生图任务 ----------
// 背景：MCP 工具的调用超时（约 60s）远短于「冷启动 ComfyUI + 出图」的耗时（60~180s），
// 同步等待必然超时：模型只看到 timeout，图却已经发出去了，于是它「不知道自己发过图」。
// 改成：立刻返回 jobId，后台出图 → 发 QQ → 唤醒会话并把「你发了什么图」写进唤醒原因。
const COMFY_JOBS = new Map();

function pruneComfyJobs() {
  while (COMFY_JOBS.size > 20) COMFY_JOBS.delete(COMFY_JOBS.keys().next().value);
}

/** 唤醒指定私聊会话，把 reason 原样带进唤醒提示词（桥接 buildWakePromptV2 会回显）。 */
async function wakePrivateChat(userId, reason) {
  const cfg = readCoreConfig(CORE_DIR);
  const port = Number(cfg.consolePort) || 3100;
  const token = bridgeConsoleToken();
  if (!token) throw new Error('缺少桥接控制台令牌');
  const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ key: `private:${Number(userId)}`, reason: String(reason || '生图完成') })
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || data?.ok === false) {
    throw new Error(`唤醒失败 HTTP ${res.status}：${data?.error || text.slice(0, 120)}`);
  }
  return data;
}

async function bridgeStatus() {
  const cfg = readCoreConfig(CORE_DIR);
  const port = cfg.consolePort || 3100;
  const base = `http://127.0.0.1:${port}`;
  const up = await probeUrl(base, 2000);
  if (!up.up) return { up: false, port };
  try {
    const res = await fetch(`${base}/api/status`, { headers: { 'x-console-token': bridgeConsoleToken() } });
    const data = await res.json();
    return { up: true, port, ...data };
  } catch (e) {
    return { up: true, port, error: String(e.message || e) };
  }
}

async function dshStatus() {
  const base = (suite.paths?.dshBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const up = await probeUrl(base, 2500);
  return { up: up.up, baseUrl: base };
}

async function gatewayStatus() {
  const probe = await qqSocial.probe();
  return probe;
}

// ---------- 人格同步 ----------
function syncDutyAgentsMd() {
  try {
    const md = compileDutyAgentsMd(personaRef.current);
    fs.writeFileSync(path.join(DUTY_DIR, 'AGENTS.md'), md, 'utf8');
    return true;
  } catch (e) {
    log(`duty/AGENTS.md 同步失败：${e.message}`);
    return false;
  }
}

function applyPersonaToCore({ setAsCurrent = false } = {}) {
  const p = personaRef.current;
  const activeId = p.active;
  const list = Array.isArray(p.personas) ? p.personas : [];
  const active = list.find((x) => x.id === activeId) || list[0];
  if (!active) throw new Error('persona.yaml 未定义人格');
  // 生成的卡带「统一-」前缀，避免覆盖手写角色卡（历史卡已归档 roles/_archive/）
  const cardName = `统一-${active.name || active.id}`;
  const md = compileQQRoleCard(p, active.id);
  fs.mkdirSync(path.join(CORE_DIR, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(CORE_DIR, 'roles', `${cardName}.md`), md, 'utf8');
  let roleState = null;
  if (setAsCurrent) {
    const roleFile = path.join(CORE_DIR, 'state', 'current-role.json');
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(roleFile, 'utf8')); } catch { /* ignore */ }
    roleState = { role: cardName, mode: prev.mode || 'active' };
    fs.writeFileSync(roleFile, JSON.stringify(roleState, null, 2), 'utf8');
  }
  return { cardName, roleState };
}

// ---------- B站定时动态（可选开关） ----------
function loadAutoPostState() {
  try { return JSON.parse(fs.readFileSync(AUTOPOST_STATE, 'utf8')); } catch { return {}; }
}
function saveAutoPostState(s) {
  fs.mkdirSync(path.dirname(AUTOPOST_STATE), { recursive: true });
  fs.writeFileSync(AUTOPOST_STATE, JSON.stringify(s, null, 2), 'utf8');
}

async function composeDigestDynamic() {
  // 用今天（或最近一天）的日报生成动态文案
  const reports = push.listReports();
  if (!reports.length) return null;
  const md = push.readReport(reports[0]);
  const digest = push.parseReportDigest(md, 3);
  if (!digest.items.length) return null;
  const activePersona = personaRef.current.personas?.find((x) => x.id === personaRef.current.active) || personaRef.current.personas?.[0];
  const lines = [`【${activePersona?.name || 'AI'}的B站值班日报 · ${digest.date.slice(5)}】`];
  for (const it of digest.items) lines.push(`${it.title} ${it.link}`);
  lines.push('');
  lines.push('挑B站值得看的视频，评论里@了主人。完整日报与依据见值班记录。');
  return lines.join('\n');
}

// 定时任务体：日报 → B站动态（直发，不走审核；要审核的走 autoDraft 那条）
async function taskAutoDigestDynamic() {
  const cfg = suite.bili?.autoDigestDynamic;
  if (!cfg?.enabled) return false;
  const text = await composeDigestDynamic();
  if (!text) return false; // 没有日报就不算跑过，等当天有日报再说
  const r = await runBiliCli(['send-dynamic', '--text', text]);
  if (!r.ok) {
    log(`定时B站动态发布失败：${r.error || '未知错误'}`);
    return false;
  }
  log('定时B站动态已发布');
  return true;
}

// 每日 B站动态草稿：到点唤醒她写一条 → 她调 bili_draft_submit → 推主人审核
// 与 autoDigestDynamic（日报汇总直发）不同：这条必须走审核，不会自动发出去。
// 日期键统一用 tasks.js 的 localDateKey（原来这里另有一份 localDateStr，已合并）

function loadAutoDraftState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'auto-draft-state.json'), 'utf8'));
  } catch {
    return { lastDraftDate: '' };
  }
}
function saveAutoDraftState(s) {
  try {
    fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'state', 'auto-draft-state.json'), JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    log(`[bili-draft] 保存定时状态失败：${e.message}`);
  }
}

// 定时任务体：到点唤醒她写一条动态草稿 → 她调 bili_draft_submit → 推主人审核
async function taskAutoDraft() {
  const cfg = suite.bili?.autoDraft;
  if (!cfg?.enabled) return false;
  // 已经有待审草稿就别催她再写一条（算作今天已完成，避免每 30 秒重复判断）
  if (biliDraft.pending()) {
    log('[bili-draft] 今日已有待审草稿，跳过定时生成');
    return true;
  }
  const reviewer = Number(readCoreConfig(CORE_DIR).biliReviewerQQ)
    || Number(suite.identity?.pushTargetQQ);
  if (!reviewer) {
    log('[bili-draft] 未配置审核人（biliReviewerQQ），定时生成跳过');
    return false;
  }
  await wakePrivateChat(
    reviewer,
    '到点写今天的 B站动态了。从今天你和主人的聊天、你记下的印象里，挑一件真实的小事或一个感受，' +
    '写成口语化的短文，长度随你，想写多长写多长（唯一硬限制是 B站单条动态 1000 字，平台限制）。' +
    '别写成宣传稿，也别写具体隐私：手机号/住址/他人隐私都不行。' +
    '想配图就先调 gen_image_gallery 看今天画了哪些，挑几张顺眼的传序号给 bili_draft_submit；' +
    '不想配就不配，纯文字也很好。新画的话用 gen_image 或 gen_self_image，出图后同样能用序号选。' +
    '写完调用 bili_draft_submit 提交，主人审核通过才会真正发到 B站。'
  );
  log(`[bili-draft] 定时已唤醒 ${reviewer} 写今日动态`);
  return true;
}

// 每周归档清理：到点唤醒她，让她自己看这周画了什么、决定删掉哪些
// 只提醒不代劳 —— 删什么由她定，管理端也能手动删（两边都会在 index.json 打【已删】）
function loadCleanupState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'gallery-cleanup-state.json'), 'utf8'));
  } catch {
    return { lastWeek: '' };
  }
}
function saveCleanupState(s) {
  try {
    fs.writeFileSync(path.join(ROOT, 'state', 'gallery-cleanup-state.json'), JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    log(`[gallery] 保存清理状态失败：${e.message}`);
  }
}

// 定时任务体：每周提醒她整理生图（只提醒不代劳，删什么由她定）
async function taskGalleryCleanup() {
  const days = listArchiveDays().filter((d) => d.kept > 0);
  if (!days.length) {
    log('[gallery] 本周没有待清理的生图，跳过');
    return true;
  }
  const totalMb = Math.round(days.reduce((s, d) => s + d.bytes, 0) / 1048576);
  const lines = days.map((d) => `${d.date}：${d.kept} 张（${Math.round(d.bytes / 1048576)}MB）`).join('；');
  const target = Number(readCoreConfig(CORE_DIR).biliReviewerQQ)
    || Number(suite.identity?.pushTargetQQ);
  if (!target) {
    log('[gallery] 未配置唤醒对象，每周清理跳过');
    return false;
  }
  await wakePrivateChat(
    target,
    `每周整理时间：你这一周画了不少图，一共 ${days.length} 天、${totalMb}MB。\n${lines}\n` +
    '先调 gen_image_gallery 逐天看看（可以传 date 看往日），把不想要的用 gen_image_delete 删掉——' +
    '删了就真没了，留下的图晚上写 B站动态可以拿来配图。不想删也可以，直接说一声就行，不用勉强。'
  );
  log(`[gallery] 每周清理已唤醒（${days.length} 天 / ${totalMb}MB）`);
  return true;
}

// ---------- 定时任务注册（统一 runner，见 services/tasks.js）----------
const taskRunner = createTaskRunner({ root: ROOT, log });

function registerScheduledTasks() {
  // 日报 → 动态（可选）
  taskRunner.register({
    id: 'bili.auto-digest',
    enabled: () => suite.bili?.autoDigestDynamic?.enabled === true,
    dueAt: () => parseTime(suite.bili?.autoDigestDynamic?.time, '12:45'),
    key: () => localDateKey(),
    legacy: { file: 'state/auto-post.json', pick: (o) => o?.lastAutoPostDate },
    run: taskAutoDigestDynamic
  });

  // 唤醒她写草稿（走审核）
  taskRunner.register({
    id: 'bili.auto-draft',
    enabled: () => suite.bili?.autoDraft?.enabled === true,
    dueAt: () => parseTime(suite.bili?.autoDraft?.time, '22:30'),
    key: () => localDateKey(),
    legacy: { file: 'state/auto-draft-state.json', pick: (o) => o?.lastDraftDate },
    run: taskAutoDraft
  });

  // 每周整理生图
  taskRunner.register({
    id: 'comfy.gallery-cleanup',
    enabled: () => suite.comfy?.weeklyCleanup?.enabled === true,
    dueAt: () => ({
      ...parseTime(suite.comfy?.weeklyCleanup?.time, '21:00'),
      weekday: Number.isFinite(Number(suite.comfy?.weeklyCleanup?.weekday))
        ? Number(suite.comfy.weeklyCleanup.weekday)
        : 0
    }),
    key: () => isoWeekKey(),
    legacy: { file: 'state/gallery-cleanup-state.json', pick: (o) => o?.lastWeek },
    run: taskGalleryCleanup
  });

  return taskRunner;
}

// ---------- 路由表（services/router.js）----------
// 迁移策略：**新端点一律走路由表**；老的 if 链仍在 handle() 里，逐条搬。
// dispatch 未命中返回 false → 自动回落到老链路，所以可以安全地一条一条搬。
// 注意：鉴权由 router 统一做（auth:'public' 才免令牌），不用在 handler 里再手写一遍。
const router = createRouter({
  log,
  authOk: (req, url) => authOk(req, url)
});

// /healthz：免鉴权、只回布尔与计数（不含任何机密）。
// 用途：doctor / ensure-running 判「进程活着但能力已死」；也是阶段门禁的取数口。
router.get('/healthz', async ({ send }) => {
  const caps = loadCapabilities();
  const consist = assertConsistent({ root: ROOT });
  const linkBase = (suite.paths?.dshBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const [bridge, linkProbe, gw] = await Promise.all([
    bridgeStatus().catch((e) => ({ up: false, error: String(e?.message || e) })),
    probeHealth(`${linkBase}/healthz`, 2000),
    qqSocial.probe().catch(() => ({ online: false }))
  ]);
  send({
    ok: true,
    service: 'hub',
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    port: PORT,
    checks: {
      bridge: { up: Boolean(bridge.up), dshReady: bridge.dshReady === true, mode: bridge.mode ?? null, port: bridge.port ?? null },
      dshLink: { up: linkProbe.up, code: linkProbe.code, targetReady: linkProbe.body?.targetReady === true },
      gateway: { online: gw.online === true, loginQQ: gw.loginQQ ?? null }
    },
    queueDepth: 0,
    comfyJobs: COMFY_JOBS.size,
    platformCount: 1 + (suite.live?.enabled === true ? 1 : 0),
    capabilitySyncPoints: caps.list.filter((c) => c.toolFlag).length,
    capabilityDegraded: caps.degraded === true,
    capabilityConsistent: consist.ok,
    capabilityIssues: consist.ok ? [] : consist.issues
  });
}, { auth: 'public', name: 'healthz' });

// ---- B站直播弹幕（只收不发）----
router.get('/api/bili/live/status', async ({ send }) => {
  let hb = null;
  try {
    hb = JSON.parse(fs.readFileSync(path.join(ROOT, suite.live?.heartbeatFile || 'state/live-heartbeat.json'), 'utf8'));
  } catch { hb = null; }
  const cfg = suite.live || {};
  const freshMs = hb?.at ? Date.now() - hb.at * 1000 : Infinity;
  send({
    ok: true,
    enabled: cfg.enabled === true,
    rooms: cfg.roomIds || [],
    heartbeat: hb,
    // 心跳 >90 秒没刷新 = sidecar 挂了或在重连
    staleSec: Number.isFinite(freshMs) ? Math.round(freshMs / 1000) : null,
    healthy: Boolean(hb?.ok && freshMs < 90 * 1000)
  });
}, { name: 'live.status' });

router.get('/api/bili/live/events', async ({ url, send }) => {
  const since = Number(url.searchParams.get('since') || 0);
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const file = path.join(ROOT, suite.live?.eventsFile || 'bili-duty/out/live-events.jsonl');
  const events = [];
  try {
    const st = fs.statSync(file);
    // 只读尾部 2MB：弹幕文件会一直长，不整文件读进内存
    const start = Math.max(0, st.size - 2 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0) lines.shift(); // 首行可能被截断
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Number(row.seq) > since) events.push(row);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 = 还没采到 */ }
  events.sort((a, b) => a.seq - b.seq);
  const slice = events.slice(-limit);
  send({ ok: true, total: events.length, lastSeq: slice.length ? slice[slice.length - 1].seq : since, events: slice });
}, { name: 'live.events' });

router.any('/api/bili/live/send', async ({ send }) => {
  // 默认关闭：B站发弹幕是高可见度写操作，且私信轮询已有 -509 前科。
  // 要开就走「建议模式」→ 复用 bili-draft 的 QQ 审核链，而不是直接放行。
  send({
    ok: false,
    error: '直播发弹幕默认关闭（写操作风险高）。如需开启：先做建议模式 → 人工确认 → 再发，不要直接放开。',
    hint: 'bili.live-send 在 config/capabilities.json 里 enabled=false'
  }, 403);
}, { name: 'live.send' });

// ---------- HTTP ----------
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // 页面是单文件内联脚本/样式，与桥接控制台同策略：self + unsafe-inline
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
};

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求必须是合法 JSON'); }
}

function tailFile(file, lines = 100) {
  try {
    const data = fs.readFileSync(file, 'utf8').trimEnd();
    return data.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function authOk(req, url) {
  const supplied = url.searchParams.get('token') ?? req.headers['x-hub-token'];
  return safeTokenEqual(supplied, HUB_TOKEN);
}

// 常量时间比较令牌：哈希后比较，兼容长度差异，避免逐字节比较的时序侧信道。
function safeTokenEqual(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const send = (obj, code) => sendJson(res, obj, code);

  // CSRF 防线（与桥接控制台一致，先于路由分发——路由表与老 if 链都要过这道闸）：
  // 写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
  if (req.method !== 'GET') {
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.toLowerCase().includes('application/json')) {
      send({ ok: false, error: '请求必须是 application/json' }, 415);
      return;
    }
    const origin = req.headers['origin'];
    if (origin) {
      let originHost = '';
      try { originHost = new URL(String(origin)).host; } catch { /* 非法 Origin 一律拒绝 */ }
      if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(originHost)) {
        send({ ok: false, error: '跨站请求被拒绝' }, 403);
        return;
      }
    }
  }

  // 路由表优先：命中即返回；未命中回落到下面的老 if 链（迁移期保险）
  if (await router.dispatch(req, res, url, { send, readJsonBody })) return;

  // 静态页面（根路径放行，其余 API 鉴权）
  if (req.method === 'GET' && p === '/') {
    try {
      const html = fs.readFileSync(path.join(ROOT, 'manage', 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('管理平台页面缺失');
    }
    return;
  }

  if (!authOk(req, url)) {
    send({ ok: false, error: '未授权：请提供管理平台访问令牌（?token= 或 x-hub-token）' }, 401);
    return;
  }

  try {
    // ---- 总览 ----
    if (req.method === 'GET' && p === '/api/overview') {
      const [bridge, dsh, gateway] = await Promise.all([bridgeStatus(), dshStatus(), gatewayStatus()]);
      let dutyState = {};
      try { dutyState = JSON.parse(fs.readFileSync(path.join(DUTY_DIR, 'state.json'), 'utf8')); } catch { /* ignore */ }
      send({
        ok: true,
        hub: { version: '1.0.0', uptimeSec: Math.round(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
        valley: valleyStatus(suite.valley?.windows),
        alwaysReply: suite.valley?.alwaysReply !== false,
        bridge: { up: bridge.up, mode: bridge.mode ?? null, role: bridge.role ?? null, dshReady: bridge.dshReady ?? null, port: bridge.port },
        dsh,
        gateway: { online: gateway.online, version: gateway.version ?? null, loginQQ: gateway.loginQQ ?? null, loginNickname: gateway.loginNickname ?? null, error: gateway.error ?? null },
        duty: { lastRunAt: dutyState.lastRunAt ?? null, lastWhy: dutyState.lastWhy ?? null, todayCount: dutyState.count ?? 0, windows: dutyState.windows ?? {} },
        identity: suite.identity
      });
      return;
    }

    // ---- 人格 ----
    if (req.method === 'GET' && p === '/api/persona') {
      send({ ok: true, persona: personaRef.current, yaml: dumpPersonaYaml(personaRef.current) });
      return;
    }
    if (req.method === 'POST' && p === '/api/persona') {
      const body = await readJsonBody(req);
      if (body.yaml) {
        personaRef.current = parsePersonaYaml(body.yaml);
      } else if (body.persona) {
        personaRef.current = body.persona;
      } else {
        throw new Error('需要 persona 或 yaml 字段');
      }
      savePersona(ROOT, personaRef.current);
      syncDutyAgentsMd();
      send({ ok: true, persona: personaRef.current });
      return;
    }
    if (req.method === 'POST' && p === '/api/persona/apply') {
      const body = await readJsonBody(req);
      const targets = Array.isArray(body.to) ? body.to : ['duty'];
      const result = {};
      if (targets.includes('duty')) result.dutyAgentsMd = syncDutyAgentsMd();
      if (targets.includes('qq')) {
        const r = applyPersonaToCore({ setAsCurrent: !!body.setAsCurrent });
        result.qqRoleCard = r.cardName;
        result.roleState = r.roleState;
      }
      send({ ok: true, ...result, note: body.setAsCurrent ? '桥接需重载角色后生效（QQ 里发 /role 或在 :3100 控制台确认）' : undefined });
      return;
    }

    // ---- 峰谷 / 推送配置 ----
    if (req.method === 'GET' && p === '/api/schedule') {
      send({ ok: true, valley: suite.valley, push: { ...suite.push, target: suite.identity?.pushTargetQQ } });
      return;
    }
    if (req.method === 'POST' && p === '/api/schedule') {
      const body = await readJsonBody(req);
      if (body.valley) suite.valley = { ...suite.valley, ...body.valley };
      if (body.push) suite.push = { ...suite.push, ...body.push };
      if (body.pushTargetQQ) suite.identity.pushTargetQQ = Number(body.pushTargetQQ);
      if (body.alwaysReply !== undefined) suite.valley.alwaysReply = !!body.alwaysReply;
      saveSuite(suite);
      log('峰谷/推送配置已更新');
      send({ ok: true, valley: suite.valley, push: suite.push });
      return;
    }

    // ---- 推送 ----
    if (req.method === 'GET' && p === '/api/push/status') {
      send({ ok: true, ...push.status() });
      return;
    }
    if (req.method === 'POST' && p === '/api/push/now') {
      const body = await readJsonBody(req);
      const r = await push.pushNow(body.date);
      send({ ok: true, ...r });
      return;
    }

    // ---- 值班（刷B站） ----
    if (req.method === 'GET' && p === '/api/duty/status') {
      let dutyState = {};
      try { dutyState = JSON.parse(fs.readFileSync(path.join(DUTY_DIR, 'state.json'), 'utf8')); } catch { /* ignore */ }
      let config = {};
      try { config = JSON.parse(fs.readFileSync(path.join(DUTY_DIR, 'config.json'), 'utf8')); } catch { /* ignore */ }
      const reports = fs.readdirSync(path.join(DUTY_DIR, 'out')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.replace(/\.md$/, '')).sort().reverse();
      send({
        ok: true,
        state: dutyState,
        config,
        reports,
        seenTail: tailFile(path.join(DUTY_DIR, 'seen.md'), 40),
        autoDigestDynamic: suite.bili?.autoDigestDynamic ?? { enabled: false }
      });
      return;
    }
    if (req.method === 'POST' && p === '/api/duty/config') {
      const body = await readJsonBody(req);
      const file = path.join(DUTY_DIR, 'config.json');
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      const allowed = ['perDay', 'peakValley', 'noon', 'night', 'autoComment', 'transcribe', 'asrModel', 'keywords', 'commentPerRound', 'mentionName', 'reportLevel', 'replyToComments', 'replyPerRound', 'dmMode', 'dmUid', 'dmOwnerUid', 'dmReplyPerDay', 'memoryMcp'];
      for (const k of allowed) if (k in body) cur[k] = body[k];
      fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8');
      send({ ok: true, config: cur, note: '下一轮值班生效（值班轮由 DSH 调度）' });
      return;
    }
    if (req.method === 'GET' && p === '/api/duty/report') {
      const date = (url.searchParams.get('date') || '').trim();
      const md = push.readReport(date);
      if (!md) { send({ ok: false, error: '日报不存在' }, 404); return; }
      send({ ok: true, date, md });
      return;
    }

    // ---- B站发布工坊 ----
    // ---- B站动态草稿（先审后发）--------------------------------------
    // 她提交 → 推主人 QQ 审核 → 主人回「发/不发/重写」→ 桥接调 approve/reject
    if (req.method === 'GET' && p === '/api/bili/draft') {
      send({ ok: true, draft: biliDraft.pending(), history: biliDraft.history() });
      return;
    }
    if (req.method === 'POST' && p === '/api/bili/draft') {
      const body = await readJsonBody(req);
      const draft = await biliDraft.submit({
        text: body.text,
        images: body.images,
        image: body.image,
        source: body.source || 'agent'
      });
      send({ ok: true, draft });
      return;
    }
    if (req.method === 'POST' && p === '/api/bili/draft/approve') {
      const draft = await biliDraft.approve();
      send({ ok: true, draft });
      return;
    }
    if (req.method === 'POST' && p === '/api/bili/draft/reject') {
      let body = {};
      try { body = await readJsonBody(req); } catch { /* 允许空 body */ }
      const draft = await biliDraft.reject(body.reason);
      send({ ok: true, draft });
      return;
    }

    if (req.method === 'GET' && p === '/api/bili/cred') {
      send({ ok: true, ...(await runBiliCli(['cred-status'], 30000)) });
      return;
    }
    if (req.method === 'POST' && p === '/api/bili/dynamic') {
      const body = await readJsonBody(req);
      if (!body.text || !String(body.text).trim()) throw new Error('动态内容不能为空');
      const args = ['send-dynamic', '--text', String(body.text)];
      for (const img of Array.isArray(body.images) ? body.images : []) args.push('--image', String(img));
      if (body.topicId) args.push('--topic-id', String(body.topicId));
      const r = await runBiliCli(args);
      log(`B站动态发布：${r.ok ? '成功' : '失败 ' + (r.error || '')}`);
      send(r, r.ok ? 200 : 500);
      return;
    }
    if (req.method === 'POST' && p === '/api/bili/opus') {
      const body = await readJsonBody(req);
      if (!body.title || !String(body.title).trim()) throw new Error('图文标题不能为空');
      const args = ['send-opus', '--title', String(body.title), '--content', String(body.content || '')];
      for (const img of Array.isArray(body.images) ? body.images : []) args.push('--image', String(img));
      const r = await runBiliCli(args);
      log(`B站图文发布：${r.ok ? '成功' : '失败 ' + (r.error || '')}`);
      send(r, r.ok ? 200 : 500);
      return;
    }
    if (req.method === 'POST' && p === '/api/bili/autopost') {
      const body = await readJsonBody(req);
      suite.bili = suite.bili || {};
      suite.bili.autoDigestDynamic = {
        enabled: !!body.enabled,
        time: /^\d{1,2}:\d{2}$/.test(String(body.time || '')) ? body.time : (suite.bili.autoDigestDynamic?.time || '12:45')
      };
      saveSuite(suite);
      send({ ok: true, autoDigestDynamic: suite.bili.autoDigestDynamic });
      return;
    }

    // ---- QQ 社交 ----
    if (req.method === 'GET' && p === '/api/qq/capabilities') {
      const probe = await qqSocial.probe();
      // 能力表不再手写死：问协议端 can_send_record / can_send_image
      const caps = probe.online ? await qqSocial.capabilityProbe() : null;
      const voiceGate = qqVoiceOffReason();
      const list = qqSocial.capabilities(probe, caps).map((c) => (c.id === 'private-voice' && voiceGate ? { ...c, support: false, reason: voiceGate } : c));
      send({ ok: true, gateway: probe, capsProbe: caps, capabilities: list });
      return;
    }
    if (req.method === 'POST' && p === '/api/qq/like') {
      const body = await readJsonBody(req);
      if (!body.qq) throw new Error('需要 qq 字段');
      const r = await qqSocial.sendLike(body.qq, body.times);
      send({ ok: true, result: r });
      return;
    }
    if (req.method === 'POST' && p === '/api/qq/notice') {
      const body = await readJsonBody(req);
      if (!body.groupId || !body.content) throw new Error('需要 groupId 和 content');
      const r = await qqSocial.sendGroupNotice(body.groupId, body.content);
      send({ ok: true, result: r });
      return;
    }
    if (req.method === 'POST' && p === '/api/qq/poke') {
      const body = await readJsonBody(req);
      const r = await qqSocial.poke(body);
      send({ ok: true, result: r });
      return;
    }
    if (p === '/api/qq/mood') {
      send({ ok: false, error: '当前协议端（SnowLuma 1.14.15）不支持发说说/Qzone：OneBot 协议未提供该接口。此能力会在协议端更新后自动接入。' }, 501);
      return;
    }

    // ---- 网关 / 日志 ----
    if (req.method === 'GET' && p === '/api/gateway') {
      send({ ok: true, home: suite.paths?.snowlumaHome ?? null, launcher: suite.paths?.snowlumaLauncher ?? null, ...(await gatewayStatus()) });
      return;
    }
    if (req.method === 'GET' && p === '/api/logs') {
      const lines = Number(url.searchParams.get('lines')) || 120;
      send({ ok: true, tail: tailFile(HUB_LOG, Math.min(lines, 500)) });
      return;
    }
    // ---- 语音：状态 / 合成 / 识别 / 合成并发送 ----
    if (req.method === 'GET' && p === '/api/tts/status') {
      const st = await tts.probe();
      send({
        ok: true,
        tts: st,
        // 推理服务是否在跑、空闲多久、还有多久自动关停（显存要和 ComfyUI 错峰）
        sovits: await tts.sovits.status(),
        asr: { cli: fs.existsSync(ASR_CLI), python: fs.existsSync(VOICE_PY) },
        personaVoice: personaRef.current?.voice ?? null,
        suiteVoice: suite.tts ?? null
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/tts/speak') {
      const body = await readJsonBody(req);
      const r = await tts.synthesize(body.text, { engine: body.engine, voice: body.voice });
      send(r, r.ok ? 200 : 400);
      return;
    }

    if (req.method === 'POST' && p === '/api/asr/transcribe') {
      const body = await readJsonBody(req);
      const voiceDir = path.join(ROOT, 'state', 'voice');
      const resolved = path.resolve(String(body.path || ''));
      // 只允许转写自己落盘的语音，避免变成任意文件读取
      if (!resolved.startsWith(voiceDir + path.sep)) {
        send({ ok: false, error: '只允许转写 state/voice 目录下的音频' }, 403);
        return;
      }
      const r = await transcribeFile(resolved);
      send(r, r.ok ? 200 : 422);
      return;
    }

    if (req.method === 'POST' && p === '/api/qq/voice') {
      // 总开关放在最前面：关掉之后连参数都不必校验，直接给明白话
      const voiceOff = qqVoiceOffReason();
      if (voiceOff) {
        send({ ok: false, disabled: true, error: voiceOff }, 403);
        return;
      }
      const body = await readJsonBody(req);
      const userId = Number(body.userId ?? body.sendTo ?? 0);
      if (!userId) throw new Error('需要 userId（收语音的 QQ 号）');

      // 收件人白名单：与生图同一条规则，不允许给任意号码发语音
      const wl = await bridgeWhitelist();
      const allowedIds = new Set(
        [...(wl.allow?.private || []), wl.ownerQQ, suite.identity?.pushTargetQQ]
          .map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
      );
      if (!allowedIds.has(userId)) {
        send({ ok: false, error: `${userId} 不在私聊白名单，拒绝发送语音` }, 403);
        return;
      }

      const gate = qqSocial.checkVoiceGate(userId);
      if (!gate.ok) {
        send({ ok: false, error: '语音发得太频繁', retryAfterMs: gate.retryAfterMs }, 429);
        return;
      }

      const syn = await tts.synthesize(body.text, { engine: body.engine, voice: body.voice });
      if (!syn.ok) {
        send({ ok: false, error: syn.error, engine: syn.engine ?? null }, 502);
        return;
      }

      const cleanup = () => { if (!body.keep) { try { fs.rmSync(syn.path, { force: true }); } catch { /* ignore */ } } };
      try {
        const sent = await qqSocial.sendPrivateVoice(userId, syn.path);
        qqSocial.markVoiceSent(userId);
        cleanup();
        let woke = false;
        if (body.wake) {
          try {
            await wakePrivateChat(userId, body.reason || `刚给你发了条语音：${String(body.text).slice(0, 80)}`);
            woke = true;
          } catch (e) {
            log(`[tts] 语音已发出但唤醒失败：${e.message}`);
          }
        }
        send({
          ok: true,
          messageId: sent?.data?.message_id ?? null,
          via: sent.via ?? null,
          degraded: sent.degraded || syn.degraded || null,
          engine: syn.engine,
          voice: syn.voice,
          bytes: syn.bytes,
          ms: syn.ms,
          woke
        });
      } catch (e) {
        cleanup();
        send({ ok: false, error: String(e.message || e) }, 502);
      }
      return;
    }

    if (req.method === 'POST' && p === '/api/hub/token') {
      const next = crypto.randomBytes(24).toString('base64url');
      suite.hub = suite.hub || {};
      suite.hub.token = next;
      saveSuite(suite);
      HUB_TOKEN = next; // 内存同步，否则新令牌当场 401
      try {
        fs.writeFileSync(path.join(ROOT, 'state', 'hub-token'), next, 'utf8'); // 桥接/MCP 读的是这个文件
      } catch (e) {
        log(`[hub] 令牌已轮换，但写 state/hub-token 失败：${e.message}`);
      }
      send({ ok: true, token: next, note: '旧令牌已失效（新值已同步到 suite.json / state/hub-token / 进程内存）' });
      return;
    }

    // ---- QQ 白名单（映射 qq-bridge/config.json 的 allow / deny / ownerQQ）----
    // 读写都经过桥接的 /api/whitelist：那里会同时热更新内存 + 原子写 config.json，
    // 直接改文件会被运行中的桥接覆盖。
    async function bridgeWhitelist() {
      const core = readCoreConfig(CORE_DIR);
      const port = Number(core.consolePort) || 3100;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/whitelist`, {
          headers: { 'x-console-token': bridgeConsoleToken() },
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) return await res.json();
      } catch { /* 桥接未起时降级读磁盘 */ }
      return { allow: core.allow ?? {}, deny: core.deny ?? {}, ownerQQ: core.ownerQQ ?? null };
    }
    async function bridgeGroups() {
      const core = readCoreConfig(CORE_DIR);
      const port = Number(core.consolePort) || 3100;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/groups`, {
          headers: { 'x-console-token': bridgeConsoleToken() },
          // 桥接内部对 OneBot 的等待上限是 8s，这里必须比它宽，否则会先超时导致群名全丢。
          signal: AbortSignal.timeout(12000)
        });
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data.groups) ? data.groups : [];
        }
      } catch { /* ignore */ }
      return [];
    }
    function personNames() {
      const map = new Map();
      try {
        for (const person of memoryStore.listPeople()) {
          for (const id of (person.identities || [])) {
            const m = /^qq-(\d+)$/.exec(String(id));
            if (m) map.set(m[1], person.displayName || person.key);
          }
        }
      } catch { /* ignore */ }
      return map;
    }

    if (req.method === 'GET' && p === '/api/qq/groups') {
      const [groups, wl] = await Promise.all([bridgeGroups(), bridgeWhitelist()]);
      const allow = new Set((wl.allow?.groups || []).map(Number));
      const deny = new Set((wl.deny?.groups || []).map(Number));
      // 白名单里有、但协议端尚未返回的群也补出来，避免配置「看不见」
      for (const id of allow) if (!groups.some((g) => Number(g.id) === Number(id))) groups.push({ id: Number(id), name: `群 ${id}`, inAllow: true, inDeny: false, hasSession: false });
      for (const g of groups) {
        g.inAllow = allow.has(Number(g.id));
        g.inDeny = deny.has(Number(g.id));
      }
      groups.sort((a, b) => Number(b.inAllow) - Number(a.inAllow) || (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0) || Number(a.id) - Number(b.id));
      send({ ok: true, groups, allowGroups: [...allow], denyGroups: [...deny] });
      return;
    }

    if (req.method === 'GET' && p === '/api/qq/allowlist') {
      const [wl, groups] = await Promise.all([bridgeWhitelist(), bridgeGroups()]);
      const core = readCoreConfig(CORE_DIR);
      const attention = core.socialV2?.attention || {};
      const levelOf = (id) => {
        const rec = attention[String(id)];
        if (rec == null) return 3;
        const n = typeof rec === 'number' ? rec : Number(rec.level);
        return Number.isFinite(n) ? n : 3;
      };
      const names = personNames();
      const gname = new Map(groups.map((g) => [String(g.id), g.name]));
      const allowPrivate = (wl.allow?.private || []).map(Number).filter(Number.isFinite);
      const allowGroups = (wl.allow?.groups || []).map(Number).filter(Number.isFinite);
      const denyPrivate = (wl.deny?.private || []).map(Number).filter(Number.isFinite);
      const denyGroups = (wl.deny?.groups || []).map(Number).filter(Number.isFinite);
      // 候选 QQ（供「从列表选」）：群成员 + 人向记忆里认得过的人，排除已在白名单/拉黑的。
      // 群成员来自最近消息，只覆盖最近说过话的人；记忆里那份能补上更早认识的人。
      const cand = new Map();
      try {
        const att = await bridgeAttentionCached();
        for (const m of att.members) {
          if (!m?.id) continue;
          cand.set(String(m.id), {
            id: String(m.id),
            name: String(m.name || ''),
            group: String(m.group || '').replace(/^group:/, ''),
            source: '群成员'
          });
        }
      } catch { /* 桥接忙时只用记忆里的人 */ }
      try {
        for (const person of memoryStore.listPeople()) {
          for (const id of (person.identities || [])) {
            const mm = /^qq-(\d+)$/.exec(String(id));
            if (!mm) continue;
            const cur = cand.get(mm[1]) || { id: mm[1], name: '', group: '', source: '记忆' };
            if (!cur.name) cur.name = person.displayName || '';
            cand.set(mm[1], cur);
          }
        }
      } catch { /* ignore */ }
      const usedIds = new Set([...allowPrivate, ...denyPrivate].map(String));
      const candidates = [...cand.values()]
        .filter((c) => !usedIds.has(String(c.id)))
        .sort((a, b) => (a.source === b.source ? 0 : a.source === '群成员' ? -1 : 1) || String(a.id).localeCompare(String(b.id)));

      send({
        ok: true,
        ownerQQ: Number(wl.ownerQQ) || null,
        entries: {
          private: allowPrivate.map((id) => ({
            id,
            name: names.get(String(id)) || '',
            level: levelOf(id),
            isOwner: Number(wl.ownerQQ) === id
          })),
          groups: allowGroups.map((id) => ({
            id,
            name: gname.get(String(id)) || '',
            hasSession: groups.some((g) => Number(g.id) === id && g.hasSession)
          }))
        },
        deny: { private: denyPrivate, groups: denyGroups },
        candidates
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/qq/allowlist') {
      const body = await readJsonBody(req);
      const kind = body.kind === 'group' ? 'group' : 'private';
      const action = String(body.action || '').trim();
      const rawId = String(body.id ?? '').trim();
      if (!/^\d{5,12}$/.test(rawId)) { send({ ok: false, error: '号码格式不对（5~12 位数字）' }, 400); return; }
      const id = Number(rawId);
      if (!['add', 'remove', 'deny', 'undeny'].includes(action)) {
        send({ ok: false, error: 'action 需为 add / remove / deny / undeny' }, 400);
        return;
      }
      const wl = await bridgeWhitelist();
      const allow = {
        private: (wl.allow?.private || []).map(Number).filter(Number.isFinite),
        groups: (wl.allow?.groups || []).map(Number).filter(Number.isFinite)
      };
      const deny = {
        private: (wl.deny?.private || []).map(Number).filter(Number.isFinite),
        groups: (wl.deny?.groups || []).map(Number).filter(Number.isFinite)
      };
      const list = kind === 'group' ? 'groups' : 'private';
      // 防手滑：把群号加进私聊白名单（号码都是 5~12 位数字，肉眼分不出来）。
      // 页面上两份白名单已经分开，这里再兜一层，接口直调也不会写错。
      if (kind === 'private' && action === 'add') {
        const groups = await bridgeGroups();
        const hit = groups.find((g) => Number(g.id) === id);
        if (hit) {
          send({ ok: false, error: `${id} 是一个群号（${hit.name || '未知群'}），请加到群聊白名单` }, 400);
          return;
        }
      }
      if (action === 'add') {
        if (!allow[list].includes(id)) allow[list].push(id);
        deny[list] = deny[list].filter((x) => x !== id); // 加白即解除拉黑
      } else if (action === 'remove') {
        allow[list] = allow[list].filter((x) => x !== id);
      } else if (action === 'deny') {
        allow[list] = allow[list].filter((x) => x !== id);
        if (!deny[list].includes(id)) deny[list].push(id);
      } else if (action === 'undeny') {
        deny[list] = deny[list].filter((x) => x !== id);
      }
      // 主人 QQ 不允许从白名单里摘掉（否则管理通道会自断）
      if (action === 'remove' && kind === 'private' && id === Number(wl.ownerQQ)) {
        send({ ok: false, error: '不能移除主人 QQ（ownerQQ），请先转移主人身份' }, 400);
        return;
      }
      const core = readCoreConfig(CORE_DIR);
      const port = Number(core.consolePort) || 3100;
      // 桥接偶发忙（正在跑 AI 回合）时首次写回可能超时，重试一次足够；
      // 写的是全量白名单，重试是幂等的。
      const writeWhitelist = async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/whitelist`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': bridgeConsoleToken() },
          body: JSON.stringify({ allow, deny, ownerQQ: wl.ownerQQ ?? null }),
          signal: AbortSignal.timeout(8000)
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* ignore */ }
        return { res, data };
      };
      let { res, data } = await writeWhitelist();
      if (!res.ok || !data?.ok) {
        ({ res, data } = await writeWhitelist());
      }
      if (!res.ok || !data?.ok) {
        send({ ok: false, error: data?.error || `桥接写入失败 HTTP ${res.status}` }, 502);
        return;
      }
      send({ ok: true, kind, id, action, allow: data.allow, deny: data.deny });
      return;
    }

    // ---- 群友关注度（与桥接 config.socialV2.attention 同源）----
    if (req.method === 'GET' && p === '/api/attention') {
      const core = readCoreConfig(CORE_DIR);
      const allowPrivate = (core.allow?.private || []).map(Number).filter(Number.isFinite);
      const allowGroups = (core.allow?.groups || []).map(Number).filter(Number.isFinite);
      let attention = {};
      let members = [];
      let bridgeError = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 走带缓存的取数：同一次页面加载里 /api/qq/allowlist 也要拿群成员，
          // 两边共用一次桥接请求，避免并发冷连接互相拖到超时。
          const r = await bridgeAttentionCached({ maxAgeMs: attempt === 0 ? 5000 : 0 });
          attention = r.attention;
          members = r.members;
          bridgeError = '';
          break;
        } catch (e) {
          // 原来是静默 catch，桥接忙/鉴权失败时界面只显示「全部正常」，看不出数据没取到。
          bridgeError = e?.name === 'TimeoutError' ? '桥接响应超时' : (e?.message || String(e));
          log(`[attention] 拉取桥接关注度失败（第 ${attempt + 1} 次）：${bridgeError}`);
        }
      }
      const nameById = new Map();
      try {
        for (const person of memoryStore.listPeople()) {
          for (const id of (person.identities || [])) {
            const m = /^qq-(\d+)$/.exec(String(id));
            if (m) nameById.set(m[1], person.displayName || person.key);
          }
        }
      } catch { /* ignore */ }
      for (const m of members) {
        if (m.name && !nameById.has(String(m.id))) nameById.set(String(m.id), m.name);
      }
      const ids = new Set([
        ...allowPrivate,
        ...members.map((m) => Number(m.id)).filter(Number.isFinite),
        ...Object.keys(attention).map(Number).filter(Number.isFinite)
      ]);
      // 群归属：前端「群聊选择」用它过滤（group:10000 → 10000）
      const groupById = new Map();
      for (const m of members) {
        if (m.group) groupById.set(String(m.id), String(m.group).replace(/^group:/, ''));
      }
      const items = [...ids].map((id) => {
        const rec = attention[String(id)];
        const lv = rec == null ? 3 : (typeof rec === 'number' ? rec : Number(rec.level));
        return {
          id,
          name: nameById.get(String(id)) || '',
          level: Number.isFinite(lv) ? lv : 3,
          note: (rec && rec.note) || '',
          inAllowList: allowPrivate.includes(id),
          isOwner: Number(core.ownerQQ) === id,
          group: groupById.get(String(id)) || ''
        };
      }).sort((a, b) => a.level - b.level || a.id - b.id);
      send({ ok: true, items, allow: { private: allowPrivate, groups: allowGroups }, ownerQQ: Number(core.ownerQQ) || null, bridgeError: bridgeError || null });
      return;
    }
    if (req.method === 'POST' && p === '/api/attention') {
      const body = await readJsonBody(req);
      const core = readCoreConfig(CORE_DIR);
      const port = Number(core.consolePort) || 3100;
      const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/attention`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': bridgeConsoleToken() },
        body: JSON.stringify(body.id !== undefined
          ? { id: body.id, level: body.level, note: body.note }
          : { attention: body.attention || {} })
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* ignore */ }
      if (!res.ok || data?.ok === false) throw new Error(data?.error || `桥接返回 HTTP ${res.status}`);
      send({ ok: true, attention: data.attention });
      return;
    }

    // ---- 人向记忆 ----
    if (req.method === 'GET' && p === '/api/memory') {
      send({
        ok: true,
        people: memoryStore.listPeople(),
        storage: memoryStore.dir,
        backup: memoryStore.backupPath
      });
      return;
    }
    if (req.method === 'POST' && p === '/api/memory') {
      const body = await readJsonBody(req);
      const action = body.action || 'add';
      let result;
      if (action === 'add') {
        result = memoryStore.addImpression(body.key, body.text, { displayName: body.displayName, platform: body.platform || 'platform', source: 'platform' });
      } else if (action === 'remove') {
        result = memoryStore.removeImpression(body.key, body.index);
      } else if (action === 'forget') {
        result = memoryStore.forgetPerson(body.key);
      } else if (action === 'rename') {
        result = memoryStore.setDisplayName(body.key, body.displayName);
      } else if (action === 'link') {
        if (!body.keyA || !body.keyB) throw new Error('link 需要 keyA 与 keyB');
        result = memoryStore.link(body.keyA, body.keyB, { displayName: body.displayName || '' });
      } else {
        throw new Error(`未知操作：${action}`);
      }
      log(`记忆操作 ${action}：${body.key}`);
      send({ ok: true, result });
      return;
    }

    // ---- 模型与密钥（统一 API-key）----
    if (req.method === 'GET' && p === '/api/llm-config') {
      const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
      let masked = null;
      let model = null;
      let provider = null;
      try {
        const text = fs.readFileSync(credFile, 'utf8');
        const m = /^(\s*DEEPSEEK_API_KEY:\s*)(\S+)/m.exec(text);
        if (m) {
          const key = m[2];
          masked = `${key.slice(0, 5)}…${key.slice(-4)}（${key.length} 位）`;
        }
      } catch { /* ignore */ }
      try {
        const cfg = readCoreConfig(CORE_DIR);
        model = cfg.dsh?.model ?? null;
        provider = cfg.dsh?.provider ?? null;
      } catch { /* ignore */ }
      send({ ok: true, apiKeyMasked: masked, model, provider, credFile });
      return;
    }
    if (req.method === 'POST' && p === '/api/llm-config') {
      const body = await readJsonBody(req);
      const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
      const notes = [];
      if (body.apiKey) {
        const key = String(body.apiKey).trim();
        if (!/^sk-/.test(key)) throw new Error('API key 应以 sk- 开头（DeepSeek 平台密钥）');
        const text = fs.readFileSync(credFile, 'utf8');
        // 写前备份（项目外）
        const backupDir = path.join(os.homedir(), '.qingniao-backup', 'credentials');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupFile = path.join(backupDir, `.credentials.yaml.${Date.now()}.bak`);
        fs.writeFileSync(backupFile, text, 'utf8');
        const re = /^(\s*DEEPSEEK_API_KEY:\s*)\S+$/m;
        if (!re.test(text)) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY 记录，拒绝盲写');
        // 用函数替换：替换串里的 $ 不再被当作捕获组引用（key 含 $&/$1 等会损坏文件）
        fs.writeFileSync(credFile, text.replace(re, (_m, p1) => p1 + key), 'utf8');
        notes.push(`已更新 DEEPSEEK_API_KEY（原文件备份在 ${backupFile}）`);
      }
      if (body.model) {
        const cfgFile = path.join(CORE_DIR, 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        cfg.dsh = cfg.dsh || {};
        cfg.dsh.model = String(body.model).trim();
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
        notes.push(`桥接默认模型已设为 ${cfg.dsh.model}（桥接重启后生效）`);
      }
      log(`模型/密钥配置已更新`);
      send({ ok: true, notes, hint: 'API key 需重启 DeepSeek Harness 桌面客户端后才被新的会话使用；B站值班轮下一轮自动生效。' });
      return;
    }

    // ---- ComfyUI 生图 ----
    if (req.method === 'GET' && p === '/api/comfy/status') {
      const up = await comfy.isUp();
      send({ ok: true, up, baseUrl: comfy.baseUrl, modelsDir: comfy.modelsDir, models: up ? comfy.listModels() : comfy.listModels(), defaults: comfy.DEFAULTS, sampler: comfy.samplerInfo(), downloads: comfy.listDownloads() });
      return;
    }
    // 当日生图归档清单：给「写 B站动态挑配图」用
    if (req.method === 'GET' && p === '/api/comfy/gallery') {
      const u = new URL(req.url, 'http://127.0.0.1');
      const date = String(u.searchParams.get('date') || '').trim() || todayYmd();
      const images = listTodayImages(date).map((x) => {
        let bytes = 0;
        try { bytes = fs.statSync(x.path).size; } catch { /* ignore */ }
        return { index: x.index, file: x.file, path: x.path, time: x.time, at: x.at, prompt: x.prompt, sendTo: x.sendTo, bytes };
      });
      send({ ok: true, date, count: images.length, images });
      return;
    }

    // ---- 本地资源（管理端「本地资源」页 + 她自己每周清理）----
    if (req.method === 'GET' && p === '/api/gallery/days') {
      const days = listArchiveDays();
      send({ ok: true, days, root: ARCHIVE_ROOT });
      return;
    }
    if (req.method === 'GET' && p === '/api/gallery/list') {
      const u = new URL(req.url, 'http://127.0.0.1');
      const date = String(u.searchParams.get('date') || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 需为 YYYY-MM-DD');
      const images = listDayImages(date).map((x) => ({ ...x, path: undefined })); // 不回传服务器绝对路径
      send({ ok: true, date, count: images.length, images });
      return;
    }
    // 图片本体：给 <img> 用，浏览器带不了自定义头，所以允许 ?token= 传令牌
    if (req.method === 'GET' && p === '/api/gallery/raw') {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (String(u.searchParams.get('token') || '') !== HUB_TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '未授权' }));
        return;
      }
      const date = String(u.searchParams.get('date') || '').trim();
      const file = path.basename(String(u.searchParams.get('file') || '').trim());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !file) throw new Error('参数不完整');
      const abs = path.join(ARCHIVE_ROOT, date, file);
      if (!fs.existsSync(abs)) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=300' });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    if (req.method === 'POST' && p === '/api/gallery/delete') {
      const body = await readJsonBody(req);
      const date = String(body.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 需为 YYYY-MM-DD');
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) throw new Error('files 不能为空');
      const removed = deleteArchiveImages(date, files, body.by === 'agent' ? 'agent' : 'admin');
      log(`[gallery] ${date} 删除 ${removed.length} 张（${body.by === 'agent' ? '她自己' : '管理端'}）：${removed.join(', ')}`);
      send({ ok: true, date, removed });
      return;
    }

    // ---- 开机自启 / doctor 保活 开关 ----
    if (req.method === 'GET' && p === '/api/toggles') {
      send({ ok: true, desired: readToggles(), actual: autostartActual(), platform: process.platform });
      return;
    }
    if (req.method === 'POST' && p === '/api/toggles') {
      const body = await readJsonBody(req);
      if (process.platform !== 'win32') throw new Error('该开关只在 Windows 上可用');
      const cur = readToggles();
      const next = { ...cur };
      const changes = {};
      if (typeof body.autostart === 'boolean' && body.autostart !== cur.autostart) changes.autostart = body.autostart;
      if (typeof body.doctor === 'boolean' && body.doctor !== cur.doctor) changes.doctor = body.doctor;

      const actions = [];
      let actual;
      if (Object.keys(changes).length) {
        // 一次 PowerShell 调用完成「变更 + 回报状态」，避免连续 spawn 造成 6 秒假死
        actual = { supported: true, ...applyToggleChanges(changes) };
        if (changes.autostart !== undefined) {
          const ok = actual.probeFailed !== true && actual.runKey === changes.autostart;
          actions.push({ what: 'autostart', on: changes.autostart, ok, detail: ok ? '' : '注册表写入后状态未改变' });
          if (ok) next.autostart = changes.autostart;
          log(`[toggles] 登录自启 → ${changes.autostart ? '开' : '关'}${ok ? '' : '（失败）'}`);
        }
        if (changes.doctor !== undefined) {
          const ok = actual.probeFailed !== true && actual.task.enabled === changes.doctor;
          actions.push({ what: 'doctor', on: changes.doctor, ok, detail: ok ? '' : '计划任务状态未改变' });
          if (ok) next.doctor = changes.doctor;
          log(`[toggles] 5 分钟保活 → ${changes.doctor ? '开' : '关'}${ok ? '' : '（失败）'}`);
        }
      } else {
        // 没有实际变化（前端重复点）也回一次当前状态
        actual = autostartActual();
      }
      next.updatedAt = Date.now();
      writeToggles(next);
      send({ ok: true, desired: next, actual, actions });
      return;
    }
    if (req.method === 'POST' && p === '/api/comfy/generate') {
      const body = await readJsonBody(req);
      // 收图人白名单：与 QQ 私聊白名单（qq-bridge/config.json → allow.private）保持同步，      // 白名单在管理后台维护一处即可，避免「能聊天但发不了图」或反过来的割裂。
      if (body.sendTo !== undefined && body.sendTo !== null && String(body.sendTo) !== '') {
        const core = readCoreConfig(CORE_DIR);
        const allowedImageTargets = new Set(
          [...(core.allow?.private || []), core.ownerQQ].map(Number).filter(Number.isFinite)
        );
        if (!allowedImageTargets.has(Number(body.sendTo))) {
          throw new Error(
            `sendTo ${body.sendTo} 不在 QQ 私聊白名单（qq-bridge/config.json → allow.private）内；` +
            `请先在管理后台「群友」页把它加入白名单`
          );
        }
      }
      // 自画像：把统一人格里的外貌设定拼进提示词
      let promptText = String(body.prompt || '');
      const rawPrompt = promptText.trim(); // 她自己写的那句，单独留一份存进 index.json
      if (body.selfImage) {
        try {
          const persona = loadPersona(ROOT);
          const ap = (persona.personas || []).find((x) => x.id === persona.active);
          // 去掉每段结尾的句号再拼，否则会出现「动画插画风。。画风：」这种双句号
          const parts = [ap?.appearance, ap?.appearanceTags]
            .filter(Boolean)
            .map((s) => String(s).replace(/[。．.]+$/, ''));
          const look = parts.length > 1 ? `${parts[0]}。画风：${parts.slice(1).join('，')}` : (parts[0] || '');
          promptText = look + '。画面内容：' + promptText;
        } catch { /* 无人格也能生图 */ }
      }
      if (!promptText.trim()) throw new Error('prompt 不能为空');
      const genOpts = {
        positive: promptText,
        negative: body.negative,
        width: Number(body.width) || 1024,
        height: Number(body.height) || 1024,
        // steps/cfg 不传时由 comfy.js 自动决定：
        //   有 Lightning LoRA → 4 步 / CFG 1.0；缺失 → 22 步 / CFG 2.2
        ...(Number(body.steps) > 0 ? { steps: Number(body.steps) } : {}),
        ...(body.cfg !== undefined && Number.isFinite(Number(body.cfg)) ? { cfg: Number(body.cfg) } : {})
      };
      const sendTo = body.sendTo ? Number(body.sendTo) : null;

      // 归档元数据：把「她写的」「实际送模型的」「生成参数」一起留下，方便回头复盘
      const sampInfo = comfy.samplerInfo();
      const archiveMeta = (extra = {}) => ({
        prompt: rawPrompt,
        promptFull: promptText,
        negative: genOpts.negative || '',
        width: genOpts.width,
        height: genOpts.height,
        steps: genOpts.steps ?? sampInfo.steps,
        cfg: genOpts.cfg ?? sampInfo.cfg,
        selfImage: body.selfImage === true,
        sendTo,
        ...extra
      });
      const withResult = (r, extra = {}) => archiveMeta({
        width: r.width ?? genOpts.width,
        height: r.height ?? genOpts.height,
        seed: r.seed ?? null,
        promptId: r.promptId ?? null,
        ...extra
      });

      // 异步模式：立刻返回 jobId（MCP 工具不会再超时）；出图后发送 + 唤醒会话
      if (body.async === true) {
        const jobId = crypto.randomBytes(4).toString('hex');
        const job = {
          id: jobId, status: 'running', startedAt: Date.now(),
          prompt: rawPrompt.slice(0, 120), sendTo
        };
        COMFY_JOBS.set(jobId, job);
        pruneComfyJobs();
        (async () => {
          try {
            const r = await comfy.generate(genOpts);
            Object.assign(job, { status: 'done', bytes: r.bytes, promptId: r.promptId, finishedAt: Date.now() });
            // 归档：图移进 pictures/daily/<日期>/，comfy-out 里不再留（发完就删的时代结束了）
            let archivePath = null;
            try {
              archivePath = archiveImage(r.file, withResult(r, { jobId }));
              job.keepFile = archivePath;
              job.archivePath = archivePath;
              log(`[comfy] 任务 ${jobId} 已归档：${archivePath}`);
            } catch (e) {
              archivePath = r.file;
              job.keepFile = r.file;
              log(`[comfy] 任务 ${jobId} 归档失败（保留原路径）：${e.message}`);
            }
            if (sendTo) {
              try {
                await qqSocial.sendPrivateImage(sendTo, archivePath);
                job.sent = true;
                log(`[comfy] 任务 ${jobId} 图片已发送给 ${sendTo}（${r.bytes} 字节）`);
                // 关键：告诉她「你刚发了一张图」，否则她下次会否认/困惑
                await wakePrivateChat(
                  sendTo,
                  `生图完成：你刚才生成的图已经发到 QQ 了（画面：${promptText.slice(0, 60)}）。这张图是你自己发的，不是对方发的；需要回看可以调用 gen_image_status。`
                ).catch((e) => log(`[comfy] 任务 ${jobId} 唤醒失败（不影响已发送）：${e.message}`));
                job.woke = true;
              } catch (e) {
                job.sendError = String(e.message || e);
                log(`[comfy] 任务 ${jobId} 发送失败（图已归档，可重发）：${e.message}`);
              }
            }
          } catch (e) {
            Object.assign(job, { status: 'error', error: String(e.message || e), finishedAt: Date.now() });
            log(`[comfy] 任务 ${jobId} 失败：${e.message}`);
            // 关键：异步失败必须告诉她。否则她已经跟对方说过「画好了就发你」，
            // 结果图没生成、她也毫不知情，对方会一直干等（2026-11-01 实际发生过）。
            if (sendTo) {
              const reason = String(e.message || e).slice(0, 180);
              wakePrivateChat(
                sendTo,
                `生图失败了，这张图没有画出来（原因：${reason}）。` +
                `如果你之前已经跟对方说过「画好了就发你」之类的话，现在要主动老实告诉对方没画成、为什么、稍后再试，` +
                `绝对不要装作已经画好，也不要编造画面内容。可以等一会儿再重新提交一次。`
              ).catch((err) => log(`[comfy] 任务 ${jobId} 失败唤醒失败：${err.message}`));
            }
          }
        })();
        send({ ok: true, jobId, status: 'running', note: '已提交，出图后自动发送并唤醒会话' });
        return;
      }

      const r = await comfy.generate(genOpts);
      // 同步模式同样归档（不再发完就删）
      let archived = r.file;
      try { archived = archiveImage(r.file, withResult(r)); } catch { /* 归档失败就用原路径 */ }
      let sent = false;
      if (body.sendTo) {
        try {
          await qqSocial.sendPrivateImage(body.sendTo, archived);
          sent = true;
          log(`[comfy] 图片已发送给 ${body.sendTo}（已归档 ${archived}）`);
        } catch (e) {
          log(`[comfy] 发送失败（图已归档，可重发）：${e.message}`);
        }
      }
      send({ ok: true, file: archived, bytes: r.bytes, sent, deleted: false });
      return;
    }

    // ---- MiniMax H3 短视频（异步，必走 job：一条要十几分钟）----
    if (req.method === 'POST' && p === '/api/video/generate') {
      const body = await readJsonBody(req);
      const promptText = String(body.prompt || '').trim();
      if (!promptText) throw new Error('prompt 不能为空');

      // 收件人白名单与图片一致（qq-bridge/config.json → allow.private）
      if (body.sendTo !== undefined && body.sendTo !== null && String(body.sendTo) !== '') {
        const core = readCoreConfig(CORE_DIR);
        const allowed = new Set([...(core.allow?.private || []), core.ownerQQ].map(Number).filter(Number.isFinite));
        if (!allowed.has(Number(body.sendTo))) {
          throw new Error(`sendTo ${body.sendTo} 不在 QQ 私聊白名单内`);
        }
      }
      const sendTo = body.sendTo ? Number(body.sendTo) : null;
      const jobId = crypto.randomBytes(4).toString('hex');
      const job = {
        id: jobId, kind: 'video', status: 'running', startedAt: Date.now(),
        prompt: promptText.slice(0, 120), sendTo,
        seconds: Number(body.seconds) || 5
      };
      COMFY_JOBS.set(jobId, job);
      pruneComfyJobs();
      (async () => {
        try {
          const r = await comfy.generateVideo({
            prompt: promptText,
            width: Number(body.width) || undefined,
            height: Number(body.height) || undefined,
            seconds: Number(body.seconds) || 5,
            seed: Number(body.seed) || undefined
          });
          Object.assign(job, {
            status: 'done', bytes: r.bytes, promptId: r.promptId,
            length: r.length, width: r.width, height: r.height, finishedAt: Date.now()
          });
          // 留档：管理端/ComfyUI 里都能回看
          try {
            const keep = path.join(ROOT, 'state', 'comfy-out', 'last-video.mp4');
            fs.mkdirSync(path.dirname(keep), { recursive: true });
            fs.copyFileSync(r.file, keep);
            job.keepFile = keep;
          } catch { /* 留档失败不影响发送 */ }
          if (sendTo) {
            try {
              await qqSocial.sendPrivateVideo(sendTo, r.file);
              job.sent = true;
              fs.rmSync(r.file, { force: true });
              log(`[comfy] 视频任务 ${jobId} 已发送给 ${sendTo}（${(r.bytes / 1048576).toFixed(1)}MB）`);
              await wakePrivateChat(
                sendTo,
                `视频生成完成：你刚才做的那条 ${(r.length / 24).toFixed(1)} 秒视频已经发到 QQ 了（画面：${promptText.slice(0, 50)}）。这张是你自己发的，不是对方发的。`
              ).catch((e) => log(`[comfy] 视频任务 ${jobId} 唤醒失败：${e.message}`));
              job.woke = true;
            } catch (e) {
              job.sendError = String(e.message || e);
              log(`[comfy] 视频任务 ${jobId} 发送失败（文件保留）：${e.message}`);
            }
          }
        } catch (e) {
          Object.assign(job, { status: 'error', error: String(e.message || e), finishedAt: Date.now() });
          log(`[comfy] 视频任务 ${jobId} 失败：${e.message}`);
          // 同生图：异步失败必须让她知道，否则她会以为片子已经发出去了
          if (sendTo) {
            const reason = String(e.message || e).slice(0, 180);
            wakePrivateChat(
              sendTo,
              `视频生成失败了，这条片子没做出来（原因：${reason}）。` +
              `如果你之前已经跟对方说过做好了，现在要主动老实说明没成、为什么、稍后再试，` +
              `不要装作已经做好，也不要编造视频内容。`
            ).catch((err) => log(`[comfy] 视频任务 ${jobId} 失败唤醒失败：${err.message}`));
          }
        }
      })();
      send({ ok: true, jobId, status: 'running', note: '已提交，出片后自动发送并唤醒会话（本机实测：5 秒片约 90 秒）' });
      return;
    }

    if (req.method === 'GET' && p === '/api/comfy/job') {
      const id = String(url.searchParams.get('id') || '').trim();
      let job = id ? COMFY_JOBS.get(id) : null;
      if (!job) {
        // 不传 id 时返回最近一个任务
        const arr = [...COMFY_JOBS.values()];
        job = arr.length ? arr[arr.length - 1] : null;
      }
      if (!job) { send({ ok: false, error: '没有生图任务' }, 404); return; }
      send({ ok: true, job: { ...job } });
      return;
    }
    if (req.method === 'POST' && p === '/api/comfy/download') {      const body = await readJsonBody(req);
      if (!body.url) throw new Error('url 不能为空');
      let r;
      try {
        // downloadModel 是 async：非法 kind/url/越界路径以 rejected promise 抛出，
        // 不 await 不 catch 的话 Node 15+ 会因 unhandledRejection 直接崩溃整个管理平台
        r = await comfy.downloadModel(String(body.url), String(body.kind || ''));
      } catch (e) {
        send({ ok: false, error: String(e.message || e) }, 400);
        return;
      }
      send({ ok: true, ...r });
      return;
    }
    if (req.method === 'POST' && p === '/api/comfy/cleanup') {
      // 清理未发送的残留生成图
      let n = 0;
      try {
        for (const f of fs.readdirSync(path.join(ROOT, 'state', 'comfy-out'))) {
          fs.rmSync(path.join(ROOT, 'state', 'comfy-out', f), { force: true });
          n++;
        }
      } catch { /* ignore */ }
      send({ ok: true, removed: n });
      return;
    }

    send({ ok: false, error: `未知接口：${req.method} ${p}` }, 404);
  } catch (e) {
    send({ ok: false, error: String(e.message || e) }, 400);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log(`请求处理异常：${e.stack || e.message}`);
    try { sendJson(res, { ok: false, error: '服务器内部错误' }, 500); } catch { /* ignore */ }
  });
});

const HOST = suite.hub?.host || '127.0.0.1';
server.listen(PORT, HOST, () => {
  try {
    fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'state', 'hub.pid'), String(process.pid), 'utf8');
  } catch { /* ignore */ }
  const shownHost = HOST === '0.0.0.0' ? '<本机IP>' : HOST;
  log(`管理平台已启动：http://${shownHost}:${PORT}（令牌见 config/suite.json 或 state/hub-token）${HOST === '0.0.0.0' ? '；已开放局域网（手机可用 http://<电脑IP>:' + PORT + ' 访问）' : ''}`);
  syncDutyAgentsMd();
  push.start();
  registerScheduledTasks().start();
  startDshLink();
});

function cleanupPid() {
  try { fs.rmSync(path.join(ROOT, 'state', 'hub.pid'), { force: true }); } catch { /* ignore */ }
}
process.on('SIGINT', () => { push.stop(); cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { push.stop(); cleanupPid(); process.exit(0); });
process.on('exit', cleanupPid);
