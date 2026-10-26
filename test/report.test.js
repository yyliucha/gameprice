import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  esc,
  fmtYuan,
  fmtPct,
  fmtDate,
  projectSeries,
  lineChart,
  sparkline,
  renderIndex,
  renderGame,
  buildSite,
  coverageFor,
} from '../src/report.js';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { ingestOffers } from '../src/ingest.js';

const seriesOf = (prices) =>
  prices.map((p, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, price_cents: p }));

test('esc 必须转义，价格数据来自第三方站点', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
  assert.equal(esc(null), '');
});

test('金额与日期格式化', () => {
  assert.equal(fmtYuan(9900), '¥99.00');
  assert.equal(fmtYuan(null), '—');
  assert.equal(fmtPct(50), '-50%');
  assert.equal(fmtPct(0), '—');
  assert.equal(fmtDate('2026-10-26T00:00:00Z'), '2026-10-26');
});

test('projectSeries 把价格映射到画布内，且价格全平时不越界', () => {
  const flat = projectSeries(seriesOf([1000, 1000, 1000]), { width: 400, height: 200, padding: { top: 10, right: 10, bottom: 10, left: 10 } });
  assert.ok(flat.yMin < flat.yMax, '价格全平时要给上下余量');
  for (const p of flat.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '坐标必须是有限数');
    assert.ok(p.y >= 10 && p.y <= 190, `点越界：${p.y}`);
  }
});

test('折线图：多点有 path，单点有圆点，空数据给提示', () => {
  const many = lineChart(seriesOf([29800, 14900, 9900]), { histLow: 9900 });
  assert.match(many, /<svg class="chart"/);
  assert.match(many, /class="line"/);
  assert.match(many, /class="area"/);
  assert.match(many, /史低 ¥99\.00/);
  assert.ok(!many.includes('NaN'), '不能出现 NaN');

  const single = lineChart(seriesOf([19900]));
  assert.match(single, /<circle class="dot"/);
  assert.ok(!single.includes('NaN'));

  assert.match(lineChart([]), /暂无历史数据/);
});

test('sparkline：数据不足与正常走势', () => {
  assert.match(sparkline(seriesOf([1000])), /数据不足/);
  const down = sparkline(seriesOf([20000, 15000]));
  assert.match(down, /class="spark down"/);
  const up = sparkline(seriesOf([10000, 20000]));
  assert.match(up, /class="spark up"/);
});

test('列表页：英文名 + 复制按钮 + 各平台价可对比', () => {
  const html = renderIndex({
    generatedAt: '2026-10-26 11:00:00',
    games: [
      {
        id: 1,
        steam_appid: 1091500,
        name: '赛博朋克 2077',
        name_en: 'Cyberpunk 2077',
        current_low: 3600,
        current_original: 3900,
        discount: 8,
        hist_low: 3600,
        series: seriesOf([3900, 3600]),
        all_offers: [
          { platform: 'sonkwo', platform_name: '杉果', price: 3600, currency: 'CNY' },
          { platform: 'gog', platform_name: 'GOG', price: 3900, currency: 'CNY' },
        ],
      },
    ],
  });
  assert.match(html, /Cyberpunk 2077/, '英文名要显示');
  assert.match(html, /data-copy="赛博朋克 2077"/, '中文名可复制');
  assert.match(html, /data-copy="Cyberpunk 2077"/, '英文名可复制');
  assert.match(html, /chip-low[^>]*>杉果/, '最低价平台要高亮');
  assert.match(html, /比次低便宜/, '要给出价差');
  assert.match(html, /杉果.*¥36\.00/, '平台价带金额');
  assert.match(html, /id="toast"/, '需要复制反馈');
});

