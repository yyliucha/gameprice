# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-26

价格历史终于能"看"了。

### 新增

- **静态价格页** `node src/cli.js chart`
  - 列表页：每款游戏当前最低价、原价、折扣、史低、迷你看板
  - 详情页：90 天价格曲线 + 当前最低 / 历史最低 / 区间均价 / 区间最高 + 各平台报价表
  - 纯静态：内联 SVG，无外部 JS/CSS/字体，离线可打开；单页约 7KB
  - 所有外部文本（游戏名、平台名）转义
- **演示数据脚本** `scripts/demo-seed.js`：造 3 款游戏 90 天曲线，用于本地看效果或截图
- 存储层新增查询：`gameOverview` / `dailyMinSeries` / `dailyPlatformSeries` / `offersOfGame`

### 修复

- **多平台报价会被归到错误的平台**：`ingestOffers` 用批次的 `platform` 作为默认值，若一个批次里混了多个平台而 offer 未自带 `platform` 字段，后来的报价会被静默记到第一个平台名下（演示数据里"杉果 ¥118"被显示成"Steam 国区"）。现在会记 `ingest.platform_mismatch` 告警，演示脚本也改为逐条携带 platform。
- **Y 轴刻度不可读**：原实现按数据范围 ±8% 均分，出现 ¥83 / ¥141 这类标签；改为 1/2/5 × 10ⁿ 步长对齐。

## [0.1.0] - 2026-10-26

首个可用版本：从零到"能自动采集、能查历史、能远程排障、能一键部署"。

### 新增

- **采集适配器**
  - Steam 国区：官方 `appdetails`，支持逗号分隔批量、限速、失败重试
  - 杉果：解析商品页内嵌 `window.__remixContext` 结构化 JSON，DOM 仅作兜底
  - IsThereAnyDeal：官方 REST API（`/games/search/v1`、`/games/prices/v3`），按商店拆成独立平台
- **存储（PostgreSQL 15）**
  - 六张表 + 一个主榜视图：`games` / `game_aliases` / `offers` / `price_snapshots` / `daily_prices` / `fetch_runs` / `v_lowest_official`
  - "只收官方渠道"做成视图约束，C2C 无法进入主榜
  - 快照按内容指纹判重，价格不变不写入
- **调度**
  - 常驻调度器，三个任务各自独立子进程，崩溃不影响其它任务
  - 首轮触发错开（30s / 180s / 300s），避免启动瞬间打满
- **日志**
  - JSONL 结构化日志，`runId` 串联一次命令的全部事件
  - 请求级埋点：`http.request/response/retry/error/fail`，带 `requestId`
  - 密钥自动脱敏，连接串只抹密码
  - 按大小轮转（8MB / 保留 10 份），错误额外落一份 `error-*.jsonl`
  - `logs` 命令支持按级别 / 事件 / runId / 时间过滤
- **运维**
  - `diagnose`：环境、数据库、网络逐项自检并落盘报告
  - `ping`：健康检查命令
  - `bootstrap`：容器启动时建表 + 首次导入，幂等
- **部署**
  - Dockerfile：非 root、tini、`npm ci --omit=dev`、healthcheck
  - compose：内置 postgres:15（可选 profile），支持外部库
  - `.gitattributes` 锁定 LF，避免 CRLF 破坏容器入口脚本
- **文档**
  - README：定位、边界、架构、命令、配置、限制
  - `docs/ARCHITECTURE.md`：设计取舍、失败模型、扩展新平台指南
  - `docs/DATA-SOURCES.md`：四个数据源的可达性实测与勘查方法
  - `docs/DEPLOY.md`：两种部署方式、运维命令、故障排查表

### 修复

开发期由测试抓到的三个会产生**错误数据**的缺陷：

- **杉果取错版本价格**：页面顶部先渲染"荣光痴人版 ¥269"，本 SKU 实际 ¥198。原实现取第一个价格，现改为按 `sku_id` 精确匹配 JSON，DOM 兜底只认"购买区"块。
- **DATE 被解析成带时区的 `Date`**：跨时区会差一天，导致日聚合把一天拆成两天、史低判断偏移。改为 identity parser + SQL `::text`。
- **错误日志被读两遍**：error 同时写入 `app-*.jsonl` 与 `error-*.jsonl`，`readLogs` 不区分来源导致重复计数。

### 已知问题

- Steam 官方接口在国内网络直连不可达（`UND_ERR_CONNECT_TIMEOUT`），需出口或改走 ITAD。
- 杉果无可用搜索接口，SKU 需人工维护（`data/skus.json`）。
- ITAD 响应结构按官方文档实现，尚未用真实 key 验证。
- 无失败熔断：某源持续 403 时仍需人工关闭。
- 无前端界面，当前只有 CLI。
