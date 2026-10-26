// 多区服对比：分组、同币种比较、终端渲染。
// 核心约束：不同币种不做汇率折算，只并排展示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, groupOffersByRegion, cheapestPerCurrency, renderCompare } from '../src/compare.js';

const row = (region, currency, priceCents, over = {}) => ({
  region,
  currency,
  platform_code: over.platform ?? 'gog',
  platform_name: over.platformName ?? 'GOG',
  price_cents: priceCents,
  original_cents: over.original ?? priceCents,
  discount_pct: over.discount ?? 0,
});

test('金额按币种符号格式化，未知币种回退到代码', () => {
  assert.equal(formatMoney(8900, 'CNY'), '¥89.00');
  assert.equal(formatMoney(2999, 'USD'), '$29.99');
  assert.equal(formatMoney(123456, 'TRY'), '₺1234.56');
  assert.equal(formatMoney(100, 'XYZ'), 'XYZ 1.00');
  assert.equal(formatMoney(null, 'CNY'), '—');
});

test('按区服分组，组内按价格升序并标出最低', () => {
  const groups = groupOffersByRegion([
    row('cn', 'CNY', 9900),
    row('cn', 'CNY', 8900),
    row('us', 'USD', 2999),
  ]);
  assert.deepEqual(groups.map((g) => g.region), ['cn', 'us'], '区服按名称排序');

  const cn = groups.find((g) => g.region === 'cn');
  assert.deepEqual(cn.offers.map((o) => o.price_cents), [8900, 9900], '组内升序');
  assert.equal(cn.offers[0].isCheapest, true);
  assert.equal(cn.offers[1].isCheapest, false);
});

test('同币种才比价格：不同币种各自选出最低', () => {
  const groups = groupOffersByRegion([row('cn', 'CNY', 8900), row('us', 'USD', 2999)]);
  const best = cheapestPerCurrency(groups);
  assert.deepEqual(best.map((b) => b.currency), ['CNY', 'USD']);
  assert.equal(best.find((b) => b.currency === 'CNY').region, 'cn');
  assert.equal(best.find((b) => b.currency === 'USD').region, 'us');
});

test('同币种跨区只保留更低的那一区', () => {
  // 少见但可能：两个区都用 USD（例如美区和港区都用美元结算的店铺）
  const groups = groupOffersByRegion([
    row('us', 'USD', 2999),
    row('hk', 'USD', 2799),
  ]);
  const best = cheapestPerCurrency(groups);
  assert.equal(best.length, 1, '同一币种只给一个结论');
  assert.equal(best[0].region, 'hk');
  assert.equal(best[0].priceCents, 2799);
});

test('渲染：表头、区服行、每区最低标记', () => {
  const text = renderCompare({
    game: { name: '赛博朋克 2077', steam_appid: 1091500 },
    rows: [row('cn', 'CNY', 8900, { discount: 70 }), row('us', 'USD', 2999, { discount: 40 })],
    generatedAt: '2026-10-26 14:00:00',
  });
  assert.match(text, /赛博朋克 2077（appid 1091500）/);
  assert.match(text, /区服/);
  assert.match(text, /cn\s+CNY\s+GOG\s+¥89\.00\s+-70%/);
  assert.match(text, /us\s+USD\s+GOG\s+\$29\.99\s+-40%/);
  assert.match(text, /该区最低/);
  assert.match(text, /同币种内最低：CNY @ cn ¥89\.00；USD @ us \$29\.99/);
  assert.match(text, /不同币种未做汇率折算/);
});

test('渲染：单币种时不出现折算提示', () => {
  const text = renderCompare({ game: { name: 'X' }, rows: [row('cn', 'CNY', 100)] });
  assert.ok(!text.includes('汇率折算'), '只有一个币种时不必提示');
});

test('渲染：没有报价时给出可读提示', () => {
  assert.match(renderCompare({ game: { name: 'X' }, rows: [] }), /还没有多区服报价/);
});
