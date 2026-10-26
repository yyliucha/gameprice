import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTitle, pickExactMatch, toOffer, searchOffer, buildSearchUrl, resolveRegion, REGIONS } from '../src/adapters/gog.js';

// 真实 catalog 响应（2026-10-26 抓取，含 Phantom Liberty / Ultimate Edition 两个干扰项）
const catalog = JSON.parse(readFileSync(new URL('./fixtures/real-gog-catalog.json', import.meta.url), 'utf8'));

function fakeFetch(json) {
  const text = JSON.stringify(json);
  return async (url) => ({ ok: true, status: 200, url, headers: { get: () => 'application/json' }, text: async () => text });
}

test('标题归一化忽略大小写、标点与商标符号', () => {
  assert.equal(normalizeTitle('Cyberpunk 2077®'), 'cyberpunk 2077');
  assert.equal(normalizeTitle('ELDEN RING™'), 'elden ring');
  assert.equal(normalizeTitle('The Witcher 3: Wild Hunt'), 'the witcher 3 wild hunt');
  assert.equal(normalizeTitle(null), '');
});

test('精确匹配能挑出本体，跳过 DLC 与终极版', () => {
  const picked = pickExactMatch(catalog.products, 'Cyberpunk 2077');
  assert.ok(picked, '应匹配到本体');
  assert.equal(picked.title, 'Cyberpunk 2077');
  assert.equal(picked.id, '2093619782');
});

test('模糊结果绝不能被当成匹配（这是数据正确性的底线）', () => {
  // GOG 搜 "elden ring" 真实返回的就是这类无关商品
  const fuzzy = [
    { id: '1', title: 'Whispers in the Moss', productType: 'game', price: {} },
    { id: '2', title: 'Whispers in the Moss Demo', productType: 'game', price: {} },
    { id: '3', title: 'Astalon: Tears of the Earth + 2 Soundtrack Albums!', productType: 'pack', price: {} },
  ];
  assert.equal(pickExactMatch(fuzzy, 'ELDEN RING'), null, '没有精确标题必须返回 null');
  assert.equal(pickExactMatch([], 'Hades'), null);
  assert.equal(pickExactMatch(catalog.products, ''), null);
});

test('同标题多产品时优先 game 而不是 pack/dlc', () => {
  const both = [
    { id: 'a', title: 'GameX', productType: 'pack', price: {} },
    { id: 'b', title: 'GameX', productType: 'game', price: {} },
  ];
  assert.equal(pickExactMatch(both, 'GameX').id, 'b');
});

test('catalog 产品转成报价：分、原价、折扣、链接', () => {
  const base = catalog.products.find((p) => p.title === 'Cyberpunk 2077');
  const offer = toOffer(base);
  assert.equal(offer.platformCode, 'gog');
  assert.equal(offer.priceCents, 8900);
  assert.equal(offer.originalCents, 29800);
  assert.equal(offer.discountPct, 70);
  assert.equal(offer.currency, 'CNY');
  assert.equal(offer.region, 'cn');
  assert.match(offer.buyUrl, /gog\.com/);
  assert.equal(offer.inStock, true);
  assert.equal(offer.meta.productType, base.productType);
});

test('没有价格的产品返回 null，不编造', () => {
  assert.equal(toOffer({ id: 'x', title: 'No Price', price: {} }), null);
  assert.equal(toOffer(null), null);
});

test('searchOffer 走接口并返回精确匹配的报价', async () => {
  const { offer, candidates } = await searchOffer('Cyberpunk 2077', { fetchImpl: fakeFetch(catalog), steamAppid: 1091500 });
  assert.ok(offer);
  assert.equal(offer.title, 'Cyberpunk 2077');
  assert.equal(offer.priceCents, 8900);
  assert.equal(offer.steamAppid, 1091500, '必须带上 steamAppid 才能并入已有游戏行');
  assert.equal(candidates, 3);
});

test('searchOffer 在只有模糊结果时返回 null', async () => {
  const fuzzy = { products: [{ id: '1', title: 'Whispers in the Moss', productType: 'game', price: { finalMoney: { amount: '22', currency: 'CNY' } } }] };
  const { offer } = await searchOffer('ELDEN RING', { fetchImpl: fakeFetch(fuzzy) });
  assert.equal(offer, null);
});

test('区服解析：国家与币种成对返回，未知区服直接报错', () => {
  assert.deepEqual(resolveRegion('cn'), { region: 'cn', country: 'CN', currency: 'CNY' });
  assert.equal(resolveRegion('US').currency, 'USD', '大小写不敏感');
  assert.equal(resolveRegion('tr').country, 'TR');
  assert.throws(() => resolveRegion('xx'), /不支持区服/);
  assert.ok(Object.keys(REGIONS).length >= 5);
});

test('toOffer 写入请求的区服（币种仍以接口返回为准）', () => {
  const base = catalog.products.find((p) => p.title === 'Cyberpunk 2077');
  const offer = toOffer(base, { region: 'us' });
  assert.equal(offer.region, 'us');
  assert.equal(offer.currency, 'CNY', '币种来自接口响应，不靠本地推断');
});
test('查询 URL 带上区服与币种（决定拿到的价格口径）', () => {
  const url = new URL(buildSearchUrl('Cyberpunk 2077', { country: 'CN', currency: 'CNY', limit: 5 }));
  assert.equal(url.searchParams.get('countryCode'), 'CN');
  assert.equal(url.searchParams.get('currencyCode'), 'CNY');
  assert.equal(url.searchParams.get('query'), 'like:Cyberpunk 2077');
  assert.equal(url.searchParams.get('limit'), '5');
});
