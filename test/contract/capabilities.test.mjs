// 契约测试（零依赖，node:test）
// 目的：让"改能力表/改发送工具"这类改动有机器可验的护栏，不靠人肉回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCapabilities,
  sendToolNames,
  toolFlags,
  assertConsistent,
  getCapability
} from '../../config/capabilities.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('能力表可读且不是降级状态', () => {
  const caps = loadCapabilities();
  assert.equal(caps.degraded, false);
  assert.ok(caps.list.length >= 8, `能力数量异常：${caps.list.length}`);
});

test('能力表与代码一致（SEND_TOOL_RE / 工具开关 / MCP 注册 / 前缀白名单）', () => {
  const res = assertConsistent({ root: ROOT });
  assert.equal(res.ok, true, res.issues.join('\n'));
});

test('发送类工具名派生正确：语音在内，表情/戳一戳不在', () => {
  const names = sendToolNames();
  assert.ok(names.includes('qq_send_message'));
  assert.ok(names.includes('qq_send_voice'), '语音必须算发送类，否则会双发');
  assert.ok(!names.includes('qq_send_sticker'), '表情不算发送类，算进去会吞掉同回合文字');
  assert.ok(!names.includes('qq_send_poke'));
});

test('每个 v2 开关名都能在 bridge 默认值里找到（防止"加了工具但关不掉"）', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'src', 'bridge.js'), 'utf8');
  for (const flag of toolFlags()) {
    const hits = (bridge.match(new RegExp(`\\b${flag}\\s*:\\s*(true|false)`, 'g')) || []).length;
    assert.ok(hits >= 2, `开关 ${flag} 只出现 ${hits} 次`);
  }
});

test('未知能力返回 null（fail-closed）', () => {
  assert.equal(getCapability('qq.not-exist'), null);
});

test('voice 能力登记为 write + sendTool', () => {
  const cap = getCapability('qq.send-voice');
  assert.ok(cap, '缺少 qq.send-voice');
  assert.equal(cap.write, true);
  assert.equal(cap.sendTool, true);
  assert.equal(cap.mcpTool, 'qq_send_voice');
});

test('B站直播发弹幕默认关闭（写操作不能默认开着）', () => {
  const cap = getCapability('bili.live-send');
  assert.ok(cap);
  assert.equal(cap.enabled, false);
  assert.equal(cap.review, 'pre');
});
