// 后台回填任务的参数归一化 / 命令行拼装 / 进度解析（纯函数，便于单测）。
//
// 控制台「数据回填」卡片和 `/api/admin/backfill*` 共用这里的规则，
// 避免前端传什么后端就跑什么（limit 上限 20 万、sleep 上限 60 秒等）。

export const BACKFILL_LIMITS = {
  limit: { min: 1, max: 200000, def: 200000 },
  batch: { min: 1, max: 100, def: 100 },
  sleep: { min: 0, max: 60000, def: 3000 },
  fallback: { min: 0, max: 100, def: 10 },
};

/** 把请求体里的 limit/batch/sleep/fallback 收敛到安全范围；非法值回落默认值。 */
export function normalizeBackfillParams(body = {}) {
  const pick = (value, { min, max, def }) => {
    // null/undefined/空串视为「没传」，回落默认值；显式 0 仍按 0 处理再 clamp
    if (value === null || value === undefined || value === '') return def;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
  };
  return {
    limit: pick(body.limit, BACKFILL_LIMITS.limit),
    batch: pick(body.batch, BACKFILL_LIMITS.batch),
    sleep: pick(body.sleep, BACKFILL_LIMITS.sleep),
    fallback: pick(body.fallback, BACKFILL_LIMITS.fallback),
  };
}

/** 子进程参数：node src/cli.js backfill --limit … --batch … --sleep … --fallback … */
export function backfillArgs(params) {
  return [
    'src/cli.js',
    'backfill',
    '--limit', String(params.limit),
    '--batch', String(params.batch),
    '--sleep', String(params.sleep),
    '--fallback', String(params.fallback),
  ];
}

// CLI 每批输出的一行：`  批次 3：本批 100 款，写入 100，回退 0，失败 0；累计 300/200000（660 款/分钟）`
const BATCH_LINE = /批次\s+(\d+)：本批\s+(\d+)\s*款，写入\s+(\d+)，回退\s+(\d+)，失败\s+(\d+)；累计\s+(\d+)\/(\d+)（(\d+)\s*款\/分钟）/;

/** 从子进程输出尾巴里取最后一条批次进度；没有则返回 null。 */
export function parseBackfillProgress(output) {
  const text = String(output ?? '');
  const re = new RegExp(BATCH_LINE.source, 'g');
  let last = null;
  for (const m of text.matchAll(re)) last = m;
  if (!last) return null;
  const done = Number(last[6]);
  const limit = Number(last[7]);
  return {
    batches: Number(last[1]),
    batchSize: Number(last[2]),
    written: Number(last[3]),
    fallback: Number(last[4]),
    failed: Number(last[5]),
    done,
    limit,
    ratePerMin: Number(last[8]),
    percent: limit > 0 ? Math.min(100, Math.round((done / limit) * 1000) / 10) : 0,
  };
}

// ---------------------------------------------------------------- GetItems → 报价

/**
 * GetItems 没带价格（preview 缺失/字段变化）的 appid，用于回退 appdetails 批量取价。
 * 同一批里去重，忽略没有 appid 的条目。
 */
export function missingPriceAppids(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const appid = Number(item?.steamAppid);
    if (!Number.isFinite(appid) || appid <= 0) continue;
    if (item.priceOverview) continue;
    if (seen.has(appid)) continue;
    seen.add(appid);
    out.push(appid);
  }
  return out;
}

/** 把 GetItems 自带的价格转成 RawOffer（与 syncPrices 的输出结构一致）。 */
export function offerFromItem(item) {
  const p = item?.priceOverview;
  const appid = Number(item?.steamAppid);
  if (!p || !Number.isFinite(appid) || appid <= 0) return null;
  return {
    platformCode: 'steam',
    platformProductId: String(appid),
    steamAppid: appid,
    title: item.nameZh ?? item.nameEn ?? String(appid),
    productType: 'official_direct',
    region: 'cn',
    currency: p.currency ?? 'CNY',
    priceCents: Math.round(p.final),
    originalCents: Math.round(p.initial ?? p.final),
    discountPct: Number(p.discountPercent ?? 0),
    inStock: true,
    buyUrl: 'https://store.steampowered.com/app/' + appid + '/',
    meta: {},
  };
}

/** 合并 GetItems 自带报价 + appdetails 回退报价（同一 appid 只保留一条，避免重复写）。 */
export function mergePriceOffers(items = [], fallbackOffers = []) {
  const offers = [];
  const seen = new Set();
  for (const item of items) {
    const offer = offerFromItem(item);
    if (!offer) continue;
    seen.add(String(offer.steamAppid));
    offers.push(offer);
  }
  for (const offer of fallbackOffers) {
    if (!offer || !Number.isFinite(Number(offer.steamAppid))) continue;
    const key = String(offer.steamAppid);
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push(offer);
  }
  return offers;
}
