// ============================================================
// bili-draft.js —— B站动态「先审后发」草稿服务（bloom-hub）
// ------------------------------------------------------------
// 流程：
//   1. 她（AI）调 MCP 工具 bili_draft_submit 提交文案 +（可选）配图
//   2. 本服务做安全过滤 → 存 state/bili-draft.json → 把草稿推到主人 QQ
//   3. 主人在 QQ 里回「发」/「不发」/「重写」，桥接拦截后调 approve/reject
//   4. approve 走 tools/bili_cli.py send-dynamic 真正发布
//
// 设计取舍：
//   · 一天只允许一条 pending，避免刷屏，也避免多条草稿混淆审批
//   · pending 超过 12 小时自动作废，防止「第二天随口一个『好』」被当成批准
//   · 审批词要求明确（发/发布/过/通过），不接受「好」「嗯」这类模糊回应
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TEXT = 1000;          // B站普通动态正文上限；超了不静默截断，直接退回让她自己改
const MAX_IMAGES = 9;           // B站单条动态最多 9 图
const PENDING_TTL_MS = 12 * 3600 * 1000;

// 发布前的硬拦：这些内容一旦出去就收不回来
const BLOCK_PATTERNS = [
  { re: /1[3-9]\d{9}/, why: '手机号' },
  { re: /\b\d{17}[\dXx]\b/, why: '身份证号' },
  { re: /\b\d{6,12}\b(?=.{0,6}(?:qq|QQ|企鹅|扣扣))/, why: '疑似 QQ 号' },
  { re: /@所有人|@全体成员/, why: '@所有人' },
  { re: /(?:省|市)[^，。\n]{0,10}(?:区|县)[^，。\n]{0,16}(?:路|街|道|号)/, why: '具体住址' },
];

