// ============================================================
// memory.js —— 跨平台人向记忆库（bloom-hub）
// ------------------------------------------------------------
// 存储：bloom-hub/memory/people/<key>.json（一人一文件）
//   key 约定：qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>
//   一个人可以有多个身份（QQ 号、B站号……）：identities[] 记录全部，
//   用任一身份读写都会落到同一个人文件（resolve），link() 合并两人文件。
//   文件内容：{ key, platform, identity, identities[], displayName, impressions[], updatedAt }
// 备份：每次写入同步镜像到 <backupPath>/people/（项目外），
//       每天首次写入再整目录快照到 <backupPath>/snapshots/<日期>/
// 所有出口共用：QQ 桥接（自动注入 + 工具 CRUD）、B站值班（MCP 工具）、管理平台。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

const MAX_IMPRESSIONS = 60;

// 印象分层（2026-11-06）：
//   episode = 日常互动、说过的话、对一个人的印象与判断（要进上下文）
//   log     = 平台流水账（日报推送记录等），可查但默认不注入 prompt
// 旧数据没有 kind 字段，按文本特征推断，所以历史推送记录会自动被降级，
// 不需要手工迁移数据。用户诉求：推送少记、日常与印象多记。
const PUSH_LOG_RE = /给他推了日报|B站值班\s*\d{4}-\d{2}-\d{2}|平台代发|推送了日报|已推送日报/;
function inferImpressionKind(imp) {
  if (imp && (imp.kind === 'log' || imp.kind === 'episode')) return imp.kind;
  const t = String((imp && imp.text) || imp || '');
  return PUSH_LOG_RE.test(t) ? 'log' : 'episode';
}

