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
const blockedHits = new Map(); // ip -> 封禁期内被拒的请求数（用于升级封禁）
const banUntil = new Map(); // ip -> 毫秒时间戳
const pathBanned = new Set(); // 因「非法路径」被封的 IP：不参与三振升级
const dayBanned = new Set(); // 已吃到「当天封禁」的 IP：当天不再重复升级/记录
const whitelist = new Set();

let config = { ...DEFAULTS };

export function configure(next = {}) {
  const max = Number(next.max);
  const assetMax = Number(next.assetMax);
  const windowSec = Number(next.windowSec);
  const escalate = Number(next.blockedEscalate);
  const dayStrikes = Number(next.dayBanStrikes);
  config = {
    enabled: next.enabled === undefined ? config.enabled : Boolean(next.enabled),
    max: Number.isFinite(max) && max > 0 ? max : config.max,
    assetMax: Number.isFinite(assetMax) && assetMax > 0 ? assetMax : config.assetMax,
    windowSec: Number.isFinite(windowSec) && windowSec > 0 ? windowSec : config.windowSec,
    banMinutes: Array.isArray(next.banMinutes) && next.banMinutes.length >= 2 ? next.banMinutes : config.banMinutes,
    dayBanStrikes: Number.isFinite(dayStrikes) && dayStrikes >= 1 ? dayStrikes : config.dayBanStrikes,
    blockedEscalate: Number.isFinite(escalate) && escalate > 0 ? escalate : config.blockedEscalate,
  };
  return { ...config };
}

export function currentConfig() {
  return { ...config };
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
    const b = await q('select ip, banned_until, ban_source from ip_abuse where banned_until is not null and banned_until > now()');
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
  return Boolean(ip) && whitelist.has(String(ip));
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
    dayBanned.add(key);
    reason = `请求过于频繁（${kind}，第 ${strikes} 次），已封禁到今天结束，明天 0 点自动恢复`;
  } else {
    const minutes = config.banMinutes[Math.min(strikes - 1, config.banMinutes.length - 1)];
    until = Date.now() + minutes * 60_000;
    dayBanned.delete(key);
    reason = `请求过于频繁（${kind}），临时封禁 ${minutes} 分钟（第 ${strikes} 次）`;
  }
  banUntil.set(key, until);
  pathBanned.delete(key);
  blockedHits.set(key, 0);
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
  banUntil.set(key, Number(until));
  blockedHits.set(key, 0);
  if (source === 'path') pathBanned.add(key);
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
  const span = config.windowSec * 1000;
  const key = String(ip);
  const isAsset = bucket === 'asset';
  const map = isAsset ? assetHits : windowHits;
  const max = isAsset ? config.assetMax : config.max;

  const list = (map.get(key) ?? []).filter((t) => now - t < span);
  list.push(now);
  map.set(key, list);

  // 窗口清理：避免 Map 无限增长（超过 1 万个 IP 时清掉空窗口）
  if (map.size > 10000) {
    for (const [k, v] of map) if (!v.length || now - v[v.length - 1] > span) map.delete(k);
  }

  // 封禁中：累计违禁请求，够数就升级（非法路径封禁除外）
  const activeBan = banUntil.get(key);
  if (activeBan && now < activeBan) {
    if (pathBanned.has(key)) {
      return { limited: true, until: activeBan, reason: '访问了禁止的路径（封禁中）', banned: true };
    }
    // 已经吃到「当天封禁」：当天封顶 3 次，不再升级、不再写新的待审核记录
    if (dayBanned.has(key)) {
      return { limited: true, until: activeBan, reason: '请求过于频繁（今天已被封禁），明天 0 点自动恢复', banned: true, dayBanned: true };
    }
    const blocked = (blockedHits.get(key) ?? 0) + 1;
    blockedHits.set(key, blocked);
    if (blocked >= config.blockedEscalate) {
      blockedHits.set(key, 0);
      const strikes = await addStrike(q, key);
      const ban = await applyBan(q, key, strikes, { bucket });
      return { limited: true, until: ban.until, reason: ban.reason, strikes, permanent: false, escalated: true, needsReview: Boolean(ban.needsReview) };
    }
    return { limited: true, until: activeBan, reason: '请求过于频繁（封禁中）', banned: true };
  }
  if (activeBan) {
    // 封禁已过期：清掉残留状态
    banUntil.delete(key);
    pathBanned.delete(key);
    dayBanned.delete(key);
  }

  if (list.length <= max) return { limited: false };

  map.delete(key);
  const strikes = await addStrike(q, key);
  const ban = await applyBan(q, key, strikes, { bucket });
  return { limited: true, until: ban.until, reason: ban.reason, strikes, permanent: false, needsReview: Boolean(ban.needsReview) };
}

/** 管理员手动解封。返回是否清掉了记录。 */
export async function unban(q, ip) {
  const key = String(ip);
  windowHits.delete(key);
  assetHits.delete(key);
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
  blockedHits.clear();
  banUntil.clear();
  pathBanned.clear();
  dayBanned.clear();
  whitelist.clear();
  config = { ...DEFAULTS };
}
