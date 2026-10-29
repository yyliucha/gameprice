# Web 服务（前后端）

本项目是"采集与展示分离"的结构：

```
scheduler（app 容器）——只写：采集价格、写快照、生成静态页
        │
        ▼
   PostgreSQL
        │
        ▼
web 服务（web 容器）——只读：页面 + JSON API
```

**硬约束：Web 层没有任何修改价格的接口。** 价格只能由调度器写入。

## 启动

```bash
# Docker Hub 零配置（自带数据库）
docker compose -f compose.hub.yaml up -d
# 首次打开 http://IP:8090 → /setup

# 从源码构建（开发）
docker compose up -d --build

# 本地开发：直接用 CLI 起服务
node src/cli.js serve --port 8090
```

默认对外映射 **8090**（容器内 8080），`WEB_PORT` 可改。

## 页面

| 路径 | 说明 |
|---|---|
| `/setup` | 首次初始化：创建管理员、数据源/代理/提醒；完成前其他页面一律 302 到这里 |
| `/` | Vue 单页前端：列表、筛选（全部/感兴趣/不感兴趣/已拥有）、排序（折扣/价格/名称）、登录 |
| `/console` | Vue 控制台（仅管理员）：游戏管理、回收站、站点通知、访问记录、用户管理、**Steam 账号**、邮件服务、**系统设置**、数据统计、运行日志；`?section=` 可直链到某个模块 |
| `/banned` | Vue 封禁提示页（403）：服务端注入 `window.__BAN_PAGE__`（站点名/申诉邮箱/到期时间/申诉编号），封禁期间只放行该页需要的 `/assets/*.js|css` |
| 点游戏名 | 详情弹窗：各平台报价、折扣、简介；管理员可直接改标记、设到价提醒 |

**前台不提供 Steam 登录**：Steam OpenID 登录与游戏库同步全部放在控制台的「Steam 账号」页，
与站点账号体系相互独立；前台只展示游戏优惠数据。

前端源码在 `frontend/`（Vue 3 + Vue Router + Element Plus + Vite）：多页面入口由 `frontend/src/router/index.js` 定义，
页面在 `frontend/src/pages/`，样式在 `frontend/src/styles/main.css`。开发用 `npm run frontend:dev`，
构建用 `npm run frontend:build`（产物 `frontend/dist/`，不入库，镜像构建时生成）。
`src/server.js` 的 `frontendDir` 负责把 `/`、`/console`、`/setup`、`/banned` 与 `/assets/*` 交给构建产物；
没有 `frontend/dist/index.html` 时自动回退到 `web/` 旧页面（旧页面里的设置表单仍由 `web/settings-ui.js` 渲染）。

## 初始化与系统设置

首次启动（无管理员）时：

```
GET /               → 302 /setup
GET /api/*          → 428 { setupRequired: true }（/api/setup/* 除外）
GET /setup          → 初始化页
POST /api/setup/complete
     原子事务：创建管理员 + 写 app_settings/smtp_settings + 写 setup.completed
     返回 gp_session cookie，前端跳 /console
```

- `GET /api/setup/status` → `{ completed, hasAdmin, setupTokenRequired, version, database }`
- `GET /api/setup/schema` → 字段定义 + 非密钥当前值（密钥只给 `hasValue`）
- 完成后 setup 接口失效（`complete`/`schema` 409），`/setup` 302 到 `/`
- 初始化始终需要口令：配置 `SETUP_TOKEN` 时使用该值；未配置时，服务启动会生成一次性口令并显示在启动输出中。`POST /api/setup/complete` 必须带 `x-setup-token` 或 body `setupToken`

老部署如果已经有管理员，启动时自动导入旧 `.env` 并标记完成，不会被拦。

## 业务设置 API（管理员）

| 接口 | 说明 |
|---|---|
| `GET /api/admin/settings` | 字段定义 + 值 + `sources`（database/env/default）+ 密钥 `hasValue` |
| `POST /api/admin/settings` | `{ values: { "sources.steam.enabled": false, ... } }` |

- 密钥字段：`GET` 不回显；`POST` 空字符串/省略 = 保持，`null` = 清除
- 保存后写库、递增 `settings.revision`；调度器轮询到 revision 变化后重新水合 `.env` 并重建任务表
- SMTP 仍落 `smtp_settings`，与其他业务设置共用页面 API；旧的 `/api/admin/smtp` 保留兼容

## 权限模型

