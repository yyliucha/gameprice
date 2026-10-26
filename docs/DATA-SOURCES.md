# 数据源验证记录

> 2026-10-26 实测，从当前这台开发机直接请求。结论会变，重跑 `scripts/hit.js` 即可复核。

## 结论速览

| 来源 | 可达 | 取数方式 | 结论 |
|---|---|---|---|
| Steam 国区 | ❌ 连接超时 | `store.steampowered.com/api/appdetails` | **本网络不可用**，需代理或改走 ITAD |
| Steam API 域名 | ❌ 连接超时 | `api.steampowered.com` | 同上 |
| 杉果 sonkwo | ✅ 200 | 服务端预渲染 HTML | **可用**，价格在 HTML 里，但搜索接口是坏的 |
| SteamPy | ✅ 200 | Vue2 SPA + `/xboot/*` 接口 | **登录墙**：所有商品接口返回 401 |
| IsThereAnyDeal | ✅ 403 | 官方 REST API | **可用，需注册 API key**（个人免费） |
| Fanatical | ✅ 200 | 服务端 HTML | 可用 |
| Humble Bundle | ✅ 200 | 服务端 HTML | 可用 |
| GOG | ✅ 200 | 服务端 HTML（中文站） | 可用 |
| GreenManGaming | ❌ 超时 | — | 本次不可用 |
| 小黑盒 | ✅ 200 | SPA 空壳（3.5KB） | 需逆向 `hkey` 签名，暂不做 |

## 细节

### Steam — 不可达
`store.steampowered.com` / `api.steampowered.com` 均 `UND_ERR_CONNECT_TIMEOUT`（20s）。
同网络下 baidu 1 秒内 200，所以不是本机没网，是目标被阻断。
**影响**：`src/adapters/steam.js` 的代码是对的，但在这台机器上跑不出数据。三条出路：
1. 给采集进程配代理（`HTTPS_PROXY`，Node 18+ 的 fetch 不认这个变量，需要显式 dispatcher）
2. 用 ITAD 拿 Steam 价（它聚合了 Steam 各区域价）
3. 把采集部署到能访问 Steam 的机器/容器

### 杉果 — 可用，但只能按 SKU 抓
- 站点已从 `songguo.com` 迁到 **`sonkwo.cn`**（商品页在 `sonkwo.hk`）
- 框架是 **Remix**（不是 Next/Nuxt/CRA）
- 首页、商品页、活动页都是**服务端预渲染**
- **商品页里嵌了 `window.__remixContext`**，含结构化商品数据，优先解析它：

```
"sku_id":111454, "key_type":"steam_key", "product_id":11473,
"region":"cn", "area":"abroad",
skus: [
  { "id":111454, "sale_price":198, "sku_names":{"chs":"愚者不灭"} },
  { "id":111455, "list_price":269, "sale_price":269,
    "sku_names":{"chs":"愚者不灭：荣光痴人版"} }
]
```

  两个坑（都踩过并已修）：
  1. 数组元素里标识字段有时叫 `sku_id`、有时只有 `id`，按 `sku_id` 找会全漏
  2. 页面顶部先渲染的是**别的版本**的价格（￥269），直接取第一个 `SKC-sale-price` 会拿到错的数。JSON 里按 `sku_id` 精确取才能拿到本 SKU 的 ￥198
- DOM 兜底只在没有 JSON 时启用，且必须取"购买区"块（`SKC-sku-sale-block`）而不是页面上第一个价格
- 搜索页 `store/search?keyword=` 的 loader **服务端报错**（`_data=` 返回 400），`/api/*` 返回 410 已废弃 → **没有可用的搜索接口**
- **商品页里没有 Steam appid**，跨平台对齐只能靠名称匹配
- robots.txt 全部注释掉，未禁止抓取

> 采集路径：先拿到 SKU id（`data/skus.json` 人工维护），再按 id 抓商品页。

### SteamPy — 登录墙
- Vue2 SPA，接口在 `https://steampy.com/xboot/`（同源，非独立 API 域名）
- 已确认的接口（来自 `js/app.8bed18e9.js`）：
  - `GET /steamGame/saleKeyByName`、`GET /steamGame/keyByName`、`GET /steamGame/listHot`、`GET /steamGame/getOne`
  - 分区镜像：`/arsSteamGame/`（阿根廷）、`/ruSteamGame/`（俄）、`/usSteamGame/`（美）、`/tlSteamGame/`（土）
- 全部返回 `{"success":false,"code":401,"message":"您还未登录"}`（HTTP 200 + 业务码 401）
- 鉴权头 `accessToken`（cookie）+ `APP_TOKEN`（桌面端为空）
- C2C 性质：卖家挂单，价格随库存变动

### ITAD — 缺 key
`api.isthereanydeal.com` 返回 403，响应体明确写着 `{"status_code":403,"reason_phrase":"Invalid or expired api key"}`。
需要去 <https://isthereanydeal.com/apps/my/> 注册应用拿 key，设到 `ITAD_API_KEY`。
条款要点：可商用但**不得与 ITAD 竞争**、不得改价/去掉联盟参数、必须标注来源。个人自用免费。

> 接口形状（`/games/search/v1`、`/games/prices/v3`）是按官方文档实现的，**尚未用真 key 跑过**。
> 配好 key 后执行 `node src/cli.js sync itad --limit 3`，若结构不符会记 `adapter.itad.shape_mismatch`，日志里带原始响应片段。

## 复现命令

```bash
node scripts/hit.js GET "https://store.steampowered.com/api/appdetails?appids=730&cc=cn"
node scripts/hit.js GET "https://www.sonkwo.cn/publisher_activity/10546"
node scripts/hit.js GET "https://steampy.com/xboot/steamGame/listHot"
node scripts/hit.js GET "https://api.isthereanydeal.com/games/search/v1?title=elden"
```

## 现场勘查工具

```bash
node scripts/inspect.js <url>                 # 判断渲染方式、找价格/接口线索
node scripts/hit.js GET|POST <url> [json]     # 打点：状态/类型/大小/前 300 字符
node scripts/mine-bundle.js <js-url>          # 从打包 JS 里挖 baseURL 和接口路径
node scripts/find-api.js <html> --base <url>  # 从页面引用的脚本里批量挖接口
node scripts/extract.js <file> <regex>        # 从保存的页面里正则提取
```
