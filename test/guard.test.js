// 路径守卫单元测试：白名单、扫描器签名、编码归一化、未知路径计数。
// 重点锁住"正常用户的资源请求不能被当成异常"这条底线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as guard from '../src/guard.js';

const WEB = fileURLToPath(new URL('../web', import.meta.url));

test('白名单：页面、图标、静态文件、API、图片、良性探测都算 known', () => {
  const known = [
    '/',
    '/index.html',
    '/console',
    '/console/',
    '/console.html',
    '/setup',
    '/settings-ui.js',
    '/favicon.ico',
    '/favicon.svg',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/api/games',
    '/api/admin/visitors',
    '/img/steam/730/capsule_sm_120',
    '/robots.txt',
    '/sitemap.xml',
    '/healthz',
    '/.well-known/appspecific/com.chrome.devtools.json',
  ];
  for (const path of known) {
    assert.equal(guard.classifyPath(path, { outDir: WEB }).kind, 'known', path);
  }
});

test('扫描器签名：敏感文件/脚本后缀/穿越/CMS 探测都能命中', () => {
  const bad = [
    '/.env',
    '/.env.local',
    '/.git/config',
    '/wp-login.php',
    '/phpmyadmin/index.php',
    '/shell.php',
    '/backup.sql',
    '/config.old',
    '/etc/passwd',
    '/a/../../etc/passwd',
    '/actuator/env',
    '/manager/html',
    '/%2E%65%6E%76',
  ];
  for (const path of bad) {
    const v = guard.classifyPath(path, { outDir: WEB });
    assert.equal(v.kind, 'signature', `${path} 应命中签名，实际 ${JSON.stringify(v)}`);
  }
});

test('编码/大小写/重复斜杠先归一化再匹配', () => {
  assert.equal(guard.normalizePath('/%2E%65%6E%76'), '/.env');
  assert.equal(guard.normalizePath('//CONSOLE//'), '/console');
  assert.equal(guard.normalizePath('/a\\b'), '/a/b');
  assert.equal(guard.classifyPath('//WP-LOGIN.PHP', { outDir: WEB }).kind, 'signature');
});

test('正常但未知的路径是 unknown，不能误判成扫描器', () => {
  const unknown = ['/logo.png', '/favicon-32x32.png', '/console/extra', '/api2/games', '/old-page'];
  for (const path of unknown) {
    assert.equal(guard.classifyPath(path, { outDir: WEB }).kind, 'unknown', path);
  }
});

test('未知路径计数：同一路径只算一次，窗口内去重', () => {
  guard.resetState();
  guard.configure({ unknownMax: 3, unknownWindowSec: 60 });
  assert.equal(guard.recordUnknown('203.0.113.9', '/a'), 1);
  assert.equal(guard.recordUnknown('203.0.113.9', '/a'), 1, '同一路径重复请求不能叠加');
  assert.equal(guard.recordUnknown('203.0.113.9', '/b'), 2);
  assert.equal(guard.recordUnknown('203.0.113.9', '/c'), 3);
  assert.equal(guard.recordUnknown('198.51.100.7', '/a'), 1, '不同 IP 各自计数');
  guard.resetState();
});

test('资源文件判定：只用于限流分桶，永远不算异常', () => {
  for (const path of ['/img/steam/730/capsule_sm_120', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/settings-ui.js', '/a.css', '/a.woff2']) {
    assert.equal(guard.isAssetPath(path), true, path);
  }
  for (const path of ['/', '/console', '/api/games', '/.env']) {
    assert.equal(guard.isAssetPath(path), false, path);
  }
});

test('inspect：扫描器路径只上报，不封禁（同一 IP+规则 60s 内只报一次）', async () => {
  guard.resetState();
  guard.configure({ enabled: true });
  const reviews = [];
  const onReview = (payload) => reviews.push(payload);
  const first = await guard.inspect({ ip: '203.0.113.9', path: '/.env', outDir: WEB, onReview });
  assert.equal(first.action, 'review');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rule, 'secret-file');
  // 节流：同一 IP + 同一规则一分钟内不重复写审核
  await guard.inspect({ ip: '203.0.113.9', path: '/.env.production', outDir: WEB, onReview });
  assert.equal(reviews.length, 1);
  guard.resetState();
});

test('inspect：正常页面/资源不上报；未知路径达到阈值才上报', async () => {
  guard.resetState();
  guard.configure({ enabled: true, unknownMax: 2, unknownWindowSec: 60 });
  const reviews = [];
  const onReview = (payload) => reviews.push(payload);
  for (const path of ['/', '/img/steam/1/x', '/favicon.ico', '/api/games', '/.well-known/x']) {
    await guard.inspect({ ip: '198.51.100.7', path, outDir: WEB, onReview });
  }
  assert.equal(reviews.length, 0, '正常路径不能产生审核');
  const one = await guard.inspect({ ip: '198.51.100.7', path: '/x1', outDir: WEB, onReview });
  assert.equal(one.action, 'log');
  assert.equal(reviews.length, 0);
  const two = await guard.inspect({ ip: '198.51.100.7', path: '/x2', outDir: WEB, onReview });
  assert.equal(two.action, 'review');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rule, 'unknown-paths');
  guard.resetState();
});
