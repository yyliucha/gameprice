// API 权限模型：匿名可读、登录可改偏好、管理员才能改数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';
import { ingestOffers } from '../src/ingest.js';

async function setup() {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);

  await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
  await db.createUser(q, { username: 'alice', password: 'alice123456', role: 'user' });

  await ingestOffers(store, {
    platform: { code: 'steam', name: 'Steam 国区', kind: 'official' },
    offers: [
      {
        platformCode: 'steam',
        platformProductId: '413150',
        steamAppid: 413150,
        title: '星露谷物语',
        productType: 'official_direct',
        region: 'cn',
        currency: 'CNY',
        priceCents: 4800,
        originalCents: 4800,
        discountPct: 0,
        inStock: true,
        buyUrl: 'https://store.steampowered.com/app/413150/',
        meta: {},
      },
    ],
  });
  await q(`insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
           select id, 'steam', 'cn', current_date - 1, 4800, 'CNY' from games where steam_appid = 413150`);

  const srv = await startApiServer({ query: q, port: 0, host: '127.0.0.1' });
  return { store, q, srv, base: `http://127.0.0.1:${srv.port}` };
}

const login = async (base, username, password) => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: res.status, cookie, body: await res.json() };
};

test('匿名可看列表与详情，但不带用户信息', async () => {
  const { store, srv, base } = await setup();
  try {
    const list = await fetch(`${base}/api/games`);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.ok(body.games.length >= 1, "匿名应能看到游戏");
    assert.ok(body.games.some((g) => g.steam_appid === 413150), "应包含目标游戏");
    assert.equal(body.games[0].steam_appid, 413150);

    // 数量接口：库内 / 有价格，前台实时数量靠它
    const count = await (await fetch(`${base}/api/games/count`)).json();
    assert.equal(count.catalog, 1);
    assert.equal(count.priced, 1);

    const detail = await fetch(`${base}/api/games/413150`);
    assert.equal(detail.status, 200);
    const d = await detail.json();
    assert.ok(d.offers.length >= 1, "详情应带报价");
    assert.ok(d.series.length >= 1, "详情应带价格序列");

    const me = await (await fetch(`${base}/api/me`)).json();
    assert.equal(me.user, null, '匿名时没有用户');
    assert.equal(me.prefs, null);
  } finally {
    await srv.close();
    await store.close();
  }
});

