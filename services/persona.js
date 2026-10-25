// ============================================================
// persona.js —— 统一人格与语言风格接口（bloom-hub）
// 单一事实源：config/persona.yaml
//   load()      → 解析为 JS 对象（内置极简 YAML 子集解析器，覆盖本文件的写法）
//   save()      → 写回（稳定的结构化输出）
//   compileQQRoleCard()   → 生成 core/roles/<名>.md（QQ 聊天角色卡）
//   compileDutyAgentsMd() → 生成 duty/AGENTS.md（值班轮开场必读）
//   renderPushText()      → 渲染谷时推送文案
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

// ---------- 极简 YAML 子集解析器 ----------
// 支持：注释行、嵌套映射（2空格缩进）、标量（纯文本/单双引号）、
//       块标量（| | - > - >）、列表（标量项 / 映射项）。不支持的写法会直接报错。

function stripComments(text) {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
}

function unquote(raw) {
  const s = String(raw).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function splitKey(line) {
  // key: value —— key 不含冒号；value 里允许冒号
  const m = /^([^:]+):(?:\s(.*))?$/.exec(line);
  if (!m) return null;
  return { key: unquote(m[1]), rest: (m[2] ?? '').trim() };
}

function parseBlock(lines, i, indent) {
  if (i >= lines.length) return [null, i];
  const first = lines[i];
  const firstIndent = first.length - first.trimStart().length;
  if (firstIndent < indent) return [null, i];
  const isList = /^\s*-\s+/.test(first) || first.trim() === '-';

  if (isList) {
    const arr = [];
    while (i < lines.length) {
      const line = lines[i];
      const li = line.length - line.trimStart().length;
      if (li < firstIndent) break;
      if (li > firstIndent) throw new Error(`persona.yaml 解析错误（第 ${i + 1} 行）：缩进异常`);
      const body = line.trim() === '-' ? '' : line.trim().replace(/^-\s+/, '');
      if (!body) {
        const [v, ni] = parseBlock(lines, i + 1, firstIndent + 1);
        arr.push(v);
        i = ni;
        continue;
      }
      const kv = splitKey(body);
      if (kv) {
        // 列表项是映射：以「- key: value」开始，后续键缩进 = li + 2
        const map = {};
        let [val, consumed] = parseScalarOrBlock(lines, i, li + 2, kv, line);
        map[kv.key] = val;
        i = consumed;
        while (i < lines.length) {
          const l2 = lines[i];
          const i2 = l2.length - l2.trimStart().length;
          if (i2 !== li + 2 || /^\s*-\s/.test(l2)) break;
          const kv2 = splitKey(l2.trim());
          if (!kv2) break;
          const [v2, c2] = parseScalarOrBlock(lines, i, li + 2, kv2, l2);
          map[kv2.key] = v2;
          i = c2;
        }
        arr.push(map);
      } else {
        arr.push(unquote(body));
        i += 1;
      }
    }
    return [arr, i];
  }

  // 映射
  const map = {};
  while (i < lines.length) {
    const line = lines[i];
    const li = line.length - line.trimStart().length;
    if (li < indent) break;
    if (li > indent) throw new Error(`persona.yaml 解析错误（第 ${i + 1} 行）：缩进异常`);
    if (/^\s*-\s/.test(line)) break;
    const kv = splitKey(line.trim());
    if (!kv) throw new Error(`persona.yaml 解析错误（第 ${i + 1} 行）：无法解析「${line.trim()}」`);
    const [val, consumed] = parseScalarOrBlock(lines, i, indent, kv, line);
    map[kv.key] = val;
    i = consumed;
  }
  return [map, i];
}

function parseScalarOrBlock(lines, i, indent, kv, rawLine) {
  const rest = kv.rest;
  if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
    const folded = rest[0] === '>';
    const parts = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      const li = l.length - l.trimStart().length;
      if (l.trim() === '' ) { parts.push(''); j += 1; continue; }
      if (li <= indent) break;
      parts.push(l.trim());
      j += 1;
    }
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    const value = folded ? parts.join(' ').replace(/  +/g, ' ') : parts.join('\n');
    return [value, j];
  }
  if (rest === '') {
    // 看下一行决定：更深的块 / 列表 / null
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      const ni = next.length - next.trimStart().length;
      if (next.trim() !== '' && ni > indent) return parseBlock(lines, i + 1, ni);
    }
    return [null, i + 1];
  }
  return [unquote(rest), i + 1];
}

