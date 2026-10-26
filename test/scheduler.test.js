import test from 'node:test';
import assert from 'node:assert/strict';
import { jobsFromEnv, dueJobs, describeSchedule, forwardedArgs } from '../src/scheduler.js';

test('默认三个任务，间隔 60/60/1440 分钟', () => {
  const jobs = jobsFromEnv({});
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.name), ['steam', 'sonkwo', 'itad']);
  assert.equal(jobs[0].intervalMin, 60);
  assert.equal(jobs[2].intervalMin, 1440);
});

test('环境变量能改间隔与首轮延迟', () => {
  const jobs = jobsFromEnv({ STEAM_INTERVAL_MIN: '15', SONKWO_INITIAL_DELAY_SEC: '5' });
  assert.equal(jobs[0].intervalMin, 15);
  assert.equal(jobs[1].initialDelaySec, 5);
});

test('显式禁用或间隔为 0 的任务会被剔除', () => {
  const jobs = jobsFromEnv({ ITAD_ENABLED: '0', STEAM_INTERVAL_MIN: '0' });
  assert.deepEqual(jobs.map((j) => j.name), ['sonkwo']);
});

test('从未跑过的任务在 initialDelay 之后才算到点', () => {
  const jobs = jobsFromEnv({ STEAM_INITIAL_DELAY_SEC: '30', SONKWO_INITIAL_DELAY_SEC: '180' });
  const startedMs = 1_000_000;
  const lastRunMs = new Map();

  assert.equal(dueJobs(jobs, { nowMs: startedMs, startedMs, lastRunMs }).length, 0);
  assert.equal(dueJobs(jobs, { nowMs: startedMs + 29_000, startedMs, lastRunMs }).length, 0);
  assert.deepEqual(
    dueJobs(jobs, { nowMs: startedMs + 31_000, startedMs, lastRunMs }).map((j) => j.name),
    ['steam'],
  );
  assert.deepEqual(
    dueJobs(jobs, { nowMs: startedMs + 181_000, startedMs, lastRunMs }).map((j) => j.name),
    ['steam', 'sonkwo'],
  );
});

test('跑过的任务按间隔再次到点', () => {
  const jobs = jobsFromEnv({});
  const startedMs = 0;
  const steam = jobs[0];
  const lastRunMs = new Map([['steam', 1_000_000]]);

  assert.equal(dueJobs([steam], { nowMs: 1_000_000 + 59 * 60_000, startedMs, lastRunMs }).length, 0);
  assert.equal(dueJobs([steam], { nowMs: 1_000_000 + 60 * 60_000, startedMs, lastRunMs }).length, 1);
});

test('唯一一个跑过的任务不影响其它任务的首次触发', () => {
  const jobs = jobsFromEnv({ SONKWO_INITIAL_DELAY_SEC: '60' });
  const startedMs = 0;
  const lastRunMs = new Map([['steam', 500]]);
  const due = dueJobs(jobs, { nowMs: 60_000, startedMs, lastRunMs });
  assert.deepEqual(due.map((j) => j.name), ['sonkwo']);
});

test('describeSchedule 能生成可读描述', () => {
  const text = describeSchedule(jobsFromEnv({}));
  assert.match(text, /steam 每 60 分钟/);
  assert.match(text, /itad 每 1440 分钟/);
});

test('通用参数会透传给子任务（--db 不能丢）', () => {
  assert.deepEqual(
    forwardedArgs(['node', 'scheduler.js', '--db', 'pglite:./data/pgdata', '--level', 'debug']),
    ['--db', 'pglite:./data/pgdata', '--level', 'debug'],
  );
  assert.deepEqual(forwardedArgs(['node', 'scheduler.js', '--db']), [], '缺值时不透传');
  assert.deepEqual(forwardedArgs(['node', 'scheduler.js', '--db', '--level', 'info']), ['--level', 'info']);
  assert.deepEqual(forwardedArgs(['node', 'scheduler.js']), []);
});
