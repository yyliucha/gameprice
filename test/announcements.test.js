// 站点公告：DB 过滤（启用/时间窗口）+ 管理接口增改删 + 公开接口只看生效中的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';

const WEB = fileURLToPath(new URL('../web', import.meta.url));
process.env.TRUST_PROXY = '1';
process.env.CAPTCHA_ENABLED = '0';

test('公告过滤：停用 / 未开始 / 已过期都不出现在 activeOnly 里', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  try {
    await db.createAnnouncement(q, { title: '现在', body: '正文', active: true });
    await db.createAnnouncement(q, { title: '停用', body: '正文', active: false });
    await db.createAnnouncement(q, { title: '未来', body: '正文', active: true, startsAt: new Date(Date.now() + 3600_000) });
    await db.createAnnouncement(q, { title: '过期', body: '正文', active: true, endsAt: new Date(Date.now() - 3600_000) });

    const active = await db.listAnnouncements(q, { activeOnly: true });
    assert.equal(active.length, 1);
    assert.equal(active[0].title, '现在');
    assert.equal((await db.listAnnouncements(q, {})).length, 4);
  } finally {
    await store.close();
  }
});

test('公告接口：管理员增改删，公开接口只返回生效中的', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
  const srv = await startApiServer({
    query: q,
    outDir: WEB,
    port: 0,
    host: '127.0.0.1',
    getSetupState: async () => ({ completed: true }),
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const headers = { 'x-forwarded-for': '203.0.113.77' };
  try {
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const admin = { cookie, ...headers };

    const created = await fetch(base + '/api/admin/announcements', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...admin },
      body: JSON.stringify({ title: '维护通知', body: '今晚 23:00 维护', level: 'warning', active: true }),
    });
    assert.equal(created.status, 200);
    const id = (await created.json()).announcement.id;

    let pub = await (await fetch(base + '/api/announcements', { headers })).json();
    assert.equal(pub.announcements.length, 1);
    assert.equal(pub.announcements[0].title, '维护通知');

    const patched = await fetch(base + '/api/admin/announcements/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: JSON.stringify({ title: '维护通知', body: '改期', level: 'critical', active: false }),
    });
    assert.equal(patched.status, 200);
    pub = await (await fetch(base + '/api/announcements', { headers })).json();
    assert.equal(pub.announcements.length, 0, '停用后公开接口不再返回');

    const del = await fetch(base + '/api/admin/announcements/' + id, { method: 'DELETE', headers: admin });
    assert.equal(del.status, 200);
    assert.equal((await db.listAnnouncements(q, {})).length, 0);

    const anonymous = await fetch(base + '/api/admin/announcements', { headers });
    assert.equal(anonymous.status, 401, '未登录不能管理公告');
  } finally {
    await srv.close();
    await store.close();
  }
});
