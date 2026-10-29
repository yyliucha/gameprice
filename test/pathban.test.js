// 路径封禁 + 限流分桶 + 拦截日志的集成测试（真 PGlite + 真 HTTP）。
// 锁住几条底线：正常页面/资源永不封、扫描器立刻封但不永久、拦截日志采样且不算访问、静态资源不占页面阈值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';
import * as ratelimit from '../src/ratelimit.js';
import * as guard from '../src/guard.js';
import * as visitors from '../src/visitors.js';

const WEB = fileURLToPath(new URL('../web', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

process.env.TRUST_PROXY = '1'; // 用 X-Forwarded-For 模拟公网客户端
process.env.CAPTCHA_ENABLED = '0';

const ENV_DEFAULTS = {
  RATE_LIMIT_ENABLED: '1',
  RATE_LIMIT_MAX: '1000',
  RATE_LIMIT_ASSET_MAX: '1000',
  RATE_LIMIT_WINDOW_SEC: '60',
  PATH_BAN_ENABLED: '1',
  PATH_BAN_SIGNATURE_MODE: 'block',
  PATH_BAN_UNKNOWN_MODE: 'log',
  PATH_BAN_UNKNOWN_MAX: '30',
  PATH_BAN_UNKNOWN_WINDOW_SEC: '600',
  PATH_BAN_MINUTES: '60',
  PATH_BAN_REPEAT_MINUTES: '1440',
};

async function boot(env = {}) {
  Object.assign(process.env, ENV_DEFAULTS, env);
  ratelimit.resetState();
  guard.resetState();
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  const srv = await startApiServer({
    query: q,
    outDir: WEB,
    port: 0,
    host: '127.0.0.1',
    getSetupState: async () => ({ completed: true }),
    imageFetch: async () => ({ body: PNG, bytes: PNG.length, contentType: 'image/png' }),
  });
  return {
    store,
    q,
    base: `http://127.0.0.1:${srv.port}`,
    close: async () => {
      await srv.close();
      await store.close();
    },
  };
}

const asIp = (ip) => ({ headers: { 'x-forwarded-for': ip } });
const get = (base, ip, path) => fetch(base + path, asIp(ip));

async function waitFor(fn, { timeoutMs = 3000, stepMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor 超时；最后值：' + JSON.stringify(last));
}

test('XFF 伪造：只信最后一跳 / X-Real-IP，非 IP 不采信', () => {
  const multi = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } };
  assert.equal(visitors.clientIp(multi), '5.6.7.8', '第一个值可能是客户端伪造的');
  const bad = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': 'deadbeef' } };
  assert.equal(visitors.clientIp(bad), '127.0.0.1', '非 IP 不能当生效地址');
  const real = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' } };
  assert.equal(visitors.clientIp(real), '9.9.9.9', 'X-Real-IP 由代理覆盖写入，优先');
});

test('扫描器路径：立即 403 + 临时封禁，绝不自动永久', async () => {
  const { q, base, close } = await boot();
  try {
    const res = await get(base, '203.0.113.9', '/.env');
    assert.equal(res.status, 403);

    const row = (await q("select path_strikes, ban_source, banned_until from ip_abuse where ip = '203.0.113.9'")).rows[0];
    assert.equal(row.path_strikes, 1);
    assert.equal(row.ban_source, 'path');
    assert.ok(new Date(row.banned_until).getTime() > Date.now(), '应该处于封禁中');
    const black = (await q('select count(*)::int as n from ip_blacklist')).rows[0].n;
    assert.equal(black, 0, '路径封禁不能写永久黑名单');

    // 封禁期内：整站 429，且不会升级成永久
    for (let i = 0; i < 5; i += 1) assert.equal((await get(base, '203.0.113.9', '/')).status, 429);
    assert.equal((await q('select count(*)::int as n from ip_blacklist')).rows[0].n, 0);

    // 管理员解封后恢复
    await ratelimit.unban(q, '203.0.113.9');
    assert.equal((await get(base, '203.0.113.9', '/')).status, 200);
  } finally {
    await close();
  }
});

test('正常页面 + 封面 + 图标：一个都不能封', async () => {
  const { q, base, close } = await boot({ PATH_BAN_UNKNOWN_MODE: 'block', PATH_BAN_UNKNOWN_MAX: '3' });
  try {
    for (const path of ['/', '/console', '/api/games', '/img/steam/730/capsule_sm_120', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/settings-ui.js']) {
      const res = await get(base, '198.51.100.7', path);
      assert.ok(res.status < 400, `${path} 不该失败，实际 ${res.status}`);
    }
    const abuse = (await q("select count(*)::int as n from ip_abuse where ip = '198.51.100.7'")).rows[0].n;
    assert.equal(abuse, 0, '正常浏览不应产生任何封禁记录');
  } finally {
    await close();
  }
});

test('未知路径：默认只记录；block 模式达到阈值才封，同一路径重复不算', async () => {
  const logMode = await boot({ PATH_BAN_UNKNOWN_MODE: 'log', PATH_BAN_UNKNOWN_MAX: '2' });
  try {
    for (const path of ['/x1', '/x2', '/x3']) {
      assert.equal((await get(logMode.base, '198.51.100.8', path)).status, 404);
    }
    assert.equal((await logMode.q("select count(*)::int as n from ip_abuse where ip = '198.51.100.8'")).rows[0].n, 0, 'log 模式不能封');
  } finally {
    await logMode.close();
  }

  const blockMode = await boot({ PATH_BAN_UNKNOWN_MODE: 'block', PATH_BAN_UNKNOWN_MAX: '2' });
  try {
    assert.equal((await get(blockMode.base, '198.51.100.9', '/y1')).status, 404);
    assert.equal((await get(blockMode.base, '198.51.100.9', '/y2')).status, 403, '第二个不同未知路径触发封禁');
    assert.equal((await blockMode.q('select count(*)::int as n from ip_blacklist')).rows[0].n, 0);

    // 同一个路径刷 5 次：只算 1 个不同路径，不能封
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await get(blockMode.base, '203.0.113.55', '/same')).status, 404);
    }
    assert.equal((await blockMode.q("select count(*)::int as n from ip_abuse where ip = '203.0.113.55'")).rows[0].n, 0);
  } finally {
    await blockMode.close();
  }
});

