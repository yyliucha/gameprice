// 设置层：默认值、密钥加密、env 兜底/导入、初始化状态、事务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import * as settings from '../src/settings.js';
import { channelsFromEnv } from '../src/notify.js';

const SECRET = 'test-secret-key-0123456789abcdef';

async function fresh() {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  await settings.ensureSettingsSchema(store);
  const { ensureEmailSchema } = await import('../src/email-auth.js');
  await ensureEmailSchema(store);
  settings.resetSettingsCache();
  const q = (sql, p) => store.query(sql, p);
  return { store, q };
}

test('设置定义完整：51 项、7 个密钥、关键分组都在', () => {
  assert.equal(settings.SETTINGS.length, 51);
  assert.equal(settings.SETTINGS.filter((d) => d.secret).length, 7);
  const tz = settings.SETTINGS.find((d) => d.key === 'system.timezone');
  assert.ok(tz, '要有 system.timezone（时区设置化）');
  assert.equal(tz.default, 'Asia/Shanghai');
  assert.equal(tz.env, 'TZ');
  const keys = settings.SETTINGS.map((d) => d.key);
  for (const key of [
    'sources.itad.apiKey',
    'sources.steam.enabled',
    'sources.gog.regions',
    'alerts.smtp.host',
    'alerts.emailTo',
    'network.steamProxy',
    'system.circuitThreshold',
    'system.logLevel',
  ]) {
    assert.ok(keys.includes(key), `缺少 ${key}`);
  }
  assert.equal(new Set(keys).size, keys.length, 'key 不能重复');
});

test('默认值 + 密钥加密：库里不存明文，公开接口只给 hasValue', async () => {
  const { store, q } = await fresh();
  try {
    const defaults = await settings.readSettings(q, { env: {}, secretKey: SECRET });
    assert.equal(defaults.values['sources.steam.enabled'], true);
    assert.equal(defaults.values['sources.itad.apiKey'], '');
    assert.equal(defaults.values['system.chartOnSync'], false);
    assert.equal(defaults.sources['sources.itad.apiKey'], 'default');

    const saved = await settings.saveSettings(
      q,
      {
        'sources.itad.apiKey': 'itad-key-123456',
        'sources.steam.enabled': false,
        'sources.gog.regions': 'cn,us',
        'alerts.emailTo': 'A@b.com, c@d.com',
      },
      { secretKey: SECRET, updatedBy: 'tester' },
    );
    assert.equal(saved.changed, true);
    assert.ok(saved.revision >= 1);

    const raw = await q("select key, value, secret_enc from app_settings where key = 'sources.itad.apiKey'");
    assert.equal(raw.rows[0].value, null, '密钥不能以 jsonb 明文落库');
    assert.ok(raw.rows[0].secret_enc, '密钥应加密存储');

    const publicView = await settings.getPublicSettings(q, { secretKey: SECRET });
    assert.equal(publicView.values['sources.itad.apiKey'], '');
    assert.equal(publicView.secrets['sources.itad.apiKey'].hasValue, true);
    assert.equal(publicView.values['sources.steam.enabled'], false);
    assert.equal(publicView.values['sources.gog.regions'], 'cn,us');
    assert.equal(publicView.values['alerts.emailTo'], 'a@b.com,c@d.com');

    const read = await settings.readSettings(q, { secretKey: SECRET });
    assert.equal(read.values['sources.itad.apiKey'], 'itad-key-123456');
    assert.equal(read.sources['sources.itad.apiKey'], 'database');
  } finally {
    await store.close();
  }
});

test('环境变量兜底：DB 未写入时读 env，写入后 DB 优先', async () => {
  const { store, q } = await fresh();
  try {
    const env = { ITAD_API_KEY: 'env-key-12345678', STEAM_ENABLED: '0', GOG_REGIONS: 'cn,jp' };
    const before = await settings.readSettings(q, { env, secretKey: SECRET });
    assert.equal(before.values['sources.itad.apiKey'], 'env-key-12345678');
    assert.equal(before.values['sources.steam.enabled'], false);
    assert.equal(before.sources['sources.itad.apiKey'], 'env');
    assert.equal(before.sources['sources.steam.enabled'], 'env');

    await settings.saveSettings(q, { 'sources.itad.apiKey': 'db-key-12345678' }, { env, secretKey: SECRET });
    const after = await settings.readSettings(q, { env, secretKey: SECRET });
    assert.equal(after.values['sources.itad.apiKey'], 'db-key-12345678');
    assert.equal(after.sources['sources.itad.apiKey'], 'database');
    assert.equal(after.values['sources.steam.enabled'], false, '未落库的项仍用 env');
  } finally {
    await store.close();
  }
});