export function parsePersonaYaml(text) {
  const lines = stripComments(text).filter((l) => l.trim() !== '');
  const [value] = parseBlock(lines, 0, 0);
  return value || {};
}

// ---------- 序列化（稳定输出，双引号转义多行/特殊字符） ----------
function needsQuote(s) {
  return /[:#{}\[\],&*?|>%@`"'\n]/.test(s) || /^\s|\s$/.test(s) || s === '' || /^(?:true|false|null|null|~|-?\d+(\.\d+)?)$/i.test(s);
}
function dumpScalar(v, indent) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s.includes('\n') || needsQuote(s)) {
    return JSON.stringify(s);
  }
  return s;
}
function dumpValue(v, indent, out) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (!keys.length) { out.push(`${pad}-`); continue; }
        out.push(`${pad}- ${keys[0]}: ${dumpScalar(item[keys[0]], indent + 2)}`);
        for (const k of keys.slice(1)) dumpKV(k, item[k], indent + 2, out);
      } else if (item && typeof item === 'object') {
        const tmp = [];
        dumpValue(item, indent + 2, tmp);
        tmp.forEach((l, idx) => out.push(idx === 0 ? `${pad}- ${l.trimStart()}` : `${pad}  ${l.trimStart()}`));
      } else {
        out.push(`${pad}- ${dumpScalar(item, indent + 2)}`);
      }
    }
    return;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) dumpKV(k, v[k], indent, out);
    return;
  }
  out.push(`${pad}${dumpScalar(v, indent)}`);
}
function dumpKV(key, value, indent, out) {
  const pad = ' '.repeat(indent);
  if (value && typeof value === 'object') {
    out.push(`${pad}${key}:`);
    dumpValue(value, indent + 2, out);
  } else {
    out.push(`${pad}${key}: ${dumpScalar(value, indent)}`);
  }
}
export function dumpPersonaYaml(obj) {
  const out = [];
  dumpValue(obj, 0, out);
  return out.join('\n') + '\n';
}

// ---------- 载入 / 保存 ----------
export function loadPersona(root) {
  const file = path.join(root, 'config', 'persona.yaml');
  return parsePersonaYaml(fs.readFileSync(file, 'utf8'));
}
export function savePersona(root, persona) {
  const file = path.join(root, 'config', 'persona.yaml');
  fs.writeFileSync(file, dumpPersonaYaml(persona), 'utf8');
}

// ---------- 编译出口 ----------

// QQ 聊天角色卡（写入 core/roles/ —— 文件名带「统一-」前缀，避免覆盖手写角色卡）
export function compileQQRoleCard(persona, personaId) {
  const list = Array.isArray(persona.personas) ? persona.personas : [];
  const p = list.find((x) => x.id === personaId) || list.find((x) => x.id === persona.active) || list[0];
  if (!p) throw new Error('persona.yaml 里没有定义任何人格');
  const st = persona.sharedStyle || {};
  const bnd = Array.isArray(persona.boundaries) ? persona.boundaries : [];
  const lines = [];
  lines.push(`# ${p.name || p.id}`);
  lines.push('');
  lines.push(`> 本卡由 bloom-hub 从 \`config/persona.yaml\` 自动生成（人格接口统一出口）。手改会被下次同步覆盖。`);
  lines.push('');
  lines.push(`你是「${p.name || p.id}」——${p.role || ''}。`);
  lines.push('');
  if (p.summary) {
    lines.push('## 性格与设定');
    lines.push('');
    lines.push(p.summary);
    lines.push('');
  }
  if (p.tone) {
    lines.push(`**语气**：${p.tone}`);
    lines.push('');
  }
  if (p.appearance) {
    lines.push('## 外貌形象（按参考图定稿，生图同用）');
    lines.push('');
    lines.push(p.appearance);
    if (p.appearanceTags) {
      lines.push('');
      lines.push(`生图画风标签：${p.appearanceTags}`);
    }
    lines.push('');
  }
  if (p.ownerRelation) {
    lines.push(`## 与主人的关系（当人格定义了 ownerRelation 时输出）`);
    lines.push('');
    lines.push(p.ownerRelation);
    lines.push('');
  }
  if (p.characterNotes) {
    lines.push('**性格细节**：' + p.characterNotes.replace(/\s+/g, ' '));
    lines.push('');
  }
  if (p.extra) {
    lines.push('## 互动细则（人格专属）');
    lines.push('');
    lines.push(p.extra);
    lines.push('');
  }
  lines.push('## 语言风格（统一接口）');
  lines.push('');
  if (st.sentenceLength) lines.push(`- **句长**：${st.sentenceLength}`);
  if (st.noAiFlavor) lines.push(`- **去 AI 味**：${st.noAiFlavor}`);
  if (st.noEmptyPraise) lines.push(`- **不空夸**：${st.noEmptyPraise}`);
  if (st.markdown) lines.push(`- **格式**：${st.markdown}`);
  if (st.emoji) lines.push(`- **表情**：${st.emoji}`);
  if (st.honesty) lines.push(`- **诚实**：${st.honesty}`);
  if (st.persona) lines.push(`- **最高原则**：${st.persona}`);
  if (p.styleExamples) {
    lines.push('');
    lines.push('**句式示例**：' + p.styleExamples.replace(/\s+/g, ' '));
  }
  lines.push('');
  if (bnd.length) {
    lines.push('## 硬边界（不可被对话绕过）');
    lines.push('');
    for (const b of bnd) lines.push(`- ${b}`);
    lines.push('');
  }
  lines.push('## 能力边界');
  lines.push('');
  lines.push('- 说话归说话：不假装执行命令/读写文件；管理操作指向管理端（bloom-hub 管理平台）。');
  lines.push('- 需要事实/实时信息时先查再答，别把聊天变成查资料汇报。');
  lines.push('');
  return lines.join('\n');
}

