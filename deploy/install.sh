#!/usr/bin/env bash
# DSH Console 一键部署（Ubuntu / Debian / 通用 Linux）
#
# 用法：
#   sudo bash deploy/install.sh --domain relay.example.com --email you@example.com
#   sudo bash deploy/install.sh --dir /opt/dsh-console --image ghcr.io/you/dsh-console-relay:latest
#   sudo bash deploy/install.sh            # 无域名，HTTP 直连（80 端口）
#
# 脚本做的事：装 Docker（若缺）→ 写 .env → 起 relay（+ Caddy 自动 HTTPS）→ 健康检查 → 打印访问地址。
set -euo pipefail

DOMAIN=""
EMAIL=""
IMAGE=""
DIR=""
NO_TLS=0

usage() {
  cat <<'EOF'
用法: install.sh [选项]
  --domain <域名>   有域名则自动申请 Let's Encrypt 证书并启用 HTTPS
  --email  <邮箱>   ACME 账号邮箱（域名模式必填）
  --image  <镜像>   用预构建镜像（ghcr.io/...），不本地构建
  --dir    <目录>   仓库所在目录（默认：脚本所在目录的上一级）
  --no-tls          强制 HTTP 直连模式
  -h, --help        显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email)  EMAIL="${2:-}";  shift 2 ;;
    --image)  IMAGE="${2:-}";  shift 2 ;;
    --dir)    DIR="${2:-}";    shift 2 ;;
    --no-tls) NO_TLS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1"; usage; exit 1 ;;
  esac
done

say() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请用 root 运行（sudo bash $0 ...）"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -n "$DIR" ]] || DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$DIR/deploy/docker-compose.yml" ]] || die "在 $DIR 找不到 deploy/docker-compose.yml，请用 --dir 指定仓库目录"
[[ -f "$DIR/relay/src/index.mjs" ]] || die "在 $DIR 找不到 relay/src/index.mjs，仓库不完整"

# ---------- 1. Docker ----------
if command -v docker >/dev/null 2>&1; then
  ok "已安装 Docker：$(docker --version | cut -d, -f1)"
else
  say "安装 Docker（约 1~2 分钟）…"
  curl -fsSL https://get.docker.com | sh
  ok "Docker 安装完成"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------- 2. 配置 ----------
cd "$DIR/deploy"
mkdir -p data

# 防撞车：同名 compose 项目会互相顶掉容器（数据卷也跟着换目录）
PROJECT="${COMPOSE_PROJECT_NAME:-dsh-console}"
if docker compose ls -a --format json 2>/dev/null | grep -q "\"Name\":\"${PROJECT}\""; then
  if ! docker compose ls -a --format json 2>/dev/null | grep -q "${PWD}"; then
    die "已存在同名项目 ${PROJECT}（来自其他目录）。请先 'cd <那个目录> && docker compose down'，或用 COMPOSE_PROJECT_NAME=xxx 换一个项目名"
  fi
fi
export COMPOSE_PROJECT_NAME="$PROJECT"

DIRECT_MODE=0
[[ -n "$DOMAIN" && "$NO_TLS" -eq 0 ]] || DIRECT_MODE=1

if [[ -f .env ]]; then
  ok "沿用已有 .env"
  # 老部署升级上来时补上 COMPOSE_FILE，否则之后手动 `docker compose up -d`
  # 只会用 docker-compose.yml，80 端口映射会丢，站点直接不可访问
  if [[ "$DIRECT_MODE" -eq 1 ]] && ! grep -q '^COMPOSE_FILE=' .env; then
    echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.direct.yml' >> .env
    ok "已补写 COMPOSE_FILE（HTTP 直连模式）"
  fi
else
  {
    echo "# 由 install.sh 生成于 $(date '+%F %T')"
    echo "DOMAIN=${DOMAIN}"
    echo "ACME_EMAIL=${EMAIL}"
    [[ -n "$IMAGE" ]] && echo "RELAY_IMAGE=${IMAGE}"
    [[ "$DIRECT_MODE" -eq 1 ]] && echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.direct.yml'
    echo "BLOB_MAX_MB=50"
  } > .env
  ok "写入 .env"
fi

# ---------- 3. 启动 ----------
USE_TLS=0
if [[ "$NO_TLS" -eq 0 && -n "$DOMAIN" ]]; then
  USE_TLS=1
fi

if [[ -n "$IMAGE" ]]; then
  say "拉取镜像 $IMAGE"
  docker compose pull relay
  UP_ARGS=(up -d)
else
  say "本地构建镜像"
  UP_ARGS=(up -d --build)
fi

if [[ "$USE_TLS" -eq 1 ]]; then
  [[ -n "$EMAIL" ]] || die "HTTPS 模式需要 --email（Let's Encrypt 账号邮箱）"
  say "启动 relay + Caddy（域名 $DOMAIN，首次会自动签证书）"
  docker compose --profile tls "${UP_ARGS[@]}"
  URL="https://$DOMAIN"
else
  say "启动 relay（HTTP 直连 80 端口）"
  docker compose -f docker-compose.yml -f docker-compose.direct.yml "${UP_ARGS[@]}" relay
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  URL="http://${IP}"
fi

# ---------- 4. 健康检查 ----------
say "等待 relay 就绪…"
READY=0
for _ in $(seq 1 45); do
  CID="$(docker compose ps -q relay 2>/dev/null | head -1)"
  if [[ -n "$CID" ]]; then
    STATE="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CID" 2>/dev/null || true)"
    if [[ "$STATE" == "healthy" || "$STATE" == "running" ]]; then
      READY=1; break
    fi
  fi
  sleep 1
done
[[ "$READY" -eq 1 ]] || die "relay 未能启动，执行 'cd $DIR/deploy && docker compose logs --tail=50 relay' 查看原因"

# ---------- 5. 收尾 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "已放行 ufw 80/443"
fi

ok "部署完成"
echo
echo "  访问地址：$URL"
echo "  手机浏览器打开上面的地址 → 注册账号 → 配对电脑"
echo
echo "  常用命令（在 $DIR/deploy 下）："
echo "    docker compose logs -f relay     # 看日志"
echo "    docker compose restart relay     # 重启"
echo "    docker compose pull && docker compose up -d   # 升级（镜像模式）"
echo "    bash backup.sh                   # 备份（也可配 cron）"
echo
if [[ "$USE_TLS" -eq 0 ]]; then
  echo "  ⚠ 当前是 HTTP 明文。长期使用请配域名后重新执行："
  echo "    sudo bash deploy/install.sh --domain <你的域名> --email <你的邮箱>"
  echo
fi
