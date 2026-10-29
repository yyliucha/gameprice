# 路线图与已预留话题

这里记录**还没实现**的议题、背景和设计取向，避免跨会话丢失上下文。
写入本文件不代表已排期；实现时按 [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) 的维护约定，
同步更新总览、专项文档和 CHANGELOG，并在本文件把状态改成已实现/已放弃。

## 地区限制与 18+ 内容（锁国区、港区可售）

状态：**未实现，仅留痕**（2026-10-29）

### 背景

- Steam 上有一部分游戏**锁国区**（`store/api/appdetails` 用 `cc=cn` 请求时 `success:false`
  或没有 `price_overview`），但**港区可以正常售卖**。
- 大陆对 18+ / 成人内容有展示限制，港区合法。站点目前对两者一视同仁：取不到就不展示，
  取得到就展示，没有区分"内容本身在大陆不该展示"和"国区买不到"。

### 现状（写这段时的代码事实）

- `src/adapters/steam.js` 只用一个区服：`descriptor.defaultRegion = 'cn'`，
  请求参数 `cc=cn`；锁区游戏被记为 `skipped` 原因 `not_found_or_region_locked`
  或 `no_price_overview`，只进运行统计和日志，**没有落库**。
- 数据库已有区服维度：`offers.region` 是显式字段，`GAME_SELECT` 按 `region` 过滤；
  `GET /api/games` 也有 `region` 参数（默认 `cn`），`src/compare.js` 按区服/币种分组比较。
  但 Steam 侧没有配置第二区服，等于只有国区数据。
- `games` 表已有 `blocked`（后台"禁用"）语义：`blocked = 'exclude'` 时前台列表不返回该游戏，
  这是**人工逐条**操作，不是按地区自动判定。
- 设置项里只有 GOG 的区服列表（`sources.gog.regions` / `GOG_REGION_CODES`），Steam 没有对应项。

### 目标

1. **能取到的都同步**：港区等可用区服的元数据和价格也入库（`offers.region` 已支持多区服）。
2. **锁区可记录**：给游戏加字段，记录"国区不可售"这类事实，而不是只留在日志里。
3. **展示可控制**：前端按站点策略决定是否展示这些条目——大陆隐藏 18+，港区正常显示；
   后台管理员始终能看到全部。

### 建议落点（实现时再定，不是承诺）

- **数据**：`games` 加列，例如 `cn_locked boolean`（或更通用的 `locked_regions text[]`）；
  迁移按现有风格追加到 `src/store/pg.js` 的 `alter table games add column if not exists ...` 列表。
  若要按区服记可见性事实，也可单独建 `game_regions` 表（game_id + region + locked/可见性原因），
  避免多地区时列数膨胀。
- **采集**：`src/adapters/steam.js` 支持多区服（cn + hk）。注意区分三种情况——
  `success:false`（真锁区/下架）、`no_price_overview`（免费或该区无定价）、以及正常无折扣；
  港区价是 HKD，不能和 CNY 混算（`offers.currency` 已是显式维度）。
- **接口**：`GET /api/games` 已有 `region`，补 `hideLocked` / `hideAdult` 之类的过滤参数，
  返回体带上锁定标记，供前端画角标。
- **设置**：站点级开关（如 `site.hideCnLocked`、`site.hideAdult`），
  走 `src/settings.js` 的 `def(...)`，在控制台"系统设置"里可改，调度器热加载。
- **前端**：`frontend/src/pages/Home.vue` 卡片加标记与筛选；
  `frontend/src/pages/AdminModules.vue` 游戏管理加字段、批量筛选和人工覆盖。

### 待确认的问题

- 锁区口径：`success:false`、无 `price_overview`、已下架三者是否要分开记录，
  判定以国区请求为准还是以"所有区服都取不到"为准？
- 港区采集的额度：Steam `store/api/appdetails` 限 200 次/5 分钟（`STEAM_429_RETRIES` 等已做退避），
  双区服等于请求翻倍，是否需要独立限流或错峰？
- 18+ 判定来源：Steam `content_descriptors`（需要 appdetails 的非 `filters=price_overview` 全量字段）
  还是人工/标签？两种来源的准确率和成本差别很大。
- 隐藏策略粒度：全局开关、按访客归属地（站点已有 `ip-api` 归属地查询）、
  还是按登录用户偏好？访客归属地可伪造，涉及合规时要不要兜底默认隐藏？
- 是否需要对外声明"部分内容仅港区可见/大陆不展示"，以及港区价格是否要标注汇率与结算限制。

### 验证要求（实现时）

- 至少用真实 appdetails 请求验证一个锁国区、港区可售的样本（例如 18+ 游戏），
  确认 `cc=cn` 与 `cc=hk` 的返回差异被正确落库。
- 前端隐藏开关要做"开/关"两种状态的回归，并确认后台不受影响。
- 部署后核对 `GET /api/games` 返回的标记字段与数量。
