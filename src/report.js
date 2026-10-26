// 静态价格页生成：把 daily_prices 渲染成可以直接双击打开的 HTML。
//
// 设计取舍：
//   - 不引入任何前端依赖，图表是手写内联 SVG（离线可看、无 CDN、无构建步骤）
//   - 渲染函数是纯函数（输入数据 → 输出字符串），不碰数据库，方便单测
//   - 所有来自数据库的文本都必须 esc()，价格数据来自第三方站点，不能当可信输入
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OFFICIAL_FILTER_NOTE = '仅统计官方 / 授权分销渠道';

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtYuan = (cents) => (cents == null || Number.isNaN(cents) ? '—' : `¥${(Number(cents) / 100).toFixed(2)}`);

export const fmtPct = (pct) => (pct == null || Number(pct) <= 0 ? '—' : `-${Number(pct)}%`);

export const fmtDate = (day) => String(day ?? '').slice(0, 10);

/** 取"好看"的刻度步长：1/2/5 × 10ⁿ，避免出现 ¥83、¥141 这种标签。 */
export function niceStep(range, targetTicks = 4) {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

/** 把 [{day, price_cents}] 映射到 SVG 坐标；返回 {points, xMin, xMax, yMin, yMax, step, xOf, yOf}。 */
export function projectSeries(series, { width, height, padding, targetTicks = 4 }) {
  if (!series.length) return null;
  const times = series.map((p) => Date.parse(`${fmtDate(p.day)}T00:00:00Z`));
  const prices = series.map((p) => Number(p.price_cents));
  const xMin = Math.min(...times);
  const xMax = Math.max(...times);

  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi === lo) {
    // 价格全平时给一点上下余量，否则线会贴在边框上
    lo = Math.max(0, lo - 100);
    hi += 100;
  }
  const step = niceStep(hi - lo, targetTicks);
  const yMin = Math.max(0, Math.floor(lo / step) * step);
  const yMax = Math.ceil(hi / step) * step;

  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const xOf = (t) => padding.left + (xMax === xMin ? innerW / 2 : ((t - xMin) / (xMax - xMin)) * innerW);
  const yOf = (v) => padding.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const points = series.map((p, i) => ({
    x: xOf(times[i]),
    y: yOf(prices[i]),
    price: prices[i],
    day: fmtDate(p.day),
  }));
  return { points, xMin, xMax, yMin, yMax, step, xOf, yOf };
}

const yLabel = (v) => `¥${Math.round(v / 100)}`;

/** 折线图（带面积填充、网格、史低虚线、首尾价格标注）。 */
export function lineChart(series, { width = 760, height = 240, histLow = null, label = '价格轨迹' } = {}) {
  if (!series || series.length === 0) {
    return '<p class="muted">暂无历史数据</p>';
  }
  const padding = { top: 18, right: 16, bottom: 28, left: 56 };
  const proj = projectSeries(series, { width, height, padding });
  const { points, yMin, yMax, step, yOf } = proj;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1].x.toFixed(1)},${(height - padding.bottom).toFixed(1)} L${points[0].x.toFixed(1)},${(height - padding.bottom).toFixed(1)} Z`;

  // 刻度只落在 step 的整数倍上，标签才是 ¥100 / ¥150 这种整数
  const grid = [];
  for (let value = yMin; value <= yMax + 1e-9; value += step) {
    const y = yOf(value);
    grid.push(
      `<line class="grid" x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}"/>` +
        `<text class="axis" x="${padding.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(yLabel(value))}</text>`,
    );
  }

  // 史低虚线
  let histLine = '';
  if (histLow != null) {
    const y = yOf(histLow);
    if (y >= padding.top - 0.5 && y <= height - padding.bottom + 0.5) {
      histLine = `<line class="hist" x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}"/>` +
        `<text class="axis hist-label" x="${width - padding.right}" y="${(y - 6).toFixed(1)}" text-anchor="end">史低 ${esc(fmtYuan(histLow))}</text>`;
    }
  }

  const first = points[0];
  const last = points[points.length - 1];
  const dots = points.length === 1
    ? `<circle class="dot" cx="${first.x.toFixed(1)}" cy="${first.y.toFixed(1)}" r="3.5"/>`
    : `<circle class="dot" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5"/>`;

  const xLabels =
    `<text class="axis" x="${padding.left}" y="${height - 8}" text-anchor="start">${esc(first.day)}</text>` +
    (points.length > 1 ? `<text class="axis" x="${width - padding.right}" y="${height - 8}" text-anchor="end">${esc(last.day)}</text>` : '');

  return [
    `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}：${esc(fmtYuan(points[0].price))} 到 ${esc(fmtYuan(last.price))}">`,
    grid,
    `<path class="area" d="${area}"/>`,
    `<path class="line" d="${line}"/>`,
    histLine,
    dots,
    xLabels,
    '</svg>',
  ]
    .filter(Boolean)
    .join('');
}

