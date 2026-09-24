#!/usr/bin/env bash
# Run on the Proxmox VE host (as root) from a copy of this repository:
#   bash proxmox/create-lxc.sh
# Creates a small unprivileged Debian LXC and installs IPTV Manager in it.
# Override any setting with environment variables, for example:
#   CTID=120 IP=192.168.1.50/24 GW=192.168.1.1 STORAGE=local-zfs bash proxmox/create-lxc.sh
#
# To upgrade an existing container later, re-run with the same CTID and UPGRADE=1.
set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-iptv-manager}"
STORAGE="${STORAGE:-local-lvm}"          # container root disk
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"                         # "dhcp" or CIDR like 192.168.1.50/24
GW="${GW:-}"                             # required with a static IP
MEMORY="${MEMORY:-512}"                  # MB; large EPGs parse in a stream, 512 is plenty
DISK="${DISK:-4}"                        # GB
CORES="${CORES:-1}"
PORT="${PORT:-8080}"
UPGRADE="${UPGRADE:-0}"

command -v pct >/dev/null || { echo "This must run on a Proxmox VE host." >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$(mktemp /tmp/iptv-manager.XXXXXX.tgz)"
trap 'rm -f "$BUNDLE"' EXIT
tar -C "$REPO_DIR" -czf "$BUNDLE" src public package.json package-lock.json

if [ "$UPGRADE" != "1" ]; then
  echo "==> Finding a Debian template"
  pveam update >/dev/null
  TEMPLATE="$(pveam available --section system | awk '/debian-1[2-9]-standard/ {print $2}' | sort -V | tail -1)"
  [ -n "$TEMPLATE" ] || { echo "No Debian template available from pveam." >&2; exit 1; }
  if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
    echo "==> Downloading $TEMPLATE"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi

  NET="name=eth0,bridge=$BRIDGE,ip=$IP"
  if [ "$IP" != "dhcp" ]; then
    [ -n "$GW" ] || { echo "Set GW when using a static IP." >&2; exit 1; }
    NET="$NET,gw=$GW"
  fi

  echo "==> Creating container $CTID ($CT_HOSTNAME)"
  pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
    --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$MEMORY" --swap 256 \
    --rootfs "$STORAGE:$DISK" --net0 "$NET" \
    --unprivileged 1 --features nesting=1 --onboot 1 \
    --description "IPTV Manager - http://<ip>:$PORT"
  pct start "$CTID"

  echo "==> Waiting for the network"
  for _ in $(seq 1 30); do
    pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
    sleep 2
  done
fi

echo "==> Installing IPTV Manager"
pct push "$CTID" "$BUNDLE" /tmp/iptv-manager.tgz
pct push "$CTID" "$REPO_DIR/proxmox/install.sh" /tmp/iptv-manager-install.sh --perms 755
pct exec "$CTID" -- env PORT="$PORT" bash /tmp/iptv-manager-install.sh /tmp/iptv-manager.tgz
pct exec "$CTID" -- rm -f /tmp/iptv-manager.tgz /tmp/iptv-manager-install.sh

CT_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
echo "Done. Container $CTID is serving IPTV Manager at http://$CT_IP:$PORT"
