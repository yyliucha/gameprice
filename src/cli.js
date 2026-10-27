#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createLogger, serializeError, readLogs } from './log.js';
import { openStore, ping } from './store/index.js';
import { startApiServer } from './server.js';
import * as db from './store/pg.js';
import { ingestOffers } from './ingest.js';
import { buildSite } from './report.js';
import { evaluateAlerts, renderDigest, toPayload } from './alerts.js';
import { channelsFromEnv, deliver, hasNotifier } from './notify.js';
import { descriptor as steam, syncPrices, syncMeta } from './adapters/steam.js';
import { descriptor as sonkwo, fetchSku } from './adapters/sonkwo.js';
import { descriptor as itad, searchGame, fetchPrices, normalizeDeals } from './adapters/itad.js';
import { descriptor as gogDescriptor, searchOffer as gogSearch, resolveRegion as gogResolveRegion } from './adapters/gog.js';
import { descriptor as humbleDescriptor, searchOffer as humbleSearch } from './adapters/humble.js';
import {
  DEFAULT_STATE as DEFAULT_DISCOVERY_STATE,
  planScan,
  discoverSkus,
  mergeSkuEntries,
} from './adapters/sonkwo-discover.js';
import { bestMatch, confidenceLabel } from './match.js';
import { renderCompare, groupOffersByRegion } from './compare.js';
import { extractAppId, fetchMetadata } from './adapters/steam-meta.js';
import { describeProxy } from './proxy.js';
import { startStaticServer } from './serve.js';

// 统一成 { code, name, kind, ..., searchOffer } 的形状，供 syncByTitle 复用
const gog = { ...gogDescriptor, searchOffer: gogSearch };
const humble = { ...humbleDescriptor, searchOffer: humbleSearch };
import { fetchText, sleep } from './http.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const logger = createLogger({
  level: String(flag('level', process.env.LOG_LEVEL ?? 'info')),
  dir: String(flag('log-dir', process.env.LOG_DIR ?? 'logs')),
  bindings: { runId },
});

const explicitTarget = String(flag('db', process.env.DATABASE_URL ?? ''));
// 开箱即用：什么都没配就落到本地嵌入式 PG（数据在 data/pgdata 下），
// 不需要先装数据库、也不需要先建库。
const dbTarget = explicitTarget || 'pglite:./data/pgdata';
if (!explicitTarget) {
  logger.info('db.default_target', { target: dbTarget, hint: '未配置 DATABASE_URL，使用嵌入式 PG' });
}
// 容器启动时数据库可能还没就绪（compose 里 db 先起、app 随后），所以支持"等库"：
// DB_WAIT_SEC=60 表示最多等 60 秒，每 2 秒重连一次。
const dbWaitSec = Number(flag('wait-db', process.env.DB_WAIT_SEC ?? 0));
const yuan = (c) => (c == null ? '-' : `¥${(c / 100).toFixed(2)}`);
const width = (s) => {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
};
const pad = (s, n) => String(s ?? '') + ' '.repeat(Math.max(0, n - width(s)));
const BLOCKS = '▁▂▃▄▅▆▇█';
const sparkline = (values) => {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => BLOCKS[Math.min(7, Math.floor(((v - min) / span) * 7))]).join('');
};
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

/**
 * 按需迁移：老库可能缺新表（例如加了 watchlist 之后的存量库）。
 * 每次只做一次 `to_regclass` 检查，缺表才跑完整 DDL——不能让用户记住"先 init"。
 */
async function ensureSchema(store) {
  const probe = await store.query(`select to_regclass('public.watchlist') is not null as ok`);
  if (probe.rows[0]?.ok === true) return;
  logger.info('db.migrate_auto', { reason: 'schema_incomplete' });
  await db.migrate(store);
}

const SKIP_AUTO_MIGRATE = new Set(['ping', 'init', 'bootstrap']);

async function withStore(fn) {
  // ping 是健康检查，必须快速返回；等库重试只对真正要干活的命令生效
  const attempts = dbWaitSec > 0 && command !== 'ping' ? Math.max(1, Math.ceil(dbWaitSec / 2)) : 1;
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const store = await openStore(dbTarget, { logger });
      try {
        if (!SKIP_AUTO_MIGRATE.has(command)) await ensureSchema(store);
        return await fn(store);
      } finally {
        await store.close();
      }
    } catch (err) {
      lastErr = err;
      // 只有"连不上"才重试；SQL 报错重试没有意义
      const connectFailed = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect|terminat/i.test(String(err.message));
      if (i === attempts || !connectFailed) break;
      logger.warn('db.connect_retry', {
        attempt: i,
        attempts,
        delayMs: 2000,
        message: String(err.message).slice(0, 160),
      });
      await sleep(2000);
    }
  }
  throw lastErr;
}

async function cmdInit() {
  await withStore(async (store) => {
    const timer = logger.timed('db.migrate', {});
    await db.migrate(store);
    timer.done();
    const v = await db.serverVersion((sql, p) => store.query(sql, p));
    logger.info('db.server', { version: v.version?.slice(0, 60), timeZone: v.timeZone, alive: await ping(store) });
    console.log(`数据库就绪：${dbTarget.startsWith('pglite:') ? dbTarget : 'postgres（凭据已隐藏）'}`);
    console.log(`  服务端版本：${v.version}`);
    console.log(`  时区：${v.timeZone}`);
  });
}

/** 容器启动用：建表 + 首次自动导入游戏（已导入则跳过），可重复执行。 */
async function cmdBootstrap() {
  await withStore(async (store) => {
    const timer = logger.timed('db.migrate', {});
    await db.migrate(store);
    timer.done();

    const countRow = await store.query('select count(*)::int as c from games');
    const games = countRow.rows[0]?.c ?? 0;
    if (games > 0) {
      logger.info('bootstrap.done', { games, seeded: 0, reason: 'already_seeded' });
      return;
    }
    if (process.env.SEED_ON_START === '0') {
      logger.info('bootstrap.done', { games: 0, seeded: 0, reason: 'SEED_ON_START=0' });
      return;
    }
    const seeds = readJson('data/games.json', []);
    let created = 0;
    for (const g of seeds) {
      const r = await db.ensureGame((sql, p) => store.query(sql, p), {
        steamAppid: g.appid ?? null,
        name: g.name ?? null,
        nameEn: g.nameEn ?? null,
      });
      if (r.created) created += 1;
    }
    logger.info('bootstrap.done', { games: games + created, seeded: created, reason: 'first_run' });
    console.log(`首次启动：已导入 ${created} 个游戏`);
  });
}

/** 健康检查：只验证数据库可用，成功时静默退出 0。 */
async function cmdPing() {
  await withStore(async (store) => {
    const r = await store.query('select 1 as ok');
    if (r.rows[0]?.ok !== 1) throw new Error('数据库返回异常');
  });
  process.exitCode = 0;
}

async function cmdSeed() {
  const games = readJson('data/games.json', []);
  if (!games.length) throw new Error('data/games.json 为空');
  await withStore(async (store) => {
    const q = (sql, p) => store.query(sql, p);
    let created = 0;
    let withEn = 0;
    for (const g of games) {
      const r = await db.ensureGame(q, { steamAppid: g.appid ?? null, name: g.name ?? null, nameEn: g.nameEn ?? null });
      if (r.created) created += 1;
      if (g.nameEn) withEn += 1;
    }
    logger.info('seed.done', { total: games.length, created, withEn });
    console.log(`导入 ${games.length} 个游戏，新建 ${created} 个（带英文名 ${withEn} 个）`);
  });
}

