// 并发池：限流、顺序、错误隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../src/pool.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('并发数不超过上限，且所有任务都完成', async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await runPool(items, 4, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(10);
    running -= 1;
    return n * 2;
  });
  assert.equal(results.length, 20);
  assert.equal(results.filter((r) => r.ok).length, 20);
  assert.ok(peak <= 4, '峰值并发不应超过 4，实际 ' + peak);
  assert.ok(peak >= 2, '并发应该真的并行（峰值 ' + peak + '）');
});

test('结果保持入参顺序', async () => {
  const items = [30, 10, 20];
  const results = await runPool(items, 3, async (n) => {
    await sleep(n);
    return n;
  });
  assert.deepEqual(results.map((r) => r.value), [30, 10, 20]);
});

test('单项失败被隔离，其他任务照常完成，进度回调总数正确', async () => {
  let progress = 0;
  const results = await runPool(
    [1, 2, 3, 4],
    2,
    async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    },
    { onProgress: () => { progress += 1; } },
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[2].ok, true);
  assert.equal(results[3].ok, true);
  assert.match(String(results[1].error.message), /boom/);
  assert.equal(progress, 4);
});

test('空列表与并发数非法值都不炸', async () => {
  assert.deepEqual(await runPool([], 4, async () => 1), []);
  const results = await runPool([1, 2], 0, async (n) => n);
  assert.deepEqual(results.map((r) => r.value), [1, 2], '并发 0 自动落到 1');
});
