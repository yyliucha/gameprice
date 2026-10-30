# 实施计划（2026-10-30）

可执行规格：批次 1 落到文件与行为，批次 2–4 落到方案与验收。决策依据、生产数据基线、探测记录见
[ROADMAP.md](ROADMAP.md)。本文件不含"待讨论"内容——未定的都列在文末「待确认」。

## 发布节奏

| 版本 | 内容 | 状态 |
|---|---|---|
| `1.2.0` | 批次 1 + 2 + 3：交互修复、亮暗色、移动端 | ✅ 已发布（`e1ebd49`，2026-10-30） |
| `1.3.0` | 批次 4：热度与排序 + 数据回填 | ✅ 已发布（`f794dbf`，2026-10-30） |

---

# 批次 1：前端交互修复

## 1.1 详情弹窗（`frontend/src/pages/Home.vue`）

现状问题（本地实测）：

- `width="850px"` 写在 `el-dialog` 上，Element Plus 把它渲染成内联 `--el-dialog-width: 850px`；
  移动端 390px 视口下弹窗实测 `left:0 / right:850`，右侧内容被裁掉。
- 已有的移动端规则 `.detail-dialog :deep(.el-dialog){width:94%}` 选择器失效——`.detail-dialog`
  和 `.el-dialog` 是同一个元素，不存在后代关系。
- 报价行 `grid-template-columns: 95px minmax(80px,1fr) 95px 85px 65px 70px`，第二列吃掉全部剩余宽度，
  平台名与价格之间出现约 400px 空白。

改法：

- 宽度改用响应式值：`<el-dialog :width="isNarrow ? '96vw' : '880px'" ...>`，
  `isNarrow` 用 `matchMedia('(max-width: 640px)')` + `addEventListener('change')` 维护，卸载时移除监听。
- 报价行栅格改为固定比例，移动端换成两行：
  ```css
  .offer-row{grid-template-columns:minmax(72px,.9fr) minmax(96px,1.1fr) 88px 88px 56px 68px}
  @media(max-width:640px){
    .offer-row{grid-template-columns:1fr auto auto;grid-template-areas:"plat price buy" "meta meta meta";row-gap:4px}
    .offer-row>*:nth-child(1){grid-area:meta}.offer-row>*:nth-child(2){grid-area:plat}
    .offer-row>*:nth-child(3){grid-area:price}.offer-row>*:nth-child(5){grid-area:meta flex}
    .offer-row>*:nth-child(6){grid-area:buy}
  }
  ```
  实现时可自由调整，验收标准：桌面无大空隙、手机不溢出。
- `.series-list` 从 `repeat(5,minmax(0,1fr))` 改为 `repeat(auto-fill,minmax(130px,1fr))`。
- 删掉失效的 `.detail-dialog :deep(.el-dialog)` 规则。

## 1.2 分页收敛（`frontend/src/components/PaginationBar.vue`）

- `v-if="total > 0"` → `v-if="total > pageSize"`，并加 prop `hideOnSinglePage`（默认 `true`），
  允许后台个别列表强制显示。
- 详情弹窗里「各区服与平台报价」「价格历史」两处分页随之自动消失（各只有 1 条数据时）。
- 首页主列表用的是 `el-pagination`（`v-if="pages > 1"`），保持不动。

## 1.3 Element Plus 中文 locale

- `main.js` 增加：
  ```js
  import zhCn from 'element-plus/es/locale/lang/zh-cn';
  import { ElConfigProvider } from 'element-plus';
  app.use(ElConfigProvider);
  ```
- `App.vue` 模板包一层：`<el-config-provider :locale="zhCn"><router-view/></el-config-provider>`。
- 顺带修 `AdminModules.vue` 游戏管理两个筛选下拉：给第一个加 `placeholder="全部平台"`、
  第二个加 `placeholder="全部同步状态"`（当前值为 `''` 时 Element Plus 显示默认英文 `Select`）。

## 1.4 站点通知改弹窗（`Home.vue`）

- 删除页面内的 `.notice-list` 与伴生 `PaginationBar`（第 12 行整块）。
- 新增 `<el-dialog v-model="noticeDialog" title="站点通知" width="min(560px, 92vw)">`：
  - 列表最多渲染 5 条，超出部分容器 `max-height:320px;overflow-y:auto`；
  - 每条展示标题 + 正文 + 级别色；
  - 底部按钮「我知道了」→ 记已读并关闭。
- 已读状态：localStorage `steamdeals.notice-read.v1` 存**最大已读公告 id**（数字）。
  打开首页时若 `notices.some(n => n.id > readId)` 则弹出；关闭时把 `max(notices.id)` 写入。
