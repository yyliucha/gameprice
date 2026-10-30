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

---

# 待执行清单（2026-10-30 确认）

以下需求由用户在 2026-10-30 逐条确认，**代码尚未实现**。实现后请在每项后面补状态和验证结果。

## 生产数据基线（2026-10-30 01:25 UTC 实测）

| 指标 | 数值 |
|---|---|
| `games` 总行数 | 196,927 |
| 其中已删除 / 已禁用 | 0 / 0 |
| `app_type = 'game'` | 1,180（绝大多数为空：195,747） |
| 国区有日价格 | 106,232 |
| 任意区有日价格 | 106,232（说明目前只有国区数据） |
| 有当前在售报价 | 106,232 |
| `offers` / `price_snapshots` / `daily_prices` | 106,246 / 106,253 / 107,326 |

**结论**：目录 19.7 万、能上架 10.6 万，缺口 9.07 万；且 `app_type` 基本没回填，
所以「10.6 万」不是游戏数，而是「有国区报价的条目数」，「19.7 万」则是包含 DLC/软件/原声的应用数。

## 已确认的决策

1. **数量口径**：首页大数字改用目录数，筛选结果数放到「找到 X 款」那一行；目录/有报价两个数都展示。
2. **排序**：新增热度，**热度作主序**（`order by heat desc nulls last`），用户选的排序作为次序。
3. **新作筛选**：需要，做成「发行时间」筛选（不限 / 近 30 天 / 近 1 年 / 近 3 年）。
4. **CSV 导出**：前端入口删除；后端 `/api/games/:appid/history.csv` 保留但拦截，不返回实际内容。
5. **移动端**：前后台都适配，目标是「好用」而不是「能打开」。
6. **亮暗色**：前台顶栏 + 后台头部各有一个切换，状态共用。
7. **亮暗色选项**：界面只给「亮色 / 暗色」两个按钮；设置页额外保留「跟随系统」入口。
8. **亮暗色默认**：默认跟随系统；用户显式选择后固定。
9. **主题偏好存储**：写入服务端（跨设备）；未登录时 localStorage 兜底。
10. **公共页**：`/banned`、`/appeal`、`/setup` 一起支持暗色。
11. **站点通知**：改成弹窗，页面内不再放公告元素。
12. **前台详情弹窗**：修 850px 固定宽度导致的移动端溢出；报价行不再用 1fr 拉出大空隙；一页数据时不显示分页。
13. **搜索边打边查**：输入即触发查询，但必须限流——300ms 防抖 + 中文输入法合成期不查 + 最少 2 个字符
    （纯数字按 AppID 走，≥4 位立即查）+ 请求可取消 + 结果短期缓存；服务端同步优化搜索条件。

## 待确认（实现前必须拍板）

| # | 问题 | 建议默认 |
|---|---|---|
| A | 目录数是否排除已删除/禁用？是否注明含 DLC？ | 排除 deleted/blocked，页面小字注明「含 DLC/软件」 |
| B | 热度刷新频率 | 播种一次 + 每周增量（限「有报价 + 近 90 天有访问或被标记」） |
| C | 用户选「价格优先」时热度是否仍压在前面 | 热度只作同档位的次序，否则价格排序会失效 |
| D | 新作筛选是否按上面四档 | 按四档做 |
| E | CSV 拦截返回什么 | 一律 404 + 空 body（403 会暴露接口存在），管理员暂不放行 |
| F | 通知弹窗触发规则 | 仅当有比「已读 id」更新的公告时弹；最多 5 条可滚动；关闭即记已读；不提供「永不再提示」 |
| G | 登录后主题以谁为准 | 服务端有值用服务端，为空则沿用本地并写回 |
| H | 切换按钮样式 | 顶栏右侧图标按钮，后台头部右上同位置 |
| I | 后台表格手机端是否可改卡片式 | 可以，按行折叠成卡片 |
| J | 发版节奏 | `1.2.0`（前端交互与暗色）+ `1.3.0`（热度与排序） |

## 执行批次

### 批次 1：前端交互修复（纯前端，可独立发布）