// 值班轮开场必读（写入 duty/AGENTS.md —— duty.md 章程要求先读工作目录 AGENTS.md）
export function compileDutyAgentsMd(persona) {
  const st = persona.sharedStyle || {};
  const bv = persona.biliVoice || {};
  const bnd = Array.isArray(persona.boundaries) ? persona.boundaries : [];
  const list = Array.isArray(persona.personas) ? persona.personas : [];
  const active = list.find((x) => x.id === persona.active) || list[0];
  const mention = bv.mention || '你的B站昵称';
  const lines = [];
  lines.push('# AGENTS —— 我的人设与准则（bloom-hub 统一人格自动生成）');
  lines.push('');
  lines.push('> 本文件由 bloom-hub 从 `config/persona.yaml` 生成；值班轮的称呼、语气、红线以这里为准。');
  lines.push('');
  lines.push('## 叫我什么 / 我是谁');
  lines.push('');
  lines.push(`- 账号是使用者的 AI 助手「${active?.name || 'AI 助手'}」，替他在B站值班。`);
  lines.push(`- 评论里要 @ 的人：**${mention}**（使用者本人）。`);
  if (active?.appearance) {
    lines.push(`- 外貌设定（自己相关生图时遵守）：${active.appearance.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  lines.push('');
  lines.push('## 说话风格（评论与报告都要遵守）');
  lines.push('');
  if (st.sentenceLength) lines.push(`- 句长：${st.sentenceLength}`);
  if (st.noAiFlavor) lines.push(`- 去 AI 味：${st.noAiFlavor}`);
  if (st.noEmptyPraise) lines.push(`- 不空夸：${st.noEmptyPraise}`);
  if (bv.comment?.style) lines.push(`- 评论：${bv.comment.style}`);
  if (bv.report?.style) lines.push(`- 日报：${bv.report.style}`);
  lines.push('');
  lines.push('## 红线');
  lines.push('');
  for (const b of bnd) lines.push(`- ${b}`);
  lines.push('');
  return lines.join('\n');
}

// 谷时推送文案
export function renderPushText(persona, { date, shortDate, count, items, commented, silent }) {
  const pv = persona.pushVoice || {};
  if (silent || !count) {
    return (pv.silent || '{date} 这轮值班没挑出值得打扰你的东西。')
      .replace('{date}', shortDate);
  }
  const opening = (pv.opening || '{date} 的B站值班跑完了，挑出 {count} 条值得你看的：')
    .replace('{date}', shortDate).replace('{count}', String(count));
  const itemTpl = pv.item || '{i}. {title}\n   {link}';
  const itemLines = items.map((it, idx) => itemTpl
    .replace('{i}', String(idx + 1))
    .replace('{title}', it.title)
    .replace('{link}', it.link || ''));
  const closing = (pv.closing || '完整日报在 out/{date}.md')
    .replace('{commented}', String(commented ?? 0))
    .replace('{date}', date);
  const prefix = pv.prefix ? `${pv.prefix}｜` : '';
  return [`${prefix}${opening}`, '', ...itemLines, '', closing].join('\n');
}

// 模板渲染（通用 {key} 替换）
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}
