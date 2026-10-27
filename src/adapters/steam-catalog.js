import { fetchJson } from '../http.js';

// Steam 全量应用目录。
// 注意：旧的 ISteamApps/GetAppList 已被 Valve 下线（返回 404 Method not found），
// 现在官方接口是 IStoreService/GetAppList，必须带 Web API Key。
export const descriptor = {
  code: 'steam-catalog',
  name: 'Steam 应用目录',
  endpoint: 'https://api.steampowered.com/IStoreService/GetAppList/v1/',
  keyPage: 'https://steamcommunity.com/dev/apikey',
};

/** 递归找到第一个"看起来像应用列表"的数组，避免依赖具体字段路径。 */
function findAppArray(node, depth = 0) {
  if (!node || depth > 5) return null;
  if (Array.isArray(node)) {
    const looks = node.some((x) => x && typeof x === "object" && (x.appid != null || x.app_id != null || x.id != null));
    return looks ? node : null;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) {
      const r = findAppArray(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export function hasApiKey(env = process.env) {
  return typeof env.STEAM_API_KEY === 'string' && env.STEAM_API_KEY.trim().length > 10;
}

/**
 * 拉取全量应用目录（分页，每次 5 万条）。
 * 返回 [{ appid, name }]
 */
export async function fetchAppList({ logger = null, env = process.env, onPage = null, maxPages = 40 } = {}) {
  if (!hasApiKey(env)) {
    const err = new Error(
      '需要 Steam Web API Key 才能拉取全量目录。免费申请：' + descriptor.keyPage + '，然后写入 .env 的 STEAM_API_KEY=...',
    );
    err.code = 'MISSING_STEAM_API_KEY';
    throw err;
  }
  const key = env.STEAM_API_KEY.trim();
  const all = [];
  let lastAppid = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      descriptor.endpoint +
      '?key=' + encodeURIComponent(key) +
      '&max_results=10000' +
      (lastAppid ? '&last_appid=' + lastAppid : '');
    // 单页 1 万条（约 1-2MB），放宽超时并允许重试，避免大响应被代理重置
    const data = await fetchJson(url, { logger, timeoutMs: 60000, retries: 2 });
    const resp = data?.response ?? {};
    const list = findAppArray(data) ?? [];
    if (!list.length && page === 0) {
      logger?.info('steam.catalog.shape', { topKeys: Object.keys(data ?? {}), sample: JSON.stringify(data ?? {}).slice(0, 400) });
    }
    for (const a of list) {
      const appid = Number(a.appid ?? a.app_id ?? a.id);
      const name = String(a.name ?? a.localized_name ?? a.app_name ?? '').trim();
      if (Number.isFinite(appid) && appid > 0) all.push({ appid, name });
    }
    if (onPage) onPage({ page: page + 1, total: all.length });
    if (!resp.have_more_results || !resp.last_appid) break;
    lastAppid = resp.last_appid;
  }
  logger?.info('steam.catalog.fetched', { total: all.length });
  return all;
}
