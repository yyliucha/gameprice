// IP 频率限制 + 白名单 + 三振封禁。
//
// 规则（可配置）：
//   页面/API：60 秒内同一 IP 超过 60 次 → 判定异常
//   静态/图片：单独一个桶（默认 300 次/60 秒），避免正常翻页的封面图把用户顶到限流
// 第 1 次：封 10 分钟；第 2 次：30 分钟；第 3 次：封到当天结束（次日 0 点自动恢复）
//   三振按「天」计：跨天后重新从 10 分钟起算；每天最多 3 次，封到当天结束后不再累加
//   **永不自动写永久黑名单**；每次自动封禁同时记一条「异常请求审核」，管理员可以人工解封/永久封
//   白名单 IP 不计数、不受黑名单限制（管理员自己的出口 IP 放这里）
//
// 「非法路径」只由 guard.js 记录待审核，不在这里封。
//
// 为了不拖慢每个请求：窗口计数全在内存里；只有"判定超限"时才写库。
import { matchesIpEntry } from './visitors.js';

const MAX_TRACKED_IPS = 20_000;
const MAX_TRACKED_HITS_PER_BUCKET = 1_000_000;

export const DEFAULTS = {
  enabled: true,
  max: 60, // 页面/API 窗口内允许的请求数
  assetMax: 300, // 静态资源/图片窗口内允许的请求数
  windowSec: 60, // 窗口长度（秒）
  banMinutes: [10, 30], // 第 1、2 次封禁时长（分钟）
  dayBanStrikes: 3, // 第几次异常开始封到当天结束
  blockedEscalate: 100, // 封禁期内继续请求多少次 → 升一档
};

const windowHits = new Map(); // ip -> number[]（页面/API）
const assetHits = new Map(); // ip -> number[]（静态/图片）
const trackedHitCounts = new Map([[windowHits, 0], [assetHits, 0]]);
const blockedHits = new Map(); // ip -> 封禁期内被拒的请求数（用于升级封禁）
const banUntil = new Map(); // ip -> 毫秒时间戳
const pathBanned = new Set(); // 因「非法路径」被封的 IP：不参与三振升级
const dayBanned = new Set(); // 已吃到「当天封禁」的 IP：当天不再重复升级/记录
const whitelist = new Set();

let config = { ...DEFAULTS };

export function configure(next = {}) {
  const boundedInt = (value, fallback, min, ceiling) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), ceiling) : fallback;
  };
  config = {
    enabled: next.enabled === undefined ? config.enabled : Boolean(next.enabled),
    max: boundedInt(next.max, config.max, 1, 10_000),
    assetMax: boundedInt(next.assetMax, config.assetMax, 1, 50_000),
    windowSec: boundedInt(next.windowSec, config.windowSec, 1, 3600),
    banMinutes: Array.isArray(next.banMinutes) && next.banMinutes.length >= 2
      ? next.banMinutes.slice(0, 10).map((value) => boundedInt(value, 10, 1, 1440))
      : config.banMinutes,
    dayBanStrikes: boundedInt(next.dayBanStrikes, config.dayBanStrikes, 1, 100),
    blockedEscalate: boundedInt(next.blockedEscalate, config.blockedEscalate, 1, 100_000),
  };
  return { ...config };
}

export function currentConfig() {
  return { ...config };
}

function setBounded(map, key, value) {
  map.delete(key);
  if (map.size >= MAX_TRACKED_IPS) map.delete(map.keys().next().value);
  map.set(key, value);
}

function addBounded(set, key) {
  if (set.has(key)) return;
  if (set.size >= MAX_TRACKED_IPS) set.delete(set.values().next().value);
  set.add(key);
}

function deleteWindowEntry(map, key) {
  const previous = map.get(key);
  if (previous) trackedHitCounts.set(map, Math.max(0, trackedHitCounts.get(map) - previous.length));
  map.delete(key);
}

function setWindowEntry(map, key, value) {
  const previous = map.get(key);
  let count = trackedHitCounts.get(map) - (previous?.length ?? 0);
  if (previous) map.delete(key);
  while (map.size >= MAX_TRACKED_IPS || count + value.length > MAX_TRACKED_HITS_PER_BUCKET) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    count -= map.get(oldestKey).length;
    map.delete(oldestKey);
  }
  map.set(key, value);
  trackedHitCounts.set(map, count + value.length);
}

