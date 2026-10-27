import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import {
  generateCode,
  hashCode,
  verifyCodeHash,
  normalizeEmail,
  checkRateLimit,
  encryptSecret,
  decryptSecret,
  ensureEmailSchema,
  smtpConfig,
  isSmtpConfigured,
  CODE_TTL_SEC,
  SEND_COOLDOWN_SEC,
  SEND_HOURLY_LIMIT,
} from '../src/email-auth.js';

test('验证码：6 位数字，范围合法', () => {
  for (let i = 0; i < 20; i += 1) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
    assert.ok(Number(code) >= 100000 && Number(code) <= 999999);
  }
  assert.equal(CODE_TTL_SEC, 300, '验证码 5 分钟有效');
});

test('验证码哈希：加盐、可校验、不含明文', () => {
  const stored = hashCode('A@Example.com', '123456');
  assert.notEqual(stored, hashCode('A@Example.com', '123456'), '每次盐不同');
  assert.equal(verifyCodeHash('a@example.com', '123456', stored), true, '邮箱不区分大小写');
  assert.equal(verifyCodeHash('a@example.com', '123457', stored), false);
  assert.equal(verifyCodeHash('a@example.com', '123456', 'garbage'), false);
  assert.ok(!stored.includes('123456'), '不能出现明文');
});

test('邮箱规范化：合法/非法', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail(''), null);
});

test('频率限制：冷却 60 秒、每小时 5 次、失败不占额度', () => {
  const now = Date.UTC(2026, 9, 27, 1, 0, 0);
  assert.equal(checkRateLimit([], now).ok, true);

  const justSent = [{ created_at: new Date(now - 5000).toISOString(), sent_ok: true }];
  const cooled = checkRateLimit(justSent, now);
  assert.equal(cooled.ok, false);
  assert.equal(cooled.reason, 'cooldown');
  assert.ok(cooled.retryAfterSec > 0 && cooled.retryAfterSec <= SEND_COOLDOWN_SEC);

  const hourly = Array.from({ length: SEND_HOURLY_LIMIT }, (_, i) => ({
    created_at: new Date(now - (SEND_COOLDOWN_SEC + 1 + i * 60) * 1000).toISOString(),
    sent_ok: true,
  }));
  assert.equal(checkRateLimit(hourly, now).reason, 'hourly_limit');

  const failed = [{ created_at: new Date(now - 1000).toISOString(), sent_ok: false }];
  assert.equal(checkRateLimit(failed, now).ok, true);
});

test('SMTP 密码加密：AES-GCM 往返，错误密钥解不开', () => {
  const secret = 'a-very-long-secret-key-123';
  const enc = encryptSecret('smtp-pass', secret);
  assert.ok(!enc.includes('smtp-pass'));
  assert.equal(decryptSecret(enc, secret), 'smtp-pass');
  assert.throws(() => decryptSecret(enc, 'wrong-secret-key-000'));
  assert.equal(encryptSecret('', secret), null);
});

test('SMTP 配置：数据库优先，未配置回退环境变量', async () => {
  const env = {
    SMTP_HOST: 'smtp.env.com',
    SMTP_PORT: '587',
    SMTP_SECURE: '0',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_FROM: 'f@x.com',
  };
  const none = await smtpConfig(async () => ({ rows: [] }), env);
  assert.equal(none.source, 'env');
  assert.equal(none.host, 'smtp.env.com');
  assert.equal(none.port, 587);
  assert.equal(none.secure, false);

  const secret = 'x'.repeat(20);
  const dbRow = {
    host: 'smtp.db.com',
    port: 465,
    secure: true,
    username: 'dbu',
    password_enc: encryptSecret('dbpass', secret),
    from_addr: 'db@x.com',
    enabled: true,
  };
  const fromDb = await smtpConfig(async () => ({ rows: [dbRow] }), { ...env, SECRET_KEY: secret });
  assert.equal(fromDb.source, 'database');
  assert.equal(fromDb.pass, 'dbpass', '有 SECRET_KEY 时能解开密码');

  assert.equal(isSmtpConfigured({ host: 'h', from: 'f' }), true);
  assert.equal(isSmtpConfigured({ host: '', from: '' }), false);
});

test('建表：email_codes / smtp_settings 与 users.email', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    await ensureEmailSchema(store);
    await ensureEmailSchema(store);
    const t = await store.query(
      "select table_name from information_schema.tables where table_schema='public' and table_name in ('email_codes','smtp_settings')",
    );
    assert.equal(t.rows.length, 2);
    const cols = await store.query(
      "select column_name from information_schema.columns where table_name='users' and column_name='email'",
    );
    assert.equal(cols.rows.length, 1);
  } finally {
    await store.close();
  }
});
