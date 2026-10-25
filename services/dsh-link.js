// ============================================================
// dsh-link.js —— DSH 桌面客户端固定端口转发层（bloom-hub）
// ------------------------------------------------------------
// 背景：桥接需要稳定的 DSH Web API 入口（原为 npx `dsh web` 固定 3080）。
// 桌面客户端（DeepSeek Harness.exe）内嵌同一个 web 服务，但硬编码
// `--port 0`（每次启动随机端口，如 60946）。本模块在固定端口上提供
// 反向代理：
//   · 自动发现桌面客户端当前的内嵌 web 端口（按进程 PID + netstat 枚举，
//     用自签认证 Cookie 探测甄别）
//   · HTTP 反向代理：改写 Host 与 dsh-auth-* Cookie 为目标端口的 authority
//     （BrowserAuth 的 Cookie 按 host:port 签名，密钥在 ~/.dsh/.credentials.yaml）
//   · WebSocket 升级（/api/remote.mux 事件流）原样转发
// 桌面端重启换端口后，下一次请求失败会自动重新发现，桥接无需任何改动。
// ============================================================

import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);



async function listDesktopPids(processName = 'DeepSeek Harness.exe') {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
    const pids = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m && m[1].toLowerCase() === processName.toLowerCase()) pids.push(Number(m[2]));
    }
    return pids;
  } catch {
    return [];
  }
}

async function listListeningPorts(pids) {
  if (!pids.length) return [];
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const set = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const local = parts[1];
      const pid = Number(parts[parts.length - 1]);
      if (!pids.includes(pid)) continue;
      const m = /^(127\.0\.0\.1|\[::1\]):(\d+)$/.exec(local);
      if (m && m[2] !== '0') set.add(Number(m[2]));
    }
    return [...set].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function createDshLink({ suite, log, mintCookie }) {
  const writeLog = (msg) => log(`[dsh-link] ${msg}`);
  const desktopExe = suite.paths?.dshDesktopExe || 'D:\\DeepSeekHarness\\DeepSeek Harness.exe';
  const desktopProcessName = desktopExe.split('\\').pop();
  let targetPort = null;
  let discovering = null;

  function cookieFor(port) {
    return mintCookie(`http://127.0.0.1:${port}`);
  }

  // 探测某端口是否为桌面客户端的内嵌 dsh web：带自签 Cookie POST 一个信封，
  // 只要过了认证围栏（非 401/403）就算命中。
  async function probePort(port) {
    const cookie = cookieFor(port);
    if (!cookie) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${port}/api/session/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, host: `127.0.0.1:${port}` },
        body: JSON.stringify({ type: 'client-request', rpcId: 'dsh-link-probe', method: 'session/list', payload: { args: {} } }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) return false;
      const text = await res.text();
      return text.includes('server-response') || text.includes('rpcId');
    } catch {
      return false;
    }
  }

  async function discover() {
    if (discovering) return discovering;
    discovering = (async () => {
      const pids = await listDesktopPids(desktopProcessName);
      if (!pids.length) {
        writeLog(`未发现 ${desktopProcessName} 进程，桌面客户端未运行`);
        return null;
      }
      const ports = await listListeningPorts(pids);
      for (const port of ports) {
        if (await probePort(port)) {
          if (port !== targetPort) writeLog(`已发现桌面客户端内嵌 web 端口：${port}`);
          targetPort = port;
          return port;
        }
      }
      writeLog(`桌面客户端在运行（pid ${pids.join(',')}），但其内嵌 web 尚未就绪（候选端口 ${ports.join(',') || '无'}）`);
      return null;
    })();
    try {
      return await discovering;
    } finally {
      discovering = null;
    }
  }

  async function resolveTarget() {
    if (targetPort && await probePort(targetPort)) return targetPort;
    return discover();
  }

  function rewriteCookies(headers, port) {
    // 删掉旧的 dsh-auth-*（按旧 authority 签的），换成目标端口的
    const out = { ...headers };
    const raw = out.cookie;
    if (raw) {
      const kept = String(raw).split(/;\s*/).filter((c) => c && !/^dsh-auth-/i.test(c));
      const mine = cookieFor(port);
      out.cookie = [...kept, mine].join('; ');
    } else {
      out.cookie = cookieFor(port);
    }
    out.host = `127.0.0.1:${port}`;
    delete out.origin;
    return out;
  }

  function noTargetResponse(res) {
    if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'DeepSeek Harness 桌面客户端未运行或其内嵌 web 尚未就绪；bloom-hub 保活任务会自动拉起它' }));
  }

  async function proxyReq(req, res) {
    let port = await resolveTarget();
    if (!port) {
      // 立刻重试一次发现（桌面端可能刚启动）
      await new Promise((r) => setTimeout(r, 1500));
      port = await discover();
    }
    if (!port) return noTargetResponse(res);

    const headers = rewriteCookies(req.headers, port);
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', async (err) => {
      if (targetPort !== null && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
        targetPort = null;
        const again = await resolveTarget();
        if (again && again !== port) {
          writeLog(`桌面客户端端口已变更 ${port} -> ${again}，本次请求已重路由`);
          const retryHeaders = rewriteCookies(req.headers, again);
          const retry = http.request({ host: '127.0.0.1', port: again, method: req.method, path: req.url, headers: retryHeaders }, (up) => {
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
          });
          retry.on('error', () => noTargetResponse(res));
          req.pipe(retry);
          return;
        }
      }
      noTargetResponse(res);
    });
    req.pipe(upstream);
  }

  function proxyUpgrade(req, socket, head) {
    (async () => {
      const port = await resolveTarget();
      if (!port) {
        socket.destroy();
        return;
      }
      const headers = rewriteCookies(req.headers, port);
      // 重建升级请求头（Host/Cookie 已改写为目标 authority；connection/upgrade 原样保留）
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      raw += '\r\n';

      const upstream = net.connect(port, '127.0.0.1', () => {
        upstream.write(raw + head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    })().catch(() => socket.destroy());
  }

  function listen(port, host = '127.0.0.1') {
    const server = http.createServer((req, res) => {
      proxyReq(req, res).catch(() => noTargetResponse(res));
    });
    server.on('upgrade', proxyUpgrade);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        writeLog(`DSH 固定入口已就绪：http://${host}:${port} -> 桌面客户端内嵌 web（动态发现）`);
        resolve(server);
      });
    });
  }

  function status() {
    return { targetPort, desktopExe, desktopRunning: null };
  }

  return { listen, discover, resolveTarget, status, _probePort: probePort };
}
