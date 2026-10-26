# gameprice — 国区官方渠道游戏比价 + 价格历史

个人自用。**只收录官方 / 授权分销渠道**，C2C（SteamPy、淘宝卖家、共享账号）不参与主榜——这是数据模型里的结构约束（`v_lowest_official` 视图 + 查询层双重过滤），不是靠代码里记得加 `if`。

## 三条设计约束

1. **主榜只比官方渠道价**：C2C 最低价结构性上由灰产定价，混进来等于给假货做广告。
2. **"真实"只承诺到"来源可信 + 可追溯"**：不承诺某个 key 一定是正品。
3. **历史从第一天开始存**：`price_snapshots` 只追加、价格没变就不写；`daily_prices` 按天聚合给画图用。

## 架构

```
adapters/            每个平台一个适配器，统一吐 RawOffer
  steam.js           Steam 官方 appdetails（批量 + 限速）
  sonkwo.js          杉果商品页（Remix 预渲染，解析内嵌 JSON）
  itad.js            IsThereAnyDeal 官方 API（覆盖 40+ 海外店）
        ↓
ingest.js            指纹判重 → 当前报价 upsert → 变化才写快照 → 日聚合
        ↓
store/pg.js          PostgreSQL 15 存储层（SQL 全部集中在这里）
        ↓
cli.js               命令行：同步 / 主榜 / 轨迹 / 日志 / 自检
```

数据源可达性、接口细节、复现命令见 **[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)**。当前实测：杉果 ✅、Fanatical/Humble/GOG ✅、ITAD 需 key、**Steam 官方接口在国内网络不可达**、SteamPy 是登录墙。

## Docker 一键部署

```bash
cp .env.example .env      # 改掉 POSTGRES_PASSWORD
docker compose up -d --build
docker compose ps         # app 应为 healthy
docker compose logs -f app
```

默认自带 `postgres:15-alpine`，`app` 启动后先 `bootstrap`（建表 + 首次导入游戏）再进常驻调度器，按间隔自动采集。用你现有的 PG 只需清空 `COMPOSE_PROFILES` 并填 `DATABASE_URL`，详见 **[docs/DEPLOY.md](docs/DEPLOY.md)**（含运维命令、备份、故障排查表）。

镜像特征：非 root 运行、`tini` 转发信号、`npm ci --omit=dev`、healthcheck 走 `node src/cli.js ping`。

## 初始化（不用 Docker 时）

要求 Node ≥ 22.5、PostgreSQL ≥ 15（实测 15.17）。

```bash
npm install                       # 装 pg（PGlite 是测试用的嵌入式 PG）
export DATABASE_URL='postgres://user:pass@host:5432/gameprice'
node src/cli.js init              # 建表 + 平台字典（幂等）
node src/cli.js seed              # 从 data/games.json 导入游戏
node src/cli.js diagnose          # 环境/数据库/网络自检
```

没有 PG 服务器也能跑（本地嵌入式 PG，用于验证逻辑）：

```bash
node src/cli.js init --db pglite:./data/pgdata
```

## 命令

| 命令 | 说明 |
|---|---|
| `init` | 建表 + 平台字典，可重复执行 |
| `bootstrap` | 建表 + 首次自动导入游戏（容器启动用，幂等） |
| `ping` | 健康检查：数据库可用则静默退出 0 |
| `seed` | 导入 `data/games.json`（`{appid, name}`） |
| `add-sku <id...>` | 往 `data/skus.json` 加杉果 SKU，`--appid 123` 可关联 Steam 游戏 |
| `sync steam` | 拉 Steam 国区价格（`--limit 500`） |
| `sync sonkwo` | 按 `data/skus.json` 逐个抓杉果（`--limit` `--rate 1200`） |
| `sync itad` | 走 ITAD 官方 API（需 `ITAD_API_KEY`，未配置则跳过） |
| `list` | 主榜：各游戏官方渠道最低价 + 是否史低 |
| `history <appid>` | 终端画价格轨迹 + 史低判断（`--days 90`） |
| `stats` | 数据量 + 最近 5 次采集健康度 |
| `logs` | 查日志，见下 |
| `diagnose` | 自检并落盘 `logs/diagnose-*.json` |

