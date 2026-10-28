// 访问者 IP、归属地解析与 IP 黑名单（server 层拦截用）。
//
// 设计取舍：
//   · 归属地解析是"尽力而为"：请求不等待它，先落库（region=null），
//     后台解析成功后回填该行；解析失败就留空，控制台显示"未知"。
//   · 内网/保留地址一律不查（省请求也查不到），本地开发不会拖慢。
//   · 解析结果带内存缓存（24h），同一 IP 只查一次。
//   · 黑名单常驻内存（启动加载 + 60s 刷新 + 管理端增删即时刷新），
//     命中判定不查库，每请求零成本。

import * as db from './store/pg.js';
import { fetchJson } from './http.js';

// ---------------------------------------------------------------- IP 提取与校验

/** 判断是否是「可信的反代来源」：本机/内网地址。 */
export function isPrivateAddress(ip) {
  const value = String(ip ?? '');
  if (!value) return false;
  if (value === '::1' || value.startsWith('127.')) return true;
  if (value.startsWith('10.') || value.startsWith('192.168.')) return true;
  const m = /^172\.(\d{1,3})\./.exec(value);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(value)) return true; // fc00::/7 私有段
  return false;
}

/**
 * 生效 IP：只有「直连来源是内网/本机」（即 nginx/caddy 反代）时才采信 X-Forwarded-For，
 * 否则用 socket 地址——避免公网直连时伪造 XFF 绕过限流/黑名单。
 */
export function clientIp(req, { trustProxy = 'auto' } = {}) {
  const raw = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  const trust =
    trustProxy === true ||
    (trustProxy === 'auto' && isPrivateAddress(raw)) ||
    process.env.TRUST_PROXY === '1';
  if (trust) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (/^[\d.a-fA-F:]+$/.test(xff)) return xff;
    const real = String(req.headers['x-real-ip'] ?? '').trim();
    if (/^[\d.a-fA-F:]+$/.test(real)) return real;
  }
  return raw;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

export function isIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every((p) => Number(p) <= 255);
}

export function isIpLike(ip) {
  const s = String(ip ?? '').trim();
  if (isIpv4(s)) return true;
  return IPV6_RE.test(s) && s.includes(':');
}

/** 归一化黑名单输入：单个 IP 或 IPv4 CIDR，非法返回 null。 */
export function normalizeBanInput(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (isIpv4(s)) return s;
  if (s.includes('/') && !s.includes(':')) {
    const [net, bitsStr] = s.split('/');
    const bits = Number(bitsStr);
    if (!isIpv4(net) || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    return `${net}/${bits}`;
  }
  if (IPV6_RE.test(s) && s.includes(':')) return s;
  return null;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((((parts[0] << 8) + parts[1] << 8) + parts[2] << 8) + parts[3]) >>> 0;
}

/** IPv4 CIDR 匹配；IPv6 只支持精确匹配。 */
function matchEntry(ip, entry) {
  if (entry === ip) return true;
  if (!entry.includes('/') || !isIpv4(ip)) return false;
  const [net, bitsStr] = entry.split('/');
  const bits = Number(bitsStr);
  if (!isIpv4(net) || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
}

// ---------------------------------------------------------------- 黑名单（内存态）

let blockedEntries = [];

/** 命中返回命中的条目（IP 或 CIDR），否则 null。 */
export function blockedBy(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return null;
  return blockedEntries.find((entry) => matchEntry(s, entry)) ?? null;
}

/** 从库加载黑名单（替换内存态，启动与定时刷新都走这里）。 */
export async function refreshBlocklist(q) {
  const rows = await db.listBlockedIps(q);
  blockedEntries = rows.map((r) => String(r.ip));
  return blockedEntries;
}

// ---------------------------------------------------------------- 归属地解析

const REGION_TTL_MS = 24 * 3600 * 1000;
const MAX_CACHE = 5000;
const regionCache = new Map(); // ip -> { region, at }
const pending = new Set(); // 解析中，防同一 IP 并发重复查询

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.') || ip.startsWith('::ffff:127.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
}

/** 缓存里已有的归属地；没有返回 null。 */
export function cachedRegion(ip) {
  const hit = regionCache.get(ip);
  if (!hit) return null;
  if (Date.now() - hit.at > REGION_TTL_MS) {
    regionCache.delete(ip);
    return null;
  }
  return hit.region;
}

// 供应商依次尝试：全部 UTF-8 JSON、无 key、单请求 4 秒超时。
const PROVIDERS = [
  {
    name: 'ip-api',
    fetch: async (ip) => {
      const r = await fetchJson(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,country,regionName,city,isp`, { timeoutMs: 4000, retries: 0, label: 'geo.ip-api' });
      const j = r.json ?? {};
      if (j.status !== 'success') throw new Error(String(j.message ?? 'fail').slice(0, 80));
      return [j.country, j.regionName, j.city].filter(Boolean).join(' ') || null;
    },
  },
  {
    name: 'ipwhois',
    fetch: async (ip) => {
      const r = await fetchJson(`https://ipwho.is/${ip}?lang=zh-CN`, { timeoutMs: 4000, retries: 0, label: 'geo.ipwhois' });
      const j = r.json ?? {};
      if (j.success !== true) throw new Error(String(j.message ?? 'fail').slice(0, 80));
      return [j.country, j.region, j.city].filter(Boolean).join(' ') || null;
    },
  },
];

async function resolveRegion(ip) {
  for (const provider of PROVIDERS) {
    try {
      const region = await provider.fetch(ip);
      if (region) return region;
    } catch {
      /* 换下一个供应商 */
    }
  }
  return null;
}

/**
 * 后台补归属地：请求路径上只调用一次（不 await）。
 * 成功写回 visitor_logs.region 并进缓存；失败静默（控制台显示"未知"）。
 */
export async function enrichRegion(q, ip, logId) {
  if (!ip || isPrivateIp(ip) || pending.has(ip)) return;
  const cached = cachedRegion(ip);
  if (cached) {
    await db.setVisitorRegion(q, logId, cached).catch(() => {});
    return;
  }
  pending.add(ip);
  try {
    const region = await resolveRegion(ip);
    if (region) {
      regionCache.set(ip, { region, at: Date.now() });
      if (regionCache.size > MAX_CACHE) {
        const first = regionCache.keys().next().value;
        regionCache.delete(first);
      }
      await db.setVisitorRegion(q, logId, region).catch(() => {});
    }
  } finally {
    pending.delete(ip);
  }
}