| 接口 | 匿名 | 登录用户 | 管理员 |
|---|:--:|:--:|:--:|
| `GET /api/games` | ✅ | ✅ | ✅ |
| `GET /api/games/:appid` | ✅ | ✅ | ✅ |
| `POST /api/login` / `POST /api/logout` | ✅ | ✅ | ✅ |
| `GET /api/setup/status` / `GET /api/setup/schema` | ✅（仅未初始化时） | ✅ | ✅ |
| `POST /api/setup/complete` | ✅（仅未初始化时；始终要求初始化口令） | ✅ | ✅ |
| `GET/POST /api/admin/settings` | ❌ 401 | ❌ 403 | ✅ |
| `POST /api/prefs` | ❌ 401 | ✅ | ✅ |
| `POST /api/games/:appid/interest` | ❌ 401 | ❌ 403 | ✅ |
| `POST /api/games/:appid/owned` | ❌ 401 | ❌ 403 | ✅ |
| `GET /api/admin/users` / `/api/admin/views` | ❌ 401 | ❌ 403 | ✅ |
| `POST /api/admin/users` | ❌ 401 | ❌ 403 | ✅ |
| `GET /api/admin/visitors` | ❌ 401 | ❌ 403 | ✅ |
| `GET/POST /api/admin/blacklist`、`DELETE /api/admin/blacklist/:ip` | ❌ 401 | ❌ 403 | ✅ |

会话：`gp_session` cookie（httpOnly + SameSite=Lax，7 天）。密码用 `node:crypto` 的 scrypt 加盐哈希，库里不存明文。

另外：**IP 黑名单在会话之外生效**——命中黑名单的 IP 对整站（含静态页）一律 403，
管理员会话自动放行（避免把自己拉黑后进不了控制台）。

## 接口

### `GET /api/games`

查询参数：

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `interest` | `all` / `on` / `off` | `all` | 感兴趣筛选 |
| `owned` | `exclude` / `only` / `include` | `exclude` | 已拥有默认排除 |
| `sort` | `discount` / `price` / `name` | `discount` | 排序 |
| `region` | 区服代码 | `cn` | 区服 |
| `limit` | 1–500 | 200 | 条数上限 |

返回 `{ games: [...], total, sort, owned }`。每行带 `all_offers`（各平台当前价，升序），前端直接渲染成平台标签。

### `GET /api/games/count`

返回 `{ catalog, priced }`：库内游戏总数、已有价格数据的游戏数（前台顶部的实时数量来源，列表最多 500 条）。

### `GET /api/games/:appid`

返回 `{ game, offers, series }`。登录用户访问会记录一条 `page_views`（管理员可在后台看到排行）。

### `POST /api/prefs`

```json
{ "hide_uninterested": true, "only_discount": false, "sort": "discount" }
```

登录用户的偏好存在服务端；**访客的筛选偏好只存浏览器 localStorage**（`steamdeals.prefs.v1`），不上传。

### 管理员

- `GET /api/admin/users` → 用户列表（角色、最近登录）
- `GET /api/admin/views` → 浏览排行（90 天前自动清理）
- `POST /api/admin/users` → `{ username, password, role }` 建号
- `GET /api/admin/visitors?page&pageSize&ip&path` → 访问记录分页 + 今日汇总（访问数/独立 IP/黑名单数/高频 IP）
- `GET /api/admin/images` → 封面图本地缓存统计（张数/覆盖游戏数/体积/目录）
- `GET /api/admin/emails` → 验证码邮件记录（含 `subject`/`body`：用户收不到邮件时直接看验证码）
- `GET /api/admin/blacklist` → 黑名单列表；`POST /api/admin/blacklist` → `{ ip, note }` 拉黑（支持 CIDR）；
  `DELETE /api/admin/blacklist/:ip` → 移出。增删后内存黑名单即时刷新

封面图走 `/img/steam/<appid>/<size>`：先查内存热缓存，再查本地文件（`data/images`），
都没有才经代理取 CDN 并落盘；之后一直读本地文件，不再出网。

也可以走 CLI：`node src/cli.js user add <用户名> --admin`

## 部署要点

1. `web` 服务需要 `DATABASE_URL`（它要读库），compose 已注入
2. 端口不对外时可用 SSH 隧道：`ssh -L 8090:127.0.0.1:8090 root@服务器`
3. 静态页（`chart` 生成的）仍在 `data/out`，可与 SPA 并存；SPA 不依赖它

## 测试

```bash
node test/api.test.js       # 5 项：匿名可读、权限隔离、登录/登出、密码哈希、已拥有标记
node test/visitors.test.js  # 5 项：IP/CIDR 校验、记录落库过滤、黑名单 403 拦截、权限隔离
node test/serve.test.js     # 5 项：静态服务路径穿越与内容类型（无 frontend/dist 时的回退路径）
```

Vue 页面没有单元测试：改动前端后至少跑 `npm run frontend:build` 确认能构建，再用浏览器过一遍
`/`、`/console`、`/banned` 与改动的后台模块。`web/` 里旧页面的内联脚本由
`node scripts/check-html-syntax.mjs web/index.html web/console.html web/setup.html` 做语法校验（CI 会跑）。
