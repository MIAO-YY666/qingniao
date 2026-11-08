const fs = require('fs');
const BASE = 'app/src/main/java/com/bloomhub/pocket';
for (const f of ['agent/Prompt.kt', 'store/MemoryStore.kt', 'agent/AgentLoop.kt', 'agent/WebSearch.kt', 'agent/AppManual.kt', 'llm/Llm.kt', 'screen/ScreenAccess.kt', 'screen/Screenshot.kt', 'notify/QqListener.kt', 'AgentService.kt', 'MainActivity.kt']) {
  const s = fs.readFileSync(`${BASE}/${f}`, 'utf8');
  let depth = 0, inLine = false, inStr = false, inTri = false, line = 1, startLine = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (c === '\n') { line++; inLine = false; continue; }
    if (inLine) continue;
    if (inTri) { if (c === '"' && s.substr(i, 3) === '"""') { inTri = false; i += 2; } continue; }
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '/' && n === '/') { inLine = true; continue; }
    if (c === '"' && s.substr(i, 3) === '"""') { inTri = true; i += 2; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && n === '*') { if (depth === 0) startLine = line; depth++; i++; continue; }
    if (c === '*' && n === '/') { depth--; i++; continue; }
  }
  console.log(f.padEnd(24), '未闭合注释深度:', depth, depth > 0 ? '<<< 首个未闭合 /* 在第 ' + startLine + ' 行' : 'OK');
}
