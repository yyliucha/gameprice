# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./frontend
RUN npm run frontend:build

FROM node:22-bookworm-slim

# TZ 影响日志时间与 date 列，默认东八区；DB_WAIT_SEC 让容器等数据库就绪再启动
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    LOG_DIR=/app/logs \
    DB_WAIT_SEC=60

# tini 负责 PID 1 的信号转发，否则 docker stop 无法把 SIGTERM 传到 node
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷依赖清单，让 npm ci 这一层能被缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
# 前端工程（单页应用）——漏了这行，容器里 /app/web 不存在，GET / 会 404
COPY --chown=node:node web ./web
COPY --from=frontend-build --chown=node:node /app/frontend/dist ./frontend/dist
COPY --chown=node:node scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/logs \
    && chown -R node:node /app

USER node

# 健康检查只验证数据库可达；DB_WAIT_SEC 对 ping 不生效，避免检查超时
HEALTHCHECK --interval=60s --timeout=15s --start-period=40s --retries=3 \
    CMD node src/cli.js ping || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
