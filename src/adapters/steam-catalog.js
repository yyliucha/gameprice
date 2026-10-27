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
      '&max_results=10000' +
      (lastAppid ? '&last_appid=' + lastAppid : '');
    // 单页 1 万条（约 1-2MB），放宽超时并允许重试，避免大响应被代理重置
    const data = await fetchJson(url, { logger, timeoutMs: 60000, retries: 2 });
    const resp = data?.response ?? {};
    // 结构在不同版本/账号下不一致，按候选路径依次尝试
    const candidates = [
      resp.applist?.apps,
      resp.apps,
      data?.applist?.apps,
      data?.apps,
      resp.applist,
    ];
    const list = candidates.find((x) => Array.isArray(x)) ?? [];
    if (!list.length && page === 0) {
      logger?.info('steam.catalog.shape', { keys: Object.keys(resp), sample: JSON.stringify(resp).slice(0, 400) });
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
