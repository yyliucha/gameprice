#!/usr/bin/env node
// 通用提取：node scripts/extract.js <file> <regex> [--unique] [--context 80]
// PowerShell 里直接写 node -e 会被引号/方括号折腾，这种一次性小脚本更省事。
import { readFileSync } from 'node:fs';

const [file, pattern] = process.argv.slice(2);
if (!file || !pattern) {
  console.error('用法: node scripts/extract.js <file> <regex> [--unique] [--context N]');
  process.exit(1);
}
const unique = process.argv.includes('--unique');
const ctxIdx = process.argv.indexOf('--context');
const ctx = ctxIdx > -1 ? Number(process.argv[ctxIdx + 1]) : 0;

const text = readFileSync(file, 'utf8');
const re = new RegExp(pattern, 'g');
const hits = [];
for (const m of text.matchAll(re)) {
  hits.push(ctx ? `${text.slice(Math.max(0, m.index - ctx), m.index + m[0].length + ctx).replace(/\s+/g, ' ')}` : m[0]);
}
const out = unique ? [...new Set(hits)] : hits;
console.log(`命中 ${hits.length} 条${unique ? `，去重 ${out.length} 条` : ''}`);
for (const h of out.slice(0, 200)) console.log(`  ${h}`);
