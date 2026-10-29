// 业务设置：数据库是事实源，进程启动时水合回 process.env。
//
// 为什么是"水合"而不是把所有读取点改成 config 对象：
//   scheduler / notify / proxy / adapters 都直接读 process.env，这些逻辑已经被测试覆盖；
//   把 DB 值写回 env 可以让它们零改动地继续工作，同时用户侧不再需要改 .env。
//
// 优先级：数据库 > 环境变量 > 代码默认值。
// 这样老部署的 .env 仍能作为首次导入/兜底，新部署在 /setup 或控制台写库后立即以库为准。
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import {
  EMAIL_SCHEMA,
  decryptSecret,
  encryptSecret,
  loadSecretKey,
  normalizeEmail,
} from './email-auth.js';

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

export const SETUP_COMPLETED_KEY = 'setup.completed_at';
export const SETUP_BY_KEY = 'setup.completed_by';
export const SETTINGS_REVISION_KEY = 'settings.revision';

export const GOG_REGION_CODES = ['cn', 'hk', 'tw', 'us', 'jp', 'ru', 'tr', 'ar'];
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

const def = (key, env, group, label, type, defaultValue, extra = {}) => ({
  key,
  env,
  group,
  label,
  type,
  default: defaultValue,
  secret: type === 'secret',
  ...extra,
});

/**
 * 45 项业务设置。env 字段是旧变量名，用于首次导入与兜底。
 * store: 'smtp' 的项落到已有的 smtp_settings 表，其余落 app_settings。
 */