// ---- P1：显著性（salience）----------------------------------------------
// 不做不可靠的「模型有没有想起这条」自动检测。可信信号只有两个：
//   ① 谁写的、写得多具体；② 同一件事后来又被写了一次（说明它反复被想起）。
// 后者用中文 bigram Jaccard 做轻量相似判定，不需要分词库，也不会凭空造信号。
function bigrams(text) {
  const t = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  // 重叠系数而非 Jaccard：中文长句的 Jaccard 天然偏低（实测同主题两句只有
  // 0.32，无关句 0.05），用 |A∩B| / min(|A|,|B|) 区分度更稳（0.56 vs 0.10）。
  return hit / Math.min(A.size, B.size);
}
function baseSalience(text, { source = 'agent', kind = 'episode' } = {}) {
  if (kind === 'log') return 0.1;
  let s = source === 'agent' ? 1.2 : 0.9;
  // 带日期、数字、引号、原话的条目更具体，也更可能被以后用上
  if (/\d{1,4}[-/月日年]|\d+\s*[条次岁点]|[「“"']/.test(String(text || ''))) s += 0.3;
  return s;
}

export function createMemoryStore({ root, backupPath, log = () => {} }) {
  const dir = path.join(root, 'memory', 'people');
  const backupPeople = path.join(backupPath, 'people');
  const backupSnapshots = path.join(backupPath, 'snapshots');

  function ensureDirs() {
    for (const d of [dir, backupPeople, backupSnapshots]) fs.mkdirSync(d, { recursive: true });
  }

  function fileFor(key) {
    // Unicode 字母/数字一律保留（中文昵称不再坍缩成同一个 bili-_.json），
    // 只有真正非法的文件名字符才换成 _。与移动端 MemoryStore.kt 的清洗规则保持一致。
    const safe = String(key).replace(/[^\p{L}\p{N}._-]+/gu, '_');
    return path.join(dir, `${safe}.json`);
  }

  function readPersonRaw(key) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    } catch {
      return null;
    }
  }

  // 身份 → 人：按 key 或 identities[] 解析（跨平台打通的核心）
  function resolve(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    const direct = readPersonRaw(k);
    if (direct) return direct;
    try {
      ensureDirs();
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (p.key === k || (Array.isArray(p.identities) && p.identities.includes(k))) return p;
        } catch { /* skip broken */ }
      }
    } catch { /* ignore */ }
    return null;
  }

  function snapshotDaily() {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const snapDir = path.join(backupSnapshots, day);
      if (fs.existsSync(snapDir)) return;
      fs.mkdirSync(snapDir, { recursive: true });
      for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(snapDir, f));
      log(`[memory] 每日快照已写入 ${snapDir}`);
    } catch (e) {
      log(`[memory] 快照失败：${e.message}`);
    }
  }

  function removeFilesFor(key) {
    for (const f of [fileFor(key), path.join(backupPeople, path.basename(fileFor(key)))]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }

  function writePerson(person) {
    ensureDirs();
    person.updatedAt = new Date().toISOString();
    if (!Array.isArray(person.identities)) person.identities = [person.key];
    if (!person.identities.includes(person.key)) person.identities.unshift(person.key);
    const file = fileFor(person.key);
    // 原子写：先写唯一临时文件再 rename。
    // 这里是多进程共享的文件（hub / bili-duty MCP / 桥接各一个实例），
    // 直接 writeFileSync 会让并发的读者读到半个 JSON。
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(person, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    // 项目外镜像备份
    fs.mkdirSync(backupPeople, { recursive: true });
    fs.copyFileSync(file, path.join(backupPeople, path.basename(file)));
    snapshotDaily();
    return person;
  }

  function readOrCreate(key, { displayName = '', platform = '' } = {}) {
    const k = String(key || '').trim();
    const found = resolve(k);
    if (found) {
      // 用新身份写入已有的人：把该身份登记进去
      if (!found.identities.includes(k)) {
        found.identities.push(k);
        writePerson(found);
      }
      return found;
    }
    return { key: k, platform, identity: k.replace(/^(qq|group|bili)-/, ''), identities: [k], displayName, impressions: [], createdAt: new Date().toISOString() };
  }

  return {
    dir,
    backupPath,
    resolve,
    readPerson: resolve,
    fileFor,

    listPeople() {
      ensureDirs();
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        } catch { /* skip broken */ }
      }
      return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },

    // 追加一条印象（同一文本去重）；key 可以是任一身份
    addImpression(key, text, { displayName = '', platform = '', source = 'agent', kind = null, keepLatestOfKind = null, salience = null, supersedes = null } = {}) {
      const p = readOrCreate(key, { displayName, platform });
      const t = String(text || '').trim();
      if (!t) throw new Error('记忆内容不能为空');
      if (displayName && !p.displayName) p.displayName = displayName;
      if (platform && !p.platform) p.platform = platform;
      const k = kind === 'log' || kind === 'episode' ? kind : 'episode';
      const now = new Date().toISOString();
      // 事实更新：旧条目标 superseded 而不是删掉，保留来源与时间，随时可回滚。
      const supersedeList = Array.isArray(supersedes) ? supersedes : (supersedes ? [supersedes] : []);
      if (supersedeList.length) {
        for (const imp of p.impressions) {
          if (supersedeList.some((s) => {
            const q = String(s || '').trim();
            return q && (imp.text === q || similarity(imp.text, q) > 0.7);
          })) {
            imp.superseded = true;
            imp.supersededAt = now;
          }
        }
      }
      if (!p.impressions.some((x) => x.text === t)) {
        // 同一主题后来又被写了一次 → 这是最可靠的「被反复想起」信号，
        // 给相关旧条目加 mentions / salience，不靠猜模型有没有看过它。
        for (const imp of p.impressions) {
          if (imp.superseded || inferImpressionKind(imp) === 'log') continue;
          if (similarity(imp.text, t) >= 0.5) {
            imp.mentions = Number(imp.mentions || 0) + 1;
            imp.lastMentionedAt = now;
            imp.salience = Math.min(3, Number(imp.salience ?? baseSalience(imp.text, imp)) + 0.1);
          }
        }
        p.impressions.push({
          at: now, text: t.slice(0, 500), source, kind: k,
          // 注意：Number(null) === 0，不能用 Number.isFinite(Number(x)) 判断"有没有传"
          salience: (salience != null && Number.isFinite(Number(salience)))
            ? Number(salience) : baseSalience(t, { source, kind: k }),
          mentions: 0, lastMentionedAt: now
        });
      }
      // 滚动写入：同一类只保留最近 N 条。平台推送记录用它，避免「一天一条
      // 流水账」把 60 条容量和 12 条注入窗口占满，同时仍能被 memory_read 查到。
      const keepN = Number(keepLatestOfKind);
      if (Number.isFinite(keepN) && keepN > 0) {
        const idx = [];
        for (let i = p.impressions.length - 1; i >= 0; i--) {
          if (inferImpressionKind(p.impressions[i]) === k) idx.push(i);
        }
        if (idx.length > keepN) {
          const drop = new Set(idx.slice(keepN));
          p.impressions = p.impressions.filter((_, i) => !drop.has(i));
        }
      }
      if (p.impressions.length > MAX_IMPRESSIONS) p.impressions = p.impressions.slice(-MAX_IMPRESSIONS);
      return writePerson(p);
    },

    setDisplayName(key, displayName) {
      const p = readOrCreate(key);
      p.displayName = String(displayName || '').slice(0, 60);
      return writePerson(p);
    },

    // 把两个身份关联成同一个人：双方已有记忆则合并（印象并集，主 key 取 a）
    link(a, b, { displayName = '' } = {}) {
      const ka = String(a || '').trim();
      const kb = String(b || '').trim();
      if (!ka || !kb) throw new Error('需要两个身份 key');
      if (ka === kb) throw new Error('两个身份相同，无需关联');
      const pa = resolve(ka);
      const pb = resolve(kb);
      if (pa && pb && pa.key === pb.key) return pa; // 已关联
      const primary = pa ?? pb ?? { key: ka, platform: '', identity: ka.replace(/^(qq|group|bili)-/, ''), identities: [ka], displayName: '', impressions: [], createdAt: new Date().toISOString() };
      const other = pa && pb ? (primary === pa ? pb : pa) : null;
      const identities = [...new Set([ka, kb, ...(primary.identities || []), ...(other?.identities || [])])];
      const seen = new Set();
      const impressions = [];
      for (const imp of [...(other?.impressions ?? []), ...(primary.impressions ?? [])]) {
        if (!seen.has(imp.text)) { seen.add(imp.text); impressions.push(imp); }
      }
      primary.identities = identities;
      primary.impressions = impressions.slice(-MAX_IMPRESSIONS);
      if (displayName) primary.displayName = displayName;
      else if (!primary.displayName && other?.displayName) primary.displayName = other.displayName;
      if (!primary.platform && other?.platform) primary.platform = other.platform;
      const merged = writePerson(primary);
      // 另一方的独立文件（若存在且不是主文件）删除，避免双份
      if (other && other.key !== merged.key) removeFilesFor(other.key);
      log(`[memory] 已关联身份：${identities.join(' ↔ ')}`);
      return merged;
    },

    removeImpression(key, index) {
      const p = resolve(key);
      if (!p) throw new Error(`没有这个人的记忆：${key}`);
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= p.impressions.length) throw new Error(`印象序号无效（0~${p.impressions.length - 1}）`);
      const [removed] = p.impressions.splice(i, 1);
      writePerson(p);
      return { removed, person: p };
    },

    forgetPerson(key) {
      const p = resolve(key);
      const k = p ? p.key : String(key || '').trim();
      if (p) for (const id of p.identities || []) removeFilesFor(id);
      removeFilesFor(k);
      return p;
    },

    // 注入用：紧凑文本块（最近 N 条），无记忆返回 ''
    // max/chars 放宽过一次：默认 5 条 / 600 字符只能塞进最近几天的碎片，
    // 主人的长期背景（项目、习惯、雷点）会被挤掉，表现为“她记不住我是谁”。
    // 2026-11-06 再加一层：log 类（推送流水账）默认不注入，只保留日常/印象。
    // 默认取全量（MAX_IMPRESSIONS=60 条）。2026-11-06 实测三个人加起来才
    // 2462 字符，原来的 12 条/2000 字上限根本没被触发；放宽后当前数据下
    // 成本增量接近 0。chars 只是安全阀，防止 60 条 × 500 字把唤醒 prompt 撑爆。
    renderForPrompt(key, { max = MAX_IMPRESSIONS, chars = 6000, includeLog = false } = {}) {
      const p = resolve(key);
      if (!p || !p.impressions?.length) return '';
      const name = p.displayName || p.key;
      const ids = (p.identities?.length ?? 0) > 1 ? `（跨平台身份：${p.identities.join(' / ')}）` : '';
      const pool = p.impressions.filter((x) => !x.superseded && (includeLog || inferImpressionKind(x) !== 'log'));
      if (!pool.length) return '';
      const now = Date.now();
      // 按 salience + 近因 + 被重复提及次数挑，但输出仍按时间正序，保留叙事感。
      const scored = pool.map((x, i) => {
        const sal = Number.isFinite(Number(x.salience)) ? Number(x.salience) : baseSalience(x.text, x);
        const ageDays = Math.max(0, (now - (Date.parse(x.at) || now)) / 86400000);
        const recency = Math.max(0, 0.5 - ageDays / 60);
        const mentions = Math.min(2, Math.log2(1 + Number(x.mentions || 0)) * 0.3);
        return { x, i, score: sal + recency + mentions };
      });
      scored.sort((a, b) => b.score - a.score || b.i - a.i);
      const lines = scored.slice(0, max).sort((a, b) => a.i - b.i).map(({ x }) => `- ${x.text}`);
      let block = `【记忆·关于${name}】${ids}（你对这个人的长期印象与互动史，供参考，不必复述）\n${lines.join('\n')}`;
      if (block.length > chars) block = block.slice(0, chars) + '…';
      return block;
    },

    // 跨聊天记忆：在其他会话（尤其群聊 group-*）的印象里，提到 name 的条目
    relatedFor(name, { max = 5, chars = 900 } = {}) {
      const kw = String(name || '').trim();
      if (!kw || kw.length < 2) return '';
      const hits = [];
      for (const p of this.listPeople()) {
        if (!p.key.startsWith('group-')) continue;
        if (p.key === kw || p.identities?.includes(kw)) continue;
        for (const imp of p.impressions ?? []) {
          if ((imp.text || '').includes(kw)) hits.push({ group: p.displayName || p.key, text: imp.text });
        }
      }
      if (!hits.length) return '';
      const lines = hits.slice(-max).map((x) => `- （${x.group}）${x.text}`);
      let block = `【群聊里关于${kw}的记录】（她在别的聊天里见过/提到过，供参考）\n${lines.join('\n')}`;
      if (block.length > chars) block = block.slice(0, chars) + '…';
      return block;
    },

    // 按关键词搜（B站值班回复前查用）
    search(keyword) {
      ensureDirs();
      const kw = String(keyword || '').trim().toLowerCase();
      if (!kw) return [];
      const hits = [];
      for (const p of this.listPeople()) {
        const hay = JSON.stringify(p).toLowerCase();
        if (hay.includes(kw)) hits.push(p);
      }
      return hits;
    }
  };
}