- 原 `noticeDismissed`（按条关闭）机制被上面的「已读 id」取代，`steamdeals.notice-hidden` 可废弃。
- 接口不用改：`GET /api/announcements` 已返回最多 200 条、`order by id desc`。

## 1.5 去掉前端导出（`Home.vue` + `src/server.js`）

- 删除详情弹窗底部的「导出 90 天价格历史 CSV」链接。
- `src/server.js:1111` 的 `/api/games/:appid/history.csv` 保留代码但加开关：
  ```js
  const HISTORY_CSV_ENABLED = process.env.HISTORY_CSV_ENABLED === '1'; // 默认关闭
  ```
  未开启时在匹配到该路径后直接 `return json(res, 404, { error: 'Not Found' })`，
  与「路由不存在」的响应一致，避免暴露接口存在；`.env.example` 不写入该变量（默认关）。
- `docs/WEB.md` 同步说明「历史 CSV 暂时关闭」。

## 1.6 「不感兴趣」三态（`Home.vue` + 后端语义）

**重要发现**：`db.setUserGameFlag`（`src/store/pg.js`）用的是
`coalesce(excluded.interested, user_game_flags.interested)`，即**传 `null` 表示"不修改"**，
所以登录用户目前**无法清除标记**，只能 true / false。

两种实现二选一（见文末待确认 3）：

- **方案 A（不改后端）**：UI 只做两态——`感兴趣` / `不感兴趣`，点中的按钮高亮；
  再点同一个按钮表示"取消"→ 但对登录用户实际是 `false`（不感兴趣），语义不完整。
- **方案 B（改后端，推荐）**：`POST /api/games/:appid/flags` 增加清除语义，
  例如 body 传 `{ interested: 'clear' }` 或新增 `DELETE /api/games/:appid/flags?field=interested`，
  客户端就能表达"未标记"。游客侧本来就是删 localStorage key，天然支持。

卡片与弹窗的按钮形态：两个并列按钮 `感兴趣` / `不感兴趣`，当前态高亮；游客与登录用户一致。

## 1.7 搜索边打边查（`Home.vue`）

- 输入框保留 `v-model="query"`，去掉只靠 `@keyup.enter` 的触发方式，改为：
  - `compositionstart/ compositionend` 维护 `composing`，合成期间不触发；
  - `watch(query)` + 300ms `setTimeout` 防抖（只保留 trailing）；
  - 触发条件：`query.trim().length >= 2`，或纯数字 `>= 4`（按 AppID 精确查）；
  - 输入框清空 → **立即** `loadGames(1)`，不走防抖；
  - Enter → 立即查询并取消待执行的防抖；
- 请求层：沿用现有 `AbortController`，新增自增 `requestSeq`，响应回来时 `seq` 不是最新就丢弃；
- 客户端缓存：`Map`，key = `q|region|sort|tab|page|type`，TTL 30s，最多 50 条；
- 中文输入法下"拼音阶段"不查询（这是最关键的一条，否则打一个词会发多次请求）。
- 服务端配套（`src/store/pg.js` 的 `gameSearch`）：
  - 关键词是纯数字时，把 `cast(g.steam_appid as text) = $2` 换成 `g.steam_appid = $2::int`；
  - 在生产库跑 `EXPLAIN ANALYZE`，单次 `like '%kw%'` 超过 150ms 再考虑 `pg_trgm`；
  - 该索引方案已写进 ROADMAP，按"先测后建"执行。

## 1.8 后台「检测新版本」（2026-10-30 追加）

现状：旧版 `web/console.html` 侧栏底部有版本块（`#appVersionBox`），显示 `版本 v{current}`，
有新版本时显示 `↑ 新版 vX 可用` 链接，点击强制刷新（`/api/admin/version?force=1`）。
Vue 后台**只剩**「系统设置」里的 `版本 x.y.z` 静态文字，没有检查更新、没有新版本提示。

后端接口无需改动，已具备：

- `GET /api/admin/version`（仅管理员）：返回 `current / latest / updateAvailable / url / checkedAt / error / repo`；
- `?force=1` 绕过服务端 6 小时缓存；
- 环境变量 `UPDATE_CHECK=0` 只报当前版本不出网，`UPDATE_REPO` 可换仓库。

前端实现（`frontend/src/pages/Console.vue` + `AdminModules.vue`）：

- 侧栏底部 `admin-bottom` 里加版本块：`版本 v{{ current }}`，
  鼠标悬停显示 `上次检查时间 / error`；
