#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This launcher is only for the approved macOS Apple Silicon test profile." >&2
  exit 1
fi

readonly TESSERACT_ROOT="/opt/homebrew/Cellar/tesseract/5.5.3"
readonly TESSDATA_SOURCE_DIR="/opt/homebrew/share/tessdata"
readonly TESSDATA_DIR="$HOME/clinic-os-data/ocr-assets/tessdata"
OBJECT_ROOT="$HOME/clinic-os-data/objects"
DATABASE_URL="postgresql://$USER@localhost:5432/clinic_os_local"
if [[ "${CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP:-}" == "1" ]]; then
  [[ "${CLINIC_OS_DEMO_DATABASE_URL:-}" =~ ^postgres(ql)?://[^/@:]+@((localhost)|(127\.0\.0\.1))(:5432)?/clinic_os_demo$ ]] || {
    echo "Dedicated local demonstration database is required." >&2
    exit 1
  }
  DATABASE_URL="$CLINIC_OS_DEMO_DATABASE_URL"
  OBJECT_ROOT="$HOME/clinic-os-data/demo-objects"
fi

[[ -x "$TESSERACT_ROOT/bin/tesseract" && -f "$TESSERACT_ROOT/share/tessdata/eng.traineddata" && -f "$TESSDATA_SOURCE_DIR/chi_sim.traineddata" && -f "$TESSERACT_ROOT/share/tessdata/configs/tsv" ]] || {
  echo "Approved Tesseract 5.5.3 Chinese OCR assets are unavailable." >&2
  exit 1
}

if [[ "${CLINIC_OS_PREPARED_DEMO_LAUNCH:-}" != "1" ]]; then
  # Homebrew's default group-writable installation layout is convenient for
  # package management, but the strict OCR trust gate deliberately rejects it.
  # These are the exact pinned package paths used by this local profile. The
  # current user retains write access, while other local users cannot replace an
  # OCR asset between integrity checks.
  for path in \
    /opt/homebrew \
    /opt/homebrew/Cellar \
    /opt/homebrew/Cellar/tesseract \
    "$TESSERACT_ROOT" \
    "$TESSERACT_ROOT/bin" \
    "$TESSERACT_ROOT/share" \
    "$TESSERACT_ROOT/bin/tesseract" \
    "$TESSERACT_ROOT/share/tessdata" \
    "$TESSERACT_ROOT/share/tessdata/eng.traineddata" \
    "$TESSERACT_ROOT/share/tessdata/configs/tsv"; do
    chmod go-w "$path"
  done

  mkdir -p "$TESSDATA_DIR/configs"
  chmod 700 "$HOME/clinic-os-data" "$HOME/clinic-os-data/ocr-assets" "$TESSDATA_DIR" "$TESSDATA_DIR/configs"
  cp -Lf "$TESSERACT_ROOT/share/tessdata/eng.traineddata" "$TESSDATA_DIR/eng.traineddata"
  cp -Lf "$TESSDATA_SOURCE_DIR/chi_sim.traineddata" "$TESSDATA_DIR/chi_sim.traineddata"
  cp -Lf "$TESSERACT_ROOT/share/tessdata/configs/tsv" "$TESSDATA_DIR/configs/tsv"
  chmod 600 "$TESSDATA_DIR/eng.traineddata" "$TESSDATA_DIR/chi_sim.traineddata" "$TESSDATA_DIR/configs/tsv"

  mkdir -p "$OBJECT_ROOT"
  chmod 700 "$OBJECT_ROOT"
fi

# These are launcher control inputs, not application configuration.  Leaving
# them in the inherited environment makes the configured runtime correctly
# reject them as unknown settings (and would retain a database URL longer than
# necessary).  The values needed by the application are passed explicitly
# below.
unset CLINIC_OS_DEMO_DATABASE_URL
unset CLINIC_OS_PREPARED_DEMO_LAUNCH
unset CLINIC_OS_LAN_DEMO_CONFIRMATION

exec env \
  CLINIC_OS_PROFILE=ON_PREM_STRICT \
  DATABASE_URL="$DATABASE_URL" \
  CLINIC_OS_DATABASE_PROVIDER=LOCAL_POSTGRES \
  CLINIC_OS_FILE_PROVIDER=LOCAL_OBJECT_STORE \
  CLINIC_OS_INFERENCE_PROVIDER=LOCAL_MODEL \
  CLINIC_OS_BACKUP_PROVIDER=LOCAL_ENCRYPTED_BACKUP \
  CLINIC_OS_EXTERNAL_INFERENCE_AUTHORIZED=false \
  CLINIC_OS_MANIFEST_VERSION=macos-m1-local-v1 \
  CLINIC_OS_OBJECT_STORE_ROOT="$OBJECT_ROOT" \
  WO021_TESSERACT_PATH="$TESSERACT_ROOT/bin/tesseract" \
  WO021_TESSDATA_DIR="$TESSDATA_DIR" \
  CLINIC_OS_OCR_LANGUAGE=chi_sim+eng \
  CLINIC_OS_INFERENCE_CAPABILITIES=EXTRACT_EYE_EXAM_REPORT \
  CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP="${CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP:-0}" \
  npm run preview
