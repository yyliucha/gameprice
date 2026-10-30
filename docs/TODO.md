# 待办总览（未完成事项清单）

> 最后更新：2026-10-30。这是**当前所有未完成事项**的总清单，接手会话先看这个，再看
> [DELIVERY.md](DELIVERY.md)（流程/发版）与 [UI-FIXES.md](UI-FIXES.md)（界面缺陷细节）。
> 完成一项就把标题改成 ~~删除线~~ 并标注完成版本。

---

## A. 立即待办（阻塞在"等指令 / 等部署"）

| # | 事项 | 现状 | 下一步 | 备注 |
|---|---|---|---|---|
| A1 | **v1.4.6 构建** | 代码已提交推 main（`b561854`），版本号 1.4.6，**tag 未打、构建未触发** | 收到所有者"构建 v1.4.6"指令后：`git tag -a v1.4.6 -m "…" && git push origin v1.4.6`，等 `docker-hub`/`docker-tcr` 双绿 | 硬规则 5：构建必须等人工指令 |
| A2 | **服务器升级到 1.4.6** | 服务器当前 **v1.4.5**（截图确认） | 构建双绿后按 [DELIVERY.md 第 4 节](DELIVERY.md#4-部署到服务器)执行（TCR tag 用 `1.4.6`）；注意 compose 文件名不是 compose.yaml | 部署后控制台「同步与回填」才会变成精简版 |
| A3 | **rename 数据验收** | 名字修复已上线 1.4.5，`rename` 在每次启动 +2h 自动跑一轮（约 50 分钟） | 跑完后执行验收脚本（DELIVERY 第 4 节 / 验证命令），预期 `有中文名` 从 11,420 → 10 万+ | 若数字不涨，抓 `docker logs` 里 `rename.done` 的计数 |

## B. 已提出、尚未实现的功能

### B1. 时间字段时区设置化（2026-10-30 提出，未动代码）

**需求**：把"系统时间基准"做成可配置设置（例如东八区），让**记录与展示**的时间都是东八区。

**现状（已勘察）**：

- 所有时间列都是 `timestamptz`（PostgreSQL 内部存 UTC 瞬间，读/显示按**会话时区**换算）。
- 日期归属依赖 DB 会话时区：`daily_prices.day` 写入用 `current_date`（[pg.js:670](../src/store/pg.js)），
  按天聚合用 `date_trunc('day', captured_at)::date`（[pg.js:614](../src/store/pg.js)），
  访客统计用 `date_trunc('day', now())`（[pg.js:1397-1399](../src/store/pg.js)），
  发行时间筛选用 `current_date - interval`（[pg.js:956-958](../src/store/pg.js)）。
- 应用从不显式设置会话时区：`openStore` 只建连接池（[store/index.js](../src/store/index.js)），
  时区取决于**外部 PostgreSQL 的默认时区**（生产是 118.25.114.250 的库，不受 compose `TZ` 控制）。
- 日志时间是 UTC：`ts: now.toISOString()`、日志文件按 UTC 日期分片
  （[log.js:145-149](../src/log.js)），控制台行只截取 ts 的时间段（[log.js:93-102](../src/log.js)），
  所以 `docker logs` 里看到的是 UTC（如 08:05 实际是北京 16:05）。
- 前端各页面 `dateTime()` 用浏览器本地时区格式化（`AdminModules.vue` / `AdminExtras.vue` /
  `Console.vue` / `Home.vue` 各自定义），不是"站点设置时区"。

**建议方案（未实现，待确认）**：

1. 新增设置 `system.timezone`（env `TZ`，默认 `Asia/Shanghai`，group `advanced`），
   写完水合回 `process.env.TZ`。
2. **数据库会话时区**：`openStore(target, { timezone })` 里给连接池加
   `options: '-c timezone=Asia/Shanghai'`（pg），PGlite 用 `set time zone '<tz>'`（tz 需白名单校验）；
   `current_date` / `date_trunc` / psql 显示随之成为东八区。**保持 `timestamptz`，不要改 `timestamp`**
   （后者丢时区信息，夏令时/换时区必错，且要迁移历史数据）。
3. **日志**：`log.js` 的 `ts` 输出带偏移的 ISO（如 `2026-10-30T16:42:23+08:00`），
   日志文件按**本地日期**分片；`fmtConsole` 的 `[HH:MM:SS]` 取本地时间。
4. **前端展示**：把时区通过 `/api/me` 或公共配置接口下发，各页 `dateTime()` 用
   `Intl.DateTimeFormat('zh-CN',{timeZone: tz, hour12:false})` 而非浏览器本地。
5. **测试要改**：`test/settings.test.js:23`（设置项 50 → 51）、`test/log.test.js`（ts 格式）、
   `test/store.test.js`（会话时区生效）。
6. **生效方式**：会话时区在**新连接**上生效；设置变更后建议重启服务（或在池的 `connect` 事件里动态应用）。

**待确认（拍板后再动手）**：

- 确认"记录为东八区"指的是**展示/按天归属**（timestamptz + 会话时区即可），不是把列改成无时区的本地时间；
- 改设置后是否接受"重启生效"，还是要求热生效（热生效需要在每个连接上重置时区）。

## C. 线上问题 / 需要探测

| # | 事项 | 现状 | 下一步 |
|---|---|---|---|
| C1 | **heat 逐 appid 全 `success:false`** | 线上 heat 请求返回全 `success:false`（日志"无效跳过 30"），疑似 `l=schinese` 与 `l=zh` 的差异或 `filters=recommendations,release_date` 被拒 | 在服务器跑一条最小探测：`docker exec steamdeals node --input-type=module -e '…fetchText appdetails…'`，对比不同 `l` 参数与 filters 组合的响应；确认后改 `heat` 的 URL 参数 |
| C2 | 服务器 compose 文件名 | 实际文件名不是 `compose.yaml`（历史 sed 报不存在） | `cd /home/ubuntu/steamdeals && ls compose*.*` 确认后写入本文 |

## D. 文档中挂着、但优先级低或已决定不做

| # | 事项 | 状态 |
|---|---|---|
| D1 | `pg_trgm` 搜索索引 | 未做，需要生产 `EXPLAIN ANALYZE` 数据（当前 `like '%kw%'` 114.87ms，阈值 150ms）；见 [ROADMAP](ROADMAP.md) |
| D2 | 图片缓存总量上限 | 可选未做（当前靠 `IMAGES_LIMIT` 控制每轮数量） |
| D3 | `app_type` 全量回填 | **已决定放弃**（v1.4.3 起 GetItems 的 `type` 枚举已正确写入，新数据会自动带类型） |
| D4 | 侧栏「版本」徽标位置修复 | 已定位、方案已写，**待改代码**；见 [UI-FIXES.md 第 1 条](UI-FIXES.md#1-后台侧栏版本检测被挤出侧栏底部v145-实测)（建议随下个版本一起发） |

## E. 流程约束（不要再踩）

- **构建必须等所有者明确指令**（硬规则 5，见 [CONTRIBUTING.md](../CONTRIBUTING.md)）：日常只提交推 `main`，
  **不得自行打 tag / 触发 CI 构建**。
- **服务器操作由部署人员执行**（硬规则 4）：开发侧不碰服务器。
- 新功能必须同步进调度器（硬规则 3），人工命令只作调试手段。
