#!/usr/bin/env node
// 页面结构勘查：把目标页抓下来，判断它是不是服务端渲染、有没有内嵌 JSON、
// 价格能不能直接从 HTML 里读到。写适配器之前先跑这个，别凭猜。
//
// 用法：node scripts/inspect.js <url> [--save name]
import { writeFileSync, mkdirSync } from 'node:fs';
import { USER_AGENT } from '../src/http.js';

const url = process.argv[2];
if (!url) {
  console.error('用法: node scripts/inspect.js <url> [--save name]');
  process.exit(1);
}
const saveIdx = process.argv.indexOf('--save');
const name = saveIdx > -1 ? process.argv[saveIdx + 1] : new URL(url).host;

const res = await fetch(url, {
  headers: {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  redirect: 'follow',
});
const body = await res.text();
mkdirSync('data/pages', { recursive: true });
const file = `data/pages/${name}.html`;
writeFileSync(file, body, 'utf8');

const count = (re) => (body.match(re) || []).length;
const first = (re) => (body.match(re) || [])[0] ?? null;
const title = first(/<title[^>]*>([^<]*)<\/title>/i);

console.log(`URL        ${url}`);
console.log(`最终地址   ${res.url}`);
console.log(`状态       ${res.status}  类型 ${res.headers.get('content-type')}`);
console.log(`大小       ${(body.length / 1024).toFixed(1)} KB  → ${file}`);
console.log(`标题       ${title}`);
console.log('');
console.log('--- 渲染方式判断 ---');
const signals = {
  'Next.js (__NEXT_DATA__)': body.includes('__NEXT_DATA__'),
  'Nuxt (__NUXT__)': body.includes('__NUXT__'),
  '空壳 SPA (id=app/root 且 body 很短)': /<div id="(app|root)"><\/div>/.test(body) && body.length < 4000,
  'Vue 内嵌初始状态': /window\.__INITIAL_STATE__|__NUXT__/.test(body),
};
for (const [k, v] of Object.entries(signals)) console.log(`  ${v ? '✔' : '·'} ${k}`);

console.log('');
console.log('--- 可直接抓的数据线索 ---');
console.log(`  内嵌 JSON 脚本块        ${count(/<script[^>]*type="application\/json"/gi)}`);
console.log(`  出现 ¥ 或 价格字段      ${count(/[¥￥]\s?\d|"price"|"salePrice"|"finalPrice"/gi)}`);
console.log(`  /api/ 路径出现次数      ${count(/["'](\/api\/|https?:\/\/[^"']*\/api\/)/gi)}`);
console.log(`  <script src> 数量       ${count(/<script[^>]+src=/gi)}`);

const apis = [...new Set((body.match(/["']((?:\/api\/|https?:\/\/[^"']*\/api\/)[^"']{0,80})/g) || []).map((s) => s.slice(1, -1)))].slice(0, 12);
if (apis.length) {
  console.log('');
  console.log('--- 发现的 API 路径（前 12 条）---');
  for (const a of apis) console.log(`  ${a}`);
}

const scripts = [...new Set(body.match(/<script[^>]+src="([^"]+)"/g) || [])].slice(0, 8);
if (scripts.length) {
  console.log('');
  console.log('--- 外部脚本（前 8 条，SPA 的接口要去这里找）---');
  for (const s of scripts) console.log(`  ${s.replace(/<script[^>]+src="|"/g, '')}`);
}

const priceSnippet = first(/.{80}[¥￥]\s?\d[\d.,]*.{80}/s);
if (priceSnippet) {
  console.log('');
  console.log('--- 价格出现位置（前后 80 字符）---');
  console.log(`  ${priceSnippet.replace(/\s+/g, ' ').trim()}`);
}
