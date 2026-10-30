// 结构化日志：JSONL 落盘 + 控制台简读 + 密钥脱敏 + 按大小轮转。
//
// 设计目标是"离线排障"：别人把 logs/*.jsonl 发过来，不看代码也能定位到
// 哪一个请求、哪一步、哪一个字段出了错。所以每条记录都带：
//   ts / level / event / runId / platform / pid，外加该事件的上下文。
//
// 术语：event 用 "域.动作" 命名（http.request、ingest.offer、run.summary），
// 便于 `node src/cli.js logs --event http.error` 这种过滤。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** 时区名白名单校验（log 层不依赖 store，避免循环引用；Intl 解析失败回落）。 */
function normalizeTz(tz) {
  const v = String(tz ?? '').trim();
  if (!v || !/^[A-Za-z_][A-Za-z0-9_+./-]{0,63}$/.test(v)) return 'Asia/Shanghai';
  if (v === 'UTC') return v; // UTC 不在 supportedValuesOf 列表，但 Intl 接受
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
 * 把 Date 格式化成带偏移的 ISO（如 2026-10-30T16:42:23+08:00），
 * 偏移按给定 IANA 时区计算；时区非法时回落 UTC ISO。日志 ts 与文件分片日期都走它，
 * 让"按天"与"时间显示"跟随设置化的时区，而不是服务器 UTC。
 */
export function tsInZone(now, tz = 'Asia/Shanghai') {
  try {
    const dtf = new Intl.DateTimeFormat('sv-SE', {
      timeZone: normalizeTz(tz),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const local = dtf.format(now).replace(' ', 'T'); // sv-SE："2026-10-30 16:42:23"
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) throw new Error('unexpected format');
    const asUtc = new Date(`${local}Z`);
    const diff = Math.round((asUtc.getTime() - now.getTime()) / 60000);
    const sign = diff >= 0 ? '+' : '-';
    const abs = Math.abs(diff);
    return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return now.toISOString();
  }
}

const SECRET_KEY = /(password|passwd|secret|token|cookie|authorization|apikey|api_key|access_token|refresh_token|dsn|database_url)/i;

const DEFAULTS = {
  dir: 'logs',
  level: 'info',
  prefix: 'app',
  maxBytes: 8 * 1024 * 1024,
  keep: 10,
  console: true,
  bindings: {},
};

function redactString(value) {
  // 连接串里的密码：postgres://user:pass@host/db → postgres://user:***@host/db
  return value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi, '$1***$3');
}

export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/(key|token|secret|pass|sign|auth)/i.test(k)) u.searchParams.set(k, '***');
    }
    return redactString(u.toString());
  } catch {
    return redactString(String(url));
  }
}

export function redactObject(input, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (input == null) return input;
  if (typeof input === 'string') return redactString(input);
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.slice(0, 200).map((v) => redactObject(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY.test(k)) {
      // 连接串这类"URL 形态的敏感值"只抹密码，保留 host/db —— 排障时需要这些信息
      const urlLike = typeof v === 'string' && v.includes('://');
      out[k] = v == null || v === '' ? v : urlLike ? redactString(v) : '***';
    } else {
      out[k] = redactObject(v, depth + 1);
    }
  }
  return out;
}

export function serializeError(err) {
  if (!err) return null;
  const out = {
    name: err.name,
    message: err.message,
    code: err.code ?? err.cause?.code,
    status: err.status,
  };
  if (err.body) out.bodySnippet = String(err.body).slice(0, 300);
  if (err.stack) out.stack = String(err.stack).split('\n').slice(0, 8).join('\n');
  if (err.cause && err.cause !== err) out.cause = { code: err.cause.code, message: err.cause.message?.slice(0, 200) };
  return out;
}

function fmtValue(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 160);
}