export function createBiliDraft({ root, log, qqSocial, runBiliCli, ownerQQ, deleteImages }) {
  const file = path.join(root, 'state', 'bili-draft.json');

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { current: j.current ?? null, history: Array.isArray(j.history) ? j.history : [] };
    } catch {
      return { current: null, history: [] };
    }
  }

  function save(d) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 超时未处理的草稿自动作废（读取时惰性判断，不依赖定时器） */
  function expireIfStale(d) {
    const cur = d.current;
    if (cur && cur.status === 'pending' && Date.now() - cur.createdAt > PENDING_TTL_MS) {
      cur.status = 'expired';
      cur.closedAt = Date.now();
      d.history.unshift(cur);
      d.history = d.history.slice(0, 30);
      d.current = null;
      save(d);
      log('[bili-draft] 待审草稿超过 12 小时，已自动作废');
      return true;
    }
    return false;
  }

  function sanitize(text) {
    let t = String(text ?? '').trim();
    if (!t) throw new Error('动态内容不能为空');
    for (const p of BLOCK_PATTERNS) {
      if (p.re.test(t)) throw new Error(`内容里出现${p.why}，已拦下；请改写成不含具体隐私的表述`);
    }
    // 不再静默截断：她写多少就是多少，超了 B站上限就退回去让她自己删
    if (t.length > MAX_TEXT) {
      throw new Error(
        `正文 ${t.length} 字，超过 B站单条动态上限 ${MAX_TEXT} 字。` +
        `删掉 ${t.length - MAX_TEXT} 字再提交，或者拆成两条发。`
      );
    }
    return t;
  }

  /** 配图只允许我们自己生成的图，杜绝把真人照片误发出去。支持多张。 */
  function normalizeImages(images) {
    const raw = Array.isArray(images) ? images : (images ? [images] : []);
    const out = [];
    for (const item of raw) {
      const s = String(item ?? '').trim();
      if (!s) continue;
      if (/^https?:\/\//i.test(s)) { out.push(s); continue; } // 远程图交给 bili_cli 的 URL 分支
      const abs = path.resolve(s);
      const allow = [path.join(root, 'pictures'), path.join(root, 'state', 'comfy-out')];
      if (!allow.some((d) => abs.startsWith(d + path.sep))) {
        throw new Error('配图只允许 bloom-hub 的 pictures/ 或 state/comfy-out/ 下的文件（避免误发真人照片）');
      }
      if (!fs.existsSync(abs)) throw new Error(`配图不存在：${abs}`);
      if (!out.includes(abs)) out.push(abs);
    }
    if (out.length > MAX_IMAGES) throw new Error(`一条动态最多 ${MAX_IMAGES} 张配图（现在 ${out.length} 张）`);
    return out;
  }

  async function pushForReview(draft) {
    const imgs = draft.images || [];
    for (const img of imgs) {
      try {
        await qqSocial.sendPrivateImage(ownerQQ, img);
      } catch (e) {
        log(`[bili-draft] 审核配图发送失败：${e.message}`);
      }
    }
    const lines = ['【B站动态 · 等你审核】', '────────────', draft.text, '────────────'];
    lines.push(imgs.length ? `配图：${imgs.length} 张（上面${imgs.length > 1 ? '几' : '那'}张）` : '配图：无');
    lines.push('', '回「发」→ 直接发到 B站', '回「不发」→ 作废', '回「重写」→ 让她重新写一版');
    await qqSocial.sendPrivateMessage(ownerQQ, lines.join('\n'));
  }

  /** 她提交草稿 */
  async function submit({ text, image, images, source = 'agent' } = {}) {
    const d = load();
    expireIfStale(d);
    if (d.current && d.current.status === 'pending') {
      throw new Error('已有一条待审草稿，先处理它（回「发」或「不发」）再来新的');
    }
    // 兼容旧的单图入参 image + 新的多图入参 images
    const pics = normalizeImages(images ?? image);
    const draft = {
      id: crypto.randomBytes(4).toString('hex'),
      text: sanitize(text),
      images: pics,
      image: pics[0] || null, // 兼容字段
      source,
      status: 'pending',
      createdAt: Date.now(),
    };
    d.current = draft;
    save(d);
    await pushForReview(draft);
    log(`[bili-draft] 新草稿 ${draft.id} 已推送审核（${draft.text.length} 字${pics.length ? ` + ${pics.length} 图` : ''}）`);
    return draft;
  }

  /** 主人批准 → 真发 */
  async function approve() {
    const d = load();
    expireIfStale(d);
    const draft = d.current;
    if (!draft || draft.status !== 'pending') throw new Error('当前没有待审草稿（可能已过期或已处理）');

    const pics = draft.images || (draft.image ? [draft.image] : []);
    const args = ['send-dynamic', '--text', draft.text];
    for (const p of pics) args.push('--image', p);
    const r = await runBiliCli(args);
    if (!r.ok) {
      draft.status = 'failed';
      draft.error = String(r.error || '发布失败');
      save(d);
      throw new Error(draft.error);
    }
    draft.status = 'published';
    draft.publishedAt = Date.now();
    // bili_cli 的返回是 {ok, result:{success, dyn_id, ...}}，早期只读 r.dyn_id / r.data.dyn_id，
    // 导致 4 条 published 的 dynId 全是 null（发出去了但查不到、也撤不回）。
    // 现在按形状逐层取，取不到就显式标记，别再静默丢。
    draft.dynId = r?.result?.dyn_id ?? r?.dyn_id ?? r?.data?.dyn_id ?? null;
    if (!draft.dynId) {
      draft.dynIdMissing = true;
      log(`[bili-draft] 草稿 ${draft.id} 已发布但未拿到 dyn_id（回执形状：${Object.keys(r?.result || r || {}).join(',')}）`);
    }
    // 发完就删：只删我们自己按日归档的图，不动 pictures/ 根目录的参考图。
    // 必须走 deleteImages 回调，让 index.json 也打上【已删】标记 ——
    // 早期直接 rmSync 会留下「索引说还在、文件已没了」的不一致记录。
    const dailyDir = path.join(root, 'pictures', 'daily');
    const byDate = new Map();
    for (const p of pics) {
      const sp = String(p);
      if (!sp.startsWith(dailyDir + path.sep)) continue;
      const date = path.basename(path.dirname(sp));
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(path.basename(sp));
    }
    let removed = 0;
    for (const [date, files] of byDate) {
      if (typeof deleteImages === 'function') {
        try { removed += deleteImages(date, files).length; } catch (e) { log(`[bili-draft] 清理归档失败（${date}）：${e.message}`); }
      } else {
        for (const f of files) {
          try { fs.rmSync(path.join(dailyDir, date, f), { force: true }); removed += 1; } catch { /* ignore */ }
        }
      }
    }
    d.history.unshift(draft);
    d.history = d.history.slice(0, 30);
    d.current = null;
    save(d);
    log(`[bili-draft] 草稿 ${draft.id} 已发布到 B站（${pics.length} 图，清理 ${removed} 张归档）`);
    try {
      await qqSocial.sendPrivateMessage(
        ownerQQ,
        `已发到 B站 ✓${draft.dynId ? `\n动态 id：${draft.dynId}` : ''}`
      );
    } catch { /* 回执失败不影响发布结果 */ }
    return draft;
  }

  /** 主人否决 */
  async function reject(reason = '') {
    const d = load();
    expireIfStale(d);
    const draft = d.current;
    if (!draft || draft.status !== 'pending') throw new Error('当前没有待审草稿');
    draft.status = 'rejected';
    draft.reason = String(reason || '').slice(0, 200);
    draft.closedAt = Date.now();
    d.history.unshift(draft);
    d.history = d.history.slice(0, 30);
    d.current = null;
    save(d);
    log(`[bili-draft] 草稿 ${draft.id} 已作废${reason ? `（${reason}）` : ''}`);
    try {
      await qqSocial.sendPrivateMessage(ownerQQ, '好，这条不发了。');
    } catch { /* ignore */ }
    return draft;
  }

  /** 当前待审草稿（给桥接判断用，不做推送） */
  function pending() {
    const d = load();
    if (expireIfStale(d)) return null;
    return d.current && d.current.status === 'pending' ? d.current : null;
  }

  function history() {
    return load().history.slice(0, 10);
  }

  return { submit, approve, reject, pending, history };
}
