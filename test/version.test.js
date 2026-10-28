// 版本比较与新版本检查（fetch 用注入的假实现，不发真实请求）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, checkLatest, versionInfo, resetVersionCache } from '../src/version.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://api.github.com/test',
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    text: async () => JSON.stringify(body),
  };
}

test('版本解析与比较', () => {
  assert.deepEqual(parseVersion('v0.20.2'), [0, 20, 2]);
  assert.deepEqual(parseVersion('1.2.3-rc1'), [1, 2, 3]);
  assert.equal(parseVersion('dev'), null);
  assert.equal(parseVersion(''), null);

  assert.ok(compareVersions('0.20.3', '0.20.2') > 0);
  assert.ok(compareVersions('v0.20.2', '0.20.2') === 0);
  assert.ok(compareVersions('0.9.9', '0.10.0') < 0, '数值比较而不是字符串比较');
  assert.equal(compareVersions('bad', '0.20.2'), 0);
});

test('检查更新：没有 release 时退回 tags，并识别出更新', async () => {
  resetVersionCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/releases/latest')) return jsonResponse({ message: 'Not Found' }, 404);
    return jsonResponse([{ name: 'v0.20.1' }, { name: 'v0.20.3' }, { name: 'v0.19.9' }, { name: 'nightly' }]);
  };

  const info = await versionInfo({ current: '0.20.2', fetchImpl, force: true });
  assert.equal(info.latest, 'v0.20.3');
  assert.equal(info.updateAvailable, true);
  assert.match(info.url, /releases\/tag\/v0\.20\.3/);
  assert.equal(info.error, null);
  assert.ok(calls.some((u) => u.includes('/releases/latest')));
  assert.ok(calls.some((u) => u.includes('/tags')));
});

test('当前已是最新时 updateAvailable=false', async () => {
  resetVersionCache();
  const fetchImpl = async (url) =>
    url.includes('/releases/latest')
      ? jsonResponse({ tag_name: 'v0.20.2', html_url: 'https://github.com/y/steamdeals/releases/tag/v0.20.2' })
      : jsonResponse([]);
  const info = await versionInfo({ current: '0.20.2', fetchImpl, force: true });
  assert.equal(info.latest, 'v0.20.2');
  assert.equal(info.updateAvailable, false);
});

test('检查结果有缓存，force 才重新请求；网络失败只记 error', async () => {
  resetVersionCache();
  let count = 0;
  const fetchImpl = async (url) => {
    count += 1;
    if (url.includes('/releases/latest')) return jsonResponse({ tag_name: 'v0.20.5' });
    return jsonResponse([]);
  };
  const first = await checkLatest({ fetchImpl, force: true });
  assert.equal(first.latest, 'v0.20.5');
  const before = count;
  const second = await checkLatest({ fetchImpl });
  assert.equal(count, before, '未强制时走缓存');
  assert.equal(second.latest, 'v0.20.5');

  resetVersionCache();
  const info = await versionInfo({
    current: '0.20.2',
    force: true,
    fetchImpl: async () => {
      throw Object.assign(new Error('boom'), {});
    },
  });
  assert.equal(info.latest, null);
  assert.equal(info.updateAvailable, false);
  assert.match(info.error, /boom/);
});
