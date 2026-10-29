# 项目总览：SteamDeals / gameprice

本文是后续维护者与 AI 会话的项目入口，概括产品边界、当前架构、功能落点和已知限制。它描述仓库代码，不代表所有外部数据源或部署环境都已验证可用。

## 后续开发的必做收尾：同步更新本文

每次新增或实质修改功能，在实现完成时**必须检查并更新本文件**，不能只改代码、测试或 CHANGELOG。把这条规则视为功能交付的一部分；即使本次会话被压缩、换模型或交给另一个 AI，也应先读本文并遵守。若仓库中存在适用的 `AGENTS.md`，同时遵循其中要求。

完成代码后，至少核对并按需更新以下内容：

1. **架构与代码落点**：模块职责、请求/数据流、入口和相关文件是否变化。
2. **功能与状态**：在“功能与代码落点”表中新增或修正能力、状态、限制和主要文件；区分已实现、已测试、真实环境已验证、受凭据/网络限制、尚未实现，不要把其中一种说成另一种。
3. **数据与配置**：新增/修改的数据实体、API/CLI 入口、环境变量或后台设置、部署依赖及迁移要求是否需要记录；敏感值只记录变量名，不记录真实凭据。
4. **验证和未完成事项**：记录本次实际执行的测试或运行验证及结果；未执行的验证明确标注未验证，不根据代码存在推断生产可用。
5. **专项文档链接**：若功能已有 README、WEB、DEPLOY、DATA-SOURCES 或 ARCHITECTURE 等专项说明，保持它们与本总览一致，并补上互相可发现的链接。

最终回复前做一次文档收尾检查：总览中的文件路径确实存在、功能状态与当前实现相符、没有把计划写成已完成。若判断不需要修改本文，也要先核对相关章节，并在交付说明中简要说明核对过且无需变更。只更新 CHANGELOG 不满足这项要求。

## 项目定位

SteamDeals 是以 Steam AppID 为游戏主键的跨平台游戏价格采集、比较和历史追踪服务。它采集 Steam、杉果、GOG、Humble 和 IsThereAnyDeal 等来源的报价，记录价格变化，提供 CLI、静态价格页和 Web 管理界面。

产品约束：主榜和史低统计仅纳入官方商店及授权零售商；C2C 报价不参与官方最低价。每条报价应可追溯到平台、区服、抓取时间和购买链接。项目不提供站内购买或代购，也不承诺对商品真伪作超出来源边界的保证。

## 技术栈与运行入口

- 服务端：Node.js ≥22.5，ES modules；运行依赖为 `pg`、`undici`、`@electric-sql/pglite`。
- 数据库：PostgreSQL 15（兼容目标从文档/SQL约束看为 PostgreSQL 10+）；无 `DATABASE_URL` 时 CLI 可使用嵌入式 PGlite。
- Web 前端：Vue 3、Vue Router、Element Plus、Vite；前端源码在 `frontend/`，由服务端提供静态资源和 JSON API。
- 部署：Docker Compose；可使用内置 PostgreSQL 或外部数据库。生产镜像构建时打包前端静态资源。
- 命令行入口：`src/cli.js`；常驻任务入口：`src/scheduler.js`；HTTP 服务入口：`src/server.js`，静态资源服务辅助模块：`src/serve.js`。

## 系统结构

```text
浏览器
  ├─ Vue 应用 frontend/src (路由、页面、组件、样式)
  ├─ 静态曲线页 out/ (由 chart 生成)
  └─ JSON API / 登录、初始化、管理接口
           │
           ▼
Node.js 服务 src/server.js
  ├─ setup/auth/settings/访问控制等路由模块
  ├─ 业务与安全模块：用户、会话、验证码、限流、IP/CIDR 黑名单、访问记录
  ├─ CLI/报表/提醒/备份/导入等共用业务模块
  └─ scheduler.js 子进程调度采集与提醒任务
           │
           ├────────── 数据源 adapters ── RawOffer ── ingest.js
           │                                      │
           └──────────────────────────────────────┤
                                                  ▼
                                       store/index.js + store/pg.js
                                                  │
                                                  ▼
                                      PostgreSQL / 嵌入式 PGlite
```

### 数据采集与入库

适配器位于 `src/adapters/`，按平台把外部响应解析成统一报价。`src/ingest.js` 负责平台/游戏/别名归并、当前报价 upsert、价格变化快照和按日聚合；数据库连接与 SQL 集中在 `src/store/`。HTTP 请求、代理选择和重试封装在 `src/http.js`、`src/proxy.js`。

标准数据链：调度器或 CLI 启动采集 → 适配器抓取并解析 → ingest 写当前报价与历史 → `fetch_runs` 记录运行结果 → 成功采集后可自动重建曲线页。详细失败模型和设计理由见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### Web 服务与前端

`src/server.js` 负责组合 HTTP API、初始化/认证/设置路由和静态前端；辅助路由分别在 `src/setup-routes.js`、`src/auth-routes.js`、`src/settings-routes.js`。`src/serve.js` 提供静态文件服务。前端是 `frontend/` 里的 Vue 3 应用（Vue Router + Element Plus + Vite），主页面和后台页面位于 `frontend/src/pages/`；服务端按 `frontendDir` 提供构建产物，`web/` 下的旧页面只在没有 `frontend/dist/index.html` 时作为回退。

