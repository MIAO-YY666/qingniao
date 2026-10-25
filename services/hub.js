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
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { valleyStatus } from './scheduler.js';
import { loadPersona, savePersona, compileQQRoleCard, compileDutyAgentsMd, parsePersonaYaml, dumpPersonaYaml } from './persona.js';
import { createQqSocial, readCoreConfig } from './qq-social.js';
import { createPushService } from './push-service.js';
import { createMemoryStore } from './memory.js';
import { createComfy } from './comfy.js';

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
  const tmp = SUITE_FILE + '.tmp';
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
const HUB_TOKEN = ensureToken();
// 兼容：state/hub-token 文件（与旧控制台习惯一致）
try {
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'state', 'hub-token'), HUB_TOKEN, 'utf8');
} catch { /* ignore */ }

const PORT = Number(suite.hub?.port) || 3160;
const CORE_DIR = path.join(ROOT, suite.paths?.core || 'qq-bridge');
const DUTY_DIR = path.join(ROOT, suite.paths?.duty || 'bili-duty');

const qqSocial = createQqSocial(CORE_DIR);
const push = createPushService({ root: ROOT, suite, personaRef, qqSocial, log });
const memoryStore = createMemoryStore({
  root: ROOT,
  backupPath: path.join(os.homedir(), '.qingniao-backup', 'memory'),
  log
});
const comfy = createComfy({ suite: { ...suite, _root: ROOT }, log });

// DSH 固定入口：桥接继续连 3080，由 dsh-link 转发到桌面客户端的内嵌 web（动态端口）
async function startDshLink() {
  try {
    const { mintDshAuthCookie } = await import(pathToFileURL(path.join(CORE_DIR, 'src', 'dsh-client.js')).href);
    const { createDshLink } = await import('./dsh-link.js');
    const link = createDshLink({ suite, log, mintCookie: mintDshAuthCookie });
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

function bridgeConsoleToken() {
  const cfg = readCoreConfig(CORE_DIR);
  if (cfg.consoleToken) return cfg.consoleToken;
  try {
    return fs.readFileSync(path.join(CORE_DIR, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
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

let autoPostTimer = null;
function startAutoPostTimer() {
  if (autoPostTimer) clearInterval(autoPostTimer);
  autoPostTimer = setInterval(async () => {
    const cfg = suite.bili?.autoDigestDynamic;
    if (!cfg?.enabled) return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hm < cfg.time) return;
    const today = now.toISOString().slice(0, 10);
    const st = loadAutoPostState();
    if (st.lastAutoPostDate >= today) return;
    const text = await composeDigestDynamic();
    if (!text) return;
    const r = await runBiliCli(['send-dynamic', '--text', text]);
    if (r.ok) {
      st.lastAutoPostDate = today;
      saveAutoPostState(st);
      log(`定时B站动态已发布（${today}）`);
    } else {
      log(`定时B站动态发布失败：${r.error || '未知错误'}`);
    }
  }, 60 * 1000);
  if (autoPostTimer.unref) autoPostTimer.unref();
}

// ---------- HTTP ----------
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

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
  return supplied === HUB_TOKEN;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const send = (obj, code) => sendJson(res, obj, code);

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
      const allowed = ['perDay', 'peakValley', 'noon', 'night', 'autoComment', 'transcribe', 'keywords', 'commentPerRound', 'mentionName', 'reportLevel', 'replyToComments', 'replyPerRound'];
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
      send({ ok: true, gateway: probe, capabilities: qqSocial.capabilities(probe) });
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
    if (req.method === 'POST' && p === '/api/hub/token') {
      suite.hub.token = crypto.randomBytes(24).toString('base64url');
      saveSuite(suite);
      send({ ok: true, token: suite.hub.token, note: '旧令牌已失效' });
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
        fs.writeFileSync(credFile, text.replace(re, `$1${key}`), 'utf8');
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
      send({ ok: true, up, baseUrl: comfy.baseUrl, modelsDir: comfy.modelsDir, models: up ? comfy.listModels() : comfy.listModels(), defaults: comfy.DEFAULTS, downloads: comfy.listDownloads() });
      return;
    }
    if (req.method === 'POST' && p === '/api/comfy/generate') {
      const body = await readJsonBody(req);
      // 自画像：把统一人格里的外貌设定拼进提示词
      let promptText = String(body.prompt || '');
      if (body.selfImage) {
        try {
          const persona = loadPersona(ROOT);
          const ap = (persona.personas || []).find((x) => x.id === persona.active);
          const look = [ap?.appearance, ap?.appearanceTags].filter(Boolean).join('。画风：');
          promptText = look + '。画面内容：' + promptText;
        } catch { /* 无人格也能生图 */ }
      }
      if (!promptText.trim()) throw new Error('prompt 不能为空');
      const r = await comfy.generate({
        positive: promptText,
        negative: body.negative,
        width: Number(body.width) || 1024,
        height: Number(body.height) || 1024,
        steps: Number(body.steps) || 22
      });
      let sent = false;
      let deleted = false;
      if (body.sendTo) {
        try {
          await qqSocial.sendPrivateImage(body.sendTo, r.file);
          sent = true;
          fs.rmSync(r.file, { force: true }); // 发送成功即删，不占存储
          deleted = true;
          log(`[comfy] 图片已发送给 ${body.sendTo} 并删除本地文件`);
        } catch (e) {
          log(`[comfy] 发送失败（文件保留）：${e.message}`);
        }
      }
      send({ ok: true, file: deleted ? null : r.file, bytes: r.bytes, sent, deleted });
      return;
    }
    if (req.method === 'POST' && p === '/api/comfy/download') {
      const body = await readJsonBody(req);
      if (!body.url) throw new Error('url 不能为空');
      const r = comfy.downloadModel(String(body.url), String(body.kind || ''));
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
  startAutoPostTimer();
  startDshLink();
});

function cleanupPid() {
  try { fs.rmSync(path.join(ROOT, 'state', 'hub.pid'), { force: true }); } catch { /* ignore */ }
}
process.on('SIGINT', () => { push.stop(); cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { push.stop(); cleanupPid(); process.exit(0); });
process.on('exit', cleanupPid);
