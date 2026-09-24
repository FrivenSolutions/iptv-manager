#!/usr/bin/env bash
# Run on the Proxmox VE host (as root) from a copy of this repository.
#
#   bash proxmox/create-lxc.sh                 create a new container and install IPTV Manager
#   bash proxmox/create-lxc.sh upgrade [ID]    upgrade the app in an existing container
#                                              (ID can be left out when only one exists)
#   bash proxmox/create-lxc.sh new             create another container even if one exists
#
# Settings for a new container can be overridden with environment variables, for example:
#   CTID=120 IP=192.168.1.50/24 GW=192.168.1.1 STORAGE=local-zfs bash proxmox/create-lxc.sh
set -euo pipefail

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

die() { echo "Error: $*" >&2; exit 1; }
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=install
TARGET=""
case "${1:-}" in
  "" | install) ;;
  upgrade) MODE=upgrade; TARGET="${2:-}" ;;
  new) MODE=new ;;
  -h | --help | help) usage; exit 0 ;;
  *) usage; die "unknown command '$1'" ;;
esac
# Older instructions used UPGRADE=1 CTID=<id>; keep honoring them, but only ever as an upgrade.
if [ "${UPGRADE:-0}" = "1" ]; then
  MODE=upgrade
  TARGET="${TARGET:-${CTID:-}}"
fi

command -v pct >/dev/null || die "this must run on a Proxmox VE host."

# IDs of containers whose name (hostname) is ours.
existing() { pct list | awk -v n="$CT_HOSTNAME" 'NR > 1 && $NF == n { print $1 }'; }
exists() { pct status "$1" >/dev/null 2>&1; }

if [ "$MODE" = upgrade ]; then
  if [ -z "$TARGET" ]; then
    mapfile -t FOUND < <(existing)
    case "${#FOUND[@]}" in
      0) die "no container named '$CT_HOSTNAME' found. Run: bash proxmox/create-lxc.sh upgrade <container id>" ;;
      1) TARGET="${FOUND[0]}" ;;
      *) die "several containers are named '$CT_HOSTNAME' (${FOUND[*]}). Run: bash proxmox/create-lxc.sh upgrade <container id>" ;;
    esac
  fi
  exists "$TARGET" || die "container $TARGET does not exist. Nothing was changed."
  CTID="$TARGET"
  if ! pct status "$CTID" | grep -q running; then
    echo "==> Starting container $CTID"
    pct start "$CTID"
    sleep 3
  fi
  pct exec "$CTID" -- test -f /opt/iptv-manager/package.json \
    || die "container $CTID has no IPTV Manager install (/opt/iptv-manager). Nothing was changed."
  echo "==> Upgrading IPTV Manager in container $CTID ($(pct config "$CTID" | awk '/^hostname:/ { print $2 }'))"
else
  mapfile -t FOUND < <(existing)
  if [ "${#FOUND[@]}" -gt 0 ] && [ "$MODE" != new ]; then
    echo "IPTV Manager already has a container: ${FOUND[*]}" >&2
    echo "  To upgrade it:           bash proxmox/create-lxc.sh upgrade ${FOUND[0]}" >&2
    echo "  To create another anyway: bash proxmox/create-lxc.sh new" >&2
    exit 1
  fi
  CTID="${CTID:-$(pvesh get /cluster/nextid)}"
  exists "$CTID" && die "container $CTID already exists. Pick a free CTID or leave it unset."
  echo "==> Creating a NEW container $CTID ($CT_HOSTNAME)"
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$(mktemp /tmp/iptv-manager.XXXXXX.tgz)"
trap 'rm -f "$BUNDLE"' EXIT
tar -C "$REPO_DIR" -czf "$BUNDLE" src public package.json package-lock.json

if [ "$MODE" != upgrade ]; then
  echo "==> Finding a Debian template"
  pveam update >/dev/null
  TEMPLATE="$(pveam available --section system | awk '/debian-1[2-9]-standard/ {print $2}' | sort -V | tail -1)"
  [ -n "$TEMPLATE" ] || die "no Debian template available from pveam."
  if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
    echo "==> Downloading $TEMPLATE"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi

  NET="name=eth0,bridge=$BRIDGE,ip=$IP"
  if [ "$IP" != "dhcp" ]; then
    [ -n "$GW" ] || die "set GW when using a static IP."
    NET="$NET,gw=$GW"
  fi

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
if [ "$MODE" = upgrade ]; then
  echo "Done. Container $CTID was upgraded and is serving IPTV Manager at http://$CT_IP:$PORT"
else
  echo "Done. Container $CTID is serving IPTV Manager at http://$CT_IP:$PORT"
  echo "To upgrade it later: bash proxmox/create-lxc.sh upgrade $CTID"
fi
