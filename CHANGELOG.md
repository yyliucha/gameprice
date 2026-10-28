# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.19.0] - 2026-10-28

后台游戏管理新增「同步进度统计」与「同步状态筛选」。

### 新增

- **同步概览统计**（`GET /api/admin/games/stats`）：库内总数、有 appid 数、**待同步信息数**、
  已同步数（含进度百分比）、有报价数、已删除数；控制台游戏管理页直接在列表上方显示
- **同步状态筛选**：游戏列表新增下拉「全部同步状态 / 待同步信息 / 已同步」
  （`GET /api/admin/games?sync=pending|done`）——可以直接筛出还没补说明/没 Steam 价格的游戏

### 说明

- 「待同步」判定与 `sync steamall` 的选择条件一致：有 appid、未删除，且（缺说明 或 没有 Steam 价格）
- 目录里没有 appid 的行（如纯杉果游戏）不计入同步进度分母

### 测试

- `api.test.js` 新增：统计字段、待同步 → 已同步转换、pending/done 过滤、匿名 401

## [0.18.9] - 2026-10-27

价格报表第一版：每次同步的价格简报 + 涨跌榜。

### 新增

- **快照记住前价**：`price_snapshots.prev_price_cents`，入库时写入上一条快照的价格
  （之后涨跌、降幅都能直接算，不用再翻历史快照）
- **每次同步的价格简报**：`sync steamall` 结束时打印本次降价/涨价条数与 Top 榜
- **`report price` 命令**：`node src/cli.js report price --hours 24 --limit 10`
- **`GET /api/admin/reports/price?hours=24&limit=10`**（管理员）：返回汇总 + 降价 Top / 涨价 Top
- 控制台「数据统计」新增「价格变动（近 24 小时）」：降价/涨价条数 + 涨跌榜（原价 → 现价 → 幅度 → 时间）

### 说明

- 只统计带有前价的新快照；功能上线前写入的旧快照没有前价，不会进报表
- 「新史低」暂未纳入本期（需要与日聚合的最低价做对比，下期补）

### 测试

- `api.test.js` 新增：快照前价写入、报表统计与榜单、匿名 401

## [0.18.8] - 2026-10-27

后台编辑/前台详情 404 修复（单款查询不再依赖列表前 500 名）。

### 修复

- `/api/games/:appid` 与 `/api/games/by-id/:id` 之前是「取概览前 500 条再搜目标」，
  排在 500 名之后、或还没有报价数据的游戏会返回 404——控制台点「编辑」报「载入失败：没有该游戏」
- 新增 `db.gameDetail`（单款按 appid / 内部 id 直查，字段与列表一致），两条详情路由改用它；
  不再受 limit、排序与「必须有日价格」的限制

### 测试

- `api.test.js` 新增：不在列表里的游戏（无报价）也能取详情、按内部 id 也能取

## [0.18.7] - 2026-10-27

游戏逻辑删除（回收站）与平台列。

### 新增

- **逻辑删除**：games.deleted / deleted_at；后台游戏列表每行新增「删除」按钮（二次确认），
  数据与报价全部保留，只是不再展示
- **回收站页面**：控制台新「回收站」页列出已删除游戏（含平台、报价数、删除时间），可一键恢复；
  接口 GET /api/admin/games/deleted
- **平台列**：后台游戏列表新增「平台」列（Steam/杉果/GOG/Humble… 多个则多个标签），
  并支持按平台筛选（GET /api/admin/games?platform=steam）
- 新接口：POST /api/games/:appid/deleted 与 POST /api/games/id/:id/deleted（管理员，{deleted:true|false}）

### 变更

- 前台列表与详情排除已删除游戏；后台列表默认排除（deleted=only 查回收站、include 两边都看）
- 增量同步不再同步已删除的游戏（sync steamall 选择条件加 not g.deleted）

### 测试

- api.test.js 新增：平台列下发、逻辑删除前后台排除、回收站可见、恢复后恢复展示、报价数据未真删

## [0.18.6] - 2026-10-27

控制台用户列表列错位修复。

### 修复

- 用户表行里多渲染了一个「Steam 绑定」单元格、表头却没有对应列，导致从「角色」开始整体右移一格
  （角色格显示「未绑定」、状态格显示 admin）。移除该单元格，列对齐恢复
- 角色改为中文展示（管理员 / 普通用户），表下补一行角色与状态说明，避免看不懂 admin/user

## [0.18.5] - 2026-10-27

