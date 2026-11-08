// 平台事件回灌：结构回归测试（2026-11-06）
// 目的：防止「平台短路消费的指令没回灌」以及「新增状态字段被 load/save 洗掉」再次发生。
// 这两类坑在本项目各踩过一次（personaNotes / groupDiveAccum）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bridge.js'),
  'utf8'
);

test('审核指令被消费后必须回灌平台事件（三个分支都要）', () => {
  const reviewBlock = src.slice(
    src.indexOf('async function tryHandleBiliDraftReview'),
    src.indexOf('bot.onPrivateMessage(')
  );
  assert.ok(reviewBlock.length > 500, '应能定位审核函数');
  const calls = (reviewBlock.match(/appendPlatformEventV2\(/g) || []).length;
  assert.equal(calls, 4, 'approve 成功/失败、reject、rewrite 共 4 处都要回灌');
  assert.ok(reviewBlock.includes('别再问「发不发」'), 'approve 文案要明确制止追问');
});

test('platformEvents 在默认值 / load / save 三处都持久化', () => {
  const occurrences = (src.match(/platformEvents:/g) || []).length;
  assert.ok(occurrences >= 3, `至少 3 处（默认/load/save），实际 ${occurrences}`);
  assert.ok(src.includes('platformEvents: []'), '新会话要有默认值');
  assert.ok(src.includes("Array.isArray(val.platformEvents)"), 'load 要从磁盘恢复');
  assert.ok(src.includes("Array.isArray(st.platformEvents)"), 'save 要写回磁盘');
});

test('回灌只进 recentMessages，绝不进 unread（否则会被当成待回复消息）', () => {
  const fn = src.slice(src.indexOf('function appendPlatformEventV2'), src.indexOf('function formatMemoryV2'));
  assert.ok(fn.includes('st.recentMessages.push'), '应写入对话流');
  assert.ok(!fn.includes('st.unread.push'), '不能写进未读队列');
  assert.ok(fn.includes('platformSent: true'), '应标记为平台发出，便于排查');
});

test('formatMemoryV2 会注入平台事件块，且有过期与条数上限', () => {
  assert.ok(src.includes('【刚刚平台替你处理的事】'));
  assert.ok(src.includes('2 * 3600 * 1000'), '2 小时过期，避免长期占 token');
  assert.ok(src.includes('platformEvents.slice(-3)'), '最多注入 3 条');
});
