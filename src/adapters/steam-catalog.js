import { fetchJson } from '../http.js';

// Steam 全量应用目录：一次请求拿到所有 appid + 名称（约 20 万条，10MB 左右）。
// 这是唯一"一条请求换全量"的官方接口，避免逐条 appdetails 被限流。
export const descriptor = {
  code: 'steam-catalog',
  name: 'Steam 应用目录',
  // Steam WebAPI 的版本号是 v0002；写成 v2 会返回 404 Method not found
  endpoints: [
    'https://api.steampowered.com/ISteamApps/GetAppList/v0002/?format=json',
    'https://api.steampowered.com/ISteamApps/GetAppList/v0002/',
  ],
};

export async function fetchAppList({ logger = null } = {}) {
  let lastError = null;
  for (const url of descriptor.endpoints) {
    try {
      const data = await fetchJson(url, { logger });
      const apps = data?.applist?.apps ?? [];
      if (!apps.length) {
        lastError = new Error("接口返回 0 条：" + url);
        continue;
      }
      return apps
        .map((a) => ({ appid: Number(a.appid), name: String(a.name ?? "").trim() }))
        .filter((a) => Number.isFinite(a.appid) && a.appid > 0 && a.name);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("拉取 Steam 应用目录失败");
}
