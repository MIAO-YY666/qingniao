#!/usr/bin/env node
/**
 * QQ 聊天 LLM 用量报告（按北京时间）
 *
 * 数据源：DSH 会话历史 ~/.dsh/sessions/**\/session.v4.jsonl.zstd。
 * 该文件是多帧 zstd，必须按 magic 0x28B52FFD 切帧后逐帧解压；直接
 * zstdDecompressSync 整个文件只能拿到第一帧，会少算绝大部分请求。
 * 每条 usage 记录含 inputTokens / outputTokens / cacheReadTokens / totalTokens。
 *
 * 读法：
 *   inputTokens       未命中缓存、按全价计费的输入（缓存失效时会暴涨）
 *   cacheReadTokens   命中 prefix 缓存的输入（便宜，量大但不怎么花钱）
 *   单次 >5 万未命中且缓存读 <20%  => 一次「历史全量重发」，最该关注
 *
 * 用法：
 *   node scripts/usage-report.mjs                     今天
 *   node scripts/usage-report.mjs --all               全部日期汇总
 *   node scripts/usage-report.mjs --day 2026-11-05    指定日期
 *   node scripts/usage-report.mjs --by-hour           附按小时明细
 *   node scripts/usage-report.mjs --by-session        附按会话明细
 *   node scripts/usage-report.mjs --json              机器可读
 *   node scripts/usage-report.mjs --calibrate 11      用当天账单反推等效单价
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const SESSION_MAP_FILE = path.join(ROOT, 'qq-bridge', 'state', 'sessions.json');
const PRICING_FILE = path.join(ROOT, 'config', 'usage-pricing.json');
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;
const ZSTD_MAGIC = [0x28, 0xB5, 0x2F, 0xFD];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }
function beijingDay(ms) { return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10); }
function beijingHour(ms) { return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(11, 13); }
function num(n) { return Number(n || 0).toLocaleString('zh-CN'); }

/** 多帧 zstd：按 magic 找每一帧起点，逐帧解压，避免只拿到第一帧。 */
function* frames(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { yield zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); }
    catch { /* 单帧损坏不影响其它帧 */ }
  }
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
  }
  return out;
}

function loadSessionNames() {
  const names = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf8'));
    const map = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : raw;
    for (const [key, sid] of Object.entries(map)) if (typeof sid === 'string') names.set(sid, key);
  } catch { /* 映射读不到时按 sessionId 展示 */ }
  return names;
}

function findUsage(o) {
  if (!o || typeof o !== 'object') return null;
  const direct = [o?.data?.message?.usage, o?.data?.usage, o?.usage];
  for (const u of direct) if (u && typeof u === 'object' && 'inputTokens' in u) return u;
  return null;
}

function collect() {
  const names = loadSessionNames();
  const files = walk(SESSIONS_ROOT);
  const records = [];
  for (const file of files) {
    const sid = path.basename(path.dirname(file));
    for (const text of frames(fs.readFileSync(file))) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const u = findUsage(o);
        if (!u) continue;
        const t = Number(o.time || 0);
        if (!t) continue;
        records.push({
          day: beijingDay(t),
          hour: beijingHour(t),
          time: new Date(t + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
          session: names.get(sid) || sid,
          input: Number(u.inputTokens || 0),
          output: Number(u.outputTokens || 0),
          cacheRead: Number(u.cacheReadTokens || 0),
          cacheWrite: Number(u.cacheWriteTokens || 0),
          total: Number(u.totalTokens || 0)
        });
      }
    }
  }
  return { records, files: files.length };
}

function blank() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, big: 0, bigInput: 0 };
}
function add(acc, r, bigThreshold) {
  acc.requests++;
  acc.input += r.input; acc.output += r.output;
  acc.cacheRead += r.cacheRead; acc.cacheWrite += r.cacheWrite; acc.total += r.total;
  if (r.input >= bigThreshold && r.cacheRead < r.input * 0.2) { acc.big++; acc.bigInput += r.input; }
}

