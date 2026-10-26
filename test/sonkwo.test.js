import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSkuPage,
  extractRemixContext,
  findSkuObjects,
  parseListingCards,
} from '../src/adapters/sonkwo.js';

// 真实页面快照（2026-10-26 抓取），不是手写样例——这样解析器改动会立刻暴露
const skuHtml = readFileSync(new URL('./fixtures/real-sonkwo-sku.html', import.meta.url), 'utf8');
const activityHtml = readFileSync(new URL('./fixtures/real-sonkwo-activity.html', import.meta.url), 'utf8');

test('能抠出 window.__remixContext 的 JSON', () => {
  const ctx = extractRemixContext(skuHtml);
  assert.ok(ctx, 'remix context 应该解析成功');
  assert.equal(typeof ctx, 'object');
});

test('能递归找到所有 SKU 对象', () => {
  const objs = findSkuObjects(extractRemixContext(skuHtml));
  assert.ok(objs.length >= 2, `应至少找到 2 个 SKU，实际 ${objs.length}`);
  const ids = objs.map((o) => Number(o.sku_id ?? o.id));
  assert.ok(ids.includes(111454));
  assert.ok(ids.includes(111455));
});

test('商品页 111454 → ￥198，名称取 sku_names.chs', () => {
  const offer = parseSkuPage(skuHtml, { skuId: 111454 });
  assert.ok(offer);
  assert.equal(offer.platformCode, 'sonkwo');
  assert.equal(offer.platformProductId, '111454');
  assert.equal(offer.priceCents, 19800);
  assert.equal(offer.currency, 'CNY');
  assert.equal(offer.region, 'cn');
  assert.equal(offer.productType, 'authorized_key');
  assert.equal(offer.buyUrl, 'https://www.sonkwo.hk/sku/111454');
  assert.match(offer.title, /愚者不灭/);
  assert.equal(offer.meta.priceSource, 'json');
});

test('同一页面的另一个版本按 skuId 精确取价（不被邻座污染）', () => {
  const offer = parseSkuPage(skuHtml, { skuId: 111455 });
  assert.equal(offer.priceCents, 26900);
  assert.match(offer.title, /荣光痴人版/);
  assert.equal(offer.originalCents, 26900);
  assert.equal(offer.discountPct, 0);
});

test('没有内嵌 JSON 时退化为 DOM 解析，并且能算折扣', () => {
  const html =
    '<html><head><title>某游戏【攻略】_杉果游戏</title></head><body>' +
    '<span class="SKC-sale-price price-text">￥12.34</span></body></html>';
  const offer = parseSkuPage(html, { skuId: 999 });
  assert.equal(offer.priceCents, 1234);
  assert.equal(offer.meta.priceSource, 'dom');
  assert.match(offer.title, /某游戏/);
});

test('页面既无 JSON 也无价格时返回 null（不能编造价格）', () => {
  assert.equal(parseSkuPage('<html><title>x</title></html>', { skuId: 1 }), null);
});

test('活动页能解析出卡片（名称+价格）', () => {
  const cards = parseListingCards(activityHtml);
  assert.ok(cards.length > 0, '应解析出卡片');
  for (const c of cards) {
    assert.ok(c.name.length > 0);
    assert.ok(c.priceCents > 0);
  }
});