通用参数：`--db <target>`（`postgres://…` 或 `pglite:./path`）、`--level`、`--log-dir`。
环境变量：`DATABASE_URL`、`ITAD_API_KEY`、`LOG_LEVEL`、`LOG_DIR`。

## 日志（远程排障的主入口）

落盘在 `logs/`，JSONL，一行一条，**所有记录带 `runId`**，一次命令的所有事件可以用 `runId` 串起来。

```
logs/app-YYYY-MM-DD.jsonl     全量（info 及以上）
logs/error-YYYY-MM-DD.jsonl   只含 error/fatal，快速看错误流
logs/diagnose-*.json          自检报告
```

按大小轮转（默认 8MB / 保留 10 份）。密钥类字段自动脱敏：`apiKey`/`token`/`cookie` 打成 `***`；连接串只抹密码、保留 host 和库名（排障需要）。

**事件命名是 `域.动作`**，常用的：

| 事件 | 什么时候出现 | 排障用途 |
|---|---|---|
| `http.request` / `http.response` | 每次外部请求 | 看不到 response 就是卡在网络上 |
| `http.error` / `http.retry` | 单次失败 / 重试 | 看 `code`（`UND_ERR_CONNECT_TIMEOUT` = 被阻断）、`status`（429 = 限流） |
| `http.parse_error` | 响应不是 JSON | 带 `bodySnippet`，多半是拿到 HTML 错误页 |
| `db.query_failed` | SQL 报错 | 带 SQL 和错误码，如 `23505` 唯一键冲突 |
| `adapter.<平台>.*` | 解析过程 | `sku_candidates` 数量 = 0 说明页面结构变了 |
| `ingest.price_changed` | 价格真的变了 | 带前后 hash |
| `ingest.summary` / `sync.done` | 每轮结束 | 一眼看 inserted/updated/snapshots/unchanged |
| `diagnose.check` | 自检每一项 | 先把这组发过来 |

查日志：

```bash
node src/cli.js logs --level error --limit 20
node src/cli.js logs --event http --since 30        # 最近 30 分钟
node src/cli.js logs --run run-20261026025454-nu81  # 单次命令全轨迹
```

**线上出问题时，发我三样就够了**：`logs/error-*.jsonl`、对应 `runId` 的 `logs/app-*.jsonl`、`logs/diagnose-*.json`。

## 测试

```bash
node test/log.test.js        # 7 项：JSONL 格式、脱敏、轮转读取、过滤
node test/adapters.test.js   # 5 项：Steam 接口构造与解析
node test/sonkwo.test.js     # 7 项：对着真实页面快照解析（含"别取错版本价"）
node test/pg.test.js         # 8 项：真 PG 语义（PGlite）跑建表/入库/去重/主榜/史低
node test/scheduler.test.js  # 8 项：调度时刻表、首轮错开、参数透传
node test/deploy.test.js     # 8 项：compose/Dockerfile/入口脚本一致性、CRLF 检查
```

## 已知限制

1. **Steam 官方接口在国内网络不可达**（实测 `UND_ERR_CONNECT_TIMEOUT`）。代码是完整的，要么给采集机配出口，要么靠 ITAD 的 Steam 价。
2. **杉果没有可用搜索接口**（`store/search` 的 loader 服务端报错、`/api/*` 返回 410），SKU 只能按 id 抓，来源靠 `data/skus.json` 人工维护。
3. **杉果商品页里没有 Steam appid**，跨平台对齐只能靠名称匹配。`add-sku --appid` 显式关联是最靠谱的做法；没关联的会以 `noAppId` 计数出现在 `ingest.summary` 里。
4. **ITAD 的响应结构是按官方文档写的，尚未用真 key 验证**。`adapter.itad.shape_mismatch` 会带原始片段，配好 key 后跑一次 `sync itad` 即可确认。
5. SteamPy 需要登录态，未接入（登录墙 + C2C 性质，且封号风险）。

## 定时采集

```cron
# 每小时 Steam + 杉果，每天一次 ITAD
5 * * * * cd /opt/gameprice && DATABASE_URL=... node src/cli.js sync steam  >> logs/cron.log 2>&1
20 * * * * cd /opt/gameprice && DATABASE_URL=... node src/cli.js sync sonkwo >> logs/cron.log 2>&1
30 3 * * * cd /opt/gameprice && DATABASE_URL=... node src/cli.js sync itad  >> logs/cron.log 2>&1
```
