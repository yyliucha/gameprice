// 入库：把适配器吐出来的 RawOffer 写进 PG。
//
// 两条规矩：
//   1. 同一 (游戏, 平台, 渠道类型, 区服) 只保留一条当前报价
//   2. 价格/折扣/库存没变就不写快照 —— 否则每小时灌一遍，一年几千万行
//
// 这里不做显式事务：每条语句都是幂等 upsert，中途失败下一轮会自愈，
// 而长事务反而容易把连接池占死。失败的那一条会留在日志里（db.query_failed）。
import { createHash } from 'node:crypto';
import * as db from './store/pg.js';
import { serializeError } from './log.js';

/** 报价"实质内容"的指纹：只比价格/折扣/库存，忽略 buy_url 这类无关变动。 */
export function offerHash(offer) {
  const payload = [offer.priceCents, offer.originalCents ?? 0, offer.discountPct ?? 0, offer.inStock ? 1 : 0].join('|');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export async function ingestOffers(store, { platform, offers, logger = null }) {
  const q = (sql, params) => store.query(sql, params);
  const stats = { total: offers.length, inserted: 0, updated: 0, snapshots: 0, unchanged: 0, skipped: 0, noAppId: 0 };
  const platformCache = new Set();

  for (const offer of offers) {
    const plat = offer.platform ?? platform;
    if (!plat?.code) {
      stats.skipped += 1;
      logger?.warn('ingest.skip', { reason: 'missing_platform', title: offer.title });
      continue;
    }
    try {
      // 一个批次里混了多个平台时必须逐条带 platform，否则报价会被静默归到第一个平台。
      // 这是最容易写错的地方，所以显式告警而不是默默按 platform 参数处理。
      if (offer.platformCode && plat.code && offer.platformCode !== plat.code) {
        logger?.warn('ingest.platform_mismatch', {
          title: offer.title,
          offerPlatform: offer.platformCode,
          usedPlatform: plat.code,
          hint: '该 offer 未自带 platform 字段，已按批次的 platform 处理',
        });
      }
      if (!platformCache.has(plat.code)) {
        await db.upsertPlatform(q, plat);
        platformCache.add(plat.code);
      }

      const game = await db.ensureGame(q, {
        steamAppid: offer.steamAppid ?? null,
        name: offer.title ?? null,
        meta: offer.meta ?? null,
      });
      if (!offer.steamAppid) stats.noAppId += 1;

      await db.upsertAlias(q, {
        gameId: game.id,
        platformCode: plat.code,
        title: offer.title ?? null,
        productId: String(offer.platformProductId),
        method: offer.steamAppid ? 'appid' : 'name',
      });

      const hash = offerHash(offer);
      const existing = await db.findOffer(q, {
        gameId: game.id,
        platformCode: plat.code,
        productType: offer.productType,
        region: offer.region,
      });

      let offerId;
      if (!existing) {
        offerId = await db.insertOffer(q, { ...offer, gameId: game.id, platformCode: plat.code });
        stats.inserted += 1;
      } else {
        offerId = Number(existing.id);
        await db.updateOffer(q, offerId, offer);
        stats.updated += 1;
      }

      const prevHash = await db.lastSnapshotHash(q, offerId);
      if (prevHash !== hash) {
        await db.insertSnapshot(q, offerId, offer, hash);
        stats.snapshots += 1;
        logger?.info('ingest.price_changed', {
          game: offer.title,
          platform: plat.code,
          region: offer.region,
          price: offer.priceCents,
          previousHash: prevHash,
          hash,
        });
      } else {
        stats.unchanged += 1;
      }

      await db.upsertDaily(q, {
        gameId: game.id,
        platformCode: plat.code,
        region: offer.region,
        priceCents: offer.priceCents,
        currency: offer.currency,
      });
      logger?.debug('ingest.offer', {
        gameId: game.id,
        platform: plat.code,
        title: offer.title,
        priceCents: offer.priceCents,
        created: game.created,
      });
    } catch (err) {
      stats.skipped += 1;
      logger?.error('ingest.offer_failed', {
        platform: plat?.code,
        title: offer.title,
        productId: offer.platformProductId,
        err: serializeError(err),
      });
    }
  }

  logger?.info('ingest.summary', stats);
  return stats;
}
