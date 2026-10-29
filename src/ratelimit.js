// IP 频率限制 + 白名单 + 三振封禁。
//
// 规则（可配置）：
//   60 秒内同一 IP 超过 60 次「页面/API」请求 → 判定异常
//   第 1 次：封 10 分钟；第 2 次：封 30 分钟；第 3 次：写进永久黑名单（命中即 403）
//   白名单 IP 不计数、不受黑名单限制（管理员自己的出口 IP 放这里）
//
// 为了不拖慢每个请求：窗口计数全在内存里；只有"判定超限"时才写库（三振计数/封禁到期/永久拉黑）。
export const DEFAULTS = {
  enabled: true,
  max: 60, // 窗口内允许的请求数
  windowSec: 60, // 窗口长度（秒）
  banMinutes: [10, 30], // 第 1、2 次封禁时长；第 3 次永久
  blockedEscalate: 100, // 封禁期内继续请求多少次 → 升级一档封禁
};

const windowHits = new Map(); // ip -> number[]（毫秒时间戳）
const blockedHits = new Map(); // ip -> 封禁期内被拒的请求数（用于升级封禁）
const banUntil = new Map(); // ip -> 毫秒时间戳
const whitelist = new Set();

let config = { ...DEFAULTS };

export function configure(next = {}) {
  const max = Number(next.max);
  const windowSec = Number(next.windowSec);
  const escalate = Number(next.blockedEscalate);
  config = {
    enabled: next.enabled === undefined ? config.enabled : Boolean(next.enabled),
    max: Number.isFinite(max) && max > 0 ? max : config.max,
    windowSec: Number.isFinite(windowSec) && windowSec > 0 ? windowSec : config.windowSec,
    banMinutes: Array.isArray(next.banMinutes) && next.banMinutes.length >= 2 ? next.banMinutes : config.banMinutes,
    blockedEscalate: Number.isFinite(escalate) && escalate > 0 ? escalate : config.blockedEscalate,
  };
  return { ...config };
}

export function currentConfig() {
  return { ...config };
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
    const b = await q('select ip, banned_until from ip_abuse where banned_until is not null and banned_until > now()');
    banUntil.clear();
    for (const row of b.rows) banUntil.set(String(row.ip), new Date(row.banned_until).getTime());
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
  const until = ip ? banUntil.get(String(ip)) : null;
  if (!until) return null;
  if (Date.now() >= until) {
    banUntil.delete(String(ip));
    return null;
  }
  return until;
}

async function addStrike(q, key) {
  try {
    const r = await q(
      `insert into ip_abuse (ip, strikes) values ($1, 1)
       on conflict (ip) do update set strikes = ip_abuse.strikes + 1, updated_at = now()
       returning strikes`,
      [key],
    );
    return Number(r.rows[0]?.strikes ?? 1);
  } catch {
    return 1;
  }
}

async function applyBan(q, key, strikes, { max, windowSec }) {
  if (strikes >= 3) {
    try {
      await q(
        `insert into ip_blacklist (ip, note, created_at) values ($1, $2, now())
         on conflict (ip) do nothing`,
        [key, `自动拉黑：${strikes} 次超频（${max} 次/${windowSec} 秒）`],
      );
    } catch {
      /* 忽略 */
    }
    banUntil.set(key, Number.MAX_SAFE_INTEGER);
    return { permanent: true, until: null, reason: '永久拉黑（多次超频）' };
  }
  const minutes = config.banMinutes[Math.min(strikes - 1, config.banMinutes.length - 1)];
  const until = Date.now() + minutes * 60_000;
  banUntil.set(key, until);
  blockedHits.set(key, 0);
  try {
    await q('update ip_abuse set banned_until = to_timestamp($2 / 1000.0), updated_at = now() where ip = $1', [key, until]);
  } catch {
    /* 忽略 */
  }
  return { permanent: false, until, reason: `请求过于频繁，临时封禁 ${minutes} 分钟` };
}

/**
 * 记一次请求。返回 { limited, until, reason, strikes, permanent, escalated }。
 *
 * 关键：封禁期内继续请求不再直接丢弃，而是累计「违禁请求」，达到
 * blockedEscalate 次就**升级一档封禁**（10 分钟 → 30 分钟 → 永久黑名单）。
 * 之前这里直接 429 返回、不计数，导致「634 次请求只记 1 次超频」。
 */
export async function hit(q, ip) {
  if (!config.enabled || !ip) return { limited: false };
  if (isWhitelisted(ip)) return { limited: false };

  const now = Date.now();
  const span = config.windowSec * 1000;
  const key = String(ip);
  const list = (windowHits.get(key) ?? []).filter((t) => now - t < span);
  list.push(now);
  windowHits.set(key, list);

  // 窗口清理：避免 Map 无限增长（超过 1 万个 IP 时清掉空窗口）
  if (windowHits.size > 10000) {
    for (const [k, v] of windowHits) if (!v.length || now - v[v.length - 1] > span) windowHits.delete(k);
  }

  // 封禁中：累计违禁请求，够数就升级
  const activeBan = banUntil.get(key);
  if (activeBan && now < activeBan) {
    const blocked = (blockedHits.get(key) ?? 0) + 1;
    blockedHits.set(key, blocked);
    if (blocked >= config.blockedEscalate) {
      blockedHits.set(key, 0);
      const strikes = await addStrike(q, key);
      const ban = await applyBan(q, key, strikes, { max: config.max, windowSec: config.windowSec });
      return { limited: true, until: ban.until, reason: ban.reason, strikes, permanent: ban.permanent, escalated: true };
    }
    return { limited: true, until: activeBan, reason: '请求过于频繁（封禁中）', banned: true };
  }

  if (list.length <= config.max) return { limited: false };

  windowHits.delete(key);
  const strikes = await addStrike(q, key);
  const ban = await applyBan(q, key, strikes, { max: config.max, windowSec: config.windowSec });
  return { limited: true, until: ban.until, reason: ban.reason, strikes, permanent: ban.permanent };
}

/** 管理员手动解封。返回是否清掉了记录。 */
export async function unban(q, ip) {
  const key = String(ip);
  windowHits.delete(key);
  banUntil.delete(key);
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
  blockedHits.clear();
  banUntil.clear();
  whitelist.clear();
  config = { ...DEFAULTS };
}
