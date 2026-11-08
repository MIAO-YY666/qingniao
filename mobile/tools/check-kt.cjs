const fs = require('fs');
const { execSync } = require('child_process');
const files = execSync('find app/src/main/java -name "*.kt"', { cwd: process.cwd() }).toString().trim().split('\n');
let bad = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  let braces = 0, parens = 0, inTri = false, inLine = false, inBlock = false, inStr = false, inChr = false, prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '/' && prev === '*') inBlock = false; prev = c; continue; }
    if (inTri) { if (c === '"' && s.substr(i, 3) === '"""') { inTri = false; i += 2; } continue; }
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (inChr) { if (c === '\\') i++; else if (c === "'") inChr = false; continue; }
    if (c === '/' && n === '/') { inLine = true; continue; }
    if (c === '/' && n === '*') { inBlock = true; prev = ''; continue; }
    if (c === "'" && n !== "'") { inChr = true; continue; }
    if (c === '"' && s.substr(i, 3) === '"""') { inTri = true; i += 2; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') braces++;
    if (c === '}') braces--;
    if (c === '(') parens++;
    if (c === ')') parens--;
  }
  const ok = braces === 0 && parens === 0 && !inTri && !inStr;
  if (!ok) bad++;
  console.log('KT', ok ? 'OK  ' : 'FAIL', f, ok ? '' : `braces=${braces} parens=${parens} inTri=${inTri} inStr=${inStr}`);
}
console.log(bad ? '*** 有结构问题 ***' : '=== 全部 KT 结构 OK ===');
process.exit(bad ? 1 : 0);
