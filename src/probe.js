#!/usr/bin/env node
// 接入可行性探针：在「有外网的机器」上跑，回答三个问题
//   1) 目标接口能不能通、成功率多少
//   2) 延迟和响应体大小多少（决定每小时能不能刷完）
//   3) 会不会被限流/封（看 403 / 429）
//
// 用法：
//   node src/probe.js --target steam --rounds 24 --interval 3600
//   node src/probe.js --target steam --rounds 3 --interval 20 --appids 730,1091500
//   node src/probe.js --url "https://example.com/x" --rounds 1
//   node src/probe.js --url-file urls.txt --rounds 1 --interval 600
import { readFileSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchJson, sleep } from './http.js';
import { buildAppDetailsUrl, descriptor as steam } from './adapters/steam.js';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const rounds = Number(flag('rounds', 1));
const intervalSec = Number(flag('interval', 0));
const out = flag('out', `data/probe-${new Date().toISOString().slice(0, 10)}.jsonl`);
const target = flag('target', null);
const appids = String(flag('appids', '730,1091500,1245620,271590,413150')).split(',').map(Number);

function buildUrls() {
  const one = flag('url', null);
  if (typeof one === 'string') return [one];
  const file = flag('url-file', null);
  if (typeof file === 'string') {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }
  if (target === 'steam') return [buildAppDetailsUrl(appids)];
  throw new Error('需要 --target steam 或 --url / --url-file');
}

const urls = buildUrls();
mkdirSync(dirname(out), { recursive: true });
const records = [];
let round = 0;

function summarize() {
  const ok = records.filter((r) => r.ok);
  const lat = ok.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null);
  const codes = {};
  for (const r of records) codes[r.status ?? 'ERR'] = (codes[r.status ?? 'ERR'] ?? 0) + 1;
  const bytes = ok.reduce((s, r) => s + r.bytes, 0);
  return {
    attempts: records.length,
    ok: ok.length,
    fail: records.length - ok.length,
    successRate: records.length ? `${((ok.length / records.length) * 100).toFixed(1)}%` : 'n/a',
    p50: pct(0.5),
    p95: pct(0.95),
    avgBytes: ok.length ? Math.round(bytes / ok.length) : 0,
    status: codes,
  };
}

function printSummary() {
  const s = summarize();
  console.log('\n===== 探针汇总 =====');
  console.log(`尝试 ${s.attempts} 次 / 成功 ${s.ok} / 失败 ${s.fail} → 成功率 ${s.successRate}`);
  console.log(`延迟 p50=${s.p50 ?? '-'}ms p95=${s.p95 ?? '-'}ms`);
  console.log(`平均响应体 ${(s.avgBytes / 1024).toFixed(1)}KB`);
  console.log('状态码分布：', JSON.stringify(s.status));
  console.log(`明细已写入 ${out}`);
  const s403 = (s.status[403] ?? 0) + (s.status[429] ?? 0);
  if (s403 > 0) console.log(`⚠️  出现 ${s403} 次 403/429 —— 有风控迹象，需要降频或换出口`);
  else if (s.ok === 0) console.log('⚠️  一次都没成功 —— 先确认这台机器的出网与 DNS，而不是怀疑目标站');
}

process.on('SIGINT', () => {
  printSummary();
  process.exit(0);
});

try {
  for (round = 1; round <= rounds; round += 1) {
    for (const url of urls) {
      const startedAt = Date.now();
      try {
        const res = await fetchJson(url, { retries: 0, timeoutMs: 20000 });
        const rec = {
          ts: new Date().toISOString(),
          round,
          url,
          status: res.status,
          bytes: res.bytes,
          elapsedMs: Date.now() - startedAt,
          ok: true,
        };
        records.push(rec);
        appendFileSync(out, `${JSON.stringify(rec)}\n`);
        console.log(`[${round}/${rounds}] OK   ${res.status} ${rec.elapsedMs}ms ${(res.bytes / 1024).toFixed(1)}KB`);
      } catch (err) {
        const rec = {
          ts: new Date().toISOString(),
          round,
          url,
          status: err.status ?? 'ERR',
          bytes: 0,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          error: String(err.message).slice(0, 200),
        };
        records.push(rec);
        appendFileSync(out, `${JSON.stringify(rec)}\n`);
        console.log(`[${round}/${rounds}] FAIL ${rec.status} ${rec.error}`);
      }
      await sleep(1200);
    }
    if (round < rounds && intervalSec > 0) {
      console.log(`... 等待 ${intervalSec}s`);
      await sleep(intervalSec * 1000);
    }
  }
} finally {
  printSummary();
}
