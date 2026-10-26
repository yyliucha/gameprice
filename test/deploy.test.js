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
  // db 不能挂在 profile 下：否则没有 .env 时 `docker compose up` 不会启动它，
  // app 连不上 db:5432 无限重启（这是真实踩过的坑）
  assert.equal(doc.services.db.profiles, undefined, 'db 不能依赖 profile 才会启动');
  assert.ok(doc.services.app.build, 'app 应从本地 Dockerfile 构建');
  assert.equal(doc.services.app.depends_on.db.required, false, 'db 必须是可选的（支持外部库）');
  assert.ok(doc.services.app.healthcheck, 'app 需要 healthcheck');
  assert.deepEqual(doc.services.app.healthcheck.test, ['CMD', 'node', 'src/cli.js', 'ping']);
  assert.ok(doc.services.db.healthcheck.test.join(' ').includes('pg_isready'));
  assert.ok('pgdata' in (doc.volumes ?? {}), '缺少数据卷 pgdata');
});

test('入口脚本会提前检查挂载目录可写，并给出修复命令', () => {
  const sh = read('scripts/docker-entrypoint.sh');
  assert.match(sh, /check_writable \/app\/logs/, '必须检查日志目录');
  assert.match(sh, /check_writable \/app\/data/, '必须检查数据目录');
  assert.match(sh, /chown -R 1000:1000/, '错误信息要给可直接执行的命令');
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

test('compose 默认零配置可启动：不强制密码，库端口不对外', () => {
  const doc = parse(read('compose.yaml'));
  const dbEnv = doc.services.db.environment;
  assert.equal(dbEnv.POSTGRES_HOST_AUTH_METHOD, '${POSTGRES_HOST_AUTH_METHOD:-trust}', '默认应免密启动');
  assert.equal(dbEnv.POSTGRES_PASSWORD, undefined, '不应把密码设成必填');
  assert.equal(doc.services.db.ports, undefined, '数据库端口不能发布到宿主机');
  // 应用侧连接串不带密码，配合 trust 认证
  assert.match(doc.services.app.environment.DATABASE_URL, /postgres:\/\/.*@db:5432/);
});

test('app 能用 host.docker.internal 连宿主机上的现成 PostgreSQL', () => {
  const doc = parse(read('compose.yaml'));
  assert.deepEqual(doc.services.app.extra_hosts, ['host.docker.internal:host-gateway']);
});

test('教程必须先建目录再 chown（logs/out 不在仓库里）', () => {
  const doc = read('docs/QUICKSTART.md');
  const mkdirAt = doc.indexOf('mkdir -p logs out');
  const chownAt = doc.indexOf('chown -R 1000:1000');
  assert.ok(mkdirAt > -1, '教程缺少 mkdir -p logs out');
  assert.ok(chownAt > mkdirAt, 'mkdir 必须在 chown 之前');
  assert.ok(existsSync(new URL('../data/wishlist.example.txt', import.meta.url)), '缺少 wishlist 模板');
});

test('.env.example 覆盖 compose 用到的可配置项', () => {
  const example = read('.env.example');
  for (const key of ['COMPOSE_PROFILES', 'POSTGRES_PASSWORD', 'ITAD_API_KEY', 'STEAM_INTERVAL_MIN', 'TZ', 'SEED_ON_START']) {
    assert.match(example, new RegExp(`^#?\\s*${key}=`, 'm'), `.env.example 缺少 ${key}`);
  }
});