export const SETTINGS = [
  // ---- 数据源 ----
  def('sources.steam.enabled', 'STEAM_ENABLED', 'sources', 'Steam', 'bool', true, { help: 'Steam 官方商店价格（国内网络可能不可达）。' }),
  def('sources.sonkwo.enabled', 'SONKWO_ENABLED', 'sources', '杉果', 'bool', true, { help: '杉果（境内可直连）。' }),
  def('sources.itad.enabled', 'ITAD_ENABLED', 'sources', 'ITAD 聚合', 'bool', true, { help: '需要 ITAD API Key；不填 Key 时该源会自动跳过。' }),
  def('sources.gog.enabled', 'GOG_ENABLED', 'sources', 'GOG', 'bool', true),
  def('sources.humble.enabled', 'HUMBLE_ENABLED', 'sources', 'Humble', 'bool', true),
  def('sources.discover.enabled', 'DISCOVER_ENABLED', 'sources', '杉果 SKU 自动发现', 'bool', false, { advanced: true }),

  def('sources.steam.priceIntervalMin', 'STEAM_PRICE_INTERVAL_MIN', 'sources', 'Steam 价格刷新间隔（分钟）', 'int', 1440, {
    min: 0,
    max: 10080,
    help: '定时刷新系统中已有 Steam 报价的游戏。建议 1440 分钟（每天一次）；间隔越短，请求越多，也更容易遇到 Steam 429。设为 0 可关闭。',
  }),
  def('sources.sonkwo.intervalMin', 'SONKWO_INTERVAL_MIN', 'sources', '杉果间隔（分钟）', 'int', 60, { min: 0, max: 10080 }),
  def('sources.itad.intervalMin', 'ITAD_INTERVAL_MIN', 'sources', 'ITAD 间隔（分钟）', 'int', 1440, { min: 0, max: 10080 }),
  def('sources.gog.intervalMin', 'GOG_INTERVAL_MIN', 'sources', 'GOG 间隔（分钟）', 'int', 720, { min: 0, max: 10080 }),
  def('sources.humble.intervalMin', 'HUMBLE_INTERVAL_MIN', 'sources', 'Humble 间隔（分钟）', 'int', 720, { min: 0, max: 10080 }),
  def('sources.discover.intervalMin', 'DISCOVER_INTERVAL_MIN', 'sources', 'SKU 发现间隔（分钟）', 'int', 720, { min: 0, max: 10080, advanced: true }),

  def('sources.steam.initialDelaySec', 'STEAM_INITIAL_DELAY_SEC', 'sources', 'Steam 价格首轮延迟（秒）', 'int', 600, {
    min: 0,
    max: 86400,
    advanced: true,
    help: '应用启动并完成初始化后，等待多久开始第一次自动价格刷新；之后按 Steam 价格刷新间隔执行。',
  }),
  def('sources.sonkwo.initialDelaySec', 'SONKWO_INITIAL_DELAY_SEC', 'sources', '杉果首轮延迟（秒）', 'int', 180, { min: 0, max: 86400, advanced: true }),
  def('sources.itad.initialDelaySec', 'ITAD_INITIAL_DELAY_SEC', 'sources', 'ITAD 首轮延迟（秒）', 'int', 300, { min: 0, max: 86400, advanced: true }),
  def('sources.gog.initialDelaySec', 'GOG_INITIAL_DELAY_SEC', 'sources', 'GOG 首轮延迟（秒）', 'int', 600, { min: 0, max: 86400, advanced: true }),
  def('sources.humble.initialDelaySec', 'HUMBLE_INITIAL_DELAY_SEC', 'sources', 'Humble 首轮延迟（秒）', 'int', 720, { min: 0, max: 86400, advanced: true }),
  def('sources.discover.initialDelaySec', 'DISCOVER_INITIAL_DELAY_SEC', 'sources', 'SKU 发现首轮延迟（秒）', 'int', 900, { min: 0, max: 86400, advanced: true }),
  def('alerts.initialDelaySec', 'ALERTS_INITIAL_DELAY_SEC', 'alerts', '提醒检查首轮延迟（秒）', 'int', 420, { min: 0, max: 86400, advanced: true }),

  // ---- Key 与区服 ----
  def('sources.itad.apiKey', 'ITAD_API_KEY', 'sources', 'ITAD API Key', 'secret', '', {
    help: '在 https://isthereanydeal.com/apps/my/ 申请。留空则 ITAD 源跳过。',
  }),
  def('sources.steam.apiKey', 'STEAM_API_KEY', 'sources', 'Steam Web API Key', 'secret', '', {
    help: '用于 Steam 游戏库同步；采集价格不依赖它。',
  }),
  def('sources.gog.regions', 'GOG_REGIONS', 'sources', 'GOG 区服', 'string', 'cn', {
    help: `逗号分隔：${GOG_REGION_CODES.join(', ')}`,
  }),

  // ---- 提醒 ----
  def('alerts.enabled', 'ALERTS_ENABLED', 'alerts', '启用降价提醒', 'bool', true),
  def('alerts.intervalMin', 'ALERTS_INTERVAL_MIN', 'alerts', '提醒检查间隔（分钟）', 'int', 360, { min: 0, max: 10080 }),
  def('alerts.webhookUrl', 'ALERT_WEBHOOK_URL', 'alerts', '通用 Webhook', 'secret', '', {
    help: 'POST 一个 JSON，包含 text 与 alerts 数组。',
  }),
  def('alerts.wecomUrl', 'WECOM_WEBHOOK_URL', 'alerts', '企业微信群机器人', 'secret', '', {
    help: '群设置 → 添加机器人 → 复制 webhook 地址。',
  }),
  def('alerts.emailTo', 'ALERT_EMAIL_TO', 'alerts', '邮件收件人', 'string', '', {
    help: '多个收件人用逗号分隔；不填则邮件通道不启用。',
  }),
  def('alerts.smtp.host', 'SMTP_HOST', 'alerts', 'SMTP 主机', 'string', '', { store: 'smtp', column: 'host', help: '如 smtp.qq.com。' }),
  def('alerts.smtp.port', 'SMTP_PORT', 'alerts', 'SMTP 端口', 'int', 465, { min: 1, max: 65535, store: 'smtp', column: 'port' }),
  def('alerts.smtp.secure', 'SMTP_SECURE', 'alerts', 'SMTP 加密', 'bool', true, { store: 'smtp', column: 'secure', help: '465 用 SSL；587 用 STARTTLS（关闭此项）。' }),
  def('alerts.smtp.user', 'SMTP_USER', 'alerts', 'SMTP 账号', 'string', '', { store: 'smtp', column: 'username' }),
  def('alerts.smtp.pass', 'SMTP_PASS', 'alerts', 'SMTP 授权码', 'secret', '', { store: 'smtp', column: 'password_enc', help: 'QQ/163 使用授权码，不是登录密码。' }),
  def('alerts.smtp.from', 'SMTP_FROM', 'alerts', '发件人', 'string', '', { store: 'smtp', column: 'from_addr', help: '留空则使用 SMTP 账号。' }),

  // ---- 网络 ----
  def('network.steamProxy', 'STEAM_PROXY', 'network', 'Steam 专用代理', 'secret', '', {
    help: '只作用于 Steam 域名，如 http://127.0.0.1:7890。仅支持 http/https。',
  }),
  def('network.httpsProxy', 'HTTPS_PROXY', 'network', '通用出网代理', 'secret', '', {
    help: '作用于其余所有主机；受 NO_PROXY 排除。仅支持 http/https。',
  }),
  def('network.noProxy', 'NO_PROXY', 'network', '代理排除列表', 'string', '', {
    help: '逗号分隔，如 sonkwo.hk,sonkwo.cn。',
  }),

  // ---- 高级 ----
  def('system.circuitThreshold', 'CIRCUIT_THRESHOLD', 'advanced', '熔断阈值（连续失败次数）', 'int', 3, { min: 1, max: 100 }),
  def('system.circuitCooldownMin', 'CIRCUIT_COOLDOWN_MIN', 'advanced', '熔断暂停（分钟）', 'int', 360, { min: 1, max: 10080 }),
  def('system.chartOnSync', 'CHART_ON_SYNC', 'advanced', '采集后生成静态页', 'bool', false, {
    help: '内置 Web 服务直接读数据库，默认不需要静态页；使用 nginx 托管 out/ 时才开启。',
  }),
  def('system.backupEnabled', 'BACKUP_ENABLED', 'advanced', '每日备份', 'bool', true),
  def('system.backupIntervalMin', 'BACKUP_INTERVAL_MIN', 'advanced', '备份间隔（分钟）', 'int', 1440, { min: 0, max: 10080, advanced: true }),
  def('system.backupInitialDelaySec', 'BACKUP_INITIAL_DELAY_SEC', 'advanced', '备份首轮延迟（秒）', 'int', 3600, { min: 0, max: 86400, advanced: true }),
  def('system.logsPruneEnabled', 'LOGS_PRUNE_ENABLED', 'advanced', '定期清理日志', 'bool', true, { advanced: true }),
  def('system.logsPruneDays', 'LOGS_PRUNE_DAYS', 'advanced', '日志保留天数', 'int', 7, { min: 1, max: 365, advanced: true }),
  def('system.logLevel', 'LOG_LEVEL', 'advanced', '日志级别', 'enum', 'info', { options: LOG_LEVELS }),

  // ---- 封面图本地缓存（下载一次后由本机磁盘提供）----
  def('images.enabled', 'IMAGES_ENABLED', 'advanced', '启用封面图补缓存', 'bool', true, { advanced: true, help: '定时把游戏封面下载到 data/images，之后不再依赖 Steam CDN。' }),
  def('images.intervalMin', 'IMAGES_INTERVAL_MIN', 'advanced', '补图间隔（分钟）', 'int', 240, { min: 0, max: 10080, advanced: true }),
  def('images.initialDelaySec', 'IMAGES_INITIAL_DELAY_SEC', 'advanced', '补图首轮延迟（秒）', 'int', 1200, { min: 0, max: 86400, advanced: true }),
  def('images.limit', 'IMAGES_LIMIT', 'advanced', '每轮补图数量', 'int', 200, { min: 1, max: 5000, advanced: true }),
  def('images.sleepMs', 'IMAGES_SLEEP_MS', 'advanced', '每张图间隔（毫秒）', 'int', 300, { min: 0, max: 60000, advanced: true }),
];

