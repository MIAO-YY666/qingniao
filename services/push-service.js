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
import { SENSITIVE_RE } from '../qq-bridge/src/sensitive.js';

const REPORT_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

// 推送出口脱敏闸（2026-11-08）：值班日报（含她手写的「给他的QQ」段）此前原文直达
// 主人 QQ，值班轮若被评论区提示注入，写进日报的本机路径/凭据会一路漏出去。
// 命中不拦截（日报是消费内容，拦了主人就什么都看不到），替换为「[已脱敏]」并记日志。
const SENSITIVE_GLOBAL = new RegExp(SENSITIVE_RE.source, 'gi');
function redactPushText(text, log) {
  const s = String(text || '');
  const hits = s.match(SENSITIVE_GLOBAL);
  if (!hits?.length) return s;
  log(`⚠️ 推送文案命中敏感信息 ${hits.length} 处，已替换为 [已脱敏]（内容不落日志）`);
  return s.replace(SENSITIVE_GLOBAL, '[已脱敏]');
}

// ---------- 日报摘要解析 ----------
export function parseReportDigest(md, maxItems = 5) {
  const text = String(md || '');
  // 日期：标题行的第一个 YYYY-MM-DD（标题文案几经演变：「刷B站日报 · x」「B站值班 · x」「x」）
  const dateM = /^#\s.*?(\d{4}-\d{2}-\d{2})/m.exec(text) || /^\s*(\d{4}-\d{2}-\d{2})/m.exec(text);
  const date = dateM ? dateM[1] : '';
  const items = [];
  // v2 段式（2026-10-25 起）：「### BV号」段，标题/链接/我的一句在段内列表行里
  const v2Re = /^###\s+(BV[0-9A-Za-z]+)\s*$/gm;
  let m;
  while ((m = v2Re.exec(text)) && items.length < maxItems) {
    const start = m.index + m[0].length;
    const next = text.indexOf('\n### ', start);
    const body = text.slice(start, next === -1 ? undefined : next);
    const titleM = /(?:^|\n)\s*(?:-\s*)?\*{0,2}标题\*{0,2}[：:]\s*(.+)/.exec(body);
    const linkM = /(?:^|\n)\s*(?:-\s*)?\*{0,2}链接\*{0,2}[：:]\s*(\S+)/.exec(body);
    const noteM = /(?:^|\n)\s*(?:-\s*)?我自己一句[：:]\s*(.+)/.exec(body);
    items.push({
      bv: m[1],
      title: titleM ? titleM[1].trim() : m[1],
      link: linkM ? linkM[1].trim() : `https://www.bilibili.com/video/${m[1]}`,
      note: noteM ? noteM[1].trim() : ''
    });
  }
  // v1 兼容（2026-10-24 前）：「## 1. 标题」+「**链接**：…」
  if (!items.length) {
    const sectionRe = /^##\s+(\d+)\.\s+(.+)$/gm;
    while ((m = sectionRe.exec(text)) && items.length < maxItems) {
      const start = m.index + m[0].length;
      const next = text.indexOf('\n## ', start);
      const body = text.slice(start, next === -1 ? undefined : next);
      const linkM = /\*\*链接\*\*：(\S+)/.exec(body);
      items.push({ title: m[2].trim(), link: linkM ? linkM[1] : '', note: '' });
    }
  }
  // 评论统计：形如「- **评论**：`BV…` 发了 N 条」
  let commented = 0;
  const cmRe = /-\s*\*\*评论\*\*：.*?发了\s*(\d+)\s*条/g;
  let cm;
  while ((cm = cmRe.exec(text))) commented += Number(cm[1]);
  // 她亲手写的推送语（v3 章程要求日报末尾写「## 给他的QQ」段，人设口吻的自然话）。
  // 取段内原文，空轮也会写（一句话说明这轮没捞着）。找不到就回退模板渲染。
  let qqNote = '';
  const qqRe = /^##\s*(给他的QQ|QQ推送语)[^\n]*$/gm.exec(text);
  if (qqRe) {
    const start = qqRe.index + qqRe[0].length;
    const next = text.indexOf('\n## ', start);
    qqNote = text.slice(start, next === -1 ? undefined : next).trim();
  }
  return { date, items, commented, itemCount: items.length, qqNote };
}

