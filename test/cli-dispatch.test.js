import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 这个测试专门防止"调度器调用了 CLI 里不存在的子命令"——
// 之前 sync steamall 的分发被误删，导致每小时任务都报"用法错误"，而且只有看日志才发现。
const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');

function schedulerSyncTargets() {
  const targets = new Set();
  const re = /args:\s*\[[^\]]*'sync',\s*'([a-z]+)'[^\]]*\]/g;
  let m;
  while ((m = re.exec(scheduler))) targets.add(m[1]);
  return [...targets];
}

test('调度器用到的 sync 子命令都有 CLI 分发', () => {
  const targets = schedulerSyncTargets();
  assert.ok(targets.length > 0, '应该能从 scheduler.js 解析出 sync 目标');
  for (const t of targets) {
    assert.ok(
      cli.includes(`target === '${t}'`),
      `cli.js 缺少 'sync ${t}' 的分发（scheduler.js 正在调用它）`,
    );
  }
});

test('sync steamall 的实现与分发同时存在', () => {
  const hasImpl = cli.includes('cmdSyncSteamAll');
  const hasDispatch = cli.includes("target === 'steamall'");
  assert.equal(hasImpl, hasDispatch, '实现与分发必须同时存在，否则任务会报用法错误');
});
