// 文档链接检查：README / docs 里的相对链接必须指向真实存在的文件。
// 文档会随代码演进漂移，断链让新读者第一次就踩坑——用测试兜住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'docs/ARCHITECTURE.md',
  'docs/DEPLOY.md',
  'docs/DATA-SOURCES.md',
  'docs/QUICKSTART.md',
  'docs/WEB.md',
];

// [文本](目标) —— 跳过外链、页内锚点、mailto
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

function collectLinks(file) {
  const abs = resolve(ROOT, file);
  const text = readFileSync(abs, 'utf8');
  const found = [];
  for (const m of text.matchAll(LINK_RE)) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split('#')[0];
    if (!target) continue;
    found.push({ raw, target, resolved: resolve(dirname(abs), decodeURI(target)) });
  }
  return found;
}

test('文档里的相对链接都指向真实文件', () => {
  const broken = [];
  let total = 0;
  for (const file of DOCS) {
    for (const link of collectLinks(file)) {
      total += 1;
      if (!existsSync(link.resolved)) {
        broken.push(`${file} → ${link.raw}（解析为 ${link.resolved}）`);
      }
    }
  }
  assert.equal(broken.length, 0, `发现 ${broken.length} 个断链：\n${broken.join('\n')}`);
  assert.ok(total >= 10, `链接数偏少（${total}），检查是否漏解析`);
});

test('入口文档齐全', () => {
  for (const file of [...DOCS, 'LICENSE']) {
    assert.ok(existsSync(resolve(ROOT, file)), `缺少 ${file}`);
  }
});

test('README 说明了边界与限制', () => {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  // 这四个段落是"描述类内容"的底线，缺了说明被误删
  assert.match(readme, /## 它明确不做什么/, '缺少"不做什么"章节');
  assert.match(readme, /## 已知限制/, '缺少"已知限制"章节');
  assert.match(readme, /## 数据源/, '缺少"数据源"章节');
  assert.match(readme, /## 日志与排障/, '缺少"日志与排障"章节');
});

test('CHANGELOG 有版本号与日期格式', () => {
  const log = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}/, '版本标题格式应为 ## [x.y.z] - YYYY-MM-DD');
});

test('LICENSE 与 package.json 的协议一致', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const license = readFileSync(resolve(ROOT, 'LICENSE'), 'utf8');
  assert.equal(pkg.license, 'MIT');
  assert.match(license, /MIT License/);
  assert.match(license, /yyliucha/);
});
