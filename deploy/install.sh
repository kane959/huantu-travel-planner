#!/usr/bin/env bash
# 寰途 · 云服务器一键安装（Ubuntu 20.04+ / Debian 11+ / Alibaba Cloud Linux 3）
#
# 用法（在服务器上，root 执行）：
#   bash install.sh /root/huantu.env
#
# 或者直接把配置写进脚本同目录的 huantu.env，然后：
#   bash install.sh
#
# 会在 <服务器部署目录> 安装代码 + Node 22（走 npmmirror 镜像），
# 并注册 systemd 服务 huantu，开机自启、崩溃自动重启。

set -euo pipefail

ENV_FILE="${1:-$(dirname "$0")/huantu.env}"
APP_DIR=<服务器部署目录>
SERVICE=huantu
NODE_VERSION=22.22.2

log() { printf '\033[32m[寰途]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 执行（sudo bash install.sh）"
[ -f "$ENV_FILE" ] || die "找不到配置文件：$ENV_FILE（先上传 huantu.env）"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

if [ "${HUANTU_PUBLIC_NO_CODE:-0}" = "1" ]; then
  log "未启用访问码：任何能访问该地址的人都能生成行程，已按每 IP 每天 ${HUANTU_PUBLIC_IP_DAILY_CALLS:-6} 次模型调用止损"
else
  : "${HUANTU_ACCESS_CODE:?配置里必须设置 HUANTU_ACCESS_CODE（至少 12 位），或设置 HUANTU_PUBLIC_NO_CODE=1 表示不要访问码}"
  [ "${#HUANTU_ACCESS_CODE}" -ge 12 ] || die "HUANTU_ACCESS_CODE 至少要 12 位"
fi
: "${HUANTU_API_KEY:?配置里必须设置 HUANTU_API_KEY}"
: "${HUANTU_PUBLIC_HOST:?配置里必须设置 HUANTU_PUBLIC_HOST（服务器公网 IP 或域名）}"

HUANTU_PORT="${HUANTU_PORT:-8788}"

# ---------- 1. Node 22 ----------
if [ -x <服务器部署目录>/node/bin/node ] && <服务器部署目录>/node/bin/node -v 2>/dev/null | grep -q '^v22'; then
  log "已有 Node $(<服务器部署目录>/node/bin/node -v)，跳过下载"
else
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac
  MIRROR="https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  log "下载 Node ${NODE_VERSION} (${ARCH}) …"
  mkdir -p <服务器部署目录>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o /tmp/node.tar.xz "$MIRROR"
  else
    wget -qO /tmp/node.tar.xz "$MIRROR"
  fi
  tar -xJf /tmp/node.tar.xz -C <服务器部署目录>
  rm -rf <服务器部署目录>/node
  mv "<服务器部署目录>/node-v${NODE_VERSION}-linux-${ARCH}" <服务器部署目录>/node
  rm -f /tmp/node.tar.xz
  log "Node 已安装：$(<服务器部署目录>/node/bin/node -v)"
fi

# ---------- 2. 代码 ----------
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$SRC_DIR/server.mjs" ]; then
  log "从 $SRC_DIR 复制代码到 $APP_DIR"
  mkdir -p "$APP_DIR"
  for item in server.mjs queue.mjs public knowledge; do
    [ -e "$SRC_DIR/$item" ] && cp -r "$SRC_DIR/$item" "$APP_DIR/"
  done
  [ -f "$SRC_DIR/package.json" ] && cp "$SRC_DIR/package.json" "$APP_DIR/"
else
  log "脚本同目录没有源码，假定 $APP_DIR 已放好代码"
fi
[ -f "$APP_DIR/server.mjs" ] || die "$APP_DIR/server.mjs 不存在，请把项目代码一起上传"

# ---------- 3. 运行用户与目录权限 ----------
id huantu >/dev/null 2>&1 || useradd -r -s /sbin/nologin huantu
mkdir -p "$APP_DIR/.data"
chown -R huantu:huantu "$APP_DIR"
chmod 600 "$ENV_FILE"
cp "$ENV_FILE" /etc/huantu.env
chmod 600 /etc/huantu.env

# ---------- 4. systemd ----------
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Huantu AI Travel Planner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=huantu
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/huantu.env
ExecStart=${APP_DIR}/node/bin/node ${APP_DIR}/server.mjs
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

# 加固：只允许写自己的数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/.data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2

# ---------- 5. 自检 ----------
# 开了 HUANTU_AUTO_VERIFY 时，进程要先做一次真实模型调用才 listen，慢模型可能 10 秒以上，
# 所以这里轮询等，不能只 sleep 2（第一次部署就是栽在这）。
HEALTH_URL="http://127.0.0.1:${HUANTU_PORT}/api/health"
READY=0
for _ in $(seq 1 25); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done

if [ "$READY" = "1" ]; then
  log "服务已启动：$(curl -fsS "$HEALTH_URL")"
else
  echo "--- 最近 40 行日志 ---"
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "服务 50 秒内没有起来，请看上面的日志"
fi

PUBLIC=$(curl -fsS -H "Host: ${HUANTU_PUBLIC_HOST%%,*}" "http://127.0.0.1:${HUANTU_PORT}/api/public" 2>/dev/null || echo '(Host 校验未通过)')
log "公开入口自检：$PUBLIC"

if [ "${HUANTU_PUBLIC_NO_CODE:-0}" = "1" ]; then
  ACCESS_LINE="访问码     未启用（任何拿到网址的人都能用）"
  ACCESS_TIP="止损：每会话 ${HUANTU_MAX_CALLS:-2} 次、每 IP 每天 ${HUANTU_PUBLIC_IP_DAILY_CALLS:-6} 次模型调用"
else
  ACCESS_LINE="访问码     ${HUANTU_ACCESS_CODE}"
  ACCESS_TIP="把地址和访问码一起发给对方即可"
fi

cat <<EOF

────────────────────────────────────────
  部署完成
  监听       0.0.0.0:${HUANTU_PORT}
  访问地址   http://${HUANTU_PUBLIC_HOST%%,*}:${HUANTU_PORT}
  ${ACCESS_LINE}
  ${ACCESS_TIP}
  配置       /etc/huantu.env（600，仅 root）
  日志       journalctl -u ${SERVICE} -f
  重启       systemctl restart ${SERVICE}
────────────────────────────────────────
  提醒：确认云厂商防火墙/安全组已放行 ${HUANTU_PORT} 端口。
EOF