function readPricing() {
  try { return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')); }
  catch { return { yuanPerMillionUncachedInput: null }; }
}

function main() {
  const bigThreshold = Math.max(1000, Number(arg('--big', 50000)) || 50000);
  const all = flag('--all');
  const day = arg('--day', beijingDay(Date.now()));
  const { records, files } = collect();
  if (!records.length) {
    console.log(`未找到任何 usage 记录（扫描 ${files} 个会话文件，目录 ${SESSIONS_ROOT}）`);
    process.exit(0);
  }

  const byDay = new Map();
  for (const r of records) {
    if (!byDay.has(r.day)) byDay.set(r.day, blank());
    add(byDay.get(r.day), r, bigThreshold);
  }

  if (flag('--calibrate')) {
    const yuan = Number(arg('--calibrate'));
    const target = byDay.get(day);
    if (!(yuan > 0) || !target || target.input === 0) {
      console.log('校准失败：需要 --calibrate <正数元>，且当天必须有未命中输入 token');
      process.exit(1);
    }
    const price = yuan / (target.input / 1e6);
    const data = {
      yuanPerMillionUncachedInput: Math.round(price * 10000) / 10000,
      note: '等效单价 = 当天实际账单 ÷ 当天未命中输入 token（百万）。把缓存读/输出折算进去了，仅供趋势对比，不是官方单价。',
      calibratedFrom: { day, yuan, uncachedInput: target.input },
      updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(PRICING_FILE), { recursive: true });
    fs.writeFileSync(PRICING_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`已按 ${day} 的 ¥${yuan} 校准：等效单价 ¥${data.yuanPerMillionUncachedInput} / 百万未命中输入`);
    console.log(`写入 ${path.relative(ROOT, PRICING_FILE)}`);
    return;
  }

  const days = all ? [...byDay.keys()].sort() : [day];
  const pricing = readPricing();
  const price = Number(pricing.yuanPerMillionUncachedInput) || 0;
  const hourly = new Map(), bySession = new Map(), bigList = [];
  for (const r of records) {
    if (!days.includes(r.day)) continue;
    if (flag('--by-hour')) {
      const k = `${r.day} ${r.hour}:00`;
      if (!hourly.has(k)) hourly.set(k, blank());
      add(hourly.get(k), r, bigThreshold);
    }
    if (flag('--by-session')) {
      if (!bySession.has(r.session)) bySession.set(r.session, blank());
      add(bySession.get(r.session), r, bigThreshold);
    }
    if (r.input >= bigThreshold && r.cacheRead < r.input * 0.2) bigList.push(r);
  }

  const out = { days: {}, pricing: price || null, bigRequests: bigList };
  for (const d of days) out.days[d] = byDay.get(d) || blank();
  if (flag('--json')) { console.log(JSON.stringify(out, null, 2)); return; }

  const title = all ? '全部日期' : day;
  console.log(`\nQQ 聊天 LLM 用量报告 · ${title}（北京时间）`);
  console.log(`扫描 ${files} 个会话历史文件，命中 ${num(records.length)} 条带 usage 的记录\n`);
  console.log('日期          请求   未命中输入      缓存读         输出   缓存失效大请求  估算费用');
  console.log('─'.repeat(96));
  for (const d of days) {
    const v = byDay.get(d) || blank();
    const cost = price ? `¥${(v.input / 1e6 * price).toFixed(2)}` : '—';
    console.log(
      d.padEnd(12) + String(v.requests).padStart(6) +
      num(v.input).padStart(14) + num(v.cacheRead).padStart(14) +
      num(v.output).padStart(10) + `${v.big} 次 / ${num(v.bigInput)}`.padStart(18) + cost.padStart(10)
    );
  }
  const cur = byDay.get(day) || blank();
  if (!all) {
    const baseline = [...byDay.entries()].filter(([d]) => d < day).slice(-7);
    if (baseline.length) {
      const avg = baseline.reduce((a, [, v]) => a + v.input, 0) / baseline.length;
      const ratio = avg > 0 ? (cur.input / avg).toFixed(2) : '—';
      console.log(`\n近 ${baseline.length} 天未命中输入均值 ${num(Math.round(avg))}，今天是其 ${ratio} 倍`);
    }
    if (cur.big) {
      const pct = cur.input ? Math.round(cur.bigInput / cur.input * 100) : 0;
      console.log(`⚠ 缓存失效全量重发 ${cur.big} 次，合计 ${num(cur.bigInput)} 未命中输入（占全天 ${pct}%）——通常是会话历史过长 + 长时间空闲/服务重启`);
    }
  }
  if (!price) {
    console.log('\n估算费用未启用：跑一次 `node scripts/usage-report.mjs --calibrate <当天账单元数>` 即可按实际账单校准。');
  } else {
    console.log(`\n费用按等效单价 ¥${price}/百万未命中输入 估算（config/usage-pricing.json，仅供趋势对比）`);
  }
  if (flag('--by-hour') && hourly.size) {
    console.log('\n按小时：');
    for (const [k, v] of [...hourly.entries()].sort())
      console.log(`  ${k}  请求 ${String(v.requests).padStart(4)}  未命中 ${num(v.input).padStart(10)}  缓存读 ${num(v.cacheRead).padStart(12)}  大请求 ${v.big}`);
  }
  if (flag('--by-session') && bySession.size) {
    console.log('\n按会话：');
    for (const [k, v] of [...bySession.entries()].sort((a, b) => b[1].input - a[1].input))
      console.log(`  ${k.padEnd(26)} 请求 ${String(v.requests).padStart(4)}  未命中 ${num(v.input).padStart(10)}  大请求 ${v.big}`);
  }
  if (bigList.length) {
    console.log('\n缓存失效的大请求（未命中输入 > ' + num(bigThreshold) + ' 且缓存读 <20%）：');
    for (const r of bigList.slice(0, 20))
      console.log(`  ${r.time}  ${r.session.padEnd(26)} input ${num(r.input).padStart(9)}  cache ${num(r.cacheRead).padStart(8)}  out ${num(r.output)}`);
    if (bigList.length > 20) console.log(`  …还有 ${bigList.length - 20} 条`);
  }
  console.log('');
}

main();
