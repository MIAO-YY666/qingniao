// 记忆分层回归测试（2026-11-06）
// 用户诉求：推送流水账少记、日常与印象多记，且推送记录不能占掉唤醒 prompt 的注入窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../../services/memory.js';

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-memory-'));
  return {
    root,
    s: createMemoryStore({ root, backupPath: path.join(root, 'backup'), log: () => {} })
  };
}

test('log 类推送记录默认不进 prompt，日常印象正常注入', () => {
  const { root, s } = store();
  try {
    s.addImpression('qq-10001', '他最近在忙无人机比赛，嘴上说没事但熬夜变多', { kind: 'episode', source: 'agent' });
    s.addImpression('qq-10001', '【平台代发】B站值班 2026-11-06 给他推了日报：《标题A》', { kind: 'log', source: 'platform' });
    const prompt = s.renderForPrompt('qq-10001');
    assert.ok(prompt.includes('无人机比赛'), '日常印象应注入');
    assert.ok(!prompt.includes('给他推了日报'), '推送流水账默认不注入');
    assert.ok(s.renderForPrompt('qq-10001', { includeLog: true }).includes('给他推了日报'), '显式 includeLog 时仍可查');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧数据没有 kind 字段时，靠文本特征自动降级为 log', () => {
  const { root, s } = store();
  try {
    s.addImpression('qq-10002', '（B站值班 2026-10-24）给他推了日报：《旧标题》', { source: 'platform' });
    // 手动抹掉 kind，模拟 2026-11-06 之前写入的历史条目
    const f = path.join(root, 'memory', 'people', 'qq-10002.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete d.impressions[0].kind;
    fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
    assert.equal(s.renderForPrompt('qq-10002'), '', '历史推送记录应被自动识别为 log 并排除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('平台滚动写入：同类 log 只保留最近 1 条，日常印象不受影响', () => {
  const { root, s } = store();
  try {
    s.addImpression('qq-10003', '他喜欢深夜聊项目，说话短', { kind: 'episode', source: 'agent' });
    for (const day of ['2026-11-04', '2026-11-05', '2026-11-06']) {
      s.addImpression('qq-10003', `【平台代发】B站值班 ${day} 给他推了日报：《标题${day}》`,
        { kind: 'log', source: 'platform', keepLatestOfKind: 1 });
    }
    const person = s.readPerson('qq-10003');
    const logs = person.impressions.filter((x) => x.kind === 'log');
    assert.equal(logs.length, 1, '只保留最近一条推送记录');
    assert.ok(logs[0].text.includes('2026-11-06'));
    assert.equal(person.impressions.filter((x) => x.kind === 'episode').length, 1, '日常印象不能被滚动清掉');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
