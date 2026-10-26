// 杉果 SKU 自动发现。
//
// 背景：杉果没有可用的搜索接口（loader 服务端报错、/api/* 已下线 410），
// 商品页只暴露自己的 sku_id，活动页卡片没有 id。实测的唯一可靠路径是
// **按 sku id 顺序探测**：id 连续、密度约 70%，未上架/已下架的 id 会返回
// 200 的空壳页（无价格），可用解析结果区分。
//
// 因此策略是"从前沿向后扫"，连续 N 个空壳就认为到头了：
//   已知最大 id 111491 → 扫 111489..111608 → 111492 起连续空壳 → 提前停
// 这样每天只需几十次请求就能跟上新上架，而不必扫描整个 id 空间。
import { sleep } from '../http.js';

export const DEFAULT_STATE = { highWaterMark: 0, lastRunAt: null, totalFound: 0 };

/**
 * 计算出本轮扫描区间。
 * 起点取「已知最大 id」与「上次扫描水位」的较大者，向前留一点重叠，
 * 以便捕捉"上架晚于相邻 id"的商品。
 */
export function planScan({ knownMax = 0, state = {}, ahead = 120, overlap = 3 } = {}) {
  const hwm = Number(state?.highWaterMark ?? 0) || 0;
  const start = Math.max(Number(knownMax) || 0, hwm);
  if (start <= 0) return null;
  const from = Math.max(1, start - overlap + 1);
  return { from, to: from + Math.max(1, ahead) - 1 };
}

/**
 * 逐个探测 id。fetchSku(id) 应返回 offer 或 null（空壳），404/异常都按空壳处理。
 * 连续 stopAfterMisses 个空壳就停：后面基本是未上架区间，继续扫只是浪费请求。
 */
export async function discoverSkus({
  from,
  to,
  fetchSku,
  rate = 1200,
  stopAfterMisses = 15,
  logger = null,
  onHit = null,
} = {}) {
  const found = [];
  const misses = [];
  let consecutive = 0;
  let probed = 0;
  let stopReason = 'range_end';

  for (let id = from; id <= to; id += 1) {
    probed += 1;
    let offer = null;
    let error = null;
    try {
      offer = await fetchSku(id);
    } catch (err) {
      error = err;
      if (err.status && err.status !== 404) {
        logger?.warn('discover.probe_failed', { skuId: id, status: err.status, message: String(err.message).slice(0, 120) });
      }
    }

    if (offer) {
      consecutive = 0;
      const item = { skuId: id, name: offer.title ?? null, priceCents: offer.priceCents ?? null };
      found.push(item);
      onHit?.(item);
      logger?.debug('discover.hit', item);
    } else {
      misses.push(id);
      consecutive += 1;
      logger?.trace?.('discover.miss', { skuId: id, reason: error ? 'error' : 'shell' });
      if (consecutive >= stopAfterMisses) {
        stopReason = 'consecutive_misses';
        logger?.info('discover.stop_early', { skuId: id, consecutive, stopAfterMisses });
        break;
      }
    }

    if (id < to) await sleep(rate);
  }

  const result = { from, to, probed, found, misses, stopReason };
  logger?.info('discover.done', {
    from,
    to,
    probed,
    found: found.length,
    misses: misses.length,
    stopReason,
  });
  return result;
}

/** 合并到 data/skus.json：按 skuId 去重，保留已有 appid 映射，补全缺失名称。 */
export function mergeSkuEntries(existing = [], found = []) {
  const map = new Map();
  for (const entry of existing) {
    const id = Number(entry.skuId ?? entry.sku);
    if (Number.isFinite(id)) map.set(id, { ...entry, skuId: id });
  }
  let added = 0;
  let named = 0;
  for (const item of found) {
    const id = Number(item.skuId);
    if (!Number.isFinite(id)) continue;
    const current = map.get(id);
    if (!current) {
      map.set(id, { skuId: id, appid: item.appid ?? null, name: item.name ?? null });
      added += 1;
    } else if (!current.name && item.name) {
      map.set(id, { ...current, name: item.name });
      named += 1;
    }
  }
  const entries = [...map.values()].sort((a, b) => a.skuId - b.skuId);
  return { entries, added, named, total: entries.length };
}
