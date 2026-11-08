// 推送队列回归测试（2026-11-06）
// 复现两个线上故障：
//   ① dispatchQueue 成功后不出队 → 2026-11-02 的旧日报被反复推到 11-06；
//   ② 失败分支 armNextValleyTimer 在谷时内同步递归 → 1 秒 198 次 fetch failed。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPushService } from '../../services/push-service.js';

const DAY = '2026-11-06';
const OLD = '2026-11-02';

function fixture({ fail, withNote = true, generatePushText } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-push-'));
  const outDir = path.join(root, 'bili-duty', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  // withNote=false 用来验证「值班没写推送语 → 交给桥接生成 → 失败回退模板」
  const note = withNote ? `## 给他的QQ\n今天挑了几个有意思的，记得看呀，别又熬夜。\n\n` : '';
  fs.writeFileSync(path.join(outDir, `${DAY}.md`),
    `# B站值班 ${DAY}\n\n${note}${'补充内容 '.repeat(30)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, `${OLD}.md`),
    `# B站值班 ${OLD}\n\n## 给他的QQ\n这是几天前的旧日报，不该再推。\n\n${'旧内容 '.repeat(30)}\n`, 'utf8');
  const stateFile = path.join(root, 'state', 'push-history.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    pushed: { [OLD]: { at: '2026-11-02T12:00:00.000Z', target: 10000, parts: 1 } },
    // 关键：queue 里残留一个「其实已经推过」的旧日期
    queue: [OLD, DAY],
    history: []
  }), 'utf8');

  const calls = [];
  const qqSocial = {
    async sendPrivateMessage(userId, text) {
      calls.push({ userId, text });
      if (fail) throw new Error('fetch failed');
      return { retcode: 0 };
    }
  };
  const suite = {
    paths: { duty: 'bili-duty', memoryBackup: path.join(root, 'backup') },
    push: { enabled: true, onlyInValley: false, catchUp: true, itemsInDigest: 5, maxChars: 2800 },
    identity: { pushTargetQQ: 10000, biliMentionName: '你的B站昵称' },
    valley: { windows: [] }
  };
  const svc = createPushService({
    root, suite, personaRef: { current: { pushVoice: {} } },
    qqSocial, log: () => {}, recordPlatformMessage: async () => {}, generatePushText
  });
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { root, svc, calls, read };
}

const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('推送成功后必须出队，且不再补发已推过的旧日报', async () => {
  const f = fixture({ fail: false });
  try {
    f.svc.start();
    await tick();
    const s = f.read();
    assert.equal(s.queue.length, 0, 'queue 应被清空（成功出队 + 过滤已推日期）');
    assert.ok(s.pushed[DAY], '新日报应标记为已推送');
    assert.equal(f.calls.length, 1, '只应发送一次');
    assert.ok(!f.calls[0].text.includes('几天前的旧日报'), '不能把旧日报再推一遍');
    const kinds = s.history.map((x) => x.kind);
    assert.ok(kinds.includes('push'), '历史里应有一条成功推送记录');
  } finally {
    f.svc.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('发送失败必须退避，不能同步递归刷屏', async () => {
  const f = fixture({ fail: true });
  try {
    f.svc.start();
    await tick(400);
    const s = f.read();
    // 修复前：同一秒内同步递归 198 次，history 被 push-failed 塞满。
    assert.equal(f.calls.length, 1, `只应尝试 1 次，实际 ${f.calls.length} 次`);
    const failures = s.history.filter((x) => x.kind === 'push-failed');
    assert.equal(failures.length, 1, '同类失败应折叠成一条（带 count）');
    assert.equal(failures[0].error, 'fetch failed');
    assert.ok(s.queue.includes(DAY), '失败后新日报应留在队列等待退避重试');
  } finally {
    f.svc.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('已推送的旧日期在补发调度开头就被过滤掉', async () => {
  const f = fixture({ fail: true });
  try {
    f.svc.start();
    await tick(400);
    const s = f.read();
    assert.ok(!s.queue.includes(OLD), `queue 里的 ${OLD} 已推过，应被清理；实际 ${JSON.stringify(s.queue)}`);
  } finally {
    f.svc.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('值班写了推送语时直接用，不再额外调桥接生成', async () => {
  let generated = 0;
  const f = fixture({ fail: false, withNote: true, generatePushText: async () => { generated++; return '桥接写的文案'; } });
  try {
    f.svc.start();
    await tick();
    assert.equal(generated, 0, '零成本路径优先，不该再花一次 LLM 请求');
    assert.ok(f.calls[0].text.includes('今天挑了几个有意思的'), '应使用值班轮自己写的推送语');
    assert.equal(f.read().pushed[DAY].introSource, 'duty-note');
  } finally {
    f.svc.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('值班没写推送语时交给桥接生成，并记录文案来源', async () => {
  const f = fixture({
    fail: false, withNote: false,
    generatePushText: async () => '刚翻到一条特有意思的，你肯定想先看这个，别又熬夜啊。'
  });
  try {
    f.svc.start();
    await tick();
    assert.ok(f.calls[0].text.startsWith('刚翻到一条特有意思的'), '桥接生成的文案应排在最前');
    assert.equal(f.read().pushed[DAY].introSource, 'bridge');
  } finally {
    f.svc.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('桥接生成失败时自动回退模板，不阻断推送', async () => {
  const f = fixture({
    fail: false, withNote: false,
    generatePushText: async () => { throw new Error('DSH 未就绪'); }
  });
  try {
    f.svc.start();
    await tick();
    assert.equal(f.calls.length, 1, '仍应正常发送一次');
    assert.equal(f.read().pushed[DAY].introSource, 'template');
  } finally {
    f.svc.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
