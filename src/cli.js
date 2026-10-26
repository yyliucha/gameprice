#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createLogger, serializeError, readLogs } from './log.js';
import { openStore, ping } from './store/index.js';
import * as db from './store/pg.js';
import { ingestOffers } from './ingest.js';
import { buildSite } from './report.js';
import { evaluateAlerts, renderDigest, toPayload, postWebhook } from './alerts.js';
import { descriptor as steam, syncPrices, syncMeta } from './adapters/steam.js';
import { descriptor as sonkwo, fetchSku } from './adapters/sonkwo.js';
import { descriptor as itad, searchGame, fetchPrices, normalizeDeals } from './adapters/itad.js';
import { descriptor as gogDescriptor, searchOffer as gogSearch } from './adapters/gog.js';
import { descriptor as humbleDescriptor, searchOffer as humbleSearch } from './adapters/humble.js';

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

const dbTarget = String(flag('db', process.env.DATABASE_URL ?? ''));
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
  const webhook = String(flag('webhook', process.env.ALERT_WEBHOOK_URL ?? ''));
  const mark = flag('mark', false) === true || flag('mark', false) === 'true';

  logger.info('alert.evaluated', {
    watched: rows.length,
    hits: hits.length,
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
  if (webhook) {
    const result = await postWebhook(webhook, toPayload(hits, { now: new Date() }), { logger });
    delivered = result.ok;
    console.log(delivered ? `\n已投递到 webhook（HTTP ${result.status}）` : `\nwebhook 投递失败（${result.status ?? result.error}）`);
  }

  if (mark && (delivered || !webhook)) {
    await withStore(async (store) => {
      const q = (sql, p) => store.query(sql, p);
      for (const h of hits) await db.markNotified(q, { watchId: h.watchId, priceCents: h.currentCents });
    });
    logger.info('alert.marked', { count: hits.length });
    console.log(`已记录 ${hits.length} 条提醒，同价位不会重复通知。`);
  } else if (mark && webhook && !delivered) {
    logger.warn('alert.not_marked', { reason: 'webhook_failed' });
    console.log('投递失败，未记录提醒状态（下轮会重试）。');
  }
}

/**
 * 按英文名检索型适配器的通用同步流程（GOG / Humble）。
 * 关键点：把 steamAppid 注入 offer，才能并进已有游戏行而不是新建一条英文名记录。
 */
async function syncByTitle(adapter, { label = adapter.code, limit = 50, rate = 1200 } = {}) {
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

  logger.info('sync.start', { platform: adapter.code, games: games.length });
  const offers = [];
  let noMatch = 0;
  for (const g of games) {
    try {
      const { offer } = await adapter.searchOffer(g.name_en, { logger, steamAppid: g.steam_appid });
      if (offer) offers.push(offer);
      else noMatch += 1;
    } catch (err) {
      logger.error('sync.item_failed', { platform: adapter.code, game: g.name_en, err: serializeError(err) });
    }
    await sleep(rate);
  }

  const stats = await withStore((store) => ingestOffers(store, { platform: adapter, offers, logger }));
  logger.info('sync.done', { platform: adapter.code, queried: games.length, matched: offers.length, noMatch, ...stats });
  console.log(`${label}：查询 ${games.length} 款，匹配 ${offers.length} 款，未找到 ${noMatch} 款`);
}

async function cmdSyncGog() {
  await syncByTitle(gog, { label: 'GOG', limit: Number(flag('limit', 50)), rate: Number(flag('rate', 1200)) });
}

async function cmdSyncHumble() {
  await syncByTitle(humble, { label: 'Humble', limit: Number(flag('limit', 50)), rate: Number(flag('rate', 1500)) });
}

async function cmdChart() {
  const outDir = String(flag('out', 'out'));
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

function cmdLogs() {
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
  history: cmdHistory,
  stats: cmdStats,
  logs: cmdLogs,
  diagnose: cmdDiagnose,
};

async function main() {
  if (command === 'sync') {
    const target = args[1];
    if (target === 'steam') return cmdSyncSteam();
    if (target === 'sonkwo') return cmdSyncSonkwo();
    if (target === 'itad') return cmdSyncItad();
    if (target === 'gog') return cmdSyncGog();
    if (target === 'humble') return cmdSyncHumble();
    throw new Error('用法: node src/cli.js sync steam|sonkwo|itad|gog|humble');
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
  alerts               检查关注列表是否到价（--mark 记录、--json 输出、--webhook 投递）
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
