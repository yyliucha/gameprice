# 贡献指南

这是个人自用项目，不追求通用性。但改动请遵守下面五条硬规则，否则会被打回。

## 五条硬规则

**1. 任何改动都要有可执行的验证**

```bash
node test/log.test.js
node test/adapters.test.js
node test/sonkwo.test.js
node test/pg.test.js
node test/scheduler.test.js
node test/deploy.test.js
node test/docs.test.js
node test/secrets.test.js
```

全部通过才算完成。**没有跑过验证就说"改好了"是最严重的问题**——这个项目里已经出现过三次"代码看起来对、数据其实错"的情况（见 [CHANGELOG](CHANGELOG.md#修复)）。

提交前再跑一次凭据扫描：

```bash
npm run scan
```

它检查 token、私钥、带真实密码的连接串；文档里的 `postgres://user:pass@host` 这类示例会被自动识别为占位符，不会误报。若某个文件确实需要包含假凭据（例如扫描器自己的测试），在文件头 5 行内写 `scan-secrets: ignore-file`，豁免会被打印出来而不是静默跳过。

**2. 改采集逻辑必须写日志**

判据很简单：**别人只看日志，能不能定位到这个错误？**

- 新事件用 `域.动作` 命名，域只能取 `http` / `db` / `adapter.<平台>` / `ingest` / `sync` / `scheduler` / `diagnose` / `process`
- 失败路径必须带可判断原因（URL、状态码、响应片段、错误码），不能只写 "failed"
- 敏感值不要手写进日志，交给 `src/log.js` 的脱敏规则

**3. 新命令/新数据任务必须同步进自动调度**

项目的最终目标是**纯系统跑：部署后不需要任何人去服务器执行命令**。所以：

- 新增 CLI 命令如果属于数据维护/采集/回填类，必须同时在 [src/scheduler.js](src/scheduler.js) 的
  `jobsFromEnv` 里加一个定时任务（参数、间隔、首轮延迟都要有环境变量可调），
  并在 [test/scheduler.test.js](test/scheduler.test.js) 里断言它的默认参数与开关行为
- 人工命令只允许作为**调试手段**或**控制台快捷入口**存在，不允许成为"上线后必须手工跑一遍"的步骤
- 一次性初始化（如目录导入）要么做成调度器的幂等任务（条件自判、没活秒退），
  要么写进 bootstrap；不要指望用户记得手动执行
- 违反这条的改动视为"功能没做完"，直接打回

**4. 服务器操作不在开发侧执行**

服务器更新（SSH、拉镜像、重建容器）**由具备服务器权限的部署人员执行**：

- 仓库与开发侧不保存任何服务器凭据，也不直接操作服务器；开发侧的职责到
  「代码提交 + 打 tag 触发 CI」为止
- 服务器步骤统一以 [docs/DEPLOY.md](docs/DEPLOY.md#发布与升级流程从提交到上线) 的
  「发布与升级流程」为准（拉镜像、重建容器、验证、回滚都有现成命令）
- 新命令/新任务并入调度器后，发布说明里只需要写「升级后系统会自动跑」，
  不需要给部署人员安排任何一次性数据命令

**5. 构建与发版必须等人工指令**

- 打 tag 并 push 会触发 GitHub Actions 构建并推送镜像（`docker-hub` / `docker-tcr`）。
  **只有项目所有者明确下达"构建 vX.Y.Z"的指令后才能执行**——自动化流程、代理、协作者
  一律不得自行打 tag 或触发构建
- 日常改动只提交并推送 `main`；推 main 不触发构建，tag 与构建时机由人决定
- 代码就绪但未获准构建时，把"待发版"状态写进 [docs/DELIVERY.md](docs/DELIVERY.md)
  末尾的「当前状态」，等指令再执行

## 会话协作约定（模型分工）

- **讨论需求、方案、取舍**用 DeepSeek-V4.1-Flash1017；**开发实现**（写代码/测试/文档、跑验证）用 DeepSeek-V4-Pro。
- 本约定只约束会话分工，不影响产物质量要求（五条硬规则对两个阶段同样生效）。

## 开发环境

```bash
npm install
node test/log.test.js          # 先确认环境可用

# 没有 PG 服务器时用内置嵌入式 PG
node src/cli.js init --db pglite:./data/pgdata
node src/cli.js seed --db pglite:./data/pgdata
```

真实 PG 用 `DATABASE_URL` 指定；目标版本是 **15.x**，不要使用 16+ 专有语法（`any_value`、`json_table` 等）。

## 提交规范

```
<type>(<scope>): <subject>

<body 可选：说明为什么，而不是做了什么>
```

- `type`：`feat` / `fix` / `refactor` / `test` / `docs` / `chore`
- `scope`：`steam` / `sonkwo` / `itad` / `store` / `ingest` / `log` / `scheduler` / `deploy`

例：`fix(sonkwo): 按 sku_id 取价，避免拿到邻近版本的价格`

## 新增一个采集平台

按 [ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-加一个新平台) 的四步走，重点：

- **先勘查再写代码**：`scripts/inspect.js` 判断渲染方式，`scripts/mine-bundle.js` 从 JS 包里挖接口。不要凭猜写选择器。
- **夹具用真实页面**：把抓下来的 HTML 存进 `test/fixtures/`，对着它断言。手写假 HTML 测不出改版。
- **遵守限速**：默认 ≥ 1 秒/请求，不要并发轰炸。
- **同步更新** [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) 的可达性表。

## 文档约定

- 文档内引用其它文件用相对路径（`docs/xxx.md`、`src/xxx.js`），`test/docs.test.js` 会校验链接有效性，断链会让测试失败。
- 描述"为什么"优先于"怎么做"；已知限制要写清楚，不要藏。
- 中文文案统一用中文全角标点。

## 不接受的改动

- 引入 C2C 数据进主榜（违反结构约束）
- 未经勘查就写死的第三方接口
- 没有失败日志的采集逻辑
- 引入重量级依赖（这个项目刻意保持依赖极少：运行时只有 `pg`）
