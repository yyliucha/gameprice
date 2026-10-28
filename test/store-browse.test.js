// GetItems 批量接口：请求体、字段映射、分批与失败收集（用假 fetch，不发真实请求）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, mapStoreItem, fetchStoreItems, CHUNK } from '../src/adapters/store-browse.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://api.steampowered.com/test',
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    text: async () => JSON.stringify(body),
  };
}

test('请求体：最多 100 个 id，带国区/语言上下文', () => {
  const body = buildBody([730, 570], { country: 'CN', language: 'schinese' });
  assert.deepEqual(body.ids, [{ appid: 730 }, { appid: 570 }]);
  assert.equal(body.context.country_code, 'CN');
  assert.equal(body.context.language, 'schinese');
  assert.equal(body.data_request.include_basic_info, true);
  assert.equal(CHUNK, 100);
});

test('字段映射：名称/类型/开发商/简介/国区价格', () => {
  const item = mapStoreItem({
    appid: 730,
    name: 'Counter-Strike 2',
    type: 'app',
    basic_info: {
      short_description: '<b>FPS</b> 游戏&amp;经典',
      developers: ['Valve'],
      publishers: ['Valve'],
      genres: [{ description: '动作' }],
    },
    best_purchase_option: {
      final_price: { amount: 0, currency: 'CNY' },
      original_price: { amount: 0, currency: 'CNY' },
      discount_percent: 0,
    },
  });
  assert.equal(item.steamAppid, 730);
  assert.equal(item.nameZh, 'Counter-Strike 2');
  assert.equal(item.appType, 'game');
  assert.deepEqual(item.developers, ['Valve']);
  assert.deepEqual(item.genres, ['动作']);
  assert.equal(item.description, 'FPS 游戏&经典');
  assert.equal(item.isFree, true);
  assert.equal(item.priceOverview.final, 0);
});

test('字段映射：DLC 与无价格', () => {
  const item = mapStoreItem({ appid: 123, name: 'DLC', type: 'dlc', basic_info: {} });
  assert.equal(item.appType, 'dlc');
  assert.equal(item.priceOverview, null);
  assert.equal(mapStoreItem(null), null);
});

test('分批请求：150 个 id 分两批，缺失的 appid 进 failed', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.ids.length);
    if (calls.length === 1) {
      // 第一批返回 100 个里的 99 个（漏掉第一个）
      const ids = body.ids.map((x) => x.appid).slice(1);
      return jsonResponse({ store_items: ids.map((id) => ({ appid: id, name: 'G' + id, type: 'app' })) });
    }
    const ids = body.ids.map((x) => x.appid);
    return jsonResponse({ store_items: ids.map((id) => ({ appid: id, name: 'G' + id, type: 'app' })) });
  };
  const appids = Array.from({ length: 150 }, (_, i) => 1000 + i);
  const r = await fetchStoreItems(appids, { key: 'k', fetchImpl });
  assert.equal(calls.length, 2, '应分成两批');
  assert.equal(calls[0], 100);
  assert.equal(calls[1], 50);
  assert.equal(r.items.length, 149);
  assert.deepEqual(r.failed, [1000]);
});

test('没有 key 时抛错（由调用方回退单条接口）', async () => {
  await assert.rejects(() => fetchStoreItems([730], {}), /STEAM_API_KEY/);
});
