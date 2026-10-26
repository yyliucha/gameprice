// 存储入口：把 pg.Pool / PGlite 统一成 { query, exec, close }，并在这一层做查询日志。
// 排障时最想知道的就是"哪条 SQL 挂了、参数是什么、花了多久"，所以包在这里而不是散在业务里。
import { serializeError } from '../log.js';

const SLOW_MS = 2000;

function shorten(sql, max = 160) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeResult(result) {
  return {
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? result.affectedRows ?? result.rows?.length ?? 0,
  };
}

/**
 * target:
 *   postgres://user:pass@host:5432/db   → 真实 PG（生产）
 *   pglite:./data/pgdata                → 本地 wasm PG（无服务器、验证用）
 */
export async function openStore(target, { logger } = {}) {
  if (!target) {
    throw new Error(
      '没有数据库地址。设置环境变量 DATABASE_URL=postgres://user:pass@host:5432/db，' +
        '或者用 --db pglite:./data/pgdata 在本地跑一个嵌入式 PG。',
    );
  }

  let kind;
  let raw;
  let exec;
  let close;

  if (target.startsWith('pglite:')) {
    kind = 'pglite';
    const rest = target.slice('pglite:'.length);
    const path = rest && rest !== ':memory:' ? rest : undefined;
    const { PGlite } = await import('@electric-sql/pglite');
    raw = new PGlite(path);
    exec = async (sql) => raw.exec(sql);
    close = async () => raw.close();
    logger?.info('db.connect', { kind, target: path ?? ':memory:' });
  } else if (/^postgres(ql)?:\/\//i.test(target)) {
    kind = 'postgres';
    const pg = (await import('pg')).default;
    // DATE 列默认被解析成 JS Date，会带本地时区偏移（跨时区时甚至差一天）。
    // 统一退回字符串 'YYYY-MM-DD'，让日聚合/史低比较始终按日历日进行。
    pg.types.setTypeParser(1082, (v) => v);
    raw = new pg.Pool({ connectionString: target, max: 4, idleTimeoutMillis: 30000 });
    raw.on('error', (err) => logger?.error('db.pool_error', { err: serializeError(err) }));
    exec = async (sql) => raw.query(sql);
    close = async () => raw.end();
    // 连接串里的密码由 logger 统一脱敏，这里可以放心记
    logger?.info('db.connect', { kind, target });
  } else {
    throw new Error(`无法识别的数据库地址：${target.slice(0, 20)}…（需要 postgres:// 或 pglite: 开头）`);
  }

  const query = async (sql, params = []) => {
    const startedAt = Date.now();
    try {
      const result = normalizeResult(await raw.query(sql, params));
      const elapsedMs = Date.now() - startedAt;
      const fields = { sql: shorten(sql), params: params.length, rows: result.rows.length, elapsedMs };
      if (elapsedMs > SLOW_MS) logger?.warn('db.slow_query', fields);
      else logger?.debug('db.query', fields);
      return result;
    } catch (err) {
      logger?.error('db.query_failed', {
        sql: shorten(sql, 600),
        paramCount: params.length,
        err: serializeError(err),
      });
      throw err;
    }
  };

  return { kind, raw, query, exec, close };
}

export async function ping(store) {
  const r = await store.query('select 1 as ok');
  return r.rows[0]?.ok === 1;
}
