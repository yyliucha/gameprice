// 首次初始化 API：建管理员 + 写设置 + 标记完成，全部在一个事务里。
//
// 这个模块只在 /setup 未完成时可用；完成后所有接口都会 403/404。
import * as db from './store/pg.js';
import * as settings from './settings.js';
import { normalizeEmail } from './email-auth.js';

const jsonError = (json, res, status, message) => json(res, status, { error: message });

function validateAdmin(admin) {
  const username = String(admin?.username ?? '').trim();
  const password = String(admin?.password ?? '');
  if (!/^[^\s/]{3,32}$/.test(username)) {
    throw Object.assign(new Error('管理员用户名需要 3-32 个字符，且不能包含空格或斜杠'), { status: 400 });
  }
  if (password.length < 8) {
    throw Object.assign(new Error('管理员密码至少 8 位'), { status: 400 });
  }
  if (password.length > 200) {
    throw Object.assign(new Error('管理员密码过长'), { status: 400 });
  }
  const rawEmail = String(admin?.email ?? '').trim();
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !email) throw Object.assign(new Error('管理员邮箱格式不正确'), { status: 400 });
  return { username, password, email };
}

function tokenFrom(req, body) {
  return String(req.headers['x-setup-token'] ?? body?.setupToken ?? '');
}

function requireToken(setupToken, req, body) {
  if (!setupToken) return;
  if (!settings.safeEqual(tokenFrom(req, body), setupToken)) {
    throw Object.assign(new Error('初始化口令不正确'), { status: 401 });
  }
}

async function statusPayload(q, store, setupToken) {
  let completed = await settings.isSetupComplete(q, { fresh: true });
  const admins = await settings.countAdmins(q);
  // 兼容：管理员已经通过 CLI 创建，但 setup.completed 还没写（老库/运行中手工建号）
  if (!completed && admins > 0) {
    await settings.markSetupComplete(q, { by: 'migration:existing_admin' });
    settings.resetSettingsCache();
    completed = true;
  }
  return {
    completed,
    hasAdmin: admins > 0,
    setupTokenRequired: Boolean(setupToken),
    version: settings.VERSION,
    database: store?.kind ?? null,
    setup: await settings.setupInfo(q),
  };
}

/**
 * 处理 /api/setup/*。返回 true 表示已经处理（调用方不要再走正常路由）。
 */
export async function handleSetupRoutes({
  path,
  req,
  res,
  q,
  store,
  logger = null,
  json,
  readBody,
  setupToken = '',
  cookieName = 'gp_session',
}) {
  if (!path.startsWith('/api/setup/')) return false;
  if (!store) return jsonError(json, res, 503, '当前进程没有可写数据库连接'), true;

  try {
    if (path === '/api/setup/status' && req.method === 'GET') {
      return json(res, 200, await statusPayload(q, store, setupToken)), true;
    }

    if (path === '/api/setup/schema' && req.method === 'GET') {
      const completed = await settings.isSetupComplete(q, { fresh: true });
      if (completed) return jsonError(json, res, 409, '系统已经初始化完成'), true;
      const publicView = await settings.getPublicSettings(q);
      return (
        json(res, 200, {
          ...publicView,
          setupTokenRequired: Boolean(setupToken),
        }),
        true
      );
    }

    if (path === '/api/setup/complete' && req.method === 'POST') {
      if (await settings.isSetupComplete(q, { fresh: true })) {
        return jsonError(json, res, 409, '系统已经初始化完成，请直接登录'), true;
      }
      if (await settings.hasAdmin(q)) {
        await settings.markSetupComplete(q, { by: 'migration:existing_admin' });
        return jsonError(json, res, 409, '已经存在管理员，请直接登录控制台'), true;
      }

      const body = (await readBody(req)) ?? {};
      requireToken(setupToken, req, body);
      const admin = validateAdmin(body.admin);
      const patch = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : {};
      const secretKey = settings.secretKeyFor();

      const created = await store.tx(async (tx) => {
        if ((await settings.countAdmins(tx)) > 0) {
          throw Object.assign(new Error('已经存在管理员，请直接登录控制台'), { status: 409 });
        }
        const user = await db.createUser(tx, { username: admin.username, password: admin.password, role: 'admin' });
        if (admin.email) {
          await tx('update users set email = $1, email_verified = false where id = $2', [admin.email, user.id]);
        }
        await settings.saveSettings(tx, patch, { updatedBy: admin.username, secretKey });
        await settings.markSetupComplete(tx, { by: admin.username });
        const session = await db.createSession(tx, { userId: user.id });
        return { user, session };
      });

      settings.resetSettingsCache();
      await settings.hydrateSettings({ store, logger, secretKey }).catch((err) => {
        logger?.warn('setup.hydrate_failed', { message: String(err.message).slice(0, 200) });
      });
      logger?.info('setup.completed', {
        username: created.user.username,
        email: admin.email ? admin.email.replace(/^(.)(.*)(@.*)$/, '$1***$3') : null,
        settings: Object.keys(patch).length,
      });

      return (
        json(
          res,
          200,
          {
            ok: true,
            user: { id: created.user.id, username: created.user.username, role: created.user.role },
            redirect: '/console',
          },
          {
            'set-cookie': `${cookieName}=${created.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          },
        ),
        true
      );
    }

    if (path.startsWith('/api/setup/')) {
      return jsonError(json, res, 404, 'not found'), true;
    }
    return false;
  } catch (err) {
    const message = String(err.message ?? '');
    const status =
      Number(err.status) ||
      (message === 'invalid json' || message === 'body too large' ? 400 : String(err.code) === '23505' ? 409 : 500);
    if (status >= 500) logger?.error('setup.error', { path, message: message.slice(0, 200) });
    return jsonError(json, res, status, status >= 500 ? '初始化失败：' + message.slice(0, 160) : err.message), true;
  }
}