无 Steam appid 的游戏（杉果等）也能标记不感兴趣/已拥有。

### 修复

- 上一版把「标记不感兴趣 / 标记已拥有」按钮限定为有 Steam appid 的游戏，
  导致杉果专属游戏详情里没有这两个按钮。现在补上按**内部 id** 的接口：
  `POST /api/games/id/:id/interest` 与 `POST /api/games/id/:id/owned`（管理员），详情弹窗自动选择用哪条
- `setOwned` 支持 `gameId`，与 `setInterest` 对齐

### 测试

- `api.test.js` 增加无 appid 游戏按内部 id 标记的断言（匿名 401 / 管理员落库）

## [0.18.4] - 2026-10-27

前台偏好双写（数据库 + 浏览器缓存）；「全部」过滤已拥有与不感兴趣。

### 新增

- **偏好随账号走**：`user_prefs` 新增 `tab` 列，页签 + 排序按用户保存；
  登录用户打开页面按数据库里的个人习惯加载（同时镜像到 `localStorage`），未登录按浏览器缓存加载；
  切换页签/排序时**同时写数据库与浏览器缓存**（写库失败不影响本地生效）
- `GET /api/me` 返回的 `prefs` 带 `tab`；`POST /api/prefs` 对非法值归一化
  （`tab` 只认 all/on/off/owned，`sort` 只认 discount/price/name）

### 变更

- **Docker 命名统一为 `steamdeals`**：compose 项目名、PostgreSQL 库名/用户、命名卷、源码镜像 tag、
  文档示例全部从 `gameprice` 切换；Docker Hub 镜像仍是 `yyliucha/steamdeals`
- **「全部」页签过滤掉「不感兴趣」与「已拥有」**（之前只隐藏已拥有）；
  已拥有只在「已拥有」里出现，不感兴趣只在「不感兴趣」里出现
- 旧 `hide_uninterested` 字段保留兼容：`tab=on` 时自动置 true

### 测试

- `api.test.js` 补充页签偏好落库、`/api/me` 回带、非法值归一化断言

## [0.18.3] - 2026-10-27

游戏详情弹窗布局调整（原来 320px 太窄，表头与内容被挤成竖排）。

### 变更

- 详情弹窗宽度改为 `min(860px, 94vw)`，最大高度 88vh 可滚动；窄屏下表格区域横向滚动
- 弹窗内表格不再折行（`white-space: nowrap`），列宽恢复正常；关闭按钮不参与压缩
- 头图限制最大宽度 520px 并居中，避免宽屏下图过高
- 前端简易后台弹窗同样放宽（`min(720px, 94vw)`）

## [0.18.2] - 2026-10-27

修复「标记不感兴趣/已拥有后，列表与页签不更新」。

### 修复

- 前台刷新签名漏了 `interested` / `owned`：标记请求已写入数据库，但 `load()` 比对签名认为"没变化"，
  不重渲染——于是切到「不感兴趣」页签看到的还是旧列表。签名补上这两个字段（及类型）后立即重绘
- 列表行新增「不感兴趣」标签（`已拥有` 原本就有），标记后当场可见，不用刷新页面
- 详情弹窗的标记按钮：失败时弹出错误提示（以前静默）；没有 Steam appid 的杉果游戏不再显示这两个按钮（避免点了 404）

### 说明

- `感兴趣 / 不感兴趣 / 已拥有` 是**全局标记**，存在 `games.interested` / `games.owned` 列，只有管理员可以改；
  `user_prefs` 只存每个用户自己的展示偏好（隐藏不感兴趣 / 只看折扣 / 排序），不是标记本身

## [0.18.1] - 2026-10-27

封面图本地缓存：下载一次后由本机磁盘直接提供，之后不再依赖 CDN / 代理（VPS 只用于采集数据）。

### 新增

- **图片本地缓存**（`src/images.js`）：`<IMG_DIR>/<appid>/<size>.jpg`，默认 `data/images`；
  `data` 是 compose 挂到宿主机的卷，重建容器不丢
- **`images pull` 命令**：批量补图（默认 `capsule_sm_120,header`，支持 `--limit/--sleep/--sizes`），
  只补「有价格数据」的游戏（列表/详情才用得到），已缓存齐全的自动跳过
- **`images stats`**：已缓存张数 / 覆盖游戏数 / 体积
- **调度器 `images` 任务**：默认每 4 小时补 200 款（`IMAGES_ENABLED` / `IMAGES_INTERVAL_MIN` /
  `IMAGES_LIMIT` / `IMAGES_SLEEP_MS` 可调）
