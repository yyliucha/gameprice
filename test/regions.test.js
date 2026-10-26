// 跨区服报价的存储行为（真 PG 语义，PGlite）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { ingestOffers } from '../src/ingest.js';
import { groupOffersByRegion, cheapestPerCurrency } from '../src/compare.js';

const gogOffer = (region, currency, priceCents) => ({
  platformCode: 'gog',
  platformProductId: '2093619782',
  steamAppid: 1091500,
  title: 'Cyberpunk 2077',
  productType: 'authorized_key',
  region,
  currency,
  priceCents,
  originalCents: 29800,
  discountPct: Math.round((1 - priceCents / 29800) * 100),
  inStock: true,
  buyUrl: 'https://www.gog.com/en/game/cyberpunk_2077',
  meta: {},
});

async function seed(store) {
  await ingestOffers(store, {
    platform: { code: 'gog', name: 'GOG', kind: 'authorized_reseller' },
    offers: [gogOffer('cn', 'CNY', 8900), gogOffer('us', 'USD', 2999)],
  });
  return (sql, p) => store.query(sql, p);
}

test('同一游戏可以在多个区服各存一条报价（唯一键含 region）', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = await seed(store);
    const rows = await db.regionOffers(q, { steamAppid: 1091500 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.region), ['cn', 'us'], '按区服名排序');
    assert.deepEqual(rows.map((r) => r.currency), ['CNY', 'USD']);
  } finally {
    await store.close();
  }
});

test('regionOffers 可按区服过滤', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = await seed(store);
    const cn = await db.regionOffers(q, { steamAppid: 1091500, region: 'cn' });
    assert.equal(cn.length, 1);
    assert.equal(cn[0].price_cents, 8900);
  } finally {
    await store.close();
  }
});

test('跨区报价能直接喂给对比视图：分组 + 同币种最低', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = await seed(store);
    const rows = await db.regionOffers(q, { steamAppid: 1091500 });
    const groups = groupOffersByRegion(rows);
    assert.deepEqual(groups.map((g) => g.region), ['cn', 'us']);
    const best = cheapestPerCurrency(groups);
    assert.deepEqual(best.map((b) => `${b.currency}@${b.region}`), ['CNY@cn', 'USD@us']);
  } finally {
    await store.close();
  }
});

test('C2C 报价不会出现在跨区视图里（结构约束同样生效）', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = await seed(store);
    await ingestOffers(store, {
      platform: { code: 'steampy', name: 'SteamPy', kind: 'c2c' },
      offers: [{ ...gogOffer('cn', 'CNY', 300), platformCode: 'steampy', productType: 'c2c_listing' }],
    });
    const rows = await db.regionOffers(q, { steamAppid: 1091500 });
    assert.ok(!rows.some((r) => r.platform_code === 'steampy'), 'C2C 不得进入对比视图');
  } finally {
    await store.close();
  }
});
