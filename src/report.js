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

/** 行内复制按钮：data-copy 里放原文（会被转义）。 */
const copyBtn = (text, label = '名称') =>
  `<button class="copy" type="button" data-copy="${esc(text)}" title="复制${esc(label)}" aria-label="复制${esc(label)}">⧉</button>`;

/**
 * 游戏名：中文在上、英文在下，各自带复制按钮。
 * 英文名缺失或与中文同名时不重复显示。
 */
function nameBlock({ name, nameEn = null, href = null, tag = null }) {
  const zh = href ? `<a href="${esc(href)}">${esc(name)}</a>` : esc(name);
  const en =
    nameEn && String(nameEn).trim() && String(nameEn).trim() !== String(name).trim()
      ? `<div class="name-en">${esc(nameEn)}${copyBtn(nameEn, '英文名')}</div>`
      : '';
  const badge = tag ? `<span class="tag">${esc(tag)}</span>` : '';
  return `<div class="name-zh">${zh}${copyBtn(name, '中文名')}${badge}</div>${en}`;
}

const CSS = `
:root{
  --bg:#f6f7f9; --panel:#ffffff; --fg:#0f172a; --muted:#64748b; --line:#0ea5e9;
  --border:#e5e7eb; --brand:#4f46e5; --good:#059669; --good-bg:#ecfdf5;
  --warn:#b45309; --warn-bg:#fffbeb; --hover:#f8fafc; --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px -12px rgba(15,23,42,.18);
  --radius:14px; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0b1020; --panel:#121a2e; --fg:#e6eaf2; --muted:#93a0b8; --border:#22304d;
    --brand:#818cf8; --good:#34d399; --good-bg:#0d2b24; --warn:#fbbf24; --warn-bg:#2b2109;
    --hover:#18233c; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -16px rgba(0,0,0,.7);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  font-feature-settings:"tnum";
}
a{color:var(--brand);text-decoration:none;transition:opacity .15s}
a:hover{opacity:.75;text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}

/* 顶栏 */
.topbar{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(140%) blur(10px);border-bottom:1px solid var(--border)}
.topbar .wrap{display:flex;align-items:center;gap:10px;height:56px}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:var(--fg)}
.brand .dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#22d3ee,#4f46e5);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 18%,transparent)}
.topbar .spacer{flex:1}
.topbar .stamp{color:var(--muted);font-size:12px}

main{padding:28px 0 8px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:17px;margin:30px 0 12px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:13px;margin:0 0 20px}
.muted{color:var(--muted)}
.small{font-size:12px}

/* 名称与复制按钮 */
.name-zh{display:inline-flex;align-items:center;gap:6px;font-weight:600;vertical-align:middle}
.name-en{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;margin-top:1px;font-family:var(--mono)}
button.copy{
  border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;
  border-radius:6px;padding:0 5px;font-size:11px;line-height:18px;opacity:.55;transition:opacity .12s,color .12s,border-color .12s;
}
button.copy:hover{opacity:1;color:var(--brand);border-color:var(--brand)}
#toast{
  position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(8px);
  background:var(--fg);color:var(--bg);padding:8px 16px;border-radius:999px;font-size:13px;
  opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:50;
}
#toast.on{opacity:.95;transform:translateX(-50%) translateY(0)}

/* 表格卡片 */
.tablecard{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:14px}
thead th{
  text-align:left;padding:11px 14px;background:color-mix(in srgb,var(--muted) 8%,transparent);
  color:var(--muted);font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase;
  border-bottom:1px solid var(--border);white-space:nowrap;
}
tbody td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--hover)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.num{font-family:var(--mono);font-size:13.5px}
tbody a{font-weight:600}

/* 徽标 */
.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--good-bg);color:var(--good);font-size:11.5px;font-weight:700;margin-left:6px;vertical-align:1px}
.tag.warn{background:var(--warn-bg);color:var(--warn)}
.tabs{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap}
.sorts{display:flex;gap:8px;align-items:center;margin:0 0 14px;color:var(--muted);font-size:12.5px}
.sort{border:0;background:transparent;color:var(--muted);cursor:pointer;font-family:inherit;font-size:12.5px;padding:2px 6px;border-radius:6px}
.sort:hover{color:var(--fg);background:var(--hover)}
.sort.on{color:var(--brand);font-weight:600}
.tab{border:1px solid var(--border);background:var(--panel);color:var(--muted);border-radius:999px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit}
.tab:hover{color:var(--fg)}
.tab.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.tab b{font-weight:600;margin-left:4px}
.facts{display:flex;flex-wrap:wrap;gap:18px;margin:10px 0 6px}
.fact{display:flex;flex-direction:column;gap:2px}
.fk{color:var(--muted);font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:600}
.fv{font-size:13.5px}
.fv .chip{margin:0 4px 0 0}

/* 平台价标签 */
.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border:1px solid var(--border);border-radius:999px;font-size:12px;white-space:nowrap;margin:1px 2px;background:var(--panel);color:var(--muted)}
.chip b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
.chip-low{border-color:color-mix(in srgb,var(--good) 55%,var(--border));background:var(--good-bg);color:var(--good)}
.chip-low b{color:var(--good)}
.coverage{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 0}
.cov{display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:10px;padding:6px 12px;font-size:13px;background:var(--panel)}
.cov.ok{border-color:color-mix(in srgb,var(--good) 45%,var(--border));background:var(--good-bg)}
.cov-name{font-weight:600}
.cov-note{color:var(--muted);font-size:12px}
.cov.ok .cov-note{color:var(--good)}

/* 图表 */
.chart{width:100%;height:auto;display:block;margin:8px 0 4px}
.chart .grid{stroke:var(--border);stroke-width:1}
.chart .axis{fill:var(--muted);font-size:11px}
.chart .line{fill:none;stroke:var(--line);stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}
.chart .area{fill:color-mix(in srgb,var(--line) 14%,transparent);stroke:none}
.chart .dot{fill:var(--line);stroke:var(--panel);stroke-width:2}
.chart .hist{stroke:var(--warn);stroke-width:1;stroke-dasharray:4 4}
.chart .hist-label{fill:var(--warn)}
.spark path{fill:none;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.spark.down path{stroke:var(--good)}.spark.up path{stroke:#ef4444}

/* KPI 卡片 */
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;margin:0 0 18px;box-shadow:var(--shadow)}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin:4px 0 0}
.kpi .k{color:var(--muted);font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600}
.kpi .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em;margin-top:2px}

tr.best td{background:color-mix(in srgb,var(--good) 7%,transparent)}
footer{border-top:1px solid var(--border);margin:36px 0 0;padding:16px 0 40px;color:var(--muted);font-size:12px}
@media (max-width:640px){
  .wrap{padding:0 14px}
  h1{font-size:21px}
  thead th,tbody td{padding:9px 10px}
  .chip{font-size:11px}
}
`;