安全与用户能力由服务端模块承载：`src/session-cookie.js`、`src/email-auth.js`、`src/captcha.js`、`src/ratelimit.js`、`src/guard.js`、`src/visitors.js`、`src/devices.js`、`src/steam-login.js`。不要仅凭前端隐藏按钮判断授权；权限必须由 API 校验。

## 功能与代码落点

尚未实现、但已经留痕的议题见 [ROADMAP.md](ROADMAP.md)（例如 Steam 锁国区与 18+ 内容的地区化展示）。

| 能力 | 主要文件 | 当前状态/边界 |
|---|---|---|
| Steam 国区价格 | `src/adapters/steam.js` | 已实现；运行需要 Steam 站点可达，国内通常需出口代理 |
| 杉果采集与 SKU 自动发现 | `src/adapters/sonkwo.js`, `sonkwo-discover.js`, `src/match.js` | 采集、发现和名称匹配已实现；商品覆盖取决于 SKU 库 |
| GOG / Humble / ITAD | `src/adapters/gog.js`, `humble.js`, `itad.js` | GOG 已可用；Humble 命中有限；ITAD 需要 API key，未经真实 key 完整验证 |
| Steam 元数据导入 | `src/adapters/steam-meta.js`, `steam-catalog.js` | 支持官方与 steamcmd 镜像后端及回落 |
| 当前价、快照、日历史、史低 | `src/ingest.js`, `src/store/pg.js` | 价格变化才写快照；主榜及历史低价查询过滤非官方/授权渠道 |
| 比价、历史和静态曲线 | `src/compare.js`, `src/report.js`, `src/cli.js` | CLI 查询与 `chart` 静态 HTML 曲线 |
| Web/API、安装和账户 | `src/server.js`, `src/*-routes.js`, `frontend/` | Vue 前端覆盖前台、初始化、封禁页与控制台十个模块；`web/` 旧页面仅作无构建产物时的回退；具体入口见 [WEB.md](WEB.md) |
| 关注、降价提醒、通知 | `src/alerts.js`, `src/notify.js` | 目标价/史低触发；Webhook、企业微信机器人、SMTP |
| 定时采集与熔断 | `src/scheduler.js` | 任务隔离子进程运行；连续失败会在冷却期内暂停调度任务 |
| 日志、自检、备份、回填 | `src/log.js`, `src/probe.js`, `src/backup.js`, `src/backfill.js` | JSONL 结构化日志、脱敏、健康检查及运维命令 |
| Docker 部署 | `Dockerfile`, `compose*.yaml`, `scripts/docker-entrypoint.sh` | Compose 文件和镜像流程已配置；执行部署前按目标 Compose 与镜像仓库确认 |

## 关键数据概念

- `games`：以 Steam AppID 为中心的游戏主记录；来源标题可以先形成待匹配记录，再通过匹配流程归并。
- `platforms`：数据平台及 `kind` 渠道类型（官方、授权零售商、C2C）。
- `offers`：当前报价；唯一维度包含游戏、平台、产品类型与区服。
- `price_snapshots`：价格变化历史；相同价格状态不重复写入。
- `daily_prices`：按天聚合，用于趋势与史低；面向官方主榜的查询必须保留渠道类型过滤。
- `fetch_runs`：每次采集的健康度和结果；关注/提醒、用户权限、运行配置等其他表结构集中在 `src/store/pg.js` 的迁移 SQL。

金额使用整数分存储，区服和币种是显式维度，不对不同币种擅自换算。日期应保留为 `YYYY-MM-DD` 字符串语义，避免时区偏移。

## 配置与部署入口

- 环境变量和默认值：查看 `src/settings.js`、`README.md`。
- Web 设置：部署初始化后可在控制台系统设置中管理业务配置；敏感凭据不应写入版本控制。
- 本地快速开始：查看 [README 快速开始](../README.md#快速开始)。
- 生产/云服务器部署：查看 [QUICKSTART.md](QUICKSTART.md)、[DEPLOY.md](DEPLOY.md)。
- 拉取已发布镜像：查看 [DOCKER-HUB.md](DOCKER-HUB.md) 及 `compose.hub.yaml`、`compose.cn.yaml`。
- 数据源可达性与限制：[DATA-SOURCES.md](DATA-SOURCES.md)。

## 常用命令

```sh
node src/cli.js bootstrap       # 幂等初始化数据库并导入初始游戏库
node src/cli.js diagnose        # 检查运行环境、数据库和外部连通性
node src/cli.js sync all        # 执行可配置的数据源采集
node src/cli.js list            # 查询官方/授权渠道主榜
node src/cli.js history 1091500 # 查看指定 AppID 的历史
node src/cli.js chart           # 生成静态价格曲线页
node src/cli.js serve           # 启动 Web/API 服务
node src/scheduler.js           # 启动常驻调度器
```

完整参数以 `README.md` 命令参考和 `src/cli.js` 实现为准。

## 测试与维护约定

测试在 `test/`，按模块拆分；`npm test` 顺序执行测试文件。新增功能应补相应模块测试，并更新本总览、相关专项文档及 README 的功能状态。数据源“代码存在”不等于“生产可用”：验证状态应分别注明代码覆盖、真实请求验证、凭据要求和网络前提。发布说明不得把未实际构建/启动的 Docker 镜像说成已验证。

遇到与本文冲突时，以当前代码和专项文档为准，并修订本文，避免把它当作运行时规范。