- **`GET /api/admin/images`** 与控制台「数据统计 → 封面图缓存」：张数 / 覆盖 / 体积 / 目录
- `.gitignore` 忽略 `data/images/`

### 修复

- **`/img/steam/<appid>/<size>` 路由此前永远不可达**：非 `/api/` 路径会先被静态资源分支处理并 404，
  于是图片请求根本到不了图片路由——这是「前台只有名字没有图」的真正原因（与代理无关）。
  现在 `/img/` 与 `/api/` 一样先走路由，再回落到静态文件
- 图片路由改为「内存热缓存 → 本地磁盘 → 三条 CDN 兜底并落盘」；命中本地后不再出网，
  失败结果缓存 5 分钟避免拖满超时

### 测试

- 新增 `images.test.js` 4 项：路径安全（appid 只留数字 / size 白名单）、读写与统计、
  下载落盘（注入 fetchBuffer，全失败不落盘）、`/img` 路由命中本地文件时不再触网

## [0.18.0] - 2026-10-27

Docker Hub 零配置部署：业务配置落库 + 首次 `/setup` 初始化 + 控制台系统设置 + 调度器热加载。

### 新增

- **设置存储**：`app_settings`（jsonb + 密钥密文）与 `app_meta`（初始化状态 / settings.revision）；
  50 项业务设置集中定义在 `src/settings.js`，SMTP 继续复用 `smtp_settings`
- **首次初始化 `/setup`**：创建第一个管理员 + 写业务设置 + 标记完成，全部在一个事务里；
  完成前页面 302 到 `/setup`、业务 API 返回 428，健康检查不受影响
- **`SETUP_TOKEN`**：可选初始化口令，防止公网被抢先初始化
- **控制台「系统设置」页**：按服务端 schema 渲染分组表单；密钥只显示「已配置」，留空保持、可显式清除
- **`GET/POST /api/admin/settings`**：管理员读写设置，保存后递增 revision
- **调度器热加载**：初始化完成前等待，不采集；轮询 revision，设置变更后重新水合 env 并重建任务表
- **Docker Hub**：`compose.hub.yaml`（自带 PostgreSQL、命名卷、零 `.env`）与
  `compose.hub.external-db.yaml`（已有库，连接串写在 compose 命令里）
- **发布工作流**：GitHub Actions 多架构构建 `linux/amd64,linux/arm64`，测试 + 容器冒烟 + 推送 `yyliucha/steamdeals`
- **文档**：`docs/DOCKER-HUB.md`，README/DEPLOY/QUICKSTART/WEB 同步更新

### 变更

- CLI 启动时自动水合数据库设置；老部署（已有管理员）自动导入旧 `.env` 并标记初始化完成
- `all` 模式入口先 bootstrap 再启动，保证首次部署导入种子游戏
- 容器默认使用命名卷，不再需要 `mkdir` / `chown`；`.dockerignore` 排除 `data/secret.key`、测试数据库与备份
- `.env.example` 缩减为部署参数；业务配置不再需要改 `.env`

### 测试

- 新增 `settings.test.js`（默认值/密钥加密/env 导入/水合/事务）与 `setup.test.js`（拦截、初始化、口令、老库迁移）
- `deploy.test.js` 增加 Hub compose、外部库 compose、发布工作流、`.dockerignore` 守卫

## [0.17.7] - 2026-10-27

Steam 登录整体移到后台，前台只展示优惠数据。

### 变更

- **前台移除 Steam 页签与登录入口**：去掉「Steam」tab、Steam 面板、登录弹窗里的「用 Steam 账号登录」按钮及相关脚本；
  本地偏好里残留的 `steam` 页签自动回落到「全部」
- **控制台新增「Steam 账号」页**（仅后台）：OpenID 登录 / 退出、游戏库同步（时长、最低价、未入库标记）、
  单款点击打开 Steam 商店页；原有 `/api/steam/*` 接口不变
- 前台功能收敛为：游戏优惠列表、筛选排序、搜索、详情价格曲线、各平台报价

### 测试

- `deploy.test.js` 新增守卫：前台不得出现 Steam 登录入口/面板/页签，控制台必须有登录与同步入口

## [0.17.6] - 2026-10-27

后台同步体验：不跳页、按钮禁用、实时输出、同步记录；前台分页吸底。

### 新增

- **同步记录**（`sync_runs` 表 + 控制台「同步记录」表）：每次手动同步的任务号、模式、状态、耗时、
  退出码与输出尾巴；服务重启残留的 running 记录启动时自动标失败
