// 容器里的常驻调度器：按间隔跑采集任务。
//
// 每个任务是独立子进程，任务崩了（OOM、未捕获异常）不会把调度器一起带走，
// 符合"采集挂掉但服务还在"的目标。
//
// 纯函数（jobsFromEnv / dueJobs / describeSchedule）单独导出，
// 测试时刻表逻辑不需要真的等一小时。
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger, serializeError } from './log.js';
import { hasNotifier } from './notify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.js');
const TICK_MS = 15000;

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function jobsFromEnv(env = process.env) {
  return [
    {
      name: 'steam',
      args: ['sync', 'steamall'], // 元数据 + 说明 + 价格，一次同步全部 Steam 游戏
      intervalMin: num(env.STEAM_INTERVAL_MIN, 60),
      initialDelaySec: num(env.STEAM_INITIAL_DELAY_SEC, 30),
      enabled: env.STEAM_ENABLED !== '0',
    },
    {
      name: 'sonkwo',
      args: ['sync', 'sonkwo'],
      intervalMin: num(env.SONKWO_INTERVAL_MIN, 60),
      initialDelaySec: num(env.SONKWO_INITIAL_DELAY_SEC, 180),
      enabled: env.SONKWO_ENABLED !== '0',
    },
    {
      name: 'itad',
      args: ['sync', 'itad'],
      intervalMin: num(env.ITAD_INTERVAL_MIN, 1440),
      initialDelaySec: num(env.ITAD_INITIAL_DELAY_SEC, 300),
      enabled: env.ITAD_ENABLED !== '0',
    },
    {
      name: 'gog',
      args: ['sync', 'gog'],
      intervalMin: num(env.GOG_INTERVAL_MIN, 720),
      initialDelaySec: num(env.GOG_INITIAL_DELAY_SEC, 600),
      enabled: env.GOG_ENABLED !== '0',
    },
    {
      name: 'humble',
      args: ['sync', 'humble'],
      intervalMin: num(env.HUMBLE_INTERVAL_MIN, 720),
      initialDelaySec: num(env.HUMBLE_INITIAL_DELAY_SEC, 720),
      enabled: env.HUMBLE_ENABLED !== '0',
    },
    {
      name: 'discover',
      // 杉果 SKU 增量发现：从前沿向后探测，连续空壳即停，通常十几到几十次请求
      args: ['discover', 'sonkwo', '--ahead', '60', '--max-misses', '12'],
      intervalMin: num(env.DISCOVER_INTERVAL_MIN, 720),
      initialDelaySec: num(env.DISCOVER_INITIAL_DELAY_SEC, 900),
      enabled: env.DISCOVER_ENABLED !== '0',
    },
    {
      name: 'backup',
      // 每日逻辑备份（gzip JSON），保留最近 7 份；顺带清理过期浏览记录
      args: ['backup'],
      intervalMin: num(env.BACKUP_INTERVAL_MIN, 1440),
      initialDelaySec: num(env.BACKUP_INITIAL_DELAY_SEC, 3600),
      enabled: env.BACKUP_ENABLED !== '0',
    },
    {
      name: 'alerts',
      // 只有配了任意提醒通道才在检查后标记已通知，否则只做只读检查，避免静默吞掉提醒
      args: hasNotifier(env) ? ['alerts', '--mark'] : ['alerts'],
      intervalMin: num(env.ALERTS_INTERVAL_MIN, 360),
      initialDelaySec: num(env.ALERTS_INITIAL_DELAY_SEC, 420),
      enabled: env.ALERTS_ENABLED !== '0',
    },
  ].filter((j) => j.enabled && j.intervalMin > 0);
}

/** 熔断参数：连续失败 threshold 次后，暂停该任务 cooldownMs。 */
export const CIRCUIT = { threshold: 3, cooldownMs: 6 * 3600_000 };

/** 记录一次任务结果，返回新的健康状态。纯函数，便于单测。 */
export function recordJobResult(state, { code, nowMs, threshold = CIRCUIT.threshold, cooldownMs = CIRCUIT.cooldownMs }) {
  if (code === 0) return { failures: 0, openUntil: null, opened: false };
  const failures = (state?.failures ?? 0) + 1;
  if (failures >= threshold) {
    return { failures, openUntil: nowMs + cooldownMs, opened: true };
  }
  return { failures, openUntil: state?.openUntil ?? null, opened: false };
}

/** 熔断是否仍然生效。 */
export function isCircuited(state, nowMs) {
  return Boolean(state?.openUntil && nowMs < state.openUntil);
}

// 采集类任务成功后需要刷新静态页的，列在这里
const SYNC_LIKE = new Set(['steam', 'sonkwo', 'itad', 'gog', 'humble', 'discover']);

/**
 * 任务成功后的后续动作。
 * 采集完不重建曲线页，用户就得手动跑 chart——这条链本来就是"自动刷新"的价值所在。
 * CHART_ON_SYNC=0 可关（例如只想采集、页面由 CI 构建）。
 */
export function followUpArgs(jobName, code, env = process.env) {
  if (code !== 0) return null;
  if (env.CHART_ON_SYNC === '0') return null;
  if (!SYNC_LIKE.has(jobName)) return null;
  return ['chart'];
}

