#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
import { describeProxy, decideProxy, parseProxy, redactProxy } from './proxy.js';
import { startStaticServer } from './serve.js';
import * as settings from './settings.js';

// 统一成 { code, name, kind, ..., searchOffer } 的形状，供 syncByTitle 复用
const gog = { ...gogDescriptor, searchOffer: gogSearch };
const humble = { ...humbleDescriptor, searchOffer: humbleSearch };
import { fetchText, fetchJson, fetchBuffer, sleep, proxyStatusHint } from './http.js';
import { runPool } from './pool.js';
import { createBackup } from './backup.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
// 同步结束时写进 sync_runs.output 的一行摘要（控制台「同步记录」的结果列显示它）
let syncNote = '';
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

/**
 * 大多数 CLI 命令在真正干活前先水合一次设置：
 *   sync itad 这类命令在 withStore 之前就读 process.env.ITAD_API_KEY，
 *   不提前水合会拿到旧值。这里单独开一个短连接，读完即关。
 */
const NO_HYDRATE = new Set(['init', 'bootstrap', 'ping', 'help', 'logs', 'all', 'serve']);
async function hydrateCliSettings() {
  if (NO_HYDRATE.has(command)) return;
  try {
    const store = await openStore(dbTarget, { logger });
    try {
      // 老库可能还没建表；先补齐，避免设置水合时 SMTP 表不存在
      await ensureSchema(store);
      await settings.initializeSettings({ store, logger });
    } finally {
      await store.close();
    }
    // 显式 --level 优先于数据库里的日志级别
    const level = flag('level', null);
    if (level && typeof level === 'string') logger.setLevel(level);
  } catch (err) {
    logger.warn('settings.hydrate_failed', { message: String(err.message).slice(0, 200) });
  }
}

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
    await settings.initializeSettings({ store, logger });
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
    // 建设置表；老部署（已有管理员）在这里自动标记初始化完成并导入 .env
    await settings.initializeSettings({ store, logger });

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
  await withStore(async (store) => {
    const q = (sql, p) => store.query(sql, p);
    for (let i = 0; i < apps.length; i += 500) {
      const batch = apps.slice(i, i + 500);
      const ids = batch.map((a) => a.appid);
      const names = batch.map((a) => a.name || ('appid:' + a.appid));
      const r = await q(
        "insert into games (steam_appid, name) " +
          "select x.appid, x.name from unnest($1::int[], $2::text[]) as x(appid, name) " +
          "where not exists (select 1 from games g where g.steam_appid = x.appid)",
        [ids, names],
      );
      inserted += r.rowCount ?? 0;
      if ((i / 500) % 20 === 0) {
        const msg = "已处理 " + (i + batch.length) + " / " + apps.length + "，新增 " + inserted;
        console.log("  " + msg);
        logger.info('import.steamcatalog.progress', { done: i + batch.length, total: apps.length, inserted });
      }
    }
  });
  logger.info("import.steamcatalog.done", { total: apps.length, inserted });
  console.log("完成：目录 " + apps.length + " 条，新增 " + inserted + " 款");
  console.log("下一步：node src/cli.js sync steamall --limit 200 --sleep 2（慢慢补价格与说明）");
}

