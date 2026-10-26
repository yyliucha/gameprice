// 关注列表的存储行为 + 与 alerts 判定的联动，跑在真 PG 语义上（PGlite）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { ingestOffers } from '../src/ingest.js';
import { evaluateAlerts } from '../src/alerts.js';

const offer = (priceCents) => ({
  platformCode: 'steam',
  platformProductId: '1091500',
  steamAppid: 1091500,
  title: '赛博朋克 2077',
  productType: 'official_direct',
  region: 'cn',
  currency: 'CNY',
  priceCents,
  originalCents: 29800,
  discountPct: Math.round((1 - priceCents / 29800) * 100),
  inStock: true,
  buyUrl: 'https://store.steampowered.com/app/1091500/',
  meta: {},
});

async function seed(store, priceCents, histLowCents) {
  const q = (sql, p) => store.query(sql, p);
  await ingestOffers(store, { platform: { code: 'steam', name: 'Steam 国区', kind: 'official' }, offers: [offer(priceCents)] });
  const gameId = (await q('select id from games where steam_appid = 1091500')).rows[0].id;
  if (histLowCents != null) {
    await q(
      `insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
       values ($1,'steam','cn', current_date - 30, $2, 'CNY')`,
      [gameId, histLowCents],
    );
  }
  return gameId;
}

test('关注后能列出，重复 upsert 会更新目标价而不是插两条', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const gameId = await seed(store, 14900, 9900);

    await db.upsertWatch(q, { gameId, targetCents: 10000, note: '想玩' });
    await db.upsertWatch(q, { gameId, targetCents: 8000 });

    const rows = await db.listWatches(q);
    assert.equal(rows.length, 1, '同一游戏同一区服只应有一条');
    assert.equal(rows[0].target_cents, 8000, '应更新为新目标价');
    assert.equal(rows[0].name, '赛博朋克 2077');
  } finally {
    await store.close();
  }
});

test('watchCandidates 带上当前价与史低', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const gameId = await seed(store, 14900, 9900);
    await db.upsertWatch(q, { gameId, targetCents: 10000 });

    const rows = await db.watchCandidates(q);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].current_cents), 14900);
    assert.equal(Number(rows[0].hist_low), 9900);
    assert.equal(Number(rows[0].target_cents), 10000);
  } finally {
    await store.close();
  }
});

test('markNotified 之后同价位不再重复提醒', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const gameId = await seed(store, 9900, 9900);
    await db.upsertWatch(q, { gameId, targetCents: 10000 });

    const before = evaluateAlerts(await db.watchCandidates(q));
    assert.equal(before.length, 1);

    await db.markNotified(q, { watchId: before[0].watchId, priceCents: before[0].currentCents });

    const after = evaluateAlerts(await db.watchCandidates(q));
    assert.equal(after.length, 0, '记录后不应再提醒');

    // 再降价则应重新提醒
    await ingestOffers(store, { platform: { code: 'steam', name: 'Steam 国区', kind: 'official' }, offers: [offer(8000)] });
    const cheaper = evaluateAlerts(await db.watchCandidates(q));
    assert.equal(cheaper.length, 1);
    assert.equal(cheaper[0].currentCents, 8000);
  } finally {
    await store.close();
  }
});

test('取消关注后从候选里消失', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const gameId = await seed(store, 14900, 9900);
    await db.upsertWatch(q, { gameId, targetCents: 10000 });
    assert.equal((await db.deleteWatch(q, { gameId })), 1);
    assert.equal((await db.watchCandidates(q)).length, 0);
    assert.equal((await db.deleteWatch(q, { gameId })), 0, '重复删除返回 0');
  } finally {
    await store.close();
  }
});

test('删除游戏会级联清掉关注项', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const gameId = await seed(store, 14900, 9900);
    await db.upsertWatch(q, { gameId, targetCents: 10000 });

    await store.query('delete from games where id = $1', [gameId]);
    const left = await q('select count(*)::int as c from watchlist');
    assert.equal(left.rows[0].c, 0, '外键级联应当生效');
  } finally {
    await store.close();
  }
});
