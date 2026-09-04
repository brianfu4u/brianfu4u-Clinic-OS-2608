#!/bin/bash
set -euo pipefail

readonly DEMO_DATABASE_URL="${CLINIC_OS_DEMO_DATABASE_URL:-}"
readonly DEMO_OBJECT_ROOT="$HOME/clinic-os-data/demo-objects"
readonly DEMO_USER="${USER:-$(id -un)}"
readonly CONFIRMATION="${CLINIC_OS_LAN_DEMO_CONFIRMATION:-}"

refuse() { printf '%s\n' 'LAN_EMPLOYEE_DEMO_REFUSED'; exit 1; }

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || refuse
[[ "$CONFIRMATION" == "LOCAL_WIFI_DEMO" ]] || refuse
[[ "$DEMO_DATABASE_URL" =~ ^postgresql://[^/@:]+@localhost:5432/clinic_os_demo$ ]] || refuse
[[ -d "$DEMO_OBJECT_ROOT" && ! -L "$DEMO_OBJECT_ROOT" ]] || refuse
[[ "$(stat -f '%Su:%Lp' "$DEMO_OBJECT_ROOT" 2>/dev/null)" == "$DEMO_USER:700" ]] || refuse

LAN_ADDRESS="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || /usr/sbin/ipconfig getifaddr en1 2>/dev/null || true)"
[[ "$LAN_ADDRESS" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ||
   "$LAN_ADDRESS" =~ ^192\.168\.[0-9]{1,3}\.[0-9]{1,3}$ ||
   "$LAN_ADDRESS" =~ ^172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || refuse

exec env \
  CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP=1 \
  CLINIC_OS_PREPARED_DEMO_LAUNCH=1 \
  CLINIC_OS_LAN_DEMO=LOCAL_WIFI_DEMO \
  CLINIC_OS_LAN_ADDRESS="$LAN_ADDRESS" \
  PREVIEW_HOST=0.0.0.0 \
  CLINIC_OS_DEMO_DATABASE_URL="$DEMO_DATABASE_URL" \
  bash scripts/start-macos-local.sh
