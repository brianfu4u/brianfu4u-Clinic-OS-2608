#!/bin/bash
set -euo pipefail

readonly DATABASE_URL="${CLINIC_OS_DEMO_DATABASE_URL:-}"
readonly OBJECT_ROOT="$HOME/clinic-os-data/demo-objects"
readonly DEMO_USER="${USER:-$(id -un)}"
readonly CONFIRMATION="${CLINIC_OS_LAN_DEMO_CONFIRMATION:-}"
PIDS=()

refuse() { printf '%s\n' 'MULTI_ROLE_DEMO_REFUSED'; exit 1; }
cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || refuse
[[ "$CONFIRMATION" == "LOCAL_WIFI_DEMO" ]] || refuse
[[ "$DATABASE_URL" =~ ^postgresql://[^/@:]+@localhost:5432/clinic_os_demo$ ]] || refuse
[[ -d "$OBJECT_ROOT" && ! -L "$OBJECT_ROOT" ]] || refuse
[[ "$(stat -f '%Su:%Lp' "$OBJECT_ROOT" 2>/dev/null)" == "$DEMO_USER:700" ]] || refuse
LAN_ADDRESS="$(/usr/sbin/ipconfig getifaddr en0 2>/dev/null || /usr/sbin/ipconfig getifaddr en1 2>/dev/null || true)"
[[ "$LAN_ADDRESS" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ || "$LAN_ADDRESS" =~ ^192\.168\.[0-9]{1,3}\.[0-9]{1,3}$ || "$LAN_ADDRESS" =~ ^172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || refuse

start_workspace() {
  local workspace="$1" port="$2" host="$3" lan="$4"
  local lan_environment=()
  [[ -n "$lan" ]] && lan_environment=(CLINIC_OS_LAN_DEMO="$lan" CLINIC_OS_LAN_ADDRESS="$LAN_ADDRESS")
  env CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP=1 CLINIC_OS_PREPARED_DEMO_LAUNCH=1 \
    CLINIC_OS_DEMO_DATABASE_URL="$DATABASE_URL" CLINIC_OS_PREVIEW_WORKSPACE="$workspace" \
    PORT="$port" PREVIEW_HOST="$host" "${lan_environment[@]}" \
    bash scripts/start-macos-local.sh >/dev/null 2>&1 &
  PIDS+=("$!")
}

start_workspace RECEPTION 3001 0.0.0.0 LOCAL_WIFI_DEMO
start_workspace DOCTOR 3002 0.0.0.0 LOCAL_WIFI_DEMO
start_workspace EXAM 3003 0.0.0.0 LOCAL_WIFI_DEMO
start_workspace CASHIER 3004 0.0.0.0 LOCAL_WIFI_DEMO
start_workspace RECEPTION 3000 127.0.0.1 ""
sleep 1
for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || refuse; done

printf 'Reception: http://%s:3001/employee\n' "$LAN_ADDRESS"
printf 'Doctor:    http://%s:3002/employee\n' "$LAN_ADDRESS"
printf 'Exam:      http://%s:3003/employee\n' "$LAN_ADDRESS"
printf 'Cashier:   http://%s:3004/employee\n' "$LAN_ADDRESS"
printf 'Manager:   http://127.0.0.1:3000/manager\n'
wait "${PIDS[4]}"
