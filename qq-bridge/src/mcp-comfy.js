// ComfyUI MCP server（stdio）—— 给 QQ agent 用的生图工具。
// 生成走 bloom-hub hub 的 /api/comfy/*（hub 负责 ComfyUI 拉起/排队/取图），
// 发送走 OneBot HTTP API（见 config.json snowluma.httpUrl），发送成功即删本地图片。
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

async function hubGet(pathname) {
  const token = hubToken();
  const res = await fetch(`http://127.0.0.1:3160${pathname}`, {
    headers: { 'x-hub-token': token }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

const mcp = new McpServer({ name: 'comfy', version: '1.0.0' });

mcp.tool(
  'gen_image',
  '用本地 ComfyUI（Qwen-Image 2.1）生成一张图片并发给 QQ 上的人。' +
  '【异步】调用会立刻返回 jobId，不会阻塞：出图（约 1~2 分钟）后自动发到对方的 QQ，并唤醒你确认。' +
  '所以不要重复提交，也不需要在本回合等待；想确认结果或回看图片，用 gen_image_status。',
  {
    prompt: z.string().max(600).describe('画面描述（中文或英文均可，越具体越好）'),
    send_to_qq: z.number().int().describe('收图人的 QQ 号'),
    negative: z.string().max(300).optional().describe('负面提示词（不要出现什么）'),
    width: z.number().int().min(256).max(2048).optional().describe('宽，默认 1024'),
    height: z.number().int().min(256).max(2048).optional().describe('高，默认 1024')
  },
  async ({ prompt, send_to_qq, negative, width, height }) => {
    try {
      const r = await hubApi('/api/comfy/generate', {
        prompt, negative, width, height, sendTo: send_to_qq, async: true
      });
      return { content: [{ type: 'text', text:
        `已提交生图任务（jobId=${r.jobId}）。出图后会自动发到 ${send_to_qq} 的 QQ，并唤醒你确认；` +
        `不要重复提交，也不用在这个回合等。稍后可用 gen_image_status 查看结果或回看图片。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `生图提交失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'gen_self_image',
  '生成一张「你自己」的图片并发给 QQ 上的人。外貌按统一人格 appearance/appearanceTags 设定，无需描述外貌，只需说画面内容。' +
  '【异步】立刻返回 jobId，出图后自动发送并唤醒你；不要重复提交，也不用在本回合等。',
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
        sendTo: send_to_qq,
        async: true
      });
      return { content: [{ type: 'text', text:
        `已提交自画像任务（jobId=${r.jobId}）。出图后会自动发到 ${send_to_qq} 的 QQ 并唤醒你；不要重复提交。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `自画像提交失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'gen_image_status',
  '查看最近一次（或指定 jobId 的）生图任务状态；若已完成，会附上当时生成的那张图，方便确认「我到底发了什么」。',
  {
    jobId: z.string().optional().describe('任务 id；不传则查最近一次')
  },
  async ({ jobId }) => {
    try {
      const r = await hubGet(`/api/comfy/job${jobId ? `?id=${encodeURIComponent(jobId)}` : ''}`);
      const j = r.job || {};
      const lines = [
        `任务 ${j.id}：${j.status}${j.sent ? '（已发送到 QQ）' : ''}${j.woke ? '（已唤醒会话）' : ''}`,
        j.error ? `错误：${j.error}` : '',
        j.prompt ? `画面：${j.prompt}` : ''
      ].filter(Boolean);
      const content = [{ type: 'text', text: lines.join('\n') }];
      if (j.status === 'done' && j.keepFile && fs.existsSync(j.keepFile)) {
        const size = fs.statSync(j.keepFile).size;
        if (size <= 3 * 1024 * 1024) {
          content.push({ type: 'image', data: fs.readFileSync(j.keepFile).toString('base64'), mimeType: 'image/png' });
        }
      }
      return { content };
    } catch (e) {
      return { content: [{ type: 'text', text: `查询失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'gen_image_gallery',
  '列出某天生成过的图片（时间 + 画面描述 + 序号 + 体积）。' +
  '写 B站动态想配图时先看这里再挑；每周整理时也用它回看往日画了什么。' +
  '不传 date 就是今天。',
  {
    date: z.string().optional().describe('日期 YYYY-MM-DD，不传则今天'),
    days: z.boolean().optional().describe('传 true 则列出「哪几天有图」的汇总（做每周清理时先看这个）')
  },
  async ({ date, days }) => {
    try {
      if (days) {
        const r = await hubGet('/api/gallery/days');
        const list = (r.days || []).filter((d) => d.kept > 0);
        if (!list.length) return { content: [{ type: 'text', text: '归档里目前没有图片。' }] };
        const totalMb = Math.round(list.reduce((s, d) => s + d.bytes, 0) / 1048576);
        const lines = [`归档共 ${list.length} 天 / 约 ${totalMb}MB：`];
        for (const d of list) lines.push(`${d.date}｜${d.kept} 张｜${Math.round(d.bytes / 1048576)}MB`);
        lines.push('', '要看某天的具体内容：gen_image_gallery(date="那天")；要删：gen_image_delete。');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      const r = await hubGet(`/api/comfy/gallery${date ? `?date=${encodeURIComponent(date)}` : ''}`);
      const list = r.images || [];
      if (!list.length) {
        return { content: [{ type: 'text', text: `${r.date} 没有（或已全部删除）图片。想配图的话先用 gen_image / gen_self_image 画一张。` }] };
      }
      const totalMb = (list.reduce((s, x) => s + (x.bytes || 0), 0) / 1048576).toFixed(1);
      const lines = [`${r.date} 共 ${list.length} 张 / ${totalMb}MB：`];
      for (const it of list) {
        lines.push(`${it.index}. ${it.time}｜${(it.prompt || '(无描述)').slice(0, 60)}｜${Math.round(it.bytes / 1024)}KB`);
      }
      lines.push('');
      lines.push('配图就把序号传给 bili_draft_submit（例如 images=[1,3]）；不想要的用 gen_image_delete 删掉。');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `查询失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'gen_image_delete',
  '删掉自己以前生成的图片（真的删文件，删了拿不回来）。' +
  '每周整理时用：先用 gen_image_gallery(days=true) 看哪天占地方，再看具体哪张，最后删掉不想要的。' +
  '不传 files 就是删这一天全部。管理端删除的记录会留一个「已删」标记，方便回看那天画过什么。',
  {
    date: z.string().describe('日期 YYYY-MM-DD（必填，避免误删今天刚画的）'),
    files: z.array(z.union([z.number().int(), z.string()])).optional()
      .describe('要删的图：序号数组（如 [2,4]）或文件名；不传=删这一天全部'),
  },
  async ({ date, files }) => {
    try {
      const r = await hubGet(`/api/gallery/list?date=${encodeURIComponent(date)}`);
      const all = r.images || [];
      const live = all.filter((x) => !x.deleted);
      if (!live.length) return { content: [{ type: 'text', text: `${date} 没有可删的图（已经删光了）。` }] };
      let targets;
      if (!files || !files.length) {
        targets = live.map((x) => x.file);
      } else {
        targets = [];
        for (const it of files) {
          const s = String(it).trim();
          if (/^\d+$/.test(s)) {
            const hit = live.find((x) => Number(x.index) === Number(s));
            if (!hit) throw new Error(`${date} 没有第 ${s} 张（现存 ${live.length} 张）`);
            targets.push(hit.file);
          } else {
            const hit = live.find((x) => x.file === path.basename(s));
            if (!hit) throw new Error(`${date} 找不到 ${s}`);
            targets.push(hit.file);
          }
        }
      }
      const out = await hubApi('/api/gallery/delete', { date, files: targets, by: 'agent' });
      const removed = out.removed || [];
      return { content: [{ type: 'text', text: `已删除 ${removed.length} 张（${date}）。剩下的：${live.length - removed.length} 张。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `删除失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'gen_video',
  '用本地 MiniMax H3 生成一段带原生音轨（环境声/音效/对话）的短视频并发给 QQ 上的人。' +
  '【异步】本机实测一条 5 秒 480p 约 90 秒（首次含模型加载会久一点）。提交后立刻返回，' +
  '不要在本回合等待，也不要重复提交；出片后会自动发到对方 QQ 并唤醒你。' +
  '适合：你想“动起来”的画面、当天氛围空镜、给主人的小短片。不适合：需要精确文字或长剧情的场景。',
  {
    prompt: z.string().max(800).describe('画面描述：写清场景、动作、镜头运动、光线氛围。H3 会同时生成环境音与音效，可以在描述里点明声音'),
    send_to_qq: z.number().int().describe('收片人的 QQ 号'),
    seconds: z.number().min(5).max(15).optional().describe('时长秒数，默认 5；H3 训练范围约 5~15 秒，低于 5 秒画质无保证'),
    width: z.number().int().optional().describe('宽，默认 736（会吸附到 32 的倍数）'),
    height: z.number().int().optional().describe('高，默认 416（会吸附到 32 的倍数）')
  },
  async ({ prompt, send_to_qq, seconds, width, height }) => {
    try {
      const sec = seconds ?? 5;
      const r = await hubApi('/api/video/generate', {
        prompt, sendTo: send_to_qq, seconds: sec, width, height, async: true
      });
      return {
        content: [{
          type: 'text',
          text: `已排入视频队列（jobId ${r.jobId}，约 ${sec} 秒片）。\n` +
                `本机较慢，预计 10~30 分钟；出片后会自动发到 ${send_to_qq} 的 QQ 并唤醒你。\n` +
                `不要重复提交；想查进度可以用 gen_image_status（把这个 jobId 传进去）。`
        }]
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `视频提交失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'list_comfy_models',
  '列出本地 ComfyUI 的全部模型（按目录：diffusion_models/text_encoders/vae/loras…）。',
  {},
  async () => {
    try {
      const r = await hubGet('/api/comfy/status');
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
