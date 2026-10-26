// IsThereAnyDeal 官方 API 适配器。
//
// 条款要点（docs.isthereanydeal.com）：可商用但不得与 ITAD 竞争、不得改价或
// 去掉联盟参数、必须标注来源、私有非个人用途需申请。个人自用免费。
//
// 需要的环境变量：ITAD_API_KEY
// 未配置时不报错，只记一条 warn 并跳过——避免整条流水线因为一个可选源挂掉。
import { fetchJson } from '../http.js';

export const descriptor = {
  code: 'itad',
  name: 'IsThereAnyDeal',
  kind: 'authorized_reseller',
  defaultRegion: 'cn',
  buyUrlBase: 'https://isthereanydeal.com/',
};

const BASE = 'https://api.isthereanydeal.com';

// ITAD 里的 Steam 商店，归并到我们自己的 steam 平台
const SHOP_ALIAS = { Steam: 'steam', GOG: 'gog', Fanatical: 'fanatical', Humble: 'humble' };

export function platformForShop(shop) {
  const known = SHOP_ALIAS[shop?.name];
  if (known) return { code: known, name: shop.name, kind: known === 'steam' ? 'official' : 'authorized_reseller' };
  return {
    code: `itad_${shop?.id ?? 'unknown'}`,
    name: shop?.name ?? 'ITAD shop',
    kind: 'authorized_reseller',
  };
}

const toCents = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** GET /games/search/v1 → [{id, slug, title, type}] */
export async function searchGame(title, { apiKey, logger, country = 'CN' }) {
  const url = `${BASE}/games/search/v1?title=${encodeURIComponent(title)}&key=${apiKey}`;
  const { json } = await fetchJson(url, { logger, label: 'itad.search' });
  if (!Array.isArray(json)) {
    logger?.error('adapter.itad.shape_mismatch', { step: 'search', keys: Object.keys(json ?? {}).slice(0, 10) });
    return [];
  }
  return json;
}

/**
 * POST /games/prices/v3?country=CN  body: ["<gameId>", ...]
 * 返回每款游戏的 deals[]，每条 deal 是一个商店的当前价。
 */
export async function fetchPrices(gameIds, { apiKey, logger, country = 'CN' }) {
  const url = `${BASE}/games/prices/v3?key=${apiKey}&country=${country}`;
  const { json } = await fetchJson(url, {
    logger,
    label: 'itad.prices',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(gameIds),
  });
  if (!Array.isArray(json)) {
    logger?.error('adapter.itad.shape_mismatch', {
      step: 'prices',
      keys: Object.keys(json ?? {}).slice(0, 10),
      bodySnippet: JSON.stringify(json).slice(0, 300),
    });
    return [];
  }
  return json;
}

/**
 * 把 ITAD 的 deal 摊平成我们的 RawOffer。
 * 一条 deal 带上它所属的平台（每家商店独立成一个 platform），
 * 这样主榜能显示"哪个店最便宜"，而不是笼统的 "ITAD"。
 */
export function normalizeDeals(games, { logger = null } = {}) {
  const offers = [];
  let skipped = 0;
  for (const game of games) {
    const deals = Array.isArray(game?.deals) ? game.deals : [];
    if (!deals.length) {
      skipped += 1;
      logger?.debug('adapter.itad.no_deals', { gameId: game?.id, title: game?.title });
      continue;
    }
    for (const deal of deals) {
      const priceCents = toCents(deal?.price?.amount);
      if (priceCents == null) {
        skipped += 1;
        continue;
      }
      const shop = deal.shop ?? {};
      const shopPlatform = platformForShop(shop);
      offers.push({
        platform: shopPlatform,
        platformCode: shopPlatform.code,
        platformProductId: String(game.id),
        steamAppid: null,
        title: game.title ?? null,
        productType: 'authorized_key',
        region: 'cn',
        currency: deal.price?.currency ?? 'CNY',
        priceCents,
        originalCents: toCents(deal.regular?.amount) ?? priceCents,
        discountPct: Number(deal.cut ?? 0),
        inStock: true,
        buyUrl: deal.url ?? null,
        meta: { itadGameId: game.id, shopId: shop.id, shopName: shop.name, drm: deal.drm ?? null },
      });
    }
  }
  return { offers, skipped };
}
