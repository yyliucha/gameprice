// Steam 游戏元数据：名字 / 类型 / 封面 / 发行日期 / 开发商。
//
// 两个后端，同一套归一化输出：
//   1. official  —— Steam 官方接口（`store.steampowered.com/api/appdetails`，filters=basic）
//      优点：能拿到按语言本地化的名字与 is_free；缺点：很多网络环境访问不到
//   2. steamcmd  —— api.steamcmd.net（Steam PICS 数据的第三方镜像）
//      优点：可达性好，`name_localized.schinese` 能给出中文名、header_image 带简体封面；
//            缺点：拿不到 is_free，也不能按名字搜索
//
// `backend: 'auto'` 会先探官方（短超时），失败再回落镜像，并把实际用的后端记进日志。
import { fetchJson } from '../http.js';

// Steam 官方分类 id → 中文名。只收录确定的那几个，未知 id 原样保留为 genre:<id>，
// 宁可显示得少，也不瞎猜名字（Steam 的分类 id 表不是公开稳定的文档）。
export const GENRES = {
  1: '动作',
  2: '策略',
  3: '角色扮演',
  4: '休闲',
  5: '竞速',
  6: '体育',
  25: '冒险',
  28: '模拟',
};

/**
 * Steam 商店按语言返回本地化日期（中文区是 "2017 年 9 月 15 日"），
 * 数据库 release_date 是 date 类型，必须先转成 YYYY-MM-DD，解析不了就存 null。
 */