async function cmdAddSku() {
  const ids = args.slice(1).filter((a) => /^\d+$/.test(a));
  if (!ids.length) throw new Error('用法: node src/cli.js add-sku <skuId> [skuId...] [--appid 123]');
  const appid = flag('appid', null);
  const file = 'data/skus.json';
  const list = readJson(file, []);
  let added = 0;
  for (const skuId of ids) {
    if (list.some((s) => String(s.skuId) === String(skuId))) continue;
    list.push({ skuId: Number(skuId), appid: appid ? Number(appid) : null });
    added += 1;
  }
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  logger.info('skus.updated', { added, total: list.length });
  console.log(`SKU 列表新增 ${added} 条（共 ${list.length} 条）`);
}

async function cmdSyncSteam() {
  const limit = Number(flag('limit', 500));
  const appids = await withStore(async (store) => {
    const r = await store.query('select steam_appid from games where steam_appid is not null order by id limit $1', [limit]);
    return r.rows.map((x) => x.steam_appid);
  });
  if (!appids.length) throw new Error('库里没有游戏，先跑 seed');
  logger.info('sync.start', { platform: steam.code, appids: appids.length });
  const runId_ = await withStore((store) => db.startFetchRun((sql, p) => store.query(sql, p), steam.code));

  try {
    const result = await syncPrices({ appids, logger, log: (m) => logger.debug('sync.progress', { msg: m }) });
    const stats = await withStore((store) => ingestOffers(store, { platform: steam, offers: result.offers, logger }));
    await withStore((store) =>
      db.finishFetchRun((sql, p) => store.query(sql, p), runId_, {
        requests: result.requests,
        total: appids.length,
        ok: result.offers.length,
        skipped: result.skipped.length,
        failed: appids.length - result.offers.length - result.skipped.length,
        status: 'ok',
        note: `${(result.bytes / 1024).toFixed(0)}KB`,
      }),
    );
    logger.info('sync.done', { platform: steam.code, ...stats });
  } catch (err) {
    await withStore((store) =>
      db.finishFetchRun((sql, p) => store.query(sql, p), runId_, {
        total: appids.length,
        failed: appids.length,
        status: 'failed',
        note: String(err.message).slice(0, 200),
      }),
    );
    logger.error('sync.failed', { platform: steam.code, err: serializeError(err) });
    throw err;
  }
}

/**
 * 同步库里所有 Steam 游戏：元数据（名字/开发商/分类/说明）+ Steam 自身价格。
 * 这是「以 Steam 为准」的批量入口，后台按钮与定时任务都走它。
 */
/**
 * 导入 Steam 全量应用目录（一次请求，20 万条）。
 * 只写 appid 与名称，价格/说明交给 sync steamall 慢慢补。
 */
async function cmdImportSteamCatalog() {
  const { fetchAppList } = await import('./adapters/steam-catalog.js');
  console.log("拉取 Steam 应用目录…（单次请求，可能 10MB 左右）");
  let apps = [];
  try {
    apps = await fetchAppList({
      logger,
      onPage: (p) => {
        const msg = '已拉取第 ' + p.page + ' 页，累计 ' + p.total + ' 条';
        console.log("  " + msg);
        logger.info('import.steamcatalog.progress', { page: p.page, total: p.total });
      },
    });
  } catch (err) {
    logger.error('import.steamcatalog.failed', { message: String(err.message).slice(0, 300) });
    throw err;
  }
  logger.info('import.steamcatalog.fetched', { total: apps.length });
  console.log("拿到 " + apps.length + " 条，开始入库（批量 500）");
  let inserted = 0;
  for (let i = 0; i < apps.length; i += 500) {
    const batch = apps.slice(i, i + 500);
    const ids = batch.map((a) => a.appid);
    const names = batch.map((a) => a.name || ('appid:' + a.appid));
    const r = await withStore(async (store) =>
      store.query(
        "insert into games (steam_appid, name) " +
          "select x.appid, x.name from unnest($1::int[], $2::text[]) as x(appid, name) " +
          "where not exists (select 1 from games g where g.steam_appid = x.appid)",
        [ids, names],
      ),
    );
    inserted += r.rowCount ?? 0;
    if ((i / 500) % 20 === 0) {
      const msg = "已处理 " + (i + batch.length) + " / " + apps.length + "，新增 " + inserted;
      console.log("  " + msg);
      logger.info('import.steamcatalog.progress', { done: i + batch.length, total: apps.length, inserted });
    }
  }
  logger.info("import.steamcatalog.done", { total: apps.length, inserted });
  console.log("完成：目录 " + apps.length + " 条，新增 " + inserted + " 款");
  console.log("下一步：node src/cli.js sync steamall --limit 200 --sleep 2（慢慢补价格与说明）");
}

async function cmdSyncSteamAll() {
  // 只挑"还没有 Steam 价格或说明"的游戏，按 id 顺序推进，避免重复抓同一批
  const limit = Number(flag('limit', '200')) || 200;
  const sleepMs = Math.max(0, Number(flag('sleep', '2')) || 0) * 1000;
  const rows = await withStore(async (store) => {
    const r = await store.query(
      "select g.steam_appid from games g where g.steam_appid is not null " +
        "and (g.description is null or g.description = '' or not exists (select 1 from offers o where o.game_id = g.id and o.platform_code = 'steam')) " +
        "order by g.id limit $1",
      [limit],
    );
    return r.rows;
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const appids = rows.map((r) => Number(r.steam_appid)).filter((n) => Number.isFinite(n) && n > 0);
  if (!appids.length) throw new Error('库里没有带 appid 的游戏：先 node src/cli.js import steam --appids ...');

  console.log(`同步 ${appids.length} 款 Steam 游戏（官方接口：元数据 + 说明 + 价格）`);
  const backend = String(flag('backend', 'official'));
  const items = [];
  for (let i = 0; i < appids.length; i += 1) {
    try {
      const one = await fetchMetadata([appids[i]], { backend, logger });
      if (one.items?.length) items.push(...one.items);
    } catch (err) {
      logger.warn('sync.item_failed', { appid: appids[i], message: String(err.message).slice(0, 160) });
    }
    if (sleepMs) await sleep(sleepMs);
    if ((i + 1) % 25 === 0) console.log("  进度 " + (i + 1) + " / " + appids.length);
  }
  console.log(`元数据来源 ${backend}，取到 ${items.length} 条`);

  let named = 0;
  let described = 0;
  let priced = 0;
  const offers = [];

  for (const item of items) {
    await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      await db.upsertGameMeta(q, item);
      if (item.description) {
        const row = await db.setGameDescription(q, { steamAppid: item.steamAppid, description: item.description });
        if (row?.description) described += 1;
      }
      if (item.nameZh) named += 1;

      if (item.priceOverview && item.priceOverview.final != null) {
        offers.push({
          platformCode: 'steam',
          platformProductId: String(item.steamAppid),
          steamAppid: item.steamAppid,
          title: item.nameZh ?? String(item.steamAppid),
          productType: 'official_direct',
          region: 'cn',
          currency: item.priceOverview.currency ?? 'CNY',
          priceCents: Math.round(item.priceOverview.final),
          originalCents: Math.round(item.priceOverview.initial ?? item.priceOverview.final),
          discountPct: Number(item.priceOverview.discountPercent ?? 0),
          inStock: true,
          buyUrl: `https://store.steampowered.com/app/${item.steamAppid}/`,
          meta: {},
        });
        priced += 1;
      }
    });
  }

  if (offers.length) {
    const stats = await withStore((store) =>
      ingestOffers(store, { platform: { code: 'steam', name: 'Steam 国区', kind: 'official' }, offers, logger }),
    );
    logger.info('sync.steamall.done', { appids: appids.length, items: items.length, described, priced, ...stats });
    console.log(`完成：${items.length} 条元数据（说明 ${described} 条）、${priced} 条 Steam 价格（新增 ${stats.inserted}）`);
  } else {
    console.log(`完成：${items.length} 条元数据，没有可入库的价格（汇率区/免费游戏）`);
  }
}

