# gameprice

**中文游戏的价格履历。**

把 Steam 国区、杉果、以及 IsThereAnyDeal 聚合的海外授权店放在同一张表里比价，并把每一次价格变动都存下来，形成可以回看的曲线。

![node](https://img.shields.io/badge/node-%E2%89%A522.5-3c873a)
![postgresql](https://img.shields.io/badge/PostgreSQL-15-336791)
![docker](https://img.shields.io/badge/docker-compose-2496ed)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 目录

- [现在的真实状态](#现在的真实状态)
- [它解决什么](#它解决什么)
- [它明确不做什么](#它明确不做什么)
- [功能](#功能)
- [设计原则](#设计原则)
- [架构](#架构)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [配置](#配置)
- [数据模型](#数据模型)
- [数据源](#数据源)
- [日志与排障](#日志与排障)
- [测试](#测试)
- [已知限制](#已知限制)
- [路线图](#路线图)
- [项目结构](#项目结构)
- [许可与免责](#许可与免责)

---

## 现在的真实状态

一句话：**开箱即用的有杉果和 GOG；Steam 需要出口、ITAD 需要 key、Humble 命中率有限。**

| 能力 | 状态 | 依据 |
|---|---|---|
| 杉果价格采集 | ✅ 已跑通 | 真实页面端到端验证：解析 ¥198 → 入库 → 写快照 |
| **杉果 SKU 自动发现** | ✅ 已跑通 | 实测扫 120 个 id 命中 46 个商品、新增 45 条，连续空壳自动停 |
| **GOG 价格采集** | ✅ 已跑通 | catalog 接口真实运行：24 款匹配 8 款，中文名合并正确 |
| **Humble 价格采集** | ⚠️ 可用但命中率受限 | 按 slug 探测 + JSON-LD 校验；没探测到的游戏会静默跳过 |
| 价格历史 / 史低判断 | ✅ 已跑通 | 96 项测试，含真 PG 语义（PGlite）验证 |
| **价格曲线网页** | ✅ 已跑通 | `node src/cli.js chart` 生成静态页，内联 SVG，浏览器直接打开 |
| 只收官方渠道的结构约束 | ✅ 已生效 | 视图 + 查询层双重过滤 + 回归断言 |
| 定时采集调度 | ✅ 已跑通 | 子进程隔离实测：真实任务完成、单任务失败不影响调度器 |
| 结构化日志 / 自检 | ✅ 已跑通 | `diagnose` 输出 11 项检查并落盘 |
| **关注与降价提醒** | ✅ 已跑通 | `watch` 加关注、`alerts` 判定到价；同价位不重复打扰 |
| **提醒通道** | ✅ 已跑通 | 通用 webhook / 企业微信机器人 / 邮件（自实现 SMTP），对着本地假服务器逐行验证 |
| **采集熔断** | ✅ 已跑通 | 连续失败 3 次暂停 6 小时，实测 `circuit_tripped` → `circuit_skip` |
| Steam 国区采集 | ⚠️ 代码完成，**本机网络不可达** | `store.steampowered.com` 连接超时（12s），需出口 |
| ITAD 官方 API | ⚠️ 代码完成，**未用真 key 验证** | 无 key 时返回 403；响应结构按官方文档实现 |
| Docker 部署 | ⚠️ 文件齐备，**镜像未真实构建过** | 开发机无 Docker；已用 `npm ci --omit=dev` + 容器启动路径等价验证 |
| **一键部署（自动建库/建表/导入）** | ✅ 已验证 | `ensureDatabase` 在真 PG 协议下建库成功；`bootstrap` 幂等建表与导入 |
| Fanatical | ⏸ 不接入 | 商品页是 SPA 且 Algolia key 被 Cloudflare 403，无可靠取数路径 |
| 多区服对比 | 🚧 未实现 | `region` 维度已在数据模型里 |
| 小黑盒商城 | ⏸ 评估后暂缓 | 无公开接口，需逆向 `hkey` 签名 |
| SteamPy | ⏸ 不接入 | 商品接口全部要求登录态（401），且是 C2C |

> 这张表随代码更新。**任何标 ✅ 的能力都必须能被测试或一次真实运行验证**；做不到就写 ⚠️。

## 它解决什么

买一款游戏时，实际要回答三个问题：

1. **同一款游戏，各渠道现在差多少？** Steam 国区、杉果、Fanatical、Humble、GOG 的价格经常差 20–40%，但没有任何一个中文站点把它们横向摆在一起。
2. **现在是不是历史低点？** 商店页面只显示"当前 -50%"，不显示"这游戏史低是 -75%"。没有价格历史，就无法判断该不该等。
3. **这个价格到底可不可信？** 搜索到的"3 元买《赛博朋克》"，大概率是共享账号或黑 key，不是游戏。

这个项目就是为这三个问题写的：**官方渠道横向比价 + 长期价格曲线 + 明确的来源边界**。

## 它明确不做什么

划清边界比堆功能重要，下面这些是**有意不做**的：

| 不做 | 原因 |
|---|---|
| **全网最低价（C2C）** | SteamPy、淘宝卖家、共享账号的"最低价"结构性上由灰产定价。把它们和正版渠道排在一起，等于给假货做免费广告，并且会把用户投诉引到自己身上。 |
| **站内下单 / 代购** | 代收货款属于二清，且平台没有面向第三方的下单接口。跳转购买已经满足需求，也避免了支付牌照、发票、售后赔付这一整套责任。 |
| **"保证是正品"的承诺** | 没有任何算法能在成交前证明一个 key 的真伪。本项目只承诺"来源可信 + 可追溯"，不承诺"我保证是正品"。 |
| **SteamPy 接入** | 全部商品接口要求登录态（`code:401`），且是 C2C 性质。用个人账号跑自动化有封号风险，收益不足以抵消。 |

## 功能

状态含义：**✅ 已验证** / **⚠️ 已实现但受限或未验证** / **🚧 未实现** / **⏸ 评估后暂缓**

| 功能 | 状态 | 说明 |
|---|---|---|
| Steam 国区采集 | ⚠️ | 官方 `appdetails`，批量 + 限速；单测覆盖解析，真实网络被阻断 |
| 杉果采集 | ✅ | 商品页内嵌 JSON 解析，不依赖 DOM 选择器；真实页面验证 |
| 杉果 SKU 自动发现 | ✅ | 按 id 从前沿向后探测，连续空壳即停；发现的 SKU 自动并入 `data/skus.json` |
| ITAD 官方 API | ⚠️ | 按商店拆成独立平台，需自备免费 key；未用真 key 跑过 |
| 价格历史与史低 | ✅ | 变化才写快照，按天聚合，终端画轨迹 |
| 官方渠道结构约束 | ✅ | `v_lowest_official` 视图 + 查询层过滤 + 回归断言 |
| 定时采集 | ✅ | 每平台独立子进程，默认每小时 / 每天 |
| 结构化日志 | ✅ | JSONL + `runId` 串联 + 密钥脱敏 + 轮转 |
| 自检 `diagnose` | ✅ | 环境 / 数据库 / 网络逐项检查，报告落盘 |
| 凭据扫描 | ✅ | `npm run scan`，公开仓库前自检 |
| Docker 部署 | ⚠️ | 非 root / tini / healthcheck 已写；镜像未构建验证 |
| 价格曲线网页 | ✅ | 静态 HTML + 内联 SVG，无外部依赖，浏览器直接打开 |
| 关注列表与降价提醒 | ✅ | 目标价 / 史低两种触发，同价位去重 |
| 提醒通道 | ✅ | webhook / 企业微信机器人 / 邮件（SMTP，支持 STARTTLS 与 AUTH PLAIN/LOGIN） |
| 采集熔断 | ✅ | 连续失败自动暂停，避免持续撞墙 |
| GOG 采集 | ✅ | 官方 catalog 接口，CNY 价格，只接受精确标题匹配 |
| Humble 采集 | ⚠️ | slug 探测 + JSON-LD，名称必须完全一致；探测不到就跳过 |
| Fanatical | ⏸ | SPA + Algolia key 被 Cloudflare 拦，没有可靠路径 |
| 多区服对比 | 🚧 | 模型已支持，未做展示 |

## 设计原则

**1. 只比官方渠道价，并且让这是结构约束而不是一句口号**

`platforms.kind` 只允许 `official` / `authorized_reseller` / `c2c` 三种值，主榜由视图 `v_lowest_official` 过滤。这意味着：

- 即使采集层以后误收了 C2C 报价，它也进不了主榜；
- 想放进去，必须改视图——一个能被 code review 看到的地方。

这个约束不是多余的谨慎。开发过程中真出现过一次泄漏：主榜视图挡住了 `offers`，但"史低"走的 `daily_prices` 聚合是**第二条路径**，把 C2C 的 3 元算成了史低。现在查询层所有面向主榜的 SQL 都强制 join `platforms.kind`，并有回归断言守着。

**2. "真实"只承诺到"来源可信 + 可追溯"**

每条报价都记录平台、区服、渠道类型、抓取时间与来源 URL。用户能看到这条价格是哪来的、什么时候抓的，而不是一个无法验证的数字。

**3. 历史从第一天开始存**

`price_snapshots` 只追加、价格没变就不写；`daily_prices` 按天聚合。晚一天开始，那天的价格就永远补不回来——这是这个项目里唯一"过期不候"的东西。

## 架构

```
                        ┌──────────────────────────────────────────┐
                        │  src/adapters/    每平台一个，统一吐 RawOffer │
                        │  ├ steam.js   官方 appdetails（批量+限速）  │
                        │  ├ sonkwo.js  商品页 → 内嵌 JSON → 报价     │
                        │  └ itad.js    官方 REST API（按商店拆分）    │
                        └──────────────────┬───────────────────────┘
                                           │  RawOffer
                                           ▼
                        ┌──────────────────────────────────────────┐
                        │  src/ingest.js                           │
                        │  指纹判重 → 当前报价 upsert                │
                        │           → 有变化才写快照                 │
                        │           → 按天聚合                       │
                        └──────────────────┬───────────────────────┘
                                           ▼
                        ┌──────────────────────────────────────────┐
                        │  src/store/     PostgreSQL 15            │
                        │  pg.js  全部 SQL 集中在这一个文件            │
                        │  index.js  连接池 + 查询日志 + 慢查询告警     │
                        └──────────────────┬───────────────────────┘
                                           ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  src/cli.js       同步 / 主榜 / 轨迹 / 日志 / 自检                    │
   │  src/scheduler.js 常驻调度：每任务独立子进程，崩了不带垮调度器            │
   │  src/log.js       JSONL + runId + 脱敏 + 轮转                       │
   └───────────────────────────────────────────────────────────────────┘
```

一次 `sync` 的完整时序：

```
cli.js 生成 runId
  └→ adapter 分批请求（每批记 http.request / http.response）
       └→ 解析成 RawOffer（解析过程的中间量记 adapter.* 事件）
            └→ ingest：每个 offer 一个 upsert 事务单元
                 ├→ 价格没变：只更新 last_seen_at（unchanged+1）
                 └→ 价格变了：写 price_snapshots（snapshots+1）+ 记 ingest.price_changed
                      └→ 更新 daily_prices（取当天最低）
                           └→ 汇总 ingest.summary → sync.done → fetch_runs 落健康度
```

设计取舍写在 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，包括为什么不做长事务、为什么子进程隔离、怎么加一个新平台。

## 快速开始

### 方式一：Docker（零配置）

```bash
docker compose up -d --build
docker compose ps             # app 应为 healthy
docker compose logs -f app    # 看到 bootstrap.done 即启动成功
```

**不需要先建库、建表、改密码、填 .env。** 起来之后这条链是全自动的：

```
postgres 容器创建库 gameprice
  → app 启动：ensureDatabase（库不在就 CREATE DATABASE）
  → bootstrap：建表 + 平台字典 + 首次导入 data/games.json（幂等）
  → 调度器：按间隔采集
```

内置 `postgres:15-alpine` 用 trust 认证且端口不发布到宿主机，只在 compose 内网可达；需要密码见 [DEPLOY.md](docs/DEPLOY.md)。

用你已有的 PostgreSQL：清空 `COMPOSE_PROFILES` 并填 `DATABASE_URL`，详见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

> 镜像本身尚未在真实 Docker 环境验证过（开发机无 Docker）。首次部署请按 [DEPLOY.md 的故障排查表](docs/DEPLOY.md#故障排查) 对照日志。

### 方式二：本地运行（推荐先这样验证）

要求 **Node ≥ 22.5**、**PostgreSQL ≥ 15**（开发机上实测 15.17）。

```bash
npm install
export DATABASE_URL='postgres://user:pass@host:5432/gameprice'
node src/cli.js init          # 建表 + 平台字典（幂等）
node src/cli.js seed          # 导入 data/games.json
node src/cli.js diagnose      # 环境 / 数据库 / 网络自检
```

没有 PG 服务器也能跑起来（内置 wasm 版 PostgreSQL，仅用于验证逻辑）：

```bash
node src/cli.js init --db pglite:./data/pgdata
node src/cli.js seed --db pglite:./data/pgdata
```

### 确认安装正常

```bash
node src/cli.js ping                      # 只验证数据库，静默退出 0
node src/cli.js sync sonkwo --limit 1     # 唯一开箱即用的源，真实抓一次
node src/cli.js list                      # 应能看到价格与史低标记
node src/cli.js chart                     # 生成静态价格页到 out/
```

`chart` 之后直接用浏览器打开 `out/index.html`（Windows 可以 `start out\index.html`）。页面是纯静态的：内联 SVG 曲线、无外部 JS/CSS、离线可看。

想先看效果而不采集数据：

```bash
node scripts/demo-seed.js                                    # 造 3 款游戏、90 天演示数据
node src/cli.js chart --db pglite:./data/demo-pgdata --out out
```

## 命令参考

**日常**

| 命令 | 说明 |
|---|---|
| `list` | 主榜：各游戏官方渠道最低价 + 是否史低 |
| `chart` | 生成静态价格页（曲线图）到 `out/`（`--out`、`--days 90`、`--limit 200`） |
| `watch add\|rm\|list` | 关注列表：`watch add 1091500 --target 99`（不带 target = 跌到史低才提醒） |
| `alerts` | 检查到价（`--mark` 记录已通知、`--json` 机器可读、`--webhook URL` 临时投递） |
| `notify-test` | 给所有已配置的提醒通道发一条测试消息（部署自检） |
| `history <appid>` | 终端画价格轨迹 + 史低判断（`--days 90`） |
| `stats` | 数据量 + 最近 5 次采集健康度 |

**采集**

| 命令 | 说明 |
|---|---|
| `sync steam` | Steam 国区价格（`--limit 500`）⚠️ 需能访问 Steam |
| `sync sonkwo` | 按 `data/skus.json` 抓杉果（`--limit`、`--rate 1200`）✅ |
| `discover sonkwo` | 自动发现新 SKU（`--ahead`、`--max-misses`、`--from/--to`）✅ |
| `sync itad` | ITAD 官方 API（`ITAD_API_KEY` 未配置则跳过）⚠️ 未验证 |
| `sync gog` | 按英文名查 GOG（catalog 接口，只接受精确标题）✅ 已跑通 |
| `sync humble` | 按英文名探测 Humble 商品页（JSON-LD）⚠️ 命中率取决于 slug |
| `add-sku <id...>` | 往 `data/skus.json` 加 SKU，`--appid 123` 关联 Steam 游戏 |

**运维与排障**

| 命令 | 说明 |
|---|---|
| `init` | 建表 + 平台字典，可重复执行 |
| `bootstrap` | 建表 + 首次自动导入（容器启动用） |
| `ping` | 健康检查，数据库可用则静默退出 0 |
| `seed` | 从 `data/games.json` 导入游戏 |
| `logs` | 查日志（`--level` `--event` `--run` `--since`） |
| `diagnose` | 环境/数据库/网络自检，报告落盘 `logs/diagnose-*.json` |
| `probe` | 目标可达性探针，见下 |

通用参数：`--db <target>`（`postgres://…` 或 `pglite:./path`）、`--level`、`--log-dir`、`--wait-db <秒>`。

探针用于接入新平台前的可达性判断，不写库、不依赖 DATABASE_URL：

```bash
node src/probe.js --url-file scripts/probe-targets.txt --rounds 1
node src/probe.js --target steam --rounds 24 --interval 3600   # 跑 24 小时看稳定性
```

输出每轮的状态码、延迟、响应体大小，最后给成功率与 p50/p95；出现 403/429 会提示风控。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 无（自动降级） | 不配时用内置嵌入式 PG（`data/pgdata`）；配了 `postgres://` 会自动建库 |
| `POSTGRES_HOST_AUTH_METHOD` | `trust` | 仅容器内置库使用；改密码时同时设它与 `DATABASE_URL` |
| `ITAD_API_KEY` | 空 | 空则跳过 itad 源（日志记 `sync.skip`） |
| `ALERT_WEBHOOK_URL` | 空 | 通用 webhook；空则不发这条通道 |
| `WECOM_WEBHOOK_URL` | 空 | 企业微信群机器人地址（`errcode=0` 才算成功） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | 空 / 465 / 1 | 邮件通道；587 端口请设 `SMTP_SECURE=0` 走 STARTTLS |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 空 | SMTP 认证与发件人 |
| `ALERT_EMAIL_TO` | 空 | 收件人，逗号分隔；**不填则邮件通道不启用** |
| `ALERTS_ENABLED` / `ALERTS_INTERVAL_MIN` | `1` / `360` | 提醒检查开关与间隔 |
| `CIRCUIT_THRESHOLD` / `CIRCUIT_COOLDOWN_MIN` | `3` / `360` | 连续失败 N 次后暂停多久 |
| `GOG_ENABLED` / `GOG_INTERVAL_MIN` | `1` / `720` | GOG 采集开关与间隔 |
| `HUMBLE_ENABLED` / `HUMBLE_INTERVAL_MIN` | `1` / `720` | Humble 采集开关与间隔 |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | `logs` | 日志目录 |
| `DB_WAIT_SEC` | `0`（容器内 60） | 启动时最多等数据库多少秒 |
| `SEED_ON_START` | `1` | 首次启动是否自动导入游戏 |
| `TZ` | `Asia/Shanghai` | 影响日志时间与 `current_date` |

容器专属（见 [compose.yaml](compose.yaml)）：`POSTGRES_PASSWORD`、`RUN_MODE`、`*_ENABLED`、`*_INTERVAL_MIN`。

## 数据模型

```
games              游戏身份，以 steam_appid 为锚点
game_aliases       平台商品 → 游戏 的映射（跨平台对齐的落点，保留匹配方式与置信度）
offers             当前报价：game × platform × 渠道类型 × 区服 唯一
price_snapshots    历史快照，只追加；raw_hash 相同不写
daily_prices       按天最低价聚合，画曲线只读这张
fetch_runs         每次采集的成功/失败/跳过，先看这里再怀疑代码
platforms          平台字典（official / authorized_reseller / c2c）
watchlist          关注列表：目标价 / 上次通知价（同价位不重复打扰）
v_lowest_official  主榜视图：只统计官方渠道的最低到手价
```

> 目前**共 8 张表 + 1 个视图**。`platforms` 里预置了 `itad` / `fanatical` / `humble` / `gog` / `steampy` 的 code，但**只有 `steam` / `sonkwo` / `itad` 有适配器**——预留 code 不等于已支持，见[数据源](#数据源)。

三个关键设计：

- **区服是独立维度。** 国区 298、全球 60 美元、土区 30 里拉不是"同一个东西的不同价格"，混着比就是错的。
- **`offers` 与 `price_snapshots` 分离。** 前者是"现在多少钱"（高频查），后者是"曾经多少钱"（只追加）。画图只读 `daily_prices`，永远不扫快照全表。
- **`DATE` 列按字符串处理。** `pg` 默认把 `date` 解析成带时区的 `Date`，跨时区会差一天，日聚合和史低判断全错。存储层显式注册了 identity parser，SQL 里也统一 `::text`。

完整 DDL 在 [src/store/pg.js](src/store/pg.js)。

## 数据源

| 来源 | 方式 | 状态 |
|---|---|---|
| 杉果 | 商品页内嵌 `__remixContext` JSON | ✅ 可用；SKU 靠 `discover` 按 id 增量发现 |
| GOG | 官方 catalog JSON（`catalog.gog.com`） | ✅ 可用，按英文名精确匹配 |
| Humble | 商品页 JSON-LD `offers.price` | ⚠️ 可用但命中率取决于 slug 命名 |
| Steam | 官方 `appdetails` | ⚠️ 代码完成，国内网络直连不可达 |
| IsThereAnyDeal | 官方 REST API | ⚠️ 需免费 key，结构未真实验证 |
| Fanatical | SPA + Algolia 代理 | ⏸ 商品页无价格、key 接口 403，不接入 |
| 小黑盒 | SPA + `hkey` 签名 | ⏸ 暂缓 |
| SteamPy | 需登录态（401） | ⏸ 不接入 |

可达性实测、接口细节、复现命令都记在 **[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)**。那份文档记录了每个源"怎么探出来的"，包括失败的尝试——避免下次重新踩。

**合规说明**：本项目仅个人自用，低频访问、遵守目标站 `robots.txt`（杉果未禁止抓取）、不绕过登录与签名校验、不转售数据。使用 ITAD API 遵守其条款（可个人免费使用，不得改价或去除联盟参数）。

## 日志与排障

日志是这个项目的一等公民——远程排障只靠它。

```
logs/app-YYYY-MM-DD.jsonl      全量（info 及以上）
logs/error-YYYY-MM-DD.jsonl    只含 error/fatal，快速看错误流
logs/diagnose-*.json           自检报告
```

每条记录都带 `ts` / `level` / `event` / `runId` / `pid`。事件名是 `域.动作`，一次命令的所有事件用 `runId` 串起来。

| 事件 | 什么时候出现 | 排障用途 |
|---|---|---|
| `http.request` / `http.response` | 每次外部请求 | 只有 request 没有 response = 卡在网络上 |
| `http.error` / `http.retry` | 单次失败 / 重试 | `code=UND_ERR_CONNECT_TIMEOUT` 是被阻断；`status=429` 是限流 |
| `http.parse_error` | 响应不是 JSON | 带 `bodySnippet`，多半是拿到 HTML 错误页 |
| `db.query_failed` | SQL 报错 | 带 SQL 片段与错误码（如 `23505` 唯一键冲突） |
| `adapter.sonkwo.sku_candidates` | 解析商品页 | `count=0` 说明页面结构变了 |
| `ingest.price_changed` | 价格真的变了 | 带前后 hash 与价格 |
| `ingest.summary` / `sync.done` | 每轮结束 | 一眼看 inserted/updated/snapshots/unchanged |
| `scheduler.job_*` | 调度器派发任务 | 子进程退出码与耗时 |

```bash
node src/cli.js logs --level error --limit 20
node src/cli.js logs --event http --since 30        # 最近 30 分钟
node src/cli.js logs --run run-20261026025454-nu81  # 单次命令全轨迹
```

**线上出问题，发这三样就够定位**：`logs/error-*.jsonl`、对应 `runId` 的 `logs/app-*.jsonl`、`logs/diagnose-*.json`。

日志自动脱敏：`apiKey` / `token` / `cookie` 打成 `***`；连接串只抹密码、保留 host 与库名（排障需要）。按 8MB 轮转、保留 10 份。

## 测试

```bash
node test/log.test.js        # 7 项：JSONL 格式、脱敏、轮转读取、过滤
node test/adapters.test.js   # 5 项：Steam 接口构造与解析
node test/sonkwo.test.js     # 7 项：对着真实页面快照解析（含"别取错版本价"）
node test/gog.test.js        # 9 项：标题归一化、精确匹配、拒绝模糊结果、折扣计算
node test/humble.test.js     # 9 项：slug 生成、JSON-LD 解析、名称校验、重定向与 404
node test/discover.test.js   # 9 项：扫描区间、连续空壳停止、404 容错、合并去重
node test/store.test.js      # 10 项：URL 解析、建库 SQL、真 TCP PG 协议下自动建库
node test/pg.test.js         # 8 项：真 PG 语义（PGlite）跑建表/入库/去重/主榜/史低
node test/report.test.js     # 9 项：SVG 图表、转义、空数据、静态站点端到端
node test/alerts.test.js     # 8 项：到价判定、同价位去重、简报、webhook 失败不抛
node test/notify.test.js     # 10 项：通道发现、MIME 编码、假 SMTP 协议对话、企业微信 errcode
node test/watchlist.test.js  # 5 项：关注表 CRUD、候选查询、标记后不再提醒、级联删除
node test/scheduler.test.js  # 11 项：调度时刻表、首轮错开、参数透传、熔断
node test/deploy.test.js     # 8 项：compose/Dockerfile/入口脚本一致性、CRLF 检查
node test/docs.test.js       # 5 项：相对链接有效性、入口文档齐全、README 必备章节、CHANGELOG 格式、许可一致
node test/secrets.test.js    # 5 项：凭据扫描器自身的正确性 + 当前仓库无泄漏
```

共 **128 项**断言。杉果解析器直接用真实页面快照做夹具，页面结构变化会立刻让测试变红。

发布前额外跑一次凭据扫描（`npm run scan`）：检查 token、私钥、带真实密码的连接串，文档里的示例和占位符不会误报。

## 已知限制

1. **Steam 官方接口在国内网络不可达**（实测 `UND_ERR_CONNECT_TIMEOUT`，12 秒超时）。代码完整、单测覆盖，但没有在真实网络跑通过。需要给采集机配出口，或改用 ITAD 的 Steam 价。
2. **ITAD 响应结构未用真 key 验证**。无 key 时返回 `403 Invalid or expired api key`；结构不符时会记 `adapter.itad.shape_mismatch` 并带原始片段。
3. **Docker 镜像未真实构建过**。Dockerfile / compose / 入口脚本已用等价方式验证（干净目录 `npm ci --omit=dev` + 执行容器启动路径），但 `docker build` 本身没跑过。
4. **杉果没有搜索接口**（`store/search` 的 loader 服务端报错、`/api/*` 返回 410），所以 SKU 靠「按 id 探测」发现：id 连续、密度约 70%，未上架的 id 返回 200 空壳页。`discover` 只能跟上前沿，**历史目录要靠一次性回填**（`--from/--to` 指定区间）；空壳页的判定依赖"无价格 + 13KB 通用页"，站点改版需要复核。
5. **杉果商品页里没有 Steam appid**，跨平台对齐只能靠名称匹配。`add-sku --appid` 显式关联最可靠；未关联的会计入 `ingest.summary.noAppId`。
5. **GOG 的搜索是模糊的**：`like:` 查询对"这家店没有的游戏"会返回无关热门商品（搜 `elden ring` 会返回 Whispers in the Moss）。适配器只接受标题完全相等的结果，所以宁可没有价格，也不会把别人的价格挂上去。
6. **Humble 命中率有限**：只能用"按英文名猜 slug → 抓商品页 → 校验名称"的方式，实测 8 个里命中 4 个；没命中的会静默跳过（日志记 `adapter.humble.no_match`）。
7. **没有 Web 服务**。`chart` 生成的是静态文件，没有交互、没有 API、没有部署好的在线站点；要实时视图需要自己起个静态服务器。
8. **邮件客户端是自实现的**，只覆盖 STARTTLS + AUTH PLAIN/LOGIN，不支持 OAuth2 与附件；协议对话已在本地假 SMTP 服务器上验证，但**未对真实邮件服务商做过端到端测试**。

## 路线图

- [ ] 名称模糊匹配 + 人工确认工作流（降低 `noAppId`）
- [ ] 多区服对比（国区 / 全球 / 低价区）
- [ ] 曲线页接入 `chart` 的定时重建（采集完成后自动刷新）
- [ ] 杉果历史 SKU 回填（`discover --from/--to` 的批量模式）

## 项目结构

```
gameprice/
├── src/
│   ├── adapters/        平台适配器（steam / sonkwo / itad / gog / humble）
│   │   └── sonkwo-discover.js  杉果 SKU 增量发现（按 id 探测）
│   ├── store/           PG 存储层（SQL 与连接池）
│   ├── cli.js           命令行入口
│   ├── scheduler.js     常驻调度（子进程隔离）
│   ├── ingest.js        入库：判重 / 快照 / 日聚合
│   ├── report.js        静态价格页：内联 SVG 图表 + 纯函数渲染
│   ├── alerts.js        降价提醒：判定 / 简报 / webhook 投递
│   ├── log.js           结构化日志
│   ├── http.js          唯一出网点（超时/重试/脱敏/观测）
│   └── probe.js         目标可达性探针
├── test/                53 项断言 + 真实页面夹具
├── data/                games.json（游戏清单）、skus.json（杉果 SKU）
├── docs/                ARCHITECTURE / DATA-SOURCES / DEPLOY
├── out/                 由 chart 生成的静态页（已 gitignore）
├── scripts/             勘查工具（inspect / mine-bundle / hit）+ 凭据扫描 + 容器入口
├── Dockerfile
├── compose.yaml
└── .env.example
```

## 贡献

这是个人项目，但改动请遵守两条硬规则：

1. **任何改动都要有可执行的验证**（`node test/*.test.js` 必须全绿）。
2. **改采集逻辑必须写日志**：新的事件用 `域.动作` 命名，失败路径必须带上可判断原因的信息。

细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可与免责

代码以 [MIT](LICENSE) 协议开源。

价格数据版权归各平台所有，本项目不转售、不重新分发数据。采集为低频个人使用，如相关平台认为不妥，删除对应适配器即可（各平台彼此独立，见 `src/adapters/`）。

本项目不对任何交易的最终结果负责：价格可能延迟、商品可能下架、第三方 key 存在来源风险。**购买前请自行核实。**
