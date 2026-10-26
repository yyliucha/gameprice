// 杉果（sonkwo）适配器。
//
// 站点是 Remix。商品页服务端预渲染，并且页面里嵌了 window.__remixContext，
// 里面有结构化的 sale_price / list_price / sku_id / key_type —— 优先解析 JSON，
// 因为 DOM 的 class 名随时会改，JSON 结构相对稳定。
//
// 没有公开 API，也没有可用的搜索接口（store/search 的 loader 在服务端报错，
// /api/* 返回 410），所以 SKU 只能按 id 逐个抓。SKU 来源见 data/skus.json。
import { fetchText } from '../http.js';
import { descriptor as descriptorBase } from './steam.js';

export const descriptor = {
  code: 'sonkwo',
  name: '杉果',
  kind: 'authorized_reseller',
  defaultRegion: 'cn',
  currency: 'CNY',
  buyUrlBase: 'https://www.sonkwo.hk/sku/',
};

/** 从 HTML 里抠出 window.__remixContext = {...}; 的 JSON。 */
export function extractRemixContext(html) {
  const marker = 'window.__remixContext';
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const braceAt = html.indexOf('{', at);
  if (braceAt === -1) return null;
  // 括号配平，同时跳过字符串里的括号
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceAt; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = html.slice(braceAt, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const MAX_NODES = 30000;

/** 页面里 SKU 的标识有时是 sku_id，有时只有 id，两种都认。 */
const skuIdOf = (node) => {
  const v = node?.sku_id ?? node?.id;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 递归找"看起来像 SKU"的对象：有 id/sku_id，且带价格。 */
export function findSkuObjects(root, { maxNodes = MAX_NODES } = {}) {
  const out = [];
  let visited = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12 || visited > maxNodes) return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const id = skuIdOf(node);
    const sellable = node.sale_price != null || node.list_price != null || node.activity_price != null;
    if (id != null && sellable) out.push(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const toCents = (value) => {
  const n = typeof value === 'string' ? Number(value.replace(/[^\d.]/g, '')) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1].replace(/【[^】]*】/g, '').replace(/_杉果游戏.*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * 解析商品页 → 一条 RawOffer。priceSource 记录价格来自 JSON 还是 DOM，
 * 这条信息在排障时很关键（JSON 解析失败会退化成 DOM，需要知道）。
 */
export function parseSkuPage(html, { skuId, logger = null } = {}) {
  const wanted = Number(skuId);
  const context = extractRemixContext(html);
  if (!context) {
    logger?.warn('adapter.sonkwo.no_remix_context', { skuId, htmlBytes: html.length });
  }

  const candidates = context ? findSkuObjects(context) : [];
  logger?.debug('adapter.sonkwo.sku_candidates', {
    skuId,
    count: candidates.length,
    ids: candidates.slice(0, 10).map((c) => skuIdOf(c)),
  });

  let picked = candidates.find((c) => skuIdOf(c) === wanted) ?? candidates[0] ?? null;
  let priceSource = 'json';

  if (!picked) {
    // 退化路径：优先取"购买区"的价格块。页面顶部常先出现别的版本的价格，
    // 直接抓第一个 SKC-sale-price 会拿到错的数（实测就踩过这个坑）。
    const purchaseBlock = html.match(/SKC-sku-sale-block[\s\S]{0,600}?SKC-sale-price[^>]*>\s*￥?\s*([\d.]+)/);
    const anyPrice = html.match(/SKC-sale-price[^>]*>\s*￥?\s*([\d.]+)/);
    const domPrice = purchaseBlock ?? anyPrice;
    if (!domPrice) {
      logger?.error('adapter.sonkwo.no_price', { skuId, htmlBytes: html.length, title: titleOf(html) });
      return null;
    }
    priceSource = 'dom';
    picked = {
      id: wanted,
      sale_price: Number(domPrice[1]),
      sku_names: { chs: titleOf(html) },
    };
    logger?.warn('adapter.sonkwo.dom_fallback', {
      skuId,
      price: domPrice[1],
      matched: purchaseBlock ? 'purchase_block' : 'first_price',
    });
  }

  const salePriceCents = toCents(picked.sale_price ?? picked.activity_price);
  if (salePriceCents == null) {
    logger?.error('adapter.sonkwo.bad_price', { skuId, raw: picked.sale_price });
    return null;
  }
  const listPriceCents = toCents(picked.list_price);
  const originalCents = listPriceCents && listPriceCents > salePriceCents ? listPriceCents : salePriceCents;
  const discountPct = originalCents > 0 ? Math.round((1 - salePriceCents / originalCents) * 100) : 0;
  // 名称可能出现在 sku_name、sku_names.chs、rlt.sku_name 三处，取到哪个算哪个
  const chineseName =
    picked.sku_name ?? picked.sku_names?.chs ?? picked.rlt?.sku_name ?? titleOf(html) ?? null;
  const englishName = picked.sku_ename ?? picked.sku_names?.default ?? picked.rlt?.sku_ename ?? null;

  return {
    platformCode: descriptor.code,
    platformProductId: String(skuIdOf(picked) ?? wanted),
    steamAppid: null, // 杉果页面里没有 Steam appid，靠名称对齐（见 README 的映射说明）
    title: chineseName,
    productType: picked.key_type === 'steam_key' ? 'authorized_key' : (picked.key_type ?? 'authorized_key'),
    region: picked.region ?? descriptor.defaultRegion,
    currency: descriptor.currency,
    priceCents: salePriceCents,
    originalCents,
    discountPct,
    inStock: true,
    buyUrl: `${descriptor.buyUrlBase}${skuIdOf(picked) ?? wanted}`,
    meta: {
      nameEn: englishName,
      keyType: picked.key_type ?? null,
      productId: picked.product_id ?? null,
      area: picked.area ?? null,
      priceSource,
    },
  };
}

export async function fetchSku(skuId, { logger }) {
  const url = `${descriptor.buyUrlBase}${skuId}`;
  const log = (logger ?? console).child?.({ platform: descriptor.code, skuId }) ?? logger;
  const res = await fetchText(url, { logger: log, label: 'sonkwo.sku', retries: 2 });
  const offer = parseSkuPage(res.body, { skuId, logger: log });
  log?.info('adapter.sonkwo.sku_done', {
    skuId,
    ok: Boolean(offer),
    priceCents: offer?.priceCents ?? null,
    name: offer?.title ?? null,
    bytes: res.bytes,
    elapsedMs: res.elapsedMs,
  });
  return offer;
}

/**
 * 列表页（首页 / publisher_activity）是 DOM 渲染的，只能解析卡片。
 * 卡片标题有时用 game-name，有时用 title；价格有时用 SKC-sale-price，有时用 game-sale-price。
 * 这里不产出报价，只用于"看看有哪些游戏、价格多少"的辅助发现。
 */
export function parseListingCards(html) {
  const cards = [];
  const re =
    /class="(?:game-name|recommend-game-name|title)"[^>]*>([^<]{1,80})<\/[\s\S]{0,900}?class="(?:SKC-sale-price|game-sale-price)[^"]*"[^>]*>\s*￥?\s*([\d.]+)/g;
  for (const m of html.matchAll(re)) {
    const name = m[1].replace(/<[^>]+>/g, '').trim();
    const price = Number(m[2]);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    cards.push({ name, priceCents: Math.round(price * 100) });
  }
  return cards;
}