/**
 * 哪些任务到点了。
 * 从未跑过：startedMs + initialDelaySec 触发（首轮错开，避免同时打满）。
 * 跑过的：lastRun + intervalMin 触发。
 */
export function dueJobs(jobs, { nowMs, startedMs, lastRunMs }) {
  return jobs.filter((job) => {
    const last = lastRunMs.get(job.name);
    const nextAt = last == null ? startedMs + job.initialDelaySec * 1000 : last + job.intervalMin * 60_000;
    return nowMs >= nextAt;
  });
}

export function describeSchedule(jobs) {
  return jobs.map((j) => `${j.name} 每 ${j.intervalMin} 分钟（首轮 ${j.initialDelaySec}s 后）`).join('；');
}

/**
 * 调度器自己的通用参数要透传给每个子任务，否则 `scheduler.js --db pglite:...`
 * 这种用法下子任务会找不到库（Docker 里靠 DATABASE_URL 侥幸不出问题，本地必踩）。
 */
export function forwardedArgs(argv = process.argv) {
  const out = [];
  for (const name of ['--db', '--log-dir', '--level']) {
    const i = argv.indexOf(name);
    if (i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(name, argv[i + 1]);
  }
  return out;
}

export async function main() {
  const logger = createLogger({ prefix: 'scheduler', level: process.env.LOG_LEVEL ?? 'info' });
  const jobs = jobsFromEnv();
  const startedMs = Date.now();
  const lastRunMs = new Map();
  const health = new Map(); // job.name -> { failures, openUntil }
  const running = new Set();
  const circuitThreshold = num(process.env.CIRCUIT_THRESHOLD, CIRCUIT.threshold);
  const circuitCooldownMs = num(process.env.CIRCUIT_COOLDOWN_MIN, CIRCUIT.cooldownMs / 60_000) * 60_000;

  let stopping = false;
  let currentChild = null;
  let wake = null;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('scheduler.stop', { signal, child: currentChild ? 'terminating' : 'idle' });
    if (currentChild) {
      currentChild.kill('SIGTERM');
      setTimeout(() => currentChild?.kill('SIGKILL'), 5000).unref();
    }
    wake?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const sleepInterruptible = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const runJob = (job) =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      const args = [CLI, ...job.args, ...forwardedArgs()];
      logger.info('scheduler.job_start', { job: job.name, args: args.slice(1).join(' ') });
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
      });
      currentChild = child;
      child.on('error', (err) => {
        logger.error('scheduler.job_spawn_failed', { job: job.name, err: serializeError(err) });
        currentChild = null;
        resolve({ code: -1 });
      });
      child.on('exit', (code, signal) => {
        currentChild = null;
        const elapsedMs = Date.now() - startedAt;
        if (code === 0) logger.info('scheduler.job_done', { job: job.name, code, elapsedMs });
        else logger.error('scheduler.job_failed', { job: job.name, code, signal, elapsedMs });
        resolve({ code: code ?? -1 });
      });
    });

  if (!jobs.length) logger.warn('scheduler.no_jobs', { hint: '所有任务均被禁用或间隔为 0' });
  logger.info('scheduler.start', {
    jobs: jobs.map((j) => j.name),
    schedule: describeSchedule(jobs),
    node: process.version,
    tickMs: TICK_MS,
  });

  while (!stopping) {
    const now = Date.now();
    const due = dueJobs(jobs, { nowMs: now, startedMs, lastRunMs });
    for (const job of due) {
      if (stopping) break;
      if (running.has(job.name)) continue;

      const state = health.get(job.name) ?? { failures: 0, openUntil: null };
      if (isCircuited(state, now)) {
        // 熔断期内不再打目标站：持续 403 时继续重试只会更快被封
        logger.warn('scheduler.circuit_skip', {
          job: job.name,
          failures: state.failures,
          openUntil: new Date(state.openUntil).toISOString(),
        });
        lastRunMs.set(job.name, now);
        continue;
      }

      running.add(job.name);
      const { code } = await runJob(job);
      running.delete(job.name);
      lastRunMs.set(job.name, Date.now());

      // 采集成功后顺手重建静态页（失败不影响主任务状态）
      const followUp = followUpArgs(job.name, code, process.env);
      if (followUp) {
        logger.info('scheduler.followup', { job: job.name, args: followUp.join(' ') });
        await runJob({ name: `${job.name}:chart`, args: followUp });
      }

      const next = recordJobResult(state, {
        code,
        nowMs: Date.now(),
        threshold: circuitThreshold,
        cooldownMs: circuitCooldownMs,
      });
      health.set(job.name, next);
      if (next.opened) {
        logger.error('scheduler.circuit_tripped', {
          job: job.name,
          failures: next.failures,
          openUntil: new Date(next.openUntil).toISOString(),
        });
      } else if (code === 0 && (state.failures ?? 0) > 0) {
        logger.info('scheduler.circuit_reset', { job: job.name, afterFailures: state.failures });
      }
      if (stopping) break;
    }
    if (stopping) break;
    await sleepInterruptible(TICK_MS);
  }

  logger.info('scheduler.exit', {});
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    const logger = createLogger({ prefix: 'scheduler' });
    logger.fatal('scheduler.crash', { err: serializeError(err) });
    process.exit(1);
  });
}
