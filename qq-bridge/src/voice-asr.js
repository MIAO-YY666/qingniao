// ============================================================
// voice-asr.js —— 入站语音转写（OneBot record 段 → wav → 文本）
// ------------------------------------------------------------
// 背景：以前 bridge.js 把 record 段直接渲染成字面量 "[语音]"，语音里的信息全丢了。
// 现在：get_record(out_format=wav) 拿到音频 → POST hub /api/asr/transcribe → 文本。
//
// 三条纪律：
//   1. 不吞异常：失败必须带原因（模型没装 / 超时 / 转写空），由上层显示成
//      "[语音（转写失败：原因）]"，而不是假装成功。
//   2. 不重复转写：同一个事件 segmentsToText 会被调两次（指向性判断 + 正文），
//      用 in-flight Promise + 结果缓存挡住，否则一条语音要跑两遍模型。
//   3. 不落 C 盘：wav 只写 state/voice/。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;

/**
 * @param {object} opts
 * @param {string} opts.root        qq-bridge 根目录（state/voice 落这里）
 * @param {(m:string)=>void} opts.log
 * @param {{getRecord:Function}} opts.bot   @snowluma/sdk 客户端
 * @param {string} opts.hubBase     http://127.0.0.1:3160
 * @param {()=>string} opts.hubToken
 */
export function createVoiceAsr({ root, log, bot, hubBase, hubToken }) {
  const outDir = path.join(root, 'state', 'voice');
  const cache = new Map();       // key -> { at, text, ok, reason }
  const inflight = new Map();    // key -> Promise

  function ensureDir() {
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
  }

  function cacheKey(data) {
    const raw = `${data?.file ?? ''}|${data?.url ?? ''}|${data?.file_size ?? ''}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }

  function prune() {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at > DEFAULT_TTL_MS) cache.delete(k);
    }
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  /** 把 get_record 的返回（base64:// 或本地路径或 url）落成本地 wav，返回绝对路径 */
  async function materialize(info, key) {
    ensureDir();
    const dest = path.join(outDir, `${key}.wav`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 512) return dest;

    const candidates = [info?.file, info?.data?.file, info?.base64, info?.data?.base64].filter(Boolean);
    for (const c of candidates) {
      const s = String(c);
      if (s.startsWith('base64://')) {
        const buf = Buffer.from(s.slice('base64://'.length), 'base64');
        if (buf.length > 512) { fs.writeFileSync(dest, buf); return dest; }
      } else if (s.startsWith('data:')) {
        const b64 = s.slice(s.indexOf(',') + 1);
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 512) { fs.writeFileSync(dest, buf); return dest; }
      } else if (/^https?:\/\//i.test(s)) {
        const res = await fetch(s, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`下载语音失败 HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 512) { fs.writeFileSync(dest, buf); return dest; }
      } else if (fs.existsSync(s)) {
        const buf = fs.readFileSync(s);
        if (buf.length > 512) { fs.writeFileSync(dest, buf); return dest; }
      }
    }
    throw new Error('get_record 未返回可用音频（可能是缓存已过期）');
  }

  /**
   * 转写一条语音。
   * @returns {Promise<{ok:boolean, text?:string, reason?:string, cached?:boolean}>}
   */
  async function transcribe(data) {
    const key = cacheKey(data);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < DEFAULT_TTL_MS) return { ...hit, cached: true };
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      try {
        // file 本身就是 file:/// 本地路径时不必再问网关
        let wavPath;
        const rawFile = String(data?.file ?? '');
        if (rawFile.startsWith('file:///') || /^[a-zA-Z]:[\\/]/.test(rawFile)) {
          const p = rawFile.startsWith('file:///') ? decodeURIComponent(rawFile.slice('file:///'.length)) : rawFile;
          if (fs.existsSync(p)) {
            ensureDir();
            wavPath = path.join(outDir, `${key}.wav`);
            if (!fs.existsSync(wavPath)) fs.copyFileSync(p, wavPath);
          }
        }
        if (!wavPath) {
          const info = await bot.getRecord({ file: rawFile, out_format: 'wav' });
          wavPath = await materialize(info, key);
        }

        const res = await fetch(`${hubBase}/api/asr/transcribe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hub-token': hubToken() },
          body: JSON.stringify({ path: wavPath }),
          signal: AbortSignal.timeout(120000)
        });
        const body = await res.json().catch(() => null);
        const out = body?.ok && body?.text
          ? { ok: true, at: Date.now(), text: String(body.text).trim() }
          : { ok: false, at: Date.now(), reason: body?.error || `HTTP ${res.status}` };
        // 转写失败也缓存 60 秒，避免同一条语音在两次调用里各跑一遍模型、各报一次错
        cache.set(key, out.ok ? out : { ...out, at: Date.now() + DEFAULT_TTL_MS - 60 * 1000 });
        prune();
        return out;
      } catch (e) {
        const out = { ok: false, at: Date.now(), reason: String(e?.message || e) };
        log(`[voice] 转写失败（${key}）：${out.reason}`);
        cache.set(key, out);
        prune();
        return out;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, job);
    return job;
  }

  return { transcribe, outDir };
}

export default { createVoiceAsr };
