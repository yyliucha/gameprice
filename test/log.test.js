import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, readLogs, redactObject, redactUrl, serializeError } from '../src/log.js';

const dir = mkdtempSync(join(tmpdir(), 'gp-log-'));

test('日志落成合法 JSONL，带 ts/level/event', () => {
  const logger = createLogger({ dir, prefix: 'app', console: false, level: 'debug' });
  logger.info('test.hello', { a: 1, b: 'x' });
  logger.error('test.boom', { err: serializeError(new Error('炸了')) });

  const day = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(join(dir, `app-${day}.jsonl`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, 'test.hello');
  assert.equal(first.level, 'info');
  assert.equal(first.a, 1);
  assert.ok(first.ts.includes('T'));
  assert.ok(first.pid > 0);

  const second = JSON.parse(lines[1]);
  assert.equal(second.event, 'test.boom');
  assert.match(second.err.stack, /Error/);
});

test('错误日志会额外写一份 error-*.jsonl', () => {
  const day = new Date().toISOString().slice(0, 10);
  const errLines = readFileSync(join(dir, `error-${day}.jsonl`), 'utf8').trim().split('\n');
  assert.equal(errLines.length, 1, '只有 error 级别进 error 文件');
  assert.equal(JSON.parse(errLines[0]).event, 'test.boom');
});

test('密钥被脱敏，但保留可读信息', () => {
  const logger = createLogger({ dir, prefix: 'redact', console: false });
  logger.info('test.secret', {
    apiKey: 'abcdef123456',
    password: 'hunter2',
    nested: { accessToken: 'tok_xxx', safe: 'keep-me' },
    dsn: 'postgres://user:pw@db:5432/x',
  });
  const day = new Date().toISOString().slice(0, 10);
  const rec = JSON.parse(readFileSync(join(dir, `redact-${day}.jsonl`), 'utf8').trim());
  assert.equal(rec.apiKey, '***');
  assert.equal(rec.password, '***');
  assert.equal(rec.nested.accessToken, '***');
  assert.equal(rec.nested.safe, 'keep-me');
  assert.ok(!JSON.stringify(rec).includes('hunter2'));
  assert.match(rec.dsn, /user:\*\*\*@db/);
});

test('redactUrl 只抹掉敏感查询参数', () => {
  const out = redactUrl('https://api.itad.com/games/prices/v3?key=SECRET&country=CN');
  assert.match(out, /key=\*\*\*/);
  assert.match(out, /country=CN/);
  assert.ok(!out.includes('SECRET'));
});

test('redactObject 对深层嵌套和数组生效', () => {
  const out = redactObject({ list: [{ token: 'a', ok: 1 }], deep: { a: { b: { secret: 's' } } } });
  assert.equal(out.list[0].token, '***');
  assert.equal(out.list[0].ok, 1);
  assert.equal(out.deep.a.b.secret, '***');
});

test('readLogs 支持按级别/事件/runId 过滤', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'gp-log2-'));
  const logger = createLogger({ dir: d2, console: false, bindings: { runId: 'run-A' } });
  logger.info('http.request', { url: 'u1' });
  logger.warn('http.retry', { attempt: 1 });
  logger.error('http.error', { status: 429 });
  logger.child({ runId: 'run-B' }).error('db.query_failed', { sql: 'x' });

  assert.equal(readLogs({ dir: d2, level: 'error' }).length, 2);
  assert.equal(readLogs({ dir: d2, event: 'http.' }).length, 3);
  assert.equal(readLogs({ dir: d2, runId: 'run-A' }).length, 3);
  assert.equal(readLogs({ dir: d2, runId: 'run-B' }).length, 1);
  assert.equal(readLogs({ dir: d2, limit: 2 }).length, 2);
  rmSync(d2, { recursive: true, force: true });
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
});
