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

export function createMemoryStore({ root, backupPath, log = () => {} }) {
  const dir = path.join(root, 'memory', 'people');
  const backupPeople = path.join(backupPath, 'people');
  const backupSnapshots = path.join(backupPath, 'snapshots');

  function ensureDirs() {
    for (const d of [dir, backupPeople, backupSnapshots]) fs.mkdirSync(d, { recursive: true });
  }

  function fileFor(key) {
    const safe = String(key).replace(/[^\w.-]+/g, '_');
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
    fs.writeFileSync(file, JSON.stringify(person, null, 2), 'utf8');
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
    addImpression(key, text, { displayName = '', platform = '', source = 'agent' } = {}) {
      const p = readOrCreate(key, { displayName, platform });
      const t = String(text || '').trim();
      if (!t) throw new Error('记忆内容不能为空');
      if (displayName && !p.displayName) p.displayName = displayName;
      if (platform && !p.platform) p.platform = platform;
      if (!p.impressions.some((x) => x.text === t)) {
        p.impressions.push({ at: new Date().toISOString(), text: t.slice(0, 500), source });
        if (p.impressions.length > MAX_IMPRESSIONS) p.impressions = p.impressions.slice(-MAX_IMPRESSIONS);
      }
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
    renderForPrompt(key, { max = 5, chars = 600 } = {}) {
      const p = resolve(key);
      if (!p || !p.impressions?.length) return '';
      const name = p.displayName || p.key;
      const ids = (p.identities?.length ?? 0) > 1 ? `；跨平台身份：${p.identities.join(' / ')}` : '';
      const lines = p.impressions.slice(-max).map((x) => `- ${x.text}`);
      let block = `【记忆·关于${name}】${ids}（你对这个人的长期印象与互动史，供参考，不必复述）\n${lines.join('\n')}`;
      if (block.length > chars) block = block.slice(0, chars) + '…';
      return block;
    },

    // 跨聊天记忆：在其他会话（尤其群聊 group-*）的印象里，提到 name 的条目
    relatedFor(name, { max = 3, chars = 450 } = {}) {
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
