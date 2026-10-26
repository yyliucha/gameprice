// 降价提醒：判定 + 简报。投递实现见 src/notify.js。
//
// 判定是纯函数（行 → 命中列表），因为它决定"要不要打扰用户"，必须能单测。
export const REASON = {
  TARGET: 'target', // 到设定的目标价
  HIST_LOW: 'hist_low', // 没设目标，跌到史低
};

export const REASON_LABEL = {
  [REASON.TARGET]: '已达目标价',
  [REASON.HIST_LOW]: '跌至史低',
};

const yuan = (cents) => (cents == null ? '—' : `¥${(Number(cents) / 100).toFixed(2)}`);

/**
 * 从 watchCandidates 的行里挑出需要提醒的。
 * 去重规则：已经用「相同或更低」的价格通知过，就不再重复打扰。
 */
export function evaluateAlerts(rows, { now = new Date() } = {}) {
  const hits = [];
  for (const row of rows ?? []) {
    const current = row.current_cents == null ? null : Number(row.current_cents);
    if (current == null) continue; // 没在售就不提醒

    const target = row.target_cents == null ? null : Number(row.target_cents);
    const hist = row.hist_low == null ? null : Number(row.hist_low);

    let reason = null;
    if (target != null) {
      if (current <= target) reason = REASON.TARGET;
    } else if (hist != null && current <= hist) {
      reason = REASON.HIST_LOW;
    }
    if (!reason) continue;

    // 上次通知过 ¥X，现在还是 ¥X 或更贵 → 不重复
    if (row.last_notified_cents != null && current >= Number(row.last_notified_cents)) continue;

    hits.push({
      watchId: Number(row.watch_id),
      gameId: Number(row.game_id),
      steamAppid: row.steam_appid ?? null,
      name: row.name,
      currentCents: current,
      targetCents: target,
      histLowCents: hist,
      atHistLow: hist != null && current <= hist,
      reason,
      note: row.note ?? null,
      detectedAt: now.toISOString(),
    });
  }
  return hits;
}

const steamUrl = (appid) => (appid ? `https://store.steampowered.com/app/${appid}/` : null);

/** 人读的简报（也进日志，方便只靠日志复盘"今天提醒了什么"）。 */
export function renderDigest(hits, { now = new Date() } = {}) {
  if (!hits?.length) return '没有需要提醒的价格。';
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const lines = hits.map((h) => {
    const bits = [
      `${h.name}  ${yuan(h.currentCents)}`,
      h.targetCents != null ? `目标 ${yuan(h.targetCents)}` : null,
      h.histLowCents != null ? `史低 ${yuan(h.histLowCents)}` : null,
      REASON_LABEL[h.reason] ?? h.reason,
    ].filter(Boolean);
    const url = steamUrl(h.steamAppid);
    return `· ${bits.join(' · ')}${url ? `\n  ${url}` : ''}`;
  });
  return `价格提醒（${stamp}，共 ${hits.length} 条）\n${lines.join('\n')}`;
}

/** 机器投递用的结构。字段名保持中性，方便接任意 webhook。 */
export function toPayload(hits, { now = new Date() } = {}) {
  return {
    type: 'gameprice.alerts',
    generatedAt: now.toISOString(),
    count: hits.length,
    text: renderDigest(hits, { now }),
    alerts: hits.map((h) => ({
      name: h.name,
      steamAppid: h.steamAppid,
      url: steamUrl(h.steamAppid),
      current: h.currentCents,
      target: h.targetCents,
      histLow: h.histLowCents,
      reason: h.reason,
      note: h.note,
    })),
  };
}

// 投递实现已下沉到 src/notify.js（webhook / 企业微信 / 邮件统一走那里），
// 这里保留同名导出，避免调用方与既有测试改动。
export { postJson as postWebhook } from './notify.js';