async function cmdSyncSteamAll() {
  // 只挑"还没有 Steam 价格或说明"的游戏，按 id 顺序推进，避免重复抓同一批
  const startedMs = Date.now();
  const limit = Number(flag('limit', '200')) || 200;
  const sleepMs = Math.max(0, Number(flag('sleep', '2')) || 0) * 1000;
  // 并发抓取：默认 4 路，配合每路 sleep 控制总速率（--concurrency 1 即回到串行）
  const concurrency = Math.max(1, Math.min(Number(flag('concurrency', 4)) || 4, 16));
  const rows = await withStore(async (store) => {
    const r = await store.query(
      "select g.steam_appid from games g where g.steam_appid is not null " +
        "and not g.deleted " +
        "and (g.description is null or g.description = '' or not exists (select 1 from offers o where o.game_id = g.id and o.platform_code = 'steam')) " +
        "order by g.id limit $1",
      [limit],
    );
    return r.rows;
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const appids = rows.map((r) => Number(r.steam_appid)).filter((n) => Number.isFinite(n) && n > 0);
  if (!appids.length) throw new Error('库里没有带 appid 的游戏：先 node src/cli.js import steam --appids ...');

  console.log(`同步 ${appids.length} 款 Steam 游戏（官方接口：元数据 + 说明 + 价格，并发 ${concurrency}）`);
  const backend = String(flag('backend', 'official'));
  const items = [];
  let blocked = 0; // 连续 403/429 计数：被限流时及时中止，避免把 IP 越打越黑
  await runPool(
    appids,
    concurrency,
    async (appid) => {
      try {
        const one = await fetchMetadata([appid], { backend, logger });
        if (one.items?.length) items.push(...one.items);
      } catch (err) {
        const status = Number(err.status) || 0;
        if (status === 403 || status === 429) {
          blocked += 1;
          logger.warn('sync.rate_limited', { appid, status, blocked });
          if (blocked >= 5) {
            throw new Error(`Steam 返回 ${status}（出口 IP 被限流），本轮已中止：降低 limit/并发，等 1~2 小时再试`);
          }
        }
        logger.warn('sync.item_failed', { appid, message: String(err.message).slice(0, 160) });
      }
      if (sleepMs) await sleep(sleepMs);
    },
    {
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) console.log(`  进度 ${done} / ${total}`);
      },
    },
  );
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
    const dlcCount = items.filter((i) => i.appType === 'dlc').length;
    logger.info('sync.steamall.done', { appids: appids.length, items: items.length, dlc: dlcCount, described, priced, ...stats });
    console.log(`完成：${items.length} 条元数据（其中 DLC ${dlcCount} 款；说明 ${described} 条）、${priced} 条 Steam 价格（新增 ${stats.inserted}）`);
    syncNote = `元数据 ${items.length} 条（说明 ${described}）、Steam 价格 ${priced} 条（新增 ${stats.inserted}）`;
  } else if (!items.length) {
    logger.warn('sync.steamall.empty', { appids: appids.length, backend });
    console.log('完成：0 条元数据 —— 拉取全部失败。先排查网络/代理：');
    console.log('  docker compose exec app node src/cli.js diagnose   # 看 net:steam 一行');
    console.log('  日志里搜 steam.meta.failed 可看到每个 appid 的失败原因');
    syncNote = '0 条元数据（拉取全部失败，先看 diagnose 的 net:steam）';
  } else {
    console.log(`完成：${items.length} 条元数据，没有可入库的价格（汇率区/免费游戏）`);
    syncNote = `元数据 ${items.length} 条（无可入库价格）`;
  }

  // 增量同步顺带补封面图：前台不用再等 4 小时的补图任务；--images 0 可关，--image-sleep 控制节奏
  const withImages = String(flag('images', '1')) !== '0' && process.env.SYNC_IMAGES_ENABLED !== '0';
  if (withImages && items.length) {
    const images = await import('./images.js');
    const sizes = String(flag('image-sizes', 'capsule_sm_120,header'))
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const imageSleep = Math.max(0, Number(flag('image-sleep', '200')) || 0);
    let imgOk = 0;
    let imgFailed = 0;
    for (const item of items) {
      const appid = Number(item.steamAppid);
      if (!Number.isFinite(appid) || appid <= 0) continue;
      for (const size of sizes) {
        if (!images.isImageSize(size)) continue;
        try {
          const r = await images.downloadImage(appid, size, { fetchBuffer, logger, timeoutMs: 12000 });
          if (r.ok) imgOk += 1;
          else imgFailed += 1;
        } catch (err) {
          imgFailed += 1;
          logger.warn('sync.image_failed', { appid, size, message: String(err.message).slice(0, 160) });
        }
        if (imageSleep) await sleep(imageSleep);
      }
    }
    console.log('封面图：成功 ' + imgOk + ' 张，失败 ' + imgFailed + ' 张');
    syncNote = (syncNote ? syncNote + '；' : '') + '封面图 ' + imgOk + ' 张';
  }
  // 价格简报：本次同步产生的涨跌（价格快照带 prev_price_cents 后才统计得到）
  const priceSummary = await printSyncPriceReport(startedMs, 5);
  if (priceSummary) syncNote = (syncNote ? syncNote + '；' : '') + priceSummary;
}

