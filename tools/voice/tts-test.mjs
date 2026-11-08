// 语音自测：合成一句 → 打印产物信息（不发送到 QQ）
// 用法：node tools/voice/tts-test.mjs "要说的话"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTts } from '../../services/tts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'suite.json'), 'utf8'));
const text = process.argv[2] || '你好呀，我是青鸟。';

const tts = createTts({ root: ROOT, suite, log: (m) => console.log(m) });
const probe = await tts.probe();
console.log('环境：', JSON.stringify(probe, null, 2));

const r = await tts.synthesize(text, {});
console.log('合成结果：', JSON.stringify(r, null, 2));
if (r.ok && fs.existsSync(r.path)) {
  console.log(`产物：${r.path}（${(fs.statSync(r.path).size / 1024).toFixed(1)}KB）`);
} else {
  process.exitCode = 1;
}
