// Steam 登录 baseUrl：只有可信反代才采纳 X-Forwarded-*，防 Host/协议伪造。
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl } from '../src/steam-login.js';

const req = (headers = {}, remote = '1.2.3.4', encrypted = false) => ({
  headers,
  socket: { remoteAddress: remote, encrypted },
});

test('直连请求（不可信来源）：忽略 X-Forwarded-*，用 Host 与 socket 协议', () => {
  delete process.env.TRUST_PROXY;
  delete process.env.TRUSTED_PROXY_IPS;
  assert.equal(baseUrl(req({ host: 'site.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })), 'http://site.example');
  assert.equal(baseUrl(req({ host: 'site.example' }, '1.2.3.4', true)), 'https://site.example');
});

test('TRUST_PROXY=1 且来源在 TRUSTED_PROXY_IPS：采纳 X-Forwarded-*', () => {
  process.env.TRUST_PROXY = '1';
  process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';
  assert.equal(baseUrl(req({ host: 'internal', 'x-forwarded-host': 'site.example', 'x-forwarded-proto': 'https' }, '10.0.0.5')), 'https://site.example');
  // 不在白名单的来源即使是 TRUST_PROXY=1 也不信
  assert.equal(baseUrl(req({ host: 'site.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, '1.2.3.4')), 'http://site.example');
  delete process.env.TRUST_PROXY;
  delete process.env.TRUSTED_PROXY_IPS;
});

test('私有网段来源自动信任（反向代理直连场景）', () => {
  delete process.env.TRUST_PROXY;
  assert.equal(baseUrl(req({ host: 'internal', 'x-forwarded-host': 'site.example', 'x-forwarded-proto': 'https' }, '127.0.0.1')), 'https://site.example');
});