- `updateAvailable` 为真时显示 `↑ 新版 vX 可用`（新窗口打开 `url`），颜色用 warning 色；
- 整块可点击：点击时带 `force=1` 重新检查，期间显示 loading 态；失败显示「版本检查失败」并在 title 里给出原因；
- 进入控制台时自动检查一次（不带 force，命中服务端缓存，不额外出网）；
- 「系统设置」里的静态版本文字保留，作为次要信息。

验收：后台侧栏能看到版本号；把 `UPDATE_REPO` 指向一个更高版本的假仓库（或用 `force=1` + 本地 mock）
时能出现「新版可用」链接；断网时显示失败而不是空白。

## 1.9 后台查询输入框统一支持 Enter（2026-10-30 追加）

要求：控制台里凡是可以触发查询的输入框，按 Enter 都要能直接触发，不能只靠点按钮。

现状审计（`AdminModules.vue` / `AdminExtras.vue` / `Console.vue`）：

| 输入框 | 位置 | 现在 Enter | 说明 |
|---|---|---|---|
| `gameQuery` 搜索名称或 AppID | 游戏管理 | ✅ 已有 | — |
| `visitorIp` 按 IP 筛选 | 访问记录 | ✅ 已有 | — |
| `visitorPath` 按路径筛选 | 访问记录 | ✅ 已有 | — |
| `logQuery` 搜索日志内容 | 运行日志 | ✅ 已有 | — |
| `settingQuery` 搜索设置项 | 系统设置 | ❌ 缺 | 瞬时筛选（`watch` 自动展开分组），Enter 无行为 |
| `filter` 搜索管理功能 | 控制台侧栏 | ❌ 缺 | 瞬时筛选（过滤菜单项），Enter 无行为 |

需要补的两处行为（不是"加查询"，是让 Enter 有可感知结果）：

- `settingQuery`：Enter → 保留关键词重新拉一次 `loadSettings()`（刷新字段定义），
  若当前关键词没有匹配项则 `ElMessage.warning('没有匹配的设置项')`；
- `filter`（侧栏）：Enter → 打开第一个匹配的菜单项（等效点击），无匹配时提示「没有匹配的功能」。

顺带建议（可选，默认做）：表单类输入按 Enter 提交，减少鼠标移动——

- `newBlockIp` / `newAllowIp`：Enter → 提交封禁 / 加入白名单；
- `testEmail`：Enter → 发送测试邮件；
- `newUser.username` / `newUser.email` / `newUser.password`：Enter → 创建账号
  （密码框内 Enter 需避免被浏览器表单默认行为吞掉，用 `@keyup.enter.prevent`）。

不做：给「回收站 / 邮件记录 / 用户管理」这些目前没有搜索框的列表新增搜索（属于新功能，另议）。

## 批次 1 验收

- `npm run frontend:build` 通过；
- 1440×900 与 390×844 下：详情弹窗不溢出、报价行无大空隙、单条数据不显示分页；
- 分页与下拉文案为中文（`共 N 条` / `前往` / `全部平台`）；
- 首页无公告元素，点开弹窗能显示未读公告，刷新后不再重复弹；
- 输入 "tom" 只发 1 次请求（防抖），中文输入拼音阶段 0 次请求；
- 详情弹窗里没有 CSV 导出入口；直接访问 `history.csv` 返回 404；
- 后台侧栏显示版本号，且「检查新版本」可点击（见 1.8）；
- 后台 `settingQuery` 与侧栏 `filter` 按 Enter 有可感知结果（见 1.9）。

---

# 批次 2：亮暗色

- `main.css` 建 token：`--bg / --bg-soft / --panel / --panel-2 / --border / --border-strong / --fg /
  --fg-muted / --fg-subtle / --brand / --brand-soft / --brand-fg / --shadow / --overlay`（约 20 个），
  替换现有 263 处硬编码 hex（`main.css` 63、`AdminModules` 80、`AdminExtras` 48、`BanPage` 32、
  `Home` 23、`AppealPage` 17、`Setup` 13）。
- `html.dark` 切换 + `import 'element-plus/theme-chalk/dark/css-vars.css'`；
- `frontend/index.html` 加 `<meta name="color-scheme" content="light dark">` 和内联脚本：
  读 localStorage → 没有则读 `matchMedia('(prefers-color-scheme: dark)')` → 立即给 `<html>` 加 `dark`，
  避免首屏闪白；
- 状态：`localStorage['steamdeals.theme.v1']` ∈ `light|dark`（不存 `system`）；
  未存过时跟随系统，并监听 `matchMedia` 变化实时切换；
