# Docker Hub 部署

镜像：`yyliucha/steamdeals:latest`（多架构：`linux/amd64` / `linux/arm64`）。

**部署不需要 `.env`，也不需要改 docker-compose 文件里的业务配置。** 第一次打开页面会进入 `/setup`，创建管理员并填写数据源/代理/提醒；这些配置写到 PostgreSQL，之后在「控制台 → 系统设置」修改。

## 方式一：自带 PostgreSQL（零配置，推荐）

```bash
docker compose -f compose.hub.yaml up -d
```

然后打开：

```text
http://服务器IP:8090
```

会自动跳到 `/setup`。完成初始化后，调度器约 15 秒内开始采集。

这个 compose 文件：

- 使用镜像 `yyliucha/steamdeals:latest`
- 自带 `postgres:15-alpine`，数据库端口不发布到宿主机
- 用命名卷 `appdata` / `logs` / `pgdata`，不需要 `mkdir` 或 `chown`
- 只向应用注入 `DATABASE_URL`、`TZ`、可选 `SETUP_TOKEN`，没有任何业务配置

## 方式二：使用已有 PostgreSQL（数据库配置放在 compose 命令里）

不启动 db 容器，数据库地址直接通过命令的环境变量传入：

```bash
DATABASE_URL='postgres://user:password@10.0.0.5:5432/gameprice?sslmode=require' \
  docker compose -f compose.hub.external-db.yaml up -d
```

宿主机上的 PostgreSQL：

```bash
DATABASE_URL='postgres://gameprice:密码@host.docker.internal:5432/gameprice' \
  docker compose -f compose.hub.external-db.yaml up -d
```

> 数据库连接串必须在应用启动前就存在，无法搬进数据库本身，所以它保留为部署参数；但可以完全写在 compose 命令里，不需要创建 `.env`。业务设置（数据源、Key、代理、提醒等）才落库。

也可以直接用 `docker run`（同样需要外部 PostgreSQL）：

```bash
docker run -d --name gameprice \
  -p 8090:8080 \
  -e DATABASE_URL='postgres://user:password@host:5432/gameprice' \
  -e TZ=Asia/Shanghai \
  -v gameprice_data:/app/data \
  -v gameprice_logs:/app/logs \
  yyliucha/steamdeals:latest all
```

## 首次初始化

未完成初始化时：

- 所有页面 302 到 `/setup`
- 除 `/api/setup/*` 外的 API 返回 `428 { setupRequired: true }`
- 健康检查仍然正常（只验证数据库连接），容器不会因为“未初始化”反复重启

`/setup` 要填：

1. 管理员用户名/密码（第一个管理员）
2. 数据源开关；国内服务器建议填 ITAD API Key 或 Steam 代理
3. 可选的 SMTP/Webhook 提醒配置

完成后自动登录并进入控制台。之后所有业务配置都可以在「系统设置」修改，调度器热加载。

### 防止公网被抢先初始化

默认首次访问者可以完成初始化（自托管常见做法）。如果端口会直接暴露公网，建议设置一次性口令：

```bash
SETUP_TOKEN='换成一个随机长口令' docker compose -f compose.hub.yaml up -d
```

设置后，`/setup` 会要求输入同一个口令；初始化完成后 setup 接口自动失效。

## 数据与备份

| 卷 | 内容 |
|---|---|
| `gameprice_pgdata` | PostgreSQL 数据 |
| `gameprice_appdata` | `data/secret.key`、SKU 清单、备份 |
| `gameprice_logs` | 结构化日志 |

`data/secret.key` 用来加密 SMTP 授权码等密钥。**不要删 appdata 卷**，否则已保存的密钥无法解密，需要到控制台重新填写。

备份：

```bash
docker compose -f compose.hub.yaml exec -T db \
  pg_dump -U gameprice gameprice > backup-$(date +%F).sql
```

升级：

```bash
docker compose -f compose.hub.yaml pull
docker compose -f compose.hub.yaml up -d
```

启动时会自动跑幂等迁移。

## 部署参数（仅这些还需要环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 自带 db | 外部 PostgreSQL 连接串 |
| `WEB_PORT` | `8090` | 宿主机端口（容器内固定 8080） |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `SETUP_TOKEN` | 空 | 设置后初始化页要求口令 |
| `SECRET_KEY` | 自动生成 | 可选；不设则用 `data/secret.key` |
| `DB_WAIT_SEC` | `60` | 启动时最多等数据库多少秒 |
| `SEED_ON_START` | `1` | 首次启动是否导入 `data/games.json` |

数据源开关、间隔、API Key、代理、提醒、熔断等 **50 项业务设置** 都在数据库/页面里，见 [DEPLOY.md](DEPLOY.md#业务设置) 或控制台「系统设置」。

## 旧 .env 部署升级

如果数据库里已经有管理员，应用启动时会：

1. 自动把当前 `.env` 里的旧业务变量导入数据库（只填空缺，不覆盖已有库值）
2. 标记初始化完成，不会把老用户拦到 `/setup`

之后以数据库为准；确认页面里的配置正确后，可以把旧业务变量从 `.env` 删掉。数据库连接、端口等部署参数仍保留在 compose/env 中。

## 排障

```bash
docker compose -f compose.hub.yaml ps
docker compose -f compose.hub.yaml logs -f app
docker compose -f compose.hub.yaml exec app node src/cli.js ping
docker compose -f compose.hub.yaml exec app node src/cli.js diagnose
```

| 现象 | 先看 |
|---|---|
| 一直跳 `/setup` | 管理员是否创建成功；日志搜 `setup.completed` |
| 初始化页 428/无法加载 | 确认访问的是 `http://IP:8090/setup`，不是反代后的子路径 |
| `app` unhealthy | `docker compose logs app`；`ping` 只验证数据库 |
| 采集没开始 | 完成初始化了吗？日志搜 `scheduler.waiting_setup` / `scheduler.start` |
| 邮件发不出 | 控制台「系统设置」里 SMTP 主机/账号/授权码；或「邮箱配置」页发测试邮件 |
| 密钥解密失败 | `data/secret.key` 是否随卷保留；日志搜 `settings.decrypt_failed` |
