import { fetchJson } from '../http.js';

// Steam 全量应用目录：一次请求拿到所有 appid + 名称（约 20 万条，10MB 左右）。
// 这是唯一"一条请求换全量"的官方接口，避免逐条 appdetails 被限流。
export const descriptor = {
  code: 'steam-catalog',
  name: 'Steam 应用目录',
  endpoint: 'https://api.steampowered.com/ISteamApps/GetAppList/v2/',
};

export async function fetchAppList({ logger = null } = {}) {
  const data = await fetchJson(descriptor.endpoint, { logger });
  const apps = data?.applist?.apps ?? [];
  return apps
    .map((a) => ({ appid: Number(a.appid), name: String(a.name ?? '').trim() }))
    .filter((a) => Number.isFinite(a.appid) && a.appid > 0 && a.name);
}
