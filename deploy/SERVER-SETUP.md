# 服务器搭建手册（香港轻量 · 免备案）

> 对应方案 v0.2 · 部署路线 A：阿里云香港轻量 + 域名直连 + Caddy 自动 HTTPS
> 目标：从零到「手机浏览器能通过 HTTPS 连上服务器」，约 1~2 小时（不含域名实名等待）

---

## 最快路径：一键部署（推荐先试这个）

服务器到手、域名解析生效后，只需要：

```bash
git clone https://github.com/Yylx-R/DSH-remote-control.git /opt/dsh-remote
cd /opt/dsh-remote
sudo bash deploy/install.sh --domain relay.example.com --email you@example.com
```

没有域名就先 `sudo bash deploy/install.sh`（HTTP 直连 80 端口，仅建议试用）。

脚本会自动装 Docker、写 `.env`、构建并启动 relay（有域名则连 Caddy 一起起、自动签证书）、做健康检查、打印访问地址。
下面的章节是**从零手工搭建**的完整记录，想自己控制每一步、或需要 swap/BBR/防火墙/fail2ban 时再照着做。

---

## 0. 当时的起点（历史记录）

| 项 | 状态 |
|---|---|
| 域名 | ❌ 没有，需要买 |
| 服务器 | ❌ 没买，有阿里云 300 元券 |
| 部署路线 | ✅ 香港轻量（免备案，大陆访问 30~80ms） |
| 多账号 | ✅ 各用各的，互不可见 |
| 代码 | 还没写，本手册只搭环境 + 冒烟测试 |

---

## 1. 采购清单

### 1.1 域名（先买，实名要等 1~2 天）

| 渠道 | 价格（估算） | 优点 | 缺点 |
|---|---|---|---|
| **阿里云万网（推荐）** | .com 首年 ¥55~75 | 和服务器同一账号，管理方便；支持支付宝 | 需实名认证，1~2 天 |
| Cloudflare Registrar | $10.4/年（成本价） | 无溢价、直接托管 CF | 需外币信用卡 |
| Porkbun / NameSilo | $10~12/年 | 便宜、隐私保护好 | 需 PayPal/外币卡 |

**建议**：阿里云买 `.com`，命名短一点，例如：

- `dsh-你的名字.com`
- `relay-你的名字.com`
- 别用敏感词，别用 `.cn`（`.cn` 要实名 + 更严）

> 阿里云域名实名认证期间**不能解析**，所以先买先等，同时去开服务器。

### 1.2 服务器

| 项 | 选择 |
|---|---|
| 产品 | 轻量应用服务器（不是 ECS，轻量更便宜、带宽更大） |
| 地域 | **中国香港** |
| 镜像 | **Ubuntu 24.04 LTS**（没有就 22.04，脚本都支持） |
| 套餐 | **2 核 2G / 30Mbps 峰值 / 40GB ESSD / 1TB 月流量** |
| 价格 | 约 ¥40~60/月（估算，以官网为准） |
| 300 元券 | **下单前确认适用范围**：是否限大陆地域、是否限新购、是否限指定套餐 |

> 若 2C2G 无货：**1C2G 也够**（10 人以内，中转不吃 CPU）。
> 若券不能用于香港：退到方案 B（大陆机 + Cloudflare Tunnel），见第 12 节。

**买完立刻记下**：

- 公网 IP
- root 密码（控制台可重置）
- 实例地域

### 1.3 控制台两件事（必做）

1. **防火墙**：轻量控制台 → 防火墙 → 放行 `22`、`80`、`443`（默认可能只开了 22）
2. **快照**：创建一台快照，配坏了能回滚（免费额度内）

---

## 2. 域名解析

域名实名通过后：

阿里云控制台 → 域名 → 解析设置 → 添加记录：

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| A | `@` | 你的服务器 IP | 600 |
| A | `www` | 你的服务器 IP | 600 |

验证（本地 Windows PowerShell）：

```powershell
nslookup relay.example.com
```

返回你的服务器 IP 就对了。不生效就等 1~10 分钟。

---

## 3. 上传文件到服务器

### 3.1 本地打包

```powershell
Compress-Archive -Path ".\deploy\*" -DestinationPath ".\deploy.zip" -Force
```

### 3.2 上传（Windows 10/11 自带 scp）

```powershell
scp ".\deploy.zip" root@<服务器IP>:/root/
```

> 没有 scp？用阿里云控制台的「Workbench」网页终端，或用 WinSCP 拖上去。

### 3.3 登录并解压

```bash
ssh root@<服务器IP>
```

