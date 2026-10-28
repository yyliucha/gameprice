// 逻辑备份：核心表导出成 gzip JSON，保留最近 N 份；顺带清理过期浏览记录与邮件记录。
//
// 同一份逻辑被 CLI（node src/cli.js backup）和后台「立即备份」按钮共用，
// 避免两处实现漂移。
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import * as db from './store/pg.js';
import { purgeOldCodes } from './email-auth.js';

export const BACKUP_TABLES = [
  'platforms',
  'games',
  'game_aliases',
  'offers',
  'price_snapshots',
  'daily_prices',
  'watchlist',
  'users',
];

/** 现有备份文件（新→旧），带大小。 */
export function listBackups(dir = 'data/backup') {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('backup-') && n.endsWith('.gz'))
      .map((name) => {
        const file = join(dir, name);
        let size = 0;
        try {
          size = statSync(file).size;
        } catch {
          /* 统计失败忽略 */
        }
        return { name, size, path: file };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

/**
 * 执行一次逻辑备份。
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} q
 * @param {{dir?: string, keep?: number, viewDays?: number, logger?: any}} opts
 */
export async function createBackup(q, { dir = 'data/backup', keep = 7, viewDays = 90, logger = null } = {}) {
  mkdirSync(dir, { recursive: true });

  const dump = {};
  for (const table of BACKUP_TABLES) {
    dump[table] = (await q(`select * from ${table}`)).rows;
  }
  const purgedViews = await db.purgeOldViews(q, { days: viewDays });
  // 邮件正文含明文验证码，只保留 3 天。email_codes 由 ensureEmailSchema 建表，
  // 少数场景（测试/未初始化）可能不存在——清理失败不应让整个备份失败。
  let purgedCodes = 0;
  try {
    purgedCodes = await purgeOldCodes(q, { days: 3 });
  } catch (err) {
    logger?.warn('backup.purge_codes_skipped', { message: String(err.message).slice(0, 120) });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const file = `${dir}/backup-${stamp}.json.gz`;
  writeFileSync(file, gzipSync(JSON.stringify({ generatedAt: new Date().toISOString(), dump })));

  const files = readdirSync(dir).filter((n) => n.startsWith('backup-')).sort();
  let removed = 0;
  for (const old of files.slice(0, Math.max(0, files.length - Math.max(1, keep)))) {
    rmSync(`${dir}/${old}`, { force: true });
    removed += 1;
  }

  const rows = BACKUP_TABLES.reduce((sum, t) => sum + dump[t].length, 0);
  const result = { file, tables: BACKUP_TABLES.length, rows, removedOld: removed, purgedViews, purgedCodes };
  logger?.info('backup.done', result);
  return result;
}
