// P1 / 全量印象注入回归测试（2026-11-06）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../../services/memory.js';

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-salience-'));
  return { root, s: createMemoryStore({ root, backupPath: path.join(root, 'backup'), log: () => {} }) };
}

test('默认不再截断到 12 条，全量印象都进 prompt', () => {
  const { root, s } = store();
  try {
    for (let i = 1; i <= 20; i++) s.addImpression('qq-20001', `第 ${i} 条日常片段，关于他最近在忙的事`, { kind: 'episode', source: 'agent' });
    const out = s.renderForPrompt('qq-20001', { chars: 1e9 });
    for (let i = 1; i <= 20; i++) assert.ok(out.includes(`第 ${i} 条`), `缺第 ${i} 条`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('按 salience 挑：截断时保留重要条目，输出仍按时间正序', () => {
  const { root, s } = store();
  try {
    for (let i = 1; i <= 10; i++) s.addImpression('qq-20002', `普通片段 ${i}`, { kind: 'episode', source: 'agent', salience: 0.5 });
    s.addImpression('qq-20002', '关键：他明确说过以后日报只要 QQ 发', { kind: 'episode', source: 'agent', salience: 3 });
    const out = s.renderForPrompt('qq-20002', { max: 3, chars: 1e9 });
    assert.ok(out.includes('关键：他明确说过'), '高 salience 条目不能被截掉');
    const lines = out.split('\n').filter((x) => x.startsWith('- '));
    assert.equal(lines.length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('supersedes 让旧说法退场，但数据仍保留可回滚', () => {
  const { root, s } = store();
  try {
    s.addImpression('qq-20003', '他现在在 A 公司做后端', { kind: 'episode', source: 'agent' });
    s.addImpression('qq-20003', '他换工作了，现在在 B 公司做算法', {
      kind: 'episode', source: 'agent', supersedes: '他现在在 A 公司做后端'
    });
    const out = s.renderForPrompt('qq-20003', { chars: 1e9 });
    assert.ok(out.includes('B 公司'), '新说法应注入');
    assert.ok(!out.includes('A 公司'), '旧说法不应再同时注入');
    const person = s.readPerson('qq-20003');
    assert.equal(person.impressions.length, 2, '旧条目不能被删，要可追溯');
    assert.equal(person.impressions[0].superseded, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('同一主题再次写入会累加 mentions / salience', () => {
  const { root, s } = store();
  try {
    s.addImpression('qq-20004', '他在准备无人机航拍语义分割比赛，压力挺大', { kind: 'episode', source: 'agent' });
    s.addImpression('qq-20004', '无人机航拍语义分割比赛今天又聊到，他说还是没过基线', { kind: 'episode', source: 'agent' });
    const first = s.readPerson('qq-20004').impressions[0];
    assert.equal(first.mentions, 1, '同主题重复出现应记为被想起一次');
    assert.ok(Number(first.salience) > 1.2, 'salience 应随重复提及上涨');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
