// 合并重复游戏行：把无 appid 的孤立行并进已有 Steam 游戏行。
// 跑在真 PG 语义上（PGlite），因为涉及 unique 约束与 upsert 行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { ingestOffers } from '../src/ingest.js';

const offer = (platform, priceCents, over = {}) => ({
  platformCode: platform,
  platformProductId: over.productId ?? '111454',
  steamAppid: over.steamAppid ?? null,
  title: over.title ?? '愚者不灭',
  productType: over.productType ?? (platform === 'steam' ? 'official_direct' : 'authorized_key'),
  region: 'cn',
  currency: 'CNY',
  priceCents,
  originalCents: priceCents,
  discountPct: 0,
  inStock: true,
  buyUrl: 'https://example.com/x',
  meta: {},
});

async function seed(store) {
  const q = (sql, p) => store.query(sql, p);
  // 目标：已有 Steam appid 的游戏
  await ingestOffers(store, {
    platform: { code: 'steam', name: 'Steam 国区', kind: 'official' },
    offers: [offer('steam', 9900, { steamAppid: 1091500, title: '赛博朋克 2077', productId: '1091500' })],
  });
  const targetId = (await q('select id from games where steam_appid = 1091500')).rows[0].id;

  // 来源：按名称建出来的孤立行（无 appid），带一个 sonkwo 报价
  await ingestOffers(store, {
    platform: { code: 'sonkwo', name: '杉果', kind: 'authorized_reseller' },
    offers: [offer('sonkwo', 8800, { title: '赛博朋克 2077 标准版', productId: '111454' })],
  });
  const orphan = (await q('select id from games where name = $1 and steam_appid is null', ['赛博朋克 2077 标准版'])).rows[0];
  return { targetId: Number(targetId), orphanId: Number(orphan.id) };
}

test('合并：报价与快照搬到目标行，源行被删除', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const { targetId, orphanId } = await seed(store);

    const result = await db.mergeGames(q, { fromGameId: orphanId, toGameId: targetId });
    assert.equal(result.merged, true);
    assert.equal(result.moved, 1);

    const offers = await q('select platform_code from offers where game_id = $1 order by platform_code', [targetId]);
    assert.deepEqual(offers.rows.map((r) => r.platform_code), ['sonkwo', 'steam']);

    const orphan = await q('select count(*)::int as c from games where id = $1', [orphanId]);
    assert.equal(orphan.rows[0].c, 0, '源游戏行应被删除');

    const snapshots = await q('select count(*)::int as c from price_snapshots');
    assert.equal(snapshots.rows[0].c, 2, '快照跟随 offer_id，不应丢失');
  } finally {
    await store.close();
  }
});

test('合并：同平台同渠道的重复报价保留目标行，源行快照一并清理', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const { targetId, orphanId } = await seed(store);

    // 给孤立行也插一条 steam 报价（同平台/类型/区服 → 与目标行冲突）
    await ingestOffers(store, {
      platform: { code: 'steam', name: 'Steam 国区', kind: 'official' },
      offers: [offer('steam', 12000, { steamAppid: null, title: '赛博朋克 2077 标准版', productId: 'dupe' })],
    });

    const result = await db.mergeGames(q, { fromGameId: orphanId, toGameId: targetId });
    assert.equal(result.dropped, 1, '重复报价应被丢弃');
    const steam = await q('select price_cents from offers where game_id = $1 and platform_code = $2', [targetId, 'steam']);
    assert.equal(steam.rows.length, 1);
    assert.equal(steam.rows[0].price_cents, 9900, '保留目标行原价');
  } finally {
    await store.close();
  }
});

test('合并：日聚合取更低价，旧日期也一起带过来', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const { targetId, orphanId } = await seed(store);

    await q(
      `insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
       values ($1,'sonkwo','cn', current_date - 10, 7900, 'CNY')`,
      [orphanId],
    );
    await q(
      `insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
       values ($1,'steam','cn', current_date - 10, 8900, 'CNY')`,
      [targetId],
    );

    await db.mergeGames(q, { fromGameId: orphanId, toGameId: targetId });
    const rows = await q(
      'select platform_code, min_price_cents from daily_prices where game_id = $1 and day = current_date - 10',
      [targetId],
    );
    assert.equal(rows.rows.length, 2, '两个平台的日聚合都应保留在目标行');
    const leftovers = await q('select count(*)::int as c from daily_prices where game_id = $1', [orphanId]);
    assert.equal(leftovers.rows[0].c, 0, '源行的日聚合应清空');
  } finally {
    await store.close();
  }
});

test('合并：关注列表搬过去，同区服重复的丢源行', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const { targetId, orphanId } = await seed(store);

    await q('insert into watchlist (game_id, region, target_cents) values ($1, $2, $3)', [targetId, 'cn', 9000]);
    await q('insert into watchlist (game_id, region, target_cents) values ($1, $2, $3)', [orphanId, 'cn', 8000]);
    await q('insert into watchlist (game_id, region, target_cents) values ($1, $2, $3)', [orphanId, 'us', 7000]);

    await db.mergeGames(q, { fromGameId: orphanId, toGameId: targetId });

    const rows = await q('select region, target_cents from watchlist where game_id = $1 order by region', [targetId]);
    assert.deepEqual(rows.rows.map((r) => r.region), ['cn', 'us'], 'cn 保留目标行，us 搬过来');
    assert.equal(rows.rows.find((r) => r.region === 'cn').target_cents, 9000);
    assert.equal(rows.rows.find((r) => r.region === 'us').target_cents, 7000);
  } finally {
    await store.close();
  }
});

test('合并：同 id / 不存在的行直接跳过，不抛异常', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const { targetId } = await seed(store);

    assert.equal((await db.mergeGames(q, { fromGameId: targetId, toGameId: targetId })).merged, false);
    assert.equal((await db.mergeGames(q, { fromGameId: 999999, toGameId: targetId })).reason, 'source_missing');
    assert.equal((await db.mergeGames(q, { fromGameId: targetId, toGameId: 999999 })).reason, 'target_missing');
  } finally {
    await store.close();
  }
});
