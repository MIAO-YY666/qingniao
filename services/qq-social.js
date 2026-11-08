// ============================================================
// qq-social.js —— QQ 社交能力适配器（bloom-hub）
// ------------------------------------------------------------
// 统一的「QQ 侧能做什么」接口：
//   · capabilities()      → 能力清单（支持/不支持 + 原因）
//   · sendPrivateMessage / sendGroupMessage  → 推送等消息能力
//   · sendLike            → 名片赞（QQ 个人主页点赞）
//   · sendGroupNotice     → 群公告
//   · poke                → 戳一戳
//   · postMood / postQzone → 说说 / QQ 空间 —— 协议端（SnowLuma）未提供，
//                            这里显式返回不支持并说明，管理平台如实展示。
// OneBot 端点与令牌沿用 core/config.json（单一来源，避免重复配置）。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

export function readCoreConfig(coreDir) {
  const file = path.join(coreDir, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function onebotHttp(coreConfig) {
  const ob = coreConfig?.snowluma || {};
  const url = (ob.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = ob.httpAccessToken ?? ob.accessToken ?? '';
  return { url, token };
}

async function callAction(coreConfig, action, params, timeoutMs = 8000) {
  const { url, token } = onebotHttp(coreConfig);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'failed' || data.retcode && data.retcode !== 0) {
      const msg = data.wording || data.message || `HTTP ${res.status}`;
      throw new Error(`${action} 失败：${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function createQqSocial(coreDir) {
  const coreConfig = readCoreConfig(coreDir);

  async function probe() {
    try {
      const info = await callAction(coreConfig, 'get_version_info', {}, 4000);
      const login = await callAction(coreConfig, 'get_login_info', {}, 4000).catch(() => null);
      return {
        online: true,
        version: info?.data?.version || info?.data?.app_name || 'SnowLuma',
        loginQQ: login?.data?.user_id ?? null,
        loginNickname: login?.data?.nickname ?? null
      };
    } catch (e) {
      return { online: false, error: String(e.message || e) };
    }
  }

  // 能力清单：support = true 可直接调用；false 时给出 reason
  // caps 来自 capabilityProbe()（can_send_record / can_send_image 的运行时探测），
  // 传了就以探测结果为准 —— 协议端支持什么不该靠我们手写猜。
  function capabilities(probeResult, caps = null) {
    const online = probeResult?.online === true;
    const why = online ? null : 'SnowLuma 未连接或未登录';
    const voiceOk = online && caps ? caps.record !== false : online;
    const voiceReason = voiceOk ? null : (online ? '协议端 can_send_record 返回不支持' : why);
    return [
      { id: 'private-push', name: 'QQ 私聊推送', support: online, reason: why, action: 'send_private_msg' },
      { id: 'groups-message', name: 'QQ 群消息', support: online, reason: why, action: 'send_group_msg' },
      { id: 'private-voice', name: 'QQ 私聊语音', support: voiceOk, reason: voiceReason, action: 'send_private_msg(record)' },
      { id: 'group-voice-ai', name: '群语音（QQ 内置 AI 音色）', support: online, reason: why, action: 'send_group_ai_record' },
      { id: 'profile-like', name: '名片赞（个人主页点赞）', support: online, reason: why, action: 'send_like' },
      { id: 'group-notice', name: '群公告', support: online, reason: why, action: 'send_group_notice' },
      { id: 'poke', name: '戳一戳', support: online, reason: why, action: 'friend_poke / group_poke' },
      { id: 'mood', name: '发说说（QQ 空间动态）', support: false, reason: '协议端 action 存在（send_qzone_msg 返 1400 缺参而非 1404 不存在），但本项目未接入；属高可见度写操作，接入需先审后发。', action: 'send_qzone_msg' },
      { id: 'qzone-album', name: '空间相册/图文', support: false, reason: '同上：空间相册确实未提供。', action: null }
    ];
  }

  /** 运行时能力探测（协议端支持什么，问它自己） */
  async function capabilityProbe() {
    const out = {};
    for (const kind of ['record', 'image']) {
      try {
        const r = await callAction(coreConfig, `can_send_${kind}`, {}, 4000);
        out[kind] = r?.data?.yes === true;
      } catch {
        out[kind] = null; // 探测失败不当作 false，避免误报"不支持"
      }
    }
    return out;
  }

  async function sendPrivateMessage(userId, text) {
    return callAction(coreConfig, 'send_private_msg', { user_id: Number(userId), message: String(text) });
  }

  // 发图（本地文件 → base64 段）
  async function sendPrivateImage(userId, file) {
    const abs = path.resolve(file);
    // 优先 file://：协议端与 hub 同机，直接让 SnowLuma 读本地路径，请求体只有几十字节。
    // 原先一律 base64 会随图片变大而爆掉：实测 1.74MB PNG → base64 约 2.3MB body，
    // SnowLuma 直接 ECONNRESET（0 秒断连）；177KB 小图则正常。故大图必须走 file://。
    try {
      return await callAction(coreConfig, 'send_private_msg', {
        user_id: Number(userId),
        message: [{ type: 'image', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }]
      }, 30000);
    } catch (e1) {
      // 回退 base64（协议端不支持 file:// 时）；仍然失败就把两个原因都带出来，便于定位
      try {
        const buf = fs.readFileSync(abs);
        return await callAction(coreConfig, 'send_private_msg', {
          user_id: Number(userId),
          message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }]
        }, 30000);
      } catch (e2) {
        const mb = (fs.statSync(abs).size / 1024 / 1024).toFixed(2);
        throw new Error(`图片发送失败（${mb}MB）：file:// → ${e1.message}；base64 → ${e2.message}`);
      }
    }
  }

  /** 发短视频：优先 video 段，协议端不支持时回退成文件（同一路径，不占请求体） */
  async function sendPrivateVideo(userId, file) {
    const abs = path.resolve(file);
    const uri = 'file:///' + abs.replace(/\\/g, '/');
    // 视频要上传到腾讯服务器，给足超时
    try {
      return await callAction(coreConfig, 'send_private_msg', {
        user_id: Number(userId),
        message: [{ type: 'video', data: { file: uri } }]
      }, 180000);
    } catch (e1) {
      try {
        return await callAction(coreConfig, 'send_private_msg', {
          user_id: Number(userId),
          message: [{ type: 'file', data: { file: uri, name: path.basename(abs) } }]
        }, 180000);
      } catch (e2) {
        const mb = (fs.statSync(abs).size / 1024 / 1024).toFixed(1);
        throw new Error(`视频发送失败（${mb}MB）：video 段 → ${e1.message}；文件 → ${e2.message}`);
      }
    }
  }

  /** 发语音：record 段优先（协议端自己转 SILK），三级降级，失败带聚合原因 */
  async function sendPrivateVoice(userId, file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`语音文件不存在：${abs}`);
    const size = fs.statSync(abs).size;
    if (size < 512) throw new Error(`语音文件过小（${size}B），可能是合成失败`);
    if (size > 8 * 1024 * 1024) throw new Error(`语音文件过大（${(size / 1048576).toFixed(1)}MB）`);
    const uri = 'file:///' + abs.replace(/\\/g, '/');
    const tries = [];

    // ① file:/// —— 唯一有真机 message_id 佐证的路径，body 只有几十字节，不受 2MB 限制
    try {
      const r = await callAction(coreConfig, 'send_private_msg', {
        user_id: Number(userId),
        message: [{ type: 'record', data: { file: uri } }]
      }, 60000);
      return { ...r, via: 'file', bytes: size };
    } catch (e1) {
      tries.push(`file:// → ${e1.message}`);
    }

    // ② base64:// —— 协议端不认本地路径时回退（语音很小，不会撞 2MB）
    try {
      const buf = fs.readFileSync(abs);
      const r = await callAction(coreConfig, 'send_private_msg', {
        user_id: Number(userId),
        message: [{ type: 'record', data: { file: `base64://${buf.toString('base64')}` } }]
      }, 60000);
      return { ...r, via: 'base64', bytes: size };
    } catch (e2) {
      tries.push(`base64 → ${e2.message}`);
    }

    // ③ 最后兜底：当文件发出去 + 一句说明，内容不能丢
    try {
      const r = await callAction(coreConfig, 'send_private_msg', {
        user_id: Number(userId),
        message: [
          { type: 'file', data: { file: uri, name: path.basename(abs) } },
          { type: 'text', data: { text: '（语音发不出去，先给你音频文件）' } }
        ]
      }, 120000);
      return { ...r, via: 'file-segment', degraded: true, bytes: size };
    } catch (e3) {
      tries.push(`file段 → ${e3.message}`);
    }

    throw new Error(`语音发送失败：${tries.join('；')}`);
  }

  // 语音闸门：同一会话 45 秒内最多一条，防止模型刷屏或重试风暴
  const VOICE_MIN_INTERVAL_MS = 45 * 1000;
  const voiceLastAt = new Map();
  function checkVoiceGate(userId) {
    const key = String(userId);
    const last = voiceLastAt.get(key) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < VOICE_MIN_INTERVAL_MS) {
      return { ok: false, retryAfterMs: VOICE_MIN_INTERVAL_MS - elapsed };
    }
    return { ok: true, retryAfterMs: 0 };
  }
  function markVoiceSent(userId) {
    voiceLastAt.set(String(userId), Date.now());
  }

  async function sendGroupMessage(groupId, text) {
    return callAction(coreConfig, 'send_group_msg', { group_id: Number(groupId), message: String(text) });
  }

  async function sendLike(userId, times = 1) {
    return callAction(coreConfig, 'send_like', { user_id: Number(userId), times: Math.max(1, Math.min(50, Number(times) || 1)) });
  }

  async function sendGroupNotice(groupId, content) {
    return callAction(coreConfig, 'send_group_notice', { group_id: Number(groupId), content: String(content) });
  }

  async function poke(opts = {}) {
    const { groupId, userId } = opts;
    if (groupId && userId) return callAction(coreConfig, 'group_poke', { group_id: Number(groupId), user_id: Number(userId) });
    if (userId) return callAction(coreConfig, 'friend_poke', { user_id: Number(userId) });
    throw new Error('poke 需要 userId（可选 groupId）');
  }

  // 说说 / 空间：显式不支持
  async function postMood() {
    throw new Error('当前协议端（SnowLuma 1.14.15）不支持发说说/Qzone：OneBot 协议未提供该接口。此功能在管理平台显示为「待协议端支持」。');
  }

  return {
    probe,
    capabilities,
    capabilityProbe,
    sendPrivateMessage,
    sendPrivateImage,
    sendPrivateVideo,
    sendPrivateVoice,
    checkVoiceGate,
    markVoiceSent,
    voiceMinIntervalMs: VOICE_MIN_INTERVAL_MS,
    sendGroupMessage,
    sendLike,
    sendGroupNotice,
    poke,
    postMood
  };
}
