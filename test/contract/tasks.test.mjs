// 任务表契约测试：到点判定 / 去重键 / 非法配置回退
// 这些是「到点该跑却没跑」和「一天跑三遍」两类事故的唯一防线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner, evaluateDue, parseTime, localDateKey, isoWeekKey } from '../../services/tasks.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const at = (s) => new Date(s);

test('到点后任意时刻都算欠着（合盖醒来会补跑）', () => {
  const dueAt = { hour: 22, minute: 30 };
  assert.equal(evaluateDue({ dueAt, key: 'k', lastKey: '', now: at('2026-11-05T22:30:00') }).due, true);
  assert.equal(evaluateDue({ dueAt, key: 'k', lastKey: '', now: at('2026-11-05T23:59:00') }).due, true);
});

test('没到点不跑', () => {
  const dueAt = { hour: 22, minute: 30 };
  assert.equal(evaluateDue({ dueAt, key: 'k', lastKey: '', now: at('2026-11-05T22:29:59') }).due, false);
});

test('同一周期已跑过不重复（键相同）', () => {
  const dueAt = { hour: 22, minute: 30 };
  const r = evaluateDue({ dueAt, key: '2026-11-05', lastKey: '2026-11-05', now: at('2026-11-05T23:00:00') });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'already-done');
});

test('跨天要重跑（键变大）', () => {
  const dueAt = { hour: 22, minute: 30 };
  assert.equal(evaluateDue({ dueAt, key: '2026-11-06', lastKey: '2026-11-05', now: at('2026-11-06T22:31:00') }).due, true);
});

test('周任务只在指定星期几跑', () => {
  const dueAt = { hour: 21, minute: 0, weekday: 1 }; // 周一
  const monday = at('2026-11-02T21:30:00');
  const tuesday = at('2026-11-03T21:30:00');
  if (monday.getDay() !== 1 || tuesday.getDay() !== 2) return; // 时区差异时跳过
  assert.equal(evaluateDue({ dueAt, key: 'w', lastKey: '', now: monday }).due, true);
  assert.equal(evaluateDue({ dueAt, key: 'w', lastKey: '', now: tuesday }).due, false);
});

test('parseTime 容错：非法值回退到 fallback', () => {
  assert.deepEqual(parseTime('22:30'), { hour: 22, minute: 30 });
  assert.deepEqual(parseTime('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(parseTime('', '09:15'), { hour: 9, minute: 15 });
  assert.deepEqual(parseTime('abc', '12:45'), { hour: 12, minute: 45 });
  assert.deepEqual(parseTime('99:99'), { hour: 23, minute: 59 });
});

test('日期键用本地时间（UTC 会让 0~8 点重复触发）', () => {
  const d = at('2026-11-05T00:30:00');
  const key = localDateKey(d);
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(key, localDay);
});

test('ISO 周键稳定且可比较', () => {
  const a = isoWeekKey(at('2026-11-02T12:00:00'));
  const b = isoWeekKey(at('2026-11-06T12:00:00'));
  assert.equal(a, b, '同一周应相同');
  assert.match(a, /^\d{4}-W\d{2}$/);
});

test('runner：成功才记 key，失败下一轮重试', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-tasks-'));
  const runner = createTaskRunner({ root, log: () => {}, tickMs: 999999 });
  let attempt = 0;
  runner.register({
    id: 't.flaky',
    dueAt: { hour: 0, minute: 0 },
    key: () => '2026-11-05',
    run: async () => {
      attempt += 1;
      return attempt >= 2; // 第一次失败
    }
  });

  await runner.tickOnce(at('2026-11-05T10:00:00'));
  assert.equal(attempt, 1, '第一次应执行');
  assert.equal(runner.list()[0].lastKey, null, '失败不该记 key');

  await runner.tickOnce(at('2026-11-05T10:01:00'));
  assert.equal(attempt, 2, '第二轮应重试');
  assert.equal(runner.list()[0].lastKey, '2026-11-05');

  await runner.tickOnce(at('2026-11-05T10:02:00'));
  assert.equal(attempt, 2, '记了 key 之后不再执行');

  fs.rmSync(root, { recursive: true, force: true });
});

test('runner：enabled() 为 false 时不执行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-tasks-'));
  const runner = createTaskRunner({ root, log: () => {}, tickMs: 999999 });
  let ran = 0;
  runner.register({
    id: 't.off',
    enabled: () => false,
    dueAt: { hour: 0, minute: 0 },
    key: () => 'd',
    run: async () => { ran += 1; }
  });
  await runner.tickOnce(at('2026-11-05T23:00:00'));
  assert.equal(ran, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runner：key() 返回 null 表示今天不算（例如没有日报）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-tasks-'));
  const runner = createTaskRunner({ root, log: () => {}, tickMs: 999999 });
  let ran = 0;
  runner.register({
    id: 't.nokey',
    dueAt: { hour: 0, minute: 0 },
    key: () => null,
    run: async () => { ran += 1; }
  });
  await runner.tickOnce(at('2026-11-05T23:00:00'));
  assert.equal(ran, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
