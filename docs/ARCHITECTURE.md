# 架构与设计取舍

这份文档记录**为什么这样设计**，而不是罗列代码。命令与部署见 [DEPLOY.md](DEPLOY.md)，数据源实测记录见 [DATA-SOURCES.md](DATA-SOURCES.md)。

## 1. 约束从哪来

| 约束 | 来源 | 对设计的直接影响 |
|---|---|---|
| 只比官方渠道 | 产品决策（C2C 最低价由灰产定价） | `platforms.kind` + 视图，主榜天然排除 C2C |
| 数据必须可追溯 | "真实"只能承诺到来源可信 | 每条报价带 platform / region / 抓取时间 / 来源 URL |
| 历史不能补 | 价格只在发生的那一刻存在 | 快照表从第一天启用，且必须"变化才写" |
| 远程排障 | 部署在别人的服务器上，看不到现场 | 日志成为一等公民，事件可过滤、可按 runId 串联 |
| 目标库是 PG 15 | 现有私有数据库 | 只用 PG 10+ 语法，禁用 `any_value`(16+)、`json_table`(17+) |

## 2. 分层与职责边界

```
adapters/   ── 只负责"把某个平台的数据变成 RawOffer"，不做入库决策
ingest.js   ── 只负责"怎么落库"（判重、快照、日聚合），不关心数据从哪来
store/      ── 只负责"SQL 与连接"，不含业务判断
report.js   ── 只负责"把查询结果渲染成静态 HTML"，不查库（数据由调用方传入）
cli.js      ── 只负责"编排与输出"，不写 SQL
scheduler   ── 只负责"什么时候跑"，不关心跑什么
```

边界清楚带来的直接好处：**加一个平台不需要动 ingest 和 store**。适配器只要吐出一致的 `RawOffer`，后面全部复用。

`RawOffer` 的约定（新增平台必须满足）：

```js
{
  platformCode,        // 与 platforms.code 对应
  platformProductId,   // 平台内部商品 ID（用于 alias 去重）
  steamAppid,          // 能为 null，但为 null 就无法与 Steam 数据合并
  title,               // 平台上的名称，用于对齐与展示
  productType,         // official_direct / authorized_key / c2c_listing
  region, currency,
  priceCents,          // 一律整数分，禁止浮点
  originalCents, discountPct,
  inStock,
  buyUrl,              // 必须是可点击的真实购买页
  meta                 // 平台特有字段，进日志便于排障
}
```

## 3. 一次采集的完整时序

```
cli.js
 ├─ 生成 runId（贯穿本次命令所有日志）
 ├─ openStore()：连接池 + 注册 DATE parser
 ├─ startFetchRun()：先落一行"开始"，即使后面崩了也有痕迹
 │
 ├─ adapter.sync*
 │    ├─ 分批请求：每批记 http.request / http.response（含 bytes / elapsedMs）
 │    ├─ 每批解析：记 adapter.*.batch（requested / parsed / skipped）
 │    └─ 失败重试：记 http.retry（原因 + 等待时长）；最终失败记 http.fail
 │
 ├─ ingestOffers()
 │    └─ 逐条 offer：
 │         ├─ ensurePlatform / ensureGame / upsertAlias（别名表记 match_method）
 │         ├─ findOffer → insert 或 update
 │         ├─ lastSnapshotHash 对比 → 不同才 insertSnapshot
 │         └─ upsertDaily（LEAST(旧, 新) 取当天最低）
 │
 ├─ finishFetchRun()：回填 requests / ok / skipped / failed / status
 └─ sync.done + ingest.summary：一行看全量结果
```

关键点：**`fetch_runs` 在开始时就写一行，结束时回填**。这样即使进程被 kill，也能看到"有一轮跑了但没结束"，而不是什么都没有。

## 4. 数据模型的三次决策

### 4.1 为什么 `offers` 和 `price_snapshots` 要分开

- `offers` 回答"现在多少钱"：每个 (game, platform, type, region) 唯一一行，查询高频、数据量小。
- `price_snapshots` 回答"曾经多少钱"：只追加，**价格没变就不写**。