async function cmdSyncSonkwo() {
  const skus = readJson('data/skus.json', []);
  if (!skus.length) throw new Error('data/skus.json 为空，先用 add-sku 加几个 SKU');
  const limit = Number(flag('limit', skus.length));
  const targets = skus.slice(0, limit);
  logger.info('sync.start', { platform: sonkwo.code, skus: targets.length });
  const offers = [];
  for (const item of targets) {
    try {
      const offer = await fetchSku(item.skuId, { logger });
      if (offer) {
        if (item.appid) offer.steamAppid = Number(item.appid);
        offers.push(offer);
      }
    } catch (err) {
      logger.error('sync.sku_failed', { skuId: item.skuId, err: serializeError(err) });
    }
    await sleep(Number(flag('rate', 1200)));
  }
  const stats = await withStore((store) => ingestOffers(store, { platform: sonkwo, offers, logger }));
  logger.info('sync.done', { platform: sonkwo.code, fetched: offers.length, ...stats });
}

async function cmdSyncItad() {
  const apiKey = process.env.ITAD_API_KEY;
  if (!apiKey) {
    logger.warn('sync.skip', { platform: itad.code, reason: 'missing_ITAD_API_KEY' });
    console.log('未配置 ITAD_API_KEY，跳过。到 https://isthereanydeal.com/apps/my/ 注册后设置环境变量。');
    return;
  }
  const limit = Number(flag('limit', 50));
  const games = await withStore(async (store) => {
    const r = await store.query('select steam_appid, name from games where name is not null order by id limit $1', [limit]);
    return r.rows;
  });
  if (!games.length) throw new Error('库里没有带名字的游戏，先跑 seed');

  logger.info('sync.start', { platform: itad.code, games: games.length });
  const ids = [];
  for (const g of games) {
    try {
      const hits = await searchGame(g.name, { apiKey, logger });
      const best = hits.find((h) => h.title?.toLowerCase() === g.name.toLowerCase()) ?? hits[0];
      logger.info('itad.search_result', {
        query: g.name,
        hits: hits.length,
        picked: best?.title ?? null,
        pickedId: best?.id ?? null,
        top3: hits.slice(0, 3).map((h) => h.title),
      });
      if (best?.id) ids.push(best.id);
    } catch (err) {
      logger.error('itad.search_failed', { query: g.name, err: serializeError(err) });
    }
    await sleep(Number(flag('rate', 1000)));
  }
  if (!ids.length) {
    logger.warn('sync.skip', { platform: itad.code, reason: 'no_game_ids' });
    return;
  }

  const prices = await fetchPrices(ids, { apiKey, logger });
  const { offers, skipped } = normalizeDeals(prices, { logger });
  logger.info('itad.normalized', { games: ids.length, offers: offers.length, skipped });
  const stats = await withStore((store) => ingestOffers(store, { platform: itad, offers, logger }));
  logger.info('sync.done', { platform: itad.code, ...stats });
}

async function cmdWatch() {
  const sub = args[1];
  const appid = Number(args[2]);

  if (sub === 'list' || sub === undefined) {
    const rows = await withStore((store) => db.listWatches((sql, p) => store.query(sql, p)));
    if (!rows.length) {
      console.log('关注列表为空。用法：node src/cli.js watch add <steamAppid> --target 99');
      return;
    }
    console.log(`${pad('游戏', 30)} ${pad('目标价', 10)} ${pad('上次提醒', 12)} ${pad('价格', 10)} 备注`);
    console.log('-'.repeat(88));
    for (const r of rows) {
      const t = r.target_cents == null ? '史低才提醒' : yuan(r.target_cents);
      const last = r.last_notified_at ? new Date(r.last_notified_at).toISOString().slice(5, 10) : '—';
      console.log(`${pad(r.name, 30)} ${pad(t, 10)} ${pad(last, 12)} ${pad(yuan(r.last_notified_cents), 10)} ${r.note ?? ''}`);
    }
    return;
  }

  if (!Number.isFinite(appid) || appid <= 0) throw new Error('用法: node src/cli.js watch <add|rm|list> <steamAppid> [--target 99]');

  if (sub === 'add') {
    const targetYuan = flag('target', null);
    const targetCents = flag('target-cents', null);
    const target = targetCents != null ? Number(targetCents) : targetYuan != null ? Math.round(Number(targetYuan) * 100) : null;
    if (target != null && (!Number.isFinite(target) || target <= 0)) throw new Error('--target 需要是正数（单位：元）');
    const note = flag('note', null);

    const result = await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      const game = await q('select id, name from games where steam_appid = $1', [appid]);
      if (!game.rows.length) return { missing: true };
      const id = await db.upsertWatch(q, { gameId: Number(game.rows[0].id), targetCents: target, note: typeof note === 'string' ? note : null });
      logger.info('watch.saved', { appid, gameId: Number(game.rows[0].id), targetCents: target, watchId: id });
      return { name: game.rows[0].name, id };
    });
    if (result.missing) throw new Error(`库里没有 appid ${appid}，先 node src/cli.js add ${appid} 或 seed`);
    console.log(`已关注：${result.name ?? `appid ${appid}`}${target ? `（目标 ${yuan(target)}）` : '（跌至史低时提醒）'}`);
    return;
  }

  if (sub === 'rm') {
    const removed = await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      const game = await q('select id from games where steam_appid = $1', [appid]);
      if (!game.rows.length) return 0;
      return db.deleteWatch(q, { gameId: Number(game.rows[0].id) });
    });
    logger.info('watch.removed', { appid, removed });
    console.log(removed ? `已取消关注 appid ${appid}` : `appid ${appid} 不在关注列表里`);
    return;
  }

  throw new Error('用法: node src/cli.js watch <add|rm|list> <steamAppid> [--target 99] [--note 备注]');
}

async function cmdAlerts() {
  const rows = await withStore((store) => db.watchCandidates((sql, p) => store.query(sql, p)));
  const hits = evaluateAlerts(rows, { now: new Date() });
  const extraWebhook = flag('webhook', null);
  const channels = channelsFromEnv();
  if (typeof extraWebhook === 'string') channels.push({ name: 'webhook(cli)', kind: 'webhook', url: extraWebhook });
  const mark = flag('mark', false) === true || flag('mark', false) === 'true';

  logger.info('alert.evaluated', {
    watched: rows.length,
    hits: hits.length,
    channels: channels.map((c) => c.name),
    reasons: hits.reduce((acc, h) => ({ ...acc, [h.reason]: (acc[h.reason] ?? 0) + 1 }), {}),
  });

  if (!hits.length) {
    console.log('没有需要提醒的价格。');
    return;
  }

  if (flag('json', false) === true) {
    console.log(JSON.stringify(toPayload(hits, { now: new Date() }), null, 2));
  } else {
    console.log(renderDigest(hits, { now: new Date() }));
  }

  let delivered = false;
  if (channels.length) {
    const result = await deliver(channels, {
      text: renderDigest(hits, { now: new Date() }),
      payload: toPayload(hits, { now: new Date() }),
      subject: `游戏价格提醒：${hits.length} 款到价`,
      logger,
    });
    delivered = result.ok;
    for (const r of result.results) {
      const detail = r.ok ? `HTTP ${r.status ?? ''}`.trim() : (r.error ?? `errcode=${r.errcode}`);
      console.log(`  ${r.ok ? '✔' : '✘'} ${r.channel}  ${detail}`);
    }
  } else {
    console.log('\n未配置任何提醒通道（ALERT_WEBHOOK_URL / WECOM_WEBHOOK_URL / SMTP_HOST+ALERT_EMAIL_TO），仅输出到终端。');
  }

  if (mark && (delivered || !channels.length)) {
    await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      for (const h of hits) await db.markNotified(q, { watchId: h.watchId, priceCents: h.currentCents });
    });
    logger.info('alert.marked', { count: hits.length });
    console.log(`已记录 ${hits.length} 条提醒，同价位不会重复通知。`);
  } else if (mark && !delivered) {
    logger.warn('alert.not_marked', { reason: 'delivery_failed' });
    console.log('投递全部失败，未记录提醒状态（下轮会重试）。');
  }
}