test('水合：把库值写回 env，SMTP 关闭时清空 SMTP_HOST', async () => {
  const { store, q } = await fresh();
  try {
    await settings.saveSettings(
      q,
      {
        'sources.steam.enabled': false,
        'sources.gog.regions': 'us',
        'alerts.emailTo': 'x@y.com',
        'alerts.smtp.host': 'smtp.example.com',
        'alerts.smtp.user': 'u@example.com',
        'alerts.smtp.pass': 'pass-123456',
      },
      { env: {}, secretKey: SECRET },
    );
    const env = { SMTP_HOST: 'old.example.com', SMTP_USER: 'old', SMTP_PASS: 'old', SECRET_KEY: SECRET };
    await settings.hydrateSettings({ store, env, secretKey: SECRET });
    assert.equal(env.STEAM_ENABLED, '0');
    assert.equal(env.GOG_REGIONS, 'us');
    assert.equal(env.ALERT_EMAIL_TO, 'x@y.com');
    assert.equal(env.SMTP_HOST, 'smtp.example.com');
    assert.equal(env.SMTP_USER, 'u@example.com');
    assert.equal(env.SMTP_PASS, 'pass-123456');
    assert.equal(env.SMTP_FROM, 'u@example.com', '发件人留空回退到账号');
  } finally {
    await store.close();
  }
});

test('初始化状态：没有管理员时未完成；已有管理员时自动迁移完成', async () => {
  const { store, q } = await fresh();
  try {
    const env = { DATABASE_URL: 'pglite:', ITAD_API_KEY: 'legacy-key-123456' };
    const first = await settings.initializeSettings({ store, env: { ...env }, secretKey: SECRET });
    assert.equal(first.completed, false);
    assert.equal(first.migrated, false);
    assert.equal(await settings.isSetupComplete(q, { fresh: true }), false);

    await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
    settings.resetSettingsCache();
    const second = await settings.initializeSettings({ store, env: { ...env }, secretKey: SECRET });
    assert.equal(second.completed, true);
    assert.equal(second.migrated, true);
    assert.equal(await settings.isSetupComplete(q, { fresh: true }), true);
    const info = await settings.setupInfo(q);
    assert.equal(info.completedBy, 'migration:existing_admin');

    const read = await settings.readSettings(q, { env: {}, secretKey: SECRET });
    assert.equal(read.values['sources.itad.apiKey'], 'legacy-key-123456');
    assert.equal(read.sources['sources.itad.apiKey'], 'database', '老 .env 应导入数据库');
  } finally {
    await store.close();
  }
});

test('SMTP 特殊存储：写 smtp_settings，不写 app_settings', async () => {
  const { store, q } = await fresh();
  try {
    await settings.saveSettings(
      q,
      {
        'alerts.smtp.host': 'smtp.qq.com',
        'alerts.smtp.port': 465,
        'alerts.smtp.secure': true,
        'alerts.smtp.user': 'u@qq.com',
        'alerts.smtp.pass': 'auth-code',
        'alerts.smtp.from': 'u@qq.com',
      },
      { env: {}, secretKey: SECRET },
    );
    const row = (await q('select host, port, secure, username, password_enc, from_addr, enabled from smtp_settings where id = 1')).rows[0];
    assert.equal(row.host, 'smtp.qq.com');
    assert.equal(row.enabled, true);
    assert.ok(row.password_enc);
    const plain = await q("select count(*)::int as n from app_settings where key like 'alerts.smtp.%'");
    assert.equal(plain.rows[0].n, 0, 'SMTP 不应重复写 app_settings');

    const read = await settings.readSettings(q, { env: {}, secretKey: SECRET });
    assert.equal(read.smtp.enabled, true);
    assert.equal(read.smtp.pass, 'auth-code');
    assert.equal(read.values['alerts.smtp.pass'], 'auth-code');
  } finally {
    await store.close();
  }
});

test('SMTP 落库后水合：alerts 能识别邮件通道；停用后不再识别', async () => {
  const { store, q } = await fresh();
  try {
    await settings.saveSettings(
      q,
      {
        'alerts.smtp.host': 'smtp.example.com',
        'alerts.smtp.user': 'u@example.com',
        'alerts.smtp.pass': 'auth-code',
        'alerts.emailTo': 'a@example.com',
      },
      { env: {}, secretKey: SECRET },
    );
    const env = {};
    await settings.hydrateSettings({ store, env, secretKey: SECRET });
    const channels = channelsFromEnv(env);
    assert.equal(channels.length, 1);
    assert.equal(channels[0].kind, 'email');
    assert.equal(channels[0].pass, 'auth-code');

    // 清空 host = 停用邮件；水合必须把 env 里的 SMTP_HOST 清掉，否则 alerts 会误判
    await settings.saveSettings(q, { 'alerts.smtp.host': '' }, { env: {}, secretKey: SECRET });
    await settings.hydrateSettings({ store, env, secretKey: SECRET });
    assert.equal(channelsFromEnv(env).length, 0);
    assert.equal(env.SMTP_HOST, '');
  } finally {
    await store.close();
  }
});

test('事务：回调抛错时整体回滚', async () => {
  const { store, q } = await fresh();
  try {
    await assert.rejects(
      store.tx(async (tx) => {
        await tx("insert into app_meta (key, value) values ('tx.rollback', '1')");
        throw new Error('boom');
      }),
      /boom/,
    );
    const row = await q("select value from app_meta where key = 'tx.rollback'");
    assert.equal(row.rows.length, 0);
  } finally {
    await store.close();
  }
});
