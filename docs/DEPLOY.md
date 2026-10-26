# 部署

两种方式，先说结论：**有现成 PG 就用方式二，没有就用方式一（三条命令，零配置）。**

前置：Docker ≥ 24 与 Docker Compose ≥ 2.20（用到了 `depends_on.required` 字段）。

---

## 方式一：一体化（自带 PostgreSQL 15，零配置）

```bash
git clone <你的仓库> gameprice && cd gameprice
# logs/ out/ 不在仓库里，必须自己建；容器以 uid 1000 运行，目录要归它所有
mkdir -p logs out
sudo chown -R 1000:1000 ./data ./logs
docker compose up -d --build
```

**不需要 `.env`、不需要改密码、不需要先建库建表。** 启动时会自动完成：

| 步骤 | 谁做的 | 说明 |
|---|---|---|
| 建库 | postgres 容器 | `POSTGRES_DB=gameprice` 由官方镜像初始化 |
| 建库兜底 | 应用 `ensureDatabase` | 库不存在就 `CREATE DATABASE`（外部库场景同样生效） |
| 建表 | `bootstrap` → `migrate` | 8 张表 + 1 视图，`create table if not exists`，可重复执行 |
| 平台字典 | `migrate` | steam / sonkwo / itad / gog / humble / steampy |
| 首次导入 | `bootstrap` | 读 `data/games.json`，已导入则跳过（幂等） |
| 定时采集 | `scheduler` | steam 60m、sonkwo 60m、gog/humble 720m、itad 1440m、alerts 360m |

数据库端口**不发布到宿主机**，只在 compose 内网可达；默认 `trust` 认证，所以不需要密码。
想启用密码：设 `POSTGRES_PASSWORD` + `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`，并显式给出
`DATABASE_URL=postgres://user:密码@db:5432/gameprice`，然后 `docker compose up -d`。

起来之后：

```bash
docker compose ps                    # app 应为 healthy
docker compose logs -f app           # 看 bootstrap.done / scheduler.start
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

### 邮箱通道速配

国内常用邮箱都需要先在网页端开启 SMTP 并获取**授权码**（不是登录密码）：

| 服务 | 配置 |
|---|---|
| QQ 邮箱 | `SMTP_HOST=smtp.qq.com` `SMTP_PORT=465` `SMTP_SECURE=1` `SMTP_PASS=`授权码 |
| 163 邮箱 | `SMTP_HOST=smtp.163.com` `SMTP_PORT=465` `SMTP_SECURE=1` `SMTP_PASS=`授权码 |
| 阿里企业邮 | `SMTP_HOST=smtp.qiye.aliyun.com` `SMTP_PORT=465` `SMTP_SECURE=1` |
| Gmail | `SMTP_HOST=smtp.gmail.com` `SMTP_PORT=587` `SMTP_SECURE=0` `SMTP_PASS=`应用专用密码 |
| Outlook | `SMTP_HOST=smtp-mail.outlook.com` `SMTP_PORT=587` `SMTP_SECURE=0` |

配好后先跑 `node src/cli.js notify-test`，看到 `✔ email` 再依赖它。失败时看日志 `notify.email_failed`，里面带 SMTP 返回码（535 = 认证失败，554 = 被当成垃圾邮件拒绝）。

---

## 网络与代理（国内服务器必读）

Steam 官方接口（`store.steampowered.com` / `api.steampowered.com`）在境内通常**直连超时**。
实测症状是 `UND_ERR_CONNECT_TIMEOUT`，重试也无用——这是链路层阻断，不是限流。

三种解法，按推荐顺序：

### 方案 A：只配 ITAD key（最省事，不碰 Steam 网络）

`sync itad` 用 Isthereanydeal 的 API 拿 Steam 各区域价，**完全不需要访问 Steam**。
免费 key 在 <https://isthereanydeal.com/apps/my/> 申请。

```bash
ITAD_API_KEY=你的key
node src/cli.js sync itad
```

代价：ITAD 的价格有延迟（通常小时级），且受其条款约束（不得改造价格、不得去掉联盟参数）。
对"每小时更新一次个人比价"完全够用。**这是国内部署的首选。**

### 方案 B：代理出口（要 Steam 原始数据时）

代码内置按目标主机分流的代理支持，**只让被墙的域名走代理**，境内源（杉果）和可达源（GOG/Humble）
仍然直连——全走代理既慢又浪费流量。

| 变量 | 作用 | 示例 |
|---|---|---|
| `STEAM_PROXY` | **只**作用于 Steam 域名（store/api/community） | `http://127.0.0.1:7890` |
| `HTTPS_PROXY` | 其余所有主机的通用代理 | `http://10.0.0.5:3128` |
| `NO_PROXY` | 排除列表，逗号分隔，支持后缀与 `*` | `sonkwo.hk,sonkwo.cn` |