- **同步实时输出**：`GET /api/admin/sync/status` 返回运行状态与输出；控制台在同步卡片内滚动显示
- **`GET /api/admin/sync/runs`**：同步历史列表（管理员）
- 同一时间只允许一个同步：运行中再点返回 409（前端按钮同时禁用，结束自动恢复）

### 变更

- 点「增量同步」不再跳转到「日志」页，只提示任务号并原地显示进度；成功/失败后按钮自动恢复
- `sync steamall` 取到 0 条时打印排查指引（`diagnose` 的 `net:steam` 一行）
- 前台分页条改**吸底常驻**（`position:sticky`），长列表滚动时始终可见

### 测试

- 新增 `test/sync-runs.test.js` 2 项；全套 26 个文件 216 项全绿

## [0.17.5] - 2026-10-27

封面图链路诊断细化。

### 变更

- `/img/steam` 兜底路径去重：三条互不重复的路（Cloudflare 代理 → Akamai 直连 → Cloudflare 强制直连）
- `diagnose` 图片探测拆成三行 `net:img:cf-proxy` / `net:img:ak-direct` / `net:img:cf-direct`，
  与图片路由逐条对应；`fetchText` 新增 `forceDirect`（跳过代理决策）

## [0.17.4] - 2026-10-27

Steam 封面图多路兜底（线上图片 404 的修复）。

### 修复

- `/img/steam/<appid>/<size>` 原来只走 Cloudflare CDN 且必须经代理，代理不通就 404。
  现在按 **Cloudflare(代理) → Akamai(直连) → Cloudflare(直连) → Akamai(代理)** 依次兜底，
  每条路 8 秒超时；成功过的路按 appid 记忆复用，失败也缓存 5 分钟避免每次拖满超时
- 图片失败日志从 debug 提到 **warn**（`steam.img_miss` 带失败原因），INFO 级别日志也能看到为什么没图
- `fetchBuffer` 新增 `forceDirect` 参数（跳过代理决策）

### 变更

- `diagnose` 新增两条封面图链路探测：`net:img:cloudflare` / `net:img:akamai`，
  图片打不开时跑 `docker compose exec app node src/cli.js diagnose` 一眼定位是哪条路不通

## [0.17.3] - 2026-10-27

游戏类型（游戏 / DLC）在前台体现；开发商/发行商同步补强。

### 新增

- 前台列表：DLC / 试玩 / 音乐等非游戏类型显示**类型徽标**（`app_type` 由 `gameOverview` 下发）；
  游戏详情弹窗 facts 首项显示「类型」，控制台游戏列表新增「类型」列
- 同步日志输出 DLC 数量（`sync.steamall.done` 带 `dlc` 计数）

### 修复 / 变更

- **类型大小写统一**：官方接口（`dlc`）与 steamcmd 镜像（`DLC`）的 `type` 全部归一化成小写入库
  （新增 `normalizeType`；`upsertGameMeta` 防御性再归一，老库大小写混用的数据随下次同步自动纠正，
  前端按小写匹配，旧数据也能立即正确显示）
- 开发商 / 发行商：此前已在同步链路中提取落库（两个后端都抓 `developers` / `publishers`），
  本次补上入库断言与 DLC 落库测试，保证不再回退

### 测试

- `steam-meta.test.js` 新增类型归一化用例；`gamemeta.test.js` 新增开发商/发行商/DLC 落库用例（共 214 项全绿）

## [0.17.2] - 2026-10-27

验证码邮件内容落库，用户收不到邮件时管理员可直接提供验证码。

### 新增

- `email_codes` 表新增 `subject` / `body` 列：登录、重置密码、绑邮箱、SMTP 测试四类邮件的
  主题与正文在**发送前**就落库（发送失败也能查到内容）
- 控制台「验证码发送记录」新增「查看」按钮：弹窗展示邮件主题/正文 + 元信息（收件人、用途、过期时间、是否已使用），
  「复制验证码」一键复制正文里的 6 位码
- `GET /api/admin/emails` 返回 `subject` / `body` / `expires_at` / `used_at`

### 变更

- 每日备份任务顺带清理 3 天前的邮件记录（正文含明文验证码，不留存太久）

### 测试

- `test/email-auth.test.js` 新增 2 项：schema 含 subject/body 列；假 SMTP 端到端
  （发码 → 正文验证码可哈希校验 → 管理员接口可读 → 过期清理），共 8 项

