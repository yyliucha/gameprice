// 站点图标：页面引用的文件必须真的存在，格式要能被浏览器认出来。
// 踩过的坑：<link rel="icon"> 指向不存在的文件不会报任何错，标签页上只是留个白板。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PAGES = ['index.html', 'console.html', 'setup.html'];
const ICONS = ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png'];

test('三个页面都引用同一套图标，且文件真实存在', () => {
  for (const page of PAGES) {
    const html = readFileSync(ROOT + page, 'utf8');
    for (const icon of ICONS) {
      assert.ok(html.includes(`href="${icon}"`), `${page} 缺少 ${icon} 的 <link>`);
      assert.doesNotThrow(() => readFileSync(ROOT + icon.slice(1)), `${page} 引用的 ${icon} 不存在`);
    }
    assert.match(html, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
  }
});

test('favicon.svg 是合法 SVG，尺寸与品牌色都在', () => {
  const svg = readFileSync(ROOT + 'favicon.svg', 'utf8');
  assert.match(svg, /^<svg[^>]*viewBox="0 0 64 64"/);
  assert.match(svg, /#22d3ee/, '品牌渐变起点色');
  assert.match(svg, /#4f46e5/, '品牌渐变终点色');
  assert.match(svg, /<\/svg>\s*$/);
});

test('favicon.ico 是合法的单图标 ICO（PNG 压缩）', () => {
  const ico = readFileSync(ROOT + 'favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0, 'reserved 必须为 0');
  assert.equal(ico.readUInt16LE(2), 1, 'type 必须是 1（icon）');
  assert.equal(ico.readUInt16LE(4), 1, '只放一张图');
  assert.equal(ico[6], 32, '宽 32');
  assert.equal(ico[7], 32, '高 32');
  const offset = ico.readUInt32LE(18);
  const bytes = ico.readUInt32LE(14);
  assert.equal(bytes, ico.length - offset, '资源长度要和文件对得上');
  assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a', '内嵌数据必须是 PNG');
});

test('apple-touch-icon.png 是 180x180 的 PNG', () => {
  const png = readFileSync(ROOT + 'apple-touch-icon.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  assert.equal(png.readUInt32BE(16), 180, '宽 180');
  assert.equal(png.readUInt32BE(20), 180, '高 180');
});
