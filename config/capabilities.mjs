// ============================================================
// capabilities.mjs —— 能力表加载 / 派生 / 一致性断言
// ------------------------------------------------------------
// 目的：把「新增一个能力要同步改 9 处」压到 2 处（加一条数据 + 写实现）。
//
// 只做三件事：
//   1. load()   —— 读 config/capabilities.json（按 mtime 热重载，避免重演"令牌陈旧"类 bug）
//   2. derive   —— 派生 sendToolNames()（bridge 的 SEND_TOOL_RE 用它，不再手写）
//   3. assert   —— 检查代码里的开关/注册/前缀是否与表一致，不一致 exit 1
//
// 零 npm 依赖：只用 node:fs / node:path。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..');
export const CAP_FILE = path.join(DEFAULT_ROOT, 'config', 'capabilities.json');

let cache = { mtimeMs: 0, data: null };

/** 读能力表；文件变更自动重载。读不到时返回空表并标记 degraded（fail-closed）。 */
export function loadCapabilities(file = CAP_FILE) {
  try {
    const st = fs.statSync(file);
    if (cache.data && cache.mtimeMs === st.mtimeMs) return cache.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.capabilities) ? raw.capabilities : [];
    const data = {
      version: raw?.version ?? 0,
      list,
      byId: new Map(list.map((c) => [c.id, c])),
      degraded: false,
      error: null
    };
    cache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (e) {
    return { version: 0, list: [], byId: new Map(), degraded: true, error: String(e?.message || e) };
  }
}

/** 未知 id 返回 null（fail-closed：调用方必须显式处理"没有这个能力"）。 */
export function getCapability(id, file = CAP_FILE) {
  const c = loadCapabilities(file).byId.get(String(id));
  if (!c) return null;
  return { ...c, available: c.enabled !== false };
}

export function byGroup(group, file = CAP_FILE) {
  return loadCapabilities(file).list.filter((c) => c.group === group);
}

/**
 * 发送类工具名（bridge 用它拼 SEND_TOOL_RE）。
 * 只收 sendTool === true 的；sticker/poke 这类装饰件不算——算进去会把同回合文字吞掉。
 */
export function sendToolNames(file = CAP_FILE) {
  return loadCapabilities(file)
    .list.filter((c) => c.sendTool === true && c.mcpTool)
    .map((c) => String(c.mcpTool));
}

/** v2 工具开关名（socialV2.tools 的 key） */
export function toolFlags(file = CAP_FILE) {
  return loadCapabilities(file)
    .list.filter((c) => c.toolFlag)
    .map((c) => String(c.toolFlag));
}

// ---------- 一致性断言 ----------

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 检查「能力表 ↔ 代码」是否一致。返回 { ok, issues[], checked }。
 * 只做能明确判定真假的检查，不做风格检查。
 */
export function assertConsistent({ root = DEFAULT_ROOT, file = CAP_FILE } = {}) {
  const issues = [];
  const caps = loadCapabilities(file);
  if (caps.degraded) {
    return { ok: false, issues: [`能力表读取失败：${caps.error}`], checked: 0 };
  }
  const bridgeFile = path.join(root, 'qq-bridge', 'src', 'bridge.js');
  const mcpFile = path.join(root, 'qq-bridge', 'src', 'mcp-snowluma-safe.js');
  const mcpBiliFile = path.join(root, 'qq-bridge', 'src', 'mcp-bili.js');
  const restrictFile = path.join(root, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'qq-tool-restrict.mjs');
  const bridge = readText(bridgeFile);
  const mcp = readText(mcpFile) + '\n' + readText(mcpBiliFile); // 工具可能注册在任意一个 server
  const restrict = readText(restrictFile);
  let checked = 0;

  // 0) 必备文件存在
  for (const [name, content] of [['bridge.js', bridge], ['mcp-snowluma-safe.js', mcp]]) {
    checked += 1;
    if (!content) issues.push(`缺少文件或读取为空：${name}`);
  }

  // 1) bridge 的 SEND_TOOL_RE 必须由能力表派生（否则改了表不生效 → 双发）
  checked += 1;
  if (!/capabilities\.json|loadSendToolNames|sendToolNames/.test(bridge)) {
    issues.push('bridge.js 未从能力表派生 SEND_TOOL_RE（仍是手写正则）');
  }

  // 2) 每个 sendTool:true 的工具名必须能在 bridge 的正则来源里找到（派生模式下检查表本身合法性）
  for (const c of caps.list.filter((x) => x.sendTool === true)) {
    checked += 1;
    if (!c.mcpTool) issues.push(`能力 ${c.id} 标记 sendTool 但没写 mcpTool`);
    else if (!/^qq_/.test(c.mcpTool)) issues.push(`能力 ${c.id} 的 mcpTool 不是 qq_ 前缀：${c.mcpTool}`);
  }

  // 3) 每个 mcpTool 必须在 MCP 侧真的注册了（不同 server 变量名不同：server / mcp）
  for (const c of caps.list.filter((x) => x.mcpTool)) {
    checked += 1;
    const re = new RegExp(`\\b(?:server|mcp|srv)\\.tool\\(\\s*['"]${escapeRe(c.mcpTool)}['"]`);
    if (!re.test(mcp)) issues.push(`能力 ${c.id} 声明了 ${c.mcpTool}，但 mcp-snowluma-safe.js / mcp-bili.js 里都没注册`);
  }

  // 4) 每个 toolFlag 必须出现在 bridge 的 tools 默认值里（至少 2 处：默认块 + 深合并块）
  for (const c of caps.list.filter((x) => x.toolFlag)) {
    checked += 1;
    const hits = (bridge.match(new RegExp(`\\b${escapeRe(c.toolFlag)}\\s*:\\s*(true|false)`, 'g')) || []).length;
    if (hits < 2) issues.push(`能力 ${c.id} 的开关 ${c.toolFlag} 只出现 ${hits} 次（应为 2 处：默认块 + 深合并块）`);
  }

  // 5) MCP 工具前缀必须在 restrict 白名单内（否则模型调不到）
  if (restrict) {
    const prefixes = (restrict.match(/SAFE_PREFIXES\s*=\s*\[([^\]]*)\]/s)?.[1] || '');
    checked += 1;
    if (!prefixes.includes('mcp__snowluma__')) {
      issues.push('qq-tool-restrict.mjs 的 SAFE_PREFIXES 未包含 mcp__snowluma__');
    }
  } else {
    issues.push('缺少 qq-tool-restrict.mjs（跳过前缀检查）');
  }

  return { ok: issues.length === 0, issues, checked };
}

export default { loadCapabilities, getCapability, byGroup, sendToolNames, toolFlags, assertConsistent };