test('登录才能存偏好；普通用户不能改游戏标记；管理员可以', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const denied = await fetch(`${base}/api/games/413150/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interested: false }),
    });
    assert.equal(denied.status, 401, '匿名不能改');

    const alice = await login(base, 'alice', 'alice123456');
    assert.equal(alice.status, 200);
    assert.ok(alice.cookie.startsWith('gp_session='));

    const forbidden = await fetch(`${base}/api/games/413150/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ interested: false }),
    });
    assert.equal(forbidden.status, 403, '普通用户不能改游戏标记');

    const prefs = await fetch(`${base}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ hide_uninterested: true, only_discount: true, sort: 'price' }),
    });
    assert.equal(prefs.status, 200);
    const saved = (await prefs.json()).prefs;
    assert.equal(saved.only_discount, true);
    assert.equal(saved.sort, 'price');

    // 页签偏好也落库：登录用户下次按自己的习惯加载
    const prefs2 = await fetch(`${base}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ tab: 'off', sort: 'name' }),
    });
    const saved2 = (await prefs2.json()).prefs;
    assert.equal(saved2.tab, 'off');
    assert.equal(saved2.sort, 'name');
    assert.equal((await q('select tab from user_prefs where user_id = (select id from users where username = $1)', ['alice'])).rows[0].tab, 'off', '页签要写进 user_prefs');
    const meBody = await (await fetch(`${base}/api/me`, { headers: { cookie: alice.cookie } })).json();
    assert.equal(meBody.prefs.tab, 'off', '/api/me 要把页签带回来');

    // 非法值归一化
    const prefs3 = await fetch(`${base}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ tab: 'steam', sort: 'weird' }),
    });
    const saved3 = (await prefs3.json()).prefs;
    assert.equal(saved3.tab, 'all');
    assert.equal(saved3.sort, 'discount');

    const admin = await login(base, 'admin', 'admin123456');
    const ok = await fetch(`${base}/api/games/413150/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ interested: false }),
    });
    assert.equal(ok.status, 200);
    const row = (await q('select interested from games where steam_appid = 413150')).rows[0];
    assert.equal(row.interested, false, '管理员改完要落库');

    // 没有 Steam appid 的游戏（杉果）：按内部 id 标记，前台详情弹窗用这条接口
    const gid = (await q("insert into games (name) values ('杉果专属游戏') returning id")).rows[0].id;
    const anonById = await fetch(`${base}/api/games/id/${gid}/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interested: false }),
    });
    assert.equal(anonById.status, 401, '匿名不能按 id 标记');

    const byId = await fetch(`${base}/api/games/id/${gid}/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ interested: false }),
    });
    assert.equal(byId.status, 200);
    assert.equal((await q('select interested from games where id = $1', [gid])).rows[0].interested, false, '按内部 id 也要落库');

    const byIdOwned = await fetch(`${base}/api/games/id/${gid}/owned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ owned: true }),
    });
    assert.equal(byIdOwned.status, 200);
    assert.equal((await q('select owned from games where id = $1', [gid])).rows[0].owned, true);
  } finally {
    await srv.close();
    await store.close();
  }
});

test('密码错误、登出、管理员看用户列表', async () => {
  const { store, srv, base } = await setup();
  try {
    const bad = await login(base, 'alice', 'wrong-password');
    assert.equal(bad.status, 401);

    const admin = await login(base, 'admin', 'admin123456');
    const users = await fetch(`${base}/api/admin/users`, { headers: { cookie: admin.cookie } });
    assert.equal(users.status, 200);
    const names = (await users.json()).users.map((u) => u.username);
    assert.deepEqual(names.sort(), ['admin', 'alice']);

    const anonUsers = await fetch(`${base}/api/admin/users`);
    assert.equal(anonUsers.status, 401);

    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: admin.cookie } });
    assert.equal(out.status, 200);
    const after = await fetch(`${base}/api/me`, { headers: { cookie: admin.cookie } });
    assert.equal((await after.json()).user, null, '登出后会话失效');
  } finally {
    await srv.close();
    await store.close();
  }
});

test('密码哈希：加盐、可校验、不存明文', async () => {
  const a = db.hashPassword('secret123');
  const b = db.hashPassword('secret123');
  assert.notEqual(a, b, '同一密码两次哈希必须不同（随机盐）');
  assert.ok(!a.includes('secret123'));
  assert.equal(db.verifyPassword('secret123', a), true);
  assert.equal(db.verifyPassword('secret124', a), false);
  assert.equal(db.verifyPassword('secret123', 'garbage'), false);
});

test('已拥有标记：匿名 401、普通用户 403、管理员可改', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const anon = await fetch(base + '/api/games/413150/owned', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owned: true }),
    });
    assert.equal(anon.status, 401);

    const alice = await login(base, 'alice', 'alice123456');
    const forbidden = await fetch(base + '/api/games/413150/owned', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: alice.cookie }, body: JSON.stringify({ owned: true }),
    });
    assert.equal(forbidden.status, 403);

    const admin = await login(base, 'admin', 'admin123456');
    const ok = await fetch(base + '/api/games/413150/owned', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ owned: true }),
    });
    assert.equal(ok.status, 200);
    const row = (await q('select owned from games where steam_appid = 413150')).rows[0];
    assert.equal(row.owned, true, '标记要落库');
  } finally {
    await srv.close();
    await store.close();
  }
});