- 服务端：`user_prefs` 加 `theme text`（空 = 跟随系统），`GET /api/me` 返回 `prefs.theme`，
  `POST /api/prefs` 接受写入；登录后以服务端为准，服务端空则沿用本地并写回；
- UI：前台顶栏右侧、后台头部右上各放一个图标按钮（太阳/月亮），两处共享同一状态源；
- `/banned`、`/appeal`、`/setup` 一并支持（BanPage 里已有的 `prefers-color-scheme` 规则要改为跟随全局 class）；
- 验收：两套主题下 6 个页面 + 后台 10 个模块切换检查，无「白底白字」；强制刷新无闪白；
  换设备登录后主题一致。

---

# 批次 3：移动端

- 断点补齐：`1080 / 900 / 600`；现有 `760` 断点保留但调整内容。
- 首页工具条：搜索框占整行，三个下拉 2×2 排布（不再被压成「中…」），刷新按钮整行或与下拉同行。
- 卡片：`≤420px` 时 1 列；`421–760` 保持 2 列；字号 12→13，卡片按钮高度 ≥40px。
- 详情弹窗：`≤640px` 时 `96vw` 且贴近顶部，内部栅格两行（见 1.1）。
- 后台：
  - 侧栏在 `≤900` 时改为顶部横条 + 横向滚动（已有雏形，需修 `height:calc(100vh-139px)` 造成的双滚动）；
  - 表格在 `≤900` 改卡片式：每行渲染成一张卡片，主字段（名称/价格/状态）+ 操作按钮；
    游戏管理、用户管理、回收站、邮件记录、访问记录、日志六个列表优先；
  - 分页在移动端用简洁版：只保留「上一页 / 页码 / 下一页」，去掉 sizes 与 jumper。
- 验收：390×844 与 768×1024 下无横向溢出；后台能完成「建用户 / 封 IP / 改设置」各一次。

---

# 批次 4：热度与排序

细节见 [ROADMAP.md](ROADMAP.md) 的「批次 4」，要点复述：

- 数据源：`appdetails?filters=recommendations,release_date`（30 个 appid/请求，间隔 1.7s，约 3 小时）；
- 落库：`games.heat real`、`heat_reviews int`、`heat_at timestamptz`，索引 `(heat desc)`；
- 新命令：`node src/cli.js heat --limit 200000 --batch 30 --sleep 1700`，按 `heat_at is null` 续跑；
- 与价格回填互斥（同一个后台任务槽位）；
- 排序：`heat desc nulls last` 作为主序，用户选择的排序作次序；
- 「发行时间」筛选吃 `release_date`；
- 验收：首页第一页不再是清一色 95% 折扣老游戏；无热度的排最后不消失；抽 10 款核对数量级。

---

# 待确认（需要你拍板，其余都按默认）

| # | 事项 | 影响 | 我的默认 |
|---|---|---|---|
| 1 | 公告改成弹窗后，**已读的公告去哪看** | 纯 UI | 不提供历史入口（只看未读） |
| 2 | 搜索词是否同步到 URL（`/?q=tom`） | 分享/刷新还原 | 做 |
| 3 | 「清除标记」是否需要（登录用户当前无法清除） | 要改后端接口语义 | 做（方案 B） |
| 4 | 生产库能否直接 `ALTER TABLE games` 加 3 个字段 + 建索引，是否要低峰窗口 | 批次 4 前置 | 加列瞬时、索引用 `CONCURRENTLY` |
| 5 | `1.2.0` 是否包含移动端（批次 3） | 发布节奏 | 包含；若想快发可拆 `1.2.0`=交互+暗色、`1.2.1`=移动端 |
| 6 | 手机端详情用「96vw 弹窗」还是「全屏」 | 交互观感 | 96vw |
| 7 | 后台表格改卡片式时，每张卡最少保留哪些字段 | 信息密度 | 名称 + 关键数值 + 操作 |
| 8 | 暗色下品牌紫是否提亮 | 视觉 | 提亮约 10%（保持色相） |
| 9 | 热度公式权重（评测数 0.7 + 新作 0.3，1 年衰减一半） | 排序观感 | 按此实现，可后调 |
| 10 | 是否需要「仅看热门」筛选或热度榜页面 | 新功能 | 不做 |

## 实施顺序建议

1. 批次 1（纯前端 + 一个开关）→ 本地验证 → 发 `1.2.0` 的候选；
2. 批次 2 暗色（改动面大但与 1 无冲突）→ 合并进 `1.2.0`；
3. 批次 3 移动端 → 合并或 `1.2.1`；
4. 批次 4 热度 → 建表 + 3 小时回填 → `1.3.0`。
