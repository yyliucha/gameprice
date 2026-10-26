import test from 'node:test';
import assert from 'node:assert/strict';
import { jobsFromEnv, dueJobs, describeSchedule, forwardedArgs, recordJobResult, isCircuited, CIRCUIT, followUpArgs } from '../src/scheduler.js';

test('默认八个任务（含 gog / humble / discover / backup / alerts），各自间隔', () => {
  const jobs = jobsFromEnv({});
  assert.deepEqual(jobs.map((j) => j.name), ['steam', 'sonkwo', 'itad', 'gog', 'humble', 'discover', 'backup', 'alerts']);
  assert.equal(jobs[0].intervalMin, 60);
  assert.equal(jobs[2].intervalMin, 1440);
  assert.equal(jobs[3].intervalMin, 720);
  assert.equal(jobs[4].intervalMin, 720);
  assert.equal(jobs[5].intervalMin, 720);
  assert.equal(jobs[6].intervalMin, 1440, '备份每天一次');
  assert.equal(jobs[7].intervalMin, 360);
  assert.deepEqual(jobs[5].args, ['discover', 'sonkwo', '--ahead', '60', '--max-misses', '12']);
  assert.deepEqual(jobs[6].args, ['backup']);
});

test('没配任何提醒通道时 alerts 只做只读检查，不标记已通知', () => {
  assert.deepEqual(jobsFromEnv({}).find((j) => j.name === 'alerts').args, ['alerts']);
  assert.deepEqual(jobsFromEnv({ ALERT_WEBHOOK_URL: 'https://example.com/hook' }).find((j) => j.name === 'alerts').args, [
    'alerts',
    '--mark',
  ]);
  // 企业微信 / 邮件任一配好，也应该在检查后标记
  assert.deepEqual(jobsFromEnv({ WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/x' }).find((j) => j.name === 'alerts').args, ['alerts', '--mark']);
  assert.deepEqual(
    jobsFromEnv({ SMTP_HOST: 'smtp.example.com', ALERT_EMAIL_TO: 'a@x.com' }).find((j) => j.name === 'alerts').args,
    ['alerts', '--mark'],
  );
});

test('环境变量能改间隔与首轮延迟', () => {
  const jobs = jobsFromEnv({ STEAM_INTERVAL_MIN: '15', SONKWO_INITIAL_DELAY_SEC: '5' });
  assert.equal(jobs[0].intervalMin, 15);
  assert.equal(jobs[1].initialDelaySec, 5);
});

test('显式禁用或间隔为 0 的任务会被剔除', () => {
  const jobs = jobsFromEnv({
    ITAD_ENABLED: '0',
    STEAM_INTERVAL_MIN: '0',
    GOG_ENABLED: '0',
    HUMBLE_ENABLED: '0',
    DISCOVER_ENABLED: '0',
    BACKUP_ENABLED: '0',
  });
  assert.deepEqual(jobs.map((j) => j.name), ['sonkwo', 'alerts']);
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

test('熔断：连失败到阈值才打开，成功后立刻复位', () => {
  const t0 = 1_000_000;
  let state = { failures: 0, openUntil: null };

  state = recordJobResult(state, { code: 1, nowMs: t0 });
  assert.equal(state.failures, 1);
  assert.equal(isCircuited(state, t0), false, '一次失败不该熔断');

  state = recordJobResult(state, { code: 1, nowMs: t0 + 1000 });
  assert.equal(state.failures, 2);
  assert.equal(isCircuited(state, t0 + 1000), false);

  state = recordJobResult(state, { code: 1, nowMs: t0 + 2000 });
  assert.equal(state.failures, 3);
  assert.equal(state.opened, true);
  assert.equal(isCircuited(state, t0 + 3000), true, '达到阈值后应熔断');

  const success = recordJobResult(state, { code: 0, nowMs: t0 + 4000 });
  assert.equal(success.failures, 0);
  assert.equal(success.openUntil, null);
  assert.equal(isCircuited(success, t0 + 4000), false, '成功一次即复位');
});

test('熔断窗口到期后自动恢复', () => {
  const t0 = 1_000_000;
  const state = { failures: CIRCUIT.threshold, openUntil: t0 + CIRCUIT.cooldownMs };
  assert.equal(isCircuited(state, t0 + CIRCUIT.cooldownMs - 1), true);
  assert.equal(isCircuited(state, t0 + CIRCUIT.cooldownMs), false);
});

test('采集成功后自动重建曲线页：失败不触发、非采集任务不触发、可关闭', () => {
  assert.deepEqual(followUpArgs('sonkwo', 0, {}), ['chart']);
  assert.deepEqual(followUpArgs('gog', 0, {}), ['chart']);
  assert.deepEqual(followUpArgs('discover', 0, {}), ['chart']);

  assert.equal(followUpArgs('sonkwo', 1, {}), null, '任务失败不该重建');
  assert.equal(followUpArgs('alerts', 0, {}), null, '提醒任务不重建');
  assert.equal(followUpArgs('sonkwo', 0, { CHART_ON_SYNC: '0' }), null, 'CHART_ON_SYNC=0 关闭');
});
