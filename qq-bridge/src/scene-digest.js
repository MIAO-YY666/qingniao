// ============================================================
// scene-digest.js —— 跨日情景摘要（P2，纯逻辑，可单测）
// ------------------------------------------------------------
// 不假设深夜在线、不依赖定时器或关机时间：调用方在每次「取会话状态」时
// 传入今天的日期，这里判断「上次记录日期 != 今天」就把昨天积累的消息
// 归纳成一条规则式摘要（不额外调 LLM），清空桶、只留最近 N 天。
// 无论几点开机、关了几天，第一次活动就会补上；用日期做幂等，一天只做一次。
// ============================================================

export const SCENE_DIGEST_DAYS = 3;
export const SCENE_BUCKET_MAX = 120;

/** 把一天的原始消息压成一句摘要。规则式，不调模型。 */
export function buildSceneDigest(day, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const speakers = {};
  for (const m of list) {
    const who = String(m?.sender || '对方').slice(0, 20);
    speakers[who] = (speakers[who] || 0) + 1;
  }
  const top = Object.entries(speakers).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, c]) => `${n}(${c})`).join('、');
  const quotes = list
    .map((m) => String(m?.plain || m?.text || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 8 && !/^\[(图片|表情包|语音)/.test(t) && !/^[\W_]+$/.test(t))
    .slice(0, 3)
    .map((t) => `「${t.slice(0, 50)}」`);
  const hours = list
    .map((m) => new Date(Number(m?.time || 0) + 8 * 3600 * 1000).getUTCHours())
    .filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
  const span = hours.length ? `，${Math.min(...hours)}~${Math.max(...hours)} 点` : '';
  return `${day}：收到 ${list.length} 条，主要 ${top || '对方'}${span}${quotes.length ? '；聊到 ' + quotes.join('、') : ''}`;
}

/**
 * 跨日检查。直接修改传入的 st（sceneDay / sceneBucket / sceneDigests）。
 * 返回 true 表示发生了归纳，调用方应落盘；日期相同则是零开销的 false。
 */
export function rollSceneDigest(st, today, { maxDays = SCENE_DIGEST_DAYS, log = () => {} } = {}) {
  if (!st || !today) return false;
  if (!st.sceneDay) { st.sceneDay = today; return false; }
  if (st.sceneDay === today) return false;
  const oldDay = st.sceneDay;
  const bucket = Array.isArray(st.sceneBucket) ? st.sceneBucket : [];
  const digest = buildSceneDigest(oldDay, bucket);
  if (digest) {
    const prev = (st.sceneDigests && typeof st.sceneDigests === 'object') ? st.sceneDigests : {};
    const next = { ...prev, [oldDay]: digest };
    st.sceneDigests = Object.fromEntries(
      Object.keys(next).sort().slice(-maxDays).map((d) => [d, next[d]])
    );
  }
  st.sceneBucket = [];
  st.sceneDay = today;
  log(`跨日 ${oldDay} → ${today}，已归纳 ${bucket.length} 条${digest ? '' : '（无内容）'}`);
  return true;
}

/** 把一条新消息放进当天的桶；桶有上限，摘要不依赖 recentMessages 的滚动窗口。 */
export function pushSceneBucket(st, msg, max = SCENE_BUCKET_MAX) {
  if (!st) return;
  st.sceneBucket = Array.isArray(st.sceneBucket) ? st.sceneBucket : [];
  st.sceneBucket.push({
    sender: String(msg?.sender || '对方').slice(0, 20),
    plain: String(msg?.plain || msg?.text || '').slice(0, 120),
    time: Number(msg?.time) || Date.now()
  });
  if (st.sceneBucket.length > max) st.sceneBucket.splice(0, st.sceneBucket.length - max);
}

/** 唤醒提示里注入最近 N 天摘要；没有则返回空串。 */
export function formatSceneDigests(st, maxDays = SCENE_DIGEST_DAYS) {
  const d = st?.sceneDigests && typeof st.sceneDigests === 'object' ? st.sceneDigests : {};
  const days = Object.keys(d).sort().slice(-maxDays);
  if (!days.length) return '';
  return `【最近几天的情景】（系统自动归纳，别只盯着本轮未读）\n${days.map((x) => `- ${d[x]}`).join('\n')}\n\n`;
}
