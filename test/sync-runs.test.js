// 手动同步任务记录：落库生命周期、中断标记、状态/记录接口权限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';

// 测试里关掉登录验证码
process.env.CAPTCHA_ENABLED = '0';

test('同步记录：插入 → 完成 → 列表 → 重启中断标记', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);

    const run = await db.insertSyncRun(q, { mode: 'steamall', args: 'src/cli.js sync steamall --limit 200' });
    assert.ok(run.id > 0, '要返回任务 id');
    const running = await db.runningSyncRun(q);
    assert.equal(running.id, run.id, '刚开始应处于运行中');

    await db.finishSyncRun(q, run.id, { status: 'ok', exitCode: 0, output: '完成：200 条元数据' });
    const list = await db.listSyncRuns(q, { limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'ok');
    assert.equal(list[0].exit_code, 0);
    assert.match(list[0].output, /200 条元数据/);
    assert.ok(list[0].finished_at, '结束时间要写入');
    assert.equal(await db.runningSyncRun(q), null, '完成后不再是 running');

    // 服务重启残留：running 记录被标成失败，避免同步按钮永远禁用
    const r2 = await db.insertSyncRun(q, { mode: 'catalog' });
    assert.equal((await db.runningSyncRun(q)).id, r2.id);
    assert.equal(await db.markStaleSyncRuns(q), 1);
    const row = (await q('select status, output from sync_runs where id = $1', [r2.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.match(row.output, /服务重启/);
  } finally {
    await store.close();
  }
});

test('同步状态/记录接口：匿名 401，管理员 200，未运行 running=false', async () => {
  const store = await openStore('pglite:', {});
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);
  await db.createUser(q, { username: 'admin', password: 'admin123456', role: 'admin' });
  const srv = await startApiServer({ query: q, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    assert.equal((await fetch(base + '/api/admin/sync/status')).status, 401, '匿名不能看同步状态');
    assert.equal((await fetch(base + '/api/admin/sync/runs')).status, 401, '匿名不能看同步记录');

    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

    const st = await (await fetch(base + '/api/admin/sync/status', { headers: { cookie } })).json();
    assert.equal(st.running, false);
    assert.equal(st.run, null);
    assert.equal(st.output, '');
    assert.equal(st.last, null);

    const runs = await (await fetch(base + '/api/admin/sync/runs?limit=5', { headers: { cookie } })).json();
    assert.deepEqual(runs.runs, []);
  } finally {
    await srv.close();
    await store.close();
  }
});
