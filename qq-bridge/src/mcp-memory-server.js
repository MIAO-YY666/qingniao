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
  '读取指定 key 的完整记忆。key 形如 qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>。',
  { key: z.string().describe('记忆 key：qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>') },
  async ({ key }) => ({ content: [{ type: 'text', text: brief(store.readPerson(key)) }] })
);

mcp.tool(
  'memory_write',
  '为某人追加一条长期印象（会去重；key 用任一身份都会落到同一个人）。互动过、值得记住的点都写在这里：称呼、偏好、说过的话、你的判断、你给他推过的东西。',
  {
    key: z.string().describe('记忆 key：qq-<QQ号> / group-<群号> / bili-<B站UID或昵称>（任一身份均可）'),
    text: z.string().max(500).describe('印象内容，一句话，例如「喜欢在深夜值班时冒泡，对插件安全话题敏感」'),
    displayName: z.string().optional().describe('这个人的显示名（B站昵称/QQ昵称），第一次写时给上'),
    platform: z.string().optional().describe('来源平台：qq / bili')
  },
  async ({ key, text, displayName, platform }) => {
    try {
      const p = store.addImpression(key, text, { displayName, platform, source: 'agent' });
      return { content: [{ type: 'text', text: `已记住（${p.key}，共 ${p.impressions.length} 条印象）。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `写入失败：${e.message}` }] };
    }
  }
);

mcp.tool(
  'memory_forget',
  '删除记忆：给 index 只删那一条印象；不给 index 删除这个人/会话的全部记忆。',
  {
    key: z.string().describe('记忆 key'),
    index: z.number().int().optional().describe('要删除的印象序号（memory_read 里看到的序号）；省略则整份删除')
  },
  async ({ key, index }) => {
    try {
      if (index === undefined || index === null) {
        const removed = store.forgetPerson(key);
        return { content: [{ type: 'text', text: removed ? `已删除 ${key} 的全部记忆（${removed.impressions?.length ?? 0} 条）。` : '本来就没有这份记忆。' }] };
      }
      const { removed } = store.removeImpression(key, index);
      return { content: [{ type: 'text', text: `已删除：${removed.text}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `删除失败：${e.message}` }] };
    }
  }
);

await mcp.connect(new StdioServerTransport());
