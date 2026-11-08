// ============================================================
// tasks.js —— 定时任务注册表（把散落的 setInterval 收成一个 runner）
// ------------------------------------------------------------
// 背景：以前 hub 里有 3 个各自为政的 setInterval(60s)：
//   autoPost(日报转动态) / autoDraft(唤醒她写草稿) / galleryCleanup(每周清图)
// 每个各管一个 state 文件，重启/合盖醒来后「今天该跑的」只能靠 60 秒轮询撞上，
// 而且三份日历逻辑各写一遍（本地日期 vs ISO 周）。
//
// 现在：一个 runner，一个时钟，一份状态文件（state/tasks.json），
// 每个任务只声明「什么时候该跑」+「跑什么」+「怎么算已经跑过」。
//
// 语义与旧实现保持一致（重要）：
//   · 到点之后任意时刻都算「欠着」（所以合盖醒来会补跑）
//   · 用 key 去重（本地日期 / ISO 周），标记成功后当天/当周不再跑
//   · 失败不写 key → 下一轮自动重试
//   · 向后兼容：首次启动从旧 state 文件播种，避免升级当天重复跑一遍
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

/** 本地日期键 YYYY-MM-DD（不能用 UTC：UTC 会让 0~8 点重复触发） */
export function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO 周键 YYYY-Www（一周只跑一次用） */
export function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

/**
 * 纯函数：这个任务现在该不该跑？
 * @param {{dueAt:{hour:number,minute:number,weekday?:number}, key:string, lastKey:string, now:Date}} p
 * @returns {{due:boolean, reason:string}}
 */
export function evaluateDue({ dueAt, key, lastKey, now = new Date() }) {
  if (!dueAt) return { due: false, reason: 'no-dueAt' };
  if (typeof dueAt.weekday === 'number' && now.getDay() !== dueAt.weekday) {
    return { due: false, reason: 'not-weekday' };
  }
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dueMin = Number(dueAt.hour) * 60 + Number(dueAt.minute);
  if (nowMin < dueMin) return { due: false, reason: 'before-time' };
  if (lastKey && lastKey >= key) return { due: false, reason: 'already-done' };
  return { due: true, reason: 'due' };
}

/** 'HH:MM' → {hour, minute}；非法值回退到 fallback */
export function parseTime(text, fallback = '00:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  const src = m ? text : fallback;
  const [h, mm] = String(src).split(':').map(Number);
  return { hour: Math.min(23, Math.max(0, h || 0)), minute: Math.min(59, Math.max(0, mm || 0)) };
}

/**
 * @param {object} opts
 * @param {string} opts.root       项目根（状态写 root/state/tasks.json）
 * @param {(m:string)=>void} opts.log
 * @param {number} [opts.tickMs]   时钟粒度，默认 30s
 */
export function createTaskRunner({ root, log, tickMs = 30 * 1000 }) {
  const stateFile = path.join(root, 'state', 'tasks.json');
  const tasks = new Map();
  let timer = null;
  let state = { tasks: {} };
  const running = new Set();

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object' && raw.tasks) state = raw;
    } catch { /* 首次运行 */ }
  }
  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      log?.(`[tasks] 保存状态失败：${e.message}`);
    }
  }

  /**
   * 注册任务。
   * @param {object} t
   * @param {string} t.id
   * @param {{hour:number,minute:number,weekday?:number}} t.dueAt
   * @param {() => (string|null)} t.key        当前周期键（返回 null 表示"今天不算"）
   * @param {(ctx:{key:string})=>Promise<boolean|void>} t.run  返回 false/抛错=失败，不记 key
   * @param {boolean} [t.enabled]              动态开关（每次 tick 求值）
   * @param {{file:string, pick:(o:any)=>string}} [t.legacy]  从旧 state 文件播种
   */
  function register(t) {
    if (!t?.id || typeof t.run !== 'function' || typeof t.key !== 'function') {
      throw new Error('register 需要 id / key() / run()');
    }
    tasks.set(t.id, { enabled: () => true, ...t });
    // 首次迁移：旧 state 文件里的 key 直接搬过来，避免升级当天重复触发
    if (!state.tasks[t.id] && t.legacy?.file && t.legacy?.pick) {
      try {
        const old = JSON.parse(fs.readFileSync(path.join(root, t.legacy.file), 'utf8'));
        const seeded = t.legacy.pick(old);
        if (seeded) {
          state.tasks[t.id] = { lastKey: String(seeded), seededFrom: t.legacy.file };
          saveState();
          log?.(`[tasks] ${t.id} 从 ${t.legacy.file} 继承进度：${seeded}`);
        }
      } catch { /* 旧文件不存在 = 全新安装 */ }
    }
    return t.id;
  }

  async function tickOnce(now = new Date()) {
    for (const [id, t] of tasks) {
      if (running.has(id)) continue;
      let enabled = true;
      try { enabled = t.enabled() !== false; } catch { enabled = false; }
      if (!enabled) continue;

      let key = null;
      try { key = t.key(now); } catch (e) { log?.(`[tasks] ${id} key() 失败：${e.message}`); continue; }
      if (!key) continue;

      const lastKey = state.tasks[id]?.lastKey || '';
      // dueAt 支持函数：管理平台改了时间点，下一轮 tick 就生效（不用重启 hub）
      const dueAt = typeof t.dueAt === 'function' ? t.dueAt() : t.dueAt;
      const verdict = evaluateDue({ dueAt, key, lastKey, now });
      if (!verdict.due) continue;

      running.add(id);
      try {
        log?.(`[tasks] 触发 ${id}（key=${key}）`);
        const r = await t.run({ key, now });
        if (r === false) {
          log?.(`[tasks] ${id} 返回失败，下一轮重试`);
        } else {
          state.tasks[id] = { lastKey: key, at: now.toISOString() };
          saveState();
        }
      } catch (e) {
        log?.(`[tasks] ${id} 执行异常（下一轮重试）：${e.message}`);
      } finally {
        running.delete(id);
      }
    }
  }

  function start() {
    if (timer) return;
    loadState();
    timer = setInterval(() => { tickOnce().catch((e) => log?.(`[tasks] tick 异常：${e.message}`)); }, tickMs);
    if (timer.unref) timer.unref();
    // 启动后立刻跑一轮：合盖/重启后欠着的任务不用等第一个 tick
    setTimeout(() => { tickOnce().catch(() => {}); }, 3000).unref?.();
    log?.(`[tasks] 任务表已启动（${tasks.size} 个任务，粒度 ${Math.round(tickMs / 1000)}s）`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function list() {
    return [...tasks.values()].map((t) => ({
      id: t.id,
      lastKey: state.tasks[t.id]?.lastKey || null,
      lastAt: state.tasks[t.id]?.at || null,
      enabled: (() => { try { return t.enabled() !== false; } catch { return false; } })()
    }));
  }

  return { register, start, stop, list, tickOnce, stateFile };
}

export default { createTaskRunner, evaluateDue, parseTime, localDateKey, isoWeekKey };
