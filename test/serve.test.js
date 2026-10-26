// 内置静态页服务：路径解析、内容类型、GET/HEAD/405、路径穿越防护。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFilePath, contentTypeFor, startStaticServer } from '../src/serve.js';

function makeSite() {
  const root = mkdtempSync(join(tmpdir(), 'gp-serve-'));
  writeFileSync(join(root, 'index.html'), '<h1>首页</h1>');
  writeFileSync(join(root, 'game-105600.html'), '<h1>泰拉瑞亚</h1>');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'index.html'), '<h1>子目录</h1>');
  writeFileSync(join(root, 'styles.css'), 'body{}');
  return root;
}

test('路径解析：目录内正常，穿越和非法编码一律拒绝', () => {
  const root = makeSite();
  assert.ok(resolveFilePath(root, '/index.html').endsWith('index.html'));
  assert.ok(resolveFilePath(root, '/sub/index.html').endsWith('index.html'));
  assert.equal(resolveFilePath(root, '/../secret.txt'), null, '../ 必须被拦');
  assert.equal(resolveFilePath(root, '/sub/../../secret.txt'), null);
  assert.equal(resolveFilePath(root, '/%2e%2e/secret.txt'), null, 'URL 编码的 ../ 也要拦');
  assert.equal(resolveFilePath(root, '/a%00b.html'), null, '空字节要拦');
  assert.equal(resolveFilePath(root, '/%E0%A4%A'), null, '非法百分号编码要拦');
});

test('内容类型：按扩展名给，未知回退二进制', () => {
  assert.match(contentTypeFor('a.html'), /text\/html/);
  assert.match(contentTypeFor('a.css'), /text\/css/);
  assert.match(contentTypeFor('a.svg'), /image\/svg\+xml/);
  assert.equal(contentTypeFor('a.xyz'), 'application/octet-stream');
});

test('HTTP：首页、子目录、404、HEAD、405', async () => {
  const root = makeSite();
  const srv = await startStaticServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /首页/);
    assert.equal(index.headers.get('cache-control'), 'no-cache', 'HTML 不能缓存');

    const sub = await fetch(`${base}/sub/`);
    assert.equal(sub.status, 200);
    assert.match(await sub.text(), /子目录/, '目录请求应返回 index.html');

    const page = await fetch(`${base}/game-105600.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /泰拉瑞亚/);

    const css = await fetch(`${base}/styles.css`);
    assert.match(css.headers.get('cache-control'), /max-age/, '静态资源可短缓存');

    assert.equal((await fetch(`${base}/nope.html`)).status, 404);

    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(await head.text(), '', 'HEAD 不应有响应体');

    const post = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await srv.close();
  }
});

test('HTTP：原始请求里的 ../ 被拒绝（不依赖客户端归一化）', async () => {
  const root = makeSite();
  const srv = await startStaticServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const status = await new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/../package.json', method: 'GET' }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on('error', fail);
    req.end();
  });
  try {
    assert.equal(status, 403, '越界访问应返回 403');
  } finally {
    await srv.close();
  }
});

test('port=0 时返回系统分配的真实端口', async () => {
  const srv = await startStaticServer({ rootDir: makeSite(), port: 0, host: '127.0.0.1' });
  try {
    assert.ok(srv.port > 0);
    assert.equal(typeof srv.close, 'function');
  } finally {
    await srv.close();
  }
});