export function parseReleaseDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text || /coming soon|即将推出|待定|tba/i.test(text)) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return iso[0];
  const cn = /(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/.exec(text);
  if (cn) {
    const y = cn[1];
    const m = String(cn[2]).padStart(2, '0');
    const d = String(cn[3] ?? '1').padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (us) {
    const m = String(us[1]).padStart(2, '0');
    const d = String(us[2]).padStart(2, '0');
    return us[3] + '-' + m + '-' + d;
  }
  return null;
}

export function genreName(id) {
  return GENRES[Number(id)] ?? `genre:${id}`;
}

export const descriptor = { code: 'steam', name: 'Steam 元数据' };

const OFFICIAL_DETAILS = 'https://store.steampowered.com/api/appdetails';
const STEAMCMD_BASE = 'https://api.steamcmd.net/v1/info/';
const CDN = 'https://cdn.akamai.steamstatic.com/steam/apps/';

/** 从 Steam 商店链接或纯数字里提取 appid。 */
export function extractAppId(input) {
  const text = String(input ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const m = text.match(/store\.steampowered\.com\/app\/(\d+)/i) || text.match(/\bapp\/(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

const toDate = (unixSeconds) => {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
};

/** 官方 appdetails(basic) 条目 → 归一化元数据。 */
export function normalizeOfficial(appid, data) {
  if (!data) return null;
  return {
    steamAppid: Number(appid),
    nameEn: null, // 官方接口按 l 参数返回一种语言，中文请求下拿不到英文名
    nameZh: data.name ?? null,
    appType: data.type ?? null,
    isFree: data.is_free ?? null,
    headerImage: data.header_image ?? null,
    releaseDate: parseReleaseDate(data.release_date?.date ?? null),
    developers: data.developers ?? null,
    publishers: data.publishers ?? null,
    genres: Array.isArray(data.genres) ? data.genres.map((g) => g.description).filter(Boolean) : null,
    // 商店简介：去标签后存纯文本（后台可编辑，Steam 同步只在为空时填）
    description: (function(raw){
      if(!raw) return null;
      return String(raw).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "\x27").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
    })(data.short_description || data.detailed_description || ""),
    tags: null,
    source: 'official',
    // 完整 appdetails 会带 price_overview：Steam 自身价格（国内可达时就能用）
    priceOverview: data.price_overview
      ? {
          final: data.price_overview.final,
          initial: data.price_overview.initial,
          discountPercent: data.price_overview.discount_percent,
          currency: data.price_overview.currency,
        }
      : null,
  };
}

/** steamcmd PICS 条目 → 归一化元数据。 */
export function normalizeSteamcmd(appid, app) {
  const common = app?.common;
  if (!common) return null;
  const localized = common.name_localized ?? {};
  const zh = localized.schinese ?? localized.sc_schinese ?? localized.tchinese ?? null;
  const header = common.header_image ?? {};
  const headerFile = header.schinese ?? header.english ?? null;
  let devs = Object.values(common.associations ?? {})
    .filter((a) => a?.type === 'developer')
    .map((a) => a.name)
    .filter(Boolean);
  let pubs = Object.values(common.associations ?? {})
    .filter((a) => a?.type === 'publisher')
    .map((a) => a.name)
    .filter(Boolean);
  // 有些条目只有 extended 里的字符串
  if (!devs.length && app?.extended?.developer) devs = [app.extended.developer];
  if (!pubs.length && app?.extended?.publisher) pubs = [app.extended.publisher];

  const genreIds = Object.values(common.genres ?? {});
  const genres = genreIds.length ? [...new Set(genreIds.map(genreName))] : null;
  // 商店标签在 PICS 数据里只有数字 id，没有名字
  const tagIds = Object.values(common.store_tags ?? {});
  const tags = tagIds.length ? [...new Set(tagIds.map((id) => `tag:${id}`))] : null;

  return {
    steamAppid: Number(appid),
    nameEn: common.name ?? null,
    nameZh: zh,
    appType: common.type ?? null,
    isFree: null, // PICS 数据里没有可靠的免费标记
    headerImage: headerFile ? `${CDN}${appid}/${headerFile}` : null,
    releaseDate: parseReleaseDate(toDate(common.steam_release_date)),
    developers: devs.length ? [...new Set(devs)] : null,
    publishers: pubs.length ? [...new Set(pubs)] : null,
    genres,
    tags,
    source: 'steamcmd',
  };
}

/** 探一下官方接口通不通（短超时，不重试）。 */
export async function probeOfficial({ fetchImpl = globalThis.fetch, logger = null, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchImpl(`${OFFICIAL_DETAILS}?appids=730&filters=basic`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'gameprice/0.1' },
    });
    const ok = res.ok;
    logger?.info('steam.probe', { official: ok, status: res.status });
    return ok;
  } catch (err) {
    logger?.info('steam.probe', { official: false, error: String(err.message).slice(0, 120) });
    return false;
  }
}

async function fetchOfficial(appids, { logger, fetchImpl }) {
  const items = [];
  // 注意：appdetails 一次只能查一个 appid，传逗号列表会返回 400（实测）
  for (const appid of appids) {
    const url = `${OFFICIAL_DETAILS}?appids=${appid}&cc=cn&l=schinese`;
    try {
      const { json } = await fetchJson(url, { logger, label: 'steam.meta.official', fetchImpl, retries: 1, timeoutMs: 20000 });
      const entry = json?.[String(appid)];
      if (entry?.success && entry.data) {
        const item = normalizeOfficial(appid, entry.data);
        if (item) items.push(item);
      } else {
        logger?.warn('steam.meta.missing', { appid, backend: 'official' });
      }
    } catch (err) {
      logger?.warn('steam.meta.failed', { appid, backend: 'official', message: String(err.message).slice(0, 120) });
    }
  }
  return items;
}

async function fetchSteamcmd(appids, { logger, fetchImpl }) {
  const items = [];
  for (const appid of appids) {
    const url = `${STEAMCMD_BASE}${appid}`;
    try {
      const { json } = await fetchJson(url, { logger, label: 'steam.meta.steamcmd', fetchImpl, retries: 1, timeoutMs: 20000 });
      const app = json?.data?.[String(appid)];
      const item = normalizeSteamcmd(appid, app);
      if (item) items.push(item);
      else logger?.warn('steam.meta.missing', { appid, backend: 'steamcmd', status: json?.status });
    } catch (err) {
      logger?.warn('steam.meta.failed', { appid, backend: 'steamcmd', message: String(err.message).slice(0, 120) });
    }
  }
  return items;
}

/**
 * 取元数据。backend: 'auto' | 'official' | 'steamcmd'
 * auto 会先探官方，不通则回落镜像（并记录实际后端，便于排障）。
 */
export async function fetchMetadata(appids, { backend = 'auto', logger = null, fetchImpl = null } = {}) {
  const unique = [...new Set((appids ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!unique.length) return { backend: null, items: [] };

  let chosen = backend;
  if (chosen === 'auto') {
    const ok = await probeOfficial({ fetchImpl: fetchImpl ?? globalThis.fetch, logger });
    chosen = ok ? 'official' : 'steamcmd';
  }

  const items =
    chosen === 'official'
      ? await fetchOfficial(unique, { logger, fetchImpl: fetchImpl ?? undefined })
      : await fetchSteamcmd(unique, { logger, fetchImpl: fetchImpl ?? undefined });

  logger?.info('steam.meta.done', { backend: chosen, requested: unique.length, got: items.length });
  return { backend: chosen, items };
}
