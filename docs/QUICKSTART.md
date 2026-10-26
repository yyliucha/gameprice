# 云服务器部署教程（从零到跑通）

面向：一台全新的 Linux 云服务器（Ubuntu 22.04 / Debian 12 最顺），2 核 2G 起，20G 磁盘。
不需要域名，**默认不对外开任何端口**（它没有 Web 服务，只产出静态 HTML 和采集数据）。

---

## 0. 先明确它会占什么

| 资源 | 情况 |
|---|---|
| 端口 | 默认**不发布任何端口**；数据库只在 compose 内网可达 |
| 内存 | 常驻约 200–300MB（node 调度器 + postgres） |
| 磁盘 | 镜像约 250MB；数据每天几 MB（价格快照），一年量级 < 1G |
| 外网 | 需要能访问 杉果 / GOG / Humble；Steam 官方**国内大概率不通**（见第 8 节） |

---

## 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker                      # 或退出重登，让 docker 组生效

docker --version                   # 需要 ≥ 24
docker compose version             # 需要 ≥ 2.20（用到 depends_on.required）
```

国内拉镜像慢的话加个加速（地址失效就换一个）：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://docker.m.daocloud.io"] }
EOF
sudo systemctl restart docker
```

---

## 2. 拉代码

```bash
cd ~
git clone https://github.com/yyliucha/gameprice.git
cd gameprice
```

---

## 3. 建目录并修权限（**必做，跳过必挂**）

```bash
mkdir -p logs out                       # logs/ out/ 不在仓库里（gitignore 了），必须自己建
sudo chown -R 1000:1000 ./data ./logs
```

两个原因：

1. `logs/` 和 `out/` 被 `.gitignore` 排除，全新克隆**没有这两个目录**；
2. 容器以 `node`（uid 1000）运行，而 `./data`、`./logs` 是 bind mount。
   如果目录是 Docker 自动创建的（root:root），容器里写日志会 `EACCES`，报错藏在启动日志深处。

入口脚本会提前检查并直接告诉你修复命令。

---

## 4. 起服务

```bash
docker compose up -d --build
```

第一次会构建镜像，3–5 分钟（取决于网络）。启动顺序是自动的：

```
postgres 容器创建库 gameprice
  → app：ensureDatabase（库不在就建）→ migrate（建表）→ bootstrap（导入 24 款游戏）
  → scheduler（按间隔采集，采集完自动重建 HTML）
```

### 4b. 如果你已经有一个 PostgreSQL（不用自带库）

**必须是 PostgreSQL，MySQL 不行**（数据层用了 `on conflict`、`least`、视图等 PG 特性）。

```bash
# 1) 在现成的 PG 上建用户和库（库也可以不建，app 会自己 create database，但需要有 CREATEDB 权限）
sudo -u postgres psql -c "create user gameprice with password '换成你的密码'"
sudo -u postgres psql -c "create database gameprice owner gameprice"

# 2) 让 PG 接受来自 Docker 网段的连接
#    postgresql.conf: listen_addresses = '*'
#    pg_hba.conf 追加: host all all 172.16.0.0/12 scram-sha-256
sudo systemctl reload postgresql

# 3) 告诉应用连哪里（host.docker.internal 已在 compose 里映射到宿主机）
cat >> .env <<'EOF'
DATABASE_URL=postgres://gameprice:密码@host.docker.internal:5432/gameprice
EOF

# 4) 只起 app，不再启动自带的 db
docker compose up -d --no-deps app
docker compose rm -sf db
```

表结构、平台字典、首次游戏导入仍然全自动（`migrate` + `bootstrap`）。
验证：`docker compose exec app node src/cli.js ping`。

数据库在**另一台机器**时，URL 换成那台机器的内网地址，并加 `?sslmode=require`。

---

## 5. 验收（4 条命令，逐条看输出）

```bash
docker compose ps
```

期望：`db` 和 `app` 都是 `Up`，`app` 最终 `(healthy)`。

```bash
docker compose logs -f app
```

期望看到（Ctrl+C 退出）：

```
[entrypoint] bootstrap：建表 + 首次导入游戏（已导入则跳过）
db.migrate ...
seed.done total=24 created=24
[entrypoint] 启动调度器
scheduler.start jobs=["steam","sonkwo","itad","gog","humble","discover","alerts"]
```

```bash
docker compose exec app node src/cli.js stats
```

期望：`游戏 24 / 报价 0 / ...`（报价要等第一轮采集，约 1–2 分钟）。

```bash
docker compose exec app node src/cli.js diagnose | tail -15
```

这是排障总入口：数据库、出网、代理配置全在里面。**第一轮采集后再跑一次**，
看 `net:sonkwo`、`net:gog` 是否为 ✔。

---

## 6. 配提醒通道（建议做）

```bash
cp .env.example .env
vi .env
```

填企业微信机器人（群设置 → 添加机器人 → 复制 webhook 地址）：

```ini
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key
```

或填邮件（国内邮箱要用**授权码**，不是登录密码）：

```ini
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=你的QQ邮箱
SMTP_PASS=授权码
SMTP_FROM=你的QQ邮箱
ALERT_EMAIL_TO=收件人@example.com
```

改完必须重建容器让环境变量生效，然后**先自检通道**：

