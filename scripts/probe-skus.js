#!/usr/bin/env node
// SKU id 探测：给定区间抽样，统计有效商品密度，用于设计"按 id 扫描发现"的窗口。
//
// 判定标准与适配器保持一致：能解析出报价才算商品。仅返回 200 但只是通用站名页
// （杉果对未上架/已下架 id 会返回 200 的空壳）不算。
//
// 用法：node scripts/probe-skus.js --from 111400 --to 111500 --step 1 --rate 400
import { fetchText } from '../src/http.js';
import { parseSkuPage } from '../src/adapters/sonkwo.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i > -1 && args[i + 1] ? args[i + 1] : d;
};

const from = Number(flag('from', 111440));
const to = Number(flag('to', 111480));
const step = Number(flag('step', 1));
const rate = Number(flag('rate', 400));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const products = [];
const shells = [];

for (let id = from; id <= to; id += step) {
  const url = `https://www.sonkwo.hk/sku/${id}`;
  try {
    const res = await fetchText(url, { retries: 0, timeoutMs: 15000 });
    const offer = parseSkuPage(res.body, { skuId: id });
    if (offer) {
      products.push({ id, name: offer.title, priceCents: offer.priceCents });
      console.log(`✔ ${id}  ¥${(offer.priceCents / 100).toFixed(2).padStart(7)}  ${offer.title}`);
    } else {
      shells.push(id);
      console.log(`· ${id}  (空壳/非商品)`);
    }
  } catch (err) {
    shells.push(id);
    console.log(`✘ ${id}  ${err.status ?? err.message}`);
  }
  await sleep(rate);
}

const total = products.length + shells.length;
console.log(`\n区间 ${from}..${to} step ${step}：请求 ${total}，商品 ${products.length}，空壳 ${shells.length}`);
if (products.length) {
  console.log(`商品 id：${products.map((p) => p.id).join(',')}`);
}
