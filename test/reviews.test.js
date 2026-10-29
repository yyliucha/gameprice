// 异常请求审核 + 限流分桶 + 封禁提示页 + 设备封禁（真 PGlite + 真 HTTP）。
// 新规则：**不自动封禁**，异常只记录，管理员审批后才封 IP / 设备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';
import * as ratelimit from '../src/ratelimit.js';
import * as guard from '../src/guard.js';
import * as devices from '../src/devices.js';
import * as visitors from '../src/visitors.js';

const WEB = fileURLToPath(new URL('../web', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

process.env.TRUST_PROXY = '1'; // 用 X-Forwarded-For 模拟公网客户端
process.env.CAPTCHA_ENABLED = '0';
process.env.APPEAL_EMAIL = 'appeal@example.com';
process.env.SITE_NAME = 'SteamDeals-Test';

const ENV_DEFAULTS = {
  RATE_LIMIT_ENABLED: '1',
  RATE_LIMIT_MAX: '1000',
  RATE_LIMIT_ASSET_MAX: '1000',
  RATE_LIMIT_WINDOW_SEC: '60',
  PATH_REVIEW_ENABLED: '1',
  PATH_REVIEW_UNKNOWN_MAX: '30',
  PATH_REVIEW_UNKNOWN_WINDOW_SEC: '600',
};

async function boot(env = {}, { admin = false } = {}) {
  Object.assign(process.env, ENV_DEFAULTS, env);
  ratelimit.resetState();
  guard.resetState();
  devices.resetState();
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  if (admin) await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
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

const asIp = (ip, extra = {}) => ({ headers: { 'x-forwarded-for': ip, ...extra } });
const get = (base, ip, path, extra = {}) => fetch(base + path, asIp(ip, extra));

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

async function loginAdmin(base) {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
  });
  assert.equal(res.status, 200, '管理员登录失败');
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

test('XFF 伪造：只信最后一跳 / X-Real-IP，非 IP 不采信', () => {
  const multi = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } };
  assert.equal(visitors.clientIp(multi), '5.6.7.8', '第一个值可能是客户端伪造的');
  const bad = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': 'deadbeef' } };
  assert.equal(visitors.clientIp(bad), '127.0.0.1', '非 IP 不能当生效地址');
  const real = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' } };
  assert.equal(visitors.clientIp(real), '9.9.9.9', 'X-Real-IP 由代理覆盖写入，优先');
});

test('扫描器路径：只记录待审核，不封禁、不返回 403', async () => {
  const { q, base, close } = await boot();
  try {
    const res = await get(base, '203.0.113.9', '/.env');
    assert.equal(res.status, 404, '不存在就是 404，不暴露"已识别"');
    const review = (await q("select ip, rule, hits, status from abuse_reviews where ip = '203.0.113.9'")).rows[0];
    assert.ok(review, '应写入一条待审核记录');
    assert.equal(review.rule, 'secret-file');
    assert.equal(review.status, 'pending');
    assert.equal((await q('select count(*)::int as n from ip_blacklist')).rows[0].n, 0, '不能自动封 IP');
    assert.equal((await q('select count(*)::int as n from device_bans')).rows[0].n, 0, '不能自动封设备');
    // 同一个 IP 继续正常访问：不受影响
    assert.equal((await get(base, '203.0.113.9', '/')).status, 200);
  } finally {
    await close();
  }
});

test('正常页面 + 封面 + 图标：不产生任何审核记录', async () => {
  const { q, base, close } = await boot({ PATH_REVIEW_UNKNOWN_MAX: '3' });
  try {
    for (const path of ['/', '/console', '/api/games', '/img/steam/730/capsule_sm_120', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/settings-ui.js']) {
      const res = await get(base, '198.51.100.7', path);
      assert.ok(res.status < 400, `${path} 不该失败，实际 ${res.status}`);
    }
    assert.equal((await q('select count(*)::int as n from abuse_reviews')).rows[0].n, 0, '正常浏览不能进审核');
  } finally {
    await close();
  }
});

test('未知路径：达到阈值才记录；同一路径重复刷新不算新路径', async () => {
  const { q, base, close } = await boot({ PATH_REVIEW_UNKNOWN_MAX: '2' });
  try {
    assert.equal((await get(base, '198.51.100.8', '/x1')).status, 404);
    assert.equal((await q('select count(*)::int as n from abuse_reviews')).rows[0].n, 0, '一个未知路径还不够阈值');
    assert.equal((await get(base, '198.51.100.8', '/x2')).status, 404);
    const review = (await q("select rule, hits from abuse_reviews where ip = '198.51.100.8'")).rows[0];
    assert.ok(review, '第二个不同未知路径应触发审核');
    assert.equal(review.rule, 'unknown-paths');

    for (let i = 0; i < 6; i += 1) await get(base, '203.0.113.55', '/same');
    assert.equal((await q("select count(*)::int as n from abuse_reviews where ip = '203.0.113.55'")).rows[0].n, 0, '同一路径重复不能算扫描');
  } finally {
    await close();
  }
});

test('超频：临时限流 429 + 待审核，不写永久黑名单', async () => {
  const { q, base, close } = await boot({ RATE_LIMIT_MAX: '2' });
  try {
    assert.equal((await get(base, '198.51.100.9', '/')).status, 200);
    assert.equal((await get(base, '198.51.100.9', '/')).status, 200);
    const third = await get(base, '198.51.100.9', '/');
    assert.equal(third.status, 429);
    const review = (await q("select rule, status from abuse_reviews where ip = '198.51.100.9'")).rows[0];
    assert.ok(review, '超频要进待审核');
    assert.equal(review.rule, 'rate-limit');
    assert.equal((await q('select count(*)::int as n from ip_blacklist')).rows[0].n, 0, '不能自动永久封');
  } finally {
    await close();
  }
});

test('管理员审批：封 IP 后整站 403，浏览器拿到多语言提示页（含申诉邮箱）', async () => {
  const { q, base, close } = await boot({}, { admin: true });
  try {
    await get(base, '198.51.100.10', '/.env');
    await waitFor(async () => (await q("select count(*)::int as n from abuse_reviews where status = 'pending'")).rows[0].n >= 1);
    const cookie = await loginAdmin(base);

    const list = await (await fetch(base + '/api/admin/reviews?status=pending', { headers: { cookie, 'x-forwarded-for': '203.0.113.77' } })).json();
    const review = list.reviews.find((r) => r.ip === '198.51.100.10');
    assert.ok(review, '待审核列表里应该有这个 IP');

    const approve = await fetch(base + '/api/admin/reviews/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ id: review.id, mode: 'ip' }),
    });
    assert.equal(approve.status, 200);
    assert.ok((await q("select count(*)::int as n from ip_blacklist where ip = '198.51.100.10'")).rows[0].n >= 1, '审批后应进黑名单');

    const api = await get(base, '198.51.100.10', '/api/games');
    assert.equal(api.status, 403);
    const page = await get(base, '198.51.100.10', '/', { accept: 'text/html' });
    assert.equal(page.status, 403);
    const html = await page.text();
    assert.match(html, /SteamDeals-Test/);
    assert.match(html, /appeal@example\.com/);
    assert.doesNotMatch(html, /__SITE_NAME__|__APPEAL_EMAIL__/, '占位符必须被替换');
  } finally {
    await close();
  }
});

