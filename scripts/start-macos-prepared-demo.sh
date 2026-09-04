#!/bin/bash
set -euo pipefail

readonly DEMO_DATABASE_URL="${CLINIC_OS_DEMO_DATABASE_URL:-}"
readonly DEMO_OBJECT_ROOT="$HOME/clinic-os-data/demo-objects"
readonly DEMO_USER="${USER:-$(id -un)}"

refuse() {
  printf '%s\n' 'PREPARED_DEMO_LAUNCH_REFUSED'
  exit 1
}

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || refuse
[[ "$DEMO_DATABASE_URL" =~ ^postgresql://[^/@:]+@localhost:5432/clinic_os_demo$ ]] || refuse
[[ -d "$DEMO_OBJECT_ROOT" && ! -L "$DEMO_OBJECT_ROOT" ]] || refuse
[[ "$(stat -f '%Su:%Lp' "$DEMO_OBJECT_ROOT" 2>/dev/null)" == "$DEMO_USER:700" ]] || refuse

# The prepared launcher deliberately delegates only to the accepted startup
# path, with its mutating setup branch disabled.
env \
  CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP=1 \
  CLINIC_OS_PREPARED_DEMO_LAUNCH=1 \
  CLINIC_OS_DEMO_DATABASE_URL="$DEMO_DATABASE_URL" \
  bash scripts/start-macos-local.sh 2>/dev/null \
  <<<'' | awk '/^Employee: http:\/\/127\.0\.0\.1:3000\/employee$/ { print $2 } /^Manager:  http:\/\/127\.0\.0\.1:3000\/manager$/ { print $2 }' &
launcher_pid=$!
if ! wait "$launcher_pid"; then
  printf '%s\n' 'PREPARED_DEMO_LAUNCH_UNAVAILABLE'
  exit 1
fi
