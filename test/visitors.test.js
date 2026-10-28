// 访问记录 + IP 黑名单：落库、归属地回填、分页过滤、server 层 403 拦截、管理员放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';
import * as visitors from '../src/visitors.js';

// 测试里关掉登录验证码
process.env.CAPTCHA_ENABLED = '0';

async function waitFor(fn, { timeoutMs = 3000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor 超时；最后值：' + JSON.stringify(last));
}

test('normalizeBanInput：单个 IP / CIDR / 非法输入', () => {
  assert.equal(visitors.normalizeBanInput(' 1.2.3.4 '), '1.2.3.4');
  assert.equal(visitors.normalizeBanInput('1.2.3.0/24'), '1.2.3.0/24');
  assert.equal(visitors.normalizeBanInput('::1'), '::1');
  assert.equal(visitors.normalizeBanInput('999.1.1.1'), null);
  assert.equal(visitors.normalizeBanInput('1.2.3.0/33'), null);
  assert.equal(visitors.normalizeBanInput('not-an-ip'), null);
  assert.equal(visitors.normalizeBanInput(''), null);
});

test('blockedBy：精确匹配与 IPv4 CIDR', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  await db.addBlockedIp(q, { ip: '5.6.7.8', note: '单个' });
  await db.addBlockedIp(q, { ip: '10.20.30.0/24', note: '网段' });
  await visitors.refreshBlocklist(q);
  try {
    assert.equal(visitors.blockedBy('5.6.7.8'), '5.6.7.8');
    assert.equal(visitors.blockedBy('10.20.30.77'), '10.20.30.0/24');
    assert.equal(visitors.blockedBy('10.20.31.1'), null);
    assert.equal(visitors.blockedBy('1.1.1.1'), null);
  } finally {
    await store.close();
  }
});

test('访问记录：落库、归属地回填、分页过滤、汇总', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  try {
    const id1 = await db.insertVisitorLog(q, { ip: '1.2.3.4', remoteIp: '172.17.0.1', path: '/', status: 200 });
    const id2 = await db.insertVisitorLog(q, { ip: '1.2.3.4', path: '/api/games', status: 200 });
    await db.insertVisitorLog(q, { ip: '9.9.9.9', path: '/console', status: 403 });

    await db.setVisitorRegion(q, id2, '中国 广东 深圳');
    const rows = await q('select ip, region, path from visitor_logs where id = $1', [id2]);
    assert.equal(rows.rows[0].region, '中国 广东 深圳');
    assert.equal(rows.rows[0].path, '/api/games');

    // 分页 + IP 过滤
    const all = await db.listVisitorLogs(q, { page: 1, pageSize: 10 });
    assert.equal(all.total, 3);
    const filtered = await db.listVisitorLogs(q, { page: 1, pageSize: 10, ip: '1.2.3.4' });
    assert.equal(filtered.total, 2);
    const byPath = await db.listVisitorLogs(q, { page: 1, pageSize: 10, path: 'console' });
    assert.equal(byPath.total, 1);
    assert.equal(byPath.rows[0].ip, '9.9.9.9');

    // 汇总
    const summary = await db.visitorSummary(q);
    assert.equal(summary.today_visits, 3);
    assert.equal(summary.today_ips, 2);
    assert.equal(summary.topIps.length, 2);
    assert.equal(summary.topIps[0].ip, '1.2.3.4');

    // 黑名单增删查
    const added = await db.addBlockedIp(q, { ip: '9.9.9.9', note: '爬虫' });
    assert.equal(added.ip, '9.9.9.9');
    const list = await db.listBlockedIps(q);
    assert.equal(list.length, 1);
    assert.equal(list[0].note, '爬虫');
    assert.equal(await db.removeBlockedIp(q, '9.9.9.9'), 1);
    assert.equal((await db.listBlockedIps(q)).length, 0);
  } finally {
    await store.close();
  }
});

test('server 层拦截：拉黑后整站 403、管理员放行、解封恢复', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
  const srv = await startApiServer({ query: q, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    // 匿名登录管理员
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal(loginRes.status, 200);

    // 正常访问可通，且访问记录已落库（fire-and-forget，轮询等待）
    const ok = await fetch(`${base}/api/games`);
    assert.equal(ok.status, 200);
    await waitFor(async () => {
      const rows = await q("select count(*)::int as n from visitor_logs where path = '/api/games'");
      return rows.rows[0].n >= 1 ? rows.rows[0].n : 0;
    });

    // 管理员拉黑 127.0.0.1
    const ban = await fetch(`${base}/api/admin/blacklist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ip: '127.0.0.1', note: '测试' }),
    });
    assert.equal(ban.status, 200);

    // 匿名请求整站 403（含静态页）
    const denied = await fetch(`${base}/api/games`);
    assert.equal(denied.status, 403);
    const deniedPage = await fetch(`${base}/console`);
    assert.equal(deniedPage.status, 403);

    // 管理员会话放行（避免把自己锁在门外）
    const adminOk = await fetch(`${base}/api/admin/blacklist`, { headers: { cookie } });
    assert.equal(adminOk.status, 200);

    // 拉黑也记访问记录（status 403）
    await waitFor(async () => {
      const rows = await q("select count(*)::int as n from visitor_logs where status = 403");
      return rows.rows[0].n >= 1 ? rows.rows[0].n : 0;
    });

    // 解封后恢复
    const unban = await fetch(`${base}/api/admin/blacklist/127.0.0.1`, { method: 'DELETE', headers: { cookie } });
    assert.equal(unban.status, 200);
    const restored = await fetch(`${base}/api/games`);
    assert.equal(restored.status, 200);
  } finally {
    await srv.close();
    await store.close();
  }
});

test('普通用户不能管理黑名单', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  await db.createUser(q, { username: 'alice', password: 'alice123456', role: 'user' });
  const srv = await startApiServer({ query: q, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice123456' }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];

    const add = await fetch(`${base}/api/admin/blacklist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ip: '1.2.3.4' }),
    });
    assert.equal(add.status, 403);
    const list = await fetch(`${base}/api/admin/blacklist`, { headers: { cookie } });
    assert.equal(list.status, 403);
    const view = await fetch(`${base}/api/admin/visitors`, { headers: { cookie } });
    assert.equal(view.status, 403);
  } finally {
    await srv.close();
    await store.close();
  }
});
