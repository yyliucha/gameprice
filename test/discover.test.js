// SKU 自动发现：扫描区间计算、探测循环、合并进 skus.json。
// 探测循环不依赖网络——fetchSku 由测试注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planScan, discoverSkus, mergeSkuEntries } from '../src/adapters/sonkwo-discover.js';

test('扫描区间从已知最大 id 向前，带重叠', () => {
  const range = planScan({ knownMax: 111491, ahead: 20, overlap: 3 });
  assert.equal(range.from, 111489);
  assert.equal(range.to, 111508);
});

test('水位比已知 id 大时以水位为准（避免重复扫描）', () => {
  const range = planScan({ knownMax: 100, state: { highWaterMark: 200 }, ahead: 10, overlap: 1 });
  assert.equal(range.from, 200);
  assert.equal(range.to, 209);
});

test('没有任何起点时返回 null，交由调用方报错', () => {
  assert.equal(planScan({ knownMax: 0, state: {} }), null);
  assert.equal(planScan({ knownMax: 0, state: { highWaterMark: 0 } }), null);
});

test('探测：命中入列，连续空壳触发提前停止', async () => {
  // 111442 起连续 3 个商品，然后全空
  const products = new Set([442, 443, 444]);
  const calls = [];
  const result = await discoverSkus({
    from: 442,
    to: 500,
    rate: 0,
    stopAfterMisses: 3,
    fetchSku: async (id) => {
      calls.push(id);
      return products.has(id) ? { title: `game-${id}`, priceCents: id * 10 } : null;
    },
  });

  assert.equal(result.found.length, 3);
  assert.deepEqual(result.found.map((f) => f.skuId), [442, 443, 444]);
  assert.equal(result.found[0].name, 'game-442');
  assert.equal(result.found[0].priceCents, 4420);
  assert.equal(result.stopReason, 'consecutive_misses');
  assert.equal(result.probed, 6, '3 个命中 + 3 个空壳后停止');
  assert.equal(calls.length, 6);
  assert.equal(result.misses.length, 3);
});

test('探测：扫到区间末尾自然结束，不误判为提前停止', async () => {
  const result = await discoverSkus({
    from: 1,
    to: 5,
    rate: 0,
    stopAfterMisses: 10,
    fetchSku: async (id) => (id % 2 === 0 ? { title: `g${id}`, priceCents: 100 } : null),
  });
  assert.equal(result.probed, 5);
  assert.equal(result.found.length, 2);
  assert.equal(result.stopReason, 'range_end');
});

test('探测：404 与异常都按空壳处理，不中断', async () => {
  const result = await discoverSkus({
    from: 1,
    to: 3,
    rate: 0,
    stopAfterMisses: 10,
    fetchSku: async (id) => {
      if (id === 1) {
        const err = new Error('HTTP 404');
        err.status = 404;
        throw err;
      }
      if (id === 2) throw new Error('boom');
      return { title: 'ok', priceCents: 1 };
    },
  });
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].skuId, 3);
  assert.deepEqual(result.misses, [1, 2]);
});

test('探测：onHit 回调逐个通知（用于 CLI 实时输出）', async () => {
  const hits = [];
  await discoverSkus({
    from: 1,
    to: 3,
    rate: 0,
    stopAfterMisses: 5,
    fetchSku: async (id) => ({ title: `g${id}`, priceCents: 1 }),
    onHit: (item) => hits.push(item.skuId),
  });
  assert.deepEqual(hits, [1, 2, 3]);
});

test('合并：按 skuId 去重、保留 appid、补全名称、按 id 排序', () => {
  const existing = [
    { skuId: 3, appid: 123, name: '旧名' },
    { skuId: 1, appid: null, name: null },
  ];
  const found = [
    { skuId: 1, name: '第一个游戏' },
    { skuId: 2, name: '新游戏' },
    { skuId: 3, name: '不该覆盖' },
  ];
  const result = mergeSkuEntries(existing, found);

  assert.deepEqual(result.entries.map((e) => e.skuId), [1, 2, 3]);
  assert.equal(result.added, 1, '只新增 2');
  assert.equal(result.named, 1, '补了 1 的缺失名称');
  assert.equal(result.entries.find((e) => e.skuId === 1).name, '第一个游戏');
  assert.equal(result.entries.find((e) => e.skuId === 3).appid, 123, '已有映射必须保留');
  assert.equal(result.entries.find((e) => e.skuId === 3).name, '旧名', '已有名称不被覆盖');
});

test('合并：空输入不炸', () => {
  assert.deepEqual(mergeSkuEntries().entries, []);
  assert.equal(mergeSkuEntries([], []).added, 0);
  // 非法 skuId 被忽略
  assert.equal(mergeSkuEntries([], [{ skuId: 'x' }]).entries.length, 0);
});
