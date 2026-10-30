# 开发到交付全流程（会话交接文档）

> 本文是**新会话的接线手册**：接手项目先读这里，再读 [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md)（架构与代码落点）
> 和 [ROADMAP.md](ROADMAP.md)（决策与待办）。发版前必读「对外描述同步」规则。
>
> **最后更新：2026-10-30（v1.4.3 已发布：tag v1.4.3，docker-hub 与 docker-tcr 双绿，镜像已推送）。若你读到的时间晚于最近提交，先看 CHANGELOG 与 git log。**

---

## 0. 一分钟看懂项目

- 仓库：`github.com/yyliucha/steamdeals`，主分支 `main`，本地 `F:\dsh\gameprice`（Windows）。
- 技术栈：Node ≥22.5（ESM）+ PostgreSQL 15 + Vue 3/Vite/Element Plus（`frontend/`，产物 `frontend/dist` 不入库）+ Docker Compose。
- 线上：生产库 19.6 万条目（有国区报价 10.6 万）；TCR 镜像 `ccr.ccs.tencentyun.com/tcb-100003189690-pljp/steamdeals:<版本>`，Docker Hub `s1065420329/steamdeals:<版本>`。
- 版本历史：… 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.4.1 → 1.4.2 → 1.4.3 → 1.4.4（详见 CHANGELOG）。

## 1. 开发环境与日常开发

```bash
cd F:\dsh\gameprice
npm install                    # 依赖（vite/element-plus 在 devDependencies）
node src/cli.js serve --port 8090   # 全栈服务；无 DATABASE_URL 时用嵌入式 PG（pglite:./data/pgdata）
npm run frontend:dev           # 另开终端：Vite 5174，/api 代理到 8090，改前端即热更
```

- 本地数据库是 `pglite:./data/pgdata`（wasm PG，仅开发验证；生产是 118.25.114.250 的 PostgreSQL）。
- 本机**无 Docker、无 Steam 出口**：采集/回填类命令本地会网络失败（预期），线上才真正验证。
- 前端页面全在 `frontend/src/pages/`；路由 `frontend/src/router/index.js`；全局样式与主题 token 在 `frontend/src/styles/main.css`（亮暗色通过 `html.dark` + CSS 变量切换，`composables/useTheme.js`）。

## 2. 改动前必须知道的规则

1. **先读 `docs/PROJECT-OVERVIEW.md` 的「后续开发的必做收尾」**：改完功能要同步总览/专项文档/README，不允许"代码新、文档旧"。
2. **发布必做「对外描述同步」**：每次打 tag 发版，按发布时点的真实功能更新 README（功能表/命令参考/环境变量/已知限制）、`docs/` 各文档、CHANGELOG，以及 **GitHub 仓库 About/description 与 topics**（`gh repo edit yyliucha/steamdeals --description "..."`）。
3. **任何改动都要有可执行的验证**：`npm test` 全绿 + 相关链外测试 + 前端改动跑 `npm run frontend:build`。改动 `web/*.html` 还要跑 `node scripts/check-html-syntax.mjs web/index.html web/console.html web/setup.html`。
4. **写日志**：新增采集/后台逻辑用 `域.动作` 事件名，失败路径带原因。
5. **测试分两链**：主链 `npm test`（44 个文件）；链外 `test/email-auth.test.js`、`test/api.test.js`、`test/cli-dispatch.test.js` 改相关代码时单独跑。
6. 凭据扫描 `npm run scan`（公开仓库前自检）。

## 3. 提交与发版（构建镜像）完整步骤

**构建镜像 = 打 annotated tag 并 push。** 推 tag 自动触发两个 GitHub Actions workflow，不需要手工跑 docker。

```bash
cd F:\dsh\gameprice
# ① 验证
npm test && npm run frontend:build && npm run scan
node test/api.test.js          # 若动过 API/权限/标记

# ② 文档同步（对外描述同步规则）
#    - CHANGELOG.md 顶部加新版本条目（## [X.Y.Z] - 日期，Keep a Changelog 格式）
#    - README/docs 里过时的描述一并更新

# ③ 版本号（改 package.json + package-lock.json，不自动打 tag）
npm version <X.Y.Z> --no-git-tag-version

# ④ 提交并推送 main
git add -A
git commit -m "feat(范围): 摘要"
git push origin main

# ⑤ 打 annotated tag 并推送（= 触发构建）
git tag -a vX.Y.Z -m "SteamDeals X.Y.Z：<一句话摘要>"
git push origin vX.Y.Z

# ⑥ 盯 CI（gh 先切到有 workflow 权限的账号）
gh auth switch --user yyliucha
gh run list --limit 2
```

### 版本号规则

- **X.0.0**：大版本（如全面换前端 = 1.0.0）。
- **X.Y.0**：新功能 / 用户可见行为变化。
- **X.Y.Z**：纯修 bug / 参数修正（如 1.4.1、1.4.2 都是热修复）。
- tag 命名固定 `v` 前缀；每次发版**恰好一个 tag**，改完再发就是下一个 patch/minor。

