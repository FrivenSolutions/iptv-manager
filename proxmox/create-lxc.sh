#!/usr/bin/env bash
# Run on the Proxmox VE host as root. Works from a checkout of the repository, or straight
# from the web without one:
#   bash -c "$(wget -qO- https://raw.githubusercontent.com/frittsasaurus/iptv-manager/main/proxmox/create-lxc.sh)"
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: create-lxc.sh [command]

  (no command)      create a new container and install IPTV Manager
  upgrade [ID]      update the app in an existing container (ID optional when only one exists)
  new               create another container even though one already exists
  help              show this help

Settings for a new container can be given as environment variables, for example:
  CTID=120 IP=192.168.1.50/24 GW=192.168.1.1 STORAGE=local-zfs bash proxmox/create-lxc.sh
  AUTO_UPDATE=1 bash proxmox/create-lxc.sh        (also turn on nightly updates)

Inside the container the app updates itself: pct exec <ID> -- iptv-manager-update
EOF
}

CT_HOSTNAME="${CT_HOSTNAME:-iptv-manager}"
STORAGE="${STORAGE:-local-lvm}"          # container root disk
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"                         # "dhcp" or CIDR like 192.168.1.50/24
GW="${GW:-}"                             # required with a static IP
MEMORY="${MEMORY:-512}"                  # MB; large EPGs parse in a stream, 512 is plenty
DISK="${DISK:-4}"                        # GB
CORES="${CORES:-1}"
INSTALL_URL="${INSTALL_URL:-https://raw.githubusercontent.com/frittsasaurus/iptv-manager/main/proxmox/install.sh}"

die() { echo "Error: $*" >&2; exit 1; }

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

# Settings passed through to install.sh inside the container (only the ones given).
install_env() {
  local v
  for v in PORT AUTO_UPDATE IPTV_REPO IPTV_BRANCH; do
    [ -n "${!v:-}" ] && printf '%s=%s\n' "$v" "${!v}"
  done
  return 0
}

# Push install.sh into the container and run it: from this checkout if there is one,
# otherwise downloaded from GitHub.
run_installer() {
  local here="" script tmp=""
  [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -n "$here" ] && [ -f "$here/install.sh" ]; then
    script="$here/install.sh"
  else
    tmp="$(mktemp /tmp/iptv-manager-install.XXXXXX.sh)"
    if command -v curl >/dev/null; then curl -fsSL "$INSTALL_URL" -o "$tmp"; else wget -qO "$tmp" "$INSTALL_URL"; fi
    script="$tmp"
  fi
  pct push "$CTID" "$script" /tmp/iptv-manager-install.sh --perms 755
  [ -z "$tmp" ] || rm -f "$tmp"
  # shellcheck disable=SC2046
  pct exec "$CTID" -- env $(install_env) bash /tmp/iptv-manager-install.sh
  pct exec "$CTID" -- rm -f /tmp/iptv-manager-install.sh
}

if [ "$MODE" = upgrade ]; then
  if [ -z "$TARGET" ]; then
    mapfile -t FOUND < <(existing)
    case "${#FOUND[@]}" in
      0) die "no container named '$CT_HOSTNAME' found. Run: create-lxc.sh upgrade <container id>" ;;
      1) TARGET="${FOUND[0]}" ;;
      *) die "several containers are named '$CT_HOSTNAME' (${FOUND[*]}). Run: create-lxc.sh upgrade <container id>" ;;
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
  if pct exec "$CTID" -- test -x /usr/local/bin/iptv-manager-update; then
    pct exec "$CTID" -- iptv-manager-update
    case "${AUTO_UPDATE:-}" in
      1) pct exec "$CTID" -- iptv-manager-update --enable-auto ;;
      0) pct exec "$CTID" -- iptv-manager-update --disable-auto ;;
    esac
  else
    echo "==> Converting this install to self-updating (one time)"
    run_installer
  fi
  echo
  echo "Done. From now on you can also update with: pct exec $CTID -- iptv-manager-update"
  exit 0
fi

mapfile -t FOUND < <(existing)
if [ "${#FOUND[@]}" -gt 0 ] && [ "$MODE" != new ]; then
  echo "IPTV Manager already has a container: ${FOUND[*]}" >&2
  echo "  To upgrade it:            create-lxc.sh upgrade ${FOUND[0]}" >&2
  echo "  Or inside the container:  pct exec ${FOUND[0]} -- iptv-manager-update" >&2
  echo "  To create another anyway: create-lxc.sh new" >&2
  exit 1
fi
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
exists "$CTID" && die "container $CTID already exists. Pick a free CTID or leave it unset."
echo "==> Creating a NEW container $CTID ($CT_HOSTNAME)"

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
  --description "IPTV Manager"
pct start "$CTID"

echo "==> Waiting for the network"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1 && break
  sleep 2
done

echo "==> Installing IPTV Manager"
run_installer

echo
echo "Done. Container $CTID is running IPTV Manager (address shown above)."
echo "Update later with: pct exec $CTID -- iptv-manager-update"