```bash
apt-get update && apt-get install -y unzip
mkdir -p /opt/dsh-remote
unzip -o /root/deploy.zip -d /opt/dsh-remote
cd /opt/dsh-remote

# Windows 上传的文件可能带 CRLF，先转掉，否则 bash 会报 "$'\r': command not found"
sed -i 's/\r$//' bootstrap.sh backup.sh
chmod +x bootstrap.sh backup.sh

ls -la
```

应该看到：`bootstrap.sh`、`backup.sh`、`Caddyfile`、`docker-compose.yml`、`.env.example`、`relay/`

---

## 4. 跑初始化脚本

```bash
cd /opt/dsh-remote
DOMAIN=relay.example.com ACME_EMAIL=你的邮箱@example.com bash bootstrap.sh
```

脚本会做这些事（约 3~5 分钟）：

| 步骤 | 内容 |
|---|---|
| 1 | 装基础包（curl、ufw、fail2ban、chrony、sqlite3、jq…） |
| 2 | 时区设 `Asia/Shanghai`，开时间同步 |
| 3 | 建 2GB swap（2G 内存的保险） |
| 4 | 开 BBR + 文件句柄调优 |
| 5 | 装 Docker + Compose 插件，配日志轮转（防撑爆 40G 盘） |
| 6 | 建目录 `/opt/dsh-remote/{relay,mobile,data,caddy,backups}` |
| 7 | ufw 放行 22/80/443 并启用，fail2ban 启动 |
| 8 | 生成 `.env` |
| 9 | 加每日 3 点备份的 cron |

结束时打印公网 IP 和下一步提示。

---

## 5. 启动服务

```bash
cd /opt/dsh-remote

# 检查 .env
cat .env
# 不对就改
nano .env

# 构建并启动
docker compose up -d --build

# 看状态
docker compose ps
```

两个容器都应该是 `running` / `healthy`。

### 看证书申请

```bash
docker compose logs -f caddy
```

首次启动会向 Let's Encrypt 申请证书，10~60 秒。看到类似：

```
certificate obtained successfully
```

就成功了。

### 验证

```bash
curl -sS https://relay.example.com/healthz
```

返回：

```json
{"ok":true,"ts":1730000000000,"publicUrl":"https://relay.example.com"}
```

---

## 6. 冒烟测试（关键一步，别跳过）

这一步过了，说明 **DNS → 防火墙 → TLS → 反代 → WebSocket** 全链路通。

### 6.1 电脑浏览器

打开 `https://relay.example.com/healthz`，看到 JSON。

### 6.2 电脑控制台测 WSS

F12 → Console：

```js
const ws = new WebSocket('wss://relay.example.com/ws')
ws.onopen    = () => { console.log('OPEN'); ws.send('hello') }
ws.onmessage = (e) => console.log('RECV', e.data)
ws.onerror   = (e) => console.error('ERR', e)
```

应该依次看到 `OPEN`、`RECV {"t":"welcome"...}`、`RECV {"t":"echo"...}`。

### 6.3 手机 Chrome 同样测一遍

手机上打开 `https://relay.example.com/healthz`，再用「远程调试」或直接在页面里跑同样的 JS。

> 手机能连上 = 运营商网络到香港没问题。这一步很重要，因为手机才是主要客户端。

### 6.4 命令行测（可选）

```bash
npx wscat -c wss://relay.example.com/ws
```

---

## 7. 安全加固（建议做，10 分钟）

### 7.1 建普通用户 + SSH 密钥

本地 Windows：

```powershell
ssh-keygen -t ed25519 -C "dsh-server"
# 一路回车，生成 C:\Users\你\.ssh\id_ed25519.pub
```

服务器上：

```bash
adduser --disabled-password --gecos "" dsh
usermod -aG sudo dsh
mkdir -p /home/dsh/.ssh
# 把本地的 id_ed25519.pub 内容粘进去
nano /home/dsh/.ssh/authorized_keys
chown -R dsh:dsh /home/dsh/.ssh
chmod 700 /home/dsh/.ssh
chmod 600 /home/dsh/.ssh/authorized_keys
```

本地测试：

```powershell
ssh dsh@<服务器IP>
```

**能登进去之后**，再改 SSH 配置：

