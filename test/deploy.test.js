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
  assert.match(sh, /^#!\/bin\/bash/, '需要 shebang（bash，tee 进程替换依赖）');
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

test('前后端合并成一个服务：app 跑 all，暴露 WEB_PORT', () => {
  const doc = parse(read('compose.yaml'));
  assert.equal(doc.services.web, undefined, '不应再有独立的 web 服务');
  assert.deepEqual(doc.services.app.command, ['all'], 'app 同时跑调度器与 Web/API');
  assert.deepEqual(doc.services.app.ports, ['${WEB_PORT:-8090}:8080'], '对外只有这一个端口');
  assert.ok(!JSON.stringify(doc).includes('nginx'), '不依赖外部 nginx');
  assert.ok(existsSync(new URL('../web/index.html', import.meta.url)), '前端首页必须存在');
  assert.ok(existsSync(new URL('../web/console.html', import.meta.url)), '控制台页面必须存在');
});

test('.env.example 覆盖 compose 用到的可配置项', () => {
  const example = read('.env.example');
  for (const key of ['COMPOSE_PROFILES', 'POSTGRES_PASSWORD', 'ITAD_API_KEY', 'STEAM_INTERVAL_MIN', 'TZ', 'SEED_ON_START']) {
    assert.match(example, new RegExp(`^#?\\s*${key}=`, 'm'), `.env.example 缺少 ${key}`);
  }
});

test('镜像必须包含前端工程（否则容器里 GET / 404）', () => {
  const df = read('Dockerfile');
  assert.ok(existsSync(new URL('../web/index.html', import.meta.url)), 'web/index.html 必须存在');
  assert.match(df, /COPY --chown=node:node web \.\/web/, 'Dockerfile 必须把 web 目录拷进镜像');
  const ignore = read('.dockerignore');
  assert.ok(!/^web$/m.test(ignore), '.dockerignore 不能排除 web 目录');
});

test('Steam 登录只在后台：前台不得出现登录入口，控制台必须有', () => {
  const front = read('web/index.html');
  assert.ok(!front.includes('/api/auth/steam/start'), '前台不得提供 Steam 登录链接');
  assert.ok(!front.includes('steamPanel'), '前台不得有 Steam 面板');
  assert.ok(!front.includes('data-tab="steam"'), '前台不得有 Steam 页签');
  const console = read('web/console.html');
  assert.ok(console.includes('/api/auth/steam/start'), '控制台必须有 Steam 登录入口');
  assert.ok(console.includes('data-section="steam"'), '控制台必须有 Steam 账号页');
  assert.ok(console.includes('/api/steam/library/sync'), '控制台必须有游戏库同步');
});

test('Docker Hub 零配置 compose：镜像 + 自带 db + 命名卷 + 首次初始化', () => {
  const doc = parse(read('compose.hub.yaml'));
  assert.equal(doc.services.app.image, 'yyliucha/steamdeals:latest');
  assert.equal(doc.services.app.build, undefined, 'Hub compose 不应要求本地源码构建');
  assert.ok(doc.services.db, '零配置模式必须自带 db');
  assert.match(doc.services.app.ports.join(' '), /\$\{WEB_PORT:-8090\}:8080/);
  const env = doc.services.app.environment;
  assert.match(env.DATABASE_URL, /@db:5432/);
  assert.equal(env.ITAD_API_KEY, undefined, '业务配置不能继续塞进 compose');
  assert.equal(env.STEAM_INTERVAL_MIN, undefined, '业务配置不能继续塞进 compose');
  const vols = doc.services.app.volumes.join(' ');
  assert.match(vols, /appdata:\/app\/data/);
  assert.match(vols, /logs:\/app\/logs/);
  assert.ok('appdata' in doc.volumes && 'pgdata' in doc.volumes && 'logs' in doc.volumes);
  assert.ok(existsSync(new URL('../web/setup.html', import.meta.url)), '初始化页必须存在');
  assert.ok(existsSync(new URL('../web/settings-ui.js', import.meta.url)), '设置表单渲染器必须存在');
});

test('Docker Hub 外部数据库 compose：不启动 db，DATABASE_URL 由命令传入', () => {
  const doc = parse(read('compose.hub.external-db.yaml'));
  assert.equal(doc.services.app.image, 'yyliucha/steamdeals:latest');
  assert.equal(doc.services.db, undefined, '外部库模式不能启动 db');
  const raw = doc.services.app.environment.DATABASE_URL;
  assert.match(raw, /DATABASE_URL:\?/, '缺少 DATABASE_URL 时应由 compose 直接报错');
  assert.ok(doc.services.app.extra_hosts.includes('host.docker.internal:host-gateway'));
  assert.match(doc.services.app.ports.join(' '), /\$\{WEB_PORT:-8090\}:8080/);
});

test('发布工作流：多架构构建、Docker Hub 镜像名、先跑测试与冒烟', () => {
  const wf = read('.github/workflows/docker-hub.yml');
  assert.match(wf, /yyliucha\/steamdeals/);
  assert.match(wf, /linux\/amd64,linux\/arm64/);
  assert.match(wf, /docker\/build-push-action/);
  assert.match(wf, /npm test/);
  assert.match(wf, /gameprice:ci all/, '冒烟必须真正启动 Web/API 进程');
  assert.match(wf, /api\/setup\/complete/);
});

test('.dockerignore 不能把 secret.key / 测试数据库打进镜像', () => {
  const ignore = read('.dockerignore');
  assert.match(ignore, /^data\/secret\.key$/m);
  assert.match(ignore, /^data\/\*-pgdata$/m);
  assert.match(ignore, /^data\/backup$/m);
  assert.match(ignore, /^\.env$/m);
});

test('容器入口在 all 模式先 bootstrap，保证首次启动导入种子游戏', () => {
  const sh = read('scripts/docker-entrypoint.sh');
  assert.match(sh, /"\$1" = "all"/);
  assert.match(sh, /node src\/cli\.js bootstrap/);
});
