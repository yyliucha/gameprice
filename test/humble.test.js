import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slugify, slugCandidates, parseProductLd, toOffer, searchOffer } from '../src/adapters/humble.js';

// 真实商品页里的 JSON-LD（2026-10-26 抓取）
const ld = JSON.parse(readFileSync(new URL('./fixtures/real-humble-product-ld.json', import.meta.url), 'utf8'));

const htmlWith = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;
const response = (body, status = 200) => async (url) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: () => 'text/html' },
  text: async () => body,
});

test('slug 生成与候选（含去掉副标题的版本）', () => {
  assert.equal(slugify('Cyberpunk 2077'), 'cyberpunk-2077');
  assert.equal(slugify("Baldur's Gate 3"), 'baldurs-gate-3');
  assert.equal(slugify('Wolfenstein & Doom'), 'wolfenstein-and-doom');
  assert.deepEqual(slugCandidates('The Witcher 3: Wild Hunt'), ['the-witcher-3-wild-hunt', 'the-witcher-3']);
});

test('能从真实 JSON-LD 里取到名称、价格与币种', () => {
  const parsed = parseProductLd(htmlWith(ld));
  assert.ok(parsed);
  assert.equal(parsed.name, 'Cyberpunk 2077');
  assert.equal(parsed.price, 400.14);
  assert.equal(parsed.currency, 'CNY');
  assert.equal(parsed.sku, 'cyberpunk2077_storefront');
});

test('没有 JSON-LD 或没有价格时返回 null', () => {
  assert.equal(parseProductLd('<html>nothing</html>'), null);
  assert.equal(parseProductLd(htmlWith({ '@type': 'Product', name: 'No Offers' })), null);
});

test('JSON-LD 转报价：分、币种、库存、链接', () => {
  const offer = toOffer(parseProductLd(htmlWith(ld)), { slug: 'cyberpunk-2077', steamAppid: 1091500 });
  assert.equal(offer.platformCode, 'humble');
  assert.equal(offer.priceCents, 40014);
  assert.equal(offer.currency, 'CNY');
  assert.equal(offer.inStock, true);
  assert.equal(offer.steamAppid, 1091500, '必须带上 steamAppid 才能并入已有游戏行');
  assert.equal(offer.productType, 'authorized_key');
  assert.match(offer.buyUrl, /humblebundle\.com\/store\/cyberpunk-2077/);
});

test('searchOffer 命中时返回报价并注入 steamAppid', async () => {
  const { offer, tried } = await searchOffer('Cyberpunk 2077', {
    fetchImpl: response(htmlWith(ld)),
    steamAppid: 1091500,
  });
  assert.ok(offer);
  assert.equal(offer.priceCents, 40014);
  assert.equal(offer.steamAppid, 1091500);
  assert.equal(tried.length, 0, '首个候选就命中，不应继续探测');
});

test('名称不一致时拒绝，绝不张冠李戴', async () => {
  const other = { ...ld, name: 'Some Other Game' };
  const { offer, tried } = await searchOffer('Cyberpunk 2077', { fetchImpl: response(htmlWith(other)) });
  assert.equal(offer, null);
  assert.equal(tried.length, 1, '无副标题时只有一个候选 slug');
  assert.ok(tried.every((t) => t.note === 'name_mismatch'));
});

test('商品不存在被重定向到首页时按"不存在"处理', async () => {
  // 真实行为：/store/grand-theft-auto-v → 302 → /store（200，无 JSON-LD）
  const redirecting = async (url) => ({
    ok: true,
    status: 200,
    url: 'https://www.humblebundle.com/store',
    finalUrl: 'https://www.humblebundle.com/store',
    headers: { get: () => 'text/html' },
    text: async () => '<html>front page</html>',
  });
  const { offer, tried } = await searchOffer('Grand Theft Auto V', { fetchImpl: redirecting });
  assert.equal(offer, null);
  assert.ok(tried.every((t) => t.note === 'redirected'), `实际：${JSON.stringify(tried)}`);
});

test('404 视为"这家店没这款游戏"，继续试下一个候选', async () => {
  const { offer, tried } = await searchOffer('Hades II', { fetchImpl: response('not found', 404) });
  assert.equal(offer, null);
  assert.equal(tried.length, 1);
  assert.ok(tried.every((t) => t.note === 'not_found'));
});

test('标题带副标题时会依次尝试两个候选', async () => {
  const { tried } = await searchOffer('The Witcher 3: Wild Hunt', { fetchImpl: response('not found', 404) });
  assert.equal(tried.length, 2, '应尝试 "the-witcher-3-wild-hunt" 与 "the-witcher-3"');
});
