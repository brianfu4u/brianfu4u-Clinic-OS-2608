#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This launcher is only for the approved macOS Apple Silicon test profile." >&2
  exit 1
fi

readonly TESSERACT_ROOT="/opt/homebrew/Cellar/tesseract/5.5.3"
readonly OBJECT_ROOT="$HOME/Library/Application Support/ClinicOS/objects"

[[ -x "$TESSERACT_ROOT/bin/tesseract" && -f "$TESSERACT_ROOT/share/tessdata/eng.traineddata" && -f "$TESSERACT_ROOT/share/tessdata/configs/tsv" ]] || {
  echo "Approved Tesseract 5.5.3 assets are unavailable." >&2
  exit 1
}

mkdir -p "$OBJECT_ROOT"
chmod 700 "$OBJECT_ROOT"

exec env \
  CLINIC_OS_PROFILE=ON_PREM_STRICT \
  DATABASE_URL="postgresql://$USER@localhost:5432/clinic_os_local" \
  CLINIC_OS_DATABASE_PROVIDER=LOCAL_POSTGRES \
  CLINIC_OS_FILE_PROVIDER=LOCAL_OBJECT_STORE \
  CLINIC_OS_INFERENCE_PROVIDER=LOCAL_MODEL \
  CLINIC_OS_BACKUP_PROVIDER=LOCAL_ENCRYPTED_BACKUP \
  CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED=false \
  CLINIC_OS_MANIFEST_VERSION=macos-m1-local-v1 \
  CLINIC_OS_OBJECT_STORE_ROOT="$OBJECT_ROOT" \
  WO021_TESSERACT_PATH="$TESSERACT_ROOT/bin/tesseract" \
  WO021_TESSDATA_DIR="$TESSERACT_ROOT/share/tessdata" \
  CLINIC_OS_INFERENCE_CAPABILITIES=EXTRACT_EYE_EXAM_REPORT \
  npm run preview