test('详情页：英文名与复制按钮都在', () => {
  const html = renderGame({
    game: { id: 1, steam_appid: 1091500, name: '赛博朋克 2077', name_en: 'Cyberpunk 2077' },
    series: seriesOf([29800, 9900]),
    histLow: 9900,
    generatedAt: '2026-10-26 11:00:00',
    offers: [
      { platform_code: 'sonkwo', platform_name: '杉果', price_cents: 3600, original_cents: 3900, discount_pct: 8, buy_url: 'https://x' },
      { platform_code: 'gog', platform_name: 'GOG', price_cents: 3900, original_cents: 3900, discount_pct: 0, buy_url: 'https://y' },
    ],
  });
  assert.match(html, /Cyberpunk 2077/);
  assert.match(html, /data-copy="Cyberpunk 2077"/);
  assert.match(html, /class="best"/, '最低价那一行要标记');
  assert.match(html, /最低</, '最低价平台要打标签');
});

test('列表页：名称转义、史低标记、链接到详情页', () => {
  const html = renderIndex({
    generatedAt: '2026-10-26 11:00:00',
    games: [
      {
        id: 1,
        steam_appid: 1091500,
        name: '<赛博朋克> 2077',
        current_low: 9900,
        current_original: 29800,
        discount: 67,
        hist_low: 9900,
        series: seriesOf([29800, 9900]),
      },
      {
        id: 2,
        steam_appid: null,
        name: '无 appid 的游戏',
        current_low: 1000,
        current_original: 1000,
        discount: 0,
        hist_low: 2000,
        series: [],
      },
    ],
  });
  assert.ok(html.includes('&lt;赛博朋克&gt; 2077'), '名称必须被转义');
  assert.ok(!html.includes('<赛博朋克>'), '原始尖括号不能出现在输出里');
  assert.ok(html.includes('href="game-1091500.html"'));
  assert.ok(html.includes('href="game-n2.html"'), '没有 appid 时用 n<id>');
  assert.match(html, /class="tag">史低</);
  assert.match(html, /数据不足/);
});

test('详情页：KPI、曲线与报价表都在，平台名转义', () => {
  const html = renderGame({
    game: { id: 1, steam_appid: 1091500, name: '赛博朋克 2077' },
    series: seriesOf([29800, 14900, 9900]),
    histLow: 9900,
    generatedAt: '2026-10-26 11:00:00',
    offers: [
      { platform_code: 'steam', platform_name: 'Steam <国区>', price_cents: 14900, original_cents: 29800, discount_pct: 50, buy_url: 'https://store.steampowered.com/app/1091500/' },
    ],
  });
  assert.match(html, /当前最低/);
  assert.match(html, /历史最低/);
  assert.match(html, /class="chart"/);
  assert.ok(html.includes('Steam &lt;国区&gt;'), '平台名必须被转义');
  assert.match(html, /去购买/);
  assert.ok(!html.includes('NaN'));
});

