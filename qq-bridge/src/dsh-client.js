// Node 环境的 DSH Web API 客户端。
//
// DSH 0.1.2-rc.1 的 Host API 已经不是旧版的 `dsh-host-apiproxy` JSON API
// （`/api/host.describe`、`/api/sessions.create` 之类在 0.1.2 里根本不存在，
// 请求会 404）。现行协议是 **Typert Remote / API Gateway**：
//
//   * 一元调用：POST /api/<namespace>/<method>，正文是 client-request 信封
//     { type:'client-request', rpcId, method:'<namespace>/<method>', payload:{ args:{...} } }
//     路径与 method 都用「短名」（例如 session/list），不是完整 descriptor id。
//   * 流式调用：WebSocket /api/remote.mux，先发
//     { type:'open', streamId, endpoint, payload:{ args:{...} } }
//     再收 { type:'item', streamId, value } / { type:'end' } / { type:'error' }；取消发 { type:'cancel', streamId }。
//   * 会话事件流：stream 端点 `session/follow`（`request.address = {kind:'session', sessionId}`），
//     首个 item 是 snapshot，其后是 { type:'event', event:{type,seq,time,data} }。
//   * Host 转发事件（agent 提问 / 工具审批）：stream 端点 `$events`，首帧 { type:'ready', clientId, host }，
//     其后是 waterfall/emit/cancel 帧；waterfall 必须用
//     POST /api/$events/result { clientId, eventId, outcome } 回执。
//
// 本模块把这套协议包成桥接其余代码已经在用的 `api.<namespace>.<method>()` 形状，
// 这样 bridge.js 只需要改「连接/事件泵/回执」三处。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// DSH /api 认证
//
// /api 由 client-connection 的 BrowserAuth 把关：只认 HMAC-SHA256 签名的
// 「浏览器会话 Cookie」，签名密钥存在 <DSH_HOME>/.credentials.yaml 的
// client-connection/browser-session 记录里。桥接进程不是浏览器，拿不到
// ?token= 启动令牌交换，因此必须按同一算法自签一枚 Cookie，
// 否则每个请求都会被 401 unauthorized 拒掉。
// ---------------------------------------------------------------------------

const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const SECRET_BYTES = 32;
const DEFAULT_COOKIE_DAYS = 30;

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从 .credentials.yaml 取 client-connection/browser-session 的 secret（按缩进定位，避免误取别的 secret）。 */
function readBrowserSessionSecret(credentialsFile) {
  let text;
  try {
    text = fs.readFileSync(credentialsFile, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/u);
  const keyPattern = /^(\s*)client-connection\/browser-session:\s*$/u;
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start === -1) return undefined;
  const keyIndent = keyPattern.exec(lines[start])[1].length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s*/u.exec(line)[0].length <= keyIndent) break;
    const match = /^\s*secret:\s*(\S+)\s*$/u.exec(line);
    if (match) {
      const secret = decodeBase64Url(match[1]);
      return secret !== undefined && secret.byteLength === SECRET_BYTES ? secret : undefined;
    }
  }
  return undefined;
}

/**
 * 生成一枚与 DSH BrowserAuth 完全一致的会话 Cookie。
 * @returns undefined 表示本机没有可用的凭据文件。
 */
export function mintDshAuthCookie(baseUrl, options = {}) {
  if (options.cookie) return options.cookie;
  const credentialsFile = options.credentialsFile ?? path.join(dshHome(), '.credentials.yaml');
  const secret = readBrowserSessionSecret(credentialsFile);
  if (secret === undefined) return undefined;
  let authority;
  try {
    authority = new URL(baseUrl).host;
  } catch {
    return undefined;
  }
  const days = Number.isFinite(options.days) ? options.days : DEFAULT_COOKIE_DAYS;
  const name = COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt: now,
    expiresAt: now + days * 24 * 60 * 60 * 1000,
  };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

// ---------------------------------------------------------------------------
// 协议信封
// ---------------------------------------------------------------------------

