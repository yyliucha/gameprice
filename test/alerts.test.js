import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlerts, renderDigest, toPayload, postWebhook, REASON } from '../src/alerts.js';

const row = (over = {}) => ({
  watch_id: 1,
  game_id: 10,
  steam_appid: 1091500,
  name: '赛博朋克 2077',
  target_cents: null,
  hist_low: 9900,
  current_cents: 14900,
  last_notified_cents: null,
  last_notified_at: null,
  note: null,
  ...over,
});

test('到目标价才提醒', () => {
  assert.equal(evaluateAlerts([row({ target_cents: 10000, current_cents: 14900 })]).length, 0);
  const hits = evaluateAlerts([row({ target_cents: 10000, current_cents: 9900 })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, REASON.TARGET);
  assert.equal(hits[0].currentCents, 9900);
});

test('没设目标价时，跌到史低才提醒', () => {
  assert.equal(evaluateAlerts([row({ current_cents: 14900, hist_low: 9900 })]).length, 0);
  const hits = evaluateAlerts([row({ current_cents: 9900, hist_low: 9900 })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, REASON.HIST_LOW);
  assert.equal(hits[0].atHistLow, true);
});

test('没有在售价就不提醒', () => {
  assert.equal(evaluateAlerts([row({ current_cents: null, target_cents: 99999 })]).length, 0);
});

test('同一价位不重复打扰，继续下跌才再提醒', () => {
  const notified = row({ target_cents: 10000, current_cents: 9900, last_notified_cents: 9900 });
  assert.equal(evaluateAlerts([notified]).length, 0, '同价不重复');

  const cheaper = row({ target_cents: 10000, current_cents: 9000, last_notified_cents: 9900 });
  assert.equal(evaluateAlerts([cheaper]).length, 1, '更便宜要再提醒');

  const pricier = row({ target_cents: 10000, current_cents: 10100, last_notified_cents: 9900 });
  assert.equal(evaluateAlerts([pricier]).length, 0, '涨回目标价之上不提醒');
});

test('多个关注项一起判定，互不干扰', () => {
  const hits = evaluateAlerts([
    row({ watch_id: 1, name: 'A', target_cents: 10000, current_cents: 9000 }),
    row({ watch_id: 2, name: 'B', target_cents: 10000, current_cents: 12000 }),
    row({ watch_id: 3, name: 'C', current_cents: 500, hist_low: 500 }),
  ]);
  assert.deepEqual(hits.map((h) => h.name), ['A', 'C']);
});

test('简报包含名称、价格、原因与链接', () => {
  const text = renderDigest(evaluateAlerts([row({ target_cents: 10000, current_cents: 9900 })]));
  assert.match(text, /价格提醒/);
  assert.match(text, /赛博朋克 2077/);
  assert.match(text, /¥99\.00/);
  assert.match(text, /已达目标价/);
  assert.match(text, /store\.steampowered\.com\/app\/1091500/);
  assert.equal(renderDigest([]), '没有需要提醒的价格。');
});

test('投递载荷结构稳定（给 webhook 用）', () => {
  const hits = evaluateAlerts([row({ target_cents: 10000, current_cents: 9900, note: '想玩' })]);
  const payload = toPayload(hits);
  assert.equal(payload.type, 'steamdeals.alerts');
  assert.equal(payload.count, 1);
  assert.equal(payload.alerts[0].name, '赛博朋克 2077');
  assert.equal(payload.alerts[0].current, 9900);
  assert.equal(payload.alerts[0].reason, REASON.TARGET);
  assert.equal(payload.alerts[0].note, '想玩');
  assert.ok(payload.text.includes('价格提醒'));
});

test('webhook 成功与失败都不抛异常', async () => {
  const okFetch = async () => ({ ok: true, status: 204, text: async () => '' });
  assert.deepEqual(await postWebhook('https://example.com/hook', { a: 1 }, { fetchImpl: okFetch }), {
    ok: true,
    status: 204,
    body: '',
  });

  const failFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const failed = await postWebhook('https://example.com/hook', { a: 1 }, { fetchImpl: failFetch });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ECONNREFUSED/);
});