/** 本地时区「今天结束」的时间戳（次日 00:00）。 */
export function nextMidnight(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/** 从数据库加载白名单与未到期的临时封禁（进程启动时调用）。 */
export async function loadState(q) {
  try {
    const w = await q('select ip from ip_whitelist');
    whitelist.clear();
    for (const row of w.rows) whitelist.add(String(row.ip));
  } catch {
    /* 表未建时忽略 */
  }
  try {
    const b = await q(
      'select ip, banned_until, ban_source from ip_abuse where banned_until is not null and banned_until > now() order by banned_until desc limit $1',
      [MAX_TRACKED_IPS],
    );
    banUntil.clear();
    pathBanned.clear();
    dayBanned.clear();
    for (const row of b.rows) {
      banUntil.set(String(row.ip), new Date(row.banned_until).getTime());
      if (row.ban_source === 'path') pathBanned.add(String(row.ip));
      if (row.ban_source === 'rate-day') dayBanned.add(String(row.ip));
    }
  } catch {
    /* 忽略 */
  }
  return { whitelist: whitelist.size, bans: banUntil.size };
}

export function isWhitelisted(ip) {
  if (!ip) return false;
  const value = String(ip);
  for (const entry of whitelist) if (matchesIpEntry(value, entry)) return true;
  return false;
}

export function addWhitelist(ip) {
  if (ip) whitelist.add(String(ip));
}

export function removeWhitelist(ip) {
  if (ip) whitelist.delete(String(ip));
}

/** 当前是否处于临时封禁中（内存态，进程启动时由 loadState 回填）。 */
export function bannedUntil(ip) {
  const key = ip ? String(ip) : '';
  const until = key ? banUntil.get(key) : null;
  if (!until) return null;
  if (Date.now() >= until) {
    banUntil.delete(key);
    pathBanned.delete(key);
    dayBanned.delete(key);
    return null;
  }
  return until;
}

async function addStrike(q, key) {
  try {
    // 三振按「天」算：strike_day 不是今天就归零重来（昨天封到 0 点，今天重新从 10 分钟起算）
    // 每天最多 3 次：strikes 封顶在 dayBanStrikes，避免继续累加
    const r = await q(
      `insert into ip_abuse (ip, strikes, strike_day) values ($1, 1, current_date)
       on conflict (ip) do update set
         strikes = case when ip_abuse.strike_day = current_date
                        then least(ip_abuse.strikes + 1, $2)
                        else 1 end,
         strike_day = current_date,
         updated_at = now()
       returning strikes`,
      [key, config.dayBanStrikes],
    );
    return Number(r.rows[0]?.strikes ?? 1);
  } catch {
    return 1;
  }
}

async function applyBan(q, key, strikes, { bucket }) {
  const kind = bucket === 'asset' ? '静态资源' : '页面/API';
  const isDayBan = strikes >= config.dayBanStrikes;
  let until;
  let reason;
  if (isDayBan) {
    // 第 3 次：封到当天结束，次日 0 点自动恢复（不写永久黑名单）
    until = nextMidnight();
    addBounded(dayBanned, key);
    reason = `请求过于频繁（${kind}，第 ${strikes} 次），已封禁到今天结束，明天 0 点自动恢复`;
  } else {
    const minutes = config.banMinutes[Math.min(strikes - 1, config.banMinutes.length - 1)];
    until = Date.now() + minutes * 60_000;
    dayBanned.delete(key);
    reason = `请求过于频繁（${kind}），临时封禁 ${minutes} 分钟（第 ${strikes} 次）`;
  }
  setBounded(banUntil, key, until);
  pathBanned.delete(key);
  setBounded(blockedHits, key, 0);
  try {
    await q(
      `update ip_abuse set banned_until = $2::timestamptz, ban_source = $3, updated_at = now() where ip = $1`,
      [key, new Date(until).toISOString(), isDayBan ? 'rate-day' : 'rate'],
    );
  } catch {
    /* 忽略 */
  }
  return { permanent: false, until, reason, needsReview: true, strikes };
}

/**
 * 外部（guard.js）写入的封禁：只动内存态，数据库由调用方写。
 * source=path 时标记为"路径封禁"，封禁期内不再累计三振升级。
 */
export function applyExternalBan(ip, until, { source = 'path' } = {}) {
  const key = String(ip);
  setBounded(banUntil, key, Number(until));
  setBounded(blockedHits, key, 0);
  if (source === 'path') addBounded(pathBanned, key);
  else pathBanned.delete(key);
}

/**
 * 记一次请求。返回 { limited, until, reason, strikes, permanent, escalated }。
 *
 * bucket: 'page'（默认，页面/API）| 'asset'（静态资源/图片，单独阈值）
 * 关键：封禁期内继续请求不再直接丢弃，而是累计「违禁请求」，达到
 * blockedEscalate 次就**升一档封禁**（10 分钟 → 30 分钟 → 封到当天结束，次日 0 点恢复）。
 * 已经封到当天结束后不再升级（每天封顶 3 次）。
 * 但「非法路径」封禁不参与升级：扫描器持续打一会儿就被升级成永久，会误伤共享出口。
 */
export async function hit(q, ip, { bucket = 'page' } = {}) {
  if (!config.enabled || !ip) return { limited: false };
  if (isWhitelisted(ip)) return { limited: false };

  const now = Date.now();
  const key = String(ip);

  // 封禁期内只记录有界升级计数，避免高频请求继续累积时间戳数组。
  const activeBan = banUntil.get(key);
  if (activeBan && now < activeBan) {
    if (pathBanned.has(key)) {
      return { limited: true, until: activeBan, reason: '访问了禁止的路径（封禁中）', banned: true };
    }
    if (dayBanned.has(key)) {
      return { limited: true, until: activeBan, reason: '请求过于频繁（今天已被封禁），明天 0 点自动恢复', banned: true, dayBanned: true };
    }
    const blocked = (blockedHits.get(key) ?? 0) + 1;
    setBounded(blockedHits, key, blocked);
    if (blocked >= config.blockedEscalate) {
      setBounded(blockedHits, key, 0);
      const strikes = await addStrike(q, key);
      const ban = await applyBan(q, key, strikes, { bucket });
      return { limited: true, until: ban.until, reason: ban.reason, strikes, permanent: false, escalated: true, needsReview: Boolean(ban.needsReview) };
    }
    return { limited: true, until: activeBan, reason: '请求过于频繁（封禁中）', banned: true };
  }
  if (activeBan) {
    banUntil.delete(key);
    pathBanned.delete(key);
    dayBanned.delete(key);
    blockedHits.delete(key);
  }

  const span = config.windowSec * 1000;
  const isAsset = bucket === 'asset';
  const map = isAsset ? assetHits : windowHits;
  const max = isAsset ? config.assetMax : config.max;

  const list = (map.get(key) ?? []).filter((t) => now - t < span);
  list.push(now);
  // 只保留触发阈值所需的最近 max+1 个时间戳，并限制每个桶的总记录量。
  if (list.length > max + 1) list.splice(0, list.length - max - 1);
  setWindowEntry(map, key, list);

  if (list.length <= max) return { limited: false };

  deleteWindowEntry(windowHits, key);
  deleteWindowEntry(assetHits, key);
  const strikes = await addStrike(q, key);
  const ban = await applyBan(q, key, strikes, { bucket });
  return { limited: true, until: ban.until, reason: ban.reason, strikes, permanent: false, needsReview: Boolean(ban.needsReview) };
}

/** 管理员手动解封。返回是否清掉了记录。 */
export async function unban(q, ip) {
  const key = String(ip);
  deleteWindowEntry(windowHits, key);
  deleteWindowEntry(assetHits, key);
  blockedHits.delete(key);
  banUntil.delete(key);
  pathBanned.delete(key);
  dayBanned.delete(key);
  let removed = 0;
  try {
    const r = await q('delete from ip_abuse where ip = $1', [key]);
    removed += r.rowCount ?? 0;
    const b = await q('delete from ip_blacklist where ip = $1', [key]);
    removed += b.rowCount ?? 0;
  } catch {
    /* 忽略 */
  }
  return removed > 0;
}

/** 测试用：清空内存状态。 */
export function resetState() {
  windowHits.clear();
  assetHits.clear();
  trackedHitCounts.set(windowHits, 0);
  trackedHitCounts.set(assetHits, 0);
  blockedHits.clear();
  banUntil.clear();
  pathBanned.clear();
  dayBanned.clear();
  whitelist.clear();
  config = { ...DEFAULTS };
}