test('buildSite 端到端：真 PG 语义 + 写文件（PGlite）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-site-'));
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);

    await ingestOffers(store, {
      platform: { code: 'steam', name: 'Steam 国区', kind: 'official' },
      offers: [
        {
          platformCode: 'steam',
          platformProductId: '1091500',
          steamAppid: 1091500,
          title: '<赛博朋克> 2077',
          productType: 'official_direct',
          region: 'cn',
          currency: 'CNY',
          priceCents: 9900,
          originalCents: 29800,
          discountPct: 67,
          inStock: true,
          buyUrl: 'https://store.steampowered.com/app/1091500/',
          meta: {},
        },
      ],
    });

    const gameId = (await store.query('select id from games where steam_appid = 1091500')).rows[0].id;
    // 造 6 天历史，价格逐日下降
    const prices = [29800, 29800, 19900, 19900, 14900, 9900];
    for (let i = 0; i < prices.length; i += 1) {
      await store.query(
        `insert into daily_prices (game_id, platform_code, region, day, min_price_cents, currency)
         values ($1,'steam','cn', current_date - ($2)::int, $3, 'CNY')`,
        [gameId, prices.length - i, prices[i]],
      );
    }

    const result = await buildSite(q, { outDir: dir, days: 90 });
    assert.equal(result.games, 1);
    assert.equal(result.files.length, 2);

    assert.ok(existsSync(join(dir, 'index.html')));
    assert.ok(existsSync(join(dir, 'game-1091500.html')));

    const index = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.ok(index.includes('&lt;赛博朋克&gt; 2077'), '端到端也要转义');
    assert.match(index, /<svg class="spark/);

    const page = readFileSync(join(dir, 'game-1091500.html'), 'utf8');
    assert.match(page, /<svg class="chart"/);
    assert.match(page, /史低 ¥99\.00/);
    assert.ok(!page.includes('NaN'));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空库时 buildSite 不报错，列表页给出提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-site-empty-'));
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const result = await buildSite((sql, p) => store.query(sql, p), { outDir: dir });
    assert.equal(result.games, 0);
    const index = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(index, /还没有任何价格记录/);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('平台覆盖：逐源说明为什么没有报价', () => {
  const game = { id: 1, steam_appid: null, name: '进击的打工人', name_en: null };
  const offers = [
    { platform_code: 'sonkwo', platform_name: '杉果', price_cents: 1500, original_cents: 1500, discount_pct: 0, buy_url: 'https://x' },
  ];
  const coverage = coverageFor({
    game,
    offers,
    sources: [
      { code: 'sonkwo', name: '杉果', on: true, missReason: '未收录' },
      { code: 'gog', name: 'GOG', on: true, missReason: '没有同名商品' },
      { code: 'humble', name: 'Humble', on: true, missReason: '没有同名商品' },
      { code: 'steam', name: 'Steam', on: true, missReason: '接口不可达' },
      { code: 'itad', name: 'ITAD', on: false, offReason: '未配置 ITAD_API_KEY' },
    ],
  });

  const hit = coverage.find((c) => c.code === 'sonkwo');
  assert.equal(hit.ok, true);
  assert.match(hit.note, /¥15\.00/);

  assert.match(coverage.find((c) => c.code === 'gog').note, /缺少英文名/);
  assert.match(coverage.find((c) => c.code === 'steam').note, /没有 Steam appid/);
  assert.match(coverage.find((c) => c.code === 'itad').note, /未配置 ITAD_API_KEY/);

  const html = renderGame({ game, series: seriesOf([1500, 1500]), histLow: 1500, generatedAt: '2026-10-26 11:00:00', offers, coverage });
  assert.match(html, /平台覆盖/);
  assert.match(html, /缺少英文名/);
  assert.match(html, /没有 Steam appid/);
});

test('列表页：感兴趣/不感兴趣标签页，行上带过滤标记', () => {
  const games = [
    { id: 1, steam_appid: 1, name: '喜欢的', current_low: 100, current_original: 100, discount: 0, hist_low: 100, series: [], interested: true },
    { id: 2, steam_appid: 2, name: '不喜欢的', current_low: 200, current_original: 200, discount: 0, hist_low: 200, series: [], interested: false },
  ];
  const html = renderIndex({ games, generatedAt: '2026-10-26 11:00:00' });
  assert.match(html, /class="tabs"/);
  assert.match(html, /全部 <b>2<\/b>/);
  assert.match(html, /感兴趣 <b>1<\/b>/);
  assert.match(html, /不感兴趣 <b>1<\/b>/);
  assert.match(html, /data-interested="1"/);
  assert.match(html, /data-interested="0"/);
  assert.match(html, /querySelectorAll\('\.tab'\)/, '要有前端过滤脚本');
});

test('详情页：开发商/发行商/分类与不感兴趣标记', () => {
  const html = renderGame({
    game: {
      id: 1,
      steam_appid: 1091500,
      name: '赛博朋克 2077',
      name_en: 'Cyberpunk 2077',
      interested: false,
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['角色扮演', '动作'],
    },
    series: seriesOf([29800, 9900]),
    histLow: 9900,
    generatedAt: '2026-10-26 11:00:00',
    offers: [],
  });
  assert.match(html, /开发商/);
  assert.match(html, /CD PROJEKT RED/);
  assert.match(html, /发行商/);
  assert.match(html, /分类/);
  assert.match(html, /角色扮演/);
  assert.match(html, /不感兴趣/);
});
