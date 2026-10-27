#!/usr/bin/env bash
# ============================================================
# DSH 远程控制 · 服务器初始化脚本
# 适用：Ubuntu 22.04 / 24.04（阿里云轻量 香港）
# 用法：DOMAIN=relay.example.com ACME_EMAIL=you@example.com bash bootstrap.sh
# 幂等：可重复执行，已完成的步骤会跳过
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dsh-remote}"
SWAP_MB="${SWAP_MB:-2048}"
DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"

log()  { printf '\033[1;32m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash bootstrap.sh）"
[[ -n "$DOMAIN" ]] || warn "未设置 DOMAIN，稍后请手动编辑 .env"

# ---------- 1. 基础软件 ----------
log "安装基础软件包..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg lsb-release ufw fail2ban chrony \
  jq unzip htop sqlite3 nano vim-tiny net-tools dnsutils

# ---------- 2. 时区与时间同步 ----------
log "设置时区 Asia/Shanghai + 时间同步..."
timedatectl set-timezone Asia/Shanghai
systemctl enable --now chrony

# ---------- 3. Swap（2G 内存保险） ----------
if ! swapon --show | grep -q .; then
  log "创建 ${SWAP_MB}MB swap..."
  fallocate -l "${SWAP_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB"
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  cat > /etc/sysctl.d/99-swap.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
else
  log "swap 已存在，跳过"
fi

# ---------- 4. 网络调优（BBR） ----------
log "开启 BBR + 文件句柄调优..."
cat > /etc/sysctl.d/99-dsh-net.conf <<'EOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.tcp_fastopen=3
net.ipv4.tcp_slow_start_after_idle=0
net.ipv4.tcp_keepalive_time=600
fs.file-max=100000
EOF
sysctl --system >/dev/null

# ---------- 5. Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  log "安装 Docker + Compose 插件..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker 已安装，跳过"
fi
systemctl enable --now docker

# Docker 日志轮转，避免撑爆 40G 盘
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "live-restore": true
}
EOF
systemctl restart docker

# ---------- 6. 目录结构 ----------
log "创建目录 ${APP_DIR} ..."
mkdir -p "$APP_DIR"/{relay,mobile,data,caddy,backups}
mkdir -p "$APP_DIR"/data/{caddy,caddy-config}

# ---------- 6.5 数据盘自动挂载 ----------
DATA_MOUNT="${APP_DIR}/data"
DATA_DISK="${DATA_DISK:-}"
if mountpoint -q "$DATA_MOUNT"; then
  log "数据盘已挂载到 ${DATA_MOUNT}，跳过"
else
  if [[ -z "$DATA_DISK" ]]; then
    ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)
    for cand in $(lsblk -rno NAME,TYPE,FSTYPE,MOUNTPOINT | awk '$2=="part" && $3!="" && $4==""{print $1}'); do
      if [[ "$(lsblk -no PKNAME "/dev/${cand}" | head -1)" == "$ROOT_DISK" ]]; then continue; fi
      DATA_DISK="$cand"; break
    done
  fi
  if [[ -n "$DATA_DISK" ]]; then
    DEV="/dev/${DATA_DISK#/dev/}"
    UUID_VAL=$(blkid -s UUID -o value "$DEV")
    if [[ -z "$UUID_VAL" ]]; then
      warn "${DEV} 无文件系统，跳过自动挂载（需要的话手动 mkfs.ext4 ${DEV}）"
    else
      log "挂载数据盘 ${DEV} (UUID=${UUID_VAL}) -> ${DATA_MOUNT}"
      mkdir -p "$DATA_MOUNT"
      mount "$DEV" "$DATA_MOUNT"
      grep -q "$UUID_VAL" /etc/fstab || echo "UUID=${UUID_VAL} ${DATA_MOUNT} ext4 defaults,nofail 0 2" >> /etc/fstab
    fi
  else
    warn "未发现可挂载的额外数据盘（可用 DATA_DISK=/dev/vdb1 指定）"
  fi
fi

# ---------- 7. 防火墙 ----------
log "配置 ufw（放行 22 / 80 / 443）..."
ufw allow 22/tcp    >/dev/null
ufw allow 80/tcp    >/dev/null
ufw allow 443/tcp   >/dev/null
ufw --force enable  >/dev/null
systemctl enable --now fail2ban

# ---------- 8. .env ----------
if [[ ! -f "$APP_DIR/.env" ]]; then
  log "生成 .env ..."
  cat > "$APP_DIR/.env" <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF
  chmod 600 "$APP_DIR/.env"
else
  log ".env 已存在，跳过（如需修改请编辑 ${APP_DIR}/.env）"
fi

# ---------- 9. 备份 cron ----------
log "配置每日备份（03:00）..."
chmod +x "$APP_DIR/backup.sh" 2>/dev/null || true
CRON_LINE="0 3 * * * ${APP_DIR}/backup.sh >> /var/log/dsh-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -vF "$APP_DIR/backup.sh" ; echo "$CRON_LINE" ) | crontab -

# ---------- 10. 汇总 ----------
IP=$(curl -s --max-time 5 https://api.ipify.org || echo "未知")
cat <<EOF

============================================================
 初始化完成
============================================================
 服务器公网 IP : ${IP}
 应用目录      : ${APP_DIR}
 域名          : ${DOMAIN:-<未设置>}

 下一步：
   1) 确认阿里云控制台「防火墙」已放行 22 / 80 / 443
   2) 确认域名 A 记录已指向 ${IP}
   3) cd ${APP_DIR} && docker compose up -d --build
   4) curl https://${DOMAIN:-你的域名}/healthz

 注意：ufw 已启用，仅放行 22/80/443。
       如你改了 SSH 端口，请先 ufw allow <端口> 再重连。
============================================================
EOF
