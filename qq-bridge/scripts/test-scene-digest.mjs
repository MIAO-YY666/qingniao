// P2 跨日情景摘要回归测试（2026-11-06）
// 用户不能保证深夜在线/关机时间稳定，所以这里验证的是「运行时判定日期变了就补做」，
// 不是任何定时任务。运行：npm run test-scene
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneDigest, rollSceneDigest, pushSceneBucket, formatSceneDigests } from '../src/scene-digest.js';

const day = (n) => `2026-11-0${n}`;
const msg = (n, text, time = Date.now()) => ({ sender: n, plain: text, time });

function state(d) {
  return { sceneDay: d, sceneBucket: [], sceneDigests: {} };
}

test('日期相同：零开销、不归纳、不落盘', () => {
  const st = state(day(5));
  pushSceneBucket(st, msg('阿苗', '今天聊了点项目上的事'));
  assert.equal(rollSceneDigest(st, day(5)), false);
  assert.equal(st.sceneBucket.length, 1);
  assert.deepEqual(st.sceneDigests, {});
});

test('跨日：第一次活动立即归纳昨天，且同一天不会重复做', () => {
  const st = state(day(5));
  pushSceneBucket(st, msg('阿苗', '昨天我们在聊无人机比赛的事'));
  pushSceneBucket(st, msg('云宝', '还提到了体测 800 米'));
  assert.equal(rollSceneDigest(st, day(6)), true, '跨日应触发归纳');
  assert.equal(st.sceneBucket.length, 0, '桶应清空');
  assert.equal(st.sceneDay, day(6));
  assert.ok(st.sceneDigests[day(5)].includes('收到 2 条'));
  assert.ok(st.sceneDigests[day(5)].includes('阿苗'));
  assert.equal(rollSceneDigest(st, day(6)), false, '同一天再次调用应幂等');
  assert.ok(formatSceneDigests(st).includes('最近几天的情景'));
});

test('关机好几天：开机后第一次活动就补上，不依赖固定时刻', () => {
  const st = state(day(2));
  pushSceneBucket(st, msg('阿苗', '那天聊到很晚的话题'));
  assert.equal(rollSceneDigest(st, day(6)), true);
  assert.ok(st.sceneDigests[day(2)], '关机前的那天仍被归纳');
  assert.equal(rollSceneDigest(st, day(6)), false);
});

test('只保留最近 3 天摘要', () => {
  const st = state(day(1));
  for (const d of [1, 2, 3, 4, 5]) {
    st.sceneDay = day(d);
    pushSceneBucket(st, msg('阿苗', `这是 ${d} 号聊的内容`));
    rollSceneDigest(st, day(d + 1));
  }
  const days = Object.keys(st.sceneDigests).sort();
  assert.deepEqual(days, [day(3), day(4), day(5)]);
  const text = formatSceneDigests(st);
  assert.ok(!text.includes(day(1)) && !text.includes(day(2)));
});

test('桶有上限，且摘要不依赖 recentMessages 的滚动窗口', () => {
  const st = state(day(5));
  for (let i = 0; i < 200; i++) pushSceneBucket(st, msg('阿苗', `第 ${i} 条`));
  assert.equal(st.sceneBucket.length, 120);
  const digest = buildSceneDigest(day(5), st.sceneBucket);
  assert.ok(digest.includes('收到 120 条'));
});

test('空桶跨日不写摘要，但日期照样推进', () => {
  const st = state(day(5));
  assert.equal(rollSceneDigest(st, day(6)), true);
  assert.deepEqual(st.sceneDigests, {});
  assert.equal(st.sceneDay, day(6));
});
