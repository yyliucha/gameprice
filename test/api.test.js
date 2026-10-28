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

test('单款详情不受列表前 500 名限制（后台编辑不再 404）', async () => {
  const { store, q, srv, base } = await setup();
  try {
    await q("insert into games (steam_appid, name) values (999999, '后排游戏')");
    const r = await fetch(`${base}/api/games/999999`);
    assert.equal(r.status, 200, '没有报价、不在列表里的游戏也要能取到详情');
    assert.equal((await r.json()).game.name, '后排游戏');
    const id = (await q('select id from games where steam_appid = 999999')).rows[0].id;
    const r2 = await fetch(`${base}/api/games/by-id/${id}`);
    assert.equal(r2.status, 200, '按内部 id 同样要能取到');
  } finally {
    await srv.close();
    await store.close();
  }
});

test('价格变动报表：快照带前价，涨跌榜与统计正确', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const admin = await login(base, 'admin', 'admin123456');
    const offer = (await q('select o.id from offers o join games g on g.id = o.game_id where g.steam_appid = 413150')).rows[0];

    // 基线快照（无前价）+ 降价快照（4800 → 3000）
    await q("insert into price_snapshots (offer_id, price_cents, discount_pct, in_stock, raw_hash) values ($1, 4800, 0, true, 'h0')", [offer.id]);
    await q("insert into price_snapshots (offer_id, price_cents, discount_pct, in_stock, raw_hash, prev_price_cents) values ($1, 3000, 37, true, 'h1', 4800)", [offer.id]);

    const repBody = await (await fetch(`${base}/api/admin/reports/price?hours=24&days=7`, { headers: { cookie: admin.cookie } })).json();
    const rep = repBody.report;
    assert.equal(rep.changed, 1);
    assert.equal(rep.drops, 1);
    assert.equal(rep.rises, 0);
    assert.equal(rep.topDrops[0].was, 4800);
    assert.equal(rep.topDrops[0].now_price, 3000);
    assert.equal(rep.topDrops[0].steam_appid, 413150);
    // setup 里 daily_prices 记录 4800，现价 3000 低于它 → 算新史低
    assert.equal(rep.newLows, 1, '降价到历史最低以下算新史低');
    assert.ok(Array.isArray(repBody.daily), '按天趋势要返回数组');

    // CSV 导出
    const csv = await fetch(`${base}/api/admin/reports/price.csv?hours=24`, { headers: { cookie: admin.cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    const csvText = await csv.text();
    assert.match(csvText, /old_price,new_price/);
    assert.match(csvText, /星露谷物语/);
    assert.equal((await fetch(`${base}/api/admin/reports/price.csv`)).status, 401, '匿名不能导出');

    assert.equal((await fetch(`${base}/api/admin/reports/price`)).status, 401, '匿名不能看价格报表');

    // ingest 写快照时要带前价：再喂一次 2400
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
          priceCents: 2400,
          originalCents: 4800,
          discountPct: 50,
          inStock: true,
          buyUrl: 'https://store.steampowered.com/app/413150/',
          meta: {},
        },
      ],
    });
    const last = (await q('select price_cents, prev_price_cents from price_snapshots where offer_id = $1 order by id desc limit 1', [offer.id])).rows[0];
    assert.equal(last.price_cents, 2400);
    assert.equal(last.prev_price_cents, 3000, '新快照要记住上一条的价格');
  } finally {
    await srv.close();
    await store.close();
  }
});

