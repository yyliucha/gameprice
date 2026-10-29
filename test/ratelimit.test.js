// 频率限制三振规则（用假 q 验证，不连库）。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ratelimit from '../src/ratelimit.js';

function fakeQ() {
  const abuse = new Map();
  const blacklist = new Set();
  const whitelist = new Set();
  const stats = { inserts: 0 };
  const q = async (sql, params) => {
    if (/insert into ip_abuse/.test(sql)) {
      stats.inserts += 1;
      const ip = params[0];
      const next = (abuse.get(ip) ?? 0) + 1;
      abuse.set(ip, next);
      return { rows: [{ strikes: next }], rowCount: 1 };
    }
    if (/update ip_abuse set banned_until/.test(sql)) return { rows: [], rowCount: 1 };
    if (/insert into ip_blacklist/.test(sql)) {
      blacklist.add(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/delete from ip_abuse/.test(sql)) return { rows: [], rowCount: abuse.delete(params[0]) ? 1 : 0 };
    if (/delete from ip_blacklist/.test(sql)) return { rows: [], rowCount: blacklist.delete(params[0]) ? 1 : 0 };
    if (/select ip from ip_whitelist/.test(sql)) return { rows: [...whitelist].map((ip) => ({ ip })) };
    if (/select ip, banned_until/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  return { q, abuse, blacklist, whitelist, stats };
}

test('超频：第 1 次封 10 分钟、第 2 次 30 分钟、第 3 次封到当天结束（次日 0 点恢复），不写永久黑名单', async () => {
  ratelimit.resetState();
  ratelimit.configure({ enabled: true, max: 5, windowSec: 60, blockedEscalate: 5 });
  const { q, blacklist, stats } = fakeQ();
  const ip = '203.0.113.9';

  for (let i = 0; i < 5; i += 1) {
    const v = await ratelimit.hit(q, ip);
    assert.equal(v.limited, false, `第 ${i + 1} 次不应限流`);
  }
  const first = await ratelimit.hit(q, ip);
  assert.equal(first.limited, true);
  assert.equal(first.strikes, 1);
  assert.equal(first.permanent, false);
  assert.equal(first.needsReview, true, '第一次超限就要交管理员审核');
  const mins1 = Math.round((first.until - Date.now()) / 60000);
  assert.ok(mins1 >= 9 && mins1 <= 10, '第一次应封约 10 分钟，实际 ' + mins1);

  // 封禁期内继续请求 5 次 → 升级到第 2 档（30 分钟）
  let second = null;
  for (let i = 0; i < 5; i += 1) second = await ratelimit.hit(q, ip);
  assert.equal(second.strikes, 2);
  const mins2 = Math.round((second.until - Date.now()) / 60000);
  assert.ok(mins2 >= 29 && mins2 <= 30, '第二次应封约 30 分钟，实际 ' + mins2);

  // 再继续 5 次 → 第 3 档：封到当天结束（次日 0 点）
  let third = null;
  for (let i = 0; i < 5; i += 1) third = await ratelimit.hit(q, ip);
  assert.equal(third.strikes, 3);
  assert.equal(third.permanent, false, '永不自动永久');
  assert.equal(third.needsReview, true);
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  assert.ok(Math.abs(third.until - midnight.getTime()) <= 5000, '第三次应封到次日 0 点，实际 ' + new Date(third.until).toISOString());
  assert.match(third.reason, /明天 0 点/);
  assert.equal(blacklist.has(ip), false, '自动流程不能写永久黑名单');

  // 已经封到当天结束：当天最多就这 3 次，继续请求不再升级、不再累加
  const insertsAfterThird = stats.inserts;
  for (let i = 0; i < 5; i += 1) {
    const v = await ratelimit.hit(q, ip);
    assert.equal(v.limited, true);
    assert.equal(Boolean(v.escalated), false, '当天封禁后不再升级');
  }
  assert.equal(stats.inserts, insertsAfterThird, '每天封顶 3 次，之后不再累计');
});

test('nextMidnight：返回本地时区次日 0 点', () => {
  const now = new Date(2026, 9, 29, 23, 59, 30).getTime();
  const next = new Date(ratelimit.nextMidnight(now));
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 9);
  assert.equal(next.getDate(), 30);
  assert.equal(next.getHours(), 0);
});

test('白名单不计数、不限流', async () => {
  ratelimit.resetState();
  ratelimit.configure({ enabled: true, max: 2, windowSec: 60 });
  const { q } = fakeQ();
  ratelimit.addWhitelist('198.51.100.7');
  for (let i = 0; i < 10; i += 1) {
    const v = await ratelimit.hit(q, '198.51.100.7');
    assert.equal(v.limited, false);
  }
  assert.equal(ratelimit.isWhitelisted('198.51.100.7'), true);
  ratelimit.removeWhitelist('198.51.100.7');
  assert.equal(ratelimit.isWhitelisted('198.51.100.7'), false);
});

test('手动解封清掉临时封禁（不再产生永久黑名单）', async () => {
  ratelimit.resetState();
  ratelimit.configure({ enabled: true, max: 1, windowSec: 60, blockedEscalate: 2 });
  const { q, blacklist } = fakeQ();
  const ip = '203.0.113.55';
  for (let round = 0; round < 3; round += 1) {
    await ratelimit.hit(q, ip);
    await ratelimit.hit(q, ip); // 第 2 次即超限
  }
  assert.equal(blacklist.has(ip), false, '自动流程不写永久黑名单');
  assert.ok(ratelimit.bannedUntil(ip), '应处于临时封禁中');
  await ratelimit.unban(q, ip);
  assert.equal(ratelimit.bannedUntil(ip), null);
});

test('禁用后完全不限流', async () => {
  ratelimit.resetState();
  ratelimit.configure({ enabled: false, max: 1, windowSec: 60 });
  const { q } = fakeQ();
  for (let i = 0; i < 20; i += 1) {
    const v = await ratelimit.hit(q, '203.0.113.1');
    assert.equal(v.limited, false);
  }
});
