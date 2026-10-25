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
  function capabilities(probeResult) {
    const online = probeResult?.online === true;
    return [
      { id: 'private-push', name: 'QQ 私聊推送', support: online, reason: online ? null : 'SnowLuma 未连接或未登录', action: 'send_private_msg' },
      { id: 'group-message', name: 'QQ 群消息', support: online, reason: online ? null : 'SnowLuma 未连接或未登录', action: 'send_group_msg' },
      { id: 'profile-like', name: '名片赞（个人主页点赞）', support: online, reason: online ? null : 'SnowLuma 未连接或未登录', action: 'send_like' },
      { id: 'group-notice', name: '群公告', support: online, reason: online ? null : 'SnowLuma 未连接或未登录', action: 'send_group_notice' },
      { id: 'poke', name: '戳一戳', support: online, reason: online ? null : 'SnowLuma 未连接或未登录', action: 'friend_poke / group_poke' },
      { id: 'mood', name: '发说说（QQ 空间动态）', support: false, reason: 'SnowLuma 1.14.15 的 OneBot 协议端未提供 Qzone/说说接口；此为协议端能力缺口，不是配置问题。可在协议端更新支持后再接入。', action: null },
      { id: 'qzone-album', name: '空间相册/图文', support: false, reason: '同上：协议端未提供 Qzone 能力。', action: null }
    ];
  }

  async function sendPrivateMessage(userId, text) {
    return callAction(coreConfig, 'send_private_msg', { user_id: Number(userId), message: String(text) });
  }

  // 发图（本地文件 → base64 段）
  async function sendPrivateImage(userId, file) {
    const fsMod = await import('node:fs');
    const buf = fsMod.readFileSync(file);
    return callAction(coreConfig, 'send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }]
    });
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

  return { probe, capabilities, sendPrivateMessage, sendPrivateImage, sendGroupMessage, sendLike, sendGroupNotice, poke, postMood };
}