function page({ title, body }) {
  const stamp = body.match(/生成于 ([^<·]+)/)?.[1]?.trim() ?? '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar"><div class="wrap">
  <a class="brand" href="index.html"><span class="dot"></span>gameprice</a>
  <span class="muted small">个人游戏比价</span>
  <span class="spacer"></span>
  ${stamp ? `<span class="stamp">${esc(stamp)}</span>` : ''}
</div></header>
<main class="wrap">
${body}
</main>
<footer><div class="wrap">数据来源：官方 / 授权分销渠道（Steam、杉果、GOG、Humble、ITAD）。价格以购买页为准，购买前请自行确认。</div></footer>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(function(){
  // 页面可能通过 http://IP:端口 访问（非安全上下文），navigator.clipboard 不可用，
  // 所以保留 execCommand 作为兜底。
  function legacyCopy(text){
    var ta=document.createElement('textarea');
    ta.value=text; ta.setAttribute('readonly','');
    ta.style.position='fixed'; ta.style.top='-1000px'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    var ok=false; try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
    document.body.removeChild(ta); return ok;
  }
  function copy(text){
    if(navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text).then(function(){return true;},function(){return legacyCopy(text);});
    }
    return Promise.resolve(legacyCopy(text));
  }
  var tabsEls=document.querySelectorAll('.tab');
  for(var i=0;i<tabsEls.length;i++){
    tabsEls[i].addEventListener('click',function(ev){
      var btn=ev.currentTarget, want=btn.getAttribute('data-tab');
      for(var j=0;j<tabsEls.length;j++) tabsEls[j].classList.remove('on');
      btn.classList.add('on');
      applyFilter(want);
    });
  }
  var sortBtns=document.querySelectorAll('.sort');
  for(var si=0;si<sortBtns.length;si++){
    sortBtns[si].addEventListener('click',function(ev){
      var b=ev.currentTarget, key=b.getAttribute('data-sort');
      for(var x=0;x<sortBtns.length;x++) sortBtns[x].classList.remove('on');
      b.classList.add('on'); applySort(key);
    });
  }
  applyFilter('all');
  var toastEl=document.getElementById('toast'), timer=null;
  function toast(msg){
    if(!toastEl) return;
    toastEl.textContent=msg; toastEl.classList.add('on');
    clearTimeout(timer); timer=setTimeout(function(){toastEl.classList.remove('on');},1300);
  }
  document.addEventListener('click',function(e){
    var btn=e.target.closest ? e.target.closest('button.copy') : null;
    if(!btn) return;
    e.preventDefault();
    var text=btn.getAttribute('data-copy')||'';
    copy(text).then(function(ok){ toast(ok?('已复制：'+text):'复制失败，请手动选择'); });
  });
})();
</script>
</body>
</html>
`;
}

/** 列表页。games 来自 store.gameOverview，带上各自的 series 用于 sparkline。 */
export function renderIndex({ games, generatedAt, region = 'cn', days = 90 }) {
  const rest = games.filter((g) => g.owned !== true).length;
  const ownedCount = games.length - rest;
  const onCount = games.filter((g) => g.interested !== false && g.owned !== true).length;
  const offCount = rest - onCount;
  const tabs = '<div class="tabs" role="tablist">' +
    '<button class="tab on" data-tab="all" role="tab">全部 <b>' + rest + '</b></button>' +
    '<button class="tab" data-tab="1" role="tab">感兴趣 <b>' + onCount + '</b></button>' +
    '<button class="tab" data-tab="0" role="tab">不感兴趣 <b>' + offCount + '</b></button>' +
    '<button class="tab" data-tab="own" role="tab">已拥有 <b>' + ownedCount + '</b></button>' +
    '</div>';
  const sorts = '<div class="sorts">排序：' +
    '<button class="sort on" data-sort="discount">折扣力度</button>' +
    '<button class="sort" data-sort="price">价格</button>' +
    '<button class="sort" data-sort="name">游戏名</button>' +
    '</div>';
  const rows = games
    .map((g) => {
      const atLow = g.hist_low != null && g.current_low != null && g.current_low <= g.hist_low;
      const href = `game-${g.steam_appid ?? `n${g.id}`}.html`;
      const interested = g.interested !== false;
      const owned = g.owned === true;
      const offers = Array.isArray(g.all_offers) ? g.all_offers : [];
      // 平台标签：按价格升序，最低价那个高亮；超过 3 个只显示前 3 个
      const chips = offers
        .slice(0, 3)
        .map((o, i) => `<span class="chip${i === 0 ? ' chip-low' : ''}">${esc(o.platform_name ?? o.platform)} ${esc(fmtYuan(o.price))}</span>`)
        .join(' ');
      const more = offers.length > 3 ? `<span class="muted">+${offers.length - 3}</span>` : '';
      const gap = offers.length > 1 ? offers[1].price - offers[0].price : null;
      return `<tr data-interested="${interested ? '1' : '0'}" data-owned="${owned ? '1' : '0'}" data-discount="${g.discount ?? 0}" data-price="${g.current_low ?? 0}" data-name="${esc(g.name)}">
  <td>${nameBlock({ name: g.name, nameEn: g.name_en, href, tag: atLow ? '史低' : null })}</td>
  <td class="num">${esc(fmtYuan(g.current_low))}${
    gap != null ? `<div class="muted small">比次低便宜 ${esc(fmtYuan(gap))}</div>` : ''
  }</td>
  <td class="num">${esc(fmtYuan(g.current_original))}</td>
  <td class="num">${esc(fmtPct(g.discount))}</td>
  <td class="num">${esc(fmtYuan(g.hist_low))}</td>
  <td>${chips} ${more}</td>
  <td>${sparkline(g.series ?? [])}</td>
