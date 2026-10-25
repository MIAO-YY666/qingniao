// ComfyUI MCP server（stdio）—— 给 QQ agent（青鸟）用的生图工具。
// 生成走 bloom-hub hub 的 /api/comfy/*（hub 负责 ComfyUI 拉起/排队/取图），
// 发送走 OneBot（青鸟的账号，127.0.0.1:3010），发送成功即删本地图片。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // bloom-hub

function hubToken() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'hub-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function onebot() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8'));
  return {
    url: (cfg.snowluma?.httpUrl || 'http://127.0.0.1:3010').replace(/\/+$/, ''),
    token: cfg.snowluma?.httpAccessToken ?? cfg.snowluma?.accessToken ?? ''
  };
}

async function hubApi(pathname, body) {
  const token = hubToken();
  const res = await fetch(`http://127.0.0.1:3160${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-token': token },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

async function onebotSendImage(userId, file) {
  const ob = onebot();
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await fetch(`${ob.url}/send_private_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ob.token}` },
    body: JSON.stringify({ user_id: Number(userId), message: [{ type: 'image', data: { file: `base64://${b64}` } }] })
  });
  const data = await res.json().catch(() => ({}));
  if (data.retcode !== 0) throw new Error(`发送失败：${data.wording || data.message || res.status}`);
  return data;
}

const mcp = new McpServer({ name: 'comfy', version: '1.0.0' });

mcp.tool(
  'gen_image',
  '用本地 ComfyUI（Qwen-Image 2.1）生成一张图片并发给 QQ 上的人。生成文件发送成功后自动删除，不占存储。首次调用若 ComfyUI 未运行会自动拉起（可能要等 1~2 分钟）。',
  {
    prompt: z.string().max(600).describe('画面描述（中文或英文均可，越具体越好）'),
    send_to_qq: z.number().int().describe('收图人的 QQ 号'),
    negative: z.string().max(300).optional().describe('负面提示词（不要出现什么）'),
    width: z.number().int().min(256).max(2048).optional().describe('宽，默认 1024'),
    height: z.number().int().min(256).max(2048).optional().describe('高，默认 1024')
  },
  async ({ prompt, send_to_qq, negative, width, height }) => {
    try {
      const r = await hubApi('/api/comfy/generate', { prompt, negative, width, height, sendTo: send_to_qq });
      return { content: [{ type: 'text', text: r.sent ? `已生成并发送给 ${send_to_qq}（本地文件已删除）。` : `已生成但未发送（${r.file}），可让管理端处理。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `生图失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'gen_self_image',
  '生成一张「你自己（青鸟）」的图片并发给 QQ 上的人。外貌自动取统一人格（persona.yaml）里的 appearance 设定，无需描述外貌，只需说画面内容。',
  {
    scene: z.string().max(400).optional().describe('画面内容（她在做什么/在哪/表情），例如「坐在电脑前回头微笑」'),
    send_to_qq: z.number().int().describe('收图人的 QQ 号')
  },
  async ({ scene, send_to_qq }) => {
    try {
      const r = await hubApi('/api/comfy/generate', {
        prompt: scene || '一张她的单人立绘，元气微笑',
        selfImage: true,
        width: 832,
        height: 1216,
        sendTo: send_to_qq
      });
      return { content: [{ type: 'text', text: r.sent ? `已生成并发送给 ${send_to_qq}（本地文件已删除）。` : `已生成但未发送（${r.file}），可让管理端处理。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `生图失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'list_comfy_models',
  '列出本地 ComfyUI 的全部模型（按目录：diffusion_models/text_encoders/vae/loras…）。',
  {},
  async () => {
    try {
      const r = await hubApi('/api/comfy/status', {});
      const lines = Object.entries(r.models || {}).map(([k, v]) => `${k}: ${v.join('、')}`);
      return { content: [{ type: 'text', text: `ComfyUI ${r.up ? '运行中' : '未运行'}\n${lines.join('\n') || '（无模型）'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `查询失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'download_model',
  '下载一个模型文件到本地 ComfyUI 模型目录（只允许落在 D 盘的 ComfyUI models 目录内，返回值注明完整位置）。下载大文件需要时间，发起后可用 list_comfy_models 确认。',
  {
    url: z.string().describe('模型直链 URL（safetensors/ckpt 等）'),
    kind: z.string().describe('目标目录：checkpoints / diffusion_models / text_encoders / vae / loras / clip / controlnet / upscale_models / embeddings')
  },
  async ({ url, kind }) => {
    try {
      const r = await hubApi('/api/comfy/download', { url, kind });
      return { content: [{ type: 'text', text: r.note }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `下载失败：${e.message}` }] };
    }
  }
);

await mcp.connect(new StdioServerTransport());
