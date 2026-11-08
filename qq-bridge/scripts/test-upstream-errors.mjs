// 回归测试（2026-11-05）：上游 LLM 的一次失败，不能因为 session/follow 重连回放
// 就在 QQ 上刷成上百条「⚠️ agent 处理出错」。
//
// 运行：node --test scripts/test-upstream-errors.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NodeApiClient,
  classifyAgentError,
  isReplayFrame,
  createTurnCollector,
} from '../src/dsh-client.js';

const TOO_BUSY = 'Service is too busy. We advise users to temporarily switch to alternative LLM API service providers. (request_id: f976b7a0-25b4-40cd-8b49-16b09edd29b1)';
const STREAM_ENDED = 'DeepSeek Messages stream ended before message_stop';

test('上游限流 / 断流归类为瞬时故障，并按 request_id 生成稳定签名', () => {
  const a = classifyAgentError(TOO_BUSY);
  assert.equal(a.transient, true);
  assert.equal(a.requestId, 'f976b7a0-25b4-40cd-8b49-16b09edd29b1');
  assert.equal(a.signature, 'rid:f976b7a0-25b4-40cd-8b49-16b09edd29b1');
  // 同一个上游请求被回放多少次，签名都必须一致，才能被去重挡住
  assert.equal(classifyAgentError(TOO_BUSY).signature, a.signature);
  assert.notEqual(classifyAgentError(TOO_BUSY.replace('f976b7a0', 'aaaaaaaa')).signature, a.signature);

  const b = classifyAgentError(STREAM_ENDED);
  assert.equal(b.transient, true);
  assert.equal(b.requestId, null);
  assert.equal(classifyAgentError(STREAM_ENDED).signature, b.signature);
});

test('真正的程序错误仍按 fatal 处理（不能被误判成瞬时）', () => {
  const r = classifyAgentError('TypeError: Cannot read properties of undefined (reading "foo")');
  assert.equal(r.transient, false);
  assert.ok(r.signature.startsWith('msg:'));
});

test('只有 snapshot 回放帧带 historical 标记', () => {
  assert.equal(isReplayFrame({ type: 'session/event', historical: true }), true);
  assert.equal(isReplayFrame({ type: 'session/event', historical: false }), false);
  assert.equal(isReplayFrame({ type: 'session/event' }), false);
  assert.equal(isReplayFrame(null), false);
});

test('孤立的历史 turn/end 仍能终结回合（状态机不能卡死）', () => {
  const collector = createTurnCollector();
  const ended = collector.push({
    type: 'turn/end',
    data: { turn: 't1', reason: { kind: 'error', error: { message: TOO_BUSY } } },
  });
  assert.ok(ended);
  assert.equal(ended.reason.kind, 'error');
  assert.equal(ended.text, '');
});

test('session/follow 的 snapshot 帧标 historical=true、增量帧标 false', async () => {
  const client = new NodeApiClient('http://127.0.0.1:1', 1000, { cookie: 'test' });
  client.openStream = async function* () {
    yield {
      type: 'snapshot',
      records: [
        {
          type: 'event',
          event: { type: 'turn/end', data: { turn: 'old', reason: { kind: 'error', error: { message: TOO_BUSY } } } },
        },
        { type: 'chunks' }, // 存储编码行，不是会话事件，必须跳过
      ],
    };
    yield { type: 'event', event: { type: 'turn/start', data: { turn: 'new' } } };
  };
  const frames = [];
  for await (const envelope of client.events.session('s1', {})) frames.push(envelope.payload);
  assert.equal(frames.length, 2, 'chunks 行不应产出帧');
  assert.equal(frames[0].historical, true);
  assert.equal(frames[0].event.type, 'turn/end');
  assert.equal(frames[1].historical, false);
  assert.equal(frames[1].event.type, 'turn/start');
});