// ---------- 服务 ----------
export function createPushService({ root, suite, personaRef, qqSocial, log, recordPlatformMessage, generatePushText }) {
  const outDir = path.join(root, suite.paths?.duty || 'bili-duty', 'out');
  const stateFile = path.join(root, 'state', 'push-history.json');
  // 记忆库：推送成功后把「这轮给主人推了什么」写成跨平台记忆（代码保底，不依赖值班轮自觉）
  const memoryStore = createMemoryStore({
    root,
    // 可配置，便于在临时目录里跑回归测试而不污染项目外的真实备份目录。
    backupPath: suite.paths?.memoryBackup || path.join(os.homedir(), '.qingniao-backup', 'memory'),
    log
  });
  const ownerBiliKey = `bili-${suite.identity?.biliMentionName || '你的B站昵称'}`;

  const state = loadState();
  let pendingTimer = null;
  let watchTimer = null;
  let debounceTimer = null;
  // 失败重试：必须带退避且防重入。原实现失败后直接 armNextValleyTimer()，
  // 谷时内它会同步再调 dispatchQueue()，形成 1 秒 198 次的 fetch failed 风暴。
  let retryTimer = null;
  let retryAttempt = 0;
  let watcher = null;

  function loadState() {
    try {
      const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!loaded || typeof loaded !== 'object') throw new Error('bad state');
      loaded.pushed = loaded.pushed && typeof loaded.pushed === 'object' ? loaded.pushed : {};
      loaded.history = Array.isArray(loaded.history) ? loaded.history : [];
      // 启动时就丢掉「其实早推成功、却还赖在 queue 里」的僵尸日期。
      // 这类残留会让每次启动补查/谷时把几天前的旧日报再推一遍。
      loaded.queue = (Array.isArray(loaded.queue) ? loaded.queue : []).filter((d) => !loaded.pushed[d]);
      return loaded;
    } catch {
      return { pushed: {}, queue: [], history: [] };
    }
  }
  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      log(`推送状态写盘失败：${e.message}`);
    }
  }
  function addHistory(entry) {
    // 连续同类失败只累加第一条的 count，不再把 200 条历史槽位一次冲光
    // （2026-11-05 23:26 一秒内刷了 197 条 push-failed，真实推送记录全被挤掉）。
    if (String(entry.kind).includes('failed')) {
      const prev = state.history[0];
      const sig = (x) => `${x?.kind ?? ''}|${x?.date ?? ''}|${x?.error ?? ''}`;
      if (prev && sig(prev) === sig(entry) && Date.now() - Date.parse(prev.at) < 5 * 60 * 1000) {
        prev.count = (prev.count || 1) + 1;
        prev.lastAt = new Date().toISOString();
        if (prev.count % 25 === 0) saveState();
        return;
      }
    }
    state.history.unshift({ at: new Date().toISOString(), count: 1, ...entry });
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

    // 文案优先级：她亲手写的「给他的QQ」段（值班时按人设写好的自然话）>
    // persona 模板渲染（兜底）。选她的文案时，条目清单（标题+链接+我的一句）
    // 仍由这里拼在后面——硬信息（链接）不该指望她手抄。
    const listLines = digest.items.map((it, idx) => {
      const note = it.note ? `（${it.note}）` : '';
      return `${idx + 1}. ${it.title}${note}\n   ${it.link || ''}`.trimEnd();
    });
    // 文案优先级（2026-11-06）：
    //   ① 值班轮自己写好的「## 给他的QQ」段 —— 零额外 LLM 请求，最优先；
    //   ② 没写时把日报摘要发给桥接，由她按人设生成开场白；
    //   ③ 桥接不可用/超时/生成过短 → persona 模板兜底，绝不阻断推送。
    let intro = '';
    let introSource = 'template';
    if (digest.qqNote && digest.qqNote.length >= 10) {
      intro = digest.qqNote;
      introSource = 'duty-note';
    } else if (!silent && typeof generatePushText === 'function') {
      try {
        const generated = await generatePushText({ date, items: digest.items, commented: digest.commented, qqNote: '' });
        const clean = String(generated ?? '').trim();
        if (clean.length >= 10) {
          intro = clean.slice(0, 600);
          introSource = 'bridge';
        }
      } catch (e) {
        log(`桥接生成推送文案失败，改用模板：${e.message}`);
      }
    }
    let text;
    if (intro && listLines.length) text = `${intro}\n\n${listLines.join('\n')}`;
    else if (intro) text = intro;
    else {
      text = renderPushText(personaRef.current, {
        date,
        shortDate: date.slice(5),
        count: silent ? 0 : digest.itemCount,
        items: digest.items,
        commented: digest.commented,
        silent
      });
    }

    // 出口脱敏：无论文案来自她手写、桥接生成还是模板兜底，统一过一遍（命中见日志）
    text = redactPushText(text, log);

    const maxChars = suite.push?.maxChars ?? 2800;
    const parts = splitMessage(text, maxChars);
    const results = [];
    for (const p of parts) {
      const r = await qqSocial.sendPrivateMessage(target, p);
      results.push(r?.retcode ?? 'ok');
    }
    state.pushed[date] = { at: new Date().toISOString(), target, silent, parts: parts.length, introSource };
    // 推送成功后必须出队，否则谷时定时器 / 每次启动补查都会把同一份旧日报再推一遍
    // （2026-11-02 就是这样被反复推到 11-06 的）。
    state.queue = state.queue.filter((d) => !isPushed(d));
    retryAttempt = 0;
    addHistory({ kind: silent ? 'silent-push' : 'push', date, target, parts: parts.length, introSource, ok: true });
    saveState();
    log(`日报 ${date} 已推送给 ${target}（${parts.length} 段${silent ? '，空轮播报' : ''}，文案来源 ${introSource}）`);
    // 跨平台记忆：QQ 侧的她要能答上「今天B站给我推了啥」。
    // 只写 bili-<昵称> 是不够的——QQ 私聊 memoryBlockFor 读的是 qq-<QQ号>，
    // 两个 key 不同，所以以前她完全不知道自己推过。两边都写一份。
    // 只在「真的有内容」时写：空轮播报零信息，天天写会把记忆注入窗口挤满。
    try {
      const hasItems = Array.isArray(digest.items) && digest.items.length > 0;
      if (!silent && hasItems) {
        const titles = digest.items.map((it) => `《${it.title}》`).join('、');
        const digestText = `【平台代发·最近一次】B站值班 ${date} 的日报已在 QQ 私聊推给主人：${titles}；评论区 @他 ${digest.commented} 条。这是用我口吻写的日报推送，不是别人发来的消息；被问到「刚才推了啥」时照此回答。`;
        // 推送流水账按 kind=log 滚动保留最近 1 条，且默认不进唤醒 prompt。
        // 她「知道自己推过」主要靠桥接回灌的 isSelf 消息；这里只留一个可查的兜底，
        // 不再一天一条把 12 条注入窗口和真正的人际印象挤掉。
        const impressionOpts = { source: 'platform', kind: 'log', keepLatestOfKind: 1 };
        memoryStore.addImpression(`qq-${target}`, digestText, { displayName: suite.identity?.biliMentionName || '主人', platform: 'qq', ...impressionOpts });
        memoryStore.addImpression(ownerBiliKey, digestText, { displayName: suite.identity?.biliMentionName || '你的B站昵称', platform: 'bili', ...impressionOpts });
      }
    } catch (e) {
      log(`推送记忆写入失败（不影响推送）：${e.message}`);
    }
    // 回灌到 QQ 会话消息流：让她的 recentMessages 里真的有「我」发过这条，
    // 而不是一条凭空出现在 QQ 里、自己却毫无记录的消息。失败不影响推送本身。
    if (typeof recordPlatformMessage === 'function') {
      Promise.resolve()
        .then(() => recordPlatformMessage({ target, date, text: parts.join('\n'), silent }))
        .catch((e) => log(`推送回灌会话流失败（不影响推送）：${e.message}`));
    }
    return { date, parts: parts.length, silent };
  }

  // ---------- 谷时闸门 ----------
  let dispatching = false;

  /** 失败退避重试：指数退避 + 全局只允许一条重试链。
   *  原实现失败后直接 armNextValleyTimer()，谷时内它同步再调 dispatchQueue()，
   *  于是 1 秒内打了 198 次 send_private_msg，全部 fetch failed。 */
  function scheduleRetry(reason) {
    if (retryTimer) return;
    retryAttempt += 1;
    const delay = Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** Math.min(retryAttempt - 1, 4));
    log(`推送失败（${reason}），${Math.round(delay / 1000)}s 后重试（第 ${retryAttempt} 次）`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      dispatchQueue();
    }, delay);
    if (retryTimer.unref) retryTimer.unref();
  }

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
      scheduleRetry(e.message);
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
    if (dispatching) return;
    // 老状态里 queue 可能残留「其实已经推成功」的日期，先把它们清掉，
    // 否则每次启动补查 / 谷时都会把几天前的旧日报又推一遍。
    const before = state.queue.length;
    state.queue = state.queue.filter((d) => !isPushed(d));
    if (state.queue.length !== before) saveState();
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
    dispatching = true;
    // sendDigest 成功时自己会出队；这里只处理失败：入队 + 退避重试，绝不同步递归。
    sendDigest(latest)
      .catch((e) => {
        log(`补发失败（${latest}）：${e.message}`);
        addHistory({ kind: 'push-failed', date: latest, error: String(e.message || e) });
        enqueue(latest);
        scheduleRetry(e.message);
      })
      .finally(() => { dispatching = false; });
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
      // 保存句柄：stop() 时必须 close，否则 fs.watch 会一直挂着事件循环
      //（回归测试里表现为 node --test 永不退出）。
      watcher = fs.watch(outDir, { persistent: false }, handleOutDirChange);
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
    saveState(); // 把 loadState() 里清掉的 queue 僵尸项落盘，避免重启后又读回来
    startWatcher();
    catchUp();
    armNextValleyTimer();
    log(`推送服务就绪：目标 ${suite.identity?.pushTargetQQ}，${suite.push?.onlyInValley !== false ? '仅谷时推送' : '不限时段'}`);
  }

  function stop() {
    if (pendingTimer) clearTimeout(pendingTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
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
