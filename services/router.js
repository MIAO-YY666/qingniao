// ============================================================
// router.js —— 极简路由表（约 80 行，零依赖，不引框架）
// ------------------------------------------------------------
// 为什么要有它：
//   hub.js 的 handle() 里是 50 条平铺 `if (req.method === 'GET' && p === '/api/x')`。
//   加一个端点 = 在 996 行里找个位置插一段，鉴权靠手写、错误靠手 catch、路径参数靠正则。
//
// 它只做三件事：
//   1. 方法 + 路径匹配（支持 /api/x/:id 形式的参数段）
//   2. 统一的「鉴权 → 取 body → 执行 → 错误包装」
//   3. 未命中返回 false，让调用方回落到老 if 链（迁移期保险，可逐条搬）
//
// 明确不做：不做中间件栈、不做 schema 校验库、不做 OpenAPI 生成 —— 这个规模不需要。
// ============================================================

const PARAM_RE = /^:([A-Za-z_][\w]*)$/;

function compile(pattern) {
  const keys = [];
  const parts = String(pattern).split('/').filter((x, i) => i > 0 || x !== '');
  const source = parts
    .map((seg) => {
      const m = PARAM_RE.exec(seg);
      if (m) {
        keys.push(m[1]);
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^/${source}/?$`), keys };
}

export function createRouter({ log, authOk } = {}) {
  const routes = [];

  /**
   * @param {string} method  GET / POST / ANY
   * @param {string} pattern '/api/x/:id'
   * @param {(ctx:object)=>any} handler
   * @param {{auth?: 'public'|'token', name?: string}} [opts]
   */
  function add(method, pattern, handler, opts = {}) {
    const { re, keys } = compile(pattern);
    routes.push({
      method: String(method).toUpperCase(),
      pattern,
      re,
      keys,
      handler,
      auth: opts.auth || 'token',
      name: opts.name || pattern
    });
    return routes.length - 1;
  }

  const get = (p, h, o) => add('GET', p, h, o);
  const post = (p, h, o) => add('POST', p, h, o);
  const any = (p, h, o) => add('ANY', p, h, o);

  /** 返回 true 表示已处理（调用方直接 return）；false 表示没命中，继续走老链路 */
  async function dispatch(req, res, url, ctx = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    for (const r of routes) {
      if (r.method !== 'ANY' && r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;

      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      if (r.auth !== 'public' && typeof authOk === 'function' && !authOk(req, url)) {
        ctx.send?.({ ok: false, error: '未授权：请提供管理平台访问令牌（?token= 或 x-hub-token）' }, 401);
        return true;
      }

      try {
        const out = await r.handler({ req, res, url, params, send: ctx.send, readJsonBody: ctx.readJsonBody, ctx });
        // handler 自己调了 send 就返回 undefined；返回对象则代发
        if (out !== undefined && !res.headersSent) ctx.send?.(out);
      } catch (e) {
        const status = Number(e?.status) || 502;
        log?.(`[router] ${r.name} 失败：${e?.message || e}`);
        if (!res.headersSent) ctx.send?.({ ok: false, error: String(e?.message || e) }, status);
      }
      return true;
    }
    return false;
  }

  function list() {
    return routes.map((r) => `${r.method} ${r.pattern}${r.auth === 'public' ? ' (public)' : ''}`);
  }

  return { add, get, post, any, dispatch, list, routes };
}

export default { createRouter };