export const SETTING_MAP = new Map(SETTINGS.map((d) => [d.key, d]));

export const GROUPS = [
  { id: 'sources', title: '数据源与采集', description: '开关、间隔、API Key 与区服。' },
  { id: 'alerts', title: '降价提醒', description: 'Webhook / 企业微信 / 邮件。邮件授权码加密存库。' },
  { id: 'network', title: '网络与代理', description: '国内服务器访问 Steam 通常需要代理；只支持 http/https。' },
  { id: 'advanced', title: '高级', description: '一般保持默认即可。' },
];

const ENV_ALIASES = {
  'network.steamProxy': ['STEAM_PROXY', 'steam_proxy'],
  'network.httpsProxy': ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'],
  'network.noProxy': ['NO_PROXY', 'no_proxy'],
};

export const PUBLIC_GROUPS = GROUPS;

export function publicFields() {
  return SETTINGS.map((d) => ({
    key: d.key,
    env: d.env,
    group: d.group,
    label: d.label,
    type: d.type,
    default: d.default,
    secret: Boolean(d.secret),
    advanced: Boolean(d.advanced),
    min: d.min,
    max: d.max,
    options: d.options,
    help: d.help,
  }));
}

// ---------------------------------------------------------------- 基础工具

export function resetSettingsCache() {
  completedCache = { value: null, at: 0 };
}

let completedCache = { value: null, at: 0 };

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function secretKeyFor({ env = process.env, secretKey = null } = {}) {
  return secretKey ?? loadSecretKey({ env });
}