## [0.17.1] - 2026-10-27

前台实时刷新提速 + 真实游戏数量 + 详情弹窗头图。

### 新增

- **`GET /api/games/count`**（匿名可读）：返回库内游戏总数与"已有价格"的游戏数。
  列表接口最多 500 条，此前后台游戏超过 500 款时前台数量永远停在 500，看起来像"没更新"
- **详情弹窗 Steam 头图**：打开游戏详情时顶部显示 `/img/steam/<appid>/header`（加载失败自动隐藏）

### 变更

- 前台实时刷新从 60 秒加快到 **10 秒**；页面从后台切回可见时立即刷新一次；
  Steam 页签也随每次轮询刷新（游戏库/时长同步后不用手动刷新）
- 前台顶部元信息改为「库内 N 款 · 有价格 N 款 · 更新于 HH:mm:ss（自动刷新）」

## [0.17.0] - 2026-10-27

访问者记录与 IP 黑名单；控制台游戏管理页重构。

### 新增

- **访问记录**：每次页面/API 请求落库 `visitor_logs`（IP + 归属地 + 路径 + 状态码），
  静态资源不记；IP 归属地异步解析（ip-api.com → ipwho.is 兜底，24h 内存缓存，内网地址不查）
- **后台「访问记录」页**：今日访问/独立 IP/黑名单数汇总、近 24h 高频 IP、分页记录（可按 IP/路径过滤）
- **IP 黑名单**：后台增删（支持单个 IP 与 IPv4 CIDR），命中即整站 403（server 层拦截、常驻内存零查询），
  管理员会话自动放行避免自我锁死
- **游戏管理页重构**：删除「愿望单导入」卡片与「单个游戏编辑」区块；
  列表「编辑」改为弹窗（说明/禁用）；「同步 Steam」卡片置顶

### 修复

- `src/steam-login.js` 误用 `../http.js` 导入：Steam 登录及所有位于其后的后台路由全部 500（`70cab61` 引入）
- 全新库上 `/api/admin/users` 报 `column "email" does not exist`：users 表的 email/steam_id 列补进迁移
- `deploy.test.js` 的 shebang 断言跟随入口脚本改为 `#!/bin/bash`

### 测试

- `test/visitors.test.js` 5 项（IP/CIDR 校验与匹配、记录落库与过滤、黑名单拦截与管理员放行、权限隔离）并纳入 `npm test`

## [0.16.0] - 2026-10-26

前后端分离落地：有了真正的 Web 前端与用户系统。

### 新增

- **`web/` 前端工程**（零构建单页）：列表 + 筛选（全部/感兴趣/不感兴趣/已拥有）+ 排序（折扣/价格/名称）
- **游戏详情弹窗**：客户端 SVG 价格曲线、各平台报价、开发商/发行商/分类
- **后台管理页**（仅管理员）：用户列表、浏览排行；可直接标记感兴趣/已拥有
- **访客本地偏好**：未登录也能筛选排序，选择存 `localStorage`，不上传服务端
- **`user` 命令**：`user add <名> [--admin]`，密码只显示一次；`user list`
- **`backup` 命令**：8 张核心表导出 gzip JSON 到 `data/backup`，保留最近 7 份
- **浏览记录 90 天清理**（随备份任务执行）
- **[docs/WEB.md](docs/WEB.md)**：API 契约、权限矩阵、部署要点

### 修复

- `serve` 启动报 `startApiServer is not defined`（导入缺失），全栈服务无法启动
- Steam `appdetails` 批量请求返回 400：改为逐个 appid 请求，并顺带取分类与价格字段
- 元数据曾覆盖人工维护的游戏名：改为只补空缺

### 变更

- 仓库更名 `gameprice` → **`steamdeals`**（旧地址 301 重定向）
- `discover`（杉果目录发现）默认关闭：以 Steam 为准，只在需要补 SKU 映射时手动开启
- 调度器新增每日 `backup` 任务（`BACKUP_ENABLED=0` 可关）

### 测试

- `test/api.test.js` 5 项（匿名可读、权限隔离、登录登出、密码哈希、已拥有）
- 调度器测试更新为 8 个任务


## [0.15.0] - 2026-10-26

用户系统与只读 API。

### 新增

- `users` / `sessions` / `user_prefs` / `page_views` 四张表，migrate 幂等创建
- scrypt 加盐哈希 + httpOnly cookie 会话（7 天）
- API：`/api/games`、`/api/games/:appid`、`/api/login`、`/api/logout`、`/api/me`、`/api/prefs`、`/api/admin/*`
- 权限隔离：匿名只读，写操作需登录/管理员；**Web 层没有任何改价接口**

