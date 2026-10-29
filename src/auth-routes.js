// 邮箱验证码相关路由：发送验证码、校验登录/重置密码。
// 单独成模块，避免把 server.js 的主 handler 越堆越长。
//
// 日志策略（用户要求"部署后靠日志定位"）：
//   auth.otp_requested  发码请求（邮箱脱敏、用途、结果）
//   auth.otp_failed     发码失败（原因：smtp 未配置 / 发送异常 / 频率限制）
//   auth.otp_verified   校验成功（登录或改密）
//   auth.otp_rejected   校验失败（过期/未找到/次数超限/码错误）
import {
  generateCode,
  hashCode,
  verifyCodeHash,
  normalizeEmail,
  checkRateLimit,
  checkIpRateLimit,
  checkGlobalDailyLimit,
  SEND_DAILY_GLOBAL_LIMIT,
  smtpConfig,
  isSmtpConfigured,
  CODE_TTL_SEC,
  CODE_MAX_ATTEMPTS,
} from './email-auth.js';
import { sendMail } from './notify.js';
import { clientIp } from './visitors.js';
import { sessionCookie } from './session-cookie.js';

export function maskEmail(email) {
  const v = String(email ?? '');
  const at = v.indexOf('@');
  if (at <= 0) return '***';
  const name = v.slice(0, at);
  const keep = name.length <= 2 ? 1 : 2;
  return `${name.slice(0, keep)}***${v.slice(at)}`;
}

