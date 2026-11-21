#!/usr/bin/env bash
# 寰途 · 从本机部署到云服务器（在 Windows 的 Git Bash 里执行）
#
#   bash deploy/deploy.sh <公网IP> [SSH端口] [SSH用户]
#
#   例：bash deploy/deploy.sh <云服务器公网IP> 22 ubuntu
#
# 需要：
#   1) 服务器上已经放行 SSH（默认 22）和 HUANTU_PORT（默认 8788）
#   2) 本机有一把能登录的私钥（脚本会自己找，也可用 HUANTU_DEPLOY_KEY 指定）
#   3) 配置文件：默认找 deploy/huantu.env，也可以用 HUANTU_ENV_FILE 指定
#
# 脚本做的事：本地打包（排除截图与测试）→ scp 上传 → 解包 → 远程执行 install.sh
# 如果 SSH 用户不是 root，会自动套一层 sudo（要求该用户 sudo 免密）。

set -euo pipefail

HOST="${1:?用法: bash deploy/deploy.sh <公网IP> [SSH端口] [SSH用户]}"
SSH_PORT="${2:-22}"
SSH_USER="${3:-root}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUANTU_ENV_FILE:-$PROJECT_DIR/deploy/huantu.env}"

die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[32m[部署]\033[0m %s\n' "$*"; }

[ -f "$ENV_FILE" ] || die "找不到配置文件 $ENV_FILE（可从 deploy/huantu.env.example 复制）"
[ "$SSH_USER" = "root" ] && SUDO="" || SUDO="sudo "

# 私钥：显式指定 > ~/.ssh/huantu_deploy > 临时目录里那把
KEY="${HUANTU_DEPLOY_KEY:-}"
if [ -z "$KEY" ]; then
  for candidate in "$HOME/.ssh/huantu_deploy" "${TEMP:-/tmp}/huantu-ssh/huantu_deploy" "/c/Users/$USER/AppData/Local/Temp/huantu-ssh/huantu_deploy"; do
    [ -f "$candidate" ] && KEY="$candidate" && break
  done
fi
[ -n "$KEY" ] && [ -f "$KEY" ] || die "找不到部署私钥。用 HUANTU_DEPLOY_KEY 指定，或先把公钥加到服务器。"

SSH_OPTS=(-i "$KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=15)

log "测试 SSH 连接 root@$HOST:$SSH_PORT"
ssh "${SSH_OPTS[@]}" "root@$HOST" "echo connected && uname -a && (command -v systemctl >/dev/null && echo systemd-ok || echo no-systemd)" \
  || die "连不上。检查：公网 IP、22 端口是否放行、公钥是否已加到 /root/.ssh/authorized_keys"

# ---------- 打包 ----------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PKG="$TMP_DIR/huantu.tar.gz"

log "打包项目（排除截图/测试/本地数据）"
tar czf "$PKG" \
  --exclude='验收截图' --exclude='tests' --exclude='.data' --exclude='node_modules' \
  --exclude='.git' --exclude='deploy/huantu.env' \
  -C "$PROJECT_DIR" server.mjs queue.mjs package.json public knowledge deploy

PKG_SIZE=$(( $(wc -c < "$PKG") / 1024 ))
log "包大小 ${PKG_SIZE} KB，开始上传"

scp "${SSH_OPTS[@]}" -q "$PKG" "$SSH_USER@$HOST:/tmp/huantu.tar.gz" || die "上传失败"
scp "${SSH_OPTS[@]}" -q "$ENV_FILE" "$SSH_USER@$HOST:/tmp/huantu.env" || die "配置上传失败"

# ---------- 远程安装 ----------
log "在服务器上解包并安装"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" bash -s <<REMOTE
set -euo pipefail
rm -rf /tmp/huantu-src && mkdir -p /tmp/huantu-src
tar xzf /tmp/huantu.tar.gz -C /tmp/huantu-src
mkdir -p /tmp/huantu-src/deploy
mv /tmp/huantu.env /tmp/huantu-src/deploy/huantu.env
chmod 600 /tmp/huantu-src/deploy/huantu.env
${SUDO}bash /tmp/huantu-src/deploy/install.sh /tmp/huantu-src/deploy/huantu.env
REMOTE

log "部署完成。外网自检："
sleep 1
PUBLIC_HOST_FIRST=$(grep -E '^HUANTU_PUBLIC_HOST=' "$ENV_FILE" | cut -d= -f2- | cut -d, -f1 | tr -d '\r')
APP_PORT=$(grep -E '^HUANTU_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
APP_PORT="${APP_PORT:-8788}"
curl -s -m 10 "http://$PUBLIC_HOST_FIRST:$APP_PORT/api/public" && echo || echo "（外网还没通，多半是云厂商安全组没放行 $APP_PORT）"
