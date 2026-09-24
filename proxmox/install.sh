#!/usr/bin/env bash
# Installs (or upgrades) IPTV Manager as a systemd service on Debian/Ubuntu —
# typically inside a Proxmox LXC. Run as root:
#   bash install.sh [path/to/iptv-manager.tgz]
# Without an argument it installs from the repository this script lives in.
# Re-running it upgrades the app and keeps all data in $DATA_DIR.
set -euo pipefail

SRC="${1:-}"
APP_DIR="${APP_DIR:-/opt/iptv-manager}"
DATA_DIR="${DATA_DIR:-/var/lib/iptv-manager}"
PORT="${PORT:-8080}"
SERVICE_USER=iptvm

[ "$(id -u)" = 0 ] || { echo "Run this as root." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
# pct exec and SSH pass the caller's locale (e.g. en_US.UTF-8), which a fresh container
# usually lacks; apt and perl then warn on every step. C.UTF-8 is always present.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE

echo "==> Installing base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg >/dev/null

NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [ "${NODE_MAJOR:-0}" -ge 24 ]; then
  echo "==> Node.js $(node -v) already installed"
else
  echo "==> Installing Node.js 24 from NodeSource"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Installing app into $APP_DIR"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public"
if [ -n "$SRC" ]; then
  tar -xzf "$SRC" -C "$APP_DIR"
else
  REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  cp -r "$REPO_DIR/src" "$REPO_DIR/public" "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$APP_DIR/"
fi
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

echo "==> Configuring systemd service"
cat > /etc/systemd/system/iptv-manager.service <<EOF
[Unit]
Description=IPTV Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable iptv-manager >/dev/null 2>&1
systemctl restart iptv-manager

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "IPTV Manager is running: http://${IP:-<this-host>}:$PORT"
echo "Logs: journalctl -u iptv-manager -f"