- 详情弹窗宽度改 `min(850px, 92vw)`，移动端全屏；报价行改固定比例栅格或两行布局。
- `PaginationBar` 在 `total <= pageSize` 时不显示；报价/历史列表的重复分页条收敛。
- Element Plus 配置中文 locale（顺带修掉 `Total / Go to / 20 per page / Select`）。
- 首页通知区去掉分页，改为弹窗（决策 11）。
- 删除详情弹窗底部 CSV 导出入口；后端接口按 E 项处理。
- 不感兴趣改为显式三态（感兴趣 / 不感兴趣 / 清除）。
- 搜索改「边打边查」（决策 13）：`watch(query)` + 300ms 防抖，`compositionstart/end` 期间不触发，
  长度 <2 且非纯数字不计，输入框清空时立即恢复全量；回车保留立即查询（跳过防抖）；
  请求沿用已有 `AbortController`，并对响应加序号防止旧结果覆盖新结果。
- 搜索服务端配套（先测量再决定是否加索引）：
  - `cast(g.steam_appid as text) = $2` 改成「关键词是纯数字时用 `g.steam_appid = $2::int`」，避免每行 cast；
  - 在**生产库**跑 `EXPLAIN ANALYZE` 看 `lower(name) like '%kw%'` 的实际耗时；
    若单次 >150ms 再考虑 `pg_trgm`：`create extension if not exists pg_trgm` +
    GIN 索引（`lower(coalesce(name,'')) gin_trgm_ops`），并确认它对该参数化 LIKE 生效。
- **验收**：桌面 1440 与手机 390 两种宽度下，弹窗、分页、通知、标记都正常；`npm run frontend:build` 通过。

### 批次 2：亮暗色主题

- 在 `main.css` 建立语义化颜色 token（约 20 个），替换现有 263 处硬编码 hex。
- `<html class="dark">` + Element Plus `dark/css-vars.css`；`index.html` 内联脚本防首屏闪烁。
- 状态：localStorage + 服务端偏好（决策 9）；未选择时跟随系统并监听 `prefers-color-scheme`。
- 前后台切换按钮共用状态（决策 6/7）；`/banned`、`/appeal`、`/setup` 一起支持（决策 10）。
- **验收**：两套主题下 6 个页面 + 后台 10 个模块无「白底白字」；强制刷新无闪白；切换后其他设备登录能同步。

### 批次 3：移动端适配

- 断点补到 900 / 600 两档；工具栏改 2×2 网格，下拉不再被压成「中…」。
- 卡片 ≤420px 一列；字号与触控目标（≥40px）放大。
- 后台表格手机端改卡片式或固定表头横滚；筛选区折叠。
- **验收**：390×844 与 768×1024 下无横向溢出，后台各模块可完成一次完整操作（建用户 / 封 IP / 改设置）。

### 批次 4：热度与排序（含数据回填，工作量最大）

- `games` 增加 `heat real`、`heat_reviews int`、`heat_at timestamptz` 与 `(heat desc)` 索引。
- 热度来源：官方 `appreviews/<appid>?json=1&num_per_page=0&language=all` 的 `query_summary.total_reviews`；
  批量播种可先用 SteamSpy `request=all` 分页（非官方，失败则退回慢刷）。
- 同时补 `app_type`：用 `appdetails?appids=<100 个>&filters=basic` 批量回填，
  196,927 条约 1,970 次请求，按 200 次/5 分钟约 50 分钟。
- 排序接入 `heat desc nulls last`；「发行时间」筛选接入 `release_date`。
- **验收**：首页第一页不再是清一色 95% 折扣老游戏；无热度数据的游戏排在末尾而不消失；
  随机抽 10 款游戏核对热度与 Steam 商店页评测数量级一致。

## 开工前必须先探测的两件事

容器里没有 `curl`，用项目自带的 HTTP 封装（会走 `STEAM_PROXY`）探测：

```bash
# 1) 官方评测接口是否可达
docker exec steamdeals node --input-type=module -e "
import { fetchJson } from '/app/src/http.js';
try {
  const d = await fetchJson('https://store.steampowered.com/appreviews/730?json=1&num_per_page=0&language=all', { label: 'probe.reviews', timeoutMs: 20000 });
  console.log('OK', JSON.stringify(d.query_summary));
} catch (e) { console.log('FAIL', e.message); }
"

# 2) SteamSpy 是否可达（用于批量播种）
docker exec steamdeals node --input-type=module -e "
import { fetchJson } from '/app/src/http.js';
try {
  const d = await fetchJson('https://steamspy.com/api.php?request=appdetails&appid=730', { label: 'probe.spy', timeoutMs: 20000 });
  console.log('OK', d.name, d.ccu, d.positive, d.negative);
} catch (e) { console.log('FAIL', e.message); }
"
```

两条都通 → 「SteamSpy 播种 + appreviews 常态更新」；只有第一条通 → 全量走 appreviews 慢刷。

