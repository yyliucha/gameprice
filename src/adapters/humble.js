// Humble Store 适配器。
//
// Humble 的搜索接口被 Cloudflare 挡（403），搜索结果也不在 HTML 里，
// 所以这里用「按 slug 探测商品页 + JSON-LD 校验」的方式：
//   1. 由英文名生成候选 slug（cyberpunk-2077）
//   2. 抓商品页，解析 schema.org 的 JSON-LD（含 offers.price / priceCurrency）
//   3. **名称归一化后必须完全一致**才接受，否则跳过
//
// 代价是命中率取决于 slug 命名（实测 8 个里命中 4 个），
// 但绝不会把 A 游戏的价格记到 B 头上。
import { fetchText } from '../http.js';
import { normalizeTitle } from './gog.js';

export const descriptor = {
  code: 'humble',
  name: 'Humble Store',
  kind: 'authorized_reseller',
  defaultRegion: 'cn',
  currency: 'CNY',
};

const BASE = 'https://www.humblebundle.com/store/';

export const slugify = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** 候选 slug：原名，以及去掉副标题（冒号后的部分）的版本。 */
export function slugCandidates(title) {
  const full = slugify(title);
  const head = slugify(String(title ?? '').split(/[:–—-]/)[0]);
  return [...new Set([full, head].filter(Boolean))];
}

/** 从页面里取第一段带 offers 的 JSON-LD（Humble 用 Product/VideoGame）。 */
export function parseProductLd(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const offers = Array.isArray(item?.offers) ? item.offers[0] : item?.offers;
      if (item?.name && offers && offers.price != null) {
        return {
          name: item.name,
          url: item.url ?? offers.url ?? null,
          sku: item.sku ?? null,
          price: Number(offers.price),
          currency: offers.priceCurrency ?? null,
          availability: offers.availability ?? null,
        };
      }
    }
  }
  return null;
}

/** JSON-LD → RawOffer。steamAppid 由调用方注入，用于和已有游戏行合并。 */
export function toOffer(ld, { slug, steamAppid = null } = {}) {
  if (!ld || !Number.isFinite(ld.price)) return null;
  const priceCents = Math.round(ld.price * 100);
  return {
    platformCode: descriptor.code,
    platformProductId: ld.sku ?? slug,
    steamAppid,
    title: ld.name,
    productType: 'authorized_key',
    region: descriptor.defaultRegion,
    currency: ld.currency ?? descriptor.currency,
    priceCents,
    originalCents: priceCents, // JSON-LD 不含原价，不臆造折扣
    discountPct: 0,
    inStock: !ld.availability || /InStock/i.test(ld.availability),
    buyUrl: ld.url ?? `${BASE}${slug}`,
    meta: { slug, sku: ld.sku ?? null },
  };
}

/**
 * 按英文名查找。返回 { offer, tried }：tried 记录试过哪些 slug，
 * 便于事后解释"为什么没这家"。
 */
export async function searchOffer(title, { logger = null, fetchImpl, steamAppid = null } = {}) {
  const candidates = slugCandidates(title);
  const tried = [];

  for (const slug of candidates) {
    const url = `${BASE}${slug}`;
    try {
      const res = await fetchText(url, { logger, label: 'humble.product', fetchImpl, retries: 0, timeoutMs: 20000 });

      // 商品不存在时 Humble 会 302 到商店首页并返回 200（700KB+ 没有 JSON-LD）。
      // 不检查最终地址的话，会把「不存在」误当成「页面结构变了」。
      let finalPath = res.finalUrl;
      try {
        finalPath = new URL(res.finalUrl).pathname.replace(/\/+$/, '');
      } catch {
        /* 保留原值 */
      }
      if (finalPath && finalPath !== `/store/${slug}`) {
        tried.push({ slug, status: res.status, note: 'redirected', to: finalPath });
        logger?.debug('adapter.humble.redirected', { slug, to: finalPath });
        continue;
      }

      const ld = parseProductLd(res.body);
      if (!ld) {
        tried.push({ slug, status: res.status, note: 'no_jsonld' });
        logger?.debug('adapter.humble.no_jsonld', { slug, bytes: res.bytes });
        continue;
      }
      if (normalizeTitle(ld.name) !== normalizeTitle(title)) {
        tried.push({ slug, status: res.status, note: 'name_mismatch', got: ld.name });
        logger?.info('adapter.humble.name_mismatch', { query: title, slug, got: ld.name });
        continue;
      }
      const offer = toOffer(ld, { slug, steamAppid });
      logger?.debug('adapter.humble.matched', { query: title, slug, priceCents: offer?.priceCents });
      return { offer, tried };
    } catch (err) {
      // 404 属正常（这家店没这款游戏），不值得记 error
      const status = err.status ?? null;
      tried.push({ slug, status, note: status === 404 ? 'not_found' : 'error' });
      if (status !== 404) logger?.warn('adapter.humble.slug_failed', { slug, status, message: String(err.message).slice(0, 120) });
    }
  }

  logger?.info('adapter.humble.no_match', { query: title, tried: tried.map((t) => `${t.slug}:${t.note}`) });
  return { offer: null, tried };
}