/** 列表页的小走势图（无坐标轴）。 */
export function sparkline(series, { width = 132, height = 30 } = {}) {
  if (!series || series.length < 2) return '<span class="muted">数据不足</span>';
  const proj = projectSeries(series, { width, height, padding: { top: 3, right: 3, bottom: 3, left: 3 } });
  const d = proj.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const trend = proj.points[proj.points.length - 1].price <= proj.points[0].price ? 'down' : 'up';
  return `<svg class="spark ${trend}" viewBox="0 0 ${width} ${height}" role="img" aria-label="价格走势"><path d="${d}"/></svg>`;
}

const CSS = `
:root{--fg:#0f172a;--muted:#64748b;--line:#0ea5e9;--grid:#e2e8f0;--bg:#ffffff;--accent:#f59e0b}
*{box-sizing:border-box}
body{margin:0;padding:24px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
a{color:#0369a1;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto}
.meta{color:var(--muted);font-size:13px;margin-bottom:18px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.chart{width:100%;height:auto;display:block;margin:6px 0 4px}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{fill:var(--muted);font-size:11px}
.chart .line{fill:none;stroke:var(--line);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .area{fill:rgba(14,165,233,.12);stroke:none}
.chart .dot{fill:var(--line)}
.chart .hist{stroke:var(--accent);stroke-width:1;stroke-dasharray:4 4}
.chart .hist-label{fill:var(--accent)}
.spark path{fill:none;stroke-width:1.6;stroke-linejoin:round}
.spark.down path{stroke:#16a34a}.spark.up path{stroke:#dc2626}
.muted{color:var(--muted)}
.card{border:1px solid var(--grid);border-radius:10px;padding:16px 18px;margin:0 0 16px}
.row{display:flex;gap:28px;flex-wrap:wrap;margin:8px 0 0}
.kpi{min-width:120px}
.kpi .k{color:var(--muted);font-size:12px}
.kpi .v{font-size:20px;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px;margin-left:6px}
.tag.warn{background:#fef3c7;color:#92400e}
footer{margin-top:32px;color:var(--muted);font-size:12px}
`;

