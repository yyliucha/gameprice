#!/usr/bin/env node
// 生成演示数据：用于本地看页面效果 / 截图，不参与生产采集。
//
// 用法：node scripts/demo-seed.js [--db pglite:./data/demo-pgdata] [--days 90]
// 完成后跑：node src/cli.js chart --db pglite:./data/demo-pgdata --out out
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { ingestOffers } from '../src/ingest.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const target = flag('db', 'pglite:./data/demo-pgdata');
const days = Number(flag('days', 90));

// 造几条"像真的"的曲线：平时原价，促销期打折，最近一次打到史低
const DEMO = [
  {
    appid: 1091500,
    name: '赛博朋克 2077',
    base: 29800,
    curve: (g) => (g <= 8 ? 9900 : g <= 30 ? 14900 : g <= 55 ? 29800 : 14900),
    offers: [
      { platform: 'steam', name: 'Steam 国区', price: 9900, original: 29800, url: 'https://store.steampowered.com/app/1091500/' },
      { platform: 'sonkwo', name: '杉果', price: 11800, original: 29800, url: 'https://www.sonkwo.hk/sku/111454' },
    ],
  },
  {
    appid: 1245620,
    name: '艾尔登法环',
    base: 39800,
    curve: (g) => (g <= 20 ? 27860 : 39800),
    offers: [
      { platform: 'steam', name: 'Steam 国区', price: 27860, original: 39800, url: 'https://store.steampowered.com/app/1245620/' },
    ],
  },
  {
    appid: null,
    name: '愚者不灭',
    base: 19800,
    curve: (g) => (g <= 3 ? 15840 : 19800),
    offers: [
      { platform: 'sonkwo', name: '杉果', price: 15840, original: 19800, url: 'https://www.sonkwo.hk/sku/111454' },
    ],
  },
];

const store = await openStore(target, {});
try {
  await db.migrate(store);
  const q = (sql, p) => store.query(sql, p);

  for (const game of DEMO) {
    const resolved = await db.ensureGame(q, { steamAppid: game.appid, name: game.name });
    const platform = game.offers[0];
    const kindOf = (code) => (code === 'steam' ? 'official' : 'authorized_reseller');
    await ingestOffers(store, {
      platform: { code: platform.platform, name: platform.name, kind: kindOf(platform.platform) },
      offers: game.offers.map((o) => ({
        // 必须逐条带 platform：一个批次里可能混多个平台
        platform: { code: o.platform, name: o.name, kind: kindOf(o.platform) },
        platformCode: o.platform,
        platformProductId: String(game.appid ?? game.name),
        steamAppid: game.appid,
        title: game.name,
        productType: o.platform === 'steam' ? 'official_direct' : 'authorized_key',
        region: 'cn',
        currency: 'CNY',
        priceCents: o.price,
        originalCents: o.original,
        discountPct: Math.round((1 - o.price / o.original) * 100),
        inStock: true,
        buyUrl: o.url,
        meta: {},
      })),
    });

    await store.query(
      `insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
       select $1, $2, 'cn', current_date - g, $3, 'CNY'
       from generate_series(0, $4) as g
       on conflict (game_id, platform_code, region, day) do update
         set min_price_cents = least(daily_prices.min_price_cents, excluded.min_price_cents)`,
      [resolved.id, platform.platform, game.base, days - 1],
    );

    // 曲线按天差异化：逐天更新成设计好的价格
    for (let g = 0; g < days; g += 1) {
      await store.query(
        `update daily_prices set min_price_cents = $1
          where game_id = $2 and platform_code = $3 and region = 'cn' and day = current_date - ($4)::int`,
        [game.curve(g), resolved.id, platform.platform, g],
      );
    }
    console.log(`已生成 ${game.name}（${days} 天历史）`);
  }

  const s = await db.stats(q);
  console.log(`\n演示库就绪：${target}`);
  console.log(`游戏 ${s.games} / 报价 ${s.offers} / 日聚合 ${s.dailyRows}`);
  console.log(`下一步：node src/cli.js chart --db ${target} --out out`);
} finally {
  await store.close();
}
