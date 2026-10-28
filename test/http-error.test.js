// fetch / undici 的错误必须"说人话"。
//
// 踩过的坑：代理拒绝 CONNECT 时，同步记录里只有 `fetch failed` + `code=0`，
// 完全看不出是代理问题。真实原因被 undici 埋了三层：
//   TypeError: fetch failed
//     cause: DOMException { message: 'Request was cancelled.', code: 0 }   ← 数字 0，不是错误码
//       cause: AbortError { message: 'Proxy response (407) !== 200 when HTTP Tunneling' }
// 这里把"挖到底层"的行为锁住。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { explainError, fetchText } from '../src/http.js';

/** 复刻 undici 8.x ProxyAgent 的包装形状。 */
function proxyTunnelError(status) {
  const inner = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), {
    name: 'AbortError',
    code: 'UND_ERR_ABORTED',
  });
  const cancelled = Object.assign(new Error('Request was cancelled.'), { name: 'Error', code: 0, cause: inner });
  return new TypeError('fetch failed', { cause: cancelled });
}

test('代理拒绝隧道：挖到最底层，给出状态码与可操作提示', () => {
  const cases = [
    [407, /认证/],
    [403, /拒绝/],
    [405, /CONNECT/],
    [502, /代理/],
  ];
  for (const [status, re] of cases) {
    const info = explainError(proxyTunnelError(status));
    assert.equal(info.code, `PROXY_${status}`, `HTTP ${status} 要变成 PROXY_${status}`);
    assert.equal(info.proxyStatus, status);
    assert.match(info.hint, re);
    assert.equal(info.cause, `代理 CONNECT 返回 ${status}`);
    assert.equal(info.retryable, status >= 500, '4xx 是配置问题，重试没有意义；5xx 才重试');
  }
});

test('DOMException 的 code=0 不会被当成错误码', () => {
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Request was cancelled.'), { code: 0 }),
  });
  const info = explainError(err);
  assert.equal(info.code, '', 'code=0 是 DOMException 的"未知"，不能当网络错误码');
  assert.equal(info.hint, '');
});

test('普通网络错误仍按 code 给出中文提示，并带上最底层原因', () => {
  const reset = new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
  const info = explainError(reset);
  assert.equal(info.code, 'ECONNRESET');
  assert.match(info.hint, /重置/);
  assert.equal(info.cause, 'read ECONNRESET');
  assert.equal(info.proxyStatus, null);

  const dns = new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.steampowered.com'), { code: 'ENOTFOUND' }),
  });
  assert.equal(explainError(dns).code, 'ENOTFOUND');
  assert.match(explainError(dns).hint, /DNS/);
});

test('fetchText：代理 407 不重试，错误信息带状态码与处理办法', async () => {
  const events = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (event, fields) => events.push([event, fields]),
    error: (event, fields) => events.push([event, fields]),
  };
  let calls = 0;
  await assert.rejects(
    fetchText('https://api.steampowered.com/IStoreService/GetAppList/v1/', {
      logger,
      retries: 2,
      fetchImpl: async () => {
        calls += 1;
        throw proxyTunnelError(407);
      },
    }),
    (err) => {
      assert.match(err.message, /PROXY_407/, '错误信息要带可检索的状态码');
      assert.match(err.message, /认证/, '要告诉用户去填账号密码');
      assert.equal(err.code, 'PROXY_407');
      assert.equal(err.proxyStatus, 407);
      return true;
    },
  );
  assert.equal(calls, 1, '407 是配置错误，不能傻重试 3 次');

  const warn = events.find(([event]) => event === 'http.error');
  assert.ok(warn, '必须落一条 http.error');
  assert.equal(warn[1].code, 'PROXY_407');
  assert.equal(warn[1].proxyStatus, 407);
  assert.equal(warn[1].retryable, false);
  assert.equal(warn[1].cause, '代理 CONNECT 返回 407', '日志里要能看到真实原因，而不是 Request was cancelled.');
});

test('fetchText：代理 502 会重试（代理上游抖动值得再试）', async () => {
  let calls = 0;
  await assert.rejects(
    fetchText('https://api.steampowered.com/', {
      retries: 1,
      fetchImpl: async () => {
        calls += 1;
        throw proxyTunnelError(502);
      },
    }),
    /PROXY_502/,
  );
  assert.equal(calls, 2, '502 应重试一次（共 2 次请求）');
});

// ---------------------------------------------------------------- 真实代理链路（离线）

/** 起一个只回 CONNECT 指定状态码的代理。返回 {port, hits, close}。 */
async function fakeConnectProxy(status) {
  const hits = [];
  const server = http.createServer((req, res) => res.writeHead(400).end('not a proxy request'));
  server.on('connect', (req, socket) => {
    hits.push(req.url);
    socket.end(`HTTP/1.1 ${status} ${status === 407 ? 'Proxy Authentication Required' : 'Forbidden'}\r\n\r\n`);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { port, hits, close: () => new Promise((r) => server.close(r)) };
}

async function withSteamProxy(url, fn) {
  const saved = { ...process.env };
  process.env.STEAM_PROXY = url;
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

test('真实 undici ProxyAgent：代理回 407 时同步记录显示 PROXY_407，且只请求一次', async () => {
  const proxy = await fakeConnectProxy(407);
  try {
    await withSteamProxy(`http://127.0.0.1:${proxy.port}`, async () => {
      await assert.rejects(
        fetchText('https://api.steampowered.com/IStoreService/GetAppList/v1/', { retries: 2, timeoutMs: 5000 }),
        (err) => {
          assert.equal(err.code, 'PROXY_407');
          assert.equal(err.proxyStatus, 407);
          assert.equal(err.via, 'steam-proxy');
          assert.match(err.message, /PROXY_407/);
          assert.match(err.message, /认证/, '要告诉用户去填代理账号密码');
          assert.match(err.message, /经 steam-proxy/, '保留出网通道信息');
          return true;
        },
      );
      assert.equal(proxy.hits.length, 1, '403/407 是配置错误，不应重试');
      assert.equal(proxy.hits[0], 'api.steampowered.com:443', 'CONNECT 的目标必须是 Steam API');
    });
  } finally {
    await proxy.close();
  }
});

test('连不上代理时，提示指向代理本身而不是目标站点', async () => {
  const proxy = await fakeConnectProxy(200);
  const { port } = proxy;
  await proxy.close(); // 端口关掉，模拟代理没启动
  await withSteamProxy(`http://127.0.0.1:${port}`, async () => {
    await assert.rejects(
      fetchText('https://api.steampowered.com/x', { retries: 0, timeoutMs: 4000 }),
      (err) => {
        assert.equal(err.code, 'ECONNREFUSED');
        assert.match(err.message, /连不上代理/);
        assert.match(err.message, /127\.0\.0\.1/, '要带上是哪个代理地址');
        return true;
      },
    );
  });
});

test('真实 undici ProxyAgent：代理回 502 时按可重试处理', async () => {
  const proxy = await fakeConnectProxy(502);
  try {
    await withSteamProxy(`http://127.0.0.1:${proxy.port}`, async () => {
      await assert.rejects(
        fetchText('https://api.steampowered.com/x', { retries: 1, timeoutMs: 5000 }),
        /PROXY_502/,
      );
      assert.equal(proxy.hits.length, 2, '502 是代理侧故障，应该重试');
    });
  } finally {
    await proxy.close();
  }
});