如果不分开，每次查询当前价都要在几千万行里做窗口函数；如果不做"变化才写"，一年会灌入 `3000 游戏 × 24 次 × 365 天 ≈ 2600 万行` 的冗余。

判重靠 `raw_hash`：只对 `priceCents | originalCents | discountPct | inStock` 做 SHA-1，`buyUrl` 变化不会产生新快照（它不影响价格）。

### 4.2 为什么区服是独立维度

国区 ¥298、全球 $60、土区 ₺1200 不是"同一个东西的不同价格"——它们对应不同的激活限制、支付方式和合规风险。用一个 `price` 字段糊在一起，最低价就一定是错的。

因此唯一键是 `(game, platform, product_type, region)`，查询必须显式带上 region。

### 4.3 为什么 DATE 要当字符串

`pg` 默认把 `date` 解析成 JS `Date`（本地时区午夜）。跨时区时 `2026-10-26` 可能变成 `2026-10-25T16:00:00Z`，于是：

- 按天聚合会把同一天拆成两天；
- 史低比较会差一天。

两层修：存储层注册 identity parser（`pg.types.setTypeParser(1082, v => v)`），SQL 里统一 `::text`。**这条踩过，不是理论风险。**

## 5. 失败模型

| 场景 | 行为 | 为什么 |
|---|---|---|
| 单条 offer 入库失败 | 捕获、记 `ingest.offer_failed`、继续下一条 | 一条脏数据不该让整轮作废 |
| 单个平台采集失败 | 子进程非 0 退出，调度器记 `scheduler.job_failed` 并继续 | 平台之间彼此独立 |
| 采集中途进程被杀 | `fetch_runs` 留一行"未完成" | 能看到"跑过但没跑完" |
| 数据库连不上 | `DB_WAIT_SEC` 内重试，超时才失败 | 容器编排下 db 可能比 app 晚就绪 |
| **没有**用长事务 | 每条语句自动提交 | 幂等 upsert 下，中途失败下一轮自愈；长事务反而容易占死连接池 |

**已知缺口**：没有失败熔断。某个源连续 403 时，调度器仍会按间隔重试。日志里能看到（`http.fail` 连续出现 + `fetch_runs.status=failed`），但目前需要人工把 `*_ENABLED=0` 关掉。这条列在路线图里。

## 6. 日志模型

### 事件命名

`域.动作`，域固定为：`http` / `db` / `adapter.<平台>` / `ingest` / `sync` / `scheduler` / `diagnose` / `process`。

用 `logs --event http` 这种前缀过滤就依赖这个约定，所以**新增事件不要自创域**。

### 一次请求的完整痕迹

```
http.request   {label, requestId, attempt, url}
http.response  {label, requestId, status, bytes, elapsedMs, contentType, finalUrl}
http.retry     {label, requestId, attempt, delayMs}
http.error     {label, requestId, code, hint, status, bodySnippet, retryable}
http.fail      {label, url, code, hint}          ← 最终失败
```

`requestId` 是单次尝试的随机串，`runId` 是整个命令。排障顺序：先按 `runId` 看全貌，再按 `requestId` 看某次请求细节。

### 脱敏规则

| 情况 | 处理 |
|---|---|
| 键名匹配 `token` / `cookie` / `apikey` / `secret` / `password` | 值替换为 `***` |
| 值是 URL 形态（`postgres://user:pw@host/db`） | 只抹密码，保留 host 与库名 |
| URL 查询参数名含 `key` / `token` / `sign` | 值替换为 `***` |

保留 host 和库名是刻意的：排障时"连错库"和"密码错"是完全不同的两个问题，全抹掉就没法判断。

### 体积

正常一轮（3000 游戏，只记 info）大约 200–400KB/天；`trace` 级别会把每条 SQL 都记下来，量级上升到几十 MB——**生产不要开 trace**。

## 7. 加一个新平台

以 Fanatical 为例，四步：

