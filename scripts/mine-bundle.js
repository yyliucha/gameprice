#!/usr/bin/env node
// 在打包后的 JS 里找"接口线索"：baseURL、绝对主机、看起来像路径的字符串字面量。
// 前端常见的写法是 axios.create({baseURL:'https://api.xxx.com'}) + url:'/goods/list'，
// 所以只搜 /api/ 会全部漏掉。
import { writeFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2];
if (!url) {
  console.error('用法: node scripts/mine-bundle.js <js-url>');
  process.exit(1);
}
const res = await fetch(url, {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36', accept: '*/*' },
});
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();
mkdirSync('data/pages', { recursive: true });
const name = `data/pages/${new URL(url).pathname.split('/').pop() || 'bundle.js'}`;
writeFileSync(name, text, 'utf8');
console.log(`已保存 ${name}（${(text.length / 1024).toFixed(0)}KB）\n`);

const freq = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('--- 绝对主机（前 20）---');
for (const [h, n] of freq([...text.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0])).slice(0, 20)) {
  console.log(`  ${n} × ${h}`);
}

console.log('\n--- baseURL / API_BASE 附近（前 10）---');
for (const m of [...text.matchAll(/baseURL|baseUrl|API_BASE|apiBase|BASE_URL/g)].slice(0, 10)) {
  console.log(`  …${text.slice(Math.max(0, m.index - 80), m.index + 120).replace(/\s+/g, ' ')}…`);
}

console.log('\n--- 疑似接口路径（前 40，按出现次数）---');
const paths = [...text.matchAll(/["'`](\/[a-zA-Z][a-zA-Z0-9_\-/]{3,60})["'`]/g)].map((m) => m[1]);
const skip = /^\/(static|js|css|img|images|fonts|assets|logo|favicon)\b/;
for (const [p, n] of freq(paths.filter((p) => !skip.test(p))).slice(0, 40)) {
  console.log(`  ${n} × ${p}`);
}

console.log('\n--- 含 goods/game/price/shop 的路径 ---');
const kw = [...new Set(paths.filter((p) => /good|game|price|shop|product|search|market|item/i.test(p)))];
for (const p of kw.slice(0, 40)) console.log(`  ${p}`);
