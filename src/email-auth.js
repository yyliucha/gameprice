// 邮箱验证码登录 / 找回密码的核心逻辑（纯函数 + 少量 SQL 封装）。
//
// 安全设计：
//   · 验证码只存哈希（sha256(salt+code)），库泄露也拿不到验证码
//   · 5 分钟过期、一次性使用、最多试 5 次
//   · 同邮箱 60 秒内只能发一次；每小时最多 5 次
//   · SMTP 密码用 AES-256-GCM 加密存储，密钥来自 SECRET_KEY 环境变量
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CODE_TTL_SEC = 300; // 5 分钟
export const CODE_MAX_ATTEMPTS = 5;
export const SEND_COOLDOWN_SEC = 60;
export const SEND_HOURLY_LIMIT = 5;

/** 生成 6 位数字验证码（避免前导零被吞）。 */
export function generateCode(randomInt = (n) => randomBytes(4).readUInt32BE(0) % n) {
  return String(100000 + randomInt(900000));
}

/** 验证码哈希：邮箱 + 验证码 + 盐，防止库内比对/彩虹表。 */
export function hashCode(email, code, salt = randomBytes(16).toString('hex')) {
  const digest = createHash('sha256').update(`${String(email).toLowerCase()}|${salt}|${code}`).digest('hex');
  return `${salt}:${digest}`;
}

export function verifyCodeHash(email, code, stored) {
  const [salt, digest] = String(stored ?? '').split(':');
  if (!salt || !digest) return false;
  const candidate = createHash('sha256').update(`${String(email).toLowerCase()}|${salt}|${code}`).digest('hex');
  return candidate === digest;
}

export function normalizeEmail(email) {
  const v = String(email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** 频率限制：返回 { ok, reason, retryAfterSec }。records 按时间倒序。 */
export function checkRateLimit(records, nowMs = Date.now()) {
  const list = (records ?? []).filter((r) => r.created_at);
  const recent = list
    .map((r) => ({ at: new Date(r.created_at).getTime(), ok: r.sent_ok !== false }))
    .filter((r) => r.ok)
    .sort((a, b) => b.at - a.at);
  if (!recent.length) return { ok: true };
  const last = recent[0].at;
  if (nowMs - last < SEND_COOLDOWN_SEC * 1000) {
    return { ok: false, reason: 'cooldown', retryAfterSec: Math.ceil((SEND_COOLDOWN_SEC * 1000 - (nowMs - last)) / 1000) };
  }
  const hourly = recent.filter((r) => nowMs - r.at < 3600 * 1000).length;
  if (hourly >= SEND_HOURLY_LIMIT) return { ok: false, reason: 'hourly_limit', retryAfterSec: 3600 };
  return { ok: true };
}

// ---------------------------------------------------------------- SMTP 密码加密

const KEY_SALT = 'steamdeals-smtp-v1';

/**
 * 取加密密钥：优先环境变量，其次 data/secret.key（首次自动生成并持久化）。
 * 这样后台配 SMTP 不需要用户先敲命令设 SECRET_KEY。
 */
export function loadSecretKey({ env = process.env, file = 'data/secret.key' } = {}) {
  if (typeof env.SECRET_KEY === 'string' && env.SECRET_KEY.length >= 16) return env.SECRET_KEY;
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* 文件不存在，下面创建 */
  }
  const generated = randomBytes(32).toString('base64url');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
  } catch {
    /* 只读环境：退回内存密钥（重启后旧密码解不开，会提示重新填写） */
  }
  return generated;
}

export function hasSecretKey(env = process.env) {
  return typeof env.SECRET_KEY === 'string' && env.SECRET_KEY.length >= 16;
}

function keyFrom(secret) {
  return scryptSync(String(secret), KEY_SALT, 32);
}

/** AES-256-GCM 加密，返回 base64(iv|tag|cipher)。 */
export function encryptSecret(plain, secret) {
  if (!plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload, secret) {
  if (!payload) return null;
  const buf = Buffer.from(String(payload), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------- 建表（幂等）

export const EMAIL_SCHEMA = `
create table if not exists email_codes (
  id bigserial primary key,
  email text not null,
  user_id integer references users(id) on delete set null,
  purpose text not null default 'login',
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  sent_ok boolean,
  error text,
  ip text,
  subject text,
  body text,
  created_at timestamptz not null default now()
);
create index if not exists email_codes_email_idx on email_codes (email, created_at desc);
create table if not exists smtp_settings (
  id integer primary key default 1,
  host text,
  port integer default 465,
  secure boolean default true,
  username text,
  password_enc text,
  from_addr text,
  enabled boolean default false,
  updated_at timestamptz default now()
);
`;

export async function ensureEmailSchema(store) {
  await store.exec(EMAIL_SCHEMA);
  // 老库补列：邮件内容（主题/正文）是后来加的，管理员要能直接看到验证码
  await store.exec('alter table email_codes add column if not exists subject text');
  await store.exec('alter table email_codes add column if not exists body text');
  await store.exec('alter table users add column if not exists email text');
  await store.exec('alter table users add column if not exists email_verified boolean not null default false');
  await store.exec('create unique index if not exists users_email_uniq on users (email) where email is not null');
}

/** 清理过期邮件记录（正文含明文验证码，定期清掉；默认保留 3 天）。 */
export async function purgeOldCodes(q, { days = 3 } = {}) {
  const r = await q("delete from email_codes where created_at < now() - ($1 || ' days')::interval", [String(days)]);
  return r.rowCount ?? 0;
}

/** 取一个可用的 SMTP 配置：数据库优先，没配则回退环境变量。 */
export async function smtpConfig(q, env = process.env) {
  const r = await q('select host, port, secure, username, password_enc, from_addr, enabled from smtp_settings where id = 1');
  const row = r.rows[0];
  if (row?.enabled && row.host) {
    let pass = null;
    if (row.password_enc) {
      try {
        // 密钥优先环境变量，否则用自动生成的 data/secret.key
        pass = decryptSecret(row.password_enc, loadSecretKey({ env }));
      } catch {
        pass = null;
      }
    }
    return {
      source: 'database',
      host: row.host,
      port: Number(row.port ?? 465),
      secure: row.secure !== false,
      user: row.username ?? '',
      pass: pass ?? '',
      // 发件人留空时回退到账号：注意空字符串不能用 ?? 兜底
      fromRaw: String(row.from_addr ?? '').trim(),
      from: String(row.from_addr ?? '').trim() || String(row.username ?? '').trim(),
    };
  }
  const envPass = env.SMTP_PASS ?? '';
  return {
    source: 'env',
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT ?? 465),
    secure: String(env.SMTP_SECURE ?? '1') !== '0',
    user: env.SMTP_USER ?? '',
    pass: envPass,
    fromRaw: String(env.SMTP_FROM ?? '').trim(),
    from: String(env.SMTP_FROM ?? '').trim() || String(env.SMTP_USER ?? '').trim(),
  };
}

export function isSmtpConfigured(cfg) {
  return Boolean(cfg?.host && cfg?.from);
}
