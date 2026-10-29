// 路径守卫：白名单 + 扫描器签名 + 未知路径计数。
//
// 设计原则（踩过的坑）：
//   · 正常用户一定会请求资源文件（封面、favicon、JS）——这些**永远**是白名单，不能当异常。
//   · 不能"不在白名单就封"：部署漏一个文件会让所有访客一起被封；共享出口（CGNAT/校园网）
//     会被一个人的扫描行为连坐。所以分三档：
//       known     白名单（路由表 + outDir 下真实存在的静态文件 + /api/、/img/、/.well-known/）
//       signature 扫描器签名（.env、.git、*.php、..、/wp-、/phpmyadmin…）→ 默认立即封
//       unknown   其余 404 → 默认只记录计数，达到阈值才封（可配成不封）
//   · 封禁只写临时封禁（1h/24h），独立计数 path_strikes，**永不自动进永久黑名单**。
//   · 任何异常都 fail-open：守卫自己出错只记日志，绝不让请求 500。
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import * as db from './store/pg.js';
import * as ratelimit from './ratelimit.js';

export const DEFAULTS = {
  enabled: true,
  signatureMode: 'block', // block | log
  unknownMode: 'log', // log | block
  unknownMax: 30, // 窗口内"不同"未知路径数达到多少才封
  unknownWindowSec: 600,
  banMinutes: 60, // 首次封禁
  repeatBanMinutes: 1440, // 24 小时内再犯
  maxTrackedIps: 2000, // 未知路径计数的内存上限
  maxPathsPerIp: 40, // 每个 IP 最多记多少条路径（够阈值即可）
};

// 已知页面/文件：改页面时记得同步这里（静态文件也会用 existsSync 兜底，所以漏了也不会误封）
const KNOWN_EXACT = new Set([
  '/',
  '/index.html',
  '/console',
  '/console/',
  '/console.html',
  '/setup',
  '/setup/',
  '/setup.html',
  '/settings-ui.js',
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  // 良性探测：不存在也放行，避免搜索引擎/监控/浏览器预检被当成扫描器
  '/robots.txt',
  '/sitemap.xml',
  '/crossdomain.xml',
  '/browserconfig.xml',
  '/humans.txt',
  '/security.txt',
  '/healthz',
  '/health',
  '/ping',
]);

// 动态前缀：路由内部自己会做鉴权/404，不需要路径守卫判断
const KNOWN_PREFIX = ['/api/', '/img/', '/.well-known/'];

const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot)$/i;

/** 扫描器签名。匹配的是"本站不可能存在"的路径，正常浏览器不会产生。 */
const SIGNATURES = [
  { rule: 'path-traversal', re: /(^|\/)\.\.(\/|$)/ },
  { rule: 'null-byte', re: /\0/ },
  { rule: 'vcs-dir', re: /(^|\/)\.(git|svn|hg|bzr)(\/|$)/ },
  { rule: 'secret-file', re: /(^|\/)(\.env(\.[a-z0-9]+)?|\.aws|\.ssh|\.htaccess|\.htpasswd|\.ds_store|id_rsa|web\.config)(\/|$)/ },
  { rule: 'script-ext', re: /\.(php\d?|phtml|asp|aspx|ashx|asmx|jsp|jspx|cgi|fcgi|pl|py|rb|sh|exe|dll|bat|cmd)$/ },
  { rule: 'backup-ext', re: /\.(sql|bak|old|orig|swp|swo|zip|tar|tgz|gz|rar|7z)$/ },
  {
    rule: 'cms-probe',
    re: /^\/(wp-|wordpress(\/|$)|xmlrpc\.php$|phpmyadmin|pma(\/|$)|myadmin|administrator(\/|$)|joomla(\/|$)|drupal(\/|$)|typo3(\/|$)|phpinfo|server-status|server-info|cgi-bin\/|actuator(\/|$)|solr(\/|$)|manager\/html)/,
  },
  { rule: 'system-file', re: /^\/(etc\/passwd|etc\/shadow|proc\/self|windows\/|boot\.ini)/ },
];

let config = { ...DEFAULTS };
const unknownByIp = new Map(); // ip -> { at, paths:Set }

export function configure(next = {}) {
  const num = (value, fallback, min = 1) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  config = {
    enabled: next.enabled === undefined ? config.enabled : Boolean(next.enabled),
    signatureMode: next.signatureMode === 'log' ? 'log' : 'block',
    unknownMode: next.unknownMode === 'block' ? 'block' : 'log',
    unknownMax: num(next.unknownMax, config.unknownMax),
    unknownWindowSec: num(next.unknownWindowSec, config.unknownWindowSec),
    banMinutes: num(next.banMinutes, config.banMinutes),
    repeatBanMinutes: num(next.repeatBanMinutes, config.repeatBanMinutes),
    maxTrackedIps: num(next.maxTrackedIps, config.maxTrackedIps),
    maxPathsPerIp: num(next.maxPathsPerIp, config.maxPathsPerIp),
  };
  return { ...config };
}

export function currentConfig() {
  return { ...config };
}

