// ============================================================
// push-service.js —— 谷时间日报推送（bloom-hub）
// ------------------------------------------------------------
// 职责：盯 duty/out/<YYYY-MM-DD>.md 日报 → 生成人格口吻摘要 →
//       谷时窗口内私聊推给 pushTargetQQ；峰时产生的日报等到下一个
//       谷时窗口补发（catchUp）。峰谷与否不影响 QQ 收消息回复——
//       那是 core 桥接的常驻职责，与本服务互不阻塞。
// 推送记录：state/push-history.json（管理平台「推送」页展示）。
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { valleyStatus } from './scheduler.js';
import { renderPushText } from './persona.js';
import { createMemoryStore } from './memory.js';

const REPORT_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

// ---------- 日报摘要解析 ----------
export function parseReportDigest(md, maxItems = 5) {
  const text = String(md || '');
  const dateM = /^#\s*刷B站日报\s*·\s*(\d{4}-\d{2}-\d{2})/m.exec(text);
  const date = dateM ? dateM[1] : '';
  const items = [];
  const sectionRe = /^##\s+(\d+)\.\s+(.+)$/gm;
  let m;
  while ((m = sectionRe.exec(text)) && items.length < maxItems) {
    const start = m.index + m[0].length;
    const next = text.indexOf('\n## ', start);
    const body = text.slice(start, next === -1 ? undefined : next);
    const linkM = /\*\*链接\*\*：(\S+)/.exec(body);
    items.push({ title: m[2].trim(), link: linkM ? linkM[1] : '' });
  }
  // 评论统计：形如「- **评论**：`BV…` 发了 N 条」
  let commented = 0;
  const cmRe = /-\s*\*\*评论\*\*：.*?发了\s*(\d+)\s*条/g;
  let cm;
  while ((cm = cmRe.exec(text))) commented += Number(cm[1]);
  return { date, items, commented, itemCount: items.length };
}