/** 打印某个时间窗内的价格变动简报；失败只警告，不影响同步结果。 */
async function printSyncPriceReport(sinceMs, limit = 5) {
  try {
    const rep = await withStore((store) =>
      db.priceChanges((sql, p) => store.query(sql, p), { sinceMs, limit }),
    );
    if (!rep.changed) {
      console.log('本次没有价格变动');
      return '价格无变动';
    }
    console.log(`\n本次价格变动：降价 ${rep.drops} 条 / 涨价 ${rep.rises} 条`);
    for (const d of rep.topDrops) {
      const pct = d.was > 0 ? Math.round((d.drop_cents / d.was) * 100) : 0;
      console.log(`  ↓ ¥${(d.was / 100).toFixed(2)} → ¥${(d.now_price / 100).toFixed(2)}（-${pct}%）${d.name} · ${d.platform_name}`);
    }
    for (const r of rep.topRises.slice(0, limit)) {
      console.log(`  ↑ ¥${(r.was / 100).toFixed(2)} → ¥${(r.now_price / 100).toFixed(2)}  ${r.name} · ${r.platform_name}`);
    }
    logger.info('sync.price_report', { hours: rep.hours, changed: rep.changed, drops: rep.drops, rises: rep.rises });
    return `降价 ${rep.drops} 条 / 涨价 ${rep.rises} 条`;
  } catch (err) {
    logger.warn('sync.price_report_failed', { message: String(err.message).slice(0, 160) });
    return '';
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
    'SteamDeals 测试消息',
    `时间：${new Date().toISOString()}`,
    `通道：${channels.map((c) => c.name).join(', ')}`,
    '收到这条说明提醒链路已打通。',
  ].join('\n');
  const result = await deliver(channels, {
    text,
    payload: { type: 'steamdeals.test', text },
    subject: 'SteamDeals 测试邮件',
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
  const result = await withStore((store) =>
    createBackup((sql, p) => store.query(sql, p), {
      dir,
      keep: 7,
      viewDays: Number(flag('days', 90)),
      logger,
    }),
  );
  console.log(`备份完成：${result.file}`);
  console.log(
    `  表 ${result.tables} 张、${result.rows} 行；清理旧备份 ${result.removedOld} 份；` +
      `清理过期浏览记录 ${result.purgedViews} 条；清理过期邮件记录 ${result.purgedCodes} 条`,
  );
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
  await (await import('./steam-login.js')).ensureSteamSchema(store); // Steam 登录与游戏库
  const initialized = await settings.initializeSettings({ store, logger });
  const levelFlag = flag('level', null);
  if (levelFlag && typeof levelFlag === 'string') logger.setLevel(levelFlag);
  const q = (sql, p) => store.query(sql, p);
  const srv = await startApiServer({
    query: q,
    logger,
    outDir: dir,
    port,
    host,
    store,
    setupToken: process.env.SETUP_TOKEN ?? '',
    getSetupState: async () => ({ completed: await settings.isSetupComplete(q) }),
  });
  logger.info('app.all_mode', { port: srv.port, staticDir: dir, setupCompleted: initialized.completed });

  const child = spawn(process.execPath, ['src/scheduler.js'], { stdio: 'inherit' });
  child.on('exit', (code) => logger.warn('app.scheduler_exit', { code }));

  console.log(`服务已启动：http://<服务器IP>:${srv.port}/`);
  if (!initialized.completed) {
    console.log(`首次初始化：http://<服务器IP>:${srv.port}/setup`);
    logger.info('app.setup_required', { url: '/setup', setupToken: Boolean(process.env.SETUP_TOKEN) });
  }
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
  const initialized = await settings.initializeSettings({ store, logger });
  const levelFlag = flag('level', null);
  if (levelFlag && typeof levelFlag === 'string') logger.setLevel(levelFlag);
  const q = (sql, p) => store.query(sql, p);
  const srv = await startApiServer({
    query: q,
    logger,
    outDir: dir,
    port,
    host,
    store,
    setupToken: process.env.SETUP_TOKEN ?? '',
    getSetupState: async () => ({ completed: await settings.isSetupComplete(q) }),
  });

  console.log(`Web 服务已启动：http://${host === '0.0.0.0' ? '<服务器IP>' : host}:${srv.port}/`);
  if (!initialized.completed) console.log(`首次初始化：http://${host === '0.0.0.0' ? '<服务器IP>' : host}:${srv.port}/setup`);
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

  // 代理"协议层"探测：TCP 通 ≠ CONNECT 通（407 要账号密码、403 是代理禁目标、代理挂了是 ECONNREFUSED）。
  // 关键点：必须用**未脱敏**的代理地址探测——凭证在 URL 里，拿 "http://***@host" 去探只会得到 407。
  const probeProxyConnect = async (proxyUrl, target) => {
    const u = new URL(proxyUrl.includes('://') ? proxyUrl : 'http://' + proxyUrl);
    const secure = u.protocol === 'https:';
    const headers = { host: target };
    if (u.username) {
      const cred = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(cred).toString('base64');
    }
    try {
      const res = await new Promise((resolve, reject) => {
        const req = (secure ? httpsRequest : httpRequest)(
          {
            host: u.hostname,
            port: Number(u.port || (secure ? 443 : 80)),
            method: 'CONNECT',
            path: target,
            headers,
            timeout: 12000,
          },
          () => reject(new Error('代理没有返回 CONNECT 响应')),
        );
        req.on('connect', (r, sock) => {
          sock.destroy();
          resolve(r);
        });
        req.on('timeout', () => req.destroy(new Error('CONNECT 超时（12s）')));
        req.on('error', reject);
        req.end();
      });
      const status = res.statusCode;
      const detail = status === 200 ? '成功：代理能建隧道' : proxyStatusHint(status);
      return { ok: status === 200, detail: `CONNECT ${target} → ${status}（${detail}）` };
    } catch (err) {
      return { ok: false, detail: `CONNECT ${target} 失败：${String(err.message).slice(0, 140)}` };
    }
  };

  // socks5:// 之类会被 parseProxy 静默丢掉、回落直连——最难查的一类配置错误，单独报出来
  const rawSteamProxy = String(process.env.STEAM_PROXY ?? process.env.steam_proxy ?? '').trim();
  if (rawSteamProxy && !parseProxy(rawSteamProxy)) {
    add('proxy:format', false, 'STEAM_PROXY 不是合法的 http/https 地址（只支持 http:// 或 https://，socks5 不支持）');
  }

  // store 与 api 的放行规则经常不一样，而「导入目录」走的正是 api.steampowered.com
  const steamRoute = decideProxy('api.steampowered.com', process.env);
  if (steamRoute.url) {
    const shown = redactProxy(steamRoute.url);
    for (const [name, target] of [
      ['proxy:connect', 'store.steampowered.com:443'],
      ['proxy:connect:api', 'api.steampowered.com:443'],
      ['proxy:connect:community', 'steamcommunity.com:443'],
    ]) {
      const r = await probeProxyConnect(steamRoute.url, target);
      add(name, r.ok, `${r.detail}${shown ? `；代理 ${shown}` : ''}`);
    }
  }

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

  const net = async (name, url, opts = {}) => {
    try {
      const res = await fetchText(url, { logger, label: `diagnose.${name}`, retries: 0, timeoutMs: 12000, ...opts });
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
  // 封面图链路：与 /img/steam 的三条兜底路径一一对应，图片 404 时看这三行
  const imgPath = '/steam/apps/413150/capsule_sm_120.jpg';
  await net('img:cf-proxy', 'https://cdn.cloudflare.steamstatic.com' + imgPath);
  await net('img:ak-direct', 'https://cdn.akamai.steamstatic.com' + imgPath);
  await net('img:cf-direct', 'https://cdn.cloudflare.steamstatic.com' + imgPath, { forceDirect: true });

  // Steam Web API Key 校验：store/api/appdetails 是免 key 的，key 只用于个人资料/游戏库/目录，
  // 所以同步成功不代表 key 有效——这里用 GetPlayerSummaries 单独验一次。
  const apiKey = String(process.env.STEAM_API_KEY ?? '').trim();
  if (!apiKey) {
    add('steam.api_key', false, '未配置 STEAM_API_KEY（Steam 登录/游戏库同步不可用，采集不受影响）');
  } else {
    try {
      const res = await fetchJson(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=76561198000000000`,
        { logger, label: 'diagnose.api_key', retries: 0, timeoutMs: 12000 },
      );
      const players = res.json?.response?.players;
      const text = JSON.stringify(res.json ?? {}).slice(0, 120);
      if (Array.isArray(players)) add('steam.api_key', true, `可用（HTTP ${res.status}，玩家查询正常返回）`);
      else add('steam.api_key', false, `返回结构异常：${text}`);
    } catch (err) {
      const body = err.body ? ` body=${String(err.body).slice(0, 120)}` : '';
      add('steam.api_key', false, `${String(err.message).slice(0, 120)}${body}（403 通常就是 key 无效）`);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('\n检查项：');
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✘'} ${pad(c.name, 16)} ${c.detail}`);
  const file = `logs/diagnose-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ runId, checks }, null, 2), 'utf8');
  logger.info('diagnose.done', { failed: failed.length, total: checks.length, file });
  console.log(`\n${failed.length ? `${failed.length} 项异常` : '全部通过'}，报告已写入 ${file}`);
}

/**
 * 代理专项排查：TCP → CONNECT（带/不带认证）→ 真正经代理访问 Steam。
 * 三层的失败原因完全不同（防火墙 / 白名单 / 认证 / 协议不对），必须分开看。
 */
async function cmdProxyCheck() {
  const net = await import('node:net');
  const { describeProxy, parseProxy, redactProxy } = await import('./proxy.js');
  const info = describeProxy(process.env);
  const steamUrl = parseProxy(process.env.STEAM_PROXY ?? process.env.steam_proxy ?? '');
  console.log('配置：Steam 专用代理 = ' + (steamUrl ? redactProxy(steamUrl) : '（未配置）'));
  console.log('      通用出网代理 = ' + (info.others.via === 'direct' ? '（未配置）' : info.others.proxy));
  if (!steamUrl) {
    console.log('\n没有配置 Steam 专用代理：Steam 目前直连（国内通常不可达 api.steampowered.com）。');
    return;
  }

  const u = new URL(steamUrl);
  console.log('      凭证 = ' + (u.username ? '已配置（用户名 ' + decodeURIComponent(u.username) + '）' : '未配置 —— 若代理要求认证就会 407'));
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const host = u.hostname;

  // 1) TCP：主机端口通不通
  const tcp = await new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 6000 });
    s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
    s.once('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
  console.log('\n1) TCP ' + host + ':' + port + ' → ' + (tcp.ok ? '✔ 通' : '✘ ' + tcp.error));
  if (!tcp.ok) {
    console.log('   → 端口不通：防火墙/安全组拦了出站，或代理端口不是 ' + port + '。');
    return;
  }

  // 2) HTTP CONNECT：能不能建隧道（这里才看得出 407/403）
  const connectTest = (withAuth) =>
    new Promise((resolve) => {
      const headers = { host: 'store.steampowered.com:443' };
      if (withAuth) {
        const cred = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
        headers['proxy-authorization'] = 'Basic ' + Buffer.from(cred).toString('base64');
      }
      const req = httpRequest(
        { host, port, method: 'CONNECT', path: 'store.steampowered.com:443', headers, timeout: 8000 },
        (res) => { res.resume(); resolve({ error: '代理把 CONNECT 当普通请求处理了，返回 HTTP ' + res.statusCode }); },
      );
      let settled = false;
      req.on('connect', (res, sock) => { settled = true; sock.destroy(); resolve({ status: res.statusCode }); });
      req.on('timeout', () => { req.destroy(); if (!settled) resolve({ error: 'timeout（8s 无响应）' }); });
      req.on('error', (e) => { if (!settled) resolve({ error: e.code || e.message }); });
      req.end();
    });
  const plain = await connectTest(false);
  const explain = (r) => {
    if (r.status === 200) return '✔ 200（隧道已建立）';
    if (r.status === 407) return '✘ 407 需要账号密码 → 填 http://账号:密码@' + host + ':' + port;
    if (r.status === 403) return '✘ 403 代理拒绝该目标（可能是 IP 白名单/目标限制）';
    if (r.status) return '✘ HTTP ' + r.status;
    return '✘ ' + r.error;
  };
  console.log('2) CONNECT store.steampowered.com:443 → ' + explain(plain));
  if (u.username) console.log('   CONNECT（带认证）→ ' + explain(await connectTest(true)));

  // 3) 真正经代理拿一次 Steam 数据（含 TLS 与证书校验）
  try {
    const res = await fetchText('https://store.steampowered.com/api/appdetails?appids=413150&cc=cn&l=schinese', {
      label: 'proxy-check',
      logger,
      retries: 0,
      timeoutMs: 15000,
    });
    console.log('3) 经代理访问 Steam → ✔ HTTP ' + res.status + '，' + res.bytes + ' 字节');
  } catch (err) {
    const cause = err.cause ? String(err.cause.message ?? err.cause) : '';
    console.log('3) 经代理访问 Steam → ✘ ' + err.message + (cause ? '（cause: ' + cause + '）' : ''));
  }

  console.log('\n结论对照：');
  console.log('  407 → 设置里补账号密码；403/隧道被关 → 把本机公网 IP 加进代理白名单');
  console.log('  立即断开/乱码 → 这个端口多半是 SOCKS5，不是 HTTP 代理');
  console.log('  certificate/ssl → 代理地址写了 https:// 而实际是 http 代理，改成 http://');
}

/**
 * 批量回填：用 IStoreBrowseService/GetItems（一次最多 100 个 appid）把全量目录的
 * 元数据 + 国区价格补齐。失败/缺 key 时回退到单条 appdetails。
 */
async function cmdBackfill() {
  const batch = Math.max(1, Math.min(Number(flag('batch', '50')) || 50, 100));
  const sleepMs = Math.max(0, Number(flag('sleep', '1500')) || 0);
  const limit = Math.max(1, Math.min(Number(flag('limit', '20000')) || 20000, 200000));
  // 单条回退上限：大跑时设 0 可完全关掉，把"缺的少量游戏"留给小任务慢慢补
  const fallbackMax = Math.max(0, Math.min(Number(flag('fallback', '10')) || 0, 100));
  const { fetchStoreItems } = await import('./adapters/store-browse.js');
  const key = String(process.env.STEAM_API_KEY ?? '').trim();
  const startedMs = Date.now();
  let done = 0;
  let stored = 0;
  let fallback = 0;
  let failed = 0;
  let batches = 0;

  // 限流/风控/方法错误时立刻中止：继续跑只会把代理 IP 打进黑名单
  const abort = (message, extra = {}) => {
    logger.error('backfill.aborted', { message, ...extra });
    throw new Error(message);
  };

  console.log(`批量回填：每批 ${batch} 个、间隔 ${sleepMs}ms、上限 ${limit} 款、单条回退 ${fallbackMax} 个/批${key ? '' : '（未配置 STEAM_API_KEY，将全部走单条接口）'}`);

  while (done < limit) {
    const size = Math.min(batch, limit - done);
    const rows = await withStore((store) =>
      store.query(
        'select g.steam_appid from games g where g.steam_appid is not null and not g.deleted ' +
          "and (g.description is null or g.description = '' or not exists (select 1 from offers o where o.game_id = g.id and o.platform_code = 'steam')) " +
          'order by g.id limit $1',
        [size],
      ),
    );
    const appids = rows.rows.map((r) => Number(r.steam_appid)).filter((n) => Number.isFinite(n) && n > 0);
    if (!appids.length) {
      console.log('没有需要回填的游戏了');
      break;
    }
    batches += 1;

    let items = [];
    let missed = [];
    if (key) {
      try {
        const r = await fetchStoreItems(appids, { key, logger, throwOnFatal: true });
        items = r.items;
        missed = r.failed;
      } catch (err) {
        if (err.status === 405) {
          abort('批量接口返回 405（POST 被拒）：当前镜像过旧，GetItems 需要 GET + input_json（0.25.2+），升级后再跑', { status: 405 });
        }
        if (err.status === 403 || err.status === 429) {
          abort(`Steam 返回 HTTP ${err.status}（限流/风控），已立即中止回填避免 IP 被封；等 30-60 分钟后把 --sleep 调大再试`, { status: err.status });
        }
        logger.warn('backfill.batch_failed', { message: String(err.message).slice(0, 160) });
        missed = appids;
      }
    } else {
      missed = appids;
    }

    // 回退：批量接口没返回的，逐个走 appdetails（默认最多 10 个/批，避免拖慢）
    if (fallbackMax > 0) {
      for (const appid of missed.slice(0, fallbackMax)) {
        try {
          const one = await fetchMetadata([appid], { backend: 'official', logger });
          if (one.items?.length) items.push(...one.items);
          fallback += 1;
        } catch (err) {
          if (err.status === 403 || err.status === 429) {
            abort(`单条回退遇到 HTTP ${err.status}（限流），已立即中止回填`, { status: err.status, appid });
          }
          failed += 1;
          logger.warn('backfill.item_failed', { appid, message: String(err.message).slice(0, 160) });
        }
        await sleep(400);
      }
    }
    failed += Math.max(0, missed.length - fallbackMax);

    // 写库：每批只开 1 个连接（之前是每款一个，100 连接/批，日志会被 db.connect 刷屏）
    if (items.length) {
      await withStore(async (store) => {
        const q = (sql, p) => store.query(sql, p);
        const offers = [];
        for (const item of items) {
          await db.upsertGameMeta(q, item);
          stored += 1;
          if (item.priceOverview) {
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
              buyUrl: 'https://store.steampowered.com/app/' + item.steamAppid + '/',
              meta: {},
            });
          }
        }
        if (offers.length) {
          await ingestOffers(store, { platform: { code: 'steam', name: 'Steam 国区', kind: 'official' }, offers, logger });
        }
      });
    }

    done += appids.length;
    const rate = Math.round((done / Math.max(1, Date.now() - startedMs)) * 60000);
    console.log(`  批次 ${batches}：本批 ${appids.length} 款，写入 ${items.length}，回退 ${fallback}，失败 ${failed}；累计 ${done}/${limit}（${rate} 款/分钟）`);
    if (sleepMs) await sleep(sleepMs);
  }

  logger.info('backfill.done', { done, stored, fallback, failed, batches, elapsedMs: Date.now() - startedMs });
  console.log(`完成：处理 ${done} 款，写入 ${stored} 条元数据，单条回退 ${fallback}，失败 ${failed}`);
}

async function cmdReport() {
  const sub = String(args[1] ?? 'price');
  if (sub !== 'price') {
    throw new Error('用法: node src/cli.js report price [--hours 24] [--limit 10] [--csv] [--days 7]');
  }
  const hours = Number(flag('hours', 24));
  const limit = Number(flag('limit', 10));

  // CSV 输出：重定向到文件即可用 Excel 打开
  if (flag('csv', false) === true) {
    const rows = await withStore((store) => db.priceChangeRows((sql, p) => store.query(sql, p), { hours }));
    const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    console.log('appid,name,platform,platform_name,old_price,new_price,drop_pct,captured_at');
    for (const r of rows) {
      const pct = r.was > 0 ? (((r.was - r.now_price) / r.was) * 100).toFixed(1) : '';
      console.log([r.steam_appid ?? '', r.name, r.platform, r.platform_name,
        (r.was / 100).toFixed(2), (r.now_price / 100).toFixed(2), pct,
        String(r.captured_at).slice(0, 19).replace('T', ' ')].map(cell).join(','));
    }
    return;
  }

  const rep = await withStore((store) => db.priceChanges((sql, p) => store.query(sql, p), { hours, limit }));
  const daily = await withStore((store) => db.priceChangesByDay((sql, p) => store.query(sql, p), { days: Number(flag('days', 7)) }));
  console.log(`近 ${rep.hours} 小时价格变动：降价 ${rep.drops} 条 / 涨价 ${rep.rises} 条 / 新史低 ${rep.newLows} 条（共 ${rep.changed} 条）`);
  if (!rep.changed) {
    console.log('（没有变动：要么价格没变，要么快照是在加入 prev_price_cents 之前写的）');
  } else {
    const fmt = (x) => `¥${(x / 100).toFixed(2)}`;
    const when = (t) => String(t).slice(0, 16).replace('T', ' ');
    console.log('\n降价 Top：');
    for (const d of rep.topDrops) {
      const pct = d.was > 0 ? Math.round((d.drop_cents / d.was) * 100) : 0;
      console.log(`  ${fmt(d.was)} → ${fmt(d.now_price)}  -${pct}%  ${d.name} · ${d.platform_name}  ${when(d.captured_at)}`);
    }
    console.log('\n涨价 Top：');
    for (const r of rep.topRises) {
      console.log(`  ${fmt(r.was)} → ${fmt(r.now_price)}  ${r.name} · ${r.platform_name}  ${when(r.captured_at)}`);
    }
  }
  if (daily.length) {
    console.log('\n近 ' + daily.length + ' 天趋势：');
    for (const d of daily) console.log(`  ${d.day}  降价 ${d.drops} / 涨价 ${d.rises}（共 ${d.changed}）`);
  }

  // --notify：把报表推到已配置的提醒通道（webhook / 企微 / 邮件）
  if (flag('notify', false) === true) {
    const channels = channelsFromEnv();
    if (!channels.length) {
      console.log('\n没有配置任何提醒通道，跳过推送（ALERT_WEBHOOK_URL / WECOM_WEBHOOK_URL / SMTP_HOST+ALERT_EMAIL_TO）');
    } else {
      const fmt = (x) => `¥${(x / 100).toFixed(2)}`;
      const lines = [
        `SteamDeals 价格报表（近 ${rep.hours} 小时）`,
        `降价 ${rep.drops} 条 / 涨价 ${rep.rises} 条 / 新史低 ${rep.newLows} 条`,
      ];
      for (const d of rep.topDrops.slice(0, 5)) {
        const pct = d.was > 0 ? Math.round((d.drop_cents / d.was) * 100) : 0;
        lines.push(`↓ ${fmt(d.was)} → ${fmt(d.now_price)}（-${pct}%）${d.name} · ${d.platform_name}`);
      }
      for (const r of rep.topRises.slice(0, 3)) {
        lines.push(`↑ ${fmt(r.was)} → ${fmt(r.now_price)}  ${r.name} · ${r.platform_name}`);
      }
      if (daily.length) lines.push('近 7 天：' + daily.map((d) => `${d.day} 降${d.drops}/涨${d.rises}`).join('；'));
      const text = lines.join('\n');
      const result = await deliver(channels, {
        text,
        payload: { type: 'steamdeals.price_report', text },
        subject: 'SteamDeals 价格报表',
        logger,
      });
      for (const r of result.results) {
        console.log(`  ${r.ok ? '✔' : '✘'} ${r.channel}  ${r.ok ? `HTTP ${r.status ?? ''}` : (r.error ?? `errcode=${r.errcode}`)}`);
      }
      console.log(result.ok ? '报表已推送。' : '报表推送失败，见日志 notify.* 事件。');
      if (!result.ok) process.exitCode = 1;
    }
  }
  logger.info('report.price', { hours: rep.hours, changed: rep.changed, drops: rep.drops, rises: rep.rises, newLows: rep.newLows });
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
  backfill: cmdBackfill,
  'proxy-check': cmdProxyCheck,
  images: cmdImages,
  report: cmdReport,
};

/**
 * 封面图本地缓存：批量下载到 data/images（宿主机挂载卷），下载一次后由本机直接提供，
 * 之后不再依赖 Steam CDN / 香港代理（VPS 只用于采集数据）。
 */
async function cmdImages() {
  const sub = String(args[1] ?? 'pull');
  const images = await import('./images.js');
  if (sub === 'stats') {
    const s = images.imageStats();
    console.log(`图片缓存：${s.images} 张 / ${s.games} 款游戏 / ${(s.bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`目录：${s.root}`);
    return;
  }
  if (sub !== 'pull') {
    throw new Error('用法: node src/cli.js images pull [--limit 200] [--sleep 300] [--sizes capsule_sm_120,header] | images stats');
  }
  const limit = Math.min(Math.max(Number(flag('limit', '200')) || 200, 1), 5000);
  const sleepMs = Math.max(0, Number(flag('sleep', '300')) || 0);
  const sizes = String(flag('sizes', 'capsule_sm_120,header'))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => images.isImageSize(s));
  if (!sizes.length) throw new Error('--sizes 不合法，可选：' + images.IMG_SIZES.join(' / '));

  // 只补「有价格数据」的游戏：列表/详情才用得到图，全量目录不下载
  const rows = await withStore((store) =>
    store.query(
      'select g.steam_appid from games g where g.steam_appid is not null ' +
        'and exists (select 1 from daily_prices d where d.game_id = g.id) ' +
        'order by g.updated_at desc nulls last, g.id desc limit $1',
      [limit * 4],
    ),
  );
  const appids = [];
  for (const row of rows.rows) {
    const appid = Number(row.steam_appid);
    if (!Number.isFinite(appid) || appid <= 0) continue;
    if (sizes.every((size) => images.hasImage(appid, size))) continue; // 已缓存齐全
    appids.push(appid);
    if (appids.length >= limit) break;
  }
  if (!appids.length) {
    const s = images.imageStats();
    console.log(`都有图了：${s.images} 张 / ${s.games} 款游戏 / ${(s.bytes / 1024 / 1024).toFixed(1)} MB`);
    return;
  }

  console.log(`准备补图：${appids.length} 款 × ${sizes.length} 张（${sizes.join(' + ')}），每张间隔 ${sleepMs}ms`);
  const stats = { downloaded: 0, skipped: 0, failed: 0 };
  for (const appid of appids) {
    for (const size of sizes) {
      if (images.hasImage(appid, size)) {
        stats.skipped += 1;
        continue;
      }
      const r = await images.downloadImage(appid, size, { fetchBuffer, logger, timeoutMs: 12000 });
      if (r.ok) {
        stats.downloaded += 1;
        if (stats.downloaded % 20 === 0) console.log(`  已下载 ${stats.downloaded} 张…（最近 ${appid}/${size}）`);
      } else {
        stats.failed += 1;
        logger.warn('images.failed', { appid, size, message: String(r.error?.message ?? '').slice(0, 160) });
      }
      if (sleepMs) await sleep(sleepMs);
    }
  }
  const local = images.imageStats();
  logger.info('images.pull.done', { ...stats, images: local.images, games: local.games, bytes: local.bytes });
  console.log(`完成：新下载 ${stats.downloaded} 张，跳过 ${stats.skipped} 张，失败 ${stats.failed} 张`);
  console.log(`缓存合计：${local.images} 张 / ${local.games} 款游戏 / ${(local.bytes / 1024 / 1024).toFixed(1)} MB → ${local.root}`);
}

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

/** 本次同步的任务号（控制台触发时由 env 传入，这时不重复建记录）。 */
function syncRunEnvId() {
  const id = Number(process.env.SYNC_RUN_ID);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** 建一条同步记录（定时任务/命令行手动跑都会留痕，控制台能看到）。 */
async function beginSyncRunRecord(mode) {
  const existing = syncRunEnvId();
  if (existing) return { id: existing, own: false };
  try {
    const id = await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      const run = await db.insertSyncRun(q, { mode, args: args.join(' ') });
      return run.id;
    });
    return { id, own: true };
  } catch (err) {
    logger.warn('sync.run_begin_failed', { mode, message: String(err.message).slice(0, 160) });
    return { id: null, own: false };
  }
}

async function finishSyncRunRecord(run, status, note = '') {
  if (!run?.own || !run.id) return; // 控制台触发的任务由 web 进程负责收尾
  try {
    await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      await db.finishSyncRun(q, run.id, { status, output: note ? String(note).slice(0, 2000) : null });
    });
  } catch (err) {
    logger.warn('sync.run_finish_failed', { runId: run.id, message: String(err.message).slice(0, 160) });
  }
}

/** 采集健康度（fetch_runs）：每个源的同步都留一行，`stats` 命令与排障能直接看。 */
async function beginFetchRunRecord(platformCode) {
  try {
    return await withStore(async (store) => db.startFetchRun((sql, p) => store.query(sql, p), platformCode));
  } catch (err) {
    logger.warn('fetch_run.begin_failed', { platformCode, message: String(err.message).slice(0, 160) });
    return null;
  }
}

async function finishFetchRunRecord(id, { status, note = '', stats = null }) {
  if (!id) return;
  try {
    await withStore(async (store) =>
      db.finishFetchRun((sql, p) => store.query(sql, p), id, {
        status,
        note: note ? String(note).slice(0, 500) : null,
        requests: stats?.requests ?? 0,
        total: stats?.total ?? 0,
        ok: stats?.ok ?? 0,
        skipped: stats?.skipped ?? 0,
        failed: stats?.failed ?? 0,
      }),
    );
  } catch (err) {
    logger.warn('fetch_run.finish_failed', { id, message: String(err.message).slice(0, 160) });
  }
}

/**
 * 同步命令的"记录"包装：sync_runs（任务级）+ fetch_runs（采集健康度）各留一条。
 * 注意 sync steam 自己已经写 fetch_runs，传 { fetchRun: false } 避免重复。
 */
async function runSyncTracked(mode, fn, { fetchRun = true } = {}) {
  const run = await beginSyncRunRecord(mode);
  const fetchRunId = fetchRun ? await beginFetchRunRecord(mode) : null;
  try {
    await fn();
    await finishSyncRunRecord(run, 'ok', syncNote || null);
    await finishFetchRunRecord(fetchRunId, { status: 'ok', note: syncNote });
  } catch (err) {
    await finishSyncRunRecord(run, 'failed', String(err.message).slice(0, 500));
    await finishFetchRunRecord(fetchRunId, { status: 'failed', note: String(err.message).slice(0, 300) });
    throw err;
  }
}

async function main() {
  // 先把库里的业务设置水合到 process.env（sync itad 等命令在 withStore 之前就会读 Key）
  if (command === 'sync' || (commands[command] && !NO_HYDRATE.has(command))) {
    await hydrateCliSettings();
  }
  if (command === 'sync') {
    const target = args[1];
    if (target === 'all') return cmdSyncAll();
    // 各源同步都留一条记录（定时任务也能在控制台「同步记录」里看到）
    if (target === 'steam') return runSyncTracked('steam', cmdSyncSteam, { fetchRun: false });
    if (target === 'steamall') return runSyncTracked('steamall', cmdSyncSteamAll);
    if (target === 'catalog') return runSyncTracked('catalog', cmdImportSteamCatalog);
    if (target === 'sonkwo') return runSyncTracked('sonkwo', cmdSyncSonkwo);
    if (target === 'itad') return runSyncTracked('itad', cmdSyncItad);
    if (target === 'gog') return runSyncTracked('gog', cmdSyncGog);
    if (target === 'humble') return runSyncTracked('humble', cmdSyncHumble);
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
  sync steamall        补元数据/说明/价格 + 封面图（--limit 200 --sleep 2 --concurrency 4 --images 0 可关）
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
  report price         价格涨跌报表（--hours 24 --limit 10 --notify 推送到提醒通道 --csv）
  logs                 查日志（--level error --event http --since 60 --limit 50）
  diagnose             环境/数据库/网络自检，报告落盘
  proxy-check          代理专项排查：TCP → CONNECT → 经代理访问 Steam
  backfill             批量回填全量游戏的元数据/价格（GetItems，一次最多 100 个 appid）
                       --limit 200000 --batch 100 --sleep 3000 --fallback 10（回退数设 0 关闭单条回退）

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