</tr>`;
    })
    .join('\n');

  const body = `<h1>游戏价格轨迹</h1>
<p class="meta">${esc(OFFICIAL_FILTER_NOTE)} · 区服 ${esc(region)} · 近 ${esc(days)} 天 · 生成于 ${esc(generatedAt)} · 共 ${games.length} 款</p>
${games.length ? tabs : ''}
${games.length ? sorts : ''}
${
  games.length
    ? `<table>
<thead><tr><th>游戏</th><th class="num">现价</th><th class="num">原价</th><th class="num">折扣</th><th class="num">史低</th><th>各平台</th><th>走势</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
    : '<p class="muted">还没有任何价格记录。先跑一次 <code>sync sonkwo</code> 或 <code>sync steam</code>。</p>'
}`;
  return page({ title: '游戏价格轨迹', body });
}

/**
 * 平台覆盖：说明每个源为什么有/没有这个游戏的报价。
 * 用户最容易误解的是"为什么只有杉果"——把原因写清楚，比让他猜好。
 */
export function coverageFor({ game, offers = [], sources = [] }) {
  const got = new Map(offers.map((o) => [o.platform_code, o]));
  return sources.map((source) => {
    const hit = got.get(source.code);
    if (hit) return { code: source.code, name: source.name, ok: true, note: fmtYuan(hit.price_cents) };
    if (!source.on) return { code: source.code, name: source.name, ok: false, note: source.offReason ?? '未启用' };
    if (!game.steam_appid && (source.code === 'steam' || source.code === 'itad')) {
      return { code: source.code, name: source.name, ok: false, note: '该游戏没有 Steam appid，无法匹配' };
    }
    if (!game.name_en && (source.code === 'gog' || source.code === 'humble')) {
      return { code: source.code, name: source.name, ok: false, note: '缺少英文名，无法在该平台检索' };
    }
    return { code: source.code, name: source.name, ok: false, note: source.missReason ?? '未匹配到同名商品' };
  });
}

