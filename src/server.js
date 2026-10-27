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
      // ---- 管理员：游戏列表（含同步状态）----
      if (path === '/api/admin/games' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const kw = String(url.searchParams.get('q') ?? '').trim();
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 1000);
        const rows = await q(
          "select g.id, g.steam_appid, coalesce(g.name, 'appid:' || g.steam_appid) as name, g.name_en, g.blocked, g.updated_at, " +
          "(g.description is not null and g.description <> '') as has_desc, " +
          "(select count(*) from offers o where o.game_id = g.id) as offer_count, " +
          "(select min(o.price_cents) from offers o where o.game_id = g.id and o.platform_code = 'steam' and o.in_stock) as steam_price " +
          "from games g " +
          "where ($1 = '' or lower(coalesce(g.name, '')) like lower('%' || $1 || '%') or lower(coalesce(g.name_en, '')) like lower('%' || $1 || '%') or cast(g.steam_appid as text) = $1) " +
          "order by g.updated_at desc nulls last, g.id desc limit $2",
          [kw, limit],
        );
        return json(res, 200, { total: rows.rows.length, games: rows.rows });
      }

      // ---- 管理员：验证邮箱归属（发码 / 校验）----      // ---- 管理员：验证邮箱归属（发码 / 校验）----
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
          "insert into email_codes (email, user_id, purpose, code_hash, expires_at) values ($1, $2, 'bind', $3, now() + interval '5 minutes') returning id",
          [target.email, target.id, auth.hashCode(target.email, code)],
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
        if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
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

      // 一键同步：把动作丢给子进程，避免 HTTP 请求挂几分钟
      if (path === '/api/admin/sync' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['src/cli.js', 'sync', 'steamall'], {
          stdio: 'ignore',
          detached: true,
        });
        child.unref();
        logger?.info('api.sync_steam_started', { by: user.username, pid: child.pid });
        return json(res, 202, { started: true, pid: child.pid, hint: '后台同步已开始，看 logs/ 或稍后刷新列表' });
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
          "insert into email_codes (email, purpose, code_hash, expires_at, sent_ok) values ($1, 'test', '-', now(), null) returning id",
          [to],
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
        const rows = await q(
          'select email, purpose, sent_ok, error, ip, created_at from email_codes order by created_at desc limit 50',
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

        const filtered = grep ? entries.filter((e) => JSON.stringify(e).includes(grep)) : entries;
        return json(res, 200, { files: picked, count: filtered.length, entries: filtered.slice(-limit) });
      }

      if (path === '/api/admin/users' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return json(res, 200, { users: await db.listUsers(q) });
      }

      if (path === '/api/admin/views' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const views = await db.viewStats(q, { limit: 50 });
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