test('游戏同步统计与筛选：待同步数量、pending/done 过滤', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const admin = await login(base, 'admin', 'admin123456');
    const statsUrl = `${base}/api/admin/games/stats`;
    const s1 = (await (await fetch(statsUrl, { headers: { cookie: admin.cookie } })).json()).stats;
    assert.equal(s1.total, 1);
    assert.equal(s1.withAppid, 1);
    assert.equal(s1.pending, 1, '没有说明 → 待同步');
    assert.equal(s1.synced, 0);

    // 补说明后：有 appid + 有 Steam 报价 + 有说明 → 已同步
    await q("update games set description = '一段说明' where steam_appid = 413150");
    const s2 = (await (await fetch(statsUrl, { headers: { cookie: admin.cookie } })).json()).stats;
    assert.equal(s2.pending, 0);
    assert.equal(s2.synced, 1);

    const pending = await (await fetch(`${base}/api/admin/games?sync=pending`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(pending.total, 0, '没有待同步的');
    const done = await (await fetch(`${base}/api/admin/games?sync=done`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(done.total, 1, '已同步的能筛出来');

    assert.equal((await fetch(statsUrl)).status, 401, '匿名不能看统计');
  } finally {
    await srv.close();
    await store.close();
  }
});

test('服务端搜索与分页：分页元数据、关键词全库搜索、折扣排序', async () => {
  const { store, q, srv, base } = await setup();
  try {
    // 造 30 款带日价格与 Steam 报价的游戏（折扣 20% ~ 49%）
    for (let i = 0; i < 30; i += 1) {
      const appid = 700000 + i;
      await q("insert into games (steam_appid, name, description) values ($1, $2, '说明')", [appid, '测试游戏 ' + i]);
      const gid = (await q('select id from games where steam_appid = $1', [appid])).rows[0].id;
      await q(
        "insert into offers (game_id, platform_code, product_type, region, currency, price_cents, original_cents, discount_pct, in_stock) " +
          "values ($1,'steam','official_direct','cn','CNY',$2,2000,$3,true)",
        [gid, 1000 + i * 10, 20 + i],
      );
      await q(
        "insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency) values ($1,'steam','cn', current_date, $2, 'CNY')",
        [gid, 1000 + i * 10],
      );
    }

    const p1 = await (await fetch(`${base}/api/games?page=1&pageSize=10`)).json();
    assert.equal(p1.total, 31, '30 款新游戏 + 初始 1 款');
    assert.equal(p1.page, 1);
    assert.equal(p1.pageSize, 10);
    assert.equal(p1.pages, 4);
    assert.equal(p1.games.length, 10);
    assert.equal(p1.games[0].discount, 49, '默认按折扣降序');
    assert.ok(p1.games[0].discount >= p1.games[1].discount);

    const p2 = await (await fetch(`${base}/api/games?page=2&pageSize=10`)).json();
    assert.equal(p2.page, 2);
    assert.notDeepEqual(p1.games.map((g) => g.id), p2.games.map((g) => g.id), '第二页数据不同');

    // 全库搜索：不在第一页的游戏也能搜到
    const hit = await (await fetch(`${base}/api/games?q=${encodeURIComponent('测试游戏 29')}`)).json();
    assert.equal(hit.total, 1);
    assert.equal(hit.games[0].name, '测试游戏 29');

    // 按价格升序
    const byPrice = await (await fetch(`${base}/api/games?sort=price&pageSize=200`)).json();
    assert.equal(byPrice.games[0].current_low, 1000, '最便宜的排在前面');
    assert.equal(byPrice.games.length, 31);
  } finally {
    await srv.close();
    await store.close();
  }
});

test('合并重复游戏：报价迁移到目标、源行删除、参数校验', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const admin = await login(base, 'admin', 'admin123456');
    const dupId = (await q("insert into games (steam_appid, name) values (555001, '星露谷物语(重复)') returning id")).rows[0].id;
    await q(
      "insert into offers (game_id, platform_code, product_type, region, currency, price_cents, in_stock) values ($1,'sonkwo','authorized_direct','cn','CNY',1000,true)",
      [dupId],
    );
    const r = await fetch(`${base}/api/admin/games/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ fromAppid: 555001, toAppid: 413150 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.result.merged, true);
    assert.ok(body.result.moved >= 1, '至少迁移 1 条报价');
    assert.equal((await q('select count(*)::int as n from games where steam_appid = 555001')).rows[0].n, 0, '源行已删除且合并进目标');
    const targetId = (await q('select id from games where steam_appid = 413150')).rows[0].id;
    assert.equal(
      (await q("select count(*)::int as n from offers where game_id = $1 and platform_code = 'sonkwo'", [targetId])).rows[0].n,
      1,
      '杉果报价已迁到目标游戏',
    );

    // 匿名 401、同源同目标 400
    assert.equal(
      (await fetch(`${base}/api/admin/games/merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromAppid: 413150, toAppid: 730 }) })).status,
      401,
    );
    const bad = await fetch(`${base}/api/admin/games/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ fromAppid: 413150, toAppid: 413150 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
    await store.close();
  }
});

test('个人标记：登录用户个人优先，未标记回退全局标记', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const alice = await login(base, 'alice', 'alice123456');
    const admin = await login(base, 'admin', 'admin123456');

    // 全局标记：管理员把 413150 标成已拥有（游戏只有这一款）
    await q('update games set owned = true where steam_appid = 413150');
    const anon = await (await fetch(`${base}/api/games`)).json();
    assert.equal(anon.total, 0, '默认排除已拥有，匿名看到的是全局标记');

    // alice 个人取消已拥有 → 她能看到；全局仍是已拥有
    const set = await fetch(`${base}/api/games/413150/flags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ owned: false }),
    });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).flags.owned, false);

    const mine = await (await fetch(`${base}/api/games`, { headers: { cookie: alice.cookie } })).json();
    assert.equal(mine.total, 1, '个人标记优先于全局');
    assert.equal(mine.games[0].owned, false);

    const detail = await (await fetch(`${base}/api/games/413150`, { headers: { cookie: alice.cookie } })).json();
    assert.equal(detail.game.owned, false, '详情也返回个人生效值');

    // admin 没有个人标记 → 回退全局（已拥有 → 默认列表排除）
    const adminList = await (await fetch(`${base}/api/games`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(adminList.total, 0, '未标记时回退全局');

    // 匿名不能写个人标记
    assert.equal(
      (await fetch(`${base}/api/games/413150/flags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ interested: true }),
      })).status,
      401,
    );
  } finally {
    await srv.close();
    await store.close();
  }
});

test('到价提醒：管理员增删查、appid 解析、普通用户 403、匿名 401', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const admin = await login(base, 'admin', 'admin123456');
    const alice = await login(base, 'alice', 'alice123456');

    const byAppid = await fetch(`${base}/api/admin/watchlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ appid: 413150, targetCents: 3000 }),
    });
    assert.equal(byAppid.status, 200);
    const list = await (await fetch(`${base}/api/admin/watchlist`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(list.watches.length, 1);
    assert.equal(list.watches[0].target_cents, 3000, '按 appid 也能解析成游戏');

    const gid = list.watches[0].game_id;
    // 留空 = 只跟史低
    await fetch(`${base}/api/admin/watchlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ gameId: gid, targetCents: null }),
    });
    const list2 = await (await fetch(`${base}/api/admin/watchlist`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(list2.watches[0].target_cents, null, '留空应覆盖成史低提醒');

    assert.equal((await fetch(`${base}/api/admin/watchlist`, { headers: { cookie: alice.cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/watchlist`)).status, 401);

    const del = await fetch(`${base}/api/admin/watchlist/${gid}`, { method: 'DELETE', headers: { cookie: admin.cookie } });
    assert.equal(del.status, 200);
    const list3 = await (await fetch(`${base}/api/admin/watchlist`, { headers: { cookie: admin.cookie } })).json();
    assert.equal(list3.watches.length, 0);
  } finally {
    await srv.close();
    await store.close();
  }
});

