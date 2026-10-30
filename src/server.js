// Web 服务：静态页 + JSON API。
//
// 权限模型（对应"前台免登录可看、后台才能改"）：
//   GET  /api/*           匿名可读
//   POST /api/login       匿名
//   POST /api/prefs       需要登录（只影响自己的展示）
//   POST /api/games/:appid/interest   需要管理员
//   GET  /api/admin/*     需要管理员
//
// 折扣数据永远只由调度器写入，这里没有任何改价的接口——这是硬约束。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import * as db from './store/pg.js';
import * as visitors from './visitors.js';
import * as images from './images.js';
import * as ratelimit from './ratelimit.js';
import * as guard from './guard.js';
import * as devices from './devices.js';
import * as captcha from './captcha.js';
import { createBackup, listBackups } from './backup.js';
import { versionInfo } from './version.js';
import { VERSION } from './settings.js';
import * as settings from './settings.js';
import { handleSetupRoutes } from './setup-routes.js';
import { sessionCookie } from './session-cookie.js';
import { handleSettingsRoutes } from './settings-routes.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const COOKIE = 'gp_session';
const DEVICE_COOKIE = 'gp_device';

// 单款价格历史 CSV 默认关闭：线上暂不对外提供（避免被试探出导出能力）；HISTORY_CSV_ENABLED=1 才放行
const historyCsvEnabled = () => process.env.HISTORY_CSV_ENABLED === '1';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 是不是浏览器在请求页面（用于决定返回 JSON 还是封禁提示页）。 */
const wantsHtml = (req) =>
  /text\/html/i.test(String(req.headers.accept ?? '')) && !String(req.url ?? '').startsWith('/api/');

const bannedTplCache = new Map();
function bannedTemplate(outDir) {
  const file = resolve(outDir ?? 'web', 'banned.html');
  if (bannedTplCache.has(file)) return bannedTplCache.get(file);
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    html = '<!doctype html><meta charset="utf-8"><title>Access denied</title><h1>Access denied</h1>';
  }
  bannedTplCache.set(file, html);
  return html;
}

/** 封禁提示页：多语言在前端按 navigator.language 选，这里只注入站点名/申诉邮箱/到期时间/申诉编号。 */
function serveBanPage(res, outDir, { status = 403, until = null, reason = '', siteName = 'SteamDeals', appealEmail = '' } = {}, frontendDir = null) {
  const code = 'AP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const untilIso = until ? new Date(until).toISOString() : '';
  const distIndex = frontendDir && resolve(frontendDir, 'index.html');
  let html;
  if (distIndex && existsSync(distIndex)) {
    const payload = JSON.stringify({ status, until: untilIso, reason, site: siteName, email: appealEmail, code }).replace(/</g, '\\u003c');
    html = readFileSync(distIndex, 'utf8').replace('</head>', `<script>window.__BAN_PAGE__=${payload}</script></head>`);
  } else {
    html = bannedTemplate(outDir)
      .replaceAll('__SITE_NAME__', escapeHtml(siteName))
      .replaceAll('__APPEAL_EMAIL__', escapeHtml(appealEmail))
      .replaceAll('__UNTIL__', untilIso)
      .replaceAll('__REASON__', escapeHtml(reason))
      .replaceAll('__CODE__', code);
  }
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (until) headers['retry-after'] = String(Math.max(1, Math.ceil((Number(until) - Date.now()) / 1000)));
  res.writeHead(status, headers);
  res.end(html);
  return code;
}