## [0.14.0] - 2026-10-26

不用 nginx，直接 `IP:端口` 看页面。

### 新增

- **内置静态页服务** `serve`（`src/serve.js`，零依赖，用 node:http）
  - compose 新增 `web` 服务，复用同一个镜像，默认对外 **8090**（避开已被占用的 80）
  - `WEB_PORT` 可改端口，`OUT_DIR` 决定服务哪个目录
  - 安全边界：只读 `OUT_DIR` 之内（路径穿越 403）、只允许 GET/HEAD（其余 405）、
    HTML 不缓存（页面上是价格）、`x-content-type-options: nosniff`
- `serve --port/--dir/--host`，`--port 0` 时由系统分配

### 说明

宿主机上常有 nginx 占着 80，且用户只想"IP+端口直接访问"。为此不引 nginx、不加反代，
而是把静态服务做进应用：少一个组件就少一处故障点。想挂到已有 nginx 也可以，
把 `OUT_DIR` 设成 `data/out`，nginx 直接指过去（教程里有配置）。

### 验证

- `test/serve.test.js` 5 项：路径穿越（含 URL 编码 `../` 与空字节）、内容类型、GET/HEAD/405
- 真实运行：对着 48 款游戏的生成目录起服务，
  `GET /` 200（14KB）、`GET /game-105600.html` 200、`GET /nope` 404、`HEAD /` 只有头
- 部署测试新增断言：web 服务复用镜像、端口 `${WEB_PORT:-8090}:8080`、不含 nginx
- 合计 195 项

## [0.13.0] - 2026-10-26

修掉两个会让首次部署直接失败的坑（是我之前的"零配置"说法不够准确）。

### 修复

- **`docker compose up` 不会启动数据库**：`db` 服务原来挂在 `profiles: ["bundled"]` 下，
  而没有 `.env` 时 `COMPOSE_PROFILES` 为空 → db 不启动 → app 连 `db:5432` 被拒、无限重启。
  现在 db 默认随 `up` 启动；用外部数据库时执行 `docker compose up -d app` 只起 app。
- **宿主机挂载目录权限**：容器以 `node`(uid 1000) 运行，`./data`、`./logs` 属主是 root 时
  写日志 `EACCES`，报错藏在启动日志深处。现在入口脚本启动前检查可写性，
  直接打印修复命令（`sudo chown -R 1000:1000 ./data ./logs`）并以 2 退出。

### 新增

- **[docs/QUICKSTART.md](docs/QUICKSTART.md)**：云服务器从零部署教程——装 Docker、权限、
  验收四命令、提醒通道配置、静态页托管（`OUT_DIR=data/out` + nginx）、网络方案、日常运维、
  故障速查表
- 部署测试新增断言：db 不得依赖 profile 才启动；入口脚本必须检查挂载目录可写

### 验证

- `test/deploy.test.js` 10 项、`test/docs.test.js` 5 项（含新文档的链接检查）全绿
- `bash -n scripts/docker-entrypoint.sh` 通过；`compose.yaml` YAML 解析通过
- **本机没有 Docker，镜像仍未经真实构建**：以上是结构与语法验证

## [0.12.0] - 2026-10-26

国内服务器访问 Steam 的问题，有了可配的出口。

### 新增

- **按主机分流的出网代理**（`src/proxy.js` + `src/http.js`）
  - `STEAM_PROXY`：只作用于 Steam 域名（store/api/community）
  - `HTTPS_PROXY`：通用代理，受 `NO_PROXY` 排除
  - 境内源（杉果）和可达源（GOG/Humble）保持直连——全走代理既慢又浪费流量
  - 支持 `http(s)://`（undici `ProxyAgent`），**不支持 socks5**；代理密码在日志与 `diagnose` 中脱敏
  - 每个请求日志带 `via=direct|proxy|steam-proxy`，失败信息也带上走了哪条路
- `diagnose` 增加 `proxy:steam` / `proxy:others` 两行，部署后第一眼就能确认出口配置
- `scripts/local-proxy.js`：零依赖的最小代理（HTTP absolute-form + HTTPS CONNECT），
  用来验证"请求确实被转发了"而无需第三方工具

### 验证

