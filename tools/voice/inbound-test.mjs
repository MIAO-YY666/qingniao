// 入站语音集成测试：用 stub bot 模拟 OneBot 的 get_record 返回，
// 走完「base64 → 落盘 state/voice → hub ASR → 文本」整条链（不发 QQ、不依赖真实语音消息）。
// 用法：node tools/voice/inbound-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceAsr } from '../../qq-bridge/src/voice-asr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'suite.json'), 'utf8'));
const token = fs.readFileSync(path.join(ROOT, 'state', 'hub-token'), 'utf8').trim();

// 用测试夹具当"收到的语音"（test/fixtures/sample-zh.wav，内容是"晚上好呀，今天辛苦了。"）
const sample = path.join(ROOT, 'test', 'fixtures', 'sample-zh.wav');
if (!fs.existsSync(sample)) {
  console.error('缺少 test/fixtures/sample-zh.wav');
  process.exit(1);
}
const b64 = fs.readFileSync(sample).toString('base64');

let calls = 0;
const stubBot = {
  async getRecord({ file, out_format }) {
    calls += 1;
    if (out_format !== 'wav') throw new Error(`期望 out_format=wav，实际 ${out_format}`);
    if (!String(file).startsWith('fake-')) throw new Error(`未知 file：${file}`);
    return { file: `base64://${b64}` };
  }
};

const asr = createVoiceAsr({
  root: ROOT,
  log: (m) => console.log(m),
  bot: stubBot,
  hubBase: `http://127.0.0.1:${suite.hub?.port || 3160}`,
  hubToken: () => token
});

const r1 = await asr.transcribe({ file: 'fake-record-001', url: 'https://example.invalid/x.amr' });
console.log('第一次：', JSON.stringify(r1, null, 2));

const r2 = await asr.transcribe({ file: 'fake-record-001', url: 'https://example.invalid/x.amr' });
console.log('第二次（应命中缓存、不再调 get_record）：', JSON.stringify(r2));

console.log(`getRecord 调用次数：${calls}（应为 1）`);
const ok = r1.ok && r1.text && calls === 1 && r2.cached === true;
console.log(ok ? '✓ 入站语音链路通过' : '✗ 入站语音链路异常');
process.exit(ok ? 0 : 1);
