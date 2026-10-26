# 贡献指南

这是个人自用项目，不追求通用性。但改动请遵守下面两条硬规则，否则会被打回。

## 两条硬规则

**1. 任何改动都要有可执行的验证**

```bash
node test/log.test.js
node test/adapters.test.js
node test/sonkwo.test.js
node test/pg.test.js
node test/scheduler.test.js
node test/deploy.test.js
node test/docs.test.js
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