/** 统一大小写/编码/重复斜杠，用于匹配（不能用于拼文件路径）。 */
export function normalizePath(raw) {
  let s = String(raw ?? '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 非法编码就用原串 */
  }
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/** 静态资源（图片/CSS/JS/图标）——只用于限流分桶，不代表可疑。 */
export function isAssetPath(pathname) {
  const p = String(pathname ?? '').toLowerCase();
  if (
    p === '/favicon.ico' ||
    p === '/favicon.svg' ||
    p === '/apple-touch-icon.png' ||
    p === '/apple-touch-icon-precomposed.png' ||
    p === '/settings-ui.js'
  ) {
    return true;
  }
  if (p.startsWith('/img/')) return true;
  return ASSET_RE.test(p);
}

/** outDir 下真实存在的静态文件（outDir 为 web/ 或 out/）。 */
function existingStaticFile(pathname, outDir) {
  if (!outDir) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname ?? ''));
  } catch {
    return false;
  }
  if (!decoded.startsWith('/')) return false;
  const root = resolve(outDir);
  const file = resolve(root, `.${decoded}`);
  if (file !== root && !file.startsWith(root + sep)) return false;
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/** 路径分类：known | signature | unknown。 */
export function classifyPath(pathname, { outDir = null } = {}) {
  const raw = String(pathname ?? '/');
  const p = normalizePath(raw);
  if (!p || p === '/') return { kind: 'known' };
  for (const prefix of KNOWN_PREFIX) if (p.startsWith(prefix)) return { kind: 'known' };
  if (KNOWN_EXACT.has(p)) return { kind: 'known' };
  if (existingStaticFile(raw, outDir)) return { kind: 'known' };
  const hit = SIGNATURES.find((sig) => sig.re.test(p));
  if (hit) return { kind: 'signature', rule: hit.rule };
  return { kind: 'unknown' };
}

/** 记一个未知路径，返回窗口内不同路径数。 */
export function recordUnknown(ip, path, now = Date.now()) {
  const key = String(ip);
  const span = config.unknownWindowSec * 1000;
  let rec = unknownByIp.get(key);
  if (!rec || now - rec.at > span) {
    rec = { at: now, paths: new Set() };
    unknownByIp.set(key, rec);
  }
  if (rec.paths.size < config.maxPathsPerIp) rec.paths.add(String(path).slice(0, 200));
  // 内存上限：超过时淘汰最久没动静的 IP
  if (unknownByIp.size > config.maxTrackedIps) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of unknownByIp) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) unknownByIp.delete(oldestKey);
  }
  return rec.paths.size;
}

async function banFor(q, ip, rule) {
  const strikes = await db.recordPathStrike(q, ip);
  const minutes = strikes <= 1 ? config.banMinutes : config.repeatBanMinutes;
  const until = await db.setBanUntil(q, ip, minutes, 'path');
  ratelimit.applyExternalBan(ip, until, { source: 'path' });
  unknownByIp.delete(String(ip));
  return { strikes, minutes, until };
}

/**
 * 检查一次请求。
 * 返回 { action: 'pass' | 'log' | 'ban', verdict, count?, reason?, minutes?, until? }
 */
export async function inspect({ q, ip, path, method = 'GET', outDir = null, logger = null }) {
  if (!config.enabled || !ip) return { action: 'pass' };
  if (method === 'OPTIONS') return { action: 'pass' }; // CORS 预检永远放行

  const verdict = classifyPath(path, { outDir });
  if (verdict.kind === 'known') return { action: 'pass' };
  const shown = String(path ?? '').slice(0, 200);

  if (verdict.kind === 'signature') {
    if (config.signatureMode !== 'block') {
      logger?.warn('security.path_would_ban', { ip, path: shown, rule: verdict.rule, mode: 'log' });
      return { action: 'log', verdict };
    }
    const ban = await banFor(q, ip, verdict.rule);
    logger?.warn('security.path_ban', {
      ip,
      path: shown,
      rule: verdict.rule,
      strikes: ban.strikes,
      minutes: ban.minutes,
      until: new Date(ban.until).toISOString(),
    });
    return { action: 'ban', verdict, ...ban, reason: `扫描路径（${verdict.rule}）` };
  }

  // unknown：默认只记录；配置成 block 后达到阈值才封
  const count = recordUnknown(ip, path);
  if (count === 1) logger?.info('security.path_unknown', { ip, path: shown, threshold: config.unknownMax });
  if (config.unknownMode !== 'block' || count < config.unknownMax) {
    if (count === config.unknownMax) {
      logger?.warn('security.path_unknown_threshold', { ip, count, mode: config.unknownMode });
    }
    return { action: 'log', verdict, count };
  }
  const ban = await banFor(q, ip, 'unknown-paths');
  logger?.warn('security.path_ban', {
    ip,
    path: shown,
    rule: 'unknown-paths',
    count,
    strikes: ban.strikes,
    minutes: ban.minutes,
    until: new Date(ban.until).toISOString(),
  });
  return { action: 'ban', verdict, count, ...ban, reason: `连续访问未知路径（${count} 个）` };
}

/** 测试用：清空内存计数。 */
export function resetState() {
  unknownByIp.clear();
  config = { ...DEFAULTS };
}