/** 部署自检：走一遍所有已配置的通道，确认能收到消息。 */
async function cmdNotifyTest() {
  const channels = channelsFromEnv();
  if (!channels.length) {
    console.log('没有配置任何提醒通道。可设置 ALERT_WEBHOOK_URL / WECOM_WEBHOOK_URL / SMTP_HOST+ALERT_EMAIL_TO。');
    process.exitCode = 1;
    return;
  }
  const text = [
    'gameprice 测试消息',
    `时间：${new Date().toISOString()}`,
    `通道：${channels.map((c) => c.name).join(', ')}`,
    '收到这条说明提醒链路已打通。',
  ].join('\n');
  const result = await deliver(channels, {
    text,
    payload: { type: 'gameprice.test', text },
    subject: 'gameprice 测试邮件',
    logger,
  });
  for (const r of result.results) {
    console.log(`  ${r.ok ? '✔' : '✘'} ${r.channel}  ${r.ok ? `HTTP ${r.status ?? ''}` : (r.error ?? `errcode=${r.errcode}`)}`);
  }
  console.log(result.ok ? '至少一个通道投递成功。' : '全部通道投递失败，见日志 notify.* 事件。');
  if (!result.ok) process.exitCode = 1;
}

/**
 * 按英文名检索型适配器的通用同步流程（GOG / Humble）。
 * 关键点：把 steamAppid 注入 offer，才能并进已有游戏行而不是新建一条英文名记录。
 * regions 非空时按区服逐个查询（只有声明支持多区的适配器才传）。
 */
async function syncByTitle(adapter, { label = adapter.code, limit = 50, rate = 1200, regions = null } = {}) {
  const games = await withStore(async (store) => {
    const r = await store.query(
      `select steam_appid, name, name_en from games
        where steam_appid is not null and name_en is not null
        order by id limit $1`,
      [limit],
    );
    return r.rows;
  });
  if (!games.length) throw new Error('库里没有带英文名的游戏，先跑 seed（data/games.json 需要 nameEn）');

  const regionList = regions?.length ? regions : [null];
  logger.info('sync.start', { platform: adapter.code, games: games.length, regions: regionList.filter(Boolean) });

  const offers = [];
  let noMatch = 0;
  for (const g of games) {
    for (const region of regionList) {
      try {
        const { offer } = await adapter.searchOffer(g.name_en, {
          logger,
          steamAppid: g.steam_appid,
          ...(region ? { region } : {}),
        });
        if (offer) offers.push(offer);
        else noMatch += 1;
      } catch (err) {
        logger.error('sync.item_failed', {
          platform: adapter.code,
          game: g.name_en,
          region,
          err: serializeError(err),
        });
      }
      await sleep(rate);
    }
  }

  const stats = await withStore((store) => ingestOffers(store, { platform: adapter, offers, logger }));
  logger.info('sync.done', { platform: adapter.code, queried: games.length, regions: regionList.filter(Boolean), matched: offers.length, noMatch, ...stats });
  const regionNote = regionList.filter(Boolean).length > 1 ? ` × ${regionList.filter(Boolean).length} 区服` : '';
  console.log(`${label}：查询 ${games.length} 款${regionNote}，匹配 ${offers.length} 条报价，未找到 ${noMatch} 次`);
}

async function cmdSyncGog() {
  const raw = String(flag('regions', process.env.GOG_REGIONS ?? 'cn'));
  const regions = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // 提前校验区服，避免跑一半才发现拼错、静默拿到错误币种
  for (const region of regions) gogResolveRegion(region);
  await syncByTitle(gog, {
    label: 'GOG',
    limit: Number(flag('limit', 50)),
    rate: Number(flag('rate', 1200)),
    regions,
  });
}

async function cmdSyncHumble() {
  await syncByTitle(humble, { label: 'Humble', limit: Number(flag('limit', 50)), rate: Number(flag('rate', 1500)) });
}

/** 杉果 SKU 自动发现：从前沿向后探测，连续空壳即停。 */
async function cmdDiscover() {
  const target = args[1];
  if (target !== 'sonkwo') {
    throw new Error('用法: node src/cli.js discover sonkwo [--ahead 120] [--from N --to M] [--rate 1200] [--max-misses 15]');
  }

  const skuFile = 'data/skus.json';
  const stateFile = 'data/sonkwo-discovery.json';
  const entries = readJson(skuFile, []);
  const state = { ...DEFAULT_DISCOVERY_STATE, ...readJson(stateFile, {}) };
  const knownMax = entries.reduce((max, e) => Math.max(max, Number(e.skuId) || 0), 0);

  const explicitFrom = flag('from', null);
  const explicitTo = flag('to', null);
  const range =
    explicitFrom != null && explicitTo != null
      ? { from: Number(explicitFrom), to: Number(explicitTo) }
      : planScan({ knownMax, state, ahead: Number(flag('ahead', 120)), overlap: Number(flag('overlap', 3)) });

  if (!range) throw new Error('没有已知 SKU 作为起点：先 add-sku，或用 --from/--to 指定区间');
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to < range.from) {
    throw new Error(`区间不合法：${JSON.stringify(range)}`);
  }

  const rate = Number(flag('rate', 1200));
  const maxMisses = Number(flag('max-misses', 15));
  console.log(`扫描 ${range.from}..${range.to}（间隔 ${rate}ms，连续 ${maxMisses} 个空壳即停）`);

  const result = await discoverSkus({
    ...range,
    rate,
    stopAfterMisses: maxMisses,
    logger,
    fetchSku: (id) => fetchSku(id, { logger }),
  });

  const merged = mergeSkuEntries(entries, result.found);
  writeFileSync(skuFile, `${JSON.stringify(merged.entries, null, 2)}\n`, 'utf8');

  const discoveredMax = result.found.reduce((max, f) => Math.max(max, f.skuId), 0);
  const highWaterMark = Math.max(knownMax, Number(state.highWaterMark) || 0, discoveredMax);
  writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        highWaterMark,
        lastRunAt: new Date().toISOString(),
        lastRange: range,
        lastStopReason: result.stopReason,
        totalFound: (Number(state.totalFound) || 0) + merged.added,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(
    `探测 ${result.probed} 个 id：命中 ${result.found.length}，新增 ${merged.added} 条，` +
      `补名称 ${merged.named} 条，当前共 ${merged.total} 条（停止原因：${result.stopReason}）`,
  );
  if (merged.added) console.log(`已写入 ${skuFile}；接着跑 node src/cli.js sync sonkwo 拉价格。`);
}

/** 把某个杉果 SKU 指向 Steam 游戏，并合并此前按名称建出的孤立游戏行。 */
async function applySkuMapping(store, { skuId, appid }) {
  const q = (sql, p) => store.query(sql, p);
  const game = await q('select id, name from games where steam_appid = $1', [appid]);
  if (!game.rows.length) throw new Error(`库里没有 appid ${appid}，先 add 或 seed`);
  const targetId = Number(game.rows[0].id);

  const alias = await q(
    'select game_id from game_aliases where platform_code = $1 and platform_product_id = $2',
    ['sonkwo', String(skuId)],
  );
  let merge = null;
  if (alias.rows.length) {
    const fromId = Number(alias.rows[0].game_id);
    if (fromId !== targetId) {
      const source = await q('select steam_appid from games where id = $1', [fromId]);
      // 只合并「没有 appid 的孤立行」；有 appid 的行说明映射冲突，交给人工处理
      if (source.rows.length && source.rows[0].steam_appid == null) {
        merge = await db.mergeGames(q, { fromGameId: fromId, toGameId: targetId, logger });
      } else {
        logger.warn('match.skip_merge', { skuId, fromGameId: fromId, reason: 'source_has_appid' });
      }
    }
  }
  return { targetId, gameName: game.rows[0].name, merge };
}