1. **勘查**（不要凭猜）：
   ```bash
   node scripts/inspect.js https://www.fanatical.com/zh-cn/game/xxx
   node scripts/mine-bundle.js <页面引用的 JS>
   ```
   目的是回答：服务端渲染还是 SPA？价格在 HTML 还是内嵌 JSON？有没有公开 API？

2. **写适配器** `src/adapters/fanatical.js`：
   - 导出 `descriptor`（code / name / kind / defaultRegion / currency）
   - 导出 `fetchXxx()`，返回 `RawOffer[]`
   - 解析失败时记 `adapter.fanatical.*` 事件，并返回空数组而不是抛异常

3. **注册平台**：在 `src/store/pg.js` 的 `migrate()` 里加一行 `platforms`，`kind` 决定它能不能进主榜。

4. **写测试**：把真实页面存成 `test/fixtures/real-xxx.html`，对着它断言价格、名称、SKU id——**不要手写假 HTML**，那样测不出页面改版。

检查清单：

- [ ] 价格是整数分，没有浮点误差
- [ ] `region` / `currency` 正确
- [ ] 失败路径有日志且信息足够定位（带 URL、状态码、响应片段）
- [ ] 限速（默认 ≥1 秒/请求）
- [ ] 真实页面夹具 + 断言
- [ ] 更新 [DATA-SOURCES.md](DATA-SOURCES.md) 里的可达性表

## 8. 静态价格页（report.js）

`chart` 把 `daily_prices` 渲染成一套静态 HTML，而不是做一个 Web 服务。几个决定：

| 决定 | 理由 | 代价 |
|---|---|---|
| **静态生成**，不做服务端渲染 | 个人自用、数据只读、零运维：产物可以直接双击打开、丢静态托管、或挂到任意 CDN | 没有实时性，要重新生成 |
| **手写内联 SVG**，不引前端库 | 运行时依赖仍然只有 `pg` 一个；离线可用；单页 7KB | 没有交互（缩放、悬浮提示） |
| **渲染函数是纯函数** | 输入数据 → 输出字符串，不碰 DB；单测可以逐字断言 SVG | 数据组装逻辑落在 `buildSite` 里 |
| **所有外部文本必须 `esc()`** | 游戏名、平台名来自第三方站点，是**不可信输入**；不转义就是注入面 | 无 |

图表本身有两个容易做错的地方，都是实际调试出来的：

1. **Y 轴必须是"整数刻度"**。最初按数据范围 ±8% 后均分，刻度出来是 ¥83 / ¥141 / ¥199——数学正确但读不了。现在用 1/2/5 × 10ⁿ 的步长对齐（`niceStep`），标签才是 ¥50 / ¥100 / ¥150。
2. **价格全平时不能除零**。所有价格相同时 `yMax - yMin = 0`，必须给一段人工区间，否则坐标是 `NaN`，SVG 静默变成空白。测试里专门有这条断言。

## 9. 容量与性能

| 项 | 估算 |
|---|---|
| 游戏数（个人使用） | 10²–10³ |
| 快照年增量 | 变化次数 × 游戏数，通常 10⁵ 量级 |
| 单轮查询 | `lowestOffers` 走视图 + 索引，毫秒级 |
| 单轮采集 | Steam 3000 款 ≈ 50 分钟（1 请求/秒，批量 30），正好卡在"每小时"的物理上限 |
| PGlite 上的 DDL | 10–30 秒（wasm 编译成本，真实 PG 上是毫秒级） |

## 10. 已知技术债

1. **无失败熔断**（见 §5）。
2. **名称匹配是妥协**：杉果页面没有 Steam appid，只能用 `noAppId` 计数暴露问题，没有自动对齐算法。
3. **`ensureGame` 对无 appid 的游戏按名称去重**，同名不同游戏可能被合并——目前靠人工维护 SKU 清单规避。
4. **没有前端**：`daily_prices` 可以直接喂给静态页面，但接口层还没做。
5. **ITAD 结构未用真 key 验证**：有 shape mismatch 日志兜底，但首次接入仍需要人盯一次。