```bash
sudo nano /etc/ssh/sshd_config
```

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo systemctl restart ssh
```

> ⚠️ 改完**别关当前窗口**，另开一个窗口验证能登，再关。否则可能把自己锁在外面（用控制台 VNC 能救）。

### 7.2 可选：改 SSH 端口

```bash
sudo nano /etc/ssh/sshd_config   # Port 2222
sudo ufw allow 2222/tcp
sudo ufw delete allow 22/tcp
sudo systemctl restart ssh
```

> 阿里云控制台防火墙也要同步改。改完记得本地 `~/.ssh/config` 加端口。

### 7.3 检查清单

```bash
sudo ufw status verbose          # 22/80/443 已放行
sudo fail2ban-client status sshd # 有 jail
ss -tlnp | grep -E ':(22|80|443|8787)'   # 8787 只应监听容器内网，不对公网
```

> `8787` 是 relay 的内部端口，compose 里用的是 `expose` 不是 `ports`，所以公网访问不到 —— 这是对的。

---

## 8. 备份

已自动配好每日 03:00 备份，保留 7 天。

手动跑一次：

```bash
bash /opt/dsh-remote/backup.sh
ls -lh /opt/dsh-remote/backups/
```

看日志：

```bash
tail -f /var/log/dsh-backup.log
```

> 正式上线后建议再 `rclone` 同步到对象存储（Cloudflare R2 免费 10GB），异地备份。

---

## 9. 常用运维命令

| 目的 | 命令 |
|---|---|
| 看容器状态 | `cd /opt/dsh-remote && docker compose ps` |
| 看日志 | `docker compose logs -f relay` |
| 重启 | `docker compose restart` |
| 更新代码后重建 | `docker compose up -d --build` |
| 看磁盘 | `df -h` |
| 看内存 | `free -h` |
| 看连接数 | `ss -tn state established '( sport = :443 )' \| wc -l` |
| 证书续期 | Caddy 自动，无需操作 |
| 看证书到期 | `docker compose exec caddy caddy list-certificates` |

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 域名不解析 | 实名未通过 / DNS 未生效 | `nslookup` 查；等 10 分钟；确认 A 记录 |
| 证书申请失败 | 80 端口不通 | 阿里云防火墙 + ufw 都要放行 80；`curl -I http://域名` 测 |
| 502 Bad Gateway | relay 没起来 | `docker compose ps`；`docker compose logs relay` |
| WSS 连不上 | 路径错 / 反代没转 upgrade | 确认路径 `/ws`；Caddy 默认支持 WS，不用额外配置 |
| 手机连不上、电脑能连 | 运营商到香港线路问题 | 换网络（4G/5G 对比）测；考虑上 Cloudflare 代理 |
| 内存不够 / OOM | 2G 内存跑太多东西 | 已开 2G swap；`free -h` 看；关掉不用的容器 |
| 磁盘满 | 日志/备份堆积 | 已配日志轮转 + 备份 7 天；`du -sh /opt/dsh-remote/*` |
| SSH 被锁 | 改了端口/禁了密码 | 阿里云控制台 → Workbench（VNC）进去改回来 |

---

## 11. 验收清单

全部打勾，环境就算搭好了：

- [ ] 域名实名通过，A 记录指向服务器 IP
- [ ] 阿里云控制台防火墙放行 22/80/443
- [ ] `docker compose ps` 两个容器 healthy
- [ ] `curl https://域名/healthz` 返回 `{"ok":true}`
- [ ] 电脑浏览器 WSS 测试收到 `welcome` + `echo`
- [ ] 手机 Chrome 同样能收到
- [ ] `ufw status` 只有 22/80/443
- [ ] `bash backup.sh` 能生成备份文件
- [ ] 普通用户 + SSH key 能登录，root 密码登录已禁用（可选）

---

## 12. 如果 300 元券不能买香港（退路）

改用 **方案 B：大陆轻量 + Cloudflare Tunnel**，免备案：

1. 买大陆轻量（2C2G 3Mbps 40GB），券大概率可用
2. 域名托管到 Cloudflare（改 NS，免费）
3. Cloudflare Zero Trust → Tunnels → 创建隧道，拿 token
4. 服务器上加一个 `cloudflared` 容器：

```yaml
  tunnel:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN}
    depends_on: [relay]
```

5. 隧道里配置 `relay.你的域名.com → http://relay:8787`
6. 删掉 caddy 服务的 `ports`（不再需要公网 80/443）

代价：延迟从 30~80ms 变成 80~200ms，晚高峰可能抖。**心跳必须 ≤30s**（Cloudflare 会断空闲连接）。

---

## 13. 下一步

环境好了之后进入 **P0**：

1. 把 `relay/server.mjs` 从冒烟版换成正式版（账号、邀请码、设备注册、路由、离线队列）
2. 写电脑端 DSH 插件骨架（出站 WSS + hello + 心跳 + 重连）
3. 手机端先出一个「设备在线」页面

---

*手册版本：v1.0 · 2026-10-26 · 对应设计方案 v0.2*
