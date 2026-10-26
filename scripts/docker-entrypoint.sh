#!/bin/sh
# 容器入口：
#   带参数  → 直接当 CLI 用（docker compose run --rm app list）
#   不带参数 → 按 RUN_MODE 跑常驻调度器（默认）
set -eu

log() { echo "[entrypoint] $*"; }

# 宿主机 bind mount 的属主通常不是容器里的 node(1000)，写不进去时报错很隐蔽
# （日志文件建不出来 → 后面一连串失败）。这里提前检查，给出可直接执行的修复命令。
check_writable() {
    dir="$1"
    if [ -d "$dir" ] && [ ! -w "$dir" ]; then
        log "错误：$dir 不可写（容器以 uid 1000 运行，宿主机目录属主不是它）"
        log "请在宿主机项目目录执行：sudo chown -R 1000:1000 ./logs ./data"
        exit 2
    fi
}
check_writable /app/logs
check_writable /app/data

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
