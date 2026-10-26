// 存储入口的两个能力：
//   1) 纯函数（URL 解析、标识符转义）
//   2) 「库不存在就建」——除了假客户端，还对着真 PG 协议跑一遍
//      （用 PGlite + PGLiteSocketServer 起一个本地 TCP Postgres）
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatabaseTarget, quoteIdent, ensureDatabase, maskDatabaseUrl } from '../src/store/index.js';

test('URL 解析出库名与维护库连接串', () => {
  const { dbname, adminUrl } = parseDatabaseTarget('postgres://u:p@host:5432/mygame');
  assert.equal(dbname, 'mygame');
  assert.equal(new URL(adminUrl).pathname, '/postgres');
  assert.equal(new URL(adminUrl).host, 'host:5432');
});

test('没有库名时按 postgres 库处理', () => {
  assert.equal(parseDatabaseTarget('postgres://u@host:5432').dbname, 'postgres');
  assert.equal(parseDatabaseTarget('postgres://u@host:5432/').dbname, 'postgres');
});

test('库名支持 URL 编码（中文/空格）', () => {
  assert.equal(parseDatabaseTarget(`postgres://u@h:5432/${encodeURIComponent('游戏 库')}`).dbname, '游戏 库');
});

test('标识符转义：双引号要翻倍', () => {
  assert.equal(quoteIdent('gameprice'), '"gameprice"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test('非法连接串报错要说人话，且不泄露密码', () => {
  // 密码里的 # 会被 URL 当成片段分隔符 → 解析失败（线上真实踩到）
  assert.throws(
    () => parseDatabaseTarget('postgres://u:pa#ss@host:5432/db'),
    (err) => {
      assert.match(err.message, /不是合法的连接串/);
      assert.match(err.message, /%23/, '要提示怎么编码');
      assert.ok(!err.message.includes('pa#ss'), '不能把密码原样打出来');
      return true;
    },
  );
  assert.throws(() => parseDatabaseTarget(''), /DATABASE_URL 为空/);
  assert.throws(() => parseDatabaseTarget('   '), /DATABASE_URL 为空/);
  // 全角冒号也是常见手误
  assert.throws(() => parseDatabaseTarget('postgres：//u:p@host:5432/db'), /不是合法的连接串/);
});

test('maskDatabaseUrl 遮住密码但保留结构', () => {
  assert.equal(maskDatabaseUrl('postgres://user:secret@host:5432/db'), 'postgres://user:***@host:5432/db');
  assert.equal(maskDatabaseUrl('postgres://host:5432/db'), 'postgres://host:5432/db');
});

function fakeClient({ exists = false, failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    factory: async (opts) => ({
      connect: async () => {
        calls.push(['connect', opts.connectionString]);
        if (failOn === 'connect') throw new Error('ECONNREFUSED');
      },
      query: async (sql, params) => {
        calls.push(['query', sql, params]);
        if (failOn === 'query') throw new Error('permission denied for database postgres');
        if (sql.startsWith('select 1 from pg_database')) return { rowCount: exists ? 1 : 0, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      end: async () => calls.push(['end']),
    }),
  };
}

test('库不存在时会执行 create database', async () => {
  const { calls, factory } = fakeClient({ exists: false });
  const result = await ensureDatabase('postgres://u:p@db:5432/newdb', { clientFactory: factory });
  assert.equal(result.created, true);

  const connectCall = calls.find((c) => c[0] === 'connect');
  assert.match(connectCall[1], /\/postgres$/, '应当连维护库而不是目标库');
  const createCall = calls.find((c) => c[0] === 'query' && c[1].startsWith('create database'));
  assert.equal(createCall[1], 'create database "newdb"');
  assert.ok(calls.some((c) => c[0] === 'end'), '连接必须关闭');
});

test('库已存在时不重复创建', async () => {
  const { calls, factory } = fakeClient({ exists: true });
  const result = await ensureDatabase('postgres://u@db:5432/existing', { clientFactory: factory });
  assert.equal(result.exists, true);
  assert.equal(result.created, false);
  assert.ok(!calls.some((c) => c[0] === 'query' && String(c[1]).startsWith('create database')));
});

test('没有建库权限时只记录失败，不抛异常（后续连接会给出更明确的错）', async () => {
  const { factory } = fakeClient({ failOn: 'query' });
  const result = await ensureDatabase('postgres://u@db:5432/noperm', { clientFactory: factory });
  assert.equal(result.created, false);
  assert.match(result.error, /permission denied/);
});

test('连不上维护库时同样不抛异常', async () => {
  const { factory } = fakeClient({ failOn: 'connect' });
  const result = await ensureDatabase('postgres://u@db:5432/x', { clientFactory: factory });
  assert.equal(result.created, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test('非 postgres 目标直接跳过（pglite 不需要建库）', async () => {
  const result = await ensureDatabase('pglite:./data/pgdata');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_postgres');
});

test('真 PG 协议下：建库成功，重复调用变成 exists', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const PORT = 15433;

  const embedded = new PGlite();
  const server = new PGLiteSocketServer({ db: embedded, port: PORT, host: '127.0.0.1' });
  await server.start();
  try {
    const target = `postgres://postgres@127.0.0.1:${PORT}/autocreate_test`;
    const first = await ensureDatabase(target);
    assert.equal(first.created, true, JSON.stringify(first));

    const second = await ensureDatabase(target);
    assert.equal(second.created, false);
    assert.equal(second.exists, true, JSON.stringify(second));

    // 直接查系统表确认库真的建出来了
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${PORT}/postgres` });
    await client.connect();
    const found = await client.query('select 1 from pg_database where datname = $1', ['autocreate_test']);
    assert.equal(found.rowCount, 1);
    await client.end();
  } finally {
    await server.stop();
    await embedded.close();
  }
});
