// ============================================================
// mcp-bili.js —— B站动态草稿 MCP 工具（给 QQ agent 用）
// ------------------------------------------------------------
// 核心约束：**不能直接发布**。她只能提交草稿，由主人审核后才真正发到 B站。
//   1. bili_draft_submit  提交文案（可带她自己生成的配图）→ 推主人 QQ 审核
//   2. bili_draft_status  查当前草稿状态（待审 / 已发 / 被否）
//
// 审核动作（发 / 不发 / 重写）由主人在 QQ 里说，桥接直接处理，不经过她。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // bloom-hub

function hubEndpoint() {
  let port = 3160;
  let token = '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'suite.json'), 'utf8'));
    port = Number(s.hub?.port) || 3160;
    token = String(s.hub?.token || '');
  } catch { /* 用默认 */ }
  if (!token) {
    try { token = fs.readFileSync(path.join(ROOT, 'state', 'hub-token'), 'utf8').trim(); } catch { /* ignore */ }
  }
  return { base: `http://127.0.0.1:${port}`, token };
}

async function hubCall(pathname, { method = 'GET', body } = {}) {
  const { base, token } = hubEndpoint();
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-hub-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `hub HTTP ${res.status}`);
  return data;
}

function todayYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 配图解析：支持
 *   · 数字序号     → 今天归档里的第 N 张（配合 gen_image_gallery 看清单）
 *   · "last"/"最近" → 今天最新一张
 *   · 纯文件名     → pictures/daily/<今天>/文件名
 *   · 绝对路径 / URL → 原样交给下游校验
 */
async function resolveImages(input) {
  if (input === undefined || input === null || input === '') return [];
  const arr = Array.isArray(input) ? input : [input];
  const out = [];
  let gallery = null;
  const getGallery = async () => {
    if (!gallery) {
      const r = await hubCall('/api/comfy/gallery');
      gallery = Array.isArray(r.images) ? r.images : [];
    }
    return gallery;
  };
  for (const item of arr) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    if (s === 'last' || s === '最近' || s === '刚刚那张') {
      const g = await getGallery();
      if (!g.length) throw new Error('今天还没有生成过图片（先用 gen_image 画一张）');
      out.push(g[g.length - 1].path);
      continue;
    }
    if (/^\d+$/.test(s)) {
      const g = await getGallery();
      const hit = g.find((x) => Number(x.index) === Number(s));
      if (!hit) throw new Error(`今天没有第 ${s} 张图（今天共 ${g.length} 张，可先用 gen_image_gallery 看清单）`);
      out.push(hit.path);
      continue;
    }
    if (!/[\\/]/.test(s) && /\.(png|jpe?g|webp)$/i.test(s)) {
      out.push(path.join(ROOT, 'pictures', 'daily', todayYmd(), s));
      continue;
    }
    out.push(s);
  }
  return out;
}

const mcp = new McpServer({ name: 'bili', version: '1.0.0' });

mcp.tool(
  'bili_draft_submit',
  '提交一条 B站动态草稿给主人审核（**不是直接发布**）。' +
  '写你当天真实的感受：对主人的印象、今天发生的小事、自己的心情。长度随你，想写多长写多长，' +
  '唯一硬限制是 B站单条动态正文最多 1000 字（平台限制，不是我们加的）。像平时说话，不要写成通稿。' +
  '配图可选：先用 gen_image_gallery 看今天画了哪些，想用就传序号；不想配就不传，纯文字也行。' +
  '提交后会自动推送「文案 + 配图」到主人 QQ，他回「发」才真的发到 B站；发完配图会自动清理。' +
  '一天只允许一条待审草稿；如果已经有一条在等他审核，会提示你先等他处理。',
  {
    text: z.string().min(1).max(1000).describe('动态正文（不要写成宣传稿；1000 字上限是 B站平台限制）'),
    images: z.array(z.union([z.number().int(), z.string()])).max(9).optional()
      .describe('配图，最多 9 张。传序号数组（如 [1,3]）、"last"（今天最新一张）或文件名；不传=纯文字'),
    image: z.union([z.number().int(), z.string()]).optional()
      .describe('单图简写（等同 images=[image]），留空表示纯文字'),
  },
  async ({ text, images, image }) => {
    try {
      const pics = await resolveImages(images ?? image);
      const draft = await hubCall('/api/bili/draft', {
        method: 'POST',
        body: { text, images: pics, source: 'agent' }
      });
      const d = draft.draft || {};
      const n = Array.isArray(d.images) ? d.images.length : 0;
      return {
        content: [{
          type: 'text',
          text: `已提交审核（草稿 ${d.id}，${String(d.text || '').length} 字${n ? `，含 ${n} 张配图` : '，纯文字'}）。\n` +
                `已推送到主人 QQ，等他回「发」才会真正发布。这条不用再重复提交。`
        }]
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `提交失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'bili_draft_status',
  '查看 B站动态草稿的当前状态：是否有待审的、最近发过什么、被否的原因。',
  {},
  async () => {
    try {
      const r = await hubCall('/api/bili/draft');
      if (!r.draft) {
        const last = (r.history || [])[0];
        const tail = last
          ? `\n最近一条：${last.status === 'published' ? '已发布' : last.status === 'rejected' ? '被否' : last.status}` +
            `${last.reason ? `（${last.reason}）` : ''}`
          : '';
        return { content: [{ type: 'text', text: `当前没有待审草稿。${tail}` }] };
      }
      const d = r.draft;
      return {
        content: [{
          type: 'text',
          text: `有一条正在等主人审核：\n${d.text}\n${d.image ? '（含 1 张配图）' : '（纯文字）'}\n` +
                `提交于 ${new Date(d.createdAt).toLocaleString('zh-CN')}。他回「发」才会发布。`
        }]
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `查询失败：${e.message}` }] };
    }
  }
);

await mcp.connect(new StdioServerTransport());