test('类型筛选：只看游戏 / 只看 DLC', async () => {
  const { store, q, srv, base } = await setup();
  try {
    // 初始游戏标成 game；再造一个 DLC（带日价格与 Steam 报价）
    await q("update games set app_type = 'game' where steam_appid = 413150");
    const dlcId = (await q("insert into games (steam_appid, name, app_type, description) values (990001, '测试 DLC', 'dlc', '说明') returning id")).rows[0].id;
    await q(
      "insert into offers (game_id, platform_code, product_type, region, currency, price_cents, discount_pct, in_stock) values ($1,'steam','official_direct','cn','CNY',500,0,true)",
      [dlcId],
    );
    await q(
      "insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency) values ($1,'steam','cn', current_date, 500, 'CNY')",
      [dlcId],
    );

    const onlyDlc = await (await fetch(`${base}/api/games?type=dlc`)).json();
    assert.equal(onlyDlc.total, 1);
    assert.equal(onlyDlc.games[0].name, '测试 DLC');
    assert.equal(onlyDlc.type, 'dlc');

    const onlyGame = await (await fetch(`${base}/api/games?type=game`)).json();
    assert.equal(onlyGame.total, 1);
    assert.equal(onlyGame.games[0].steam_appid, 413150);

    const all = await (await fetch(`${base}/api/games`)).json();
    assert.equal(all.total, 2, '默认不过滤类型');

    // 非法值回落 all
    const fallback = await (await fetch(`${base}/api/games?type=weird`)).json();
    assert.equal(fallback.type, 'all');
    assert.equal(fallback.total, 2);
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

test('逻辑删除：前台与后台默认都排除，回收站可见并可恢复；平台列随列表下发', async () => {
  const { store, q, srv, base } = await setup();
  try {
    const admin = await login(base, 'admin', 'admin123456');

    // 平台列：有 Steam 报价的游戏应带 platform_codes / platform_names
    const list0 = await (await fetch(`${base}/api/admin/games`, { headers: { cookie: admin.cookie } })).json();
    const row0 = list0.games.find((g) => g.steam_appid === 413150);
    assert.deepEqual(row0.platform_codes, ['steam']);
    assert.deepEqual(row0.platform_names, ['Steam 国区']);

    // 逻辑删除
    const del = await fetch(`${base}/api/games/413150/deleted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ deleted: true }),
    });
    assert.equal(del.status, 200);
    assert.equal((await q('select deleted from games where steam_appid = 413150')).rows[0].deleted, true);
    assert.equal((await q('select count(*)::int as n from offers o join games g on g.id = o.game_id where g.steam_appid = 413150')).rows[0].n, 1, '报价数据不能被真删');

    // 前台列表排除
    const pub = await (await fetch(`${base}/api/games`)).json();
    assert.ok(!pub.games.some((g) => g.steam_appid === 413150), '前台不该再展示已删除游戏');

    // 后台默认列表排除，回收站可取到
    const list1 = await (await fetch(`${base}/api/admin/games`, { headers: { cookie: admin.cookie } })).json();
    assert.ok(!list1.games.some((g) => g.steam_appid === 413150), '后台默认列表也要排除');
    const only = await (await fetch(`${base}/api/admin/games?deleted=only`, { headers: { cookie: admin.cookie } })).json();
    assert.ok(only.games.some((g) => g.steam_appid === 413150), 'deleted=only 能查到');
    const bin = await (await fetch(`${base}/api/admin/games/deleted`, { headers: { cookie: admin.cookie } })).json();
    assert.ok(bin.games.some((g) => g.steam_appid === 413150), '回收站接口能查到');

    // 恢复
    const restore = await fetch(`${base}/api/games/413150/deleted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ deleted: false }),
    });
    assert.equal(restore.status, 200);
    assert.equal((await q('select deleted, deleted_at from games where steam_appid = 413150')).rows[0].deleted, false);
    assert.equal((await q('select deleted_at from games where steam_appid = 413150')).rows[0].deleted_at, null, '恢复后清空删除时间');
    const pub2 = await (await fetch(`${base}/api/games`)).json();
    assert.ok(pub2.games.some((g) => g.steam_appid === 413150), '恢复后前台恢复展示');
  } finally {
    await srv.close();
    await store.close();
  }
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