- `test/proxy.test.js` 10 项：决策矩阵、NO_PROXY 匹配、密码脱敏、**本地起代理真实转发**
- 真实 HTTPS 验证：`HTTPS_PROXY=http://127.0.0.1:8899` 下，`import steam` 成功且日志 `via=proxy`，
  代理端记录 `CONNECT api.steamcmd.net:443`；`STEAM_PROXY` 下 Steam 请求记录
  `CONNECT store.steampowered.com:443` 并报 `经 steam-proxy`
- 合计 184 项

## [0.11.0] - 2026-10-26

游戏信息不用手填了。

### 新增

- **Steam 游戏信息导入** `import steam`
  - 支持 `--appids 730,570`、`--urls <商店链接>`、`--file <清单>`（每行一个 appid 或链接）
  - 写入中文名、英文名、类型、封面、发行日期、开发商/发行商
  - **双后端自动回落**：先探官方 `appdetails`（5s 超时），不通则用 `api.steamcmd.net`
    （Steam PICS 数据镜像，实测本机可达），实际用的后端记进 `steam.meta.done`
  - `--backend auto|official|steamcmd` 可强制指定
- 实测：6 个 appid 全部导入成功，中文名与封面齐全

### 修复

- **元数据把人工维护的名字改坏了**：730 的 `sc_schinese` 还是旧的「反恐精英：全球攻势」，
  第一版"元数据覆盖"策略把它盖掉了「反恐精英 2」。现在名字**只补空缺不覆盖**
  （`coalesce(games.name, excluded.name)`）；`is_free` 用 null 判断，镜像给不了时不会误改成 false。

### 已知

- 镜像**不提供 `is_free`**，也**不能按名字搜索**（只能给 appid 或商店链接）。
  官方接口可达时这两个限制都不存在。

### 测试

- 新增 `test/steam-meta.test.js` 11 项、`test/gamemeta.test.js` 5 项
- 合计 174 项

## [0.10.0] - 2026-10-26

采集完自动刷新页面，不用再手动跑 `chart`。

### 新增

- **曲线页自动重建**：调度器在采集类任务成功后自动执行 `chart`
  - 触发条件：任务是 steam/sonkwo/itad/gog/humble/discover 且退出码为 0
  - `CHART_ON_SYNC=0` 可关闭（例如页面由 CI 构建）
  - `OUT_DIR` 可配置输出目录
  - 重建失败只记 `scheduler.job_failed`（job 名 `sonkwo:chart`），不影响主任务状态
- 实测：46 个杉果 SKU 同步完成（65.5s，41 条新快照）→ 自动重建 48 款游戏、49 个文件、337ms

### 测试

- 调度测试新增 1 项：成功触发 / 失败不触发 / 非采集任务不触发 / 可关闭
- 合计 158 项

## [0.9.0] - 2026-10-26

`region` 终于不只是数据库里的一个字段。

### 新增

- **多区服采集**：GOG 支持按国家/币种查询，`sync gog --regions cn,us`（或 `GOG_REGIONS`）
  - 显式区服映射表（cn/hk/tw/us/jp/ru/tr/ar → 国家 + 币种），未知区服直接报错
  - 实测：泰拉瑞亚 cn ¥36.00 / us $9.99，星露谷 cn ¥48.00 / us $14.99
- **多区服对比** `compare <appid>`
  - 按区服分组、组内按价格排序、标出"该区最低"
  - **不同币种不做汇率折算**，只并排展示并明确提示不可直接比较
  - `--region cn` 只看单区、`--json` 输出机器可读结构
- 存储层 `regionOffers()`：跨区查询，同样只统计官方/授权渠道

### 设计说明

不做汇率折算的理由：折算需要实时汇率，硬编码会把比较做**错**；用户真正关心的是
"这个区多少钱"，而不是"折成人民币多少"（后者还涉及支付方式能否落地）。所以只在
**同币种内**比数字。

### 测试

- `test/compare.test.js` 7 项、`test/regions.test.js` 4 项、gog 区服 2 项
- 合计 157 项

## [0.8.0] - 2026-10-26

把"46 条孤立价格"和"Steam 游戏"接上的那一环。

### 新增

- **跨平台名称匹配** `match`
  - 归一化：去版本词（标准版/豪华版/Deluxe/Ultimate/GOTY…）、去平台标注、全角转半角、去标点
  - 相似度用**字符 bigram 的 Dice 系数**（中文无词边界，比编辑距离稳），并对"包含关系"给部分分
  - 标题拆成中/英多个写法分别比较（杉果标题常是「中文名 版本（Steam） English Name」）
  - 阈值分级：≥0.94 自动应用、0.86–0.94 待人工 `--confirm`、<0.86 无候选
  - `--apply` 写入 `data/skus.json`；`--confirm <skuId> <appid>` 手工确认
