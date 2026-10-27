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
# 全栈（前端 + API + 数据库）
docker compose up -d --build

# 本地开发：直接用 CLI 起服务
node src/cli.js serve --port 8090
```

默认 `web` 服务对外映射 **8090**（容器内 8080），`WEB_PORT` 可改。

## 页面

| 路径 | 说明 |
|---|---|
| `/` | 单页前端：列表、筛选（全部/感兴趣/不感兴趣/已拥有）、排序（折扣/价格/名称）、登录、后台 |
| 点游戏名 | 详情弹窗：价格曲线（客户端 SVG）、各平台报价、开发商/发行商/分类；管理员可直接改标记 |

前端是**零构建**的：`web/index.html` 一个文件，改完刷新即可生效，不需要 npm build。

## 权限模型

| 接口 | 匿名 | 登录用户 | 管理员 |
|---|:--:|:--:|:--:|
| `GET /api/games` | ✅ | ✅ | ✅ |
| `GET /api/games/:appid` | ✅ | ✅ | ✅ |
| `POST /api/login` / `POST /api/logout` | ✅ | ✅ | ✅ |
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
- `GET /api/admin/emails` → 验证码邮件记录（含 `subject`/`body`：用户收不到邮件时直接看验证码）
- `GET /api/admin/blacklist` → 黑名单列表；`POST /api/admin/blacklist` → `{ ip, note }` 拉黑（支持 CIDR）；
  `DELETE /api/admin/blacklist/:ip` → 移出。增删后内存黑名单即时刷新

也可以走 CLI：`node src/cli.js user add <用户名> --admin`

## 部署要点

1. `web` 服务需要 `DATABASE_URL`（它要读库），compose 已注入
2. 端口不对外时可用 SSH 隧道：`ssh -L 8090:127.0.0.1:8090 root@服务器`
3. 静态页（`chart` 生成的）仍在 `data/out`，可与 SPA 并存；SPA 不依赖它

## 测试

```bash
node test/api.test.js       # 5 项：匿名可读、权限隔离、登录/登出、密码哈希、已拥有标记
node test/visitors.test.js  # 5 项：IP/CIDR 校验、记录落库过滤、黑名单 403 拦截、权限隔离
node test/serve.test.js     # 5 项：静态服务路径穿越与内容类型（旧静态模式）
```

前端脚本没有单元测试，用 `new Function` 做语法校验（见提交说明）；行为依赖人工冒烟。