/** 返回 true 表示这个请求已被本模块处理。 */
export async function handleEmailAuth({ path, req, res, q, logger, json, readBody }) {
  if (req.method !== 'POST') return false;

  // ---------------- 发送验证码 ----------------
  if (path === '/api/auth/email/request') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const purpose = body.purpose === 'reset' ? 'reset' : 'login';
    if (!email) {
      json(res, 400, { error: '邮箱格式不正确' });
      return true;
    }

    const recent = await q(
      'select created_at, sent_ok from email_codes where email = $1 order by created_at desc limit 20',
      [email],
    );
    const limit = checkRateLimit(recent.rows);
    if (!limit.ok) {
      logger?.warn('auth.otp_failed', {
        email: maskEmail(email),
        purpose,
        reason: limit.reason,
        retryAfterSec: limit.retryAfterSec,
      });
      json(res, 429, {
        error: limit.reason === 'cooldown' ? `请 ${limit.retryAfterSec} 秒后再试` : '发送过于频繁，请稍后再试',
        retryAfterSec: limit.retryAfterSec,
      });
      return true;
    }

    // 防止拿同一台机器换着邮箱轰炸：按来源 IP 限流 + 全站每日上限
    const senderIp = clientIp(req);
    const ipRecent = await q(
      "select created_at, sent_ok from email_codes where ip = $1 and created_at > now() - interval '1 hour' order by created_at desc limit 50",
      [senderIp],
    );
    const ipLimit = checkIpRateLimit(ipRecent.rows);
    if (!ipLimit.ok) {
      logger?.warn('auth.otp_ip_limited', { ip: senderIp, reason: ipLimit.reason, retryAfterSec: ipLimit.retryAfterSec });
      json(res, 429, { error: '这个网络发送验证码太频繁，请稍后再试', retryAfterSec: ipLimit.retryAfterSec });
      return true;
    }
    const dailyCount = (await q(
      "select count(*)::int as n from email_codes where sent_ok is not false and created_at > now() - interval '1 day'",
    )).rows[0]?.n ?? 0;
    const dailyLimit = checkGlobalDailyLimit(dailyCount);
    if (!dailyLimit.ok) {
      logger?.warn('auth.otp_daily_limited', { count: dailyCount, limit: SEND_DAILY_GLOBAL_LIMIT });
      json(res, 429, { error: '今天系统发信量已达上限，请明天再试或联系管理员' });
      return true;
    }

    const cfg = await smtpConfig(q);
    if (!isSmtpConfigured(cfg)) {
      logger?.warn('auth.otp_failed', { purpose, reason: 'smtp_not_configured' });
      json(res, 503, { error: '系统还没有配置发信邮箱，请联系管理员' });
      return true;
    }

    const userRow = await q('select id, username, disabled, email_verified from users where email = $1', [email]);
    const target = userRow.rows[0] ?? null;
    if (!target || target.disabled || target.email_verified !== true) {
      logger?.warn('auth.otp_failed', {
        email: maskEmail(email), purpose,
        reason: !target ? 'email_not_bound' : target.disabled ? 'user_disabled' : 'email_unverified',
      });
      json(res, 200, { ok: true, hint: '如果邮箱已绑定且可用，验证码将发送到该邮箱' });
      return true;
    }

    const code = generateCode();
    const subject = purpose === 'reset' ? 'SteamDeals 重置密码验证码' : 'SteamDeals 登录验证码';
    const text =
      `你的验证码是：${code}\n` +
      `用途：${purpose === 'reset' ? '重置密码' : '登录'}\n` +
      `有效期：${Math.round(CODE_TTL_SEC / 60)} 分钟，用完即失效。\n` +
      '如果不是你本人操作，请忽略这封邮件。';
    const inserted = await q(
      `insert into email_codes (email, user_id, purpose, code_hash, subject, body, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)
       returning id`,
      [email, target.id, purpose, hashCode(email, code), subject, '验证码邮件正文未保存。', String(CODE_TTL_SEC)],
    );
    const id = inserted.rows[0].id;

    try {
      await sendMail(
        {
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          user: cfg.user,
          pass: cfg.pass,
          from: cfg.from,
          to: email,
          subject,
          text,
        },
        { logger },
      );
      await q('update email_codes set sent_ok = true where id = $1', [id]);
      logger?.info('auth.otp_requested', { email: maskEmail(email), purpose, sent: true });
      json(res, 200, { ok: true, hint: '如果邮箱已绑定且可用，验证码将发送到该邮箱' });
    } catch (err) {
      const message = String(err.message).slice(0, 200);
      await q('update email_codes set sent_ok = false, error = $1 where id = $2', [message, id]);
      logger?.error('auth.otp_failed', { email: maskEmail(email), purpose, reason: 'send_error', message });
      json(res, 200, { ok: true, hint: '如果邮箱已绑定且可用，验证码将发送到该邮箱' });
    }
    return true;
  }

  // ---------------- 校验验证码 ----------------
  if (path === '/api/auth/email/verify') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const code = String(body.code ?? '').trim();
    const purpose = body.purpose === 'reset' ? 'reset' : 'login';
    if (!email || !/^\d{6}$/.test(code)) {
      json(res, 400, { error: '邮箱或验证码格式不正确' });
      return true;
    }

    const found = await q(
      `select id, user_id, code_hash, attempts, expires_at, used_at
         from email_codes
        where email = $1 and purpose = $2 and used_at is null
        order by created_at desc limit 1`,
      [email, purpose],
    );
    const row = found.rows[0];
    if (!row) {
      logger?.warn('auth.otp_rejected', { email: maskEmail(email), purpose, reason: 'no_code' });
      json(res, 400, { error: '没有可用的验证码，请重新获取' });
      return true;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      logger?.warn('auth.otp_rejected', { email: maskEmail(email), purpose, reason: 'expired' });
      json(res, 400, { error: '验证码已过期，请重新获取' });
      return true;
    }
    if (row.attempts >= CODE_MAX_ATTEMPTS) {
      logger?.warn('auth.otp_rejected', { email: maskEmail(email), purpose, reason: 'too_many_attempts' });
      json(res, 429, { error: '尝试次数过多，请重新获取验证码' });
      return true;
    }
    if (!verifyCodeHash(email, code, row.code_hash)) {
      await q('update email_codes set attempts = attempts + 1 where id = $1', [row.id]);
      logger?.warn('auth.otp_rejected', { email: maskEmail(email), purpose, reason: 'wrong_code', attempts: row.attempts + 1 });
      json(res, 400, { error: '验证码不正确' });
      return true;
    }

    const resetPassword = purpose === 'reset' ? String(body.password ?? '') : null;
    if (purpose === 'reset' && (resetPassword.length < 8 || resetPassword.length > 200)) {
      json(res, 400, { error: '新密码需要 8-200 位' });
      return true;
    }

    // 校验通过：立刻作废，防止重放
    await q('update email_codes set used_at = now() where id = $1', [row.id]);

    if (purpose === 'reset') {
      const { setUserPassword } = await import('./store/pg.js');
      const updated = await setUserPassword(q, { username: null, userId: row.user_id, password: resetPassword });
      logger?.info('auth.otp_verified', { email: maskEmail(email), purpose: 'reset', ok: Boolean(updated) });
      json(res, 200, { ok: true, message: '密码已重置，请用新密码登录' });
      return true;
    }

    const userRow = await q('select id, username, role, disabled from users where id = $1', [row.user_id]);
    const account = userRow.rows[0];
    if (!account || account.disabled) {
      logger?.warn('auth.otp_rejected', { email: maskEmail(email), purpose, reason: 'account_unavailable' });
      json(res, 403, { error: '账号不可用' });
      return true;
    }
    const { createSession } = await import('./store/pg.js');
    const token = await createSession(q, { userId: account.id });
    logger?.info('auth.otp_verified', { email: maskEmail(email), purpose: 'login', username: account.username });
    json(
      res,
      200,
      { user: { id: account.id, username: account.username, role: account.role } },
      { 'set-cookie': sessionCookie(req, token, 604800) },
    );
    return true;
  }

  return false;
}