```bash
docker compose up -d app
docker compose exec app node src/cli.js notify-test
```

看到 `✔ email` 或 `✔ wecom` 才说明通道通了。

---

## 7. 看价格页（内置服务，直接 IP:端口）

镜像里自带一个静态页服务，**不需要 nginx，也不占 80 端口**（宿主机上已有 nginx 也不冲突）。

```bash
echo 'OUT_DIR=data/out' >> .env      # 页面落到宿主机 data/out
docker compose up -d --force-recreate --no-deps app
docker compose exec app node src/cli.js chart

docker compose up -d web             # 起内置服务
docker compose ps                     # web 应监听 0.0.0.0:8090
```

访问 **`http://你的公网IP:8090/`**（安全组放行 TCP 8090）。

换端口就改 `.env` 里的 `WEB_PORT`，然后 `docker compose up -d web`。

页面是静态 HTML，采集完成后由调度器自动重建，**刷新浏览器即可，不用重启服务**。

### 可选：只给自己看

把端口绑到回环地址，或用 nginx 反代加密码：

```yaml
# compose.override.yaml
services:
  web:
    ports: ["127.0.0.1:8090:8080"]
```

```bash
docker compose up -d web
# 然后从本机 SSH 隧道访问：ssh -L 8090:127.0.0.1:8090 root@服务器
```

### 可选：用现成的 nginx 托管

如果你更想挂在已有的 nginx 下（80/443 已在用）：

```bash
# 页面已经在宿主机 data/out 里了，nginx 直接指过去
# /etc/nginx/conf.d/gameprice.conf
server {
    listen 80;
    server_name prices.example.com;
    root /root/gameprice/data/out;
    location / { try_files $uri $uri/ =404; }
}
```

```bash
nginx -t && systemctl reload nginx
docker compose rm -sf web            # 内置服务可以停掉
```

---

## 8. 网络：Steam 打不开是正常的

国内服务器访问 `store.steampowered.com` 基本都超时，这不是你的配置问题。

**不受影响的部分**：游戏信息（名字/封面/发行日期）——`import steam` 会自动回落到
`api.steamcmd.net` 镜像，境内可达。

```bash
docker compose exec app node src/cli.js import steam --appids 730,570,1091500
# 元数据来源：steamcmd，取到 3 条
```

**价格**三种解法（详见 [DEPLOY.md](DEPLOY.md#网络与代理国内服务器必读)）：

1. **只用 ITAD**（最省事）：在 `.env` 填 `ITAD_API_KEY=...`，`sync itad` 不需要访问 Steam
2. **配代理**：`STEAM_PROXY=http://127.0.0.1:7890`（Clash 的 **HTTP** 端口，不是 socks5 那个）
3. **双机分流**：境外机器只采 Steam/ITAD，境内机器采杉果 + 出页面 + 发提醒

---

## 9. 加你关心的游戏

```bash
# 加一款（appid 从 Steam 商店链接里取）
docker compose exec app node src/cli.js import steam --appids 2358720
docker compose exec app node src/cli.js add 2358720
docker compose exec app node src/cli.js watch add 2358720 --target 200

# 批量导入：把常买的游戏链接贴进一个文件，一行一个
docker compose exec app node src/cli.js import steam --file data/wishlist.txt
```

`data/wishlist.txt` 内容形如（仓库里有模板 `data/wishlist.example.txt`，先复制再改）：

```bash
cp data/wishlist.example.txt data/wishlist.txt
```

```
https://store.steampowered.com/app/2358720/
https://store.steampowered.com/app/1091500/
```

---

## 10. 日常运维

```bash
docker compose logs --tail 100 app          # 最近日志
tail -f logs/app-2026-10-26.jsonl           # 结构化日志（宿主机直接看）
docker stats                                # 资源占用

git pull && docker compose up -d --build    # 更新到新版本（数据不丢）

# 备份数据库
docker compose exec -T db pg_dump -U gameprice gameprice > backup-$(date +%F).sql

docker compose down                         # 停服务（数据保留在 pgdata 卷 + ./data）
```

---

## 11. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| app 反复重启，日志有 `错误：/app/logs 不可写` | 目录属主不对 | `sudo chown -R 1000:1000 ./data ./logs` |
| app 报 `connect ECONNREFUSED db:5432` | db 没起或还在初始化 | `docker compose ps`、`docker compose logs db`，等 healthy |
| `bootstrap` 报 `database "gameprice" does not exist` | 极少见（会自动建库） | `docker compose exec db psql -U gameprice -c 'create database gameprice'` |
| `net:steam` 超时 | 境内直连被阻断 | 正常，配 ITAD key 或 `STEAM_PROXY` |
| 页面不更新 | `CHART_ON_SYNC=0` 或 chart 失败 | `docker compose logs app \| grep report`；手动 `chart` |
| 提醒收不到 | 通道没配或容器没重建 | `notify-test` 自检；日志搜 `notify.` |
| 80 端口起不来 | 安全组没放行 / 端口被占 | 换端口，或去云厂商控制台放行 |

排障第一命令永远是：

```bash
docker compose exec app node src/cli.js diagnose
```

它会把数据库、表、各源可达性、代理配置一次性列出来，报告同时写进 `logs/diagnose-*.json`。
