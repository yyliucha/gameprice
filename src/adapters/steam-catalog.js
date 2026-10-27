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
      '&max_results=50000' +
      (lastAppid ? '&last_appid=' + lastAppid : '');
    const data = await fetchJson(url, { logger });
    const resp = data?.response ?? {};
    const apps = resp.applist?.apps ?? [];
    for (const a of apps) {
      const appid = Number(a.appid);
      const name = String(a.name ?? '').trim();
      if (Number.isFinite(appid) && appid > 0 && name) all.push({ appid, name });
    }
    if (onPage) onPage({ page: page + 1, total: all.length });
    if (!resp.have_more_results || !resp.last_appid) break;
    lastAppid = resp.last_appid;
  }
  logger?.info('steam.catalog.fetched', { total: all.length });
  return all;
}
