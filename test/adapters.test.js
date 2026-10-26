import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAppDetailsUrl, parseAppDetails, syncPrices, chunk } from '../src/adapters/steam.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/steam-appdetails.json', import.meta.url), 'utf8'));

test('buildAppDetailsUrl 带上 appids / 区服 / 语言 / filters', () => {
  const url = new URL(buildAppDetailsUrl([730, 570], { region: 'cn', lang: 'schinese', filters: 'price_overview' }));
  assert.equal(url.origin + url.pathname, 'https://store.steampowered.com/api/appdetails');
  assert.equal(url.searchParams.get('appids'), '730,570');
  assert.equal(url.searchParams.get('cc'), 'cn');
  assert.equal(url.searchParams.get('l'), 'schinese');
  assert.equal(url.searchParams.get('filters'), 'price_overview');
});

test('parseAppDetails 把有价格的游戏解析成报价，免费/不存在记为 skipped', () => {
  const { offers, skipped } = parseAppDetails(fixture, { region: 'cn' });

  assert.equal(offers.length, 2);
  const cp = offers.find((o) => o.steamAppid === 1091500);
  assert.equal(cp.platformCode, 'steam');
  assert.equal(cp.platformProductId, '1091500');
  assert.equal(cp.priceCents, 14900);
  assert.equal(cp.originalCents, 29800);
  assert.equal(cp.discountPct, 50);
  assert.equal(cp.currency, 'CNY');
  assert.equal(cp.region, 'cn');
  assert.equal(cp.buyUrl, 'https://store.steampowered.com/app/1091500/');
  assert.equal(cp.inStock, true);

  const free = skipped.find((s) => s.appid === 730);
  assert.equal(free.reason, 'free');
  const missing = skipped.find((s) => s.appid === 999999);
  assert.equal(missing.reason, 'not_found_or_region_locked');
});

test('parseAppDetails 容忍空响应', () => {
  assert.deepEqual(parseAppDetails(null), { offers: [], skipped: [] });
});

test('chunk 按批切分且不丢尾巴', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('syncPrices 走批量请求、去重、把失败项归入 skipped（无网络，靠注入 fetch）', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const ids = new URL(url).searchParams.get('appids').split(',');
    const body = Object.fromEntries(ids.map((id) => [id, fixture[id] ?? { success: false }]));
    const text = JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'application/json' },
      text: async () => text,
    };
  };

  const result = await syncPrices({
    appids: [1091500, 1245620, 730, 999999, 1091500],
    fetchImpl: fakeFetch,
    batchSize: 30,
    rateLimitMs: 0,
  });

  assert.equal(calls.length, 1, '5 个 appid 应合成 1 次请求');
  assert.equal(result.requests, 1);
  assert.equal(result.offers.length, 2);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.bytes > 0);
});
