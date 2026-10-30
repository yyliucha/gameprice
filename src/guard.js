// 路径守卫：白名单 + 扫描器签名 + 未知路径计数。
//
// 重要：**这里不封禁任何人**。命中只生成一条「异常请求审核」，由管理员在控制台决定
// 要不要封 IP / 封设备。自动封禁在真实站点上误伤成本太高（共享出口、部署漏文件、爬虫）。
//
// 设计原则（踩过的坑）：
//   · 正常用户一定会请求资源文件（封面、favicon、JS）——这些永远是白名单。
//   · 未知路径按"不同路径数"计数：同一个坏链接重复刷新只算 1 个，不会把人误报成扫描器。
//   · 扫描器签名（.env、.git、*.php、..、/wp-、/phpmyadmin…）命中即上报，但仍走人工审批。
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const DEFAULTS = {
  enabled: true,
  unknownMax: 30, // 窗口内"不同"未知路径数达到多少才上报
  unknownWindowSec: 600,
  maxTrackedIps: 2000,
  maxPathsPerIp: 40,
  reviewThrottleSec: 60, // 同一 IP+规则最多每分钟上报一次，避免扫描器刷爆审核表
};

// 已知页面/文件：改页面时记得同步这里（静态文件也会用 existsSync 兜底，漏了也不会误报）
const KNOWN_EXACT = new Set([
  '/',
  '/index.html',
  '/console',
  '/console/',
  '/console.html',
  '/setup',
  '/setup/',
  '/setup.html',
  '/banned',
  '/banned/',
  '/appeal',
  '/appeal/',
  '/banned.html',
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

// 动态前缀：路由内部自己会做鉴权/404
const KNOWN_PREFIX = ['/api/', '/img/', '/.well-known/'];

const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot)$/i;

/** 扫描器签名：本站不可能存在的路径，正常浏览器不会产生。 */
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
const lastReviewAt = new Map(); // ip|rule -> ts

export function configure(next = {}) {
  const num = (value, fallback, min = 1) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  config = {
    enabled: next.enabled === undefined ? config.enabled : Boolean(next.enabled),
    unknownMax: num(next.unknownMax, config.unknownMax),
    unknownWindowSec: num(next.unknownWindowSec, config.unknownWindowSec),
    maxTrackedIps: num(next.maxTrackedIps, config.maxTrackedIps),
    maxPathsPerIp: num(next.maxPathsPerIp, config.maxPathsPerIp),
    reviewThrottleSec: num(next.reviewThrottleSec, config.reviewThrottleSec),
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

function throttleReview(ip, rule, now = Date.now()) {
  const key = `${ip}|${rule}`;
  if (now - (lastReviewAt.get(key) ?? 0) < config.reviewThrottleSec * 1000) return false;
  lastReviewAt.set(key, now);
  if (lastReviewAt.size > 5000) {
    for (const [k, ts] of lastReviewAt) if (now - ts > config.reviewThrottleSec * 3000) lastReviewAt.delete(k);
  }
  return true;
}

/**
 * 检查一次请求。只上报、不封禁。
 * 返回 { action: 'pass' | 'review', verdict, count?, rule?, detail? }
 * onReview(payload) 由调用方落库（默认没有任何副作用）。
 */
export async function inspect({ ip, path, method = 'GET', outDir = null, logger = null, onReview = null }) {
  if (!config.enabled || !ip) return { action: 'pass' };
  if (method === 'OPTIONS') return { action: 'pass' }; // CORS 预检永远放行

  const verdict = classifyPath(path, { outDir });
  if (verdict.kind === 'known') return { action: 'pass' };
  const shown = String(path ?? '').slice(0, 200);

  if (verdict.kind === 'signature') {
    logger?.warn('security.path_detected', { ip, path: shown, rule: verdict.rule, action: 'review' });
    if (throttleReview(ip, verdict.rule) && typeof onReview === 'function') {
      await onReview({ rule: verdict.rule, detail: '扫描器路径', path: shown });
    }
    return { action: 'review', verdict, rule: verdict.rule, detail: '扫描器路径' };
  }

  const count = recordUnknown(ip, path);
  if (count === 1) logger?.info('security.path_unknown', { ip, path: shown, threshold: config.unknownMax });
  if (count >= config.unknownMax) {
    const rec = unknownByIp.get(String(ip));
    if (rec) rec.paths.clear(); // 攒满一批就重新计数，避免同一批路径被反复上报
    logger?.warn('security.path_unknown_threshold', { ip, count, threshold: config.unknownMax, action: 'review' });
    if (throttleReview(ip, 'unknown-paths') && typeof onReview === 'function') {
      await onReview({ rule: 'unknown-paths', detail: `${count} 个不同未知路径`, path: shown });
    }
    return { action: 'review', verdict, count, rule: 'unknown-paths', detail: `${count} 个不同未知路径` };
  }
  return { action: 'log', verdict, count };
}

/** 测试用：清空内存计数。 */
export function resetState() {
  unknownByIp.clear();
  lastReviewAt.clear();
  config = { ...DEFAULTS };
}
