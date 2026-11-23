#!/usr/bin/env bash
# Loads the Sportozen host firewall safely (WP7).
#
#   sudo deploy/host/apply-firewall.sh [/etc/nftables.conf]
#
# It refuses to load a file that still has the placeholder administrator ranges
# (that would close SSH to everyone), checks the syntax first, and removes the
# rules again unless you confirm within 60 seconds, from a second terminal, that
# you can still connect. Once confirmed, enable nftables.service so the rules
# survive a reboot.
set -euo pipefail

CONF=${1:-/etc/nftables.conf}
NFT=${SPORTOZEN_NFT:-nft}
WAIT=${SPORTOZEN_FIREWALL_CONFIRM_SECONDS:-60}

[ -f "$CONF" ] || { echo "ERROR: $CONF not found" >&2; exit 1; }
if grep -Eq '^define ADMIN_CIDR *= *192\.0\.2\.0/24' "$CONF"; then
  echo "ERROR: ADMIN_CIDR in $CONF is still the placeholder (192.0.2.0/24). Set the range administrators connect from." >&2
  exit 1
fi
"$NFT" -c -f "$CONF" || { echo "ERROR: $CONF has a syntax error; nothing was changed" >&2; exit 1; }
"$NFT" -f "$CONF"
echo "Rules loaded. From ANOTHER terminal, confirm you can still open an SSH session."
echo "Press Enter here within ${WAIT}s to keep the rules; otherwise they are removed."
if read -r -t "$WAIT" _; then
  echo "Kept. Run: systemctl enable --now nftables"
else
  "$NFT" delete table inet sportozen
  echo "No confirmation: the rules were removed and the server is open as before." >&2
  exit 2
fi
