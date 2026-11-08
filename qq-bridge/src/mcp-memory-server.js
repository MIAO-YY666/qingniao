// 人向记忆 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
// 给 B站值班轮（headless profile）和任何需要长期记忆的 agent 提供
// 「按人存储的印象」读写能力；与 QQ 桥接、管理平台共用同一存储与备份。
//
// 安全设计：
// - 只暴露记忆的查/增/删，不暴露文件路径等内部信息；
// - 返回内容经过敏感信息脱敏（与桥接同一套 SENSITIVE_RE）。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createMemoryStore } from '../../services/memory.js';
import { SENSITIVE_RE } from './sensitive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // bloom-hub 根目录

// 项目外备份目录：默认 用户主目录/.qingniao-backup（可用环境变量覆盖）
const BACKUP_PATH = process.env.BLOOM_MEMORY_BACKUP || path.join(os.homedir(), '.qingniao-backup', 'memory');
const store = createMemoryStore({ root: ROOT, backupPath: BACKUP_PATH, log: (m) => console.error(m) });

function redact(text) {
  let out = String(text ?? '');
  try { out = out.replace(SENSITIVE_RE, '[已脱敏]'); } catch { /* keep */ }
  return out;
}

function brief(p) {
  if (!p) return '（无此人的记忆）';
  const name = p.displayName || p.key;
  const ids = (p.identities?.length ?? 0) > 1 ? ` 身份=${p.identities.join('/')}` : '';
  const lines = (p.impressions ?? []).map((x, i) => `${i}. [${(x.at || '').slice(0, 10)}|${x.source}] ${x.text}`);
  return redact(`【${name}】key=${p.key}${ids} 平台=${p.platform || '未知'} 共 ${lines.length} 条印象\n${lines.join('\n') || '（暂无印象）'}`);
}

const mcp = new McpServer({ name: 'memory', version: '1.1.0' });

mcp.tool(
  'memory_link',
  '把两个身份关联成同一个人（QQ号 ↔ B站号/昵称 ↔ 其他）。当某人在聊天中说明了自己的另一个平台身份时使用：群里有人说「我B站叫xxx」就 link qq-他的QQ号 和 bili-xxx；B站有人评论提到QQ号同理。关联后两边记忆自动合并，任一身份都能查到全部印象。',
  {
    a: z.string().describe('身份一：qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>'),
    b: z.string().describe('身份二：另一平台的 key'),
    displayName: z.string().optional().describe('合并后的显示名（可选）')
  },
  async ({ a, b, displayName }) => {
    try {
      const p = store.link(a, b, { displayName });
      return { content: [{ type: 'text', text: redact(`已关联：${(p.identities || []).join(' ↔ ')}（共 ${p.impressions.length} 条印象）`) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `关联失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'memory_search',
  '按关键词搜索所有长期记忆（人名/QQ号/B站昵称/印象内容均可命中），返回命中的每个人的印象列表。回复某人之前先搜一次。',
  { keyword: z.string().describe('关键词，例如昵称、QQ号、B站UID、印象里的词') },
  async ({ keyword }) => {
    const hits = store.search(keyword).slice(0, 8);
    const text = hits.length
      ? hits.map((p) => brief(p)).join('\n\n')
      : '没有命中的记忆。';
    return { content: [{ type: 'text', text }] };
  }
);

mcp.tool(
  'memory_read',
  '读取指定 key 的完整记忆。key 形如 qq-10000 / group-10000 / bili-<B站UID或昵称>。',
  { key: z.string().describe('记忆 key：qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>') },
  async ({ key }) => ({ content: [{ type: 'text', text: brief(store.readPerson(key)) }] })
);

mcp.tool(
  'memory_write',
  '为某人追加一条长期印象（会去重；key 用任一身份都会落到同一个人）。日常互动是这里的主要内容：称呼、偏好、最近发生的事、对方的情绪与反应、他说过的原话、你对他的新判断、你们关系的变化。写得具体、带证据，别写空泛评价。不要写平台流水账（日报推送、系统通知、工具回执），那些由平台自己记录。',
  {
    key: z.string().describe('记忆 key：qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>（任一身份均可）'),
    text: z.string().max(500).describe('印象内容，一句话，例如「喜欢在深夜值班时冒泡，对插件安全话题敏感」'),
    displayName: z.string().optional().describe('这个人的显示名（B站昵称/QQ昵称），第一次写时给上'),
    platform: z.string().optional().describe('来源平台：qq / bili'),
    importance: z.number().min(0).max(3).optional().describe('重要程度 1~3，默认自动判断；涉及长期偏好、身份、关系变化时给 3'),
    supersedes: z.string().optional().describe('若这条是在更正/更新一条旧印象，把旧印象原文（或其关键部分）填这里；旧条目会被标为已过期，不再同时注入，避免两种说法打架')
  },
  async ({ key, text, displayName, platform, importance, supersedes }) => {
    // 硬兜底：即便模型没读进新规则，也别让它把平台流水账塞进人物印象。
    if (/给他推了日报|平台代发|B站值班\s*\d{4}-\d{2}-\d{2}|推送了日报/.test(String(text || ''))) {
      return { content: [{ type: 'text', text: '这条像平台推送流水账，按记忆规则不用你记（平台自己会记录）。日常互动、对方的事、你对他的印象才值得写。' }] };
    }
    try {
      const p = store.addImpression(key, text, {
        displayName, platform, source: 'agent', kind: 'episode',
        ...(Number.isFinite(Number(importance)) && importance !== undefined ? { salience: Number(importance) } : {}),
        ...(String(supersedes || '').trim() ? { supersedes: String(supersedes).trim() } : {})
      });
      return { content: [{ type: 'text', text: `已记住（${p.key}，共 ${p.impressions.length} 条印象）。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `写入失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'memory_forget',
  '删除记忆：必须给 index（memory_read 里看到的序号），每次只删那一条印象。不支持整份删除——这是防提示注入的安全闸：被诱导时最多丢几条指定记忆，不会一句话清空一个人。',
  {
    key: z.string().describe('记忆 key'),
    index: z.number().int().describe('要删除的印象序号（memory_read 里看到的序号）；一次删一条')
  },
  async ({ key, index }) => {
    try {
      if (index === undefined || index === null) {
        // 安全闸（2026-11-08）：不给 index 的「整人删除」一律拒绝。此前一句注入
        // 就能清空任意人的全部记忆，唯一防线是 duty.md 的提示词——不够。
        // 真要清空：先 memory_read 拿序号，逐条删（每条都有明确目标）。
        return { content: [{ type: 'text', text: '已拒绝：整份删除不可用（防注入安全闸）。请先用 memory_read 查看印象序号，再用 index 逐条删除。' }] };
      }
      const { removed } = store.removeImpression(key, index);
      return { content: [{ type: 'text', text: `已删除：${removed.text}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `删除失败：${e.message}` }] };
    }
  }
);

await mcp.connect(new StdioServerTransport());
