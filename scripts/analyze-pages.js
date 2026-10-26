#!/usr/bin/env node
// 一次性分析：从抓下来的首页 HTML 里找出商品链接规律、价格卡片结构、SPA 的脚本入口
import { readFileSync } from 'node:fs';

function analyzeSonkwo() {
  const html = readFileSync('data/pages/sonkwo-home.html', 'utf8');
  console.log('===== 杉果首页 =====');
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(hrefs)];
  console.log(`链接总数 ${hrefs.length}，去重 ${uniq.length}`);
  const buckets = {};
  for (const h of uniq) {
    const key = h.replace(/\d{2,}/g, 'N').replace(/\?.*/, '?');
    buckets[key] = (buckets[key] || 0) + 1;
  }
  console.log('链接模式（按数量）：');
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v} × ${k}`);

  console.log('\n示例商品链接：');
  for (const h of uniq.filter((x) => /\/\d{3,}/.test(x)).slice(0, 6)) console.log(`  ${h}`);

  const i = html.indexOf('SKC-sale-price');
  console.log('\n价格卡片结构（价格前后 900 字符）：');
  console.log(html.slice(Math.max(0, i - 900), i + 500).replace(/\s+/g, ' '));
}

function analyzeSteampy() {
  const html = readFileSync('data/pages/steampy-home.html', 'utf8');
  console.log('\n===== SteamPy 首页 =====');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  console.log(`脚本 ${scripts.length} 个：`);
  for (const s of scripts) console.log(`  ${s}`);

  const links = [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
  console.log(`\n链接 ${links.length} 个，前 15：`);
  for (const l of links.slice(0, 15)) console.log(`  ${l}`);

  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]{0,300}?)<\/script>/g)].map((m) => m[1].trim()).filter(Boolean);
  console.log(`\n内联脚本 ${inline.length} 段，前 3 段内容：`);
  for (const s of inline.slice(0, 3)) console.log(`  ${s.slice(0, 200)}`);
}

analyzeSonkwo();
analyzeSteampy();
