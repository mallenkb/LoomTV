#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Ad-hoc macOS signing requires macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEARCH_ROOT="${1:-$ROOT_DIR/out/builder}"
APP="$(find "$SEARCH_ROOT" -type d -name '*.app' -print -quit 2>/dev/null || true)"

if [[ -z "$APP" ]]; then
  echo "No macOS app bundle found under $SEARCH_ROOT" >&2
  exit 1
fi

echo "==> Applying an ad-hoc signature: $APP"
# This fallback is intentionally isolated from the release path. --deep is
# acceptable here because there is no Developer ID signature to preserve.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

ZIP_PATH="${ADHOC_ZIP_PATH:-$ROOT_DIR/out/builder/Loom-Media-Server-adhoc.zip}"
mkdir -p "$(dirname "$ZIP_PATH")"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP_PATH"

echo "Created non-notarized manual-install archive: $ZIP_PATH"
echo "Users will need to approve the first launch in System Settings > Privacy & Security."
