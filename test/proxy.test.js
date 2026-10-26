// 出网代理决策 + 真实转发链路（本地起代理与目标，离线可验证）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseProxy, parseNoProxy, shouldBypass, decideProxy, redactProxy, describeProxy } from '../src/proxy.js';
import { fetchText } from '../src/http.js';

test('代理地址解析：补齐协议、拒绝非法值、忽略非 http 代理', () => {
  assert.equal(parseProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890', '缺协议时补 http://');
  assert.equal(parseProxy('socks5://127.0.0.1:7891'), null, '不支持 socks5（undici ProxyAgent 不支持）');
  assert.equal(parseProxy(''), null);
  assert.equal(parseProxy(undefined), null);
  assert.equal(parseProxy('not a url'), null);
});

test('NO_PROXY 解析与匹配：精确、后缀、通配、端口', () => {
  assert.deepEqual(parseNoProxy('a.com, .b.com ,'), ['a.com', '.b.com']);
  assert.equal(shouldBypass('catalog.gog.com', ['gog.com']), true, '子域名应命中');
  assert.equal(shouldBypass('gog.com', ['gog.com']), true);
  assert.equal(shouldBypass('catalog.gog.com', ['.gog.com']), true);
  assert.equal(shouldBypass('catalog.gog.com', ['example.com']), false);
  assert.equal(shouldBypass('anything', ['*']), true);
  assert.equal(shouldBypass('gog.com:443', ['gog.com']), true, '带端口也能匹配');
  assert.equal(shouldBypass('notgog.com', ['gog.com']), false, '不能误伤同后缀域名');
});

test('决策：Steam 域名走 STEAM_PROXY，其余走 HTTPS_PROXY', () => {
  const env = { STEAM_PROXY: 'http://127.0.0.1:7001', HTTPS_PROXY: 'http://127.0.0.1:7002' };
  assert.deepEqual(decideProxy('store.steampowered.com', env), { via: 'steam-proxy', url: 'http://127.0.0.1:7001' });
  assert.deepEqual(decideProxy('api.steampowered.com', env), { via: 'steam-proxy', url: 'http://127.0.0.1:7001' });
  assert.deepEqual(decideProxy('catalog.gog.com', env), { via: 'proxy', url: 'http://127.0.0.1:7002' });
});

test('决策：没配 STEAM_PROXY 时 Steam 回落通用代理；都没配则直连', () => {
  assert.deepEqual(decideProxy('store.steampowered.com', { HTTPS_PROXY: 'http://127.0.0.1:7002' }), {
    via: 'proxy',
    url: 'http://127.0.0.1:7002',
  });
  assert.deepEqual(decideProxy('store.steampowered.com', {}), { via: 'direct', url: null });
  assert.deepEqual(decideProxy('catalog.gog.com', {}), { via: 'direct', url: null });
});

test('决策：NO_PROXY 能排除主机（即使配了通用代理）', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7002', NO_PROXY: 'sonkwo.hk,sonkwo.cn' };
  assert.equal(decideProxy('www.sonkwo.cn', env).via, 'direct', '境内源直连');
  assert.equal(decideProxy('catalog.gog.com', env).via, 'proxy');
});

test('决策：STEAM_PROXY 不影响非 Steam 主机', () => {
  const env = { STEAM_PROXY: 'http://127.0.0.1:7001' };
  assert.equal(decideProxy('catalog.gog.com', env).via, 'direct', '只配 Steam 代理时其它源必须直连');
});

test('代理地址里的密码不会进日志', () => {
  assert.equal(redactProxy('http://user:secret@127.0.0.1:7890'), 'http://***@127.0.0.1:7890');
  assert.equal(redactProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(redactProxy(null), null);
});

test('describeProxy 给出 Steam 与其它源的出网摘要', () => {
  const env = { STEAM_PROXY: 'http://127.0.0.1:7001', HTTPS_PROXY: 'http://127.0.0.1:7002' };
  const info = describeProxy(env);
  assert.equal(info.steam.via, 'steam-proxy');
  assert.equal(info.others.via, 'proxy');
  assert.equal(info.steam.proxy, 'http://127.0.0.1:7001');
});

// ---------------------------------------------------------------- 真实转发链路

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('fetchText 经本地代理真实转发（验证 dispatcher 接线正确）', async () => {
  const seen = [];
  // 目标服务
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, ok: true }));
  });
  const targetPort = await listen(target);

  // 代理：记录并转发 absolute-form 请求
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    const url = new URL(req.url);
    const upstream = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => res.writeHead(502).end(String(err.message)));
    req.pipe(upstream);
  });
  const proxyPort = await listen(proxy);

  const saved = { ...process.env };
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  delete process.env.STEAM_PROXY;
  delete process.env.NO_PROXY;

  try {
    const res = await fetchText(`http://127.0.0.1:${targetPort}/through-proxy`, { retries: 0 });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(seen.length, 1, '请求必须经过代理一次');
    assert.match(seen[0], new RegExp(`^http://127\\.0\\.0\\.1:${targetPort}/through-proxy`), '代理收到的是 absolute-form');
  } finally {
    process.env = saved;
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => target.close(r));
  }
});

test('没配代理时直连，不经任何代理', async () => {
  const target = http.createServer((req, res) => res.writeHead(200).end('direct-ok'));
  const targetPort = await listen(target);
  const saved = { ...process.env };
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.STEAM_PROXY;

  try {
    const res = await fetchText(`http://127.0.0.1:${targetPort}/`, { retries: 0 });
    assert.equal(res.body, 'direct-ok');
  } finally {
    process.env = saved;
    await new Promise((r) => target.close(r));
  }
});
