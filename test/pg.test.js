// 用 PGlite（编译成 wasm 的真 PostgreSQL）跑，SQL 语义与生产的 PG 15 一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { ingestOffers, offerHash } from '../src/ingest.js';

const steamPlatform = { code: 'steam', name: 'Steam 国区', kind: 'official' };

function offer(appid, priceCents, extra = {}) {
  return {
    platformCode: 'steam',
    platformProductId: String(appid),
    steamAppid: appid,
    title: `game-${appid}`,
    productType: 'official_direct',
    region: 'cn',
    currency: 'CNY',
    priceCents,
    originalCents: extra.originalCents ?? priceCents,
    discountPct: extra.discountPct ?? 0,
    inStock: true,
    buyUrl: `https://store.steampowered.com/app/${appid}/`,
    meta: {},
  };
}

async function freshStore() {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  return store;
}
const q = (store) => (sql, params) => store.query(sql, params);

test('offerHash 只看价格/折扣/库存', () => {
  const a = offer(1, 100, { originalCents: 200, discountPct: 50 });
  assert.equal(offerHash(a), offerHash({ ...a, buyUrl: 'changed', title: 'renamed' }));
  assert.notEqual(offerHash(a), offerHash(offer(1, 90, { originalCents: 200, discountPct: 55 })));
});

test('建表幂等，跑两次 migrate 不报错', async () => {
  const store = await freshStore();
  try {
    await db.migrate(store);
    const t = await store.query(
      `select count(*)::int as c from information_schema.tables where table_schema='public'`,
    );
    assert.ok(t.rows[0].c >= 6);
  } finally {
    await store.close();
  }
});

test('入库：首次插入，二次同价不写快照，变价才写', async () => {
  const store = await freshStore();
  try {
    const o = [offer(1091500, 14900, { originalCents: 29800, discountPct: 50 })];

    const s1 = await ingestOffers(store, { platform: steamPlatform, offers: o });
    assert.equal(s1.inserted, 1);
    assert.equal(s1.snapshots, 1);

    const s2 = await ingestOffers(store, { platform: steamPlatform, offers: o });
    assert.equal(s2.inserted, 0);
    assert.equal(s2.updated, 1);
    assert.equal(s2.snapshots, 0, '价格没变不应写快照');
    assert.equal(s2.unchanged, 1);

    const s3 = await ingestOffers(store, { platform: steamPlatform, offers: [offer(1091500, 9900, { originalCents: 29800, discountPct: 67 })] });
    assert.equal(s3.snapshots, 1);

    const c = await store.query('select count(*)::int as c from price_snapshots');
    assert.equal(c.rows[0].c, 2);
  } finally {
    await store.close();
  }
});

test('主榜只含官方渠道：更便宜的 C2C 报价和史低都被排除', async () => {
  const store = await freshStore();
  try {
    await ingestOffers(store, { platform: steamPlatform, offers: [offer(1091500, 14900)] });
    await store.query(`insert into platforms (code,name,kind) values ('steampy','SteamPy','c2c') on conflict (code) do nothing`);
    await ingestOffers(store, {
      platform: { code: 'steampy', name: 'SteamPy', kind: 'c2c' },
      offers: [{ ...offer(1091500, 300), platformCode: 'steampy', productType: 'c2c_listing' }],
    });

    const rows = await db.lowestOffers(q(store), { region: 'cn' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].platform_code, 'steam');
    assert.equal(rows[0].price_cents, 14900, 'C2C 的 3 元不能进主榜');
    assert.equal(rows[0].hist_low, 14900, '史低也只能统计官方渠道');

    const low = await db.isAtHistoricalLow(q(store), { steamAppid: 1091500, region: 'cn' });
    assert.equal(low.histLow, 14900);
    assert.equal(low.atLow, true);
  } finally {
    await store.close();
  }
});

test('日聚合取当天最低 + 跨天轨迹 + 史低判断', async () => {
  const store = await freshStore();
  try {
    await ingestOffers(store, { platform: steamPlatform, offers: [offer(1091500, 29900)] });
    // 手工补一条 60 天前的记录（真实采集跑久了自然会有，这里模拟历史）
    await store.query(
      `insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
       select id, 'steam', 'cn', current_date - 60, 39900, 'CNY' from games where steam_appid = 1091500`,
    );
    await ingestOffers(store, { platform: steamPlatform, offers: [offer(1091500, 14900)] });

    const hist = await db.priceHistory(q(store), { steamAppid: 1091500, days: 90 });
    assert.equal(hist.length, 2);
    assert.ok(String(hist[0].day) < String(hist[1].day));

    const today = await store.query(`select min_price_cents from daily_prices d join games g on g.id=d.game_id
                                      where g.steam_appid=1091500 and d.day=current_date`);
    assert.equal(today.rows[0].min_price_cents, 14900);

    const low = await db.isAtHistoricalLow(q(store), { steamAppid: 1091500 });
    assert.equal(low.histLow, 14900);
    assert.equal(low.atLow, true);
  } finally {
    await store.close();
  }
});

test('多平台各自的报价互不覆盖，主榜取最低', async () => {
  const store = await freshStore();
  try {
    await ingestOffers(store, { platform: steamPlatform, offers: [offer(1245620, 39800)] });
    await ingestOffers(store, {
      platform: { code: 'sonkwo', name: '杉果', kind: 'authorized_reseller' },
      offers: [
        {
          ...offer(1245620, 31800),
          platformCode: 'sonkwo',
          platformProductId: '111454',
          productType: 'authorized_key',
          buyUrl: 'https://www.sonkwo.hk/sku/111454',
        },
      ],
    });

    const rows = await db.lowestOffers(q(store), { region: 'cn' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].platform_code, 'sonkwo');
    assert.equal(rows[0].price_cents, 31800);

    const s = await db.stats(q(store));
    assert.equal(s.games, 1, '同一个 appid 不应产生两条游戏记录');
    assert.equal(s.offers, 2);
    assert.equal(s.platforms.length >= 2, true);
  } finally {
    await store.close();
  }
});

