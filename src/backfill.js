// 后台回填任务的参数归一化 / 命令行拼装 / 进度解析（纯函数，便于单测）。
//
// 控制台「数据回填」卡片和 `/api/admin/backfill*` 共用这里的规则，
// 避免前端传什么后端就跑什么（limit 上限 20 万、sleep 上限 60 秒等）。

export const BACKFILL_LIMITS = {
  limit: { min: 1, max: 200000, def: 200000 },
  batch: { min: 1, max: 100, def: 100 },
  sleep: { min: 0, max: 60000, def: 3000 },
  fallback: { min: 0, max: 100, def: 10 },
};

/** 把请求体里的 limit/batch/sleep/fallback 收敛到安全范围；非法值回落默认值。 */
export function normalizeBackfillParams(body = {}) {
  const pick = (value, { min, max, def }) => {
    // null/undefined/空串视为「没传」，回落默认值；显式 0 仍按 0 处理再 clamp
    if (value === null || value === undefined || value === '') return def;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
  };
  return {
    limit: pick(body.limit, BACKFILL_LIMITS.limit),
    batch: pick(body.batch, BACKFILL_LIMITS.batch),
    sleep: pick(body.sleep, BACKFILL_LIMITS.sleep),
    fallback: pick(body.fallback, BACKFILL_LIMITS.fallback),
  };
}

/** 子进程参数：node src/cli.js backfill --limit … --batch … --sleep … --fallback … */
export function backfillArgs(params) {
  return [
    'src/cli.js',
    'backfill',
    '--limit', String(params.limit),
    '--batch', String(params.batch),
    '--sleep', String(params.sleep),
    '--fallback', String(params.fallback),
  ];
}

// CLI 每批输出的一行：`  批次 3：本批 100 款，写入 100，回退 0，失败 0；累计 300/200000（660 款/分钟）`
const BATCH_LINE = /批次\s+(\d+)：本批\s+(\d+)\s*款，写入\s+(\d+)，回退\s+(\d+)，失败\s+(\d+)；累计\s+(\d+)\/(\d+)（(\d+)\s*款\/分钟）/;

/** 从子进程输出尾巴里取最后一条批次进度；没有则返回 null。 */
export function parseBackfillProgress(output) {
  const text = String(output ?? '');
  const re = new RegExp(BATCH_LINE.source, 'g');
  let last = null;
  for (const m of text.matchAll(re)) last = m;
  if (!last) return null;
  const done = Number(last[6]);
  const limit = Number(last[7]);
  return {
    batches: Number(last[1]),
    batchSize: Number(last[2]),
    written: Number(last[3]),
    fallback: Number(last[4]),
    failed: Number(last[5]),
    done,
    limit,
    ratePerMin: Number(last[8]),
    percent: limit > 0 ? Math.min(100, Math.round((done / limit) * 1000) / 10) : 0,
  };
}
