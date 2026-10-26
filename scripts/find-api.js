#!/usr/bin/env node
// 从 SPA 的 JS 包里挖接口路径。注意：这些站点的 HTML 属性经常不带引号，
// 正则必须同时支持 src="x" 和 src=x，否则会漏掉全部脚本。
//
// 用法：node scripts/find-api.js <本地 HTML 文件> [--max-mb 4]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/find-api.js <html文件>');
  process.exit(1);
}
const maxIdx = process.argv.indexOf('--max-mb');
const maxBytes = (maxIdx > -1 ? Number(process.argv[maxIdx + 1]) : 4) * 1024 * 1024;
const baseIdx = process.argv.indexOf('--base');
const base = baseIdx > -1 ? process.argv[baseIdx + 1].replace(/\/$/, '') : null;

const html = readFileSync(file, 'utf8');
// 同时匹配：<script src>（带/不带引号）与 <link rel="modulepreload" href>（Remix/Vite 用后者）
const scriptRe = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const preloadRe = /<link\b[^>]*\bhref\s*=\s*"([^"]+\.js)"/gi;
const scripts = [
  ...new Set([
    ...[...html.matchAll(scriptRe)].map((m) => m[1] || m[2] || m[3]),
    ...[...html.matchAll(preloadRe)].map((m) => m[1]),
  ]),
];
console.log(`发现 ${scripts.length} 个脚本：`);
for (const s of scripts) console.log(`  ${s}`);

const API_RE = /["'`]((?:https?:\/\/[^"'`\s]{4,120})?\/api\/[A-Za-z0-9_\-./{}$:]{2,100})["'`]/g;
const found = new Map();

for (const src of scripts) {
  const url = src.startsWith('//')
    ? `https:${src}`
    : src.startsWith('http')
      ? src
      : base
        ? `${base}${src.startsWith('/') ? '' : '/'}${src}`
        : null;
  if (!url) {
    console.log(`\n[跳过] 相对路径 ${src}（用 --base 指定站点根地址，例如 --base https://steampy.com）`);
    continue;
  }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36', accept: '*/*' },
    });
    if (!res.ok) {
      console.log(`\n[失败] ${url} → HTTP ${res.status}`);
      continue;
    }
    const text = (await res.text()).slice(0, maxBytes);
    const hits = new Set();
    for (const m of text.matchAll(API_RE)) hits.add(m[1]);
    console.log(`\n[${url}] ${(text.length / 1024).toFixed(0)}KB，命中 ${hits.size} 条接口`);
    for (const h of [...hits].slice(0, 25)) {
      console.log(`  ${h}`);
      found.set(h, (found.get(h) ?? 0) + 1);
    }
  } catch (err) {
    console.log(`\n[异常] ${url} → ${err.message}`);
  }
}

if (found.size) {
  console.log(`\n===== 全部去重接口 ${found.size} 条（按出现次数）=====`);
  for (const [k, v] of [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${v} × ${k}`);
}