### CI 会发生什么（对方最关心）

- 两个 workflow 都先跑 `npm ci + npm test + 前端在 Docker 多阶段里 vite build`（`frontend/dist` 不入库，镜像内构建）。
- `docker-hub`：test + **smoke job**（真实构建镜像 → 起容器连外部 PG → 走 `/api/setup/complete` 完成初始化）→ 推送 amd64+arm64 到 Docker Hub。
- `docker-tcr`：test → 推送 linux/amd64 到腾讯云 TCR（`latest` / `<版本>` / `sha-<commit>` 三个 tag）→ `Verify manifests` 确认镜像真实存在。
- 耗时：docker-hub 约 5–7 分钟；docker-tcr 约 8–25 分钟（跨境推送波动）。
- **判断成功**：`gh run view <run-id> --json jobs` 看 publish job 的 `Run docker/build-push-action@v6` 和 `Verify manifests` 都是 success。查完 `gh auth switch --user boxiang-sun_shortcut` 切回默认账号。

## 4. 部署到服务器

> **服务器操作边界（硬规则 4，见 CONTRIBUTING.md）**：服务器更新由**具备服务器权限的部署人员**执行；
> 仓库与开发侧不保存服务器凭据、不直接操作服务器。开发侧职责到「提交 + 打 tag」为止。
> 通用流程（Hub/TCR 两种源的 pull/up、验证、回滚）见
> [DEPLOY.md 的「发布与升级流程」](DEPLOY.md#发布与升级流程从提交到上线)，本节是**这台生产服务器**的具体执行版。

服务器：`ubuntu@VM-0-6-ubuntu`（118.25.114.250），项目目录 `/home/ubuntu/steamdeals`。
**注意：compose 文件名不叫 compose.yaml**（历史上 sed compose.yaml 报不存在）；先确认：

```bash
cd /home/ubuntu/steamdeals
ls compose*.*
docker compose config --images   # 看当前实际用的镜像 tag
```

用真实文件名替换 tag 并部署（TCR 的可用 tag：`latest`、`sha-<完整40位提交号>`、`<git tag 版本号>`——
以 CI 实际推送为准，先 `docker manifest inspect ccr.ccs.tencentyun.com/tcb-100003189690-pljp/steamdeals:<tag>` 确认存在）：

```bash
sed -i 's#tcb-100003189690-pljp/steamdeals:[^" ]*#tcb-100003189690-pljp/steamdeals:sha-<完整40位提交号>#' <真实 compose 文件名>
docker compose pull app && docker compose up -d app
docker exec steamdeals node -p "require('./package.json').version"   # 期望输出新版本
```

回滚：把 tag 换回上一个已部署版本（如 1.4.0）再 pull/up。

### 部署后验证清单

1. `GET /` 是新 Vue 首页；目录大数字（约 19.7 万）+「其中有报价 N」。
2. 后台 `/console`：侧栏版本号、热度回填卡片、中文 locale（无 Total/Go to/Select）。
3. 封禁页 `/banned` 与申诉页 `/appeal` 可打开且带样式。
4. 日志：`docker logs --tail 100 steamdeals` 无 error 刷屏。

## 5. 数据任务与自动化（哪些命令不用手工跑）

调度器（容器内 `RUN_MODE=all` 会随 app 常驻）**自动**执行：

| 任务 | 频率 | 说明 |
|---|---|---|
| `sync steam-prices` | 每天 | 刷新已有 Steam 报价（`STEAM_PRICE_INTERVAL_MIN`） |
| `sync catalog` | 每周 | Steam 全量目录同步（幂等），**新游戏自动进库**；需 `STEAM_API_KEY`，没配则该任务不出现 |
| `backfill` 增量回填 | 每周 | 给新游戏补元数据/说明/价格；有说明+报价的自动跳过，没活秒退（`STEAM_BACKFILL_LIMIT` 默认 20000） |
| `heat` 热度回填 | **每天**（v1.4.3 起） | 首轮自动全量播种（每天 2 万款 ≈ 9.4h，19.6 万款约 10 天播完）；之后只刷"过期 7 天且有报价"的条目 |
| `rename` 名字重写 | 每周 | 机器英文名补中文（英文挪进 name_en）；选择条件自带收敛，没活秒退 |
| `prune` 定期清理 | 每周 | 访问记录 180 天 / 采集与任务 90 天 / 验证码 7 天 |
| `images pull` / `backup` / `alerts` | 定时 | 封面缓存 / 每日备份 / 到价提醒 |

Steam 重任务（价格/目录/回填/热度/改名）与后台手动任务**互斥**，不会并行抢限流；
`rename` / `backfill` 成功后自动重建静态页。

**仍需手工**：`/setup` 首次初始化（一次性）、`diagnose`、`proxy-check`（排查工具，出问题才用）。
**不要再手工执行** `rename` / `heat` / `backfill` / `sync catalog`——调度器会自动跑（早期运维习惯中的手工
`docker exec … heat --limit 200000` 等命令已被 v1.4.3 的调度任务取代）。

## 6. 排障速查（历次踩坑汇总）

- **容器里没有 curl**：用 `docker exec steamdeals node --input-type=module -e '...'` + `/app/src/http.js` 的 `fetchText`（自动走 `STEAM_PROXY`）。
- **bash 双引号里的 `!` 会历史展开**（`!String: event not found`）：脚本外层用单引号。
- **Steam appdetails 批量规则（2026-10-30 实测）**：`appids` 多于 1 个时**只接受 `filters=price_overview`**；无 filters 或 `filters=recommendations` 都 400；单 appid 才支持 recommendations（69 字节）。热度因此逐 appid 请求。
- **Steam 配额**：200 次/5 分钟；价格回填跑起来就是 ~176 次/5 分钟，别再并行开热度/探测。
- **代理并发满**表现为 `UND_ERR_CONNECT_TIMEOUT`（不是批量问题）；`node src/cli.js proxy-check` 看 TCP/CONNECT/实际请求三段。
- **429**：后台回填/热度 `STEAM_429_RETRIES=Infinity`，冷却 30 分钟→1 小时→2 小时→…→6 小时自动重试；日志 `http.rate_limit_pause` 表示在等待，不是卡死。
- **搜索性能基准**：`like '%kw%'` count 在生产 EXPLAIN 是 114.87ms（并行全表扫）；暂不上 pg_trgm，超 150ms 再上。
- **生产库**：`docker exec -i steamdeals sh -c 'cat > /tmp/count.mjs' <<'EOF' … EOF` 方式传入脚本（见 ROADMAP 探测记录）；数据库只读诊断先跑 `node src/cli.js stats`。

## 7. 会话交接模板（每个会话结束时填）

复制本节填好，作为下个会话的开场白：

```
【项目状态】版本 <X.Y.Z>，HEAD <短哈希>，工作区是否干净；最新 tag 与已构建镜像列表
【本次做了什么】按提交/文件列出，标注"已发布 / 已提交未发布 / 未提交 WIP"
【线上状态】服务器部署版本、数据任务是否在跑（heat/backfill）、已知异常
【待办】下一批要做的 + 依赖的前提（如需要生产数据/用户拍板）
【踩坑】本次新发现的坑（补充进本文第 6 节）
【验证】跑过哪些测试/命令与结果
```

---

### 当前状态（2026-10-30 更新，v1.4.4 已发布）

- 已发布：**v1.4.4**（tag `v1.4.4` → 提交 `136a824`；`docker-hub` 与 `docker-tcr` 双绿，2026-10-30 确认）：
  修复 TCR 版本 tag 取 package.json 的坑（改为打 tag 触发时取 git tag），并 `npm version 1.4.4`
  对齐 package.json。**TCR 上现在有 `1.4.4` / `latest` / `sha-136a824ae228d7fc28a735a345faa6a1e7cf3c3a` 三个 tag**，
  Docker Hub 有 `1.4.4` / `1.4` / `latest`。镜像内 package.json = 1.4.4，控制台版本号正确。
- 上一个版本 v1.4.3（`37baea6`）含名字修复全套 + rename/catalog/backfill 调度 + heat 每天播种。
  其 TCR 镜像只有 latest / 1.4.0 / sha-37baea6f6035f43f10d51dd3b040be9eee70e15e（当时版本 tag 取 package.json 的坑，
  已在 1.4.4 修复）。**服务器升级直接用 1.4.4**，不需要再用 v1.4.3。
- 工作区：干净；HEAD `136a824`，已同步 origin。
- 待部署：服务器仍跑旧镜像，**更新由部署人员按第 4 节执行**（tag 用 `1.4.4` 或 `latest` 或 `sha-136a824…`）。
  部署后自动时序：+10min steam-prices → +1h catalog/heat → +2h rename（全量重写名字，约 50 分钟）→ +3h backfill。
  验收：`games` 表有中文名的行数从 1.14 万涨到 10 万+（SQL 见「发布与升级流程」验证节）。
- 待定位：线上 heat 逐 appid 请求返回全 `success:false`（"无效跳过 30"），疑似 `l=schinese` 与 `l=zh` 或
  `release_date` filter 差异；诊断日志已加，等探测结果。
- 已修未发（在 main，未打 tag）：状态文件 `scheduler-status.json` 的 `nextRunAt` 对从未跑过的任务按间隔显示
  （首轮 rename 显示成一周后），已改为按 `initialDelaySec` 计算（含测试）。**下次发版随包带上即可，不影响任务实际触发时间。**
- 部署提醒：服务器 compose 文件名待确认（非 compose.yaml）。