/** 详情页：曲线 + 当前各平台报价。 */
export function renderGame({ game, series, offers, histLow, generatedAt, days = 90, coverage = null }) {
  const currentLow = offers.length ? Math.min(...offers.map((o) => o.price_cents)) : null;
  const atLow = currentLow != null && histLow != null && currentLow <= histLow;
  const prices = series.map((s) => Number(s.price_cents));
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const minDay = series.find((s) => Number(s.price_cents) === min)?.day;

  const cheapest = offers.length ? Math.min(...offers.map((o) => o.price_cents)) : null;
  const runnerUp = offers.filter((o) => o.price_cents > cheapest).map((o) => o.price_cents);
  const gap = runnerUp.length ? Math.min(...runnerUp) - cheapest : null;

  const facts = [];
  if (Array.isArray(game.developers) && game.developers.length) facts.push(["开发商", game.developers.join(" / ")]);
  if (Array.isArray(game.publishers) && game.publishers.length) facts.push(["发行商", game.publishers.join(" / ")]);
  const genreList = Array.isArray(game.genres) ? game.genres.filter((x) => !String(x).startsWith("tag:")) : [];
  const factsHtml = facts.length
    ? '<div class="facts">' + facts.map(([k, v]) => '<div class="fact"><span class="fk">' + esc(k) + '</span><span class="fv">' + esc(v) + '</span></div>').join('') + '</div>'
    : '';
  const genreHtml = genreList.length
    ? '<div class="facts"><div class="fact"><span class="fk">分类</span><span class="fv">' + genreList.map((g) => '<span class="chip">' + esc(g) + '</span>').join(" ") + '</span></div></div>'
    : '';
  const offerRows = offers
    .map(
      (o) => `<tr${o.price_cents === cheapest ? ' class="best"' : ''}>
  <td>${esc(o.platform_name ?? o.platform_code)}${o.price_cents === cheapest ? '<span class="tag">最低</span>' : ''}</td>
  <td class="num">${esc(fmtYuan(o.price_cents))}</td>
  <td class="num">${esc(fmtYuan(o.original_cents))}</td>
  <td class="num">${esc(fmtPct(o.discount_pct))}</td>
  <td>${o.buy_url ? `<a href="${esc(o.buy_url)}" rel="noopener noreferrer nofollow" target="_blank">去购买</a>` : '<span class="muted">—</span>'}</td>
</tr>`,
    )
    .join('\n');

  const body = `<p class="meta"><a href="index.html">← 返回列表</a></p>
<h1>${esc(game.name)}${copyBtn(game.name, '中文名')}${atLow ? '<span class="tag">史低</span>' : ''}${game.interested === false ? '<span class="tag warn">不感兴趣</span>' : ''}</h1>
${
    game.name_en && String(game.name_en).trim() !== String(game.name).trim()
      ? `<p class="meta name-en">${esc(game.name_en)}${copyBtn(game.name_en, '英文名')}</p>`
      : ''
  }
${factsHtml}
${genreHtml}
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
}

${
  coverage && coverage.length
    ? `<h2>平台覆盖</h2>
<div class="coverage">
${coverage
  .map(
    (c) =>
      `<div class="cov${c.ok ? ' ok' : ''}"><span class="cov-name">${esc(c.name)}</span><span class="cov-note">${esc(c.note)}</span></div>`,
  )
  .join('\n')}
</div>
<p class="muted small">没有出现的平台通常是：该游戏没有 Steam appid、缺少英文名、源未配置（ITAD 需要 key），或该区服不可售。</p>`
    : ''
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

  // 每个源的状态：决定详情页"平台覆盖"里显示什么原因
  const sources = [
    { code: 'sonkwo', name: '杉果', on: process.env.SONKWO_ENABLED !== '0', missReason: '杉果未收录该商品' },
    { code: 'gog', name: 'GOG', on: process.env.GOG_ENABLED !== '0', missReason: 'GOG 没有同名商品' },
    { code: 'humble', name: 'Humble', on: process.env.HUMBLE_ENABLED !== '0', missReason: 'Humble 没有同名商品' },
    { code: 'steam', name: 'Steam', on: process.env.STEAM_ENABLED !== '0', missReason: 'Steam 接口不可达或未采集到' },
    {
      code: 'itad',
      name: 'ITAD',
      on: Boolean(process.env.ITAD_API_KEY),
      offReason: '未配置 ITAD_API_KEY',
      missReason: 'ITAD 没有该商品',
    },
  ];

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
      renderGame({ game, series, offers, histLow: game.hist_low, generatedAt, days, coverage: coverageFor({ game, offers, sources }) }),
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
