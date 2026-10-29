// 后台回填：参数收敛、命令行拼装、进度解析
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackfillParams, backfillArgs, parseBackfillProgress } from '../src/backfill.js';

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
