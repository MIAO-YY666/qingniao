// ============================================================
// scheduler.js —— 峰谷时间窗口计算（bloom-hub 共享模块）
// 窗口定义在 config/suite.json 的 valley.windows：
//   { name, label, start: "HH:MM", end: "HH:MM" }
// 支持跨午夜窗口（如 23:00 → 07:30）。
// ============================================================

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

export function normalizeWindows(windows) {
  const out = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start == null || end == null) continue;
    out.push({ name: w.name || `w${out.length + 1}`, label: w.label || w.name || `窗口${out.length + 1}`, start, end });
  }
  return out;
}

function minutesOf(d) {
  return d.getHours() * 60 + d.getMinutes();
}

// 某一时刻（分钟数）是否落在窗口内（跨午夜：start > end）
export function windowAt(wins, minutes) {
  for (const w of wins) {
    if (w.start <= w.end) {
      if (minutes >= w.start && minutes < w.end) return w;
    } else if (minutes >= w.start || minutes < w.end) {
      return w;
    }
  }
  return null;
}

function fmtHM(mins) {
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// 当前状态：{ inValley, window, nextWindowStartAt, nextWindowName }
export function valleyStatus(windowsRaw, date = new Date()) {
  const wins = normalizeWindows(windowsRaw);
  const cur = windowAt(wins, minutesOf(date));

  // 下一个窗口开始：枚举每个窗口在「今天/明天」的开始时刻，取严格晚于现在的最早者
  let best = null;
  let bestW = null;
  for (const w of wins) {
    for (const dayOffset of [0, 1]) {
      const s = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, Math.floor(w.start / 60), w.start % 60, 0, 0);
      if (s.getTime() > date.getTime() && (!best || s.getTime() < best.getTime())) {
        best = s;
        bestW = w;
      }
    }
  }

  return {
    inValley: !!cur,
    window: cur ? { name: cur.name, label: cur.label } : null,
    nextWindowStartAt: best ? best.toISOString() : null,
    nextWindowName: bestW ? bestW.name : null,
    nextWindowLabel: bestW ? bestW.label : null,
    windows: wins.map((w) => ({ name: w.name, label: w.label, start: fmtHM(w.start), end: fmtHM(w.end) }))
  };
}

// 距离下一个谷时窗口开始的毫秒数（已在谷时返回 0；没有窗口返回 null）
export function msUntilValley(windowsRaw, date = new Date()) {
  const st = valleyStatus(windowsRaw, date);
  if (st.inValley) return 0;
  if (!st.nextWindowStartAt) return null;
  return Math.max(0, new Date(st.nextWindowStartAt).getTime() - date.getTime());
}

export function inValleyNow(windowsRaw, date = new Date()) {
  return valleyStatus(windowsRaw, date).inValley;
}

// 日报文件名日期（YYYY-MM-DD）→ 展示用 MM-DD
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[2]}-${m[3]}` : String(iso || '');
}