/** 名称匹配 + 人工确认：把杉果 SKU 对齐到已有 Steam 游戏。 */
async function cmdMatch() {
  const skuFile = 'data/skus.json';
  const entries = readJson(skuFile, []);
  const games = await withStore(async (store) =>
    (await store.query('select id, steam_appid, name, name_en from games where steam_appid is not null order by id')).rows,
  );

  // 人工确认模式：match --confirm <skuId> <appid>
  const confirmIdx = args.indexOf('--confirm');
  if (confirmIdx > -1) {
    const skuId = Number(args[confirmIdx + 1]);
    const appid = Number(args[confirmIdx + 2]);
    if (!Number.isFinite(skuId) || !Number.isFinite(appid)) {
      throw new Error('用法: node src/cli.js match --confirm <skuId> <steamAppid>');
    }
    const entry = entries.find((e) => Number(e.skuId) === skuId);
    if (!entry) throw new Error(`skus.json 里没有 ${skuId}`);
    const result = await withStore((store) => applySkuMapping(store, { skuId, appid }));
    entry.appid = appid;
    writeFileSync(skuFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    console.log(`已确认：${entry.name ?? skuId} → ${games.find((g) => g.steam_appid === appid)?.name ?? appid}`);
    if (result.merge?.merged) {
      console.log(`合并了孤立游戏行：搬 ${result.merge.moved} 条报价、丢弃 ${result.merge.dropped} 条重复`);
    }
    return;
  }

  const minScore = Number(flag('min-score', 0.86));
  const autoScore = Number(flag('auto-score', 0.94));
  const apply = flag('apply', false) === true;
  const limit = Number(flag('limit', 200));
  const unresolved = entries.filter((e) => !e.appid && e.name).slice(0, limit);

  if (!unresolved.length) {
    console.log('没有待匹配的 SKU（都已有 appid，或 skus.json 为空）。');
    return;
  }

  console.log(`${pad('skuId', 8)} ${pad('杉果名', 26)} ${pad('候选游戏', 22)} ${pad('appid', 8)} ${pad('分数', 6)} 建议`);
  console.log('-'.repeat(80));

  const proposals = [];
  for (const entry of unresolved) {
    const best = bestMatch(entry.name, games, { minScore });
    if (!best) {
      console.log(`${pad(entry.skuId, 8)} ${pad(entry.name, 26)} ${pad('—', 22)} ${pad('—', 8)} ${pad('—', 6)} 无候选`);
      continue;
    }
    const label = confidenceLabel(best.score);
    proposals.push({ entry, best, label });
    console.log(
      `${pad(entry.skuId, 8)} ${pad(entry.name, 26)} ${pad(best.candidate.name ?? best.matchedField, 22)} ` +
        `${pad(best.candidate.steam_appid, 8)} ${pad(best.score.toFixed(2), 6)} ${label}`,
    );
  }

  logger.info('match.proposals', {
    unresolved: unresolved.length,
    proposed: proposals.length,
    auto: proposals.filter((p) => p.label === '自动').length,
  });

  if (!proposals.length) {
    console.log('\n没有达到阈值的候选。可降低 --min-score，或用 match --confirm <skuId> <appid> 手工指定。');
    return;
  }

  if (!apply) {
    console.log(`\n以上为提案（未写入）。加 --apply 自动应用「自动」级别的 ${proposals.filter((p) => p.label === '自动').length} 条。`);
    return;
  }

  const auto = proposals.filter((p) => p.label === '自动');
  let mapped = 0;
  let merged = 0;
  for (const p of auto) {
    const appid = p.best.candidate.steam_appid;
    await withStore((store) => applySkuMapping(store, { skuId: Number(p.entry.skuId), appid }));
    p.entry.appid = appid;
    mapped += 1;
    if (p.best.candidate) merged += 1;
  }
  writeFileSync(skuFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  logger.info('match.applied', { mapped });
  console.log(`\n已写入 ${mapped} 条映射到 ${skuFile}（阈值 ${autoScore}）。其余请用 --confirm 逐个确认。`);
}

/** 多区服对比：同一款游戏在各区服的报价并排展示（不同币种不折算）。 */
async function cmdCompare() {
  const appid = Number(args[1]);
  if (!Number.isFinite(appid)) throw new Error('用法: node src/cli.js compare <steamAppid> [--region cn] [--json]');
  const regionFlag = flag('region', null);
  const region = typeof regionFlag === 'string' ? regionFlag : null;

  const data = await withStore(async (store) => {
    const q = (sql, p) => store.query(sql, p);
    const game = await q('select id, name, name_en, steam_appid from games where steam_appid = $1', [appid]);
    if (!game.rows.length) return null;
    const rows = await db.regionOffers(q, { steamAppid: appid, region });
    return { game: game.rows[0], rows };
  });

  if (!data) throw new Error(`库里没有 appid ${appid}，先 add 或 seed`);

  const groups = groupOffersByRegion(data.rows);
  logger.info('compare.done', {
    appid,
    regions: groups.map((g) => g.region),
    offers: data.rows.length,
  });

  if (flag('json', false) === true) {
    console.log(
      JSON.stringify(
        {
          game: data.game,
          regions: groups.map((g) => ({
            region: g.region,
            currency: g.currency,
            offers: g.offers.map((o) => ({
              platform: o.platform_code,
              price: o.price_cents,
              currency: o.currency,
              discount: o.discount_pct,
              cheapest: o.isCheapest,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    renderCompare({
      game: data.game,
      rows: data.rows,
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }),
  );
}

/** 导入 Steam 游戏元数据（名字/封面/发行日期/开发商），支持 appid、商店链接或文件。 */
async function cmdImport() {
  const kind = args[1];
  if (kind !== 'steam') {
    throw new Error('用法: node src/cli.js import steam [--appids 730,570] [--urls ...] [--file data/wishlist.txt] [--backend auto|official|steamcmd]');
  }

  const raw = [];
  const appidsFlag = flag('appids', null);
  if (typeof appidsFlag === 'string') raw.push(...appidsFlag.split(/[\s,]+/));
  const urlsFlag = flag('urls', null);
  if (typeof urlsFlag === 'string') raw.push(...urlsFlag.split(/[\s,]+/));
  const fileFlag = flag('file', null);
  if (typeof fileFlag === 'string') {
    if (!existsSync(fileFlag)) throw new Error(`文件不存在：${fileFlag}`);
    raw.push(...readFileSync(fileFlag, 'utf8').split(/\r?\n/));
  }

  const appids = [...new Set(raw.map(extractAppId).filter((n) => Number.isFinite(n) && n > 0))];
  if (!appids.length) {
    throw new Error('没有解析到 appid：用 --appids 730,570 / --urls <商店链接> / --file <清单> 指定');
  }

  console.log(`准备导入 ${appids.length} 个 appid：${appids.slice(0, 8).join(', ')}${appids.length > 8 ? ' …' : ''}`);
  const { backend, items } = await fetchMetadata(appids, { backend: String(flag('backend', 'auto')), logger });
  console.log(`元数据来源：${backend ?? '无'}，取到 ${items.length} 条`);

  const stats = await withStore(async (store) => {
    const q = (sql, p) => store.query(sql, p);
    let created = 0;
    let updated = 0;
    let named = 0;
    for (const item of items) {
      const result = await db.upsertGameMeta(q, item);
      if (result.created) created += 1;
      else updated += 1;
      if (item.nameZh) named += 1;
    }
    return { created, updated, named };
  });

  logger.info('import.done', { kind, backend, requested: appids.length, got: items.length, ...stats });
  console.log(
    `导入完成：新增 ${stats.created} 款、更新 ${stats.updated} 款（其中带中文名 ${stats.named} 款）`,
  );
  const missing = appids.length - items.length;
  if (missing > 0) console.log(`有 ${missing} 个 appid 没有取到元数据（可能已下架或不是游戏），详见日志 steam.meta.missing`);
  console.log('下一步：node src/cli.js list，或直接 node src/cli.js chart 看页面');
}

/** 标记已拥有（默认在列表里收起，采集与统计不受影响）。 */
async function cmdOwned() {
  const appid = Number(args[1]);
  const value = String(args[2] ?? '').toLowerCase();
  if (!Number.isFinite(appid) || !['on', 'off'].includes(value)) {
    throw new Error('用法: node src/cli.js owned <steamAppid> on|off');
  }
  const row = await withStore((store) => db.setOwned((sql, p) => store.query(sql, p), { steamAppid: appid, owned: value === 'on' }));
  if (!row) throw new Error(`库里没有 appid ${appid}`);
  logger.info('owned.set', { appid, owned: row.owned });
  console.log(`${row.name ?? appid} → ${row.owned ? '已拥有' : '未拥有'}（默认在列表里收起）`);
}
/** 用户管理：add / list。密码只在创建时显示一次。 */
async function cmdUser() {
  const sub = args[1];
  if (sub === 'add') {
    const username = String(args[2] ?? '').trim();
    const role = args.includes('--admin') ? 'admin' : 'user';
    const pwIdx = args.indexOf('--password');
    // 用 Web Crypto（Node 19+ 全局可用），不额外引入模块
    const password =
      pwIdx > -1 ? String(args[pwIdx + 1]) : Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('base64url');
    if (!username) throw new Error('用法: node src/cli.js user add <用户名> [--admin] [--password xxx]');
    const created = await withStore((store) =>
      db.createUser((sql, p) => store.query(sql, p), { username, password, role }),
    );
    logger.info('user.created', { username: created.username, role: created.role });
    console.log(`已创建 ${created.username}（${created.role}）`);
    if (pwIdx === -1) console.log(`初始密码：${password}（只显示这一次，请立即保存）`);
    return;
  }
  if (sub === 'list') {
    const users = await withStore((store) => db.listUsers((sql, p) => store.query(sql, p)));
    if (!users.length) {
      console.log('还没有用户。用 node src/cli.js user add <用户名> --admin 创建管理员。');
      return;
    }
    for (const u of users) {
      const created = u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : '';
      console.log(`${String(u.username).padEnd(18)} ${String(u.role).padEnd(6)} ${created}`);
    }
    return;
  }
  throw new Error('用法: node src/cli.js user add <用户名> [--admin] [--password xxx] | user list');
}

/** 逻辑备份：核心表导出成 gzip JSON，保留最近 7 份；顺带清理过期浏览记录。 */
async function cmdBackup() {
  const dir = String(flag('out', 'data/backup'));
  mkdirSync(dir, { recursive: true });
  const tables = ['platforms', 'games', 'game_aliases', 'offers', 'price_snapshots', 'daily_prices', 'watchlist', 'users'];

  const dump = {};
  let purged = 0;
  await withStore(async (store) => {
    const q = (sql, p) => store.query(sql, p);
    for (const table of tables) {
      dump[table] = (await q(`select * from ${table}`)).rows;
    }
    purged = await db.purgeOldViews(q, { days: Number(flag('days', 90)) });
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const file = `${dir}/backup-${stamp}.json.gz`;
  writeFileSync(file, gzipSync(JSON.stringify({ generatedAt: new Date().toISOString(), dump })));

  const files = readdirSync(dir).filter((n) => n.startsWith('backup-')).sort();
  let removed = 0;
  for (const old of files.slice(0, Math.max(0, files.length - 7))) {
    rmSync(`${dir}/${old}`, { force: true });
    removed += 1;
  }

  const rows = tables.reduce((sum, t) => sum + dump[t].length, 0);
  logger.info('backup.done', { file, tables: tables.length, rows, removedOld: removed, purgedViews: purged });
  console.log(`备份完成：${file}`);
  console.log(`  表 ${tables.length} 张、${rows} 行；清理旧备份 ${removed} 份；清理过期浏览记录 ${purged} 条`);
}

/** 标记感兴趣 / 不感兴趣。不感兴趣只影响列表展示，采集与统计照常。 */
async function cmdInterest() {
  const appid = Number(args[1]);
  const value = String(args[2] ?? '').toLowerCase();
  if (!Number.isFinite(appid) || !['on', 'off'].includes(value)) {
    throw new Error('用法: node src/cli.js interest <steamAppid> on|off');
  }
  const interested = value === 'on';
  const row = await withStore(async (store) => db.setInterest((sql, p) => store.query(sql, p), { steamAppid: appid, interested }));
  if (!row) throw new Error(`库里没有 appid ${appid}`);
  logger.info('interest.set', { appid, interested });
  console.log(`${row.name ?? appid} → ${interested ? '感兴趣' : '不感兴趣'}（采集与金额统计不受影响）`);
}

/**
 * 一体化：同一进程跑 Web/API，并把调度器作为子进程拉起。
 * 部署只需要一个服务：既能采集，又能出前端与 /console 控制台。
 */
async function cmdAll() {
  const port = Number(flag('port', process.env.WEB_PORT ?? 8080));
  const host = String(flag('host', '0.0.0.0'));
  const dir = String(flag('dir', existsSync('web') ? 'web' : (process.env.OUT_DIR ?? 'out')));
  if (!Number.isFinite(port) || port < 0) throw new Error(`端口不合法：${port}`);

  const store = await openStore(dbTarget, { logger });
  await db.migrate(store); // 启动即补齐列，避免旧库缺字段导致查询 500
  await (await import('./email-auth.js')).ensureEmailSchema(store); // 邮箱验证码相关表
  const srv = await startApiServer({
    query: (sql, p) => store.query(sql, p),
    logger,
    outDir: dir,
    port,
    host,
  });
  logger.info('app.all_mode', { port: srv.port, staticDir: dir });

  const child = spawn(process.execPath, ['src/scheduler.js'], { stdio: 'inherit' });
  child.on('exit', (code) => logger.warn('app.scheduler_exit', { code }));

  console.log(`服务已启动：http://<服务器IP>:${srv.port}/`);
  console.log(`管理控制台：http://<服务器IP>:${srv.port}/console（需管理员登录）`);
  console.log('采集调度器已在同一容器内启动；Ctrl+C 停止');

  await new Promise((done) => {
    const stop = () => {
      logger.info('app.stopping', {});
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      srv.close().then(() => store.close()).then(done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** 内置静态页服务：直接 IP:端口 访问生成好的页面，不需要外部 nginx。 */
async function cmdServe() {
  const port = Number(flag('port', process.env.WEB_PORT ?? process.env.PORT ?? 8090));
  const host = String(flag('host', '0.0.0.0'));
  // 有 web/ 就服务前端工程，否则退回静态页目录
  const dir = String(flag('dir', existsSync('web') ? 'web' : (process.env.OUT_DIR ?? 'out')));
  if (!Number.isFinite(port) || port < 0) throw new Error(`端口不合法：${port}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const store = await openStore(dbTarget, { logger });
  await db.migrate(store); // 启动即补齐列，避免旧库缺字段导致查询 500
  await (await import('./email-auth.js')).ensureEmailSchema(store); // 邮箱验证码相关表
  const srv = await startApiServer({
    query: (sql, p) => store.query(sql, p),
    logger,
    outDir: dir,
    port,
    host,
  });

  console.log(`Web 服务已启动：http://${host === '0.0.0.0' ? '<服务器IP>' : host}:${srv.port}/`);
  console.log(`静态目录：${dir} · 接口：/api/*（前台免登录可读，写操作需管理员）`);
  console.log('Ctrl+C 停止');

  await new Promise((done) => {
    const stopServer = () => {
      logger.info('web.stopping', {});
      srv.close().then(() => store.close()).then(done);
    };
    process.once('SIGINT', stopServer);
    process.once('SIGTERM', stopServer);
  });
}

async function cmdChart() {
  const outDir = String(flag('out', process.env.OUT_DIR ?? 'out'));
  const days = Number(flag('days', 90));
  const limit = Number(flag('limit', 200));
  const result = await withStore((store) =>
    buildSite((sql, p) => store.query(sql, p), { outDir, days, limit, logger }),
  );
  console.log(`已生成 ${result.games} 款游戏的价格页（${result.files.length} 个文件）→ ${result.outDir}/index.html`);
  console.log(`耗时 ${(result.elapsedMs / 1000).toFixed(2)}s`);
}

async function cmdList() {
  const rows = await withStore((store) => db.lowestOffers((sql, p) => store.query(sql, p), { limit: Number(flag('limit', 30)) }));
  if (!rows.length) {
    console.log('还没有报价数据。先 init → seed → sync steam/sonkwo');
    return;
  }
  console.log(`${pad('游戏', 30)} ${pad('平台', 14)} ${pad('现价', 10)} ${pad('原价', 10)} ${pad('折扣', 6)} ${pad('史低', 10)}`);
  console.log('-'.repeat(92));
  for (const r of rows) {
    const atLow = r.hist_low != null && r.price_cents <= r.hist_low ? '★' : '';
    console.log(
      `${pad(r.name, 30)} ${pad(r.platform_code, 14)} ${pad(yuan(r.price_cents), 10)} ${pad(yuan(r.original_cents), 10)} ` +
        `${pad(`-${r.discount_pct}%`, 6)} ${pad(yuan(r.hist_low), 10)} ${atLow}`,
    );
  }
}

async function cmdHistory() {
  const appid = Number(args[1]);
  if (!Number.isFinite(appid)) throw new Error('用法: node src/cli.js history <steamAppid> [--days 90]');
  const days = Number(flag('days', 90));
  const rows = await withStore((store) => db.priceHistory((sql, p) => store.query(sql, p), { steamAppid: appid, days }));
  if (!rows.length) {
    console.log(`appid ${appid} 没有历史数据`);
    return;
  }
  const byDay = new Map();
  for (const r of rows) {
    const cur = byDay.get(String(r.day));
    if (cur == null || r.min_price_cents < cur) byDay.set(String(r.day), r.min_price_cents);
  }
  const values = [...byDay.values()];
  console.log(`appid ${appid} 近 ${days} 天最低价（${values.length} 天有数据）`);
  console.log(`  ${sparkline(values)}   ${yuan(Math.min(...values))} ~ ${yuan(Math.max(...values))}`);
  for (const [day, price] of byDay) console.log(`  ${day}  ${yuan(price)}`);
  const low = await withStore((store) => db.isAtHistoricalLow((sql, p) => store.query(sql, p), { steamAppid: appid }));
  if (low) console.log(`\n当前最低 ${yuan(low.current)} / 史低 ${yuan(low.histLow)} → ${low.atLow ? '已是史低' : '还没到史低'}`);
}

async function cmdStats() {
  const s = await withStore((store) => db.stats((sql, p) => store.query(sql, p)));
  console.log(`游戏 ${s.games} / 报价 ${s.offers} / 快照 ${s.snapshots} / 日聚合 ${s.dailyRows}`);
  console.log(`平台：${s.platforms.map((p) => `${p.code}(${p.kind})`).join(', ') || '(空)'}`);
  if (s.lastRuns.length) {
    console.log('最近采集：');
    for (const r of s.lastRuns) {
      console.log(`  ${r.platform_code} ${r.started_at?.toISOString?.() ?? r.started_at} → ${r.status} 请求${r.requests} 成功${r.ok} 跳过${r.skipped} 失败${r.failed} ${r.note ?? ''}`);
    }
  }
}

/** 清理 N 天前的日志文件（jsonl / boot.log 按行截断）。 */
async function pruneLogs(days = 7) {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const dir = process.env.LOG_DIR ?? 'logs';
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let removed = 0;
  let kept = 0;
  let entries = [];
  try {
    entries = fsMod.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const p = pathMod.join(dir, name);
    try {
      const st = fsMod.statSync(p);
      if (st.mtimeMs < cutoff) {
        fsMod.unlinkSync(p);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      /* 单个文件失败不影响整体 */
    }
  }
  // boot.log 会持续追加，超过 5MB 时保留最后 2000 行
  const boot = pathMod.join(dir, 'boot.log');
  try {
    const st = fsMod.statSync(boot);
    if (st.size > 5 * 1024 * 1024) {
      const lines = fsMod.readFileSync(boot, 'utf8').split('\n');
      fsMod.writeFileSync(boot, lines.slice(-2000).join('\n'));
      logger.info('logs.boot_truncated', { keptLines: 2000 });
    }
  } catch {
    /* 没有 boot.log 就算了 */
  }
  logger.info('logs.pruned', { days, removed, kept });
  console.log(`日志清理完成：删除 ${removed} 个文件，保留 ${kept} 个（阈值 ${days} 天）`);
  return { removed, kept };
}

function cmdLogs() {
  if (flag('action') === 'prune' || process.argv.includes('prune')) {
    return pruneLogs(Number(flag('days', '7')) || 7);
  }
  const recs = readLogs({
    dir: String(flag('log-dir', 'logs')),
    level: flag('level', null),
    event: flag('event', null),
    runId: flag('run', null),
    sinceMinutes: flag('since', null) ? Number(flag('since', null)) : null,
    limit: Number(flag('limit', 50)),
  });
  if (!recs.length) {
    console.log('没有匹配的日志');
    return;
  }
  for (const r of recs.reverse()) {
    const { ts, level, event, pid, ...rest } = r;
    console.log(`${ts} ${level.toUpperCase().padEnd(5)} ${event} ${JSON.stringify(rest)}`);
  }
}

async function cmdDiagnose() {
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    logger.info('diagnose.check', { name, ok, detail });
  };

  add('node', true, process.version);
  add('platform', true, `${process.platform} ${process.arch}`);
  add('cwd', true, process.cwd());
  add('DATABASE_URL', Boolean(process.env.DATABASE_URL), process.env.DATABASE_URL ? '已设置（已脱敏）' : '未设置');
  add('ITAD_API_KEY', Boolean(process.env.ITAD_API_KEY), process.env.ITAD_API_KEY ? '已设置' : '未设置（ITAD 源会跳过）');

  // 出网通道：国内服务器访问 Steam 需要蒸汽专用代理，这里把决策结果显式打出来
  const proxyInfo = describeProxy(process.env);
  add('proxy:steam', true, proxyInfo.steam.via === 'direct' ? '直连（国内通常不可达）' : `${proxyInfo.steam.via} → ${proxyInfo.steam.proxy}`);
  add('proxy:others', true, proxyInfo.others.via === 'direct' ? '直连' : `${proxyInfo.others.via} → ${proxyInfo.others.proxy}`);

  if (dbTarget) {
    try {
      await withStore(async (store) => {
        const v = await db.serverVersion((sql, p) => store.query(sql, p));
        const alive = await ping(store);
        add('database', alive, `${v.version?.slice(0, 50)} tz=${v.timeZone}`);
        const t = await store.query(
          `select table_name from information_schema.tables where table_schema='public' order by table_name`,
        );
        const names = t.rows.map((r) => r.table_name);
        add('tables', names.includes('offers') && names.includes('price_snapshots'), names.join(',') || '(空)');
      });
    } catch (err) {
      add('database', false, String(err.message).slice(0, 200));
    }
  } else {
    add('database', false, '没有 DATABASE_URL，也没有 --db');
  }

  const net = async (name, url) => {
    try {
      const res = await fetchText(url, { logger, label: `diagnose.${name}`, retries: 0, timeoutMs: 12000 });
      add(`net:${name}`, true, `HTTP ${res.status} ${(res.bytes / 1024).toFixed(0)}KB ${res.elapsedMs}ms`);
    } catch (err) {
      // 把响应体片段带上：403 的 body 常常直接写着原因（如 "Invalid or expired api key"）
      const snippet = err.body ? ` body=${String(err.body).slice(0, 120)}` : '';
      add(`net:${name}`, false, `${String(err.message).slice(0, 140)}${snippet}`);
    }
  };
  await net('steam', 'https://store.steampowered.com/api/appdetails?appids=730&cc=cn');
  await net('sonkwo', 'https://www.sonkwo.hk/sku/111454');
  await net('itad', `https://api.isthereanydeal.com/games/search/v1?title=elden&key=${process.env.ITAD_API_KEY ?? 'none'}`);
  await net('fanatical', 'https://www.fanatical.com/');

  const failed = checks.filter((c) => !c.ok);
  console.log('\n检查项：');
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✘'} ${pad(c.name, 16)} ${c.detail}`);
  const file = `logs/diagnose-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ runId, checks }, null, 2), 'utf8');
  logger.info('diagnose.done', { failed: failed.length, total: checks.length, file });
  console.log(`\n${failed.length ? `${failed.length} 项异常` : '全部通过'}，报告已写入 ${file}`);
}

const commands = {
  init: cmdInit,
  bootstrap: cmdBootstrap,
  ping: cmdPing,
  seed: cmdSeed,
  'add-sku': cmdAddSku,
  list: cmdList,
  chart: cmdChart,
  watch: cmdWatch,
  alerts: cmdAlerts,
  discover: cmdDiscover,
  match: cmdMatch,
  compare: cmdCompare,
  import: cmdImport,
  serve: cmdServe,
  all: cmdAll,
  interest: cmdInterest,
  user: cmdUser,
  backup: cmdBackup,
  owned: cmdOwned,
  'notify-test': cmdNotifyTest,
  history: cmdHistory,
  stats: cmdStats,
  logs: cmdLogs,
  diagnose: cmdDiagnose,
};

/** 一键同步：把能采集的源按顺序跑一遍，最后重建页面。 */
async function cmdSyncAll() {
  const sources = ['sonkwo', 'gog', 'humble', 'steam', 'itad'];
  const enabled = {
    sonkwo: process.env.SONKWO_ENABLED !== '0',
    gog: process.env.GOG_ENABLED !== '0',
    humble: process.env.HUMBLE_ENABLED !== '0',
    steam: process.env.STEAM_ENABLED !== '0',
    itad: process.env.ITAD_ENABLED !== '0' && Boolean(process.env.ITAD_API_KEY),
  };
  const queue = sources.filter((s) => enabled[s]);

  if (!queue.length) throw new Error('没有启用任何采集源（检查 *_ENABLED / ITAD_API_KEY）');
  console.log(`一键同步：${queue.join(' → ')}（共 ${queue.length} 个源，串行执行）`);

  const results = [];
  for (const source of queue) {
    const startedAt = Date.now();
    console.log(`\n── ${source} ${'─'.repeat(Math.max(0, 40 - source.length))}`);
    // 子进程隔离：单个源崩溃不影响其它源，和调度器保持同一套行为
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['src/cli.js', 'sync', source], { stdio: 'inherit' });
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    results.push({ source, code, elapsedMs: Date.now() - startedAt });
    if (code !== 0) console.log(`${source} 失败（exit ${code}），继续下一个`);
  }

  // 采集完立刻重建页面，省掉再跑一次 chart
  console.log('\n── 重建页面 ──────────────────────────────');
  const chartCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.js', 'chart'], { stdio: 'inherit' });
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });

  const ok = results.filter((r) => r.code === 0).length;
  logger.info('sync.all_done', { sources: results, ok, failed: results.length - ok, chartCode });
  console.log(
    `\n完成：${ok}/${results.length} 个源成功` +
      (results.length - ok ? `，失败：${results.filter((r) => r.code !== 0).map((r) => r.source).join(', ')}` : '') +
      `；页面重建${chartCode === 0 ? '成功' : '失败'}`,
  );
  if (!ok) throw new Error('所有采集源都失败了，检查日志');
}

async function main() {
  if (command === 'sync') {
    const target = args[1];
    if (target === 'all') return cmdSyncAll();
    if (target === 'steam') return cmdSyncSteam();
    if (target === 'steamall') return cmdSyncSteamAll();
    if (target === 'catalog') return cmdImportSteamCatalog(); // 全量目录，一次请求 // 元数据 + 说明 + 价格，全部 Steam 游戏
    if (target === 'sonkwo') return cmdSyncSonkwo();
    if (target === 'itad') return cmdSyncItad();
    if (target === 'gog') return cmdSyncGog();
    if (target === 'humble') return cmdSyncHumble();
    throw new Error('用法: node src/cli.js sync all|steam|steamall|catalog|sonkwo|itad|gog|humble');
  }
  const fn = commands[command];
  if (!fn) {
    console.log(`用法: node src/cli.js <命令>

  init                 建表 + 平台字典（幂等）
  bootstrap            建表 + 首次自动导入游戏（容器启动用，幂等）
  ping                 健康检查：数据库可用则静默退出 0
  seed                 从 data/games.json 导入游戏
  add-sku <id...>      往 data/skus.json 加杉果 SKU（可 --appid 关联 Steam）
  sync steam           拉 Steam 国区价格（需能访问 store.steampowered.com）
  sync sonkwo          按 SKU 抓杉果价格
  sync itad            走 ITAD 官方 API（需 ITAD_API_KEY）
  sync gog             按英文名查 GOG 商店（catalog 接口，只接受精确标题）
  sync humble          按英文名探测 Humble 商品页（JSON-LD，命中率取决于 slug）
  list                 主榜：各游戏官方渠道最低价
  chart                生成静态价格页（曲线图）到 out/，用浏览器直接打开
  watch add|rm|list    关注列表：watch add 1091500 --target 99
  discover sonkwo      自动发现杉果 SKU（从前沿向后探测，连续空壳即停）
  match                把杉果 SKU 对齐到 Steam 游戏（--apply 自动应用、--confirm 手工确认）
  compare <appid>      多区服对比（--region 只看某区、--json 机器可读）
  import steam         导入 Steam 游戏信息（--appids / --urls / --file，双后端自动回落）
  owned <appid> on|off      标记已拥有（列表默认收起）
  interest <appid> on|off   标记感兴趣 / 不感兴趣
  serve                内置静态页服务：直接 IP:端口 访问页面（--port 8090 --dir out）
  alerts               检查关注列表是否到价（--mark 记录、--json 输出、--webhook 投递）
  notify-test          给所有已配置的提醒通道发一条测试消息（部署自检）
  history <appid>      价格轨迹（--days 90）
  stats                数据量 + 采集健康度
  logs                 查日志（--level error --event http --since 60 --limit 50）
  diagnose             环境/数据库/网络自检，报告落盘

通用参数：--db <target> --level <trace|debug|info|warn|error> --log-dir <dir>
环境变量：DATABASE_URL / ITAD_API_KEY / LOG_LEVEL / LOG_DIR

数据库：postgres://user:pass@host:5432/db，或 pglite:./data/pgdata（本地嵌入式）`);
    return;
  }
  await fn();
}

process.on('unhandledRejection', (err) => logger.fatal('process.unhandled_rejection', { err: serializeError(err) }));
process.on('uncaughtException', (err) => logger.fatal('process.uncaught_exception', { err: serializeError(err) }));

main()
  .then(() => logger.debug('process.exit', { code: 0 }))
  .catch((err) => {
    logger.error('process.command_failed', { command: args[0], err: serializeError(err) });
    console.error(`\n错误: ${err.message}`);
    console.error(`详细日志: ${logger.file?.() ?? 'logs/'}（runId=${runId}）`);
    process.exitCode = 1;
  });