function page({ title, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body><div class="wrap">
${body}
<footer>数据来源：官方 / 授权分销渠道（Steam、杉果、ITAD 等）。价格以购买页为准。</footer>
</div></body>
</html>
`;
}

/** 列表页。games 来自 store.gameOverview，带上各自的 series 用于 sparkline。 */
export function renderIndex({ games, generatedAt, region = 'cn', days = 90 }) {
  const rows = games
    .map((g) => {
      const atLow = g.hist_low != null && g.current_low != null && g.current_low <= g.hist_low;
      const href = `game-${g.steam_appid ?? `n${g.id}`}.html`;
      return `<tr>
  <td><a href="${esc(href)}">${esc(g.name)}</a>${atLow ? '<span class="tag">史低</span>' : ''}</td>
  <td class="num">${esc(fmtYuan(g.current_low))}</td>
  <td class="num">${esc(fmtYuan(g.current_original))}</td>
  <td class="num">${esc(fmtPct(g.discount))}</td>
  <td class="num">${esc(fmtYuan(g.hist_low))}</td>
  <td>${sparkline(g.series ?? [])}</td>
</tr>`;
    })
    .join('\n');

  const body = `<h1>游戏价格轨迹</h1>
<p class="meta">${esc(OFFICIAL_FILTER_NOTE)} · 区服 ${esc(region)} · 近 ${esc(days)} 天 · 生成于 ${esc(generatedAt)} · 共 ${games.length} 款</p>
${
  games.length
    ? `<table>
<thead><tr><th>游戏</th><th class="num">现价</th><th class="num">原价</th><th class="num">折扣</th><th class="num">史低</th><th>走势</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
    : '<p class="muted">还没有任何价格记录。先跑一次 <code>sync sonkwo</code> 或 <code>sync steam</code>。</p>'
}`;
  return page({ title: '游戏价格轨迹', body });
}

/** 详情页：曲线 + 当前各平台报价。 */
export function renderGame({ game, series, offers, histLow, generatedAt, days = 90 }) {
  const currentLow = offers.length ? Math.min(...offers.map((o) => o.price_cents)) : null;
  const atLow = currentLow != null && histLow != null && currentLow <= histLow;
  const prices = series.map((s) => Number(s.price_cents));
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const minDay = series.find((s) => Number(s.price_cents) === min)?.day;

  const offerRows = offers
    .map(
      (o) => `<tr>
  <td>${esc(o.platform_name ?? o.platform_code)}</td>
  <td class="num">${esc(fmtYuan(o.price_cents))}</td>
  <td class="num">${esc(fmtYuan(o.original_cents))}</td>
  <td class="num">${esc(fmtPct(o.discount_pct))}</td>
  <td>${o.buy_url ? `<a href="${esc(o.buy_url)}" rel="noopener noreferrer nofollow" target="_blank">去购买</a>` : '<span class="muted">—</span>'}</td>
</tr>`,
    )
    .join('\n');

  const body = `<p class="meta"><a href="index.html">← 返回列表</a></p>
<h1>${esc(game.name)}${atLow ? '<span class="tag">史低</span>' : ''}</h1>
<p class="meta">${esc(OFFICIAL_FILTER_NOTE)} · 近 ${esc(days)} 天 · 生成于 ${esc(generatedAt)}${
    game.steam_appid ? ` · <a href="https://store.steampowered.com/app/${esc(game.steam_appid)}/" rel="noopener noreferrer nofollow" target="_blank">Steam 商店</a>` : ''
  }</p>

<div class="card">
  <div class="row">
    <div class="kpi"><div class="k">当前最低</div><div class="v">${esc(fmtYuan(currentLow))}</div></div>
    <div class="kpi"><div class="k">历史最低</div><div class="v">${esc(fmtYuan(histLow))}${minDay ? `<div class="k">${esc(fmtDate(minDay))}</div>` : ''}</div></div>
    <div class="kpi"><div class="k">区间均价</div><div class="v">${esc(fmtYuan(avg))}</div></div>
    <div class="kpi"><div class="k">区间最高</div><div class="v">${esc(fmtYuan(max))}</div></div>
  </div>
  ${lineChart(series, { histLow, label: `${game.name} 价格轨迹` })}
</div>

<h2>当前报价</h2>
${
  offers.length
    ? `<table>
<thead><tr><th>平台</th><th class="num">价格</th><th class="num">原价</th><th class="num">折扣</th><th>链接</th></tr></thead>
<tbody>
${offerRows}
</tbody>
</table>`
    : '<p class="muted">当前没有在售报价（可能缺货或该区服不可售）。</p>'
}`;
  return page({ title: `${game.name} 价格轨迹`, body });
}

/**
 * 生成整套静态站点。
 * q: (sql, params) => Promise<{rows}>
 */
export async function buildSite(q, { outDir = 'out', days = 90, limit = 200, region = 'cn', logger = null } = {}) {
  const { gameOverview, dailyMinSeries, offersOfGame } = await import('./store/pg.js');
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const games = await gameOverview(q, { region, limit });
  if (!games.length) {
    logger?.warn('report.empty', { region, limit });
  }

  mkdirSync(outDir, { recursive: true });
  const written = [];

  const indexGames = [];
  for (const game of games) {
    const series = await dailyMinSeries(q, { gameId: game.id, region });
    const offers = await offersOfGame(q, { gameId: game.id, region });
    const slug = game.steam_appid ?? `n${game.id}`;
    const file = `game-${slug}.html`;
    writeFileSync(
      join(outDir, file),
      renderGame({ game, series, offers, histLow: game.hist_low, generatedAt, days }),
      'utf8',
    );
    written.push(file);
    indexGames.push({
      ...game,
      series,
      discount:
        game.current_original && game.current_low != null && game.current_original > game.current_low
          ? Math.round((1 - game.current_low / game.current_original) * 100)
          : 0,
    });
    logger?.debug('report.page', { game: game.name, days: series.length, offers: offers.length });
  }

  writeFileSync(join(outDir, 'index.html'), renderIndex({ games: indexGames, generatedAt, region, days }), 'utf8');
  written.push('index.html');

  const result = { outDir, games: games.length, files: written, elapsedMs: Date.now() - startedAt };
  logger?.info('report.build', { ...result, files: written.length });
  return result;
}