test('被拦截请求：单独标记、每 IP 每分钟采样一条，不污染访问统计', async () => {
  const { q, base, close } = await boot();
  try {
    assert.equal((await get(base, '198.51.100.10', '/.env')).status, 403);
    for (let i = 0; i < 5; i += 1) assert.equal((await get(base, '198.51.100.10', '/')).status, 429);

    const blocked = await waitFor(async () => {
      const n = (await q('select count(*)::int as n from visitor_logs where blocked')).rows[0].n;
      return n >= 1 ? n : 0;
    });
    assert.equal(blocked, 1, '同一 IP 一分钟内只记一条被拦截记录');
    const reason = (await q('select block_reason from visitor_logs where blocked')).rows[0].block_reason;
    assert.match(reason, /扫描路径|封禁/);

    const visits = await db.listVisitorLogs(q, { filter: 'visits' });
    assert.equal(visits.rows.every((r) => r.blocked === false), true);
    const onlyBlocked = await db.listVisitorLogs(q, { filter: 'blocked' });
    assert.equal(onlyBlocked.total, 1);
    const summary = await db.visitorSummary(q);
    assert.equal(summary.today_visits, 0, '被拦截的请求不算访问量');
    assert.equal(summary.today_blocked, 1);
  } finally {
    await close();
  }
});

test('访问记录接口：filter 支持 正常访问 / 被拦截 / 全部', async () => {
  const { q, base, close } = await boot();
  try {
    await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    await q('delete from visitor_logs');

    await db.insertVisitorLog(q, { ip: '198.51.100.20', path: '/', status: 200 });
    await db.insertVisitorLog(q, { ip: '198.51.100.20', path: '/.env', status: 403, blocked: true, blockReason: '扫描路径（secret-file）' });

    for (const [filter, expect] of [['visits', 1], ['blocked', 1], ['all', 2]]) {
      const res = await fetch(base + '/api/admin/visitors?filter=' + filter, {
        headers: { cookie, 'x-forwarded-for': '203.0.113.77' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.total, expect, `filter=${filter}`);
    }
  } finally {
    await close();
  }
});

test('限流分桶：静态资源不占用页面/API 的阈值', async () => {
  const { base, close } = await boot({ RATE_LIMIT_MAX: '3', RATE_LIMIT_ASSET_MAX: '100' });
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await get(base, '198.51.100.11', `/img/steam/730/capsule_sm_120?i=${i}`);
      assert.equal(res.status, 200, '静态资源不该触发页面阈值');
    }
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await get(base, '198.51.100.11', '/')).status, 200);
    }
    assert.equal((await get(base, '198.51.100.11', '/')).status, 429, '页面桶超过 3 次才限流');
  } finally {
    await close();
  }
});
