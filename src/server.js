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
export function createApiServer({ query, logger = null, outDir = null }) {
  const q = query;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE] ?? null;

    try {
      // 静态资源（页面本身仍由 chart 生成，这里只发文件）
      if (!path.startsWith('/api/')) {
        return serveStatic(res, outDir, path);
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

      // ---- 登录 / 登出 ----
      if (path === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
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
          { 'set-cookie': `${COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` },
        );
      }

      if (path === '/api/logout' && req.method === 'POST') {
        await db.deleteSession(q, token);
        return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
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

      // ---- 游戏列表（匿名可读）----
      if (path === '/api/games' && req.method === 'GET') {
        const interest = url.searchParams.get('interest') ?? 'all';
        const ownedParam = url.searchParams.get('owned') ?? 'exclude';
        const blockedParam = url.searchParams.get('blocked') ?? 'exclude';
        const sort = url.searchParams.get('sort') ?? 'discount';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
        const rows = await db.gameOverview(q, { region: url.searchParams.get('region') ?? 'cn', limit });
        const filtered = rows.filter((g) => {
          if (blockedParam === 'exclude' && g.blocked === true) return false;
          if (blockedParam === 'only' && g.blocked !== true) return false;
          if (ownedParam === 'exclude' && g.owned === true) return false;
          if (ownedParam === 'only' && g.owned !== true) return false;
          if (interest === 'on') return g.interested !== false;
          if (interest === 'off') return g.interested === false;
          return true;
        });
        return json(res, 200, { games: sortGames(filtered, sort), total: rows.length, sort, owned: ownedParam });
      }

      // ---- 单个游戏（匿名可读）----
      // ---- 单个游戏（按内部 id，用于没有 Steam appid 的杉果游戏）----
      const byIdMatch = path.match(/^\/api\/games\/by-id\/(\d+)$/);
      if (byIdMatch && req.method === 'GET') {
        const id = Number(byIdMatch[1]);
        const rows = await db.gameOverview(q, { region: url.searchParams.get('region') ?? 'cn', limit: 500 });
        const game = rows.find((g) => Number(g.id) === id);
        if (!game) return json(res, 404, { error: '没有该游戏' });
        const offers = await db.offersOfGame(q, { gameId: game.id, region: 'cn' });
        const series = await db.dailyMinSeries(q, { gameId: game.id, region: 'cn' });
        if (user) await db.recordView(q, { userId: user.id, path: `/game/id/${id}`, appid: game.steam_appid ?? null });
        return json(res, 200, { game, offers, series });
      }

      const gameMatch = path.match(/^\/api\/games\/(\d+)$/);
      if (gameMatch && req.method === 'GET') {
        const appid = Number(gameMatch[1]);
        const rows = await db.gameOverview(q, { region: url.searchParams.get('region') ?? 'cn', limit: 500 });
        const game = rows.find((g) => Number(g.steam_appid) === appid);
        if (!game) return json(res, 404, { error: '没有该游戏' });
        const offers = await db.regionOffers(q, { steamAppid: appid });
        const series = await db.dailyMinSeries(q, { gameId: game.id, region: 'cn' });
        if (user) await db.recordView(q, { userId: user.id, path: `/game/${appid}`, appid });
        return json(res, 200, { game, offers, series });
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

      // ---- 管理员：用户管理（编辑 / 改密码 / 禁用）----
      // ---- 管理员：验证邮箱归属（发码 / 校验）----
      const bindCode = path.match(/^\/api\/admin\/users\/([^/]+)\/email\/code$/);
      if (bindCode && req.method === 'POST') {
        if (!requireAdmin()) return;
        const auth = await import('./email-auth.js');
        const { sendMail } = await import('./notify.js');
        const username = decodeURIComponent(bindCode[1]);
        const urow = await q('select id, username, email, email_verified from users where username = $1', [username]);
        const target = urow.rows[0];
        if (!target) return json(res, 404, { error: '没有该用户' });
        if (!target.email) return json(res, 400, { error: '该用户还没有绑定邮箱' });
        const cfg = await auth.smtpConfig(q);
        if (!auth.isSmtpConfigured(cfg)) return json(res, 503, { error: 'SMTP 未配置，无法发送验证邮件' });
        const code = auth.generateCode();
        const ins = await q(
          "insert into email_codes (email, user_id, purpose, code_hash, expires_at) values ($1, $2, 'bind', $3, now() + interval '5 minutes') returning id",
          [target.email, target.id, auth.hashCode(target.email, code)],
        );
        try {
          await sendMail(
            { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass, from: cfg.from, to: target.email,
              subject: 'SteamDeals 邮箱验证码', text: '验证码：' + code + '\n有效期 5 分钟，用于验证该邮箱属于 ' + target.username + '。' },
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

      if (path === '/api/admin/users' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { users: await db.listUsers(q) });
      }

      if (path === '/api/admin/views' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { views: await db.viewStats(q, { limit: 50 }) });
      }

      if (path === '/api/admin/users' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readBody(req);
        const username = String(body.username ?? '').trim();
        const password = String(body.password ?? '');
        if (!username || password.length < 6) {
          return json(res, 400, { error: '用户名必填，密码至少 6 位' });
        }
        const created = await db.createUser(q, { username, password, role: body.role === 'admin' ? 'admin' : 'user' });
        logger?.info('api.user_created', { username: created.username, role: created.role });
        return json(res, 201, { user: created });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      logger?.error('api.error', { path, message: String(err.message).slice(0, 200) });
      return json(res, 500, { error: '服务器错误' });
    }
  });

  return server;
}

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

export function startApiServer({ query, logger = null, outDir = null, port = 8090, host = '0.0.0.0' }) {
  const server = createApiServer({ query, logger, outDir });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.removeListener('error', fail);
      const address = server.address();
      logger?.info('api.listen', { host, port: address.port, outDir: outDir ? resolve(outDir) : null });
      done({ server, port: address.port, host, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export { join };
