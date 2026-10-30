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

/** 日志/报错里展示连接串时遮掉密码。 */
export function maskDatabaseUrl(target) {
  return String(target ?? '').replace(/([a-z]+:\/\/[^:@/]*:)[^@/]*@/i, '$1***@');
}

/**
 * 会话时区归一化：只允许 IANA 风格名称，且必须能被 Intl 解析；
 * 非法/缺省一律回落 Asia/Shanghai。连接池 options 用它拼 `-c timezone=…`，
 * 校验过再拼可以避免 SQL/连接串注入。
 */
export function normalizeTimezone(tz) {
  const v = String(tz ?? '').trim();
  if (!v || !/^[A-Za-z_][A-Za-z0-9_+./-]{0,63}$/.test(v)) return 'Asia/Shanghai';
  // UTC 不在 Intl.supportedValuesOf('timeZone') 列表里，但 Intl 接受它，显式放行
  if (v === 'UTC') return v;
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone').includes(v) ? v : 'Asia/Shanghai';
    }
    if (new Intl.DateTimeFormat('en', { timeZone: v }).resolvedOptions().timeZone === v) return v;
  } catch {
    /* 非法时区 */
  }
  return 'Asia/Shanghai';
}

/**
 * 解析 postgres URL：取出库名，并给出用于建库的维护库连接串（/postgres）。
 *
 * 这里单独判空并给出可操作的报错：`new URL()` 只会抛 "Invalid URL"，
 * 在容器里根本看不出是密码带 # 还是写了全角标点。
 */
export function parseDatabaseTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) {
    throw new Error('DATABASE_URL 为空：请在 .env 里写 DATABASE_URL=postgres://用户:密码@主机:5432/库名');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `DATABASE_URL 不是合法的连接串：${maskDatabaseUrl(raw)}\n` +
        '常见原因：\n' +
        '  · 密码里有 # ? / 等特殊字符（URL 里有含义，需编码：# → %23，? → %3F，/ → %2F，@ → %40）\n' +
        '  · 用了中文标点（全角冒号"："、全角斜杠"／"）\n' +
        '  · 值被引号包住，或等号两边多了空格\n' +
        '最简单：把数据库密码改成纯字母数字，或手动编码特殊字符',
    );
  }

  const dbname = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  const admin = new URL(raw);
  admin.pathname = '/postgres';
  return { dbname, adminUrl: admin.toString() };
}

/** 建库时要拼标识符，必须转义双引号。 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * 目标库不存在就建出来。
 *
 * 为什么要这层：DATABASE_URL 指向的库往往还没建（新机器、新 compose 项目），
 * 让用户"先去 createdb"违背开箱即用。这里连维护库 /postgres 检查并创建，
 * 没有建库权限时只记 warn 并继续——后面真正的连接错误会带上更明确的信息。
 */
