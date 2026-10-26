// 多区服对比：把同一款游戏在各区服的报价分组、排序、标出每区最低。
//
// 关键前提：**不同币种不做汇率折算**。折算需要实时汇率，猜一个静态汇率会把
// 比较结果做错；宁可并排展示、明确告知不可直接比较。

const SYMBOLS = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  TWD: 'NT$',
  JPY: 'JP¥',
  RUB: '₽',
  TRY: '₺',
  ARS: 'ARS$',
  EUR: '€',
};

export function formatMoney(cents, currency = 'CNY') {
  if (cents == null || Number.isNaN(Number(cents))) return '—';
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * 按区服分组，组内按价格升序，并标出该区最低。
 * rows 来自 store.regionOffers（已按 region, price 排序）。
 */
export function groupOffersByRegion(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const region = row.region ?? 'unknown';
    if (!map.has(region)) map.set(region, { region, currency: row.currency ?? null, offers: [] });
    map.get(region).offers.push({ ...row, isCheapest: false });
  }
  const groups = [...map.values()].map((group) => {
    group.offers.sort((a, b) => a.price_cents - b.price_cents);
    if (group.offers.length) group.offers[0].isCheapest = true;
    return group;
  });
  groups.sort((a, b) => String(a.region).localeCompare(String(b.region)));
  return groups;
}

/**
 * 同币种跨区比较：只有币种相同才比数字。
 * 返回 [{ currency, region, priceCents }]，用来回答"这个币种下哪个区最便宜"。
 */
export function cheapestPerCurrency(groups = []) {
  const byCurrency = new Map();
  for (const group of groups) {
    const cheapest = group.offers[0];
    if (!cheapest) continue;
    const currency = cheapest.currency ?? group.currency ?? 'unknown';
    const current = byCurrency.get(currency);
    if (!current || cheapest.price_cents < current.priceCents) {
      byCurrency.set(currency, { currency, region: group.region, priceCents: cheapest.price_cents });
    }
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

const pad = (s, n) => {
  let width = 0;
  for (const ch of String(s ?? '')) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return String(s ?? '') + ' '.repeat(Math.max(0, n - width));
};

/** 终端表格。groups 为 groupOffersByRegion 的结果。 */
export function renderCompare({ game, rows, generatedAt = null }) {
  const groups = groupOffersByRegion(rows);
  if (!groups.length) return `${game?.name ?? '该游戏'} 还没有多区服报价。`;

  const lines = [];
  const title = game?.name ?? '未知游戏';
  const appid = game?.steam_appid ? `（appid ${game.steam_appid}）` : '';
  lines.push(`${title}${appid} 多区服对比${generatedAt ? ` · 生成于 ${generatedAt}` : ''}`);
  lines.push(`${pad('区服', 6)}${pad('币种', 6)}${pad('平台', 12)}${pad('现价', 12)}${pad('折扣', 7)}备注`);
  lines.push('-'.repeat(64));

  for (const group of groups) {
    for (const offer of group.offers) {
      const note = offer.isCheapest ? '该区最低' : '';
      lines.push(
        `${pad(group.region, 6)}${pad(offer.currency ?? group.currency, 6)}${pad(offer.platform_name ?? offer.platform_code, 12)}` +
          `${pad(formatMoney(offer.price_cents, offer.currency), 12)}${pad(`-${offer.discount_pct ?? 0}%`, 7)}${note}`,
      );
    }
  }

  const best = cheapestPerCurrency(groups);
  if (best.length) {
    lines.push('');
    lines.push(`同币种内最低：${best.map((b) => `${b.currency} @ ${b.region} ${formatMoney(b.priceCents, b.currency)}`).join('；')}`);
  }
  if (new Set(groups.map((g) => g.currency)).size > 1) {
    lines.push('注意：不同币种未做汇率折算，跨区数字不可直接比较。');
  }
  return lines.join('\n');
}
