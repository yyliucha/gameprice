// 后台回填：参数收敛、命令行拼装、进度解析、价格回退合并
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBackfillParams,
  backfillArgs,
  parseBackfillProgress,
  missingPriceAppids,
  offerFromItem,
  mergePriceOffers,
} from '../src/backfill.js';

test('参数归一化：默认值与上限/下限', () => {
  assert.deepEqual(normalizeBackfillParams({}), { limit: 200000, batch: 100, sleep: 3000, fallback: 10 });
  assert.deepEqual(normalizeBackfillParams({ limit: 999999, batch: 500, sleep: 999999, fallback: 500 }), {
    limit: 200000, batch: 100, sleep: 60000, fallback: 100,
  });
  assert.deepEqual(normalizeBackfillParams({ limit: 0, batch: -5, sleep: -1, fallback: -2 }), {
    limit: 1, batch: 1, sleep: 0, fallback: 0,
  });
  assert.deepEqual(normalizeBackfillParams({ limit: 'abc', batch: null, sleep: undefined, fallback: 'x' }), {
    limit: 200000, batch: 100, sleep: 3000, fallback: 10,
  });
});

test('子进程参数拼装', () => {
  assert.deepEqual(backfillArgs({ limit: 200000, batch: 100, sleep: 3000, fallback: 0 }), [
    'src/cli.js', 'backfill',
    '--limit', '200000',
    '--batch', '100',
    '--sleep', '3000',
    '--fallback', '0',
  ]);
});

test('进度解析：取最后一条批次行并算百分比', () => {
  const output = [
    '批量回填：每批 100 个、间隔 3000ms、上限 200000 款、单条回退 10 个/批',
    '  批次 1：本批 100 款，写入 100，回退 0，失败 0；累计 100/200000（600 款/分钟）',
    '  批次 2：本批 100 款，写入 95，回退 5，失败 0；累计 200/200000（640 款/分钟）',
  ].join('\n');
  assert.deepEqual(parseBackfillProgress(output), {
    batches: 2, batchSize: 100, written: 95, fallback: 5, failed: 0,
    done: 200, limit: 200000, ratePerMin: 640, percent: 0.1,
  });
  assert.equal(parseBackfillProgress('没有进度'), null);
});

test('缺价 appid：只挑没有 priceOverview 的，去重且忽略非法 appid', () => {
  const items = [
    { steamAppid: 730, priceOverview: { final: 0 } },
    { steamAppid: 570 },
    { steamAppid: 570 },
    { steamAppid: 271590, priceOverview: null },
    { steamAppid: 0 },
    { steamAppid: null },
  ];
  assert.deepEqual(missingPriceAppids(items), [570, 271590]);
  assert.deepEqual(missingPriceAppids([]), []);
});

test('GetItems 报价 → RawOffer，字段对齐 syncPrices 输出', () => {
  const offer = offerFromItem({
    steamAppid: 271590,
    nameZh: 'GTA V',
    priceOverview: { final: 11900, initial: 17900, discountPercent: 33, currency: 'CNY' },
  });
  assert.equal(offer.platformCode, 'steam');
  assert.equal(offer.steamAppid, 271590);
  assert.equal(offer.title, 'GTA V');
  assert.equal(offer.priceCents, 11900);
  assert.equal(offer.originalCents, 17900);
  assert.equal(offer.discountPct, 33);
  assert.equal(offer.region, 'cn');
  assert.equal(offerFromItem({ steamAppid: 1 }), null);
});

test('报价标题兜底：nameZh 为空时用 nameEn，避免 appid 数字写进名字', () => {
  const withEn = offerFromItem({
    steamAppid: 892970,
    nameZh: null,
    nameEn: 'Valheim',
    priceOverview: { final: 7000, initial: 7000, discountPercent: 0, currency: 'CNY' },
  });
  assert.equal(withEn.title, 'Valheim');
  const neither = offerFromItem({
    steamAppid: 892970,
    nameZh: null,
    nameEn: null,
    priceOverview: { final: 7000, initial: 7000, discountPercent: 0, currency: 'CNY' },
  });
  assert.equal(neither.title, '892970');
});

test('合并报价：GetItems 自带 + appdetails 回退，同一 appid 不重复写', () => {
  const items = [
    { steamAppid: 730, nameZh: 'CS2', priceOverview: { final: 0, initial: 0, discountPercent: 0 } },
    { steamAppid: 570, nameZh: 'Dota 2' },
  ];
  const fallback = [
    { platformCode: 'steam', steamAppid: 570, title: 'Dota 2', priceCents: 100, originalCents: 100, discountPct: 0, region: 'cn' },
    { platformCode: 'steam', steamAppid: 730, title: 'CS2', priceCents: 0, originalCents: 0, discountPct: 0, region: 'cn' },
    { platformCode: 'steam', steamAppid: 440, title: 'TF2', priceCents: 0, originalCents: 0, discountPct: 0, region: 'cn' },
  ];
  const merged = mergePriceOffers(items, fallback);
  assert.deepEqual(merged.map((o) => o.steamAppid).sort((a, b) => a - b), [440, 570, 730]);
  assert.equal(merged.length, 3, '同一 appid 不能出现两条');
});
