# 部署

两种方式，先说结论：**有现成 PG 就用方式二，没有就用方式一（一条命令起全套）。**

前置：Docker ≥ 24 与 Docker Compose ≥ **2.20**（用到了 `depends_on.required` 字段）。

---

## 方式一：一体化（自带 PostgreSQL 15）

```bash
git clone <你的仓库> gameprice && cd gameprice
cp .env.example .env
# 必须改 POSTGRES_PASSWORD，其余可留默认
vi .env
docker compose up -d --build
```

`.env` 里的 `COMPOSE_PROFILES=bundled` 会让 compose 同时启动 `db`（postgres:15-alpine）和 `app`。

起来之后：

```bash
docker compose ps                    # app 应为 healthy
docker compose logs -f app           # 看启动日志
docker compose exec app node src/cli.js stats
docker compose exec app node src/cli.js list
```

首轮采集在三分钟内陆续开始（steam 30s、sonkwo 180s、itad 300s 之后各自触发一次，避免同时打满）。

## 方式二：用你自己的 PostgreSQL

你的库是 15.17，直接用。**注意不要用 `--build` 之外的特殊操作，改 `.env` 即可：**

```bash
cp .env.example .env
vi .env
```

```ini
# 把这一行清空或删掉，compose 就不会启动自带的 db
COMPOSE_PROFILES=
DATABASE_URL=postgres://gameprice:密码@10.0.0.5:5432/gameprice
```

```bash
docker compose up -d --build      # 只会启动 app
```

已建库的用户需要有建表权限（`init` 会 `create table if not exists`）。

> 如果你的 Compose 低于 2.20，`required: false` 会报未知字段。两种办法：
> ① 升级 compose；② 把 `compose.yaml` 里 `app.depends_on` 整段删掉——
> app 自带 `DB_WAIT_SEC=60` 的等库重试，数据库慢一点也能自己连上。

---

## 容器里跑了什么

```
tini (PID 1，转发信号)
 └─ docker-entrypoint.sh
     ├─ node src/cli.js bootstrap     建表 + 首次自动导入 data/games.json（已导入则跳过）
     └─ node src/scheduler.js         常驻，按间隔派生子进程跑采集
         ├─ node src/cli.js sync steam
         ├─ node src/cli.js sync sonkwo
         └─ node src/cli.js sync itad
```

单个采集任务失败**不会**影响调度器和其它任务：子进程退出码非 0 只会在日志里记 `scheduler.job_failed`，下一个周期照跑。

入口也支持直接当 CLI 用（`RUN_MODE` 只在无参数时生效）：

```bash
docker compose run --rm app list
docker compose run --rm app sync sonkwo --limit 1
docker compose run --rm app diagnose
```

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 指向内置 db | `postgres://user:pass@host:5432/db` |
| `POSTGRES_PASSWORD` | 无（必填） | 仅方式一使用 |
| `ITAD_API_KEY` | 空 | 空则跳过 itad 源（日志记 `sync.skip`） |
| `STEAM_ENABLED` / `SONKWO_ENABLED` / `ITAD_ENABLED` | `1` | 置 `0` 关闭该源 |
| `STEAM_INTERVAL_MIN` / `SONKWO_INTERVAL_MIN` / `ITAD_INTERVAL_MIN` | 60/60/1440 | 采集间隔（分钟） |
| `DB_WAIT_SEC` | 60 | 启动时最多等数据库多少秒 |
| `SEED_ON_START` | 1 | 首次启动是否导入 `data/games.json` |
| `LOG_LEVEL` | info | trace/debug/info/warn/error |
| `ALERT_WEBHOOK_URL` | 空 | 填了才投递提醒；空则只输出简报 |
| `ALERTS_ENABLED` / `ALERTS_INTERVAL_MIN` | 1 / 360 | 提醒检查开关与间隔 |
| `CIRCUIT_THRESHOLD` / `CIRCUIT_COOLDOWN_MIN` | 3 / 360 | 连续失败 N 次后暂停多久 |
| `TZ` | Asia/Shanghai | 影响日志与 `current_date` |
| `RUN_MODE` | scheduler | `scheduler` 常驻；`once` 只 bootstrap 后退出 |

---

## 日常运维

```bash
# 看最近错误
docker compose exec app node src/cli.js logs --level error --limit 20

# 看某次采集全轨迹（runId 从上面输出里拿）
docker compose exec app node src/cli.js logs --run run-20261026030334-y9gn

# 自检（数据库/网络/表结构），报告落在宿主 logs/
docker compose exec app node src/cli.js diagnose

# 生成静态价格页（曲线图），输出到容器内 /app/out
docker compose exec app node src/cli.js chart --out /app/out
# 若想在宿主机看到，先加一个挂载：./out:/app/out，然后浏览器打开 out/index.html

# 关注一款游戏，并立刻检查是否到价
docker compose exec app node src/cli.js watch add 1091500 --target 100
docker compose exec app node src/cli.js alerts

# 加一个杉果 SKU 并关联 Steam 游戏
vi data/skus.json        # 宿主机直接改，容器内可见（./data 已挂载）
docker compose run --rm app sync sonkwo --limit 1

# 升级
git pull && docker compose up -d --build

# 停止（保留数据卷）
docker compose down
# 连数据一起删
docker compose down -v
```

日志在宿主机的 `./logs/`，数据卷 `gameprice_pgdata`。

**备份**（方式一）：

```bash
docker compose exec -T db pg_dump -U gameprice gameprice > backup-$(date +%F).sql
```

---

## 故障排查

| 现象 | 先看这里 |
|---|---|
| `app` 一直 unhealthy | `docker compose logs app`；`ping` 只验证数据库，多半是 `DATABASE_URL` 错或库没起 |
| `db.connect_retry` 反复出现 | 方式二时确认宿主到 PG 的 5432 可达、密码正确、`pg_hba.conf` 允许该网段 |
| `net:steam` 失败 | 国内网络访问 `store.steampowered.com` 常态超时；配 `ITAD_API_KEY` 或在能出海的机器上跑 |
| `sync.skip reason=missing_ITAD_API_KEY` | 没配 key，正常跳过；配了仍报就检查 `.env` 是否被 compose 读到（`docker compose config`） |
| 日志里有 `adapter.sonkwo.no_price` | 杉果页面结构可能变了，把该 JSON 日志发我 |
| 时间对不上 / 日期差一天 | 检查 `TZ`；DATE 列已统一按字符串处理，跨时区不会偏移 |

---

## 安全说明

- 容器以 `node` 用户（非 root）运行。
- 日志自动脱敏：`apiKey`/`token`/`cookie` 记作 `***`；`DATABASE_URL` 只保留 host 与库名。
- 不要把 `.env` 提交到仓库（`.dockerignore` 与 `.gitignore` 都已排除）。