- **重复游戏行合并** `mergeGames()`
  - 确认 appid 后，把早期按名称建出的孤立行并进 Steam 游戏行：
    报价（快照跟随 offer_id）、日聚合（同键取 LEAST）、别名、关注列表，最后删源行
  - 同平台同渠道类型的重复报价保留目标行，源行快照一并清理

### 修复（都是真实数据暴露的）

- **`™` 被 NFKC 展开成 "TM"**：`ELDEN RING™` 归一化成 `elden ringtm`，匹配不到。
  改为先去商标符号再 normalize。
- **中文片段把数字删了**：早期用"删掉所有 ASCII 取中文"，`全境封锁2` 变成 `全境封锁`。
  改为"必须以汉字开头、允许后接数字"的匹配。
- **纯数字被当成中文变体**：`Cyberpunk 2077` 生成变体 `2077`，与中文标题里的 `2077`
  得到 0.6 的假高分。中文片段现在要求以汉字开头。

### 测试

- `test/match.test.js` 11 项、`test/merge.test.js` 5 项（真 PG 语义）
- 合计 144 项

### 已知

- 真实运行 `match` 对 46 个杉果 SKU 返回 0 提案——它们与现有 24 款 Steam 游戏没有交集。
  这是数据覆盖问题，扩大游戏库后即可work。

## [0.7.0] - 2026-10-26

杉果不用再手工加 SKU 了。

### 新增

- **杉果 SKU 自动发现** `discover sonkwo`
  - 杉果没有搜索接口（loader 服务端报错、`/api/*` 已下线 410），改为**按 sku id 顺序探测**：
    id 连续、密度约 70%，未上架/已下架的 id 返回 200 的空壳页（无价格），用解析结果区分
  - 策略：从前沿（已知最大 id）向后扫，**连续 N 个空壳即停**，通常十几到几十次请求
  - 发现的 SKU（含名称）自动并入 `data/skus.json`，已有 `appid` 映射与名称不会被覆盖
  - 扫描水位记录在 `data/sonkwo-discovery.json`（已 gitignore）
  - 调度器新增 `discover` 任务（默认 12 小时一次）
- 实测：扫 120 个 id 命中 46 个商品（111442–111491 密集区，111492 后为空壳），新增 45 条

### 修复

- **空壳页被记成 ERROR**：批量发现时 74 个空壳页产生 74 条 `adapter.sonkwo.no_price` 错误日志，
  会污染 `error-*.jsonl`。现在能区分"这个 id 没有商品"（`adapter.sonkwo.not_a_product`，debug 级）
  与"商品页解析不出价格"（仍是 error 级）。

### 工具

- `scripts/probe-skus.js`：按区间抽样统计 SKU 密度，用于设计扫描窗口；
  判定标准与适配器一致（能解析出报价才算商品）

### 测试

- 新增 `test/discover.test.js` 9 项：区间计算、连续空壳停止、404/异常容错、合并去重
- sonkwo 测试补空壳识别 2 项
- 合计 128 项

## [0.6.0] - 2026-10-26

真正做到一键部署、零配置开箱即用。

### 新增

- **自动建库**：`ensureDatabase()` 在连接前检查目标库，不存在就连维护库 `/postgres` 执行
  `CREATE DATABASE`（标识符转义、支持 URL 编码的中文库名）。无建库权限时只记 `db.autocreate_failed`
  并继续，让后续真实连接报出更明确的错误。
- **compose 零配置**：去掉必填的 `POSTGRES_PASSWORD`，内置库改用 `trust` 认证且**不发布端口**；
  `docker compose up -d --build` 三条命令即可，不需要 `.env`、不需要先建库建表。
- **CLI 自动降级**：没有 `DATABASE_URL` 也没有 `--db` 时，自动使用嵌入式 PG（`data/pgdata`），
  本地试验零前置。

### 测试

- 新增 `test/store.test.js` 10 项，其中最后一项用 **PGlite + PGLiteSocketServer 起真 TCP Postgres**，
  实测 `CREATE DATABASE` 成功、重复调用变为 `exists`、并在 `pg_database` 里查到新库。
- 部署测试新增断言：compose 默认免密启动、数据库端口不对外、`DATABASE_URL` 与 trust 匹配。
- 合计 117 项。

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
