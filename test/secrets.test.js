// 扫描器自己也要被测：它是"能不能公开仓库"的判断依据，误报会让人无视告警，
// 漏报则直接把凭据推上公网。
// scan-secrets: ignore-file
// 本文件是扫描器自己的测试，夹具里必须包含"看起来像真凭据"的假值，
// 因此整体豁免。豁免会由脚本打印出来，不是静默跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSecrets } from '../scripts/scan-secrets.js';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gp-scan-'));
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

test('真实凭据会被抓出来：token / 私钥 / 带密码连接串', () => {
  const dir = fixture({
    'leak.js': 'const t = "ghp_' + 'A'.repeat(36) + '";\n',
    'key.pem': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
    'db.md': 'postgres://admin:S3cretPw@prod-db.internal:5432/app\n',
  });
  try {
    const { hardHits } = scanSecrets(dir);
    const rules = hardHits.map((h) => h.rule);
    assert.ok(rules.includes('GitHub token'));
    assert.ok(rules.includes('私钥块'));
    assert.ok(rules.includes('带密码的连接串'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('示例与占位符不会误报（这是能不能日常使用它的关键）', () => {
  const dir = fixture({
    'README.md': [
      "export DATABASE_URL='postgres://user:pass@host:5432/db'",
      'postgres://user:password@10.0.0.5:5432/gameprice',
      'DATABASE_URL: ${POSTGRES_PASSWORD:-gameprice}@db:5432/x',
      '把 POSTGRES_PASSWORD=改成你自己的强密码',
    ].join('\n'),
    '.env.example': '# DATABASE_URL=postgres://user:password@example.com:5432/db\nDATABASE_URL=\n',
  });
  try {
    const { hardHits, softHits } = scanSecrets(dir);
    assert.equal(hardHits.length, 0, `误报：${JSON.stringify(hardHits)}`);
    assert.equal(softHits.length, 0, `误报：${JSON.stringify(softHits)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node_modules 与 logs 被跳过', () => {
  const dir = fixture({
    'node_modules/pkg/leak.js': 'const t = "ghp_' + 'B'.repeat(36) + '";\n',
    'logs/app.jsonl': '{"msg":"postgres://root:RealPw123@db-prod:5432/x"}\n',
    'ok.txt': 'hello\n',
  });
  try {
    const { files, hardHits } = scanSecrets(dir);
    assert.equal(files.length, 1, `只应扫到 1 个文件，实际 ${files.length}`);
    assert.equal(hardHits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('测试目录里的假值不报（夹具天然是假的）', () => {
  const dir = fixture({ 'test/x.test.js': "const apiKey = 'abcdef123456';\n" });
  try {
    const { softHits } = scanSecrets(dir);
    assert.equal(softHits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('当前仓库本身是干净的', () => {
  // 不传 ignore：本文件的豁免靠文件头标记，顺带验证豁免机制生效
  const { hardHits, skipped } = scanSecrets(join(import.meta.dirname, '..'));
  assert.ok(skipped.includes('test/secrets.test.js'), '文件头豁免标记应当生效');
  assert.equal(hardHits.length, 0, `仓库里发现凭据：${JSON.stringify(hardHits, null, 2)}`);
});