function fmtConsole(rec) {
  const time = rec.ts.slice(11, 19);
  const { ts, level, event, pid, ...rest } = rec;
  const kv = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${fmtValue(v)}`)
    .join(' ');
  const tag = level.toUpperCase().padEnd(5);
  return `[${time}] ${tag} ${event}${kv ? `  ${kv}` : ''}`;
}

export function createLogger(options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const tz = normalizeTz(opt.timezone ?? process.env.TZ);
  mkdirSync(opt.dir, { recursive: true });
  const state = { day: '', minLevel: LEVELS[opt.level] ?? LEVELS.info };
  // 每个日志文件独立记字节数，避免 app / error 两个文件互相干扰轮转
  const sizes = new Map();

  function archive(path) {
    try {
      renameSync(path, `${path}.${Date.now()}`);
      const dir = dirname(path);
      const base = basename(path);
      const olds = readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`))
        .sort();
      while (olds.length > opt.keep) unlinkSync(join(dir, olds.shift()));
    } catch {
      /* 轮转失败不影响写日志 */
    }
    sizes.set(path, 0);
  }

  function appendLine(path, line) {
    const size = Buffer.byteLength(line);
    let bytes = sizes.get(path);
    if (bytes == null) bytes = existsSync(path) ? statSync(path).size : 0;
    if (bytes + size > opt.maxBytes) {
      archive(path);
      bytes = 0;
    }
    appendFileSync(path, line, 'utf8');
    sizes.set(path, bytes + size);
  }

  function currentFile(day) {
    if (state.day !== day) state.day = day;
    return join(opt.dir, `${opt.prefix}-${day}.jsonl`);
  }

  function write(level, event, fields = {}) {
    if ((LEVELS[level] ?? 99) < state.minLevel) return null;
    const ts = tsInZone(new Date(), tz);
    const day = ts.slice(0, 10);
    const rec = redactObject({
      ts,
      level,
      event,
      ...opt.bindings,
      ...fields,
      pid: process.pid,
    });
    const line = `${JSON.stringify(rec)}\n`;
    appendLine(currentFile(day), line);
    // 错误额外落一份 error-*.jsonl，排障时不用在几万行里翻
    if (level === 'error' || level === 'fatal') {
      appendLine(join(opt.dir, `error-${day}.jsonl`), line);
    }

    if (opt.console) {
      const out = fmtConsole(rec);
      if (level === 'error' || level === 'fatal') console.error(out);
      else if (level === 'warn') console.warn(out);
      else console.log(out);
    }
    return rec;
  }

  const logger = {
    dir: opt.dir,
    level: opt.level,
    file: () => state.file,
    setLevel: (level) => {
      if (LEVELS[level] == null) return false;
      state.minLevel = LEVELS[level];
      logger.level = level;
      return true;
    },
    trace: (event, fields) => write('trace', event, fields),
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    fatal: (event, fields) => write('fatal', event, fields),
    child: (bindings) => createLogger({ ...opt, bindings: { ...opt.bindings, ...bindings } }),
    timed: (event, fields) => {
      const started = Date.now();
      return {
        done: (extra = {}) => write('info', event, { ...fields, ...extra, elapsedMs: Date.now() - started }),
        fail: (err, extra = {}) =>
          write('error', event, { ...fields, ...extra, elapsedMs: Date.now() - started, err: serializeError(err) }),
      };
    },
  };
  return logger;
}

/**
 * 读日志，用于 `cli.js logs`。从新到旧扫描，支持级别/事件/runId/时间过滤。
 * 默认只读 app-*.jsonl：错误行同时会写进 error-*.jsonl，两个文件都读会重复计数。
 * 想看精简的错误流就传 source: 'error'。
 */
export function readLogs({
  dir = 'logs',
  level = null,
  event = null,
  runId = null,
  sinceMinutes = null,
  limit = 50,
  source = 'app',
} = {}) {
  if (!existsSync(dir)) return [];
  const fileRe = source === 'error' ? /^error-\d{4}-\d{2}-\d{2}\.jsonl$/ : /^app-\d{4}-\d{2}-\d{2}\.jsonl$/;
  const files = readdirSync(dir)
    .filter((f) => fileRe.test(f))
    .sort()
    .reverse();
  const minLevel = level ? (LEVELS[level] ?? 0) : 0;
  const since = sinceMinutes ? Date.now() - sinceMinutes * 60_000 : null;
  const out = [];

  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (minLevel && (LEVELS[rec.level] ?? 0) < minLevel) continue;
      if (event && !rec.event.includes(event)) continue;
      if (runId && rec.runId !== runId) continue;
      if (since && Date.parse(rec.ts) < since) continue;
      out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
