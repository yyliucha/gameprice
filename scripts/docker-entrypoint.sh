#!/bin/sh
# 容器入口：
#   带参数  → 直接当 CLI 用（docker compose run --rm app list）
#   不带参数 → 按 RUN_MODE 跑常驻调度器（默认）
set -eu

log() { echo "[entrypoint] $*"; }

if [ "$#" -gt 0 ]; then
    exec node src/cli.js "$@"
fi

case "${RUN_MODE:-scheduler}" in
    scheduler)
        log "bootstrap：建表 + 首次导入游戏（已导入则跳过）"
        node src/cli.js bootstrap
        log "启动调度器"
        exec node src/scheduler.js
        ;;
    once)
        log "RUN_MODE=once：只做 bootstrap 后退出"
        exec node src/cli.js bootstrap
        ;;
    *)
        log "未知 RUN_MODE: ${RUN_MODE}（可选 scheduler / once）"
        exit 2
        ;;
esac
