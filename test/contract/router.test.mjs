// 路由表契约测试：匹配 / 参数 / 鉴权 / 错误包装 / 未命中回落
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../services/router.js';

function fakeRes() {
  const res = {
    headersSent: false,
    status: null,
    body: null,
    writeHead(code) { this.status = code; this.headersSent = true; },
    end(text) { this.body = text; this.headersSent = true; }
  };
  return res;
}

function sendTo(res) {
  return (obj, code = 200) => {
    res.writeHead(code);
    res.end(JSON.stringify(obj));
  };
}

function req(method, headers = {}) {
  return { method, headers };
}

const url = (s) => new URL(s, 'http://127.0.0.1:3160');

test('精确路径命中，方法不匹配则不命中', async () => {
  const r = createRouter({ authOk: () => true });
  let hit = 0;
  r.get('/api/x', () => { hit += 1; });
  const res = fakeRes();
  assert.equal(await r.dispatch(req('GET'), res, url('/api/x'), { send: sendTo(res) }), true);
  assert.equal(hit, 1);
  assert.equal(await r.dispatch(req('POST'), res, url('/api/x'), { send: sendTo(res) }), false);
});

test('路径参数被解析进 params', async () => {
  const r = createRouter({ authOk: () => true });
  let got = null;
  r.get('/api/job/:id', ({ params }) => { got = params; });
  const res = fakeRes();
  await r.dispatch(req('GET'), res, url('/api/job/abc-123'), { send: sendTo(res) });
  assert.deepEqual(got, { id: 'abc-123' });
});

test('末尾斜杠等价', async () => {
  const r = createRouter({ authOk: () => true });
  let hit = 0;
  r.get('/healthz', () => { hit += 1; });
  const res = fakeRes();
  await r.dispatch(req('GET'), res, url('/healthz/'), { send: sendTo(res) });
  assert.equal(hit, 1);
});

test('auth:public 免令牌；默认需要令牌，失败返回 401 且不执行 handler', async () => {
  const r = createRouter({ authOk: () => false });
  let privateRan = 0;
  let publicRan = 0;
  r.get('/pub', () => { publicRan += 1; }, { auth: 'public' });
  r.get('/priv', () => { privateRan += 1; });

  const res1 = fakeRes();
  await r.dispatch(req('GET'), res1, url('/pub'), { send: sendTo(res1) });
  assert.equal(publicRan, 1);
  assert.equal(res1.status, null, 'public 路由不该被鉴权拦');

  const res2 = fakeRes();
  await r.dispatch(req('GET'), res2, url('/priv'), { send: sendTo(res2) });
  assert.equal(privateRan, 0, '未授权不应执行 handler');
  assert.equal(res2.status, 401);
});

test('handler 抛错 → 统一 502 + 错误文本（带 status 时用 status）', async () => {
  const r = createRouter({ authOk: () => true, log: () => {} });
  r.get('/boom', () => { throw new Error('炸了'); });
  r.get('/teapot', () => { const e = new Error('参数不对'); e.status = 400; throw e; });

  const res1 = fakeRes();
  await r.dispatch(req('GET'), res1, url('/boom'), { send: sendTo(res1) });
  assert.equal(res1.status, 502);
  assert.match(res1.body, /炸了/);

  const res2 = fakeRes();
  await r.dispatch(req('GET'), res2, url('/teapot'), { send: sendTo(res2) });
  assert.equal(res2.status, 400);
});

test('handler 返回对象时代为发送；返回 undefined 视为自己发过了', async () => {
  const r = createRouter({ authOk: () => true });
  r.get('/auto', () => ({ ok: true, v: 1 }));
  r.get('/manual', ({ send }) => { send({ ok: true, v: 2 }); });

  const res1 = fakeRes();
  await r.dispatch(req('GET'), res1, url('/auto'), { send: sendTo(res1) });
  assert.deepEqual(JSON.parse(res1.body), { ok: true, v: 1 });

  const res2 = fakeRes();
  await r.dispatch(req('GET'), res2, url('/manual'), { send: sendTo(res2) });
  assert.deepEqual(JSON.parse(res2.body), { ok: true, v: 2 });
});

test('ANY 方法通吃（用于 /api/xxx 拒绝所有写法的端点）', async () => {
  const r = createRouter({ authOk: () => true });
  let n = 0;
  r.any('/api/nope', () => { n += 1; });
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
    const res = fakeRes();
    assert.equal(await r.dispatch(req(m), res, url('/api/nope'), { send: sendTo(res) }), true);
  }
  assert.equal(n, 4);
});
