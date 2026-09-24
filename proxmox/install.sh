#!/usr/bin/env bash
# Installs IPTV Manager as a systemd service on Debian/Ubuntu (typically inside a Proxmox LXC).
# Run as root:  bash install.sh
#
# The app is kept as a git checkout of the GitHub repository in $APP_DIR, so later updates
# are a single command inside the container:  iptv-manager-update
# Re-running this script is safe: it converts an older copy-based install to a git checkout,
# refreshes the service files, and keeps all data in $DATA_DIR.
#
# Optional environment variables:
#   PORT=8080          HTTP port (kept from the previous install if not given)
#   AUTO_UPDATE=1      turn nightly updates on (0 turns them off; unset leaves them as they are)
#   IPTV_REPO=<url>    git repository to install and update from (for forks)
#   IPTV_BRANCH=main   branch to follow
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/iptv-manager}"
DATA_DIR="${DATA_DIR:-/var/lib/iptv-manager}"
CONF=/etc/default/iptv-manager
REPO_URL="${IPTV_REPO:-https://github.com/frittsasaurus/iptv-manager.git}"
SERVICE_USER=iptvm

[ "$(id -u)" = 0 ] || { echo "Run this as root." >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
# pct exec and SSH pass the caller's locale (e.g. en_US.UTF-8), which a fresh container
# usually lacks; apt and perl then warn on every step. C.UTF-8 is always present.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE

# Keep the port and branch of an existing install unless new ones are given.
PREV_PORT=""
PREV_BRANCH=""
if [ -f "$CONF" ]; then
  PREV_PORT="$(sed -n 's/^PORT=//p' "$CONF")"
  PREV_BRANCH="$(sed -n 's/^IPTV_BRANCH=//p' "$CONF")"
fi
PORT="${PORT:-${PREV_PORT:-8080}}"
BRANCH="${IPTV_BRANCH:-${PREV_BRANCH:-main}}"

# apt only runs when something is actually missing.
if ! command -v curl >/dev/null || ! command -v gpg >/dev/null || ! command -v git >/dev/null; then
  echo "==> Installing base packages"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git >/dev/null
fi

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

id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

if [ -d "$APP_DIR/.git" ]; then
  echo "==> $APP_DIR is already a git checkout; updating it"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
else
  # First install, or an older copy-based install: turn the directory into a checkout in place.
  # Tracked files are overwritten; node_modules and anything else untracked is left alone.
  echo "==> Setting up $APP_DIR as a git checkout of $REPO_URL"
  git -C "$APP_DIR" init -q
  git -C "$APP_DIR" remote add origin "$REPO_URL"
fi
git -C "$APP_DIR" fetch --quiet --depth 1 origin "$BRANCH"
git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD
echo "==> Installing dependencies"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

cat > "$CONF" <<EOF
# IPTV Manager settings, read by the service and by iptv-manager-update.
PORT=$PORT
DATA_DIR=$DATA_DIR
IPTV_BRANCH=$BRANCH
EOF

# The updater lives in the checkout, so it updates itself along with the app. It is linked
# into /usr/bin too: `pct exec` runs commands with a minimal PATH that omits /usr/local/bin.
chmod +x "$APP_DIR/proxmox/iptv-manager-update"
ln -sfn "$APP_DIR/proxmox/iptv-manager-update" /usr/local/bin/iptv-manager-update
ln -sfn "$APP_DIR/proxmox/iptv-manager-update" /usr/bin/iptv-manager-update

echo "==> Configuring systemd"
cat > /etc/systemd/system/iptv-manager.service <<EOF
[Unit]
Description=IPTV Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Environment=NODE_ENV=production
EnvironmentFile=$CONF
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
# The update units (updater service, nightly timer, and the path unit behind the web
# "Update now" button) are owned by the updater itself, so updates can change them.
/usr/local/bin/iptv-manager-update --setup
case "${AUTO_UPDATE:-}" in
  1) /usr/local/bin/iptv-manager-update --enable-auto ;;
  0) /usr/local/bin/iptv-manager-update --disable-auto ;;
esac

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "IPTV Manager is running: http://${IP:-<this-host>}:$PORT"
echo "Version:  $(git -C "$APP_DIR" log -1 --format='%h %s')"
echo "Update:   iptv-manager-update            (nightly: iptv-manager-update --enable-auto)"
echo "Logs:     journalctl -u iptv-manager -f"
