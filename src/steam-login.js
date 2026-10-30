// Steam OpenID 登录 + 游戏库同步（独立于站点用户体系）。
// 登录不需要 API Key；游戏库需要 STEAM_API_KEY，且账号的"游戏详情"必须公开。
import { fetchText, fetchJson } from './http.js';
import { randomBytes } from 'node:crypto';
import { isPrivateAddress, matchesIpEntry } from './visitors.js';

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

/** 建表（幂等）。 */
export async function ensureSteamSchema(store) {
  const exec = (sql) => (store.exec ? store.exec(sql) : store.query(sql));
  await exec('alter table users add column if not exists steam_id text');
  await exec('create unique index if not exists users_steam_uniq on users (steam_id) where steam_id is not null');
  await exec([
    'create table if not exists steam_accounts (',
    '  steam_id text primary key,',
    '  persona_name text,',
    '  avatar text,',
    '  last_login_at timestamptz not null default now()',
    ');',
  ].join('\n'));
  await exec([
    'create table if not exists steam_sessions (',
    '  token text primary key,',
    '  steam_id text not null references steam_accounts(steam_id) on delete cascade,',
    '  created_at timestamptz not null default now()',
    ');',
  ].join('\n'));
  await exec([
    'create table if not exists steam_games (',
    '  steam_id text not null,',
    '  appid integer not null,',
    '  name text,',
    '  playtime_minutes integer not null default 0,',
    '  last_played_at timestamptz,',
    '  synced_at timestamptz not null default now(),',
    '  primary key (steam_id, appid)',
    ');',
  ].join('\n'));
}

let schemaEnsured = false;
/** 请求内懒建表：第一次调用执行 DDL，之后直接返回。 */
export async function ensureSteamSchemaOnce(q) {
  if (schemaEnsured) return;
  await ensureSteamSchema({ exec: (sql) => q(sql), query: (sql) => q(sql) });
  schemaEnsured = true;
}

export function baseUrl(req) {
  // 只信任可信反代传入的 X-Forwarded-*（防 Host/协议伪造影响 Steam 登录回调地址）
  const raw = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  const trustedEntries = String(process.env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const trusted =
    isPrivateAddress(raw) ||
    (process.env.TRUST_PROXY === '1' && trustedEntries.some((entry) => matchesIpEntry(raw, entry)));
  const host = trusted
    ? String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost')
    : String(req.headers.host ?? 'localhost');
  const proto = trusted
    ? String(req.headers['x-forwarded-proto'] ?? (req.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim()
    : req.socket?.encrypted
      ? 'https'
      : 'http';
  return proto + '://' + host;
}

/** 生成跳转到 Steam 的授权地址。 */
export function buildLoginUrl(base) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': base + '/api/auth/steam/callback',
    'openid.realm': base,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return OPENID_ENDPOINT + '?' + params.toString();
}

/** 用 Steam 校验回传参数，成功返回 steamid（17 位），失败返回 null。 */
export async function verifyCallback(url, { logger = null } = {}) {
  const params = new URLSearchParams(url.search);
  params.set('openid.mode', 'check_authentication');
  let text = '';
  const post = (extra) =>
    fetchText(OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeoutMs: 20000,
      retries: 1,
      logger,
      ...extra,
    });
  try {
    text = await post({});
  } catch (err) {
    // 代理可能把 steamcommunity 的连接重置：再直连试一次（国内直连有时反而通）
    logger?.warn('steam.openid_retry_direct', { message: String(err.message).slice(0, 120) });
    try {
      text = await post({ forceDirect: true, retries: 0 });
    } catch (err2) {
      logger?.warn('steam.openid_failed', { message: String(err2.message).slice(0, 160) });
      return null;
    }
  }
  if (!/is_valid\s*:\s*true/.test(text)) {
    logger?.warn('steam.openid_invalid', { snippet: String(text).slice(0, 120) });
    return null;
  }
  const claimed = String(url.searchParams.get('openid.claimed_id') ?? '');
  const m = /\/id\/(\d{17})$/.exec(claimed);
  if (!m) {
    logger?.warn('steam.openid_no_id', { claimed });
    return null;
  }
  logger?.info('steam.openid_ok', { steamId: m[1] });
  return m[1];
}

/** Steam 独立会话（与站点用户体系解耦）。 */
export async function createSteamSession(q, steamId) {
  const token = randomBytes(24).toString('base64url');
  await q('insert into steam_sessions (token, steam_id) values ($1, $2)', [token, steamId]);
  return token;
}

export async function steamIdBySession(q, token) {
  if (!token) return null;
  const r = await q('select steam_id from steam_sessions where token = $1', [token]);
  return r.rows[0]?.steam_id ?? null;
}

/** 拉取昵称头像（需要 API Key；没有 key 就用 steamid）。 */
export async function fetchPersona({ apiKey, steamId, logger = null }) {
  if (!apiKey) return { personaName: null, avatar: null };
  try {
    const url =
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=' +
      encodeURIComponent(apiKey) + '&steamids=' + encodeURIComponent(steamId);
    const res = await fetchJson(url, { logger, timeoutMs: 20000, retries: 1 });
    const data = res?.json ?? {};
    const p = data?.response?.players?.[0] ?? null;
    return { personaName: p?.personaname ?? null, avatar: p?.avatarfull ?? null };
  } catch (err) {
    logger?.warn('steam.persona_failed', { message: String(err.message).slice(0, 120) });
    return { personaName: null, avatar: null };
  }
}

/** 拉取账号拥有的游戏（需要 API Key）。 */
export async function fetchOwnedGames({ apiKey, steamId, logger = null }) {
  const url =
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/' +
    '?key=' + encodeURIComponent(apiKey) +
    '&steamid=' + encodeURIComponent(steamId) +
    '&include_appinfo=1&include_played_free_games=1&format=json';
  const res = await fetchJson(url, { logger, timeoutMs: 30000, retries: 1 });
  const data = res?.json ?? {};
  const games = data?.response?.games ?? [];
  return games
    .map((g) => ({
      appid: Number(g.appid),
      name: String(g.name ?? '').trim(),
      playtimeMinutes: Number(g.playtime_forever ?? 0),
      lastPlayedAt: g.rtime_last_played ? new Date(g.rtime_last_played * 1000) : null,
    }))
    .filter((g) => Number.isFinite(g.appid) && g.appid > 0);
}