function deviceCookie(req, value, maxAgeSec) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
  const https = proto === 'https' || Boolean(req.socket?.encrypted);
  return `${DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

const toIso = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// 封面图内存热缓存：数据库是持久层，这里只放最近访问的少量图片（LRU，约 300 张）
const imgMemCache = new Map(); // appid/size -> { contentType, body }
const IMG_MEM_MAX = 300;
// 取图失败缓存：5 分钟内不再重试，避免每次都拖满超时
const imgMissCache = new Map(); // appid/size -> ts

function memoGetImage(key) {
  const hit = imgMemCache.get(key);
  if (!hit) return null;
  imgMemCache.delete(key);
  imgMemCache.set(key, hit); // 移到队尾（最近使用）
  return hit;
}
function memoPutImage(key, entry) {
  imgMemCache.set(key, entry);
  if (imgMemCache.size > IMG_MEM_MAX) imgMemCache.delete(imgMemCache.keys().next().value);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
};

const readBody = (req, limit = 64 * 1024) =>
  new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return done({});
      try {
        done(JSON.parse(raw));
      } catch {
        fail(new Error('invalid json'));
      }
    });
    req.on('error', fail);
  });

/** 排序：折扣力度 / 金额 / 游戏名，默认折扣。 */
export function sortGames(rows, sort = 'discount') {
  const copy = [...rows];
  if (sort === 'price') {
    copy.sort((a, b) => (a.current_low ?? Infinity) - (b.current_low ?? Infinity));
  } else if (sort === 'name') {
    copy.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN'));
  } else {
    copy.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0) || (a.current_low ?? Infinity) - (b.current_low ?? Infinity));
  }
  return copy;
}
/**
 * 创建 API 服务。
 * query: (sql, params) => Promise<{rows}>
 */
export function createApiServer({
  query,
  logger = null,
  outDir = null,
  frontendDir = null,
  store = null,
  setupToken = '',
  getSetupState = null,
  imageFetch = null, // 测试注入：() => { body, bytes, contentType }；默认用 http.js 的 fetchBuffer
}) {
  const q = query;
  // 手动同步的进程内状态：同一时刻只允许一个同步任务
  let syncChild = null;
  let syncRun = null; // { id, mode, startedAt, params }
  let syncOutput = ''; // 子进程输出尾巴，供前端轮询
  let syncSettled = true;
  let syncStopRequested = false; // 后台点了"停止"，子进程退出后记为 cancelled

  /**
   * 启动一个 Steam 子进程任务（同步 / 回填共用同一个槽位，保证同一时间只有一个任务）。
   * 记录到 sync_runs，输出尾巴供前端轮询；返回 { runId, pid }。
   */
  async function startSteamJob({ mode, args, params = null, by = null }) {
    if (syncChild) {
      const err = new Error('已有任务在运行（同步/回填），请等它结束');
      err.code = 'BUSY';
      err.run = syncRun;
      throw err;
    }
    // 进程内没记录但库里有 running（服务重启残留）→ 先标失败，避免永远拒绝
    const stale = await db.runningSyncRun(q).catch(() => null);
    if (stale) await db.markStaleSyncRuns(q).catch(() => {});
    const run = await db.insertSyncRun(q, { mode, args: args.join(' ') });
    const { spawn } = await import('node:child_process');
    const fsMod = await import('node:fs');
    // SYNC_RUN_ID 让子进程复用这一条记录，避免重复建行
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SYNC_RUN_ID: String(run.id),
        // 后台回填是长任务：Steam 持续返回 429 时由 http.js 逐步延长冷却并自动重试，
        // 让管理员点一次后可留在服务器上运行；手动同步仍使用有限重试。
        ...(mode === 'backfill' || mode === 'heat' ? { STEAM_429_RETRIES: 'Infinity' } : {}),
      },
    });
    syncChild = child;
    syncRun = { id: run.id, mode, args: args.join(' '), startedAt: run.startedAt, params };
    syncOutput = '';
    syncSettled = false;
    syncStopRequested = false;
    const append = (chunk) => {
      syncOutput = (syncOutput + chunk).slice(-8000);
      try {
        fsMod.appendFileSync('logs/spawn.log', chunk);
      } catch {
        /* 日志目录不可写时忽略，DB 里仍有输出 */
      }
    };
    const finish = async (status, exitCode, note) => {
      if (syncSettled) return;
      syncSettled = true;
      syncChild = null;
      if (syncStopRequested) status = 'cancelled';
      if (note) append('\n' + note);
      try {
        await db.finishSyncRun(q, run.id, { status, exitCode, output: syncOutput });
      } catch {
        /* 记录失败不影响主流程 */
      }
      logger?.info('api.sync_finished', { mode, runId: run.id, status, exitCode });
    };
    child.stdout?.on('data', (d) => append(String(d)));
    child.stderr?.on('data', (d) => append(String(d)));
    child.on('error', (err) => {
      void finish('failed', null, '[spawn error] ' + String(err.message).slice(0, 300));
    });
    child.on('close', (code) => {
      void finish(code === 0 ? 'ok' : 'failed', code, null);
    });
    logger?.info('api.sync_started', { mode, args: args.join(' '), by, pid: child.pid, runId: run.id });
    return { runId: run.id, pid: child.pid };
  }

  // 被拦截请求的采样日志：同一 IP 每分钟最多一条，避免刷屏和污染访问统计
  const blockedLoggedAt = new Map();
  const logBlocked = ({ ip, req, path, status, reason }) => {
    const now = Date.now();
    if (now - (blockedLoggedAt.get(ip) ?? 0) < 60_000) return;
    blockedLoggedAt.set(ip, now);
    if (blockedLoggedAt.size > 5000) {
      for (const [k, v] of blockedLoggedAt) if (now - v > 300_000) blockedLoggedAt.delete(k);
    }
    db.insertVisitorLog(q, {
      ip,
      remoteIp: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
      region: visitors.cachedRegion(ip),
      path,
      method: req.method ?? 'GET',
      userAgent: req.headers['user-agent'],
      status,
      blocked: true,
      blockReason: reason,
    }).catch(() => {});
  };

  const siteName = () => String(process.env.SITE_NAME ?? 'SteamDeals').trim() || 'SteamDeals';
  const appealEmail = () =>
    String(process.env.APPEAL_EMAIL ?? process.env.ALERT_EMAIL_TO ?? process.env.SMTP_FROM ?? '').trim();

  /** 统一的封禁响应：浏览器给提示页，API/脚本给纯文本。 */
  const denyBanned = (req, res, { status = 403, until = null, reason = '访问被拒绝', ip = null } = {}) => {
    if (wantsHtml(req)) {
      const code = serveBanPage(res, outDir, { status, until, reason, siteName: siteName(), appealEmail: appealEmail() }, frontendDir);
      // 记录申诉编号，管理员收到申诉邮件后能按编号在日志里定位这次封禁
      logger?.warn('ban.page', { ip, code, status, until, reason });
      return code;
    }
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
    if (until) headers['retry-after'] = String(Math.max(1, Math.ceil((Number(until) - Date.now()) / 1000)));
    res.writeHead(status, headers);
    res.end(reason);
    return null;
  };

  /**
   * 异常请求审核：**只记录、不封禁**。
   * 同一 IP+规则由 guard 内部节流（默认 60s），数据库里 pending 记录再合并计数。
   */
  const recordReview = async ({ ip, deviceId, fingerprint, rule, detail, path }) => {
    try {
      const row = await db.recordAbuseReview(q, { ip, deviceId, fingerprint, rule, detail, path });
      logger?.warn('abuse.review', {
        ip,
        rule,
        path: String(path ?? '').slice(0, 120),
        hits: row?.hits ?? 1,
        deviceId: deviceId || null,
      });
    } catch (err) {
      logger?.warn('abuse.review_failed', { ip, rule, message: String(err.message).slice(0, 120) });
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
      const appealPage = path === '/appeal' || path === '/appeal/';
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE] ?? null;

    try {
      // ---- 基础安全响应头（所有响应都带）----
      applySecurityHeaders(req, res);

      // ---- 访问者 IP + 黑名单 + 频率限制（整站拦截，静态资源也一样拦）----
      const ip = visitors.clientIp(req);

      // 白名单：不计数、不受黑名单限制
      const whitelisted = ratelimit.isWhitelisted(ip);

      // 管理员放行：避免把自己拉黑后连控制台都进不去
      let adminBypass = false;
      if (token) {
        try {
          const u = await db.userBySession(q, token);
          adminBypass = u?.role === 'admin';
        } catch {
          adminBypass = false;
        }
      }

      // ---- 设备封禁（管理员在控制台审批后才会存在）----
      const deviceId = devices.normalizeDeviceId(cookies[DEVICE_COOKIE]);
      const deviceBan = deviceId && !adminBypass && !whitelisted ? devices.isBanned({ deviceId }) : null;
      if (deviceBan && !appealPage) {
        if (req.method === 'GET' && isFrontendAsset(path)) return serveFrontendStatic(res, frontendDir, outDir, path);
        logger?.warn('device.denied', { ip, deviceId, until: deviceBan.until });
        logBlocked({ ip, req, path, status: 403, reason: '设备已被封禁' });
        return denyBanned(req, res, { status: 403, until: deviceBan.until, reason: '设备已被封禁', ip });
      }

      // 频率限制：白名单/管理员不参与三振；内网/本机（反代、健康检查）不计数
      // 分桶：页面/API 与静态资源/图片分开计数——一个列表页几十张封面不该顶到页面阈值
      if (ip && !whitelisted && !adminBypass && !visitors.isPrivateAddress(ip) && !appealPage) {
        // 统一走 hit：封禁期内的请求也会被计数，够数就记一条待审核（**不再自动永久封**）
        const verdict = await ratelimit.hit(q, ip, { bucket: guard.isAssetPath(path) ? 'asset' : 'page' });
        if (verdict.limited) {
          if (req.method === 'GET' && isFrontendAsset(path)) return serveFrontendStatic(res, frontendDir, outDir, path);
          const until = Number(verdict.until) || 0;
          logger?.warn('rate.limited', {
            ip,
            path,
            strikes: verdict.strikes ?? null,
            reason: verdict.reason,
            escalated: Boolean(verdict.escalated),
            needsReview: Boolean(verdict.needsReview),
          });
          // 只有"新一次超限"才记审核；封禁期内的重复请求不重复记
          if (!verdict.banned && verdict.needsReview) {
            await recordReview({
              ip,
              deviceId,
              fingerprint: devices.fingerprintFor(deviceId),
              rule: 'rate-limit',
              detail: `超频 ${verdict.strikes || 1} 次：${verdict.reason}`,
              path,
            });
          }
          logBlocked({ ip, req, path, status: 429, reason: verdict.reason });
          return denyBanned(req, res, { status: 429, until, reason: verdict.reason, ip });
        }
      }

      const hit = ip && !adminBypass && !whitelisted ? visitors.blockedBy(ip) : null;
      if (hit && !appealPage) {
        if (req.method === 'GET' && isFrontendAsset(path)) return serveFrontendStatic(res, frontendDir, outDir, path);
        logger?.warn('block.ip_denied', { ip, path, rule: hit });
        logBlocked({ ip, req, path, status: 403, reason: `IP 黑名单（${hit}）` });
        return denyBanned(req, res, { status: 403, reason: '访问被拒绝', ip });
      }

      // ---- 路径守卫：白名单 / 扫描器签名 / 未知路径计数 ----
      // 只记录待审核，**绝不自动封禁**；管理员在控制台审批后才封 IP/设备。
      if (ip && !whitelisted && !adminBypass && !visitors.isPrivateAddress(ip) && visitors.isIpLike(ip)) {
        try {
          await guard.inspect({
            ip,
            path,
            method: req.method ?? 'GET',
            outDir,
            logger,
            onReview: (payload) =>
              recordReview({
                ip,
                deviceId,
                fingerprint: devices.fingerprintFor(deviceId),
                ...payload,
              }),
          });
        } catch (err) {
          // 守卫自己出错只记日志，绝不影响正常请求（fail-open）
          logger?.warn('guard.failed', { ip, path, message: String(err.message).slice(0, 160) });
        }
      }

      // ---- 访问记录：静态资源不记，页面与 API 必记（状态码在 finish 时补）----
      const logVisit = () => {
        if (!isLoggablePath(path)) return;
        const region = visitors.cachedRegion(ip);
        res.once('finish', () => {
          // 成功的只读 API 查询不计入访问记录；页面访问、登录/修改以及错误状态仍记录。
          if ((req.method === 'GET' && path.startsWith('/api/') || req.method === 'POST' && path === '/api/games/search') && res.statusCode < 400) return;
          db.insertVisitorLog(q, {
            ip,
            remoteIp: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
            region,
            path,
            method: req.method ?? 'GET',
            userAgent: req.headers['user-agent'],
            status: res.statusCode,
          })
            .then((id) => {
              if (!region && ip) visitors.enrichRegion(q, ip, id).catch(() => {});
            })
            .catch(() => {});
        });
      };
      logVisit();

      // ---- 首次初始化拦截：完成前只允许 /setup、设置页静态资源和 /api/setup/* ----
      const setupState = getSetupState ? await getSetupState() : { completed: true };
      if (!setupState.completed) {
        // 图标也要放行：否则 /setup 自身的 favicon 请求会被 302 成 HTML，标签页图标就丢了
        if (
          path === '/setup' ||
          (req.method === 'GET' && isFrontendAsset(path)) ||
          path === '/settings-ui.js' ||
          path === '/favicon.svg' ||
          path === '/favicon.ico' ||
          path === '/apple-touch-icon.png'
        ) {
          return serveFrontendStatic(res, frontendDir, outDir, path);
        }
        if (path.startsWith('/api/setup/')) {
          const handled = await handleSetupRoutes({
            path,
            req,
            res,
            q,
            store,
            logger,
            json,
            readBody,
            setupToken,
            cookieName: COOKIE,
          });
          if (handled) return;
        }
        if (path.startsWith('/api/')) {
          return json(res, 428, { error: '系统尚未初始化', setupRequired: true, setup: '/setup' });
        }
        res.writeHead(302, { location: '/setup', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (path === '/setup') {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      // 初始化完成后 /api/setup/status 仍可读；complete/schema 会返回 409
      if (path.startsWith('/api/setup/')) {
        const handled = await handleSetupRoutes({
          path,
          req,
          res,
          q,
          store,
          logger,
          json,
          readBody,
          setupToken,
          cookieName: COOKIE,
        });
        if (handled) return;
      }

      // ---- 封禁提示页（直接打开也返回同样的页面）----
      if (path === '/banned' || path === '/banned/') {
        const code = serveBanPage(res, outDir, { status: 403, siteName: siteName(), appealEmail: appealEmail(), reason: '访问受限' }, frontendDir);
        logger?.info('ban.page_direct', { ip, code });
        return;
      }

      // 静态资源（页面本身仍由 chart 生成，这里只发文件）
      // 注意：/img/ 是服务端图片代理路由（本地缓存 → CDN 兜底），不能当静态文件处理，
      // 否则会直接 404——这正是之前"前台只有名字没有图"的真正原因。
      if (!path.startsWith('/api/') && !path.startsWith('/img/')) {
        return serveFrontendStatic(res, frontendDir, outDir, path);
      }

      // ---- 公开接口：站点信息 / 公告 / 设备指纹上报 ----
      if (path === '/api/site' && req.method === 'GET') {
        return json(res, 200, { name: siteName(), version: VERSION, appealEmail: appealEmail() });
      }
      if (path === '/api/announcements' && req.method === 'GET') {
        const rows = await db.listAnnouncements(q, { activeOnly: true, limit: 200 });
        return json(
          res,
          200,
          {
            announcements: rows.map((r) => ({
              id: Number(r.id),
              title: r.title,
              body: r.body,
              level: r.level,
              startsAt: r.starts_at,
              endsAt: r.ends_at,
            })),
          },
          { 'cache-control': 'no-store' },
        );
      }
      if (path === '/api/device' && req.method === 'POST') {
        let body;
        try {
          body = await readBody(req, 16 * 1024);
        } catch {
          return json(res, 400, { error: '请求格式错误' });
        }
        if (!body || typeof body !== 'object') return json(res, 400, { error: '请求格式错误' });
        const deviceId = devices.normalizeDeviceId(body?.deviceId);
        const details = devices.sanitizeDetails(body?.details);
        const fingerprint = devices.fingerprintOf(details);
        const cookie = deviceCookie(req, deviceId, deviceId ? 31536000 : 0);
        const ban = devices.isBanned({ deviceId, fingerprint });
        if (ban) {
          logger?.warn('device.banned', { ip, deviceId: deviceId || null, fingerprint: fingerprint.slice(0, 16), until: ban.until });
          return json(res, 403, { banned: true, until: ban.until, reason: ban.note || '设备已被封禁' }, { 'set-cookie': cookie });
        }
        if (deviceId) devices.rememberDevice(deviceId, fingerprint, details);
        if (devices.shouldLog(deviceId || fingerprint)) {
          db.insertDeviceLog(q, { ip, deviceId, fingerprint, userAgent: req.headers['user-agent'], details }).catch(() => {});
        }
        return json(res, 200, { ok: true, fingerprint: fingerprint.slice(0, 16) }, { 'set-cookie': cookie });
      }

      const user = token ? await db.userBySession(q, token) : null;

      // 邮箱验证码路由（发送 / 校验），逻辑在 auth-routes.js
      const authRoutes = await import('./auth-routes.js');
      if (await authRoutes.handleEmailAuth({ path, req, res, q, logger, json, readBody })) return;
      const requireUser = () => {
        if (!user) {
          json(res, 401, { error: '需要登录' });
          return false;
        }
        return true;
      };
      const requireAdmin = () => {
        if (!user) {
          json(res, 401, { error: '需要登录' });
          return false;
        }
        if (user.role !== 'admin') {
          json(res, 403, { error: '需要管理员' });
          return false;
        }
        return true;
      };

      // 系统设置（管理员）：读写 app_settings / smtp_settings
      if (path.startsWith('/api/admin/settings')) {
        if (!requireAdmin()) return;
        const handled = await handleSettingsRoutes({ path, req, res, q, store, logger, json, readBody, user });
        if (handled) return;
      }

      // ---- 登录 / 登出 ----
      // ---- 图形验证码（登录前置，匿名可拿；缓存禁止）----
      if (path === '/api/captcha' && req.method === 'GET') {
        const cap = await captcha.issue(q);
        return json(res, 200, cap, { 'cache-control': 'no-store' });
      }

      if (path === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        // 验证码校验放在密码之前：没通过就不会消耗一次密码尝试，也不会泄露账号是否存在
        if (captcha.enabled()) {
          const okCaptcha = await captcha.verify(q, body.captchaToken, body.captchaAnswer);
          if (!okCaptcha) {
            logger?.warn('api.login_captcha_failed', { ip, username: String(body.username ?? '').slice(0, 32) });
            return json(res, 400, { error: '验证码错误或已过期，请重新输入' });
          }
        }
        const found = await db.findUserByName(q, String(body.username ?? ''));
        if (!found || found.disabled || !db.verifyPassword(String(body.password ?? ''), found.password_hash)) {
          logger?.warn('api.login_failed', { username: String(body.username ?? '').slice(0, 32), disabled: Boolean(found?.disabled) });
          return json(res, 401, { error: found?.disabled ? '账号已被禁用' : '用户名或密码错误' });
        }
        const sessionToken = await db.createSession(q, { userId: found.id });
        logger?.info('api.login', { userId: found.id, username: found.username });
        return json(
          res,
          200,
          { user: { id: found.id, username: found.username, role: found.role } },
          { 'set-cookie': sessionCookie(req, sessionToken, 604800) },
        );
      }

      if (path === '/api/logout' && req.method === 'POST') {
        await db.deleteSession(q, token);
        return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
      }

      // ---- 当前用户与偏好 ----
      if (path === '/api/me' && req.method === 'GET') {
        const prefs = user ? await db.getPrefs(q, user.id) : null;
        return json(res, 200, { user: user ? { id: user.id, username: user.username, role: user.role } : null, prefs });
      }

      if (path === '/api/prefs' && req.method === 'POST') {
        if (!requireUser()) return;
        const body = await readBody(req);
        const prefs = await db.savePrefs(q, user.id, body);
        logger?.info('api.prefs_saved', { userId: user.id, ...prefs });
        return json(res, 200, { prefs });
      }

      // ---- 游戏数量（匿名可读）：库内总数 + 已有价格数，前台"实时数量"靠它 ----
      if (path === '/api/games/count' && req.method === 'GET') {
        const priced = await q('select count(*)::int as n from (select distinct game_id from daily_prices) x');
        const catalog = await q('select count(*)::int as n from games where not deleted and not blocked');
        return json(res, 200, { priced: priced.rows[0]?.n ?? 0, catalog: catalog.rows[0]?.n ?? 0 });
      }

      // ---- 数据指纹（匿名可读）：前台轮询这个，变了才重新拉列表 ----
      // 只做低成本聚合：别再让每次自动刷新都跑一遍完整列表查询。
      // 说明：价格/库存变化会更新 offers.last_seen_at，新游戏/新报价会改变计数，
      // 所以这三项足够判断"列表内容是否需要重新拉"。
      if (path === '/api/games/stamp' && req.method === 'GET') {
        const r = await q(
          `select (select count(*)::int from games) as games,
                  (select count(*)::int from offers) as offers,
                  (select max(last_seen_at)::text from offers) as offers_seen`,
        );
        const row = r.rows[0] ?? {};
        const stamp = [row.games, row.offers, row.offers_seen].join('|');
        return json(res, 200, { stamp, ...row }, { 'cache-control': 'no-store' });
      }

      // ---- 游戏列表（匿名可读）：GET 保留旧接口；POST 用于游客本地标记筛选 ----
      const guestSearchPost = path === '/api/games/search' && req.method === 'POST';
      if ((path === '/api/games' && req.method === 'GET') || guestSearchPost) {
        const body = guestSearchPost ? await readBody(req, 256 * 1024) : {};
        const getInput = (key) => guestSearchPost ? body?.[key] : url.searchParams.get(key);
        const oneOf = (key, allowed, fallback) => {
          const v = String(getInput(key) ?? '').trim();
          return allowed.includes(v) ? v : fallback;
        };
        const interest = oneOf('interest', ['all', 'on', 'off'], 'all');
        const ownedParam = oneOf('owned', ['exclude', 'only', 'include'], 'exclude');
        const blockedParam = oneOf('blocked', ['exclude', 'only', 'include'], 'exclude');
        const sort = oneOf('sort', ['discount', 'price', 'name'], 'discount');
        const typeFilter = oneOf('type', ['all', 'game', 'dlc'], 'all');
        const released = oneOf('released', ['all', '30d', '1y', '3y'], 'all');
        const compact = guestSearchPost || url.searchParams.get('compact') === '1';
        const keyword = String(getInput('q') ?? '').slice(0, 80);
        const pageSize = Math.min(
          Math.max(Number(guestSearchPost ? getInput('pageSize') ?? 20 : url.searchParams.get('pageSize') ?? url.searchParams.get('limit') ?? 20) || 20, 5),
          100,
        );
        const page = Math.max(1, Number(getInput('page') ?? 1) || 1);
        const maxBigintId = 9223372036854775807n;
        const normalizeIds = (value) => Array.isArray(value)
          ? [...new Set(value.slice(0, 5000).map((id) => String(id)).filter((id) => /^\d{1,19}$/.test(id) && BigInt(id) > 0n && BigInt(id) <= maxBigintId))]
          : [];
        const guestFlags = guestSearchPost && !user ? {
          interestedIds: normalizeIds(body?.guestFlags?.interestedIds),
          uninterestedIds: normalizeIds(body?.guestFlags?.uninterestedIds),
          ownedIds: normalizeIds(body?.guestFlags?.ownedIds),
        } : null;
        const result = await db.gameSearch(q, {
          region: String(getInput('region') ?? 'cn').slice(0, 12),
          page,
          pageSize,
          keyword,
          sort,
          interest,
          owned: ownedParam,
          blocked: blockedParam,
          userId: user?.id ?? null,
          typeFilter,
          released,
          compact,
          guestFlags,
        });
        return json(res, 200, {
          games: result.rows,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          pages: result.pages,
          sort,
          owned: ownedParam,
          interest,
          q: keyword,
          type: typeFilter,
        });
      }

      // ---- 单个游戏（匿名可读）----
      // ---- 单个游戏（按内部 id，用于没有 Steam appid 的杉果游戏）----
      const byIdMatch = path.match(/^\/api\/games\/by-id\/(\d+)$/);
      if (byIdMatch && req.method === 'GET') {
        const id = Number(byIdMatch[1]);
        const game = await db.gameDetail(q, { gameId: id, region: url.searchParams.get('region') ?? 'cn', userId: user?.id ?? null });
        if (!game) return json(res, 404, { error: '没有该游戏' });
        const offers = await db.offersOfGame(q, { gameId: game.id, region: 'cn' });
        const series = await db.dailyMinSeries(q, { gameId: game.id, region: 'cn' });
        if (user) await db.recordView(q, { userId: user.id, path: `/game/id/${id}`, appid: game.steam_appid ?? null });
        return json(res, 200, { game, offers, series });
      }

      // ---- Steam 图片代理：/img/steam/<appid>/<size>（服务端经代理取 CDN，前端无需直连） ----
      const imgMatch = path.match(/^\/img\/steam\/(\d+)\/([a-z0-9_]+)$/);
      if (imgMatch && req.method === 'GET') {
        const appid = imgMatch[1];
        const size = imgMatch[2];
        if (!images.isImageSize(size)) return json(res, 404, { error: 'unknown size' });
        const key = appid + '/' + size;
        const imgHeaders = (contentType, length) => ({
          'content-type': contentType,
          'content-length': length,
          'cache-control': 'public, max-age=31536000, immutable',
        });

        // 1) 内存热缓存（列表刷新会重复取同一批图）
        const hot = memoGetImage(key);
        if (hot) {
          res.writeHead(200, imgHeaders(hot.contentType, hot.body.length));
          res.end(hot.body);
          return;
        }

        // 2) 本地磁盘：图片下载过一次后只读文件，不再碰 CDN/代理（VPS 只用于数据联通）
        const local = images.readImage(appid, size);
        if (local) {
          memoPutImage(key, { contentType: 'image/jpeg', body: local });
          res.writeHead(200, imgHeaders('image/jpeg', local.length));
          res.end(local);
          return;
        }

        // 3) 本地没有：走三条 CDN 兜底取一次，成功后落盘
        const missAt = imgMissCache.get(key);
        if (missAt && Date.now() - missAt < 5 * 60 * 1000) {
          res.writeHead(404);
          res.end();
          return;
        }
        const fetcher = imageFetch ?? (await import('./http.js')).fetchBuffer;
        const got = await images.downloadImage(appid, size, { fetchBuffer: fetcher, timeoutMs: 8000 });
        if (got.ok) {
          memoPutImage(key, { contentType: got.contentType, body: got.body });
          logger?.info('steam.img_cached', { appid, size, bytes: got.bytes });
          res.writeHead(200, imgHeaders(got.contentType, got.body.length));
          res.end(got.body);
          return;
        }
        imgMissCache.set(key, Date.now());
        if (imgMissCache.size > 2000) imgMissCache.delete(imgMissCache.keys().next().value);
        logger?.warn('steam.img_miss', { appid, size, message: String(got.error?.message ?? '').slice(0, 160) });
        res.writeHead(404);
        res.end();
        return;
      }

      const gameMatch = path.match(/^\/api\/games\/(\d+)$/);
      if (gameMatch && req.method === 'GET') {
        const appid = Number(gameMatch[1]);
        // 单款查询：不走"列表前 500 名"，否则排在后面的游戏会 404（后台编辑曾因此失败）
        const game = await db.gameDetail(q, { steamAppid: appid, region: url.searchParams.get('region') ?? 'cn', userId: user?.id ?? null });
        if (!game) return json(res, 404, { error: '没有该游戏' });
        const offers = await db.regionOffers(q, { steamAppid: appid });
        const series = await db.dailyMinSeries(q, { gameId: game.id, region: 'cn' });
        if (user) await db.recordView(q, { userId: user.id, path: `/game/${appid}`, appid });
        return json(res, 200, { game, offers, series });
      }

      // ---- 登录用户：个人标记（个人优先，未标记回退全局标记）----
      const flagsByAppid = path.match(/^\/api\/games\/(\d+)\/flags$/);
      const flagsById = path.match(/^\/api\/games\/id\/(\d+)\/flags$/);
      if ((flagsByAppid || flagsById) && req.method === 'POST') {
        if (!requireUser()) return;
        const body = await readBody(req);
        let gameId = null;
        if (flagsByAppid) {
          const found = await db.gameDetail(q, { steamAppid: Number(flagsByAppid[1]) });
          if (!found) return json(res, 404, { error: '没有该游戏' });
          gameId = found.id;
        } else {
          gameId = Number(flagsById[1]);
        }
        // 'clear' = 显式清除个人标记（回退全局）；boolean = 设置；其余 = 不改动
        const pick = (v) => (v === 'clear' ? 'clear' : typeof v === 'boolean' ? v : null);
        const flags = await db.setUserGameFlag(q, {
          userId: user.id,
          gameId,
          interested: pick(body.interested),
          owned: pick(body.owned),
        });
        if (!flags) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.user_flag', { userId: user.id, gameId, interested: flags.interested, owned: flags.owned });
        return json(res, 200, { flags });
      }

      // ---- 管理员：标记兴趣、看用户 ----
      const interestMatch = path.match(/^\/api\/games\/(\d+)\/interest$/);
      if (interestMatch && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const appid = Number(interestMatch[1]);
        const row = await db.setInterest(q, { steamAppid: appid, interested: Boolean(body.interested) });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.interest', { appid, interested: row.interested, by: user.username });
        return json(res, 200, { game: row });
      }

      // ---- 管理员：标记已拥有 ----
      const ownedMatch = path.match(/^\/api\/games\/(\d+)\/owned$/);
      if (ownedMatch && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const appid = Number(ownedMatch[1]);
        const row = await db.setOwned(q, { steamAppid: appid, owned: Boolean(body.owned) });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.owned', { appid, owned: row.owned, by: user.username });
        return json(res, 200, { game: row });
      }

      // ---- 管理员：按内部 id 标记（杉果等没有 Steam appid 的游戏）----
      const byIdInterest = path.match(/^\/api\/games\/id\/(\d+)\/interest$/);
      if (byIdInterest && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const gameId = Number(byIdInterest[1]);
        const row = await db.setInterest(q, { gameId, interested: Boolean(body.interested) });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.interest_by_id', { gameId, interested: row.interested, by: user.username });
        return json(res, 200, { game: row });
      }

      const byIdOwned = path.match(/^\/api\/games\/id\/(\d+)\/owned$/);
      if (byIdOwned && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const gameId = Number(byIdOwned[1]);
        const row = await db.setOwned(q, { gameId, owned: Boolean(body.owned) });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.owned_by_id', { gameId, owned: row.owned, by: user.username });
        return json(res, 200, { game: row });
      }

      // ---- 管理员：用户管理（编辑 / 改密码 / 禁用）----
      // ---- Steam OpenID 登录 / 游戏库（独立于站点用户体系）----
      const steamMod = await import('./steam-login.js');
      await steamMod.ensureSteamSchemaOnce(q);
      const parseCookies = (header) => Object.fromEntries(String(header ?? '').split(';').map((c) => c.trim().split('=')).filter((x) => x.length === 2));

      if (path === '/api/auth/steam/start' && req.method === 'GET') {
        const target = steamMod.buildLoginUrl(steamMod.baseUrl(req));
        logger?.info('steam.login_start', { host: req.headers.host });
        res.writeHead(302, { location: target });
        res.end();
        return;
      }

      if (path.startsWith('/api/auth/steam/callback')) {
        const steamId = await steamMod.verifyCallback(url, { logger });
        if (!steamId) return json(res, 400, { error: 'Steam 校验失败，请重试' });
        const apiKey = String(process.env.STEAM_API_KEY ?? '').trim();
        const persona = await steamMod.fetchPersona({ apiKey, steamId, logger });
        await q(
          "insert into steam_accounts (steam_id, persona_name, avatar, last_login_at) values ($1, $2, $3, now()) " +
          "on conflict (steam_id) do update set persona_name = coalesce(excluded.persona_name, steam_accounts.persona_name), avatar = coalesce(excluded.avatar, steam_accounts.avatar), last_login_at = now()",
          [steamId, persona.personaName, persona.avatar],
        );
        const token = await steamMod.createSteamSession(q, steamId);
        logger?.info('steam.login_ok', { steamId, persona: persona.personaName ?? null });
        res.writeHead(302, {
          location: '/#steam',
          'set-cookie': 'steam_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
        });
        res.end();
        return;
      }

      if (path === '/api/steam/me' && req.method === 'GET') {
        const cookies = parseCookies(req.headers.cookie);
        const steamId = await steamMod.steamIdBySession(q, cookies.steam_session);
        if (!steamId) return json(res, 200, { steamId: null });
        const acc = await q(
          'select a.steam_id, a.persona_name, a.avatar, (select count(*)::int from steam_games g where g.steam_id = a.steam_id) as games from steam_accounts a where a.steam_id = $1',
          [steamId],
        );
        return json(res, 200, { ...(acc.rows[0] ?? {}), steamId });
      }

      if (path === '/api/steam/logout' && req.method === 'POST') {
        const cookies = parseCookies(req.headers.cookie);
        await q('delete from steam_sessions where token = $1', [cookies.steam_session ?? '']);
        res.writeHead(302, { location: '/#steam', 'set-cookie': 'steam_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
        res.end();
        return;
      }

      if (path === '/api/steam/library/sync' && req.method === 'POST') {
        const cookies = parseCookies(req.headers.cookie);
        const steamId = await steamMod.steamIdBySession(q, cookies.steam_session);
        if (!steamId) return json(res, 401, { error: '请先登录 Steam' });
        const apiKey = String(process.env.STEAM_API_KEY ?? '').trim();
        if (!apiKey) return json(res, 400, { error: '未配置 STEAM_API_KEY（Steam Web API Key）' });
        let games = [];
        try {
          games = await steamMod.fetchOwnedGames({ apiKey, steamId, logger });
        } catch (err) {
          return json(res, 502, { error: '拉取游戏库失败：' + String(err.message).slice(0, 160) });
        }
        for (const g of games) {
          await q(
            "insert into steam_games (steam_id, appid, name, playtime_minutes, last_played_at, synced_at) values ($1,$2,$3,$4,$5,now()) " +
            "on conflict (steam_id, appid) do update set name = excluded.name, playtime_minutes = excluded.playtime_minutes, last_played_at = excluded.last_played_at, synced_at = now()",
            [steamId, g.appid, g.name, g.playtimeMinutes, g.lastPlayedAt],
          );
        }
        logger?.info('steam.library_synced', { steamId, total: games.length });
        return json(res, 200, { total: games.length });
      }

      if (path === '/api/steam/library' && req.method === 'GET') {
        const cookies = parseCookies(req.headers.cookie);
        const steamId = await steamMod.steamIdBySession(q, cookies.steam_session);
        if (!steamId) return json(res, 200, { steamId: null, games: [] });
        const games = await q(
          "select sg.appid, coalesce(g.name, sg.name) as name, sg.playtime_minutes, sg.last_played_at, " +
          "g.steam_appid is not null as in_db, " +
          "(select min(o.price_cents) from offers o where o.game_id = g.id and o.in_stock) as low " +
          "from steam_games sg left join games g on g.steam_appid = sg.appid where sg.steam_id = $1 order by sg.playtime_minutes desc limit 500",
          [steamId],
        );
        return json(res, 200, { steamId, games: games.rows });
      }

      // ---- 管理员：游戏同步概览（待同步数量统计）----
      if (path === '/api/admin/games/stats' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { stats: await db.adminGameStats(q) });
      }

      // ---- 管理员：游戏列表（分页 + 搜索 + 平台筛选 + 同步状态 + 回收站）----
      if (path === '/api/admin/games' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const kw = String(url.searchParams.get('q') ?? '').trim();
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
        const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize') ?? 20) || 20, 5), 200);
        const offset = (page - 1) * pageSize;
        const platform = String(url.searchParams.get('platform') ?? '').trim();
        const sync = String(url.searchParams.get('sync') ?? '').trim();
        const deletedParam = String(url.searchParams.get('deleted') ?? 'exclude');
        // 默认只看正常游戏；deleted=only 就是回收站，include 两边都看
        const deletedWhere =
          deletedParam === 'only' ? ' and g.deleted = true' : deletedParam === 'include' ? '' : ' and not g.deleted';
        // 同步状态：pending=缺说明或无 Steam 价格；done=两者都有
        const syncWhere =
          sync === 'pending'
            ? " and g.steam_appid is not null and (g.description is null or g.description = '' or not exists (select 1 from offers so where so.game_id = g.id and so.platform_code = 'steam'))"
            : sync === 'done'
              ? " and g.steam_appid is not null and g.description is not null and g.description <> '' and exists (select 1 from offers so2 where so2.game_id = g.id and so2.platform_code = 'steam')"
              : '';
        // 平台筛选：按参数位置生成（计数查询与列表查询占位符不同）
        const platformCond = (index) =>
          platform
            ? " and exists (select 1 from offers po join platforms pp on pp.code = po.platform_code where po.game_id = g.id and po.platform_code = $" + index + ')'
            : '';
        const baseWhere =
          "where ($1 = '' or lower(coalesce(g.name, '')) like lower('%' || $1 || '%') " +
          "or lower(coalesce(g.name_en, '')) like lower('%' || $1 || '%') or cast(g.steam_appid as text) = $1)" +
          deletedWhere + syncWhere;
        const cnt = await q(
          'select count(*)::int as n from games g ' + baseWhere + platformCond(2),
          platform ? [kw, platform] : [kw],
        );
        const rows = await q(
          'select g.id, g.steam_appid, coalesce(g.name, \'appid:\' || g.steam_appid) as name, g.name_en, g.app_type, g.blocked, g.deleted, g.deleted_at, g.updated_at, ' +
          '(g.description is not null and g.description <> \'\') as has_desc, ' +
          '(select count(*) from offers o where o.game_id = g.id) as offer_count, ' +
          '(select min(o.price_cents) from offers o where o.game_id = g.id and o.platform_code = \'steam\' and o.in_stock) as steam_price, ' +
          // 平台列：这款游戏当前有报价的渠道（多个用数组，前端渲染成多个标签）
          '(select coalesce(array_agg(distinct p.name), \'{}\') from offers o2 join platforms p on p.code = o2.platform_code where o2.game_id = g.id) as platform_names, ' +
          '(select coalesce(array_agg(distinct o3.platform_code), \'{}\') from offers o3 where o3.game_id = g.id) as platform_codes ' +
          'from games g ' + baseWhere + platformCond(4) + ' ' +
          'order by g.updated_at desc nulls last, g.id desc limit $2 offset $3',
          platform ? [kw, pageSize, offset, platform] : [kw, pageSize, offset],
        );
        const total = cnt.rows[0]?.n ?? 0;
        return json(res, 200, { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), games: rows.rows });
      }

      // ---- 管理员：回收站（逻辑删除的游戏）----
      if (path === '/api/admin/games/deleted' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const limit = Number(url.searchParams.get('limit') ?? 200);
        return json(res, 200, { games: await db.listDeletedGames(q, { limit }) });
      }

      // ---- 管理员：到价提醒（关注列表）----
      if (path === '/api/admin/watchlist' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const region = String(url.searchParams.get('region') ?? 'cn');
        return json(res, 200, { watches: await db.listWatches(q, { region }) });
      }

      if (path === '/api/admin/watchlist' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        let gameId = Number(body.gameId);
        if (!Number.isFinite(gameId) || gameId <= 0) {
          const appid = Number(body.appid);
          const found = Number.isFinite(appid) && appid > 0 ? await db.gameDetail(q, { steamAppid: appid }) : null;
          if (!found) return json(res, 400, { error: '需要有效的 gameId 或 appid' });
          gameId = found.id;
        }
        let targetCents = null;
        if (body.targetCents != null && body.targetCents !== '') {
          const n = Math.round(Number(body.targetCents));
          if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: '目标价不合法' });
          targetCents = n;
        }
        const id = await db.upsertWatch(q, {
          gameId,
          region: 'cn',
          targetCents,
          note: String(body.note ?? '').trim().slice(0, 200) || null,
        });
        logger?.info('api.watch_saved', { gameId, targetCents, by: user.username });
        return json(res, 200, { id });
      }

      const watchDel = path.match(/^\/api\/admin\/watchlist\/(\d+)$/);
      if (watchDel && req.method === 'DELETE') {
        if (!requireAdmin()) return;
        const removed = await db.deleteWatch(q, { gameId: Number(watchDel[1]), region: 'cn' });
        logger?.info('api.watch_deleted', { gameId: Number(watchDel[1]), removed, by: user.username });
        return json(res, 200, { removed });
      }

      // ---- 管理员：版本与更新检查 ----
      if (path === '/api/admin/version' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const force = url.searchParams.get('force') === '1';
        const repo = process.env.UPDATE_REPO || undefined;
        // UPDATE_CHECK=0 时只报当前版本，不出网
        if (process.env.UPDATE_CHECK === '0') {
          return json(res, 200, {
            current: VERSION,
            latest: null,
            updateAvailable: false,
            url: null,
            checkedAt: new Date().toISOString(),
            error: null,
            repo: repo ?? null,
          });
        }
        return json(res, 200, await versionInfo({ current: VERSION, repo, logger, force }));
      }

      // ---- 管理员：备份（手动触发 + 列表）----
      if (path === '/api/admin/backups' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { backups: listBackups(process.env.BACKUP_DIR ?? 'data/backup') });
      }

      if (path === '/api/admin/backup' && req.method === 'POST') {
        if (!requireAdmin()) return;
        try {
          const result = await createBackup(q, { dir: process.env.BACKUP_DIR ?? 'data/backup', logger });
          logger?.info('api.backup_done', { ...result, by: user.username });
          return json(res, 200, { result, backups: listBackups(process.env.BACKUP_DIR ?? 'data/backup') });
        } catch (err) {
          logger?.warn('api.backup_failed', { message: String(err.message).slice(0, 160) });
          return json(res, 500, { error: '备份失败：' + String(err.message).slice(0, 120) });
        }
      }

      // ---- 单款价格历史 CSV（默认关闭，见 historyCsvEnabled）----
      const historyCsv = path.match(/^\/api\/games\/(\d+)\/history\.csv$/);
      if (historyCsv && req.method === 'GET') {
        if (!historyCsvEnabled()) return json(res, 404, { error: 'not found' });
        const appid = Number(historyCsv[1]);
        const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 90) || 90, 1), 3650);
        const game = await db.gameDetail(q, { steamAppid: appid });
        if (!game) return json(res, 404, { error: '没有该游戏' });
        const cutoff = Date.now() - days * 86400000;
        const series = (await db.dailyMinSeries(q, { gameId: game.id, region: 'cn' })).filter(
          (p) => new Date(p.day).getTime() >= cutoff,
        );
        const lines = ['date,price_cents,price,currency'];
        for (const p of series) lines.push([p.day, p.price_cents, (p.price_cents / 100).toFixed(2), p.currency].join(','));
        const body = '\uFEFF' + lines.join('\r\n');
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="history-' + appid + '.csv"',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }

      // ---- 管理员：合并重复游戏（把 from 并进 to，按 Steam appid 指定）----
      if (path === '/api/admin/games/merge' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const fromAppid = Number(body.fromAppid);
        const toAppid = Number(body.toAppid);
        if (!Number.isFinite(fromAppid) || !Number.isFinite(toAppid)) {
          return json(res, 400, { error: '需要 fromAppid 与 toAppid' });
        }
        if (fromAppid === toAppid) return json(res, 400, { error: '源和目标不能是同一个游戏' });
        const from = await db.gameDetail(q, { steamAppid: fromAppid });
        const to = await db.gameDetail(q, { steamAppid: toAppid });
        if (!from) return json(res, 404, { error: '源游戏不存在：' + fromAppid });
        if (!to) return json(res, 404, { error: '目标游戏不存在：' + toAppid });
        const result = await db.mergeGames(q, { fromGameId: from.id, toGameId: to.id, logger });
        logger?.info('api.game_merged', { fromAppid, toAppid, ...result, by: user.username });
        return json(res, 200, { result });
      }

      // ---- 管理员：逻辑删除 / 恢复（按 appid 或内部 id）----
      const delByAppid = path.match(/^\/api\/games\/(\d+)\/deleted$/);
      const delById = path.match(/^\/api\/games\/id\/(\d+)\/deleted$/);
      if ((delByAppid || delById) && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const target = delByAppid ? { steamAppid: Number(delByAppid[1]) } : { gameId: Number(delById[1]) };
        const row = await db.setGameDeleted(q, { ...target, deleted: body.deleted !== false });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.game_deleted', { ...target, deleted: row.deleted, by: user.username });
        return json(res, 200, { game: row });
      }

      // ---- 管理员：验证邮箱归属（发码 / 校验）----      // ---- 管理员：验证邮箱归属（发码 / 校验）----      // ---- 管理员：验证邮箱归属（发码 / 校验）----
      const bindCode = path.match(/^\/api\/admin\/users\/([^/]+)\/email\/code$/);
      if (bindCode && req.method === 'POST') {
        if (!requireAdmin()) return;
        const auth = await import('./email-auth.js');
        const { sendMail } = await import('./notify.js');
        const username = decodeURIComponent(bindCode[1]);
        const urow = await q('select id, username, email from users where username = $1', [username]);
        const target = urow.rows[0];
        if (!target) return json(res, 404, { error: '没有该用户' });
        if (!target.email) return json(res, 400, { error: '该用户还没有绑定邮箱' });
        const cfg = await auth.smtpConfig(q);
        if (!auth.isSmtpConfigured(cfg)) return json(res, 503, { error: 'SMTP 未配置，无法发送验证邮件' });
        const code = auth.generateCode();
        const ins = await q(
          "insert into email_codes (email, user_id, purpose, code_hash, subject, body, expires_at) " +
          "values ($1, $2, 'bind', $3, $4, $5, now() + interval '5 minutes') returning id",
          [target.email, target.id, auth.hashCode(target.email, code), 'SteamDeals 邮箱验证码', '验证码邮件正文未保存。'],
        );
        try {
          await sendMail(
            { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from: cfg.from, to: target.email,
              subject: 'SteamDeals 邮箱验证码', text: '验证码：' + code + '\n有效期 5 分钟。' },
            { logger },
          );
          await q('update email_codes set sent_ok = true where id = $1', [ins.rows[0].id]);
          logger?.info('api.user_email_code_sent', { username, by: user.username });
          return json(res, 200, { ok: true, hint: '验证码已发送到 ' + target.email });
        } catch (err) {
          await q('update email_codes set sent_ok = false, error = $1 where id = $2', [String(err.message).slice(0, 200), ins.rows[0].id]);
          return json(res, 502, { error: '发送失败：' + String(err.message).slice(0, 160) });
        }
      }

      const bindVerify = path.match(/^\/api\/admin\/users\/([^/]+)\/email\/verify$/);
      if (bindVerify && req.method === 'POST') {
        if (!requireAdmin()) return;
        const auth = await import('./email-auth.js');
        const body = await readBody(req);
        const code = String(body.code ?? '').trim();
        const username = decodeURIComponent(bindVerify[1]);
        const urow = await q('select id, email from users where username = $1', [username]);
        const target = urow.rows[0];
        if (!target) return json(res, 404, { error: '没有该用户' });
        if (!target.email) return json(res, 400, { error: '该用户还没有绑定邮箱' });
        const found = await q(
          "select id, code_hash, attempts, expires_at from email_codes where email = $1 and purpose = 'bind' and used_at is null order by created_at desc limit 1",
          [target.email],
        );
        const row = found.rows[0];
        if (!row) return json(res, 400, { error: '没有可用的验证码，请先发送' });
        if (new Date(row.expires_at).getTime() < Date.now()) return json(res, 400, { error: '验证码已过期，请重新发送' });
        if (row.attempts >= 5) return json(res, 429, { error: '尝试次数过多，请重新发送' });
        if (!auth.verifyCodeHash(target.email, code, row.code_hash)) {
          await q('update email_codes set attempts = attempts + 1 where id = $1', [row.id]);
          return json(res, 400, { error: '验证码不正确' });
        }
        await q('update email_codes set used_at = now() where id = $1', [row.id]);
        await q('update users set email_verified = true where id = $1', [target.id]);
        logger?.info('api.user_email_verified', { username, by: user.username });
        return json(res, 200, { ok: true });
      }

      const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && req.method === 'PATCH') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const username = decodeURIComponent(userMatch[1]);
        const row = await db.updateUser(q, {
          username,
          displayName: body.display_name,
          role: body.role,
          disabled: body.disabled,
        });
        if (!row) return json(res, 404, { error: '没有该用户或没有要改的字段' });
        logger?.info('api.user_updated', { username, by: user.username, ...body });
        return json(res, 200, { user: row });
      }

      const pwdMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
      if (pwdMatch && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const password = String(body.password ?? '');
        if (password.length < 8 || password.length > 200) return json(res, 400, { error: '密码需要 8-200 位' });
        const row = await db.setUserPassword(q, { username: decodeURIComponent(pwdMatch[1]), password });
        if (!row) return json(res, 404, { error: '没有该用户' });
        logger?.info('api.user_password_reset', { username: decodeURIComponent(pwdMatch[1]), by: user.username });
        return json(res, 200, { ok: true });
      }

      // ---- 管理员：禁用游戏 / 编辑说明 / 触发 Steam 同步 ----
      const blockMatch = path.match(/^\/api\/games\/(\d+)\/blocked$/);
      if (blockMatch && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const row = await db.setGameBlocked(q, { steamAppid: Number(blockMatch[1]), blocked: Boolean(body.blocked) });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.game_blocked', { appid: Number(blockMatch[1]), blocked: row.blocked, by: user.username });
        return json(res, 200, { game: row });
      }

      const descMatch = path.match(/^\/api\/games\/(\d+)\/description$/);
      if (descMatch && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const row = await db.setGameDescription(q, {
          steamAppid: Number(descMatch[1]),
          description: String(body.description ?? ''),
          overwrite: Boolean(body.overwrite),
        });
        if (!row) return json(res, 404, { error: '没有该游戏' });
        logger?.info('api.game_description', { appid: Number(descMatch[1]), by: user.username });
        return json(res, 200, { game: row });
      }

      // 一键同步：把动作丢给子进程，避免 HTTP 请求挂几分钟。
      // 记录到 sync_runs（开始/结束/输出尾巴），前端轮询状态显示实时输出。
      if (path === '/api/admin/sync' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const mode = body.mode === 'catalog' ? 'catalog' : 'steamall';
        const args = ['src/cli.js', 'sync', mode];
        if (mode === 'steamall') {
          const limit = Math.min(Math.max(Number(body.limit ?? 200) || 200, 1), 2000);
          const sleep = Math.min(Math.max(Number(body.sleep ?? 2) || 2, 1), 30);
          args.push('--limit', String(limit), '--sleep', String(sleep));
        }
        try {
          const job = await startSteamJob({ mode, args, by: user.username });
          return json(res, 202, { started: true, runId: job.runId, mode, pid: job.pid });
        } catch (err) {
          if (err.code === 'BUSY') return json(res, 409, { error: err.message, run: err.run });
          throw err;
        }
      }

      if (path === '/api/admin/sync/status' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const running = Boolean(syncChild);
        const last = await db.listSyncRuns(q, { limit: 1 }).catch(() => []);
        let schedule = null;
        try {
          const file = process.env.SCHEDULER_STATUS_FILE ?? 'data/scheduler-status.json';
          schedule = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          schedule = null;
        }
        return json(res, 200, {
          running,
          run: running ? syncRun : null,
          output: syncOutput.slice(-6000),
          last: last[0] ?? null,
          schedule,
        });
      }

      if (path === '/api/admin/sync/runs' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const limit = Number(url.searchParams.get('limit') ?? 20);
        return json(res, 200, { runs: await db.listSyncRuns(q, { limit }) });
      }

      // ---- 管理员：数据回填（批量补全量元数据/价格，与同步共用子进程槽位）----
      if (path === '/api/admin/backfill' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const { normalizeBackfillParams, backfillArgs } = await import('./backfill.js');
        const params = normalizeBackfillParams(body);
        try {
          const job = await startSteamJob({ mode: 'backfill', args: backfillArgs(params), params, by: user.username });
          logger?.info('api.backfill_started', { runId: job.runId, by: user.username, ...params });
          return json(res, 202, { started: true, runId: job.runId, pid: job.pid, params });
        } catch (err) {
          if (err.code === 'BUSY') return json(res, 409, { error: err.message, run: err.run });
          throw err;
        }
      }

      if (path === '/api/admin/backfill/stop' && req.method === 'POST') {
        if (!requireAdmin()) return;
        if (!syncChild) return json(res, 409, { error: '当前没有运行中的任务' });
        const child = syncChild;
        const runId = syncRun?.id ?? null;
        syncStopRequested = true;
        child.kill('SIGTERM');
        // 10 秒还没退就强杀，避免卡死子进程一直占着槽位
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
        }, 10000);
        killTimer.unref?.();
        logger?.warn('api.backfill_stop', { runId, pid: child.pid, by: user.username });
        return json(res, 202, { stopping: true, runId, pid: child.pid });
      }

      if (path === '/api/admin/backfill/status' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const { parseBackfillProgress } = await import('./backfill.js');
        const isBackfill = syncRun?.mode === 'backfill';
        const runs = await db.listSyncRuns(q, { limit: 10 }).catch(() => []);
        return json(res, 200, {
          running: Boolean(syncChild) && isBackfill,
          busy: Boolean(syncChild),
          mode: syncRun?.mode ?? null,
          run: syncRun,
          output: syncOutput.slice(-6000),
          progress: isBackfill ? parseBackfillProgress(syncOutput) : null,
          last: runs.find((r) => r.mode === 'backfill') ?? null,
        });
      }

      // ---- 管理员：热度回填（与同步/回填共用子进程槽位，天然互斥）----
      if (path === '/api/admin/heat' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const pickNum = (v, def, min, max) => Math.max(min, Math.min(Number(v ?? def) || def, max));
        const params = {
          limit: pickNum(body.limit, 200000, 1, 200000),
          batch: pickNum(body.batch, 30, 1, 100),
          sleep: pickNum(body.sleep, 1700, 0, 60000),
        };
        try {
          const job = await startSteamJob({
            mode: 'heat',
            args: ['heat', '--limit', String(params.limit), '--batch', String(params.batch), '--sleep', String(params.sleep)],
            params,
            by: user.username,
          });
          logger?.info('api.heat_started', { runId: job.runId, by: user.username, ...params });
          return json(res, 202, { started: true, runId: job.runId, pid: job.pid, params });
        } catch (err) {
          if (err.code === 'BUSY') return json(res, 409, { error: err.message, run: err.run });
          throw err;
        }
      }

      if (path === '/api/admin/heat/stop' && req.method === 'POST') {
        if (!requireAdmin()) return;
        if (!syncChild) return json(res, 409, { error: '当前没有运行中的任务' });
        const child = syncChild;
        const runId = syncRun?.id ?? null;
        syncStopRequested = true;
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
        }, 10000);
        killTimer.unref?.();
        logger?.warn('api.heat_stop', { runId, pid: child.pid, by: user.username });
        return json(res, 202, { stopping: true, runId, pid: child.pid });
      }

      if (path === '/api/admin/heat/status' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const isHeat = syncRun?.mode === 'heat';
        return json(res, 200, {
          running: Boolean(syncChild) && isHeat,
          busy: Boolean(syncChild),
          mode: syncRun?.mode ?? null,
          run: syncRun,
          output: syncOutput.slice(-6000),
        });
      }

      // ---- 管理员：邮箱（SMTP）配置与验证码发送记录 ----
      if (path === '/api/admin/smtp' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const auth = await import('./email-auth.js');
        const cfg = await auth.smtpConfig(q);
        const raw = await q("select from_addr from smtp_settings where id = 1");
        const rawFrom = raw.rows[0] ? String(raw.rows[0].from_addr ?? '') : '';
        return json(res, 200, {
          smtp: {
            source: cfg.source,
            host: cfg.host ?? '',
            port: cfg.port ?? 465,
            secure: cfg.secure !== false,
            user: cfg.user ?? '',
            from: cfg.from ?? '',
            hasPassword: Boolean(cfg.pass),
            ready: auth.isSmtpConfigured(cfg),
          },
        });
      }

      if (path === '/api/admin/smtp' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const auth = await import('./email-auth.js');
        const body = await readBody(req);
        const pass = body.pass ? auth.encryptSecret(String(body.pass), auth.loadSecretKey()) : null;
        // 发件人留空就用账号，保存时就补全，避免后续判断为"未配置"
        const mailUser = String(body.user ?? '').trim();
        const mailFrom = String(body.from ?? '').trim(); // 存原值；留空表示用账号，由读取时兜底
        await q(
          `insert into smtp_settings (id, host, port, secure, username, password_enc, from_addr, enabled, updated_at)
           values (1, $1, $2, $3, $4, $5, $6, $7, now())
           on conflict (id) do update set
             host = excluded.host, port = excluded.port, secure = excluded.secure,
             username = excluded.username,
             password_enc = coalesce($5, smtp_settings.password_enc),
             from_addr = excluded.from_addr, enabled = excluded.enabled, updated_at = now()`,
          [
            String(body.host ?? '').trim(),
            Number(body.port ?? 465),
            body.secure !== false,
            mailUser,
            pass,
            mailFrom,
            body.enabled !== false,
          ],
        );
        logger?.info('api.smtp_saved', { by: user.username, host: String(body.host ?? '').trim() });
        if (store) {
          await settings.hydrateSettings({ store, logger }).catch((err) => {
            logger?.warn('settings.hydrate_failed', { message: String(err.message).slice(0, 160) });
          });
        }
        return json(res, 200, { ok: true });
      }

      if (path === '/api/admin/smtp/test' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const auth = await import('./email-auth.js');
        const { sendMail } = await import('./notify.js');
        const body = await readBody(req);
        const cfg = await auth.smtpConfig(q);
        if (!auth.isSmtpConfigured(cfg)) {
          const missing = [];
          if (!cfg.host) missing.push('主机');
          if (!cfg.from) missing.push('发件人（留空时应回填账号，请再保存一次）');
          logger?.warn('api.smtp_incomplete', { missing, by: user.username });
          return json(res, 400, { error: 'SMTP 配置不完整：缺少 ' + missing.join('、') });
        }
        // 收件人留空时发给发件人自己，前端不用重复填
        const to = String(body.to ?? '').trim() || cfg.from;
        if (!auth.normalizeEmail(to)) return json(res, 400, { error: '收件邮箱不合法' });
        const record = await q(
          "insert into email_codes (email, purpose, code_hash, subject, body, expires_at, sent_ok) " +
          "values ($1, 'test', '-', $2, $3, now(), null) returning id",
          [to, 'SteamDeals 测试邮件', '这是一封测试邮件。收到说明 SMTP 配置可用。'],
        );
        try {
          const result = await sendMail(
            {
              host: cfg.host,
              port: cfg.port,
              secure: cfg.secure,
              user: cfg.user,
              pass: cfg.pass,
              from: cfg.fromRaw,
            effectiveFrom: cfg.from,
              to,
              subject: 'SteamDeals 测试邮件',
              text: '这是一封测试邮件。收到说明 SMTP 配置可用。',
            },
            { logger },
          );
          await q('update email_codes set sent_ok = true where id = $1', [record.rows[0].id]);
          logger?.info('api.smtp_test_ok', { to, by: user.username, steps: result?.steps ?? null });
          return json(res, 200, { ok: true, steps: result?.steps ?? [] });
        } catch (err) {
          const message = String(err.message).slice(0, 200);
          await q('update email_codes set sent_ok = false, error = $1 where id = $2', [message, record.rows[0].id]);
          logger?.warn('api.smtp_test_failed', { message, to, steps: err.steps ?? null });
          return json(res, 502, { error: message, steps: err.steps ?? [] });
        }
      }

      if (path === '/api/admin/emails' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
        const rows = await q(
          'select id, email, purpose, sent_ok, error, ip, subject, body, expires_at, used_at, created_at ' +
          `from email_codes order by created_at desc limit ${limit}`,
        );
        return json(res, 200, { records: rows.rows });
      }

      // ---- 管理员：给用户绑定/解绑登录邮箱 ----
      const bindMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/email$/);
      if (bindMatch && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const auth = await import('./email-auth.js');
        const raw = String(body.email ?? '').trim();
        const email = raw ? auth.normalizeEmail(raw) : null;
        if (raw && !email) return json(res, 400, { error: '邮箱格式不正确' });
        const username = decodeURIComponent(bindMatch[1]);
        const doBind = () =>
          q(
            'update users set email = $1, email_verified = false where username = $2 returning id, username, email, role, disabled',
            [email, username],
          );
        try {
          let r;
          try {
            r = await doBind();
          } catch (err) {
            // 旧库可能缺列：补建后重试一次，避免只报"服务器错误"
            if (String(err.code) === '42703') {
              await q('alter table users add column if not exists email text');
              await q('alter table users add column if not exists email_verified boolean not null default false');
              r = await doBind();
            } else {
              throw err;
            }
          }
          if (!r.rows.length) return json(res, 404, { error: '没有该用户' });
          logger?.info('api.user_email_bound', {
            username,
            email: email ? String(email).replace(/^(.)(.*)(@.*)$/, '$1***$3') : null,
            by: user.username,
          });
          return json(res, 200, { user: r.rows[0] });
        } catch (err) {
          if (String(err.code) === '23505') return json(res, 409, { error: '这个邮箱已被其他账号绑定' });
          logger?.error('api.user_email_bind_failed', {
            username,
            code: err.code ?? null,
            message: String(err.message).slice(0, 200),
            by: user.username,
          });
          return json(res, 500, { error: '绑定失败：' + String(err.message).slice(0, 160) });
        }
      }

      // ---- 管理员：最近日志（排障用；日志层已做脱敏）----
      if (path === '/api/admin/logs' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const fsMod = await import('node:fs');
        const dir = process.env.LOG_DIR ?? 'logs';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000);
        const grep = String(url.searchParams.get('grep') ?? '').trim();
        let files = [];
        try {
          files = fsMod.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
        } catch {
          files = [];
        }
        const picked = files.slice(-5);
        const entries = [];
        for (const f of picked) {
          try {
            const lines = fsMod.readFileSync(dir + '/' + f, 'utf8').split('\n').filter(Boolean);
            for (const line of lines.slice(-limit)) {
              try {
                entries.push(JSON.parse(line));
              } catch {
                entries.push({ msg: line });
              }
            }
          } catch {
            /* 单个文件读失败不影响整体 */
          }
        }
        // 容器启动输出（entrypoint / node 崩溃栈）也一起返回
        try {
          const bootLines = fsMod.readFileSync(dir + '/boot.log', 'utf8').split('\n').filter(Boolean).slice(-limit);
          for (const line of bootLines) {
            entries.push({ ts: new Date().toISOString(), level: /错误|失败|ERROR|Error/.test(line) ? 'warn' : 'info', event: line.slice(0, 300) });
          }
          if (bootLines.length) picked.push("boot.log");
        } catch {
          /* 没有 boot.log 就算了 */
        }

        // 按模块归类：用户 / Steam 同步 / 程序；error 单独一档
        const scopeOf = (e) => {
          const ev = String(e.event || '');
          const job = String(e.job || '');
          if (/^(auth\.|api\.login|api\.logout|api\.user_|api\.me)/.test(ev)) return 'user';
          if (/^(sync\.steamall|sync\.item_failed|import\.steamcatalog|steam\.meta|api\.sync_)/.test(ev) || /^steam/.test(job)) return 'steam';
          return 'app';
        };
        const scope = String(url.searchParams.get('scope') ?? '').trim();
        const minutes = Math.max(0, Number(url.searchParams.get('minutes') ?? 0) || 0);
        // 时间范围：只保留最近 N 分钟的日志（ts 是 ISO 字符串）
        let ranged = entries;
        if (minutes > 0) {
          const cutoff = Date.now() - minutes * 60_000;
          ranged = entries.filter((e) => {
            const ts = e.ts || e.time;
            if (!ts) return false;
            const t = new Date(ts).getTime();
            return Number.isFinite(t) && t >= cutoff;
          });
        }
        const scoped = scope
          ? ranged.filter((e) => (scope === 'error' ? String(e.level || '').toLowerCase() === 'error' : scopeOf(e) === scope))
          : ranged;
        const filtered = grep ? scoped.filter((e) => JSON.stringify(e).includes(grep)) : scoped;
        return json(res, 200, { files: picked, count: filtered.length, entries: filtered.slice(-limit) });
      }

      if (path === '/api/admin/users' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { users: await db.listUsers(q) });
      }

      if (path === '/api/admin/views' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
        const views = await db.viewStats(q, { limit });
        // 把 /game/<appid> 与 /game/id/<id> 解析成游戏名与当前最低价
        const appids = [];
        const ids = [];
        for (const v of views) {
          const byId = /^\/game\/id\/(\d+)$/.exec(v.path);
          const byAppid = /^\/game\/(\d+)$/.exec(v.path);
          if (byId) ids.push(Number(byId[1]));
          else if (byAppid) appids.push(Number(byAppid[1]));
        }
        const map = new Map();
        if (appids.length || ids.length) {
          const rows = await q(
            "select g.id, g.steam_appid, coalesce(g.name, 'appid:' || g.steam_appid) as name, " +
            "(select min(o.price_cents) from offers o where o.game_id = g.id and o.in_stock) as low " +
            "from games g where g.steam_appid = any($1::int[]) or g.id = any($2::int[])",
            [appids, ids],
          );
          for (const g of rows.rows) {
            if (g.steam_appid != null) map.set('a' + g.steam_appid, g);
            map.set('i' + g.id, g);
          }
        }
        const enriched = views.map((v) => {
          const byId = /^\/game\/id\/(\d+)$/.exec(v.path);
          const byAppid = /^\/game\/(\d+)$/.exec(v.path);
          const g = byId ? map.get('i' + byId[1]) : byAppid ? map.get('a' + byAppid[1]) : null;
          return { ...v, name: g ? g.name : null, price: g ? g.low : null };
        });
        return json(res, 200, { views: enriched });
      }

      if (path === '/api/admin/users' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const username = String(body.username ?? '').trim();
        const password = String(body.password ?? '');
        if (!username || password.length < 8 || password.length > 200) {
          return json(res, 400, { error: '用户名必填，密码需要 8-200 位' });
        }
        const created = await db.createUser(q, { username, password, role: body.role === 'admin' ? 'admin' : 'user' });
        logger?.info('api.user_created', { username: created.username, role: created.role });
        return json(res, 201, { user: created });
      }

      // ---- 管理员：访问记录（分页 + 过滤 + 今日汇总）----
      if (path === '/api/admin/visitors' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
        const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize') ?? 20) || 20, 5), 200);
        const ip = String(url.searchParams.get('ip') ?? '').trim();
        const p = String(url.searchParams.get('path') ?? '').trim();
        // filter=visits（默认，正常访问）| blocked（被拦截）| all
        const filter = String(url.searchParams.get('filter') ?? 'visits');
        const list = await db.listVisitorLogs(q, { page, pageSize, ip: ip || null, path: p || null, filter });
        const summary = await db.visitorSummary(q);
        return json(res, 200, { ...list, page, pageSize, filter, pages: Math.max(1, Math.ceil(list.total / pageSize)), summary });
      }

      // ---- 管理员：封面图本地缓存统计 ----
      if (path === '/api/admin/images' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { images: images.imageStats() });
      }

      // ---- 管理员：价格变动报表（涨跌榜 + 按天趋势 + CSV 导出）----
      if (path === '/api/admin/reports/price' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const hours = Number(url.searchParams.get('hours') ?? 24);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
        const days = Number(url.searchParams.get('days') ?? 7);
        return json(res, 200, {
          report: await db.priceChanges(q, { hours, limit }),
          daily: await db.priceChangesByDay(q, { days }),
        });
      }

      if (path === '/api/admin/reports/price.csv' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const hours = Number(url.searchParams.get('hours') ?? 24);
        const rows = await db.priceChangeRows(q, { hours });
        const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const lines = ['appid,name,platform,platform_name,old_price,new_price,drop_pct,captured_at'];
        for (const r of rows) {
          const pct = r.was > 0 ? (((r.was - r.now_price) / r.was) * 100).toFixed(1) : '';
          lines.push([
            r.steam_appid ?? '',
            r.name,
            r.platform,
            r.platform_name,
            (r.was / 100).toFixed(2),
            (r.now_price / 100).toFixed(2),
            pct,
            String(r.captured_at).slice(0, 19).replace('T', ' '),
          ].map(cell).join(','));
        }
        // 带 BOM：Excel 直接打开中文不乱码
        const body = '\uFEFF' + lines.join('\r\n');
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="price-changes.csv"',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }

      // ---- 管理员：IP 黑名单 ----
      if (path === '/api/admin/blacklist' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { ips: await db.listBlockedIps(q) });
      }

      if (path === '/api/admin/blacklist' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const ip = visitors.normalizeBanInput(body.ip);
        if (!ip) return json(res, 400, { error: 'IP 格式不正确（支持 1.2.3.4 单个 IP 或 1.2.3.0/24 网段）' });
        const row = await db.addBlockedIp(q, { ip, note: String(body.note ?? '').trim().slice(0, 200) || null });
        await visitors.refreshBlocklist(q).catch(() => {});
        logger?.info('api.ip_blocked', { ip, by: user.username });
        return json(res, 200, { ip: row });
      }

      const unbanMatch = path.match(/^\/api\/admin\/blacklist\/([^/]+)$/);
      if (unbanMatch && req.method === 'DELETE') {
        if (!requireAdmin()) return;
        const target = decodeURIComponent(unbanMatch[1]);
        const removed = await db.removeBlockedIp(q, target);
        await visitors.refreshBlocklist(q).catch(() => {});
        logger?.info('api.ip_unblocked', { ip: target, removed, by: user.username });
        return json(res, 200, { removed });
      }

      // ---- 管理员：白名单（不受频率限制与黑名单影响）----
      if (path === '/api/admin/whitelist' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { ips: await db.listWhitelist(q), config: ratelimit.currentConfig() });
      }

      if (path === '/api/admin/whitelist' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const ip = visitors.normalizeBanInput(body.ip);
        if (!ip) return json(res, 400, { error: 'IP 格式不正确（支持 1.2.3.4 或 1.2.3.0/24）' });
        const row = await db.addWhitelistIp(q, { ip, note: String(body.note ?? '').trim().slice(0, 200) || null });
        ratelimit.addWhitelist(ip);
        logger?.info('api.ip_whitelisted', { ip, by: user.username });
        return json(res, 200, { ip: row });
      }

      const wlMatch = path.match(/^\/api\/admin\/whitelist\/([^/]+)$/);
      if (wlMatch && req.method === 'DELETE') {
        if (!requireAdmin()) return;
        const target = decodeURIComponent(wlMatch[1]);
        const removed = await db.removeWhitelistIp(q, target);
        ratelimit.removeWhitelist(target);
        logger?.info('api.ip_whitelist_removed', { ip: target, removed, by: user.username });
        return json(res, 200, { removed });
      }

      // ---- 管理员：超频/临时封禁记录 + 手动解封 ----
      if (path === '/api/admin/abuse' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, {
          abuse: await db.listAbuse(q, { limit: Number(url.searchParams.get('limit') ?? 50) }),
          config: ratelimit.currentConfig(),
        });
      }

      const abuseUnban = path.match(/^\/api\/admin\/abuse\/([^/]+)$/);
      if (abuseUnban && req.method === 'DELETE') {
        if (!requireAdmin()) return;
        const target = decodeURIComponent(abuseUnban[1]);
        const removed = await ratelimit.unban(q, target);
        await visitors.refreshBlocklist(q).catch(() => {});
        logger?.info('api.abuse_unbanned', { ip: target, removed, by: user.username });
        return json(res, 200, { removed });
      }

      // ---- 管理员：站点公告 ----
      if (path === '/api/admin/announcements' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200) || 200, 1), 200);
        return json(res, 200, { announcements: await db.listAnnouncements(q, { limit }) });
      }
      if (path === '/api/admin/announcements' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const title = String(body.title ?? '').trim().slice(0, 120);
        const text = String(body.body ?? '').trim().slice(0, 4000);
        if (!title || !text) return json(res, 400, { error: '标题和内容不能为空' });
        const row = await db.createAnnouncement(q, {
          title,
          body: text,
          level: ['info', 'warning', 'critical'].includes(body.level) ? body.level : 'info',
          active: body.active !== false,
          startsAt: toIso(body.startsAt),
          endsAt: toIso(body.endsAt),
          createdBy: user.id,
        });
        logger?.info('announcement.created', { id: row.id, by: user.username });
        return json(res, 200, { announcement: row });
      }
      const annMatch = path.match(/^\/api\/admin\/announcements\/(\d+)$/);
      if (annMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const title = String(body.title ?? '').trim().slice(0, 120);
        const text = String(body.body ?? '').trim().slice(0, 4000);
        if (!title || !text) return json(res, 400, { error: '标题和内容不能为空' });
        const row = await db.updateAnnouncement(q, Number(annMatch[1]), {
          title,
          body: text,
          level: ['info', 'warning', 'critical'].includes(body.level) ? body.level : 'info',
          active: body.active !== false,
          startsAt: toIso(body.startsAt),
          endsAt: toIso(body.endsAt),
        });
        if (!row) return json(res, 404, { error: '公告不存在' });
        logger?.info('announcement.updated', { id: row.id, by: user.username });
        return json(res, 200, { announcement: row });
      }
      if (annMatch && req.method === 'DELETE') {
        if (!requireAdmin()) return;
        const removed = await db.deleteAnnouncement(q, Number(annMatch[1]));
        logger?.info('announcement.deleted', { id: Number(annMatch[1]), removed, by: user.username });
        return json(res, 200, { removed });
      }

      // ---- 管理员：设备指纹与设备封禁 ----
      if (path === '/api/admin/devices' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { devices: await db.listDevices(q, { limit: Number(url.searchParams.get('limit') ?? 100) }) });
      }
      if (path === '/api/admin/device-bans' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { bans: await db.listDeviceBans(q, { limit: 200 }) });
      }
      if (path === '/api/admin/devices/ban' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const fingerprint = String(body.fingerprint ?? '').trim().toLowerCase();
        if (!/^[a-f0-9]{32,64}$/.test(fingerprint)) return json(res, 400, { error: 'fingerprint 不合法' });
        const minutes = Number(body.minutes);
        const permanent = body.permanent === true || !Number.isFinite(minutes) || minutes <= 0;
        const until = permanent ? null : new Date(Date.now() + minutes * 60_000).toISOString();
        const row = await db.upsertDeviceBan(q, {
          fingerprint,
          deviceId: devices.normalizeDeviceId(body.deviceId),
          note: body.note,
          until,
        });
        await devices.loadBans(q).catch(() => {});
        logger?.info('device.banned', { fingerprint: fingerprint.slice(0, 16), by: user.username, until });
        return json(res, 200, { ban: row });
      }
      const devBanMatch = path.match(/^\/api\/admin\/device-bans\/([a-f0-9]{16,64})$/);
      if (devBanMatch && req.method === 'DELETE') {
        if (!requireAdmin()) return;
        const removed = await db.removeDeviceBan(q, devBanMatch[1]);
        await devices.loadBans(q).catch(() => {});
        logger?.info('device.unbanned', { fingerprint: devBanMatch[1].slice(0, 16), removed, by: user.username });
        return json(res, 200, { removed });
      }

      // ---- 管理员：异常请求审核（不自动封，审批后才封 IP / 设备）----
      if (path === '/api/admin/reviews' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const status = String(url.searchParams.get('status') ?? 'pending');
        const reviews = await db.listAbuseReviews(q, { status, limit: Number(url.searchParams.get('limit') ?? 300) });
        return json(res, 200, { reviews, pending: await db.countPendingReviews(q) });
      }
      if (path === '/api/admin/reviews/approve' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const review = await db.getAbuseReview(q, Number(body.id));
        if (!review || review.status !== 'pending') return json(res, 404, { error: '审核记录不存在或已处理' });
        const mode = ['ip', 'device', 'both'].includes(body.mode) ? body.mode : 'ip';
        let bannedIp = false;
        let bannedDevice = false;
        if ((mode === 'ip' || mode === 'both') && review.ip) {
          await db.addBlockedIp(q, { ip: review.ip, note: `审核通过（${review.rule}）by ${user.username}` });
          await visitors.refreshBlocklist(q).catch(() => {});
          bannedIp = true;
        }
        if ((mode === 'device' || mode === 'both') && review.fingerprint) {
          await db.upsertDeviceBan(q, {
            fingerprint: review.fingerprint,
            deviceId: review.device_id,
            note: `审核通过（${review.rule}）by ${user.username}`,
          });
          await devices.loadBans(q).catch(() => {});
          bannedDevice = true;
        }
        await db.finishAbuseReview(q, Number(body.id), { status: 'approved', reviewedBy: user.id, note: body.note });
        logger?.info('abuse.review_approved', {
          id: Number(body.id),
          mode,
          ip: review.ip,
          fingerprint: (review.fingerprint || '').slice(0, 16),
          by: user.username,
        });
        return json(res, 200, { ok: true, bannedIp, bannedDevice });
      }
      if (path === '/api/admin/reviews/reject' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const row = await db.finishAbuseReview(q, Number(body.id), { status: 'rejected', reviewedBy: user.id, note: body.note });
        if (!row) return json(res, 404, { error: '审核记录不存在' });
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      logger?.error('api.error', { path, message: String(err.message).slice(0, 200) });
      return json(res, 500, { error: '服务器错误' });
    }
  });

  return server;
}

/** 访问记录过滤：静态资源与图片代理不记，页面与 API 必记。 */
function isLoggablePath(path) {
  if (path === '/favicon.ico') return false;
  // 前台轮询用的轻量指纹接口：每 10 秒一次，记访问日志只会污染统计
  if (path === '/api/games/stamp') return false;
  // 控制台轮询类接口：只用于刷新 UI，记进访问日志只会让统计虚高
  if (path === '/api/admin/sync/status' || path === '/api/admin/sync/runs') return false;
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|map|woff2?|ttf|otf|eot|json|xml|txt|md)$/i.test(path)) return false;
  if (path.startsWith('/img/')) return false;
  return true;
}

/** 基础安全响应头：防嗅探、防点击劫持、限制 referrer 与权限。 */
function applySecurityHeaders(req, res) {
  try {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    const proto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
    const https = proto === 'https' || Boolean(req.socket?.encrypted);
    if (https) res.setHeader('strict-transport-security', 'max-age=15552000; includeSubDomains');
  } catch {
    /* 头部设置失败不影响请求 */
  }
}

/** 会话 Cookie：HTTPS 时加 Secure（本地 http 调试不受影响）。 */
function serveStatic(res, outDir, pathname) {
  if (!outDir) {
    res.writeHead(404).end('not found');
    return;
  }
  let clean = pathname;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (clean === '/') clean = '/index.html';
  if (clean === '/console' || clean === '/console/') clean = '/console.html';
  if (clean === '/setup' || clean === '/setup/') clean = '/setup.html';
  const root = resolve(outDir);
  const file = resolve(root, `.${clean}`);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
  });
  res.end(body);
}

/** Vue 构建产物负责站点所有页面；无构建产物时回退到 web 目录。 */
function serveFrontendStatic(res, frontendDir, outDir, pathname) {
  if (!frontendDir || !existsSync(resolve(frontendDir, 'index.html'))) return serveStatic(res, outDir, pathname);
  if (['/', '/console', '/console/', '/setup', '/setup/', '/banned', '/banned/', '/appeal', '/appeal/', '/index.html', '/console.html', '/setup.html', '/banned.html'].includes(pathname)) {
    return serveStatic(res, frontendDir, '/index.html');
  }
  if (pathname.startsWith('/assets/')) return serveStatic(res, frontendDir, pathname);
  return serveStatic(res, outDir, pathname);
}

function isFrontendAsset(pathname) {
  return /^\/assets\/[A-Za-z0-9._/-]+\.(?:js|css)$/.test(pathname);
}

export function startApiServer({
  query,
  logger = null,
  outDir = null,
  frontendDir = null,
  port = 8090,
  host = '0.0.0.0',
  store = null,
  setupToken = '',
  getSetupState = null,
  imageFetch = null,
}) {
  const server = createApiServer({ query, logger, outDir, frontendDir, store, setupToken, getSetupState, imageFetch });
  // 黑名单定时刷新（管理端增删后也会即时刷新；unref 不阻止进程退出）
  const blockTimer = setInterval(() => {
    visitors.refreshBlocklist(query).catch(() => {});
    devices.loadBans(query).catch(() => {});
    ratelimit.loadState(query).catch((err) => logger?.warn('rate.refresh_failed', { message: String(err.message).slice(0, 120) }));
  }, 60_000);
  blockTimer.unref?.();
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, async () => {
      server.removeListener('error', fail);
      try {
        await visitors.refreshBlocklist(query);
      } catch (err) {
        logger?.warn('block.init_failed', { message: String(err.message).slice(0, 120) });
      }
      try {
        // 频率限制与白名单：内存计数 + 启动时从库里回填白名单/未到期封禁
        ratelimit.configure({
          enabled: process.env.RATE_LIMIT_ENABLED !== '0',
          max: Number(process.env.RATE_LIMIT_MAX ?? 60),
          assetMax: Number(process.env.RATE_LIMIT_ASSET_MAX ?? 300),
          windowSec: Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60),
        });
        const loaded = await ratelimit.loadState(query);
        logger?.info('rate.init', { ...ratelimit.currentConfig(), ...loaded });
      } catch (err) {
        logger?.warn('rate.init_failed', { message: String(err.message).slice(0, 120) });
      }
      try {
        // 路径守卫：只记录待审核，不自动封禁
        guard.configure({
          enabled: process.env.PATH_REVIEW_ENABLED !== '0',
          unknownMax: Number(process.env.PATH_REVIEW_UNKNOWN_MAX ?? 30),
          unknownWindowSec: Number(process.env.PATH_REVIEW_UNKNOWN_WINDOW_SEC ?? 600),
        });
        logger?.info('guard.init', { ...guard.currentConfig(), outDir: outDir ? resolve(outDir) : null });
      } catch (err) {
        logger?.warn('guard.init_failed', { message: String(err.message).slice(0, 120) });
      }
      try {
        // 设备封禁缓存：只有管理员审批后才会存在；启动回填 + 60s 刷新
        const loaded = await devices.loadBans(query);
        logger?.info('device.init', loaded);
      } catch (err) {
        logger?.warn('device.init_failed', { message: String(err.message).slice(0, 120) });
      }
      try {
        // 服务重启后残留的 running 记录标失败，避免同步按钮永远禁用
        await db.markStaleSyncRuns(query);
      } catch {
        /* 表未建（老库）时忽略 */
      }
      const address = server.address();
      logger?.info('api.listen', { host, port: address.port, outDir: outDir ? resolve(outDir) : null });
      done({
        server,
        port: address.port,
        host,
        close: () => new Promise((r) => {
          clearInterval(blockTimer);
          server.close(r);
        }),
      });
    });
  });
}

export { join };
