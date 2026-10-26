# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-10-26

提醒终于能推到手上了。

### 新增

- **三种提醒通道**（`src/notify.js`），可同时配置
  - 通用 webhook（原有）
  - 企业微信群机器人：`errcode=0` 才算成功，HTTP 200 但 errcode 非 0 会判失败
  - 邮件：自实现 SMTP 客户端，支持隐式 TLS(465) 与 STARTTLS(587)、AUTH PLAIN / LOGIN
- **`notify-test` 命令**：给所有已配置通道发一条测试消息，部署时先跑这个
- `alerts` 输出每个通道的投递结果（✔/✘ + 状态码）；任一通道成功才标记已通知
- `channelsFromEnv()` / `hasNotifier()`：通道完全由环境变量决定，调度器据此决定是否传 `--mark`

### 实现说明

- 邮件没有引入 nodemailer：运行时依赖仍只有 `pg`，且协议对话可在本地假 SMTP 服务器上逐行断言
- 中文主题按 RFC 2047（`=?UTF-8?B?...?=`）编码，正文 base64 + 76 字符折行，避免客户端乱码
- 通道失败只记日志不抛异常：一个通道挂了不能影响其它通道和整轮任务

### 测试

- 新增 `test/notify.test.js` 10 项，其中 SMTP 全流程用 `net.createServer` 起假服务器，
  断言 `EHLO → AUTH PLAIN(base64 校验) → MAIL/RCPT → DATA → QUIT` 与收到的 MIME 内容
- 合计 106 项

## [0.4.0] - 2026-10-26

数据源从 1 个变成 3 个。

### 新增

- **GOG 适配器**（`sync gog`）
  - 用官方商店前端的 catalog 接口，直接拿 CNY 价格，无需解析页面
  - 实测 24 款中匹配 8 款（泰拉瑞亚 ¥36、星露谷 ¥48、空洞骑士 ¥58、茶杯头 ¥68、死亡细胞 ¥40、赛博朋克 ¥89、博德之门 3 ¥298、冰汽时代 ¥16）
  - **只接受标题归一化后完全相等的产品**：GOG 的 `like:` 是模糊搜索，GOG 不卖的游戏会返回无关热门商品，宁可判空也不能张冠李戴
- **Humble 适配器**（`sync humble`）
  - 搜索接口被 Cloudflare 挡（403），改为按英文名生成 slug 探测商品页，解析 schema.org JSON-LD 的 `offers.price`
  - 名称必须完全一致才接受；404 与"重定向到商店首页"都按"这家店没有"处理
- **英文名支持**：`data/games.json` 增加 `nameEn`，`seed` 写入 `games.name_en`（GOG/Humble 只能按英文检索）
- 调度器新增 `gog` / `humble` 任务（默认 12 小时一次）
- 报价可携带 `steamAppid`，按名检索的源据此并入已有游戏行而不是新建

### 修复

- **GOG 折扣算错**：`price.finalMoney.discount` 是"省了多少钱"（如 209），不是百分比；改为由 final/base 自行计算，`-70%` 才不会被显示成 `209%`
- **Humble 把"不存在"当成"页面结构变了"**：商品不存在时会被 302 到商店首页并返回 200（700KB 无 JSON-LD），现在检查最终 URL 判定为 `redirected`
- **GOG 报价没有带上 steamAppid**，导致 8 款游戏被建成英文名的新行（实测 `noAppId=8`）；修复后 `noAppId=0`、游戏总数不变

### 未接入

- **Fanatical**：商品页是 SPA（HTML 里没有价格），数据走 Algolia 代理，而 `/algolia/key` 被 Cloudflare 返回 403。没有可靠取数路径，暂不实现，避免用错误数据充数。

## [0.3.0] - 2026-10-26

从"能看"到"会叫你"。

### 新增

- **关注列表**（`watchlist` 表，第 8 张表）
  - `watch add <appid> --target 99`：到目标价提醒
  - `watch add <appid>`：不带目标价时，跌到史低才提醒
  - `watch rm` / `watch list`
- **降价提醒** `alerts`
  - 两种触发语义：目标价优先，未设目标时看是否破史低
  - **按价格去重**：同价位不重复打扰，更便宜才再通知（不用时间窗口）
  - `--json` 输出机器可读载荷、`--mark` 记录已通知、`--webhook URL` 投递
  - 没配 webhook 时**不标记**已通知，避免静默吞掉提醒；投递失败不标记、下轮重试
- **采集熔断**
  - 同一任务连续失败 `CIRCUIT_THRESHOLD`（默认 3）次后暂停 `CIRCUIT_COOLDOWN_MIN`（默认 360）分钟
  - 熔断期间只记 `scheduler.circuit_skip`，不再请求目标站；成功一次即复位
- **老库自动迁移**：命令执行前检查 `to_regclass`，缺表自动补 DDL，不需要记住先跑 `init`
- 调度器新增 `alerts` 任务（默认 6 小时一次）；`ALERT_WEBHOOK_URL` 存在时才传 `--mark`

### 修复

- 演示数据里多平台报价被归到同一平台的问题，现在会记 `ingest.platform_mismatch`（上个版本的行为修复，本次补测试）

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
