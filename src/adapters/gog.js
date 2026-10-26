// GOG 适配器。
//
// 用官方商店前端所用的 catalog 接口：`catalog.gog.com/v1/catalog`
// 返回 JSON 里直接带 CNY 价格（price.finalMoney），不需要解析页面。
//
// 关键约束：`query=like:<title>` 是**模糊匹配**。实测搜 "elden ring" 会返回
// Whispers in the Moss 之类完全无关的商品（GOG 并不卖艾尔登法环）。
// 所以这里只接受标题归一化后**完全相等**的结果，否则宁可返回 null——
// 把别人的价格挂到这款游戏上，比没有价格糟糕得多。
import { fetchJson } from '../http.js';

export const descriptor = {
  code: 'gog',
  name: 'GOG',
  kind: 'authorized_reseller',
  defaultRegion: 'cn',
  currency: 'CNY',
};

const BASE = 'https://catalog.gog.com/v1/catalog';

/** 标题归一化：大小写、标点、罗马数字与空格都不参与比较。 */
export function normalizeTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[®™©]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// 同一款游戏在 GOG 可能有 game / pack（终极版）两种产品，优先基础游戏
const TYPE_PRIORITY = { game: 0, pack: 1, dlc: 2 };

export function pickExactMatch(products, title) {
  const want = normalizeTitle(title);
  if (!want) return null;
  const exact = (products ?? []).filter((p) => normalizeTitle(p.title) === want);
  if (!exact.length) return null;
  return exact.sort((a, b) => (TYPE_PRIORITY[a.productType] ?? 9) - (TYPE_PRIORITY[b.productType] ?? 9))[0];
}

export function buildSearchUrl(title, { country = 'CN', currency = 'CNY', limit = 20, locale = 'en-US' } = {}) {
  const url = new URL(BASE);
  url.searchParams.set('query', `like:${title}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('countryCode', country);
  url.searchParams.set('currencyCode', currency);
  url.searchParams.set('locale', locale);
  return url.toString();
}

const toCents = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** catalog 产品 → RawOffer；价格缺失时返回 null。 */
export function toOffer(product, { title = null, steamAppid = null } = {}) {
  const price = product?.price?.finalMoney;
  const base = product?.price?.baseMoney;
  const priceCents = toCents(price?.amount);
  if (priceCents == null) return null;
  const originalCents = toCents(base?.amount) ?? priceCents;
  // 注意：finalMoney.discount 是"省了多少钱"（如 209），不是百分比，不能用它算折扣。
  // 折扣必须由 final/base 自己算。
  const discountPct = originalCents > 0 ? Math.max(0, Math.round((1 - priceCents / originalCents) * 100)) : 0;
  return {
    platformCode: descriptor.code,
    platformProductId: String(product.id),
    steamAppid,
    title: product.title ?? title,
    productType: product.productType === 'game' ? 'authorized_key' : 'authorized_pack',
    region: descriptor.defaultRegion,
    currency: price?.currency ?? descriptor.currency,
    priceCents,
    originalCents,
    discountPct,
    inStock: product.productState !== 'notAvailable',
    buyUrl: product.storeLink ?? `https://www.gog.com/en/game/${product.slug}`,
    meta: {
      gogId: product.id,
      slug: product.slug,
      productType: product.productType,
      releaseDate: product.releaseDate ?? null,
    },
  };
}

/**
 * 按英文名查询。返回 { offer, candidates } —— candidates 用于日志复盘
 * （"为什么没匹配上"必须有据可查）。
 */
export async function searchOffer(
  title,
  { logger = null, fetchImpl, country = 'CN', currency = 'CNY', limit = 20, steamAppid = null } = {},
) {
  const url = buildSearchUrl(title, { country, currency, limit });
  // GOG catalog 偶尔很慢（实测有过 18s），单独放宽超时
  const { json } = await fetchJson(url, { logger, label: 'gog.catalog', fetchImpl, timeoutMs: 30000 });
  const products = json?.products ?? [];
  const picked = pickExactMatch(products, title);

  if (!picked) {
    logger?.info('adapter.gog.no_exact_match', {
      query: title,
      candidates: products.slice(0, 6).map((p) => p.title),
      total: products.length,
    });
    return { offer: null, candidates: products.length };
  }

  const offer = toOffer(picked, { title, steamAppid });
  if (!offer) {
    logger?.warn('adapter.gog.no_price', { title: picked.title, id: picked.id });
    return { offer: null, candidates: products.length };
  }
  logger?.debug('adapter.gog.matched', {
    query: title,
    matched: picked.title,
    productType: picked.productType,
    priceCents: offer.priceCents,
  });
  return { offer, candidates: products.length };
}
