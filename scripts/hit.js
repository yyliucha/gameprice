#!/usr/bin/env node
// 通用打点：node scripts/hit.js GET|POST <url> [json-body] [--header k:v]
// 只打印状态码、类型、长度和前 300 字符，用来快速确认"这个接口存在吗、要不要登录"。
const [method = 'GET', url, bodyArg] = process.argv.slice(2);
if (!url) {
  console.error('用法: node scripts/hit.js GET|POST <url> [json] [--header k:v]');
  process.exit(1);
}
const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  origin: new URL(url).origin,
  referer: `${new URL(url).origin}/`,
};
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--header' && process.argv[i + 1]) {
    const [k, ...v] = process.argv[i + 1].split(':');
    headers[k.trim()] = v.join(':').trim();
  }
}
const hasBody = method.toUpperCase() !== 'GET' && bodyArg && !bodyArg.startsWith('--header');
if (hasBody) headers['content-type'] = 'application/json';

const started = Date.now();
try {
  const res = await fetch(url, { method: method.toUpperCase(), headers, body: hasBody ? bodyArg : undefined });
  const text = await res.text();
  console.log(`${res.status}  ${res.headers.get('content-type')}  ${(text.length / 1024).toFixed(1)}KB  ${Date.now() - started}ms  ${url}`);
  console.log(`  ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
} catch (err) {
  console.log(`ERR  ${err.cause?.code ?? err.message}  ${url}`);
}