// ---------- 服务 ----------
export function createPushService({ root, suite, personaRef, qqSocial, log }) {
  const outDir = path.join(root, suite.paths?.duty || 'bili-duty', 'out');
  const stateFile = path.join(root, 'state', 'push-history.json');
  // 记忆库：推送成功后把「这轮给主人推了什么」写成跨平台记忆（代码保底，不依赖值班轮自觉）
  const memoryStore = createMemoryStore({
    root,
    backupPath: 'D:\\.qingniao-backup\\memory',
    log
  });
  const ownerBiliKey = `bili-${suite.identity?.biliMentionName || '使用者B站名'}`;

  const state = loadState();
  let pendingTimer = null;
  let watchTimer = null;
  let debounceTimer = null;

  function loadState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return { pushed: {}, queue: [], history: [] };
    }
  }
  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      log(`推送状态写盘失败：${e.message}`);
    }
  }
  function addHistory(entry) {
    state.history.unshift({ at: new Date().toISOString(), ...entry });
    state.history = state.history.slice(0, 200);
    saveState();
  }

  function listReports() {
    try {
      return fs.readdirSync(outDir).filter((f) => REPORT_RE.test(f)).map((f) => f.replace(/\.md$/, '')).sort().reverse();
    } catch {
      return [];
    }
  }

  function readReport(date) {
    const name = String(date || '').replace(/\.md$/, '');
    if (!REPORT_RE.test(`${name}.md`)) return null;
    const file = path.join(outDir, `${name}.md`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  }

  function isPushed(date) {
    return !!state.pushed[date];
  }

  // ---------- 发送 ----------
  function splitMessage(text, maxChars) {
    if (text.length <= maxChars) return [text];
    const lines = text.split('\n');
    const parts = [];
    let cur = '';
    for (const line of lines) {
      if ((cur + '\n' + line).length > maxChars && cur) {
        parts.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + '\n' + line : line;
      }
      while (cur.length > maxChars) {
        parts.push(cur.slice(0, maxChars));
        cur = cur.slice(maxChars);
      }
    }
    if (cur) parts.push(cur);
    return parts;
  }

  async function sendDigest(date, { silent = false } = {}) {
    const md = readReport(date);
    if (!md) throw new Error(`日报不存在：${date}`);
    const digest = parseReportDigest(md, suite.push?.itemsInDigest ?? 5);
    const target = suite.identity?.pushTargetQQ;
    if (!target) throw new Error('未配置 pushTargetQQ');

    const text = renderPushText(personaRef.current, {
      date,
      shortDate: date.slice(5),
      count: silent ? 0 : digest.itemCount,
      items: digest.items,
      commented: digest.commented,
      silent
    });

    const maxChars = suite.push?.maxChars ?? 2800;
    const parts = splitMessage(text, maxChars);
    const results = [];
    for (const p of parts) {
      const r = await qqSocial.sendPrivateMessage(target, p);
      results.push(r?.retcode ?? 'ok');
    }
    state.pushed[date] = { at: new Date().toISOString(), target, silent, parts: parts.length };
    addHistory({ kind: silent ? 'silent-push' : 'push', date, target, parts: parts.length, ok: true });
    saveState();
    log(`日报 ${date} 已推送给 ${target}（${parts.length} 段${silent ? '，空轮播报' : ''}）`);
    // 跨平台记忆：QQ 侧的她要能答上「今天B站给我推了啥」
    try {
      const digestText = silent
        ? `（B站值班 ${date}）这轮没挑出值得推的视频，只发了空轮播报`
        : `（B站值班 ${date}）给他推了日报：${digest.items.map((it) => `《${it.title}》`).join('、')}；评论区已 @他 ${digest.commented} 条`;
      memoryStore.addImpression(ownerBiliKey, digestText, { displayName: suite.identity?.biliMentionName || '使用者B站名', platform: 'bili', source: 'platform' });
    } catch (e) {
      log(`推送记忆写入失败（不影响推送）：${e.message}`);
    }
    return { date, parts: parts.length, silent };
  }

  // ---------- 谷时闸门 ----------
  function tryDispatch(date) {
    const onlyInValley = suite.push?.onlyInValley !== false;
    const st = valleyStatus(suite.valley?.windows);
    if (onlyInValley && !st.inValley) {
      scheduleAtNextValley(date);
      return false;
    }
    sendDigest(date).catch((e) => {
      log(`推送失败（${date}）：${e.message}；已入队列待补发`);
      addHistory({ kind: 'push-failed', date, error: String(e.message || e) });
      enqueue(date);
    });
    return true;
  }

  function scheduleAtNextValley(date) {
    const st = valleyStatus(suite.valley?.windows);
    const wait = st.nextWindowStartAt ? Math.max(1000, new Date(st.nextWindowStartAt).getTime() - Date.now()) : 30 * 60 * 1000;
    enqueue(date);
    log(`当前非谷时，日报 ${date} 将在 ${st.nextWindowStartAt || '下个窗口'} 补发（${Math.round(wait / 60000)} 分钟后）`);
    armNextValleyTimer();
  }

  function enqueue(date) {
    if (!state.queue.includes(date)) {
      state.queue.push(date);
      saveState();
    }
  }

  function armNextValleyTimer() {
    if (pendingTimer) clearTimeout(pendingTimer);
    if (!state.queue.length) return;
    const st = valleyStatus(suite.valley?.windows);
    if (st.inValley) {
      dispatchQueue();
      return;
    }
    const wait = st.nextWindowStartAt ? Math.min(Math.max(1000, new Date(st.nextWindowStartAt).getTime() - Date.now()), 6 * 3600 * 1000) : 30 * 60 * 1000;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      dispatchQueue();
    }, wait + 2000);
    if (pendingTimer.unref) pendingTimer.unref();
  }

  function dispatchQueue() {
    if (!state.queue.length) return;
    const st = valleyStatus(suite.valley?.windows);
    if (suite.push?.onlyInValley !== false && !st.inValley) {
      armNextValleyTimer();
      return;
    }
    // 只补发最新一份，其余标记为跳过（避免刷屏）
    const sorted = [...state.queue].sort();
    const latest = sorted[sorted.length - 1];
    state.queue = state.queue.filter((d) => d === latest);
    for (const d of sorted) {
      if (d !== latest && !isPushed(d)) {
        addHistory({ kind: 'skipped-stale', date: d });
      }
    }
    saveState();
    sendDigest(latest).catch((e) => {
      log(`补发失败（${latest}）：${e.message}`);
      addHistory({ kind: 'push-failed', date: latest, error: String(e.message || e) });
      enqueue(latest);
      armNextValleyTimer();
    });
  }

  // ---------- 文件监听 ----------
  function handleOutDirChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const reports = listReports();
      const latest = reports[0];
      if (!latest) return;
      if (isPushed(latest)) return; // 当日已推过；文件更新不重复推送
      try {
        const md = readReport(latest);
        if (!md || md.trim().length < 80) return; // 还没写完
        log(`发现新日报：${latest}，准备推送`);
        tryDispatch(latest);
      } catch { /* 半写状态，等下次 */ }
    }, 90 * 1000); // 防抖：日报往往一轮内多次写入，等 90 秒静默再推
  }

  function startWatcher() {
    try {
      fs.watch(outDir, { persistent: false }, handleOutDirChange);
    } catch (e) {
      log(`日报目录监听失败（改用轮询）：${e.message}`);
    }
    watchTimer = setInterval(() => {
      const reports = listReports();
      const latest = reports[0];
      if (latest && !isPushed(latest)) {
        try {
          const md = readReport(latest);
          if (md && md.trim().length >= 80) handleOutDirChange();
        } catch { /* ignore */ }
      }
    }, 10 * 60 * 1000);
    if (watchTimer.unref) watchTimer.unref();
  }

  // ---------- 启动补查 ----------
  function catchUp() {
    if (suite.push?.catchUp === false) return;
    const reports = listReports().slice(0, 3); // 只看最近 3 天
    const unpushed = reports.filter((d) => !isPushed(d));
    if (!unpushed.length) return;
    const latest = unpushed[0];
    if (unpushed.length > 1) {
      for (const d of unpushed.slice(1)) addHistory({ kind: 'skipped-stale', date: d });
      saveState();
    }
    log(`启动补查：发现未推送日报 ${latest}，按谷时规则处理`);
    tryDispatch(latest);
  }

  function start() {
    startWatcher();
    catchUp();
    armNextValleyTimer();
    log(`推送服务就绪：目标 ${suite.identity?.pushTargetQQ}，${suite.push?.onlyInValley !== false ? '仅谷时推送' : '不限时段'}`);
  }

  function stop() {
    if (pendingTimer) clearTimeout(pendingTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
  }

  // ---------- 管理平台 API ----------
  async function pushNow(date) {
    const d = date || listReports()[0];
    if (!d) throw new Error('没有可推送的日报');
    const r = await sendDigest(d);
    state.queue = state.queue.filter((x) => x !== d);
    saveState();
    return r;
  }

  function status() {
    const st = valleyStatus(suite.valley?.windows);
    return {
      enabled: suite.push?.enabled !== false,
      onlyInValley: suite.push?.onlyInValley !== false,
      inValley: st.inValley,
      window: st.window,
      nextWindowStartAt: st.nextWindowStartAt,
      target: suite.identity?.pushTargetQQ ?? null,
      queue: [...state.queue].sort(),
      pushed: state.pushed,
      history: state.history.slice(0, 50),
      reports: listReports().slice(0, 14)
    };
  }

  return { start, stop, status, pushNow, parseReportDigest, listReports, readReport };
}