只支持 http/https 代理（undici 的 `ProxyAgent` 不支持 socks5）。配好后先自检：

```bash
node src/cli.js diagnose
# ✔ proxy:steam      steam-proxy → http://***@127.0.0.1:7890
# ✔ net:steam        HTTP 200 ...
```

日志里每个请求会带 `via=direct|proxy|steam-proxy`，排障时一眼能看出走了哪条路。

> 合规提醒：代理的用途与合法性取决于你的网络环境与当地法规，请自行确认。

### 方案 C：双机分流（自用最稳）

境内机器跑主站 + 杉果采集，境外机器跑 Steam/ITAD 采集，两边共用一个 PostgreSQL：

```
[境外 VPS]  采集 Steam / ITAD ──┐
                                ├─→ PostgreSQL ←─ [境内机器] 站点 / 杉果 / 提醒
[境内机器]  采集杉果 / 通知 ────┘
```

部署要点：

1. 数据库放一侧，另一侧通过 **TLS** 连（`sslmode=require`），别裸奔公网；
2. 两侧跑同一个镜像，只是 `*_ENABLED` 环境变量不同：

```bash
# 境外机器：只采 Steam/ITAD
STEAM_ENABLED=1  ITAD_ENABLED=1  SONKWO_ENABLED=0  GOG_ENABLED=0  DISCOVER_ENABLED=0  ALERTS_ENABLED=0

# 境内机器：采杉果 + 出页面 + 发提醒
STEAM_ENABLED=0  ITAD_ENABLED=0  SONKWO_ENABLED=1  GOG_ENABLED=1  DISCOVER_ENABLED=1  ALERTS_ENABLED=1
```

3. 采集器只写库、站点只读库，两边并发不会互相干扰（这是数据模型一开始就定好的）。

### 元数据怎么办

`import steam` 有双后端：官方不可达时自动回落到 `api.steamcmd.net`（Steam PICS 镜像，
境内可达）。所以**即使不配代理，游戏名字/封面/发行日期也能补全**，只有"价格"需要另想办法。

```bash
node src/cli.js import steam --appids 730,570,1091500
# 元数据来源：steamcmd，取到 3 条
```

### 本地验证代理是否真的生效

仓库自带一个零依赖的最小代理，可用来验证接线（不会解决墙的问题，只证明"请求确实被转发了"）：

```bash
node scripts/local-proxy.js --port 8899
# 另开一个终端
HTTPS_PROXY=http://127.0.0.1:8899 node src/cli.js import steam --appids 1091500
# 代理端会打印：CONNECT api.steamcmd.net:443
```

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
| `POSTGRES_PASSWORD` | 空（不需要） | 仅方式一；启用密码时配合 `POSTGRES_HOST_AUTH_METHOD` |
| `ITAD_API_KEY` | 空 | 空则跳过 itad 源（日志记 `sync.skip`） |
| `STEAM_ENABLED` / `SONKWO_ENABLED` / `ITAD_ENABLED` | `1` | 置 `0` 关闭该源 |
| `STEAM_INTERVAL_MIN` / `SONKWO_INTERVAL_MIN` / `ITAD_INTERVAL_MIN` | 60/60/1440 | 采集间隔（分钟） |
| `DB_WAIT_SEC` | 60 | 启动时最多等数据库多少秒 |
| `SEED_ON_START` | 1 | 首次启动是否导入 `data/games.json` |
| `LOG_LEVEL` | info | trace/debug/info/warn/error |
| `ALERT_WEBHOOK_URL` | 空 | 通用 webhook，POST JSON |
| `WECOM_WEBHOOK_URL` | 空 | 企业微信群机器人地址 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | 空 / 465 / 1 | 邮件通道；587 端口设 `SMTP_SECURE=0` |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 空 | SMTP 认证与发件人 |
| `ALERT_EMAIL_TO` | 空 | 收件人，逗号分隔（不填则不启用邮件） |
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

# 提醒通道自检（配好 SMTP / 企业微信 / webhook 后先跑这个）
docker compose exec app node src/cli.js notify-test

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
