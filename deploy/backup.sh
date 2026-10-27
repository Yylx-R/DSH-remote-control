#!/usr/bin/env bash
# 每日备份：SQLite 热备 + 数据目录打包，保留 7 天
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dsh-remote}"
BK_DIR="$APP_DIR/backups"
mkdir -p "$BK_DIR"
STAMP="$(date +%F-%H%M)"

if command -v sqlite3 >/dev/null 2>&1 && [ -f "$APP_DIR/data/relay.db" ]; then
  sqlite3 "$APP_DIR/data/relay.db" ".backup '$BK_DIR/relay-$STAMP.db'"
  echo "[$(date '+%F %T')] sqlite backup -> $BK_DIR/relay-$STAMP.db"
else
  tar czf "$BK_DIR/relay-$STAMP.tgz" -C "$APP_DIR" data 2>/dev/null || true
  echo "[$(date '+%F %T')] tar backup -> $BK_DIR/relay-$STAMP.tgz"
fi

# 只保留最近 7 天
find "$BK_DIR" -type f -mtime +7 -delete

# 磁盘低于 15% 时告警（仅打日志）
USED=$(df -P "$APP_DIR" | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ "${USED:-0}" -gt 85 ]; then
  echo "[$(date '+%F %T')] WARN: disk usage ${USED}%"
fi
