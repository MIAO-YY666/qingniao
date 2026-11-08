// ============================================================
// check.mjs —— 全量静态检查（零依赖，替代原来只管 7 个文件的 npm run check）
// ------------------------------------------------------------
// 覆盖：
//   1. 所有 .js / .mjs / .cjs 语法（含 8917 行的 bridge.js 与 6 个 MCP server）
//   2. 所有 .json 可解析（config / state / qq-bridge）
//   3. 所有 .py 语法（bili-duty / tools/voice）
//   4. 能力表 ↔ 代码一致性（config/capabilities.mjs 的 assertConsistent）
//
// 用法：npm run check   （任何一项失败都 exit 1）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertConsistent } from '../config/capabilities.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
let checked = 0;

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walk(dir, exts, out = [], depth = 0) {
  if (!fs.existsSync(dir) || depth > 6) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.venv', '.venv-asr', '.git', '__pycache__', 'models', 'logs', 'pictures'].includes(entry.name)) continue;
      walk(full, exts, out, depth + 1);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// ---------- 1. JS 语法 ----------
const jsFiles = [
  ...walk(path.join(ROOT, 'services'), ['.js']),
  ...walk(path.join(ROOT, 'scripts'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'config'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'tools', 'voice'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'test'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'qq-bridge', 'src'), ['.js', '.mjs'])
];
for (const f of jsFiles) {
  checked += 1;
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    errors.push(`语法错误 ${rel(f)}\n${(r.stderr || '').split('\n').slice(0, 4).join('\n')}`);
  }
}

// ---------- 2. JSON 可解析 ----------
const jsonFiles = [
  ...walk(path.join(ROOT, 'config'), ['.json']),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'qq-bridge', 'config.json'),
  path.join(ROOT, 'qq-bridge', 'config.example.json'),
  path.join(ROOT, 'qq-bridge', 'package.json')
];
for (const f of jsonFiles) {
  if (!fs.existsSync(f)) continue;
  checked += 1;
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    errors.push(`JSON 解析失败 ${rel(f)}：${e.message}`);
  }
}

// ---------- 3. Python 语法（compile，不写 pycache）----------
const pyFiles = [
  ...walk(path.join(ROOT, 'bili-duty'), ['.py']),
  ...walk(path.join(ROOT, 'tools', 'voice'), ['.py'])
];
const py = process.env.BLOOM_PYTHON || path.join(ROOT, 'tools', 'voice', '.venv', 'Scripts', 'python.exe');
if (pyFiles.length) {
  if (!fs.existsSync(py)) {
    errors.push(`找不到 Python 解释器：${rel(py)}（跳过 ${pyFiles.length} 个 .py 的语法检查）`);
  } else {
    const code = `
import sys
bad = 0
for f in sys.argv[1:]:
    try:
        src = open(f, 'r', encoding='utf-8').read()
        compile(src, f, 'exec')
    except Exception as e:
        bad += 1
        print(f"{f}: {e}")
sys.exit(1 if bad else 0)
`;
    const r = spawnSync(py, ['-c', code, ...pyFiles], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    checked += pyFiles.length;
    if (r.status !== 0) {
      errors.push(`Python 语法错误：\n${(r.stdout || r.stderr || '').trim()}`);
    }
  }
}

// ---------- 4. 能力表一致性 ----------
{
  const res = assertConsistent({ root: ROOT });
  checked += 1;
  if (!res.ok) {
    errors.push(`能力表与代码不一致：\n  - ${res.issues.join('\n  - ')}`);
  }
}

// ---------- 汇总 ----------
if (errors.length) {
  console.error(`\n✗ check 失败（${errors.length} 项 / 共检查 ${checked} 项）\n`);
  for (const e of errors) console.error(`• ${e}\n`);
  process.exit(1);
}
console.log(`✓ check 通过：${jsFiles.length} 个 JS、${jsonFiles.filter((f) => fs.existsSync(f)).length} 个 JSON、${pyFiles.length} 个 PY，能力表一致`);