test('设备指纹：上报落库 + 管理员封设备后 POST 返回 banned，页面直接 403', async () => {
  const { q, base, close } = await boot({}, { admin: true });
  try {
    const details = {
      platform: 'Win32',
      vendor: 'Google Inc.',
      language: 'zh-CN',
      languages: ['zh-CN', 'en'],
      timezone: 'Asia/Shanghai',
      screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, cd: 24 },
      viewport: { w: 1280, h: 800, dpr: 1 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      touchPoints: 0,
      webglVendor: 'Google Inc. (Intel)',
      webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics)',
      canvasHash: 'abcd1234',
    };
    const did = 'device-test-0001';
    const first = await fetch(base + '/api/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.30' },
      body: JSON.stringify({ deviceId: did, details }),
    });
    assert.equal(first.status, 200);
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie.startsWith('gp_device='), '应下发设备 cookie');
    const row = (await q("select fingerprint, device_id from device_logs where device_id = 'device-test-0001'")).rows[0];
    assert.ok(row && row.fingerprint, '设备信息应落库');

    const adminCookie = await loginAdmin(base);
    const ban = await fetch(base + '/api/admin/devices/ban', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie, 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ fingerprint: row.fingerprint, deviceId: did, permanent: true, note: '测试' }),
    });
    assert.equal(ban.status, 200);

    const again = await fetch(base + '/api/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.30' },
      body: JSON.stringify({ deviceId: did, details }),
    });
    assert.equal(again.status, 403);
    assert.equal((await again.json()).banned, true);

    const page = await fetch(base + '/', {
      headers: { 'x-forwarded-for': '198.51.100.30', accept: 'text/html', cookie },
    });
    assert.equal(page.status, 403, '带被封设备 cookie 的页面请求直接拒绝');
  } finally {
    await close();
  }
});

test('被拦截请求：单独标记、每 IP 每分钟采样一条，不计入访问量', async () => {
  const { q, base, close } = await boot({ RATE_LIMIT_MAX: '1' });
  try {
    assert.equal((await get(base, '198.51.100.11', '/')).status, 200);
    for (let i = 0; i < 4; i += 1) assert.equal((await get(base, '198.51.100.11', '/')).status, 429);
    const blocked = await waitFor(async () => {
      const n = (await q('select count(*)::int as n from visitor_logs where blocked')).rows[0].n;
      return n >= 1 ? n : 0;
    });
    assert.equal(blocked, 1, '同一 IP 一分钟内只记一条被拦截记录');

    const visits = await db.listVisitorLogs(q, { filter: 'visits' });
    assert.equal(visits.rows.every((r) => r.blocked === false), true);
    const onlyBlocked = await db.listVisitorLogs(q, { filter: 'blocked' });
    assert.equal(onlyBlocked.total, 1);
    const summary = await db.visitorSummary(q);
    assert.ok(summary.today_visits >= 1);
    assert.equal(summary.today_blocked, 1);
  } finally {
    await close();
  }
});

test('限流分桶：静态资源不占用页面/API 的阈值', async () => {
  const { base, close } = await boot({ RATE_LIMIT_MAX: '3', RATE_LIMIT_ASSET_MAX: '100' });
  try {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await get(base, '198.51.100.12', `/img/steam/730/capsule_sm_120?i=${i}`)).status, 200);
    }
    for (let i = 0; i < 3; i += 1) assert.equal((await get(base, '198.51.100.12', '/')).status, 200);
    assert.equal((await get(base, '198.51.100.12', '/')).status, 429, '页面桶超过 3 次才限流');
  } finally {
    await close();
  }
});