function ok(rpcId, value) {
  return { rpcId, result: { ok: true, value } };
}

function fail(rpcId, code, message, details = {}) {
  return { rpcId, result: { ok: false, error: { code, message, details } } };
}

/** 把一次一元调用折叠成旧版 RpcResponse 形状，并保证不抛（调用方用 unwrap 取结果）。 */
async function settle(rpcId, run) {
  try {
    return ok(rpcId, await run());
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'bridge/transport';
    return fail(rpcId, code, String(error?.message ?? error));
  }
}

/** 把 "ns/method" 规范成 HTTP 路径用的短名（已经是短名时原样返回）。 */
function shortMethod(method) {
  const at = method.lastIndexOf('#');
  return at === -1 ? method : method.slice(at + 1);
}

export class NodeApiClient {
  constructor(baseUrl, timeoutMs, auth) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
    this.authCookie = mintDshAuthCookie(this.baseUrl, auth ?? {});
    this.streamSeq = 0;
    this.sessions = this.#sessionsNamespace();
    this.host = this.#hostNamespace();
    this.settings = this.#settingsNamespace();
    this.workspace = this.#workspaceNamespace();
    this.agentPresets = this.#agentPresetsNamespace();
    this.events = this.#eventsNamespace();
  }

  // ── 传输 ────────────────────────────────────────────────────────────────

  wsUrl(pathname) {
    const url = new URL(pathname, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  }

  nextStreamId() {
    this.streamSeq += 1;
    return `qq-bridge-${process.pid}-${Date.now().toString(36)}-${this.streamSeq}`;
  }

  /** 一元 RPC：POST /api/<method>。抛错由调用方的 settle 收成 error 信封。 */
  async call(method, args = {}) {
    const endpoint = shortMethod(method);
    const rpcId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authCookie === undefined ? {} : { cookie: this.authCookie }),
        },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      const error = new Error(
        `DSH /api 拒绝了请求（HTTP ${response.status}）。请确认桥接能读到 ${path.join(dshHome(), '.credentials.yaml')} 的会话密钥。`,
      );
      error.code = `bridge/http-${response.status}`;
      throw error;
    }
    if (response.status !== 200) {
      throw new Error(`DSH ${endpoint} 返回 HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`DSH ${endpoint} 返回了非 JSON 响应: ${text.slice(0, 200)}`);
    }
    const result = body?.result;
    if (result?.ok === true) return result.value;
    const error = new Error(`${result?.error?.code ?? 'bridge/unknown'}: ${result?.error?.message ?? 'DSH 调用失败'}`);
    error.code = result?.error?.code ?? 'bridge/unknown';
    error.details = result?.error?.details ?? {};
    throw error;
  }

  /**
   * 打开一条 Remote 流。返回 async generator，逐个产出 `value`；
   * 端点级 error 帧与连接断开以异常形式抛出，由调用方决定是否重连。
   */
  async *openStream(endpoint, args, signal, onReady) {
    const streamId = this.nextStreamId();
    // Node 内置 WebSocket（undici）支持 headers 选项（浏览器不支持），用它带会话 Cookie。
    const socket = this.authCookie === undefined
      ? new WebSocket(this.wsUrl('/api/remote.mux'))
      : new WebSocket(this.wsUrl('/api/remote.mux'), { headers: { cookie: this.authCookie } });
    const inbox = [];
    let wake;
    let failure;
    let closed = false;
    // WebSocket 生命周期：abort 与 finally 都会尝试关闭，必须只关一次并及时摘掉监听器。
    // 否则 undici 的 WebSocket 在句柄已释放后再被 close()/send() 会触发 libuv
    // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 直接崩掉进程。
    let disposed = false;
    const push = (item, error) => {
      if (error !== undefined) failure = error;
      else inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const detach = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      if (disposed) return;
      try {
        socket.send(
          JSON.stringify({ type: 'open', streamId, endpoint: shortMethod(endpoint), payload: { args } }),
        );
      } catch (error) {
        push(undefined, new Error(`DSH 流 ${endpoint} 发送 open 失败: ${String(error?.message ?? error)}`));
      }
    };
    const onMessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (error) {
        push(undefined, new Error(`DSH 流 ${endpoint} 收到非 JSON 帧: ${String(error)}`));
        return;
      }
      if (frame.type === 'item') {
        onReady?.(frame.value);
        push(frame.value);
        return;
      }
      if (frame.type === 'end') {
        push(undefined, new Error(`DSH 流 ${endpoint} 已结束`));
        return;
      }
      if (frame.type === 'error') {
        const error = new Error(
          `DSH 流 ${endpoint} 报错: ${frame.error?.code ?? '?'}: ${frame.error?.message ?? '?'}`,
        );
        error.code = frame.error?.code;
        push(undefined, error);
      }
    };
    const onClose = () => {
      closed = true;
      push(undefined, new Error(`DSH 流 ${endpoint} 连接已关闭`));
    };
    const onError = () => {
      closed = true;
      push(undefined, new Error(`DSH 流 ${endpoint} 连接出错`));
    };
    /** 只关一次：先摘监听器，再取消流、关闭 socket。 */
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      detach();
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }));
        }
      } catch {}
      try {
        socket.close();
      } catch {}
      wake?.();
      wake = undefined;
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose, { once: true });
    socket.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', dispose, { once: true });
    if (signal?.aborted) dispose();
    try {
      while (true) {
        while (inbox.length > 0) yield inbox.shift();
        if (signal?.aborted) return;
        if (failure !== undefined) throw failure;
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal?.removeEventListener('abort', dispose);
      dispose();
    }
  }

  // ── 命名空间 ────────────────────────────────────────────────────────────

  #sessionsNamespace() {
    const self = this;
    return {
      create: (params = {}) =>
        settle('session.create', async () => {
          const workspaceId = params.workspaceId;
          const value = await self.call('session/create', {
            request: {
              ...(workspaceId === undefined ? {} : { workspaceId }),
              ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
              ...(params.agentPreset === undefined ? {} : { agentPreset: params.agentPreset }),
            },
          });
          return { sessionId: value.sessionId, agentPreset: value.agentPreset };
        }),
      prompt: (params = {}) =>
        settle('session.prompt', () => {
          const requestId = params.requestId ?? randomUUID();
          return self.call('session/prompt', {
            request: {
              requestId,
              sessionId: params.sessionId,
              mode: params.mode === 'steer' ? 'steer' : 'queue',
              content: params.content ?? [],
            },
          });
        }),
      cancel: (params = {}) =>
        settle('session.cancel', () =>
          self.call('session/cancel', { request: { sessionId: params.sessionId } }),
        ),
      selectModel: (params = {}) =>
        settle('session.selectModel', async () => {
          // 先确认这个 provider/model 在当前 catalog 里可用：配置里写了不存在的模型时，
          // 旧版只会打日志，这里保持同样的“不阻塞启动”行为。
          const catalog = await self.call('session/modelCatalog');
          const effort = params.reasoningEffort;
          const available = (catalog.groups ?? []).some((group) =>
            group.id === params.provider && (group.models ?? []).some((model) => model.id === params.model),
          );
          if (!available) {
            throw new Error(`模型 ${params.provider}/${params.model} 不在当前 DSH 的可用模型列表里`);
          }
          const value = await self.call('session/selectModel', {
            request: {
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.model,
              ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort }),
            },
          });
          return value;
        }),
      rename: (params = {}) =>
        settle('session.rename', () =>
          self.call('session/rename', { request: { sessionId: params.sessionId, title: params.title } }),
        ),
      modelCatalog: () => settle('session.modelCatalog', () => self.call('session/modelCatalog')),
    };
  }

  #hostNamespace() {
    const self = this;
    return {
      // 新版没有 host.describe 端点；用一次真实的 Host 读操作做探活，
      // 返回 { ok:true, items:[...] }，checkDsh 只看它是否抛错。
      describe: () =>
        settle('host.describe', async () => {
          const value = await self.call('session/list', { _request: {} });
          return { ok: true, items: value.items ?? [] };
        }),
    };
  }

  #settingsNamespace() {
    const self = this;
    return {
      describe: (params = {}) =>
        settle('settings.describe', () => {
          const args = {};
          if (params.request !== undefined) args.request = params.request;
          return self.call('settings/describe', args);
        }),
      mutate: (params = {}) =>
        settle('settings.mutate', () => {
          const request = params.request ?? {};
          return self.call('settings/mutate', { request });
        }),
    };
  }

  #workspaceNamespace() {
    const self = this;
    return {
      create: (params = {}) =>
        settle('workspace.create', () => self.call('workspace/create', { request: { path: params.path } })),
      rename: (params = {}) =>
        settle('workspace.rename', () =>
          self.call('workspace/rename', { request: { workspaceId: params.workspaceId, title: params.title } }),
        ),
      delete: (params = {}) =>
        settle('workspace.delete', () =>
          self.call('workspace/delete', { request: { workspaceId: params.workspaceId } }),
        ),
      archiveSession: (params = {}) =>
        settle('workspace.archiveSession', () =>
          self.call('workspace/archiveSession', { request: { sessionId: params.sessionId } }),
        ),
      list: () =>
        settle('workspace.list', async () => {
          // 新协议没有 workspace/list 一元端点；workspace/follow 的首帧 baseline
          // 就带完整注册表（无参数，多传 request 会被判 arguments-invalid）。
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), self.timeoutMs);
          try {
            for await (const value of self.openStream('workspace/follow', {}, controller.signal)) {
              if (value?.type === 'baseline') {
                return {
                  items: value.value.items,
                  archivedSessionIds: value.value.archivedSessionIds,
                };
              }
            }
            return { items: [], archivedSessionIds: [] };
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
        }),
    };
  }

  #agentPresetsNamespace() {
    const self = this;
    return {
      list: (params = {}) =>
        settle('agentPreset.list', () =>
          self.call('@deepseek-ai/dsh-agent-presets#agentPresets/list', params.request ?? {}),
        ),
    };
  }

  /**
   * 会话事件流：`session/follow`。
   * 产出旧版 events.mux 的帧形状 `{ type:'session/event', sessionId, event }`，
   * 这样 bridge.js 里既有的帧处理逻辑不用改。
   */
  #eventsNamespace() {
    const self = this;
    return {
      session: (sessionId, opts = {}) =>
        self.#sessionEvents(sessionId, opts),
      /**
       * 兼容旧调用 `api.events.mux({})`：订阅 Host 级事件。
       * 新协议下每条会话有自己的 follow 流，因此这里订阅 `$events`（Host 转发事件），
       * 只用于审批/提问；会话事件请用 `api.events.session(sessionId)`。
       */
      mux: () => self.#forwardedEvents(),
    };
  }

  /**
   * 会话事件流：`session/follow`，产出桥接用的 `{ type:'session/event', sessionId, event }` 帧。
   *
   * ⚠️ 关键：follow 的首帧 `snapshot` 把**已有历史事件全部装在 `records[]` 里**，
   * 而不是逐个 item 推。这些 record 的形状是 `{ type:'event', event:{...} }`
   * （另有 `chunks` 打包行，属于存储编码、不是会话事件，必须跳过）。
   *
   * 之前这里用「等一个 `value.type === 'event'` 的 item」判断就绪并 `continue` 掉
   * snapshot，导致两件事同时出错：
   *   1. 整批初始事件被丢弃 —— 尤其是那个终结回合的 `turn/end`；
   *   2. 就绪信号永远不触发。
   * 后果是桥接的 turn collector 永远不清空，`isConversationBusyV2` 一直返回 true，
   * 之后所有消息都被判定「会话繁忙」而积压 —— 表现为「机器人不回消息了」。
   *
   * 现在：snapshot 先发它携带的全部 record，再发就绪信号；后续增量照常逐个发。
   */
  async *#sessionEvents(sessionId, opts) {
    const frame = (event) => ({
      rpcId: randomUUID(),
      payload: { type: 'session/event', sessionId, event },
    });
    for await (const value of this.openStream(
      'session/follow',
      { request: { address: { kind: 'session', sessionId } } },
      opts.signal,
      () => opts.onOpen?.(),
    )) {
      if (value?.type === 'snapshot') {
        for (const record of value.records ?? []) {
          if (record?.type === 'event' && record.event !== undefined) yield frame(record.event);
        }
        // 历史补完之后才算就绪：调用方在 onOpen 之后才 prompt，避免漏 turn。
        opts.onReady?.();
        continue;
      }
      if (value?.type === 'event' && value.event !== undefined) {
        yield frame(value.event);
      }
    }
  }

  /**
   * Host 转发事件：审批（approval/request）与提问（user-questions/request）waterfall。
   *
   * 注意 `$events` 的 args 契约与 session/* 不同：不是 `{ request: {...} }`，
   * 而是「空的 args 对象」。openStream 会再包一层成 `{ args }`，
   * 所以这里传 `{}`，最终载荷正是网关要求的 `{ args: {} }`
   * （传 `{ args: {} }` 会变成 `{ args: { args: {} } }` 而被拒：
   * `$events: forwarded Remote event stream requires an empty args object`）。
   */
  async *#forwardedEvents() {
    for await (const value of this.openStream('$events', {})) {
      if (value?.type === 'ready') {
        this.forwardedClientId = value.clientId;
        yield { rpcId: randomUUID(), payload: { type: 'stream/ready', host: value.host } };
        continue;
      }
      if (value?.type === 'waterfall') {
        yield {
          rpcId: randomUUID(),
          payload: {
            type: 'remote/waterfall',
            event: value.event,
            eventId: value.eventId,
            agentId: value.agentId,
            request: value.request,
          },
        };
        continue;
      }
      if (value?.type === 'emit') {
        yield { rpcId: randomUUID(), payload: { type: 'remote/emit', event: value.event, args: value.args } };
      }
    }
  }

  /**
   * 用事件 id 回执一个 waterfall 请求（提问/审批）。
   * @param eventId - `$events` 帧上的 eventId
   * @param value - listener 结果（提问答案是 `{ answers }`，审批是 outcome 字符串）
   */
  answerEvent(eventId, value) {
    const clientId = this.forwardedClientId;
    if (clientId === undefined) throw new Error('回执失败：还没有拿到 $events 的 clientId');
    if (eventId === undefined) throw new Error('回执失败：缺少 eventId');
    return this.call('$events/result', {
      clientId,
      eventId,
      outcome: { kind: 'result', value },
    });
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        // 孤立的 turn/end（本 collector 没见过对应的 turn/start）也必须算「回合已结束」。
        //
        // 为什么会出现：DSH 的 session/follow 首帧 snapshot 只给**日志尾部一个窗口**
        // （实测 recentLimit 100 左右，258 条记录里最早的是 seq 144），
        // 而 session/follow 是「每会话一条」的常驻订阅，桥接每次重启/重连都会重放窗口。
        // 于是窗口起点之后的 turn/end 会先于它的 turn/start 被看到（turn/start 在窗口之前）。
        // 旧实现这里 `if (!t) return null` 会把它丢掉，导致：
        //   collectors 里该会话的条目永远不清 → isConversationBusyV2 永远 true
        //   → 「会话繁忙，暂存唤醒原因」刷屏 → 机器人对所有消息都不回。
        // 结束事件本身是权威的：见到它就代表这个 turn 结束了，文本拿不到就当空文本。
        return {
          turn: event.data.turn,
          reason: event.data.reason,
          text: t?.text ?? ''
        };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    }
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
