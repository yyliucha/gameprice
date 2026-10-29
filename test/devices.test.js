// 设备指纹：字段白名单/截断、指纹稳定性、写库节流、设备→指纹映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as devices from '../src/devices.js';

const BASE = {
  platform: 'Win32',
  vendor: 'Google Inc.',
  language: 'zh-CN',
  languages: ['zh-CN', 'en'],
  timezone: 'Asia/Shanghai',
  screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, cd: 24 },
  viewport: { w: 1280, h: 800, dpr: 1 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  touchPoints: 0,
  webglVendor: 'Google Inc. (Intel)',
  webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics)',
  canvasHash: 'abcd1234',
};

test('设备 ID：只接受 8-64 位字母数字/下划线/横线', () => {
  assert.equal(devices.normalizeDeviceId('device-test-0001'), 'device-test-0001');
  assert.equal(devices.normalizeDeviceId('a'.repeat(8)), 'a'.repeat(8));
  assert.equal(devices.normalizeDeviceId('short'), '');
  assert.equal(devices.normalizeDeviceId('a'.repeat(65)), '');
  assert.equal(devices.normalizeDeviceId('bad value with spaces'), '');
  assert.equal(devices.normalizeDeviceId('x'.repeat(8) + '<script>'), '');
  assert.equal(devices.normalizeDeviceId(undefined), '');
});

test('sanitizeDetails：只留白名单字段，长字符串截断、数值有上限', () => {
  const d = devices.sanitizeDetails({
    ...BASE,
    platform: 'P'.repeat(500),
    languages: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    screen: { w: 999999999, h: -5 },
    evil: 'should be dropped',
  });
  assert.equal(d.platform.length, 80, '长字符串要截断');
  assert.equal(d.languages.length, 6, '语言最多 6 个');
  assert.equal(d.screen[0], 20000, '屏幕宽有上限');
  assert.equal(d.screen[1], 0, '负数归零');
  assert.equal(d.evil, undefined, '未列入白名单的字段丢弃');
});

test('指纹：同样的稳定字段 → 同一个指纹；屏幕变化 → 指纹变化', () => {
  const a = devices.fingerprintOf(devices.sanitizeDetails(BASE));
  const b = devices.fingerprintOf(devices.sanitizeDetails({ ...BASE, viewport: { w: 800, h: 600, dpr: 2 } }));
  assert.equal(a, b, '窗口尺寸变化不能改变指纹');
  const c = devices.fingerprintOf(devices.sanitizeDetails({ ...BASE, screen: { ...BASE.screen, w: 2560 } }));
  assert.notEqual(a, c, '屏幕分辨率属于稳定信号');
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('写库节流：同一设备 10 分钟只写一次', () => {
  devices.resetState();
  const now = Date.now();
  assert.equal(devices.shouldLog('did-1', now), true);
  assert.equal(devices.shouldLog('did-1', now + 1000), false);
  assert.equal(devices.shouldLog('did-1', now + 10 * 60 * 1000 + 1), true);
  assert.equal(devices.shouldLog('did-2', now), true, '不同设备互不影响');
  devices.resetState();
});

test('设备→指纹映射：rememberDevice 后审核/封禁能带出指纹', () => {
  devices.resetState();
  devices.rememberDevice('device-test-0001', 'f'.repeat(64), BASE);
  assert.equal(devices.fingerprintFor('device-test-0001'), 'f'.repeat(64));
  assert.equal(devices.fingerprintFor('missing-device'), '');
  devices.resetState();
});
