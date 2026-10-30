// 首次初始化流程：未完成前拦截、/setup 页面、原子建管理员、完成后放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import * as settings from '../src/settings.js';
import { startApiServer } from '../src/server.js';

const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url));
const SECRET = 'setup-test-secret-0123456789abcdef';
process.env.SECRET_KEY = SECRET;

async function boot({ setupToken = '' } = {}) {
  process.env.SECRET_KEY = SECRET;
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  await (await import('../src/email-auth.js')).ensureEmailSchema(store);
  await settings.ensureSettingsSchema(store);
  settings.resetSettingsCache();
  const q = (sql, p) => store.query(sql, p);
  await settings.initializeSettings({ store, env: {}, secretKey: SECRET });
  const srv = await startApiServer({
    query: q,
    outDir: WEB_DIR,
    port: 0,
    host: '127.0.0.1',
    store,
    setupToken,
    getSetupState: async () => ({ completed: await settings.isSetupComplete(q) }),
  });
  return { store, q, srv, base: `http://127.0.0.1:${srv.port}` };
}

const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0];

async function postJson(base, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { res, json };
}

test('未初始化：页面 302 到 /setup，API 返回 428，/setup 可访问', async () => {
  const { store, srv, base } = await boot();
  try {
    const home = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/setup');

    const api = await fetch(base + '/api/games');
    assert.equal(api.status, 428);
    assert.equal((await api.json()).setupRequired, true);

    const setup = await fetch(base + '/setup');
    assert.equal(setup.status, 200);
    assert.match(await setup.text(), /初始化系统/);

    // 初始化页也要有标签图标：favicon 被 302 成 HTML 的话浏览器只能显示白板
    for (const [icon, type] of [
      ['/favicon.svg', 'image/svg+xml'],
      ['/favicon.ico', 'image/x-icon'],
      ['/apple-touch-icon.png', 'image/png'],
    ]) {
      const res = await fetch(base + icon);
      assert.equal(res.status, 200, `${icon} 初始化前也要能取到`);
      assert.equal(res.headers.get('content-type'), type);
      assert.ok((await res.arrayBuffer()).byteLength > 0);
    }

    const status = await (await fetch(base + '/api/setup/status')).json();
    assert.equal(status.completed, false);
    assert.equal(status.hasAdmin, false);
    assert.ok(status.version);

    const schema = await (await fetch(base + '/api/setup/schema')).json();
    assert.equal(schema.fields.length, 51);
    assert.ok(schema.fields.some((f) => f.key === 'sources.itad.apiKey'));
    assert.equal(schema.values['sources.itad.apiKey'], '', '初始化页不能回显密钥');
  } finally {
    await srv.close();
    await store.close();
  }
});

test('完成初始化：建管理员 + 写设置 + 建会话，随后页面/API 放行', async () => {
  const { store, q, srv, base } = await boot();
  try {
    const out = await postJson(base, '/api/setup/complete', {
      admin: { username: 'admin', password: 'admin123456', email: 'admin@example.com' },
      settings: {
        'sources.itad.apiKey': 'itad-key-12345678',
        'sources.steam.enabled': false,
        'alerts.emailTo': 'a@example.com',
      },
    });
    assert.equal(out.res.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.user.username, 'admin');
    assert.equal(out.json.user.role, 'admin');
    assert.equal(out.json.redirect, '/console');
    const cookie = cookieOf(out.res);
    assert.ok(cookie.startsWith('gp_session='));

    const home = await fetch(base + '/', { headers: { cookie } });
    assert.equal(home.status, 200);

    const api = await fetch(base + '/api/games', { headers: { cookie } });
    assert.equal(api.status, 200);

    const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
    assert.equal(me.user.username, 'admin');

    const setupAgain = await postJson(base, '/api/setup/complete', {
      admin: { username: 'admin2', password: 'admin123456' },
    });
    assert.equal(setupAgain.res.status, 409, '完成后不能再次初始化');

    const adminSettings = await (await fetch(base + '/api/admin/settings', { headers: { cookie } })).json();
    assert.equal(adminSettings.values['sources.steam.enabled'], false);
    assert.equal(adminSettings.values['sources.itad.apiKey'], '', '管理员接口也不回显密钥');
    assert.equal(adminSettings.secrets['sources.itad.apiKey'].hasValue, true);

    const raw = await q("select secret_enc from app_settings where key = 'sources.itad.apiKey'");
    assert.ok(raw.rows[0].secret_enc, '密钥必须加密落库');

    const status = await (await fetch(base + '/api/setup/status')).json();
    assert.equal(status.completed, true);
    assert.equal(status.hasAdmin, true);

    const setupPage = await fetch(base + '/setup', { headers: { cookie }, redirect: 'manual' });
    assert.equal(setupPage.status, 302, '完成后 /setup 应跳回首页');
  } finally {
    await srv.close();
    await store.close();
  }
});

test('SETUP_TOKEN：没有口令 401，带口令通过', async () => {
  const { store, srv, base } = await boot({ setupToken: 's3cret-token' });
  try {
    const status = await (await fetch(base + '/api/setup/status')).json();
    assert.equal(status.setupTokenRequired, true);

    const bad = await postJson(base, '/api/setup/complete', {
      admin: { username: 'admin', password: 'admin123456' },
      setupToken: 'wrong',
    });
    assert.equal(bad.res.status, 401);

    const ok = await postJson(base, '/api/setup/complete', {
      admin: { username: 'admin', password: 'admin123456' },
      setupToken: 's3cret-token',
    });
    assert.equal(ok.res.status, 200, JSON.stringify(ok.json));
  } finally {
    await srv.close();
    await store.close();
  }
});

test('老部署已有管理员：启动即视为初始化完成，不拦截', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    await (await import('../src/email-auth.js')).ensureEmailSchema(store);
    const q = (sql, p) => store.query(sql, p);
    await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
    settings.resetSettingsCache();
    const initialized = await settings.initializeSettings({ store, env: {}, secretKey: SECRET });
    assert.equal(initialized.completed, true);
    assert.equal(initialized.migrated, true);

    const srv = await startApiServer({
      query: q,
      outDir: WEB_DIR,
      port: 0,
      host: '127.0.0.1',
      store,
      getSetupState: async () => ({ completed: await settings.isSetupComplete(q) }),
    });
    try {
      const home = await fetch(`http://127.0.0.1:${srv.port}/`);
      assert.equal(home.status, 200, '老部署不能被拦到 /setup');
    } finally {
      await srv.close();
    }
  } finally {
    await store.close();
  }
});