function envRawValue(d, env) {
  const names = ENV_ALIASES[d.key] ?? [d.env];
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

export function parseEnvValue(d, raw) {
  if (raw == null) return { ok: true, value: d.default };
  if (d.type === 'bool') {
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return { ok: true, value: true };
    if (['0', 'false', 'no', 'off', ''].includes(v)) return { ok: true, value: false };
    return { ok: false, error: `${d.label} 需要布尔值（1/0）` };
  }
  if (d.type === 'int') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `${d.label} 需要数字` };
    return { ok: true, value: Math.trunc(n) };
  }
  return { ok: true, value: String(raw) };
}

export function valueToEnv(value) {
  if (value === true) return '1';
  if (value === false) return '0';
  if (value == null) return '';
  return String(value);
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value).includes('://') ? String(value) : `http://${value}`);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 校验并归一化单个设置值。返回 { ok, value, error }。 */
export function validateSetting(d, input) {
  if (d.type === 'bool') {
    if (typeof input !== 'boolean') return { ok: false, error: `${d.label} 需要 true/false` };
    return { ok: true, value: input };
  }
  if (d.type === 'int') {
    const n = typeof input === 'number' ? input : Number(input);
    if (!Number.isInteger(n)) return { ok: false, error: `${d.label} 需要整数` };
    if (d.min != null && n < d.min) return { ok: false, error: `${d.label} 不能小于 ${d.min}` };
    if (d.max != null && n > d.max) return { ok: false, error: `${d.label} 不能大于 ${d.max}` };
    return { ok: true, value: n };
  }
  if (d.type === 'enum') {
    const value = String(input ?? '');
    if (!d.options?.includes(value)) return { ok: false, error: `${d.label} 只能是 ${d.options?.join(' / ')}` };
    return { ok: true, value };
  }
  // string / secret
  if (input == null) return { ok: false, error: `${d.label} 不能为 null` };
  let value = String(input).trim();
  if (d.type === 'secret') {
    // 密钥不 trim 内部空格，但两端空白没有意义
    value = String(input).trim();
    if (value.length > 4096) return { ok: false, error: `${d.label} 过长` };
  } else if (value.length > 4096) {
    return { ok: false, error: `${d.label} 过长` };
  }

  if (d.key === 'sources.gog.regions' && value) {
    const regions = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!regions.length) return { ok: false, error: 'GOG 区服不能为空' };
    const bad = regions.find((r) => !GOG_REGION_CODES.includes(r));
    if (bad) return { ok: false, error: `GOG 不支持区服 ${bad}（可选：${GOG_REGION_CODES.join(', ')}）` };
    value = [...new Set(regions)].join(',');
  }
  if (d.key === 'alerts.emailTo' && value) {
    const list = value.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.find((e) => !normalizeEmail(e));
    if (bad) return { ok: false, error: `邮箱格式不正确：${bad}` };
    value = [...new Set(list.map((e) => e.toLowerCase()))].join(',');
  }
  if (['alerts.webhookUrl', 'alerts.wecomUrl'].includes(d.key) && value && !isHttpUrl(value)) {
    return { ok: false, error: `${d.label} 需要 http/https URL` };
  }
  if (['network.steamProxy', 'network.httpsProxy'].includes(d.key) && value && !isHttpUrl(value)) {
    return { ok: false, error: `${d.label} 需要 http/https 代理地址（不支持 socks5）` };
  }
  if (d.key === 'sources.itad.apiKey' && value && value.length < 8) {
    return { ok: false, error: 'ITAD API Key 看起来过短' };
  }
  if (d.key === 'sources.steam.apiKey' && value && value.length < 10) {
    return { ok: false, error: 'Steam Web API Key 看起来过短' };
  }
  if (d.key === 'alerts.smtp.host' && value && /\s/.test(value)) {
    return { ok: false, error: 'SMTP 主机不能包含空格' };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------- 建表

export const SETTINGS_SCHEMA = `
create table if not exists app_settings (
  key text primary key,
  value jsonb,
  secret_enc text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create table if not exists app_meta (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
`;

export async function ensureSettingsSchema(store) {
  await store.exec(SETTINGS_SCHEMA);
}

async function hasTable(q, name) {
  try {
    const r = await q('select to_regclass($1) is not null as ok', [`public.${name}`]);
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

async function ensureSmtpSchema(store) {
  if (!(await hasTable((sql, p) => store.query(sql, p), 'users'))) return false;
  await store.exec(EMAIL_SCHEMA);
  return true;
}

// ---------------------------------------------------------------- 读取 / 写入

function sourceValueFromRow(row, d, secretKey) {
  if (!row) return null;
  if (d.secret) {
    if (!row.secret_enc) return { value: '', source: 'database', decryptError: false };
    try {
      return { value: decryptSecret(row.secret_enc, secretKey) ?? '', source: 'database', decryptError: false };
    } catch {
      return { value: '', source: 'database', decryptError: true };
    }
  }
  return { value: row.value ?? d.default, source: 'database' };
}

async function readSmtpRow(q) {
  try {
    const r = await q('select host, port, secure, username, password_enc, from_addr, enabled from smtp_settings where id = 1');
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function readSettings(q, { env = process.env, secretKey = null } = {}) {
  const key = secretKeyFor({ env, secretKey });
  let rows = [];
  try {
    const r = await q('select key, value, secret_enc from app_settings');
    rows = r.rows;
  } catch {
    rows = [];
  }
  const stored = new Map(rows.map((r) => [r.key, r]));
  const smtpRow = await readSmtpRow(q);

  const values = {};
  const sources = {};
  const decryptErrors = [];

  for (const d of SETTINGS) {
    if (d.store === 'smtp') {
      if (smtpRow) {
        const map = {
          'alerts.smtp.host': smtpRow.host ?? '',
          'alerts.smtp.port': Number(smtpRow.port ?? 465),
          'alerts.smtp.secure': smtpRow.secure !== false,
          'alerts.smtp.user': smtpRow.username ?? '',
          'alerts.smtp.pass': '',
          'alerts.smtp.from': smtpRow.from_addr ?? '',
        };
        if (d.key === 'alerts.smtp.pass') {
          try {
            map[d.key] = decryptSecret(smtpRow.password_enc, key) ?? '';
          } catch {
            map[d.key] = '';
            decryptErrors.push(d.key);
          }
        }
        values[d.key] = map[d.key];
        sources[d.key] = 'database';
      } else {
        const raw = envRawValue(d, env);
        if (raw != null) {
          const parsed = parseEnvValue(d, raw);
          values[d.key] = parsed.ok ? parsed.value : d.default;
          sources[d.key] = 'env';
        } else {
          values[d.key] = d.default;
          sources[d.key] = 'default';
        }
      }
      continue;
    }

    const row = stored.get(d.key);
    if (row) {
      const got = sourceValueFromRow(row, d, key);
      values[d.key] = got.value;
      sources[d.key] = got.source;
      if (got.decryptError) decryptErrors.push(d.key);
      continue;
    }

    const raw = envRawValue(d, env);
    if (raw != null) {
      const parsed = parseEnvValue(d, raw);
      values[d.key] = parsed.ok ? parsed.value : d.default;
      sources[d.key] = 'env';
    } else {
      values[d.key] = d.default;
      sources[d.key] = 'default';
    }
  }

  // SMTP 是否真正启用：有 host 且 enabled 不为 false
  const smtp = smtpRow
    ? {
        source: 'database',
        enabled: smtpRow.enabled !== false && Boolean(smtpRow.host),
        host: String(smtpRow.host ?? ''),
        port: Number(smtpRow.port ?? 465),
        secure: smtpRow.secure !== false,
        user: String(smtpRow.username ?? ''),
        pass: values['alerts.smtp.pass'] ?? '',
        from: String(smtpRow.from_addr ?? '').trim() || String(smtpRow.username ?? '').trim(),
      }
    : {
        source: 'env',
        enabled: Boolean(String(env.SMTP_HOST ?? '').trim()),
        host: String(env.SMTP_HOST ?? '').trim(),
        port: Number(env.SMTP_PORT ?? 465),
        secure: String(env.SMTP_SECURE ?? '1') !== '0',
        user: String(env.SMTP_USER ?? ''),
        pass: String(env.SMTP_PASS ?? ''),
        from: String(env.SMTP_FROM ?? '').trim() || String(env.SMTP_USER ?? '').trim(),
      };

  return { values, sources, smtp, decryptErrors, secretKey: key };
}

export async function getPublicSettings(q, opts = {}) {
  const read = await readSettings(q, opts);
  const values = {};
  const secrets = {};
  for (const d of SETTINGS) {
    if (d.secret) {
      values[d.key] = '';
      secrets[d.key] = { hasValue: Boolean(read.values[d.key]), source: read.sources[d.key] };
    } else {
      values[d.key] = read.values[d.key];
    }
  }
  return {
    version: VERSION,
    groups: GROUPS,
    fields: publicFields(),
    values,
    secrets,
    sources: read.sources,
    revision: await getRevision(q),
    setup: await setupInfo(q),
  };
}

async function upsertSetting(q, d, { plain, encrypted, updatedBy, clear = false }) {
  if (clear) {
    await q(
      `insert into app_settings (key, value, secret_enc, updated_at, updated_by)
       values ($1, null, null, now(), $2)
       on conflict (key) do update set value = null, secret_enc = null, updated_at = now(), updated_by = excluded.updated_by`,
      [d.key, updatedBy],
    );
    return;
  }
  if (d.secret) {
    await q(
      `insert into app_settings (key, value, secret_enc, updated_at, updated_by)
       values ($1, null, $2, now(), $3)
       on conflict (key) do update set value = null, secret_enc = excluded.secret_enc, updated_at = now(), updated_by = excluded.updated_by`,
      [d.key, encrypted, updatedBy],
    );
    return;
  }
  await q(
    `insert into app_settings (key, value, secret_enc, updated_at, updated_by)
     values ($1, $2::jsonb, null, now(), $3)
     on conflict (key) do update set value = excluded.value, secret_enc = null, updated_at = now(), updated_by = excluded.updated_by`,
    [d.key, JSON.stringify(plain), updatedBy],
  );
}

async function upsertSmtp(q, next, { updatedBy, pass, keepPass }) {
  let passwordEnc = keepPass ?? null;
  if (pass === null) passwordEnc = null;
  else if (typeof pass === 'string' && pass !== '') passwordEnc = encryptSecret(pass, next.secretKey);
  await q(
    `insert into smtp_settings (id, host, port, secure, username, password_enc, from_addr, enabled, updated_at)
     values (1, $1, $2, $3, $4, $5, $6, $7, now())
     on conflict (id) do update set
       host = excluded.host, port = excluded.port, secure = excluded.secure,
       username = excluded.username,
       password_enc = excluded.password_enc,
       from_addr = excluded.from_addr, enabled = excluded.enabled, updated_at = now()`,
    [next.host, next.port, next.secure, next.user, passwordEnc, next.from, next.enabled],
  );
  void updatedBy;
}

function smtpNextFromPatch(existing, read, patch, secretKey) {
  const next = {
    host: String(patch['alerts.smtp.host'] ?? existing?.host ?? read.values['alerts.smtp.host'] ?? '').trim(),
    port: Number(patch['alerts.smtp.port'] ?? existing?.port ?? read.values['alerts.smtp.port'] ?? 465),
    secure: patch['alerts.smtp.secure'] ?? (existing ? existing.secure !== false : read.values['alerts.smtp.secure'] !== false),
    user: String(patch['alerts.smtp.user'] ?? existing?.username ?? read.values['alerts.smtp.user'] ?? '').trim(),
    from: String(patch['alerts.smtp.from'] ?? existing?.from_addr ?? read.values['alerts.smtp.from'] ?? '').trim(),
    secretKey,
  };
  if (next.host && !next.user && !next.from) {
    // 允许只有 host（极少见），但 smtpConfig 会判定未配置；这里不强行报错
  }
  next.enabled = Boolean(next.host);
  return next;
}

export async function saveSettings(q, patch, { updatedBy = null, env = process.env, secretKey = null } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('settings 必须是对象'), { status: 400 });
  }
  const key = secretKeyFor({ env, secretKey });
  const read = await readSettings(q, { env, secretKey: key });
  let changed = false;
  const changedKeys = [];

  for (const [name, raw] of Object.entries(patch)) {
    const d = SETTING_MAP.get(name);
    if (!d) throw Object.assign(new Error(`未知设置项：${name}`), { status: 400 });
    if (d.store === 'smtp') continue;
    if (raw === undefined) continue;

    if (d.secret) {
      if (raw === '' || raw == null) {
        // 空字符串表示"保持原值"，null 表示显式清除
        if (raw === null) {
          await upsertSetting(q, d, { clear: true, updatedBy });
          changed = true;
          changedKeys.push(name);
        }
        continue;
      }
      const v = validateSetting(d, raw);
      if (!v.ok) throw Object.assign(new Error(v.error), { status: 400 });
      await upsertSetting(q, d, { encrypted: encryptSecret(v.value, key), updatedBy });
      changed = true;
      changedKeys.push(name);
      continue;
    }

    if (raw === null) throw Object.assign(new Error(`${d.label} 不能为 null`), { status: 400 });
    const v = validateSetting(d, raw);
    if (!v.ok) throw Object.assign(new Error(v.error), { status: 400 });
    await upsertSetting(q, d, { plain: v.value, updatedBy });
    changed = true;
    changedKeys.push(name);
  }

  const smtpPatch = {};
  for (const [name, raw] of Object.entries(patch)) {
    const d = SETTING_MAP.get(name);
    if (d?.store === 'smtp' && raw !== undefined) smtpPatch[name] = raw;
  }
  if (Object.keys(smtpPatch).length) {
    const existing = await readSmtpRow(q);
    const next = smtpNextFromPatch(existing, read, smtpPatch, key);
    // 端口/主机组合校验
    const portCheck = validateSetting(SETTING_MAP.get('alerts.smtp.port'), next.port);
    if (!portCheck.ok) throw Object.assign(new Error(portCheck.error), { status: 400 });
    if (next.host && /\s/.test(next.host)) throw Object.assign(new Error('SMTP 主机不能包含空格'), { status: 400 });
    if (next.host && !next.user && !next.from) {
      throw Object.assign(new Error('启用 SMTP 时至少填写账号或发件人'), { status: 400 });
    }
    const pass = smtpPatch['alerts.smtp.pass'];
    const keepPass = existing?.password_enc ?? null;
    await upsertSmtp(q, next, { updatedBy, pass, keepPass });
    changed = true;
    changedKeys.push(...Object.keys(smtpPatch));
  }

  if (changed) await bumpRevision(q, updatedBy);
  return { changed, keys: [...new Set(changedKeys)], revision: await getRevision(q) };
}

export async function bumpRevision(q, updatedBy = null) {
  await q(
    `insert into app_meta (key, value, updated_at) values ($1, '1', now())
     on conflict (key) do update set value = (coalesce(app_meta.value, '0')::int + 1)::text, updated_at = now()`,
    [SETTINGS_REVISION_KEY],
  );
  void updatedBy;
}

export async function getRevision(q) {
  try {
    const r = await q('select value from app_meta where key = $1', [SETTINGS_REVISION_KEY]);
    return Number(r.rows[0]?.value ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function setupInfo(q) {
  try {
    const r = await q('select key, value from app_meta where key in ($1, $2)', [SETUP_COMPLETED_KEY, SETUP_BY_KEY]);
    const map = new Map(r.rows.map((x) => [x.key, x.value]));
    return {
      completed: Boolean(map.get(SETUP_COMPLETED_KEY)),
      completedAt: map.get(SETUP_COMPLETED_KEY) ?? null,
      completedBy: map.get(SETUP_BY_KEY) ?? null,
    };
  } catch {
    return { completed: false, completedAt: null, completedBy: null };
  }
}

export async function isSetupComplete(q, { fresh = false, ttlMs = 2000 } = {}) {
  if (!fresh && completedCache.value !== null && Date.now() - completedCache.at < ttlMs) {
    return completedCache.value;
  }
  const info = await setupInfo(q);
  completedCache = { value: info.completed, at: Date.now() };
  return info.completed;
}

export async function markSetupComplete(q, { by = null } = {}) {
  const at = new Date().toISOString();
  await q(
    `insert into app_meta (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SETUP_COMPLETED_KEY, at],
  );
  if (by) {
    await q(
      `insert into app_meta (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [SETUP_BY_KEY, String(by)],
    );
  }
  await bumpRevision(q, by);
  return at;
}

export async function countAdmins(q) {
  try {
    const r = await q("select count(*)::int as n from users where role = 'admin'");
    return Number(r.rows[0]?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function hasAdmin(q) {
  return (await countAdmins(q)) > 0;
}

// ---------------------------------------------------------------- env 导入 / 水合

/** 把当前环境变量里显式给出的旧配置导入数据库（只填空缺，不覆盖已有库值）。 */
export async function seedSettingsFromEnv(q, { env = process.env, secretKey = null, updatedBy = 'env-import' } = {}) {
  const key = secretKeyFor({ env, secretKey });
  const read = await readSettings(q, { env, secretKey: key });
  const patch = {};

  for (const d of SETTINGS) {
    if (d.store === 'smtp') continue;
    if (read.sources[d.key] === 'database') continue;
    const raw = envRawValue(d, env);
    if (raw == null) continue;
    const parsed = parseEnvValue(d, raw);
    if (!parsed.ok) continue;
    if (d.secret && parsed.value === '') continue;
    patch[d.key] = parsed.value;
  }

  const smtpRow = await readSmtpRow(q);
  if (!smtpRow) {
    const smtpHost = String(env.SMTP_HOST ?? '').trim();
    if (smtpHost) {
      patch['alerts.smtp.host'] = smtpHost;
      patch['alerts.smtp.port'] = Number(env.SMTP_PORT ?? 465);
      patch['alerts.smtp.secure'] = String(env.SMTP_SECURE ?? '1') !== '0';
      patch['alerts.smtp.user'] = String(env.SMTP_USER ?? '');
      patch['alerts.smtp.from'] = String(env.SMTP_FROM ?? '');
      if (String(env.SMTP_PASS ?? '') !== '') patch['alerts.smtp.pass'] = String(env.SMTP_PASS);
    }
  }

  if (!Object.keys(patch).length) return 0;
  const result = await saveSettings(q, patch, { updatedBy, env, secretKey: key });
  return result.keys.length;
}

function applySmtpEnv(env, read) {
  const smtp = read.smtp;
  if (!smtp.enabled) {
    env.SMTP_HOST = '';
    env.SMTP_PORT = String(smtp.port ?? 465);
    env.SMTP_SECURE = smtp.secure === false ? '0' : '1';
    env.SMTP_USER = '';
    env.SMTP_PASS = '';
    env.SMTP_FROM = '';
    return;
  }
  env.SMTP_HOST = smtp.host;
  env.SMTP_PORT = String(smtp.port);
  env.SMTP_SECURE = smtp.secure ? '1' : '0';
  env.SMTP_USER = smtp.user;
  env.SMTP_PASS = smtp.pass;
  env.SMTP_FROM = smtp.from;
}

/** 把库里的设置写回 process.env，让现有模块无需改读取逻辑。 */
export async function hydrateSettings({ store, logger = null, env = process.env, secretKey = null } = {}) {
  const q = (sql, p) => store.query(sql, p);
  const read = await readSettings(q, { env, secretKey });
  for (const d of SETTINGS) {
    if (d.store === 'smtp') continue;
    env[d.env] = valueToEnv(read.values[d.key]);
  }
  applySmtpEnv(env, read);
  // 子进程继承同一个密钥，避免各自生成 data/secret.key
  if (!env.SECRET_KEY || String(env.SECRET_KEY).length < 16) env.SECRET_KEY = read.secretKey;
  if (logger?.setLevel && LOG_LEVELS.includes(String(env.LOG_LEVEL ?? ''))) {
    logger.setLevel(String(env.LOG_LEVEL));
  }
  if (read.decryptErrors.length) {
    logger?.warn('settings.decrypt_failed', {
      keys: read.decryptErrors,
      hint: 'SECRET_KEY 可能已变化；请到控制台重新填写对应密钥',
    });
  }
  return read;
}

/**
 * 进程启动初始化：
 *   1. 建设置表
 *   2. 老部署如果已有管理员，自动导入 env 并标记初始化完成（不能把老用户拦到 /setup）
 *   3. 新部署保持未完成，交给 /setup
 *   4. 水合 env
 */
export async function initializeSettings({ store, logger = null, env = process.env, secretKey = null } = {}) {
  await ensureSettingsSchema(store);
  const usersReady = await hasTable((sql, p) => store.query(sql, p), 'users');
  if (usersReady) await ensureSmtpSchema(store);

  const q = (sql, p) => store.query(sql, p);
  const completed = await isSetupComplete(q, { fresh: true });
  const admins = usersReady ? await countAdmins(q) : 0;
  let migrated = false;
  let imported = 0;

  if (!completed && admins > 0) {
    imported = await seedSettingsFromEnv(q, { env, secretKey, updatedBy: 'migration' });
    await markSetupComplete(q, { by: 'migration:existing_admin' });
    migrated = true;
    logger?.info('settings.setup_migrated', { admins, imported, reason: 'existing_admin' });
  } else if (!completed) {
    imported = await seedSettingsFromEnv(q, { env, secretKey, updatedBy: 'env-import' });
    if (imported) logger?.info('settings.env_imported', { imported });
  }

  const read = await hydrateSettings({ store, logger, env, secretKey });
  const info = await setupInfo(q);
  return {
    completed: info.completed,
    migrated,
    imported,
    admins,
    values: read.values,
    sources: read.sources,
  };
}

/** 给测试/运维用：当前设置摘要，密钥打码。 */
export async function describeSettings(q, opts = {}) {
  const read = await readSettings(q, opts);
  return SETTINGS.map((d) => ({
    key: d.key,
    env: d.env,
    value: d.secret ? (read.values[d.key] ? '***' : '') : read.values[d.key],
    source: read.sources[d.key],
  }));
}

export { EMAIL_SCHEMA };
