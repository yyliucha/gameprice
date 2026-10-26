import { fetchJson, sleep } from '../http.js';

// 一平台一个适配器，统一吐 RawOffer：
// { platformCode, platformProductId, steamAppid, title, productType, region,
//   currency, priceCents, originalCents, discountPct, inStock, buyUrl, meta }
export const descriptor = {
  code: 'steam',
  name: 'Steam 国区',
  kind: 'official',
  defaultRegion: 'cn',
  currency: 'CNY',
  buyUrlBase: 'https://store.steampowered.com/app/',
};

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function buildAppDetailsUrl(appids, opts = {}) {
  const { region = descriptor.defaultRegion, lang = 'schinese', filters = 'price_overview' } = opts;
  const url = new URL('https://store.steampowered.com/api/appdetails');
  url.searchParams.set('appids', appids.join(','));
  url.searchParams.set('cc', region);
  url.searchParams.set('l', lang);
  if (filters) url.searchParams.set('filters', filters);
  return url.toString();
}

/**
 * 解析 appdetails 响应。
 * 注意：用 filters=price_overview 时免费游戏和区域锁定游戏都不会有 price_overview，
 * 这两种都记为 skipped，不产生报价——免费游戏没有比价价值。
 */
export function parseAppDetails(payload, ctx = {}) {
  const { region = descriptor.defaultRegion, platformCode = descriptor.code } = ctx;
  const offers = [];
  const skipped = [];

  for (const [key, entry] of Object.entries(payload || {})) {
    const appid = Number(key);
    if (!entry || entry.success !== true || !entry.data) {
      skipped.push({ appid, reason: 'not_found_or_region_locked' });
      continue;
    }
    const data = entry.data;
    const price = data.price_overview;
    if (!price) {
      skipped.push({ appid, reason: data.is_free ? 'free' : 'no_price_overview' });
      continue;
    }
    offers.push({
      platformCode,
      platformProductId: String(appid),
      steamAppid: appid,
      title: data.name ?? null,
      productType: 'official_direct',
      region,
      currency: price.currency || descriptor.currency,
      priceCents: Number(price.final),
      originalCents: Number(price.initial),
      discountPct: Number(price.discount_percent ?? 0),
      inStock: true,
      buyUrl: `${descriptor.buyUrlBase}${appid}/`,
      meta: {
        appType: data.type ?? null,
        isFree: Boolean(data.is_free),
        headerImage: data.header_image ?? null,
      },
    });
  }
  return { offers, skipped };
}

/**
 * 批量拉价格。appdetails 支持逗号分隔多个 appid，单批数量保守取 30。
 * 默认每批之间停 1.1s，约等于 1 请求/秒。
 */
export async function syncPrices(opts = {}) {
  const {
    appids,
    fetchImpl,
    logger = null,
    region = descriptor.defaultRegion,
    lang = 'schinese',
    batchSize = 30,
    rateLimitMs = 1100,
    log = () => {},
  } = opts;

  const unique = [...new Set(appids.map(Number).filter(Number.isFinite))];
  const batches = chunk(unique, batchSize);
  const result = { offers: [], skipped: [], requests: 0, bytes: 0 };

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const url = buildAppDetailsUrl(batch, { region, lang });
    const { json, bytes } = await fetchJson(url, { fetchImpl, logger, label: 'steam.appdetails' });
    const parsed = parseAppDetails(json, { region });
    result.offers.push(...parsed.offers);
    result.skipped.push(...parsed.skipped);
    result.requests += 1;
    result.bytes += bytes;
    logger?.info('adapter.steam.batch', {
      batch: i + 1,
      batches: batches.length,
      appids: batch.length,
      offers: parsed.offers.length,
      skipped: parsed.skipped.length,
      bytes,
    });
    log(`[steam] 批次 ${i + 1}/${batches.length} appids=${batch.length} 有效报价=${parsed.offers.length} 跳过=${parsed.skipped.length}`);
    if (i < batches.length - 1) await sleep(rateLimitMs);
  }
  return result;
}

/** 只取元数据（名字/类型/封面），给新加的游戏补名字用。 */
export async function syncMeta(opts = {}) {
  const { appids, fetchImpl, logger = null, batchSize = 20, rateLimitMs = 1100, log = () => {} } = opts;
  const unique = [...new Set(appids.map(Number).filter(Number.isFinite))];
  const batches = chunk(unique, batchSize);
  const metas = [];
  for (let i = 0; i < batches.length; i += 1) {
    const url = buildAppDetailsUrl(batches[i], { filters: 'basic' });
    const { json } = await fetchJson(url, { fetchImpl, logger, label: 'steam.appdetails.meta' });
    for (const [key, entry] of Object.entries(json || {})) {
      if (!entry || entry.success !== true || !entry.data) continue;
      const d = entry.data;
      metas.push({
        steamAppid: Number(key),
        name: d.name ?? null,
        appType: d.type ?? null,
        isFree: Boolean(d.is_free),
        headerImage: d.header_image ?? null,
        releaseDate: d.release_date?.date ?? null,
      });
    }
    log(`[steam:meta] 批次 ${i + 1}/${batches.length}`);
    if (i < batches.length - 1) await sleep(rateLimitMs);
  }
  return metas;
}
