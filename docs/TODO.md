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

### B1. ~~时间字段时区设置化~~（2026-10-30 提出）→ **已实现（v1.4.6）**

**需求**：把"系统时间基准"做成可配置设置（例如东八区），让**记录与展示**的时间都是东八区。

**落地内容（v1.4.6）**：

- 新增设置 `system.timezone`（env `TZ`，默认 `Asia/Shanghai`，见 [settings.js](../src/settings.js)）。
- 数据库会话时区随连接生效（[store/index.js](../src/store/index.js)：连接池 `options: -c timezone=…`
  + `connect` 事件 + `store.setTimezone()` 热更新；PGlite 同步支持；时区白名单校验，非法回落 Asia/Shanghai）。
  保存设置后 `settings-routes.js` / 调度器 revision 重载会调用 `setTimezone`，约 30 秒内新连接生效。
- 日志 `ts` 带偏移 ISO、文件按本地日期分片（[log.js](../src/log.js) 的 `tsInZone`）。
- 前端时间显示统一用站点时区（`/api/me` 下发 `timezone`，`frontend/src/utils/siteTime.js`）。

**遗留提醒**：改时区设置后**旧连接**仍是旧时区，重启服务保证全部生效；heat 的 C1 仍待探测。

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
| D4 | 侧栏「版本」徽标位置修复 | **已修（v1.4.6）**：徽标移到后台 header 右侧 + 侧栏底部两行布局与收缩约束；见 [UI-FIXES.md 第 1 条](UI-FIXES.md#1-后台侧栏版本检测被挤出侧栏底部v145-实测) |

## E. 流程约束（不要再踩）

- **构建必须等所有者明确指令**（硬规则 5，见 [CONTRIBUTING.md](../CONTRIBUTING.md)）：日常只提交推 `main`，
  **不得自行打 tag / 触发 CI 构建**。
- **服务器操作由部署人员执行**（硬规则 4）：开发侧不碰服务器。
- 新功能必须同步进调度器（硬规则 3），人工命令只作调试手段。
