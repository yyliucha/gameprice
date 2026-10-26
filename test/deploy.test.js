// 部署配置的一致性检查：Dockerfile / compose / 入口脚本三者必须对得上。
// 没有 docker 的机器上也能跑，用来防止改了命令却忘了改容器入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('compose.yaml 合法且服务齐全', () => {
  const doc = parse(read('compose.yaml'));
  assert.ok(doc.services?.app, '缺少 app 服务');
  assert.ok(doc.services?.db, '缺少 db 服务');
  assert.ok(doc.services.db.profiles.includes('bundled'), 'db 应属于 bundled profile');
  assert.ok(doc.services.app.build, 'app 应从本地 Dockerfile 构建');
  assert.equal(doc.services.app.depends_on.db.required, false, 'db 必须是可选的（支持外部库）');
  assert.ok(doc.services.app.healthcheck, 'app 需要 healthcheck');
  assert.deepEqual(doc.services.app.healthcheck.test, ['CMD', 'node', 'src/cli.js', 'ping']);
  assert.ok(doc.services.db.healthcheck.test.join(' ').includes('pg_isready'));
  assert.ok('pgdata' in (doc.volumes ?? {}), '缺少数据卷 pgdata');
});

test('compose 里 app 的数据卷与日志卷指向宿主机', () => {
  const doc = parse(read('compose.yaml'));
  const vols = doc.services.app.volumes.join(' ');
  assert.match(vols, /\.\/logs:\/app\/logs/);
  assert.match(vols, /\.\/data:\/app\/data/);
});

test('compose 的 DATABASE_URL 默认指向内置 db', () => {
  const doc = parse(read('compose.yaml'));
  assert.match(doc.services.app.environment.DATABASE_URL, /@db:5432/);
});

test('Dockerfile 关键约束：非 root、tini、健康检查、生产依赖', () => {
  const df = read('Dockerfile');
  assert.match(df, /FROM node:22/);
  assert.match(df, /npm ci --omit=dev/, '必须只装生产依赖');
  assert.match(df, /USER node/, '不能以 root 运行');
  assert.match(df, /HEALTHCHECK/);
  assert.match(df, /tini/, '需要 tini 转发信号');
  assert.match(df, /ENTRYPOINT \["\/usr\/bin\/tini"/);
});

test('入口脚本存在且逻辑完整', () => {
  const sh = read('scripts/docker-entrypoint.sh');
  assert.match(sh, /^#!\/bin\/sh/, '需要 shebang');
  assert.match(sh, /exec node src\/cli\.js "\$@"/, '带参数时应当透传为 CLI');
  assert.match(sh, /bootstrap/, '启动前要建表');
  assert.match(sh, /scheduler/, '默认要跑调度器');
  assert.match(sh, /set -eu/, '应当 fail fast');
});

test('构建所需文件都在（.dockerignore 不能把它们排掉）', () => {
  for (const f of ['package.json', 'package-lock.json', 'src/cli.js', 'src/scheduler.js', 'data/games.json', 'data/skus.json']) {
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} 必须存在`);
  }
  const ignore = read('.dockerignore');
  assert.ok(!/^data$/m.test(ignore), '.dockerignore 不能整体排除 data 目录');
  assert.ok(/^test$/m.test(ignore), 'test 目录应排除，减小镜像');
});

test('入口脚本必须是 LF 换行且无 BOM（CRLF 会让容器报 no such file or directory）', () => {
  const buf = readFileSync(new URL('../scripts/docker-entrypoint.sh', import.meta.url));
  assert.notEqual(buf[0], 0xef, '不能有 UTF-8 BOM');
  const crlf = [...buf].some((b, i, arr) => b === 0x0a && arr[i - 1] === 0x0d);
  assert.equal(crlf, false, '不能出现 CRLF');
});

test('.env.example 覆盖 compose 用到的可配置项', () => {
  const example = read('.env.example');
  for (const key of ['POSTGRES_PASSWORD', 'ITAD_API_KEY', 'STEAM_INTERVAL_MIN', 'TZ', 'SEED_ON_START']) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `.env.example 缺少 ${key}`);
  }
});