test('startFetchRun / finishFetchRun 能留下采集健康度', async () => {
  const store = await freshStore();
  try {
    const id = await db.startFetchRun(q(store), 'steam');
    await db.finishFetchRun(q(store), id, { requests: 3, total: 90, ok: 88, skipped: 2, failed: 0, status: 'ok', note: '12KB' });
    const s = await db.stats(q(store));
    assert.equal(s.lastRuns.length, 1);
    assert.equal(s.lastRuns[0].status, 'ok');
    assert.equal(s.lastRuns[0].ok, 88);
  } finally {
    await store.close();
  }
});

test('serverVersion 能读到 PG 版本（诊断用）', async () => {
  const store = await freshStore();
  try {
    const v = await db.serverVersion(q(store));
    assert.match(v.version, /PostgreSQL/);
    assert.ok(v.timeZone);
  } finally {
    await store.close();
  }
});

test('没有 appid 的游戏：再次采集时能补上英文名（杉果 sku_ename）', async () => {
  const store = await freshStore();
  try {
    const q = (sql, p) => store.query(sql, p);
    const sonkwo = { code: 'sonkwo', name: '杉果', kind: 'authorized_reseller' };
    const base = {
      platformCode: 'sonkwo',
      platformProductId: '111454',
      steamAppid: null,
      title: '愚者不灭',
      productType: 'authorized_key',
      region: 'cn',
      currency: 'CNY',
      priceCents: 19800,
      originalCents: 19800,
      discountPct: 0,
      inStock: true,
      buyUrl: 'https://www.sonkwo.hk/sku/111454',
    };

    // 第一次：页面还没带英文名
    await ingestOffers(store, { platform: sonkwo, offers: [{ ...base, meta: {} }] });
    let row = (await q("select id, name_en from games where name = '愚者不灭'")).rows[0];
    assert.equal(row.name_en, null);

    // 第二次：适配器从 sku_ename 拿到英文名，应补进同一行
    await ingestOffers(store, { platform: sonkwo, offers: [{ ...base, meta: { nameEn: 'Stupid Never Dies' } }] });
    row = (await q("select name_en from games where name = '愚者不灭'")).rows[0];
    assert.equal(row.name_en, 'Stupid Never Dies');
    assert.equal((await q("select count(*)::int c from games")).rows[0].c, 1, '不能因此多建一行');
  } finally {
    await store.close();
  }
});

test('兴趣开关：不感兴趣只改标记，报价与统计照常', async () => {
  const store = await freshStore();
  try {
    const q = (sql, p) => store.query(sql, p);
    await ingestOffers(store, { platform: steamPlatform, offers: [offer(730, 9900)] });

    const off = await db.setInterest(q, { steamAppid: 730, interested: false });
    assert.equal(off.interested, false);

    const overview = await db.gameOverview(q, { region: 'cn' });
    assert.equal(overview.length, 1, '不感兴趣的游戏仍然出现在数据里');
    assert.equal(overview[0].interested, false);
    assert.equal(overview[0].current_low, 9900, '价格统计不受影响');

    const on = await db.setInterest(q, { steamAppid: 730, interested: true });
    assert.equal(on.interested, true);
    assert.equal(await db.setInterest(q, { steamAppid: 999999, interested: true }), null);
  } finally {
    await store.close();
  }
});

test('元数据写入开发商/发行商/分类/标签', async () => {
  const store = await freshStore();
  try {
    const q = (sql, p) => store.query(sql, p);
    await db.upsertGameMeta(q, {
      steamAppid: 1091500,
      nameZh: '赛博朋克 2077',
      nameEn: 'Cyberpunk 2077',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['角色扮演'],
      tags: ['tag:4115'],
    });
    const row = (await q('select developers, publishers, genres, tags from games where steam_appid = 1091500')).rows[0];
    assert.deepEqual(row.developers, ['CD PROJEKT RED']);
    assert.deepEqual(row.genres, ['角色扮演']);
    assert.deepEqual(row.tags, ['tag:4115']);
  } finally {
    await store.close();
  }
});

test('回填：upsertGameMeta 写 description，markBackfilled 记录 backfill_at', async () => {
  const store = await freshStore();
  try {
    const q = (sql, p) => store.query(sql, p);
    await db.upsertGameMeta(q, { steamAppid: 990001, nameZh: '回填测试', description: '一段说明' });
    let row = (await q('select description, backfill_at from games where steam_appid = 990001')).rows[0];
    assert.equal(row.description, '一段说明');
    assert.equal(row.backfill_at, null);

    await db.markBackfilled(q, [990001]);
    row = (await q('select backfill_at from games where steam_appid = 990001')).rows[0];
    assert.ok(row.backfill_at != null, '处理过应打上 backfill_at');

    // 人工/已有说明不被覆盖（只填空）
    await db.upsertGameMeta(q, { steamAppid: 990001, nameZh: '回填测试', description: '新说明' });
    row = (await q('select description from games where steam_appid = 990001')).rows[0];
    assert.equal(row.description, '一段说明');
  } finally {
    await store.close();
  }
});