# 部署

先说结论：**普通部署用 Docker Hub（`compose.hub.yaml`，零配置）；有现成 PostgreSQL 用 `compose.hub.external-db.yaml`；要改源码才用 `compose.yaml` 本地构建。**

前置：Docker ≥ 24 与 Docker Compose ≥ 2.20（用到了 `depends_on.required` 字段）。

---

## Docker Hub（推荐，零配置）

镜像：`s1065420329/steamdeals:latest`。完整说明见 **[DOCKER-HUB.md](DOCKER-HUB.md)**。

```bash
# 自带 PostgreSQL，不建 .env、不 chown
docker compose -f compose.hub.yaml up -d

# 用已有 PostgreSQL：先改 compose.hub.external-db.yaml 里的 DATABASE_URL
docker compose -f compose.hub.external-db.yaml up -d
```

**国内用户**：Docker Hub 可能不可达，用腾讯云 TCR 公开镜像：

```bash
docker compose -f compose.cn.yaml up -d
# 或已有 PostgreSQL：先改 compose.cn.external-db.yaml
docker compose -f compose.cn.external-db.yaml up -d
```

镜像由 GitHub Actions 的 `docker-tcr` 工作流推送，需先配置 `TCR_USERNAME` / `TCR_PASSWORD` 并手动运行一次。

打开 `http://服务器IP:8090`，先进入 `/setup`：

1. 创建第一个管理员（密码 ≥ 8 位）
2. 填数据源；国内服务器建议 ITAD API Key 或 Steam 代理
3. 可选填 Webhook / 企业微信 / SMTP

初始化完成前，所有页面 302 到 `/setup`，业务 API 返回 `428`；健康检查只验证数据库，容器不会因未初始化而重启。业务设置写入 PostgreSQL 的 `app_settings` / `smtp_settings`，之后在「控制台 → 系统设置」修改，调度器约 15 秒内热加载。

> 数据库连接串必须在应用启动前存在，不能搬进数据库；但它可以直接写在 `compose.hub.external-db.yaml` 的 `environment.DATABASE_URL` 里（和 `volumes` 一样是 compose 文件内容），不需要 `.env`。首次初始化始终需要口令：建议设置 `SETUP_TOKEN`；未设置时服务会生成一次性口令并显示在启动输出中。

---

## 方式一：一体化（自带 PostgreSQL 15，零配置）

```bash
git clone <你的仓库> steamdeals && cd steamdeals
# logs/ out/ 不在仓库里，必须自己建；容器以 uid 1000 运行，目录要归它所有
mkdir -p logs out
sudo chown -R 1000:1000 ./data ./logs
docker compose up -d --build
```

**不需要 `.env`、不需要改密码、不需要先建库建表。** 启动时会自动完成：

| 步骤 | 谁做的 | 说明 |
|---|---|---|
| 建库 | postgres 容器 | `POSTGRES_DB=steamdeals` 由官方镜像初始化 |
| 建库兜底 | 应用 `ensureDatabase` | 库不存在就 `CREATE DATABASE`（外部库场景同样生效） |
| 建表 | `bootstrap` → `migrate` | 8 张表 + 1 视图，`create table if not exists`，可重复执行 |
| 平台字典 | `migrate` | steam / sonkwo / itad / gog / humble / steampy |
| 首次导入 | `bootstrap` | 读 `data/games.json`，已导入则跳过（幂等） |
| 定时采集 | `scheduler` | Steam 报价默认 1440m、sonkwo 60m、gog/humble 720m、itad 1440m、alerts 360m |

数据库端口**不发布到宿主机**，只在 compose 内网可达；默认 `trust` 认证，所以不需要密码。
想启用密码：设 `POSTGRES_PASSWORD` + `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`，并显式给出
`DATABASE_URL=postgres://user:密码@db:5432/steamdeals`，然后 `docker compose up -d`。

起来之后：

```bash
docker compose ps                    # app 应为 healthy
docker compose logs -f app           # 看 bootstrap.done / scheduler.start
docker compose exec app node src/cli.js stats
docker compose exec app node src/cli.js list
```

完成 `/setup` 后，首轮采集会在三分钟内陆续开始（steam 30s、sonkwo 180s、itad 300s 之后各自触发一次，避免同时打满）。

## 方式二：用你自己的 PostgreSQL

### Docker Hub 镜像（推荐）

直接编辑 [compose.hub.external-db.yaml](../compose.hub.external-db.yaml) 里的这一行（和改 `volumes` 一样）：

```yaml
environment:
  DATABASE_URL: "postgres://steamdeals:密码@10.0.0.5:5432/steamdeals?sslmode=require"
```

然后启动：

```bash
docker compose -f compose.hub.external-db.yaml up -d
```

宿主机上的 PostgreSQL 用 `host.docker.internal`（Linux 已映射到网关）：

```yaml
DATABASE_URL: "postgres://steamdeals:密码@host.docker.internal:5432/steamdeals"
```

已建库的用户需要有建表权限（启动时会 `create table if not exists`）。

如果不想把密码写进受版本控制的文件，可以复制一份本地副本（已 gitignore）：

```bash
cp compose.hub.external-db.yaml compose.hub.external-db.local.yaml
# 改本地副本里的 DATABASE_URL
docker compose -f compose.hub.external-db.local.yaml up -d
```

### 从源码构建

```bash
cp .env.example .env
vi .env       # 只填 DATABASE_URL 和部署参数；业务配置在 /setup 页面
docker compose up -d --build
```

如果 Compose 低于 2.20，`required: false` 会报未知字段：升级 compose，或把 `compose.yaml` 里 `app.depends_on` 整段删掉——app 自带 `DB_WAIT_SEC=60` 的等库重试。

---

### 邮箱通道速配

在 `/setup` 或「控制台 → 系统设置 → 降价提醒」里填 SMTP。国内常用邮箱需要先在网页端开启 SMTP 并获取**授权码**（不是登录密码）：

| 服务 | 主机 | 端口 | 加密 |
|---|---|---|---|
| QQ 邮箱 | `smtp.qq.com` | 465 | SSL |
| 163 邮箱 | `smtp.163.com` | 465 | SSL |
| 阿里企业邮 | `smtp.qiye.aliyun.com` | 465 | SSL |
| Gmail | `smtp.gmail.com` | 587 | STARTTLS（关闭 SSL） |
| Outlook | `smtp-mail.outlook.com` | 587 | STARTTLS（关闭 SSL） |

授权码加密存库，页面不回显。配好后在「邮箱配置」页发测试邮件，或跑 `node src/cli.js notify-test`，看到 `✔ email` 再依赖它。失败时看日志 `notify.email_failed`，里面带 SMTP 返回码（535 = 认证失败，554 = 被当成垃圾邮件拒绝）。

---

## 网络与代理（国内服务器必读）

Steam 官方接口（`store.steampowered.com` / `api.steampowered.com`）在境内通常**直连超时**。
实测症状是 `UND_ERR_CONNECT_TIMEOUT`，重试也无用——这是链路层阻断，不是限流。

三种解法，按推荐顺序：

### 方案 A：只配 ITAD key（最省事，不碰 Steam 网络）

`sync itad` 用 Isthereanydeal 的 API 拿 Steam 各区域价，**完全不需要访问 Steam**。
免费 key 在 <https://isthereanydeal.com/apps/my/> 申请。

推荐直接在「控制台 → 系统设置 → 数据源 → ITAD API Key」填写（加密存库，页面不回显）。旧 `.env` 也兼容：

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

以上三项在「控制台 → 系统设置 → 网络与代理」里填写，旧 `.env` 仍可被首次导入。

只支持 http/https 代理（undici 的 `ProxyAgent` 不支持 socks5）。配好后先自检：

```bash
node src/cli.js diagnose
# ✔ proxy:steam      steam-proxy → http://***@127.0.0.1:7890
# ✔ net:steam        HTTP 200 ...
```

日志里每个请求会带 `via=direct|proxy|steam-proxy`，排障时一眼能看出走了哪条路。

**封面图是另一个域名**：`cdn.cloudflare.steamstatic.com` / `cdn.akamai.steamstatic.com`。
图片**下载一次就落到本机**（`data/images`，宿主机卷），之后前台直接读本地文件，
不再依赖 CDN/代理——代理只用于采集数据。补图有两种方式：

```bash
# 手动批量补图（有价格数据的游戏才会补）
node src/cli.js images pull --limit 400 --sleep 200
node src/cli.js images stats          # 看已缓存张数/覆盖/体积
```

调度器默认每 4 小时自动补 200 款（`IMAGES_ENABLED=0` 可关，`IMAGES_LIMIT/SLEEP_MS` 可调）。

页面"只有名字没有图"时，先看三行图片探测（对应 `/img/steam` 的三条兜底路）：

```bash
node src/cli.js diagnose
# ✔ net:img:cf-proxy   Cloudflare 经 STEAM_PROXY（/img/steam 第一条路）
# ✔ net:img:ak-direct  Akamai 直连
# ✔ net:img:cf-direct  Cloudflare 强制直连
```

三行全红且本地也没缓存，说明服务器到 Steam CDN 的路都不通：给代理放行 `cdn.cloudflare.steamstatic.com`
与 `cdn.akamai.steamstatic.com`（自建代理常常只白名单了 api/store/community，图片域名会被拒）。
`/img/steam` 本身已按「内存热缓存 → 本地文件 → Cloudflare 代理 → Akamai 直连 → Cloudflare 直连」自动兜底。

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

### 部署参数（仍用环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 自带 db / 嵌入式 PG | 外部 PostgreSQL 连接串；可写在 compose 命令里 |
| `POSTGRES_PASSWORD` / `POSTGRES_HOST_AUTH_METHOD` | 空 / `trust` | 仅自带 db 的可选加固 |
| `WEB_PORT` | `8090` | 宿主机端口（容器内固定 8080） |
| `TZ` | Asia/Shanghai | 影响日志与 `current_date` |
| `SETUP_TOKEN` | 自动生成 | 初始化口令；未设置时每次未完成初始化的启动都会生成新口令 |
| `SECRET_KEY` | 自动生成 | 不设则用 `data/secret.key` |
| `DB_WAIT_SEC` | 60 | 启动时最多等数据库多少秒 |
| `SEED_ON_START` | 1 | 首次启动是否导入 `data/games.json` |
| `RUN_MODE` | scheduler | `scheduler` 常驻；`once` 只 bootstrap 后退出；compose 用 `all` |
| `LOG_DIR` / `OUT_DIR` | `logs` / `out` | 日志与静态页目录 |
| `IMG_DIR` | `data/images` | 封面图缓存目录 |

### 业务设置

50 项业务配置落库，不再需要 `.env`；Steam 价格默认每天刷新，可在系统设置中调整间隔：

- 首次启动：`/setup`
- 之后：控制台「系统设置」
- 保存后调度器约 15 秒内热加载
- 密钥（ITAD/Steam Key、SMTP 授权码、Webhook、代理）AES-256-GCM 加密；页面只显示「已配置」

完整定义在 `src/settings.js` 的 `SETTINGS` 数组，页面会按分组自动渲染。

### 旧环境变量迁移

老部署升级时，如果库里已经有管理员：

1. 启动时自动把当前 `.env` 里的旧业务变量导入 `app_settings`（只填空缺，不覆盖已有库值）
2. 写入 `setup.completed_at`，不会把老用户拦到 `/setup`
3. 之后优先级：数据库 > 环境变量 > 默认值

可迁移的旧变量：`ITAD_API_KEY`、`STEAM_API_KEY`、`*_ENABLED`、`*_INTERVAL_MIN`、`*_INITIAL_DELAY_SEC`、`GOG_REGIONS`、`ALERT_*`、`WECOM_WEBHOOK_URL`、`SMTP_*`、`CIRCUIT_*`、`CHART_ON_SYNC`、`BACKUP_*`、`LOGS_PRUNE_*`、`IMAGES_*`、`STEAM_PROXY` / `HTTPS_PROXY` / `NO_PROXY`、`LOG_LEVEL`。确认页面配置正确后，可以把它们从 `.env` 删掉。

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

日志在宿主机的 `./logs/`，数据卷 `steamdeals_pgdata`。

**备份**（方式一）：

```bash
docker compose exec -T db pg_dump -U steamdeals steamdeals > backup-$(date +%F).sql
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