export async function ensureDatabase(target, { logger = null, clientFactory = null } = {}) {
  if (!/^postgres(ql)?:\/\//i.test(target)) return { skipped: true, reason: 'not_postgres' };

  const { dbname, adminUrl } = parseDatabaseTarget(target);
  if (dbname === 'postgres') return { exists: true, created: false };

  const makeClient =
    clientFactory ??
    (async (opts) => {
      const pg = (await import('pg')).default;
      return new pg.Client(opts);
    });

  let client = null;
  try {
    client = await makeClient({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    const found = await client.query('select 1 from pg_database where datname = $1', [dbname]);
    if ((found.rowCount ?? found.rows?.length ?? 0) > 0) return { exists: true, created: false };

    await client.query(`create database ${quoteIdent(dbname)}`);
    logger?.info('db.autocreate', { database: dbname });
    return { created: true };
  } catch (err) {
    logger?.warn('db.autocreate_failed', {
      database: dbname,
      message: String(err.message).slice(0, 200),
      hint: '需要建库权限；可手动 createdb，或用已有库地址',
    });
    return { created: false, error: String(err.message) };
  } finally {
    try {
      await client?.end();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * target:
 *   postgres://user:pass@host:5432/db   → 真实 PG（生产）
 *   pglite:./data/pgdata                → 本地 wasm PG（无服务器、验证用）
 */
export async function openStore(target, { logger, timezone } = {}) {
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
  let runTransaction;
  // 会话时区（设置化）：current_date / date_trunc / now() 的显示与"按天"归属都按它算。
  // 保存后新连接生效；setTimezone 可让运行中的进程立即更新后续连接。
  let sessionTz = normalizeTimezone(timezone ?? process.env.TZ);
  const applySessionTz = async (conn) => {
    try {
      await conn.query('select set_config($1, $2, false)', ['timezone', sessionTz]);
    } catch {
      /* 会话时区设置失败不影响业务查询，落回服务器默认 */
    }
  };

  if (target.startsWith('pglite:')) {
    kind = 'pglite';
    const rest = target.slice('pglite:'.length);
    const path = rest && rest !== ':memory:' ? rest : undefined;
    const { PGlite } = await import('@electric-sql/pglite');
    raw = new PGlite(path);
    await applySessionTz(raw);
    exec = async (sql) => raw.exec(sql);
    close = async () => raw.close();
    // PGlite 自带事务：callback 里拿到的 tx 只能在该事务内使用
    runTransaction = (fn) =>
      raw.transaction(async (tx) => {
        const txQuery = makeQuery((sql, params) => tx.query(sql, params), logger);
        return fn(txQuery);
      });
    logger?.info('db.connect', { kind, target: path ?? ':memory:', timezone: sessionTz });
  } else if (/^postgres(ql)?:\/\//i.test(target)) {
    kind = 'postgres';
    // 先保证库存在（连不上或无权限只记 warn，不影响后面的真实报错）
    await ensureDatabase(target, { logger });
    const pg = (await import('pg')).default;
    // DATE 列默认被解析成 JS Date，会带本地时区偏移（跨时区时甚至差一天）。
    // 统一退回字符串 'YYYY-MM-DD'，让日聚合/史低比较始终按日历日进行。
    pg.types.setTypeParser(1082, (v) => v);
    raw = new pg.Pool({
      connectionString: target,
      max: 4,
      idleTimeoutMillis: 30000,
      options: `-c timezone=${sessionTz}`,
    });
    // 每个新连接都按当前 sessionTz 设一次：设置变更后无需重启，新连接自动跟上
    raw.on('connect', (client) => {
      applySessionTz(client);
    });
    raw.on('error', (err) => logger?.error('db.pool_error', { err: serializeError(err) }));
    exec = async (sql) => raw.query(sql);
    close = async () => raw.end();
    // pg.Pool.query 每次可能拿不同连接，事务必须固定在一个 client 上
    runTransaction = async (fn) => {
      const client = await raw.connect();
      try {
        await client.query('begin');
        const txQuery = makeQuery((sql, params) => client.query(sql, params), logger);
        const result = await fn(txQuery);
        await client.query('commit');
        return result;
      } catch (err) {
        try {
          await client.query('rollback');
        } catch {
          /* 连接已断时 rollback 也会失败，保留原始错误 */
        }
        throw err;
      } finally {
        client.release();
      }
    };
    // 连接串里的密码由 logger 统一脱敏，这里可以放心记
    logger?.info('db.connect', { kind, target, timezone: sessionTz });
  } else {
    throw new Error(`无法识别的数据库地址：${target.slice(0, 20)}…（需要 postgres:// 或 pglite: 开头）`);
  }

  const query = makeQuery((sql, params) => raw.query(sql, params), logger);

  return {
    kind,
    raw,
    query,
    exec,
    close,
    tx: runTransaction,
    get timezone() {
      return sessionTz;
    },
    /** 运行中修改会话时区（设置保存后调用）：后续新连接生效，并立即更新当前池连接。 */
    setTimezone: async (tz) => {
      sessionTz = normalizeTimezone(tz);
      await applySessionTz(raw);
      logger?.info('db.timezone_updated', { timezone: sessionTz });
      return sessionTz;
    },
  };
}

/** 统一的查询包装：计时 + 慢查询 + 失败日志。事务里的查询也复用它。 */
function makeQuery(rawQuery, logger) {
  return async (sql, params = []) => {
    const startedAt = Date.now();
    try {
      const result = normalizeResult(await rawQuery(sql, params));
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
}

export async function ping(store) {
  const r = await store.query('select 1 as ok');
  return r.rows[0]?.ok === 1;
}
