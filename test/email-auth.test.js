import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';

// 测试里关掉登录验证码
process.env.CAPTCHA_ENABLED = '0';
import {
  generateCode,
  hashCode,
  verifyCodeHash,
  normalizeEmail,
  checkRateLimit,
  checkIpRateLimit,
  checkGlobalDailyLimit,
  SEND_IP_HOURLY_LIMIT,
  SEND_DAILY_GLOBAL_LIMIT,
  encryptSecret,
  decryptSecret,
  ensureEmailSchema,
  purgeOldCodes,
  smtpConfig,
  isSmtpConfigured,
  CODE_TTL_SEC,
  SEND_COOLDOWN_SEC,
  SEND_HOURLY_LIMIT,
} from '../src/email-auth.js';

/** 起一个假 SMTP 服务器，记录收到的每一行命令与邮件正文。 */
function startFakeSmtp({ authCode = 235 } = {}) {
  const state = { commands: [], data: '' };
  const server = net.createServer((socket) => {
    socket.write('220 fake ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        state.commands.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            state.data += `${line}\r\n`;
          }
          continue;
        }
        if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n');
        else if (/^AUTH PLAIN/i.test(line)) socket.write(`${authCode} auth result\r\n`);
        else if (/^MAIL FROM/i.test(line)) socket.write('250 2.1.0 Ok\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write('250 2.1.5 Ok\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

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
    const mailCols = await store.query(
      "select column_name from information_schema.columns where table_name='email_codes' and column_name in ('subject','body')",
    );
    assert.equal(mailCols.rows.length, 2, 'email_codes 要有 subject/body（管理员查看邮件内容用）');
  } finally {
    await store.close();
  }
});

test('发码后邮件内容落库：正文含验证码且可哈希校验，管理员接口可读，过期可清理', async () => {
  const { server: smtp, port } = await startFakeSmtp();
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    await ensureEmailSchema(store);
    const q = (sql, p) => store.query(sql, p);
    await db.createUser(q, { username: 'alice', password: 'alice123456' });
    await q("update users set email = 'alice@example.com', email_verified = true where username = 'alice'");
    await q(
      "insert into smtp_settings (id, host, port, secure, username, from_addr, enabled) values (1, '127.0.0.1', $1, false, 's@x.com', 's@x.com', true)",
      [port],
    );
    await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });

    const srv = await startApiServer({ query: q, port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(`${base}/api/auth/email/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', purpose: 'login' }),
      });
      assert.equal(res.status, 200, JSON.stringify(await res.text()));

      const row = (await q('select id, subject, body, code_hash from email_codes order by id desc limit 1')).rows[0];
      assert.equal(row.subject, 'SteamDeals 登录验证码');
      const code = /(\d{6})/.exec(row.body ?? '')?.[1];
      assert.ok(code, '正文里要有 6 位验证码');
      assert.equal(verifyCodeHash('alice@example.com', code, row.code_hash), true, '正文里的验证码能通过哈希校验');

      // 管理员接口能看到主题/正文，直接提供验证码给收不到邮件的用户
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const emails = await (await fetch(`${base}/api/admin/emails`, { headers: { cookie } })).json();
      assert.equal(emails.records[0].body, row.body);
      assert.equal(emails.records[0].subject, 'SteamDeals 登录验证码');

      // 清理：3 天前的记录被删（正文含明文验证码，不能久留）
      await q("update email_codes set created_at = now() - interval '4 days'");
      const purged = await purgeOldCodes(q, { days: 3 });
      assert.equal(purged, 1);
    } finally {
      await srv.close();
    }
  } finally {
    await store.close();
    smtp.close();
  }
});

test('发信限流：单 IP 每小时上限与全站每日上限', () => {
  const now = Date.now();
  const many = Array.from({ length: SEND_IP_HOURLY_LIMIT }, () => ({ created_at: new Date(now - 1000).toISOString(), sent_ok: true }));
  const ipLimited = checkIpRateLimit(many, now);
  assert.equal(ipLimited.ok, false);
  assert.equal(ipLimited.reason, 'ip_hourly_limit');
  assert.equal(checkIpRateLimit(many.slice(0, 3), now).ok, true);

  assert.equal(checkGlobalDailyLimit(SEND_DAILY_GLOBAL_LIMIT).ok, false);
  assert.equal(checkGlobalDailyLimit(SEND_DAILY_GLOBAL_LIMIT - 1).ok, true);
});