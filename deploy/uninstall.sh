#!/usr/bin/env bash
# 卸载 DSH Console 中继：停止并删除容器与网络，默认保留数据。
#
#   sudo bash deploy/uninstall.sh            # 删容器，保留 data/
#   sudo bash deploy/uninstall.sh --purge    # 连 data/ 一起删（数据库、文件、证书）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

cd "$DIR"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "找不到 docker compose，请先安装 Docker。" >&2
  exit 1
fi

echo "==> 停止并删除容器 / 网络"
$DC down --remove-orphans || true

if [[ $PURGE -eq 1 ]]; then
  echo "==> 删除数据目录 $DIR/data"
  rm -rf "$DIR/data"
  echo "已彻底删除。"
else
  echo "==> 数据已保留：$DIR/data"
  echo "    包含数据库、上传的文件和 TLS 证书；重新部署时会继续使用。"
  echo "    想彻底删除：sudo bash deploy/uninstall.sh --purge"
fi

echo "完成。"
