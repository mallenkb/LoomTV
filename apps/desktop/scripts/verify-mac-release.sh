#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEARCH_ROOT="${1:-$ROOT_DIR/out/builder}"
EXPECTED_TEAM_ID="${MACOS_TEAM_ID:-${APPLE_TEAM_ID:-}}"

if [[ -z "$EXPECTED_TEAM_ID" ]]; then
  echo "MACOS_TEAM_ID (or APPLE_TEAM_ID) is required for final macOS signature verification." >&2
  exit 1
fi

declare -a APPS=()
while IFS= read -r -d '' app; do
  APPS+=("$app")
done < <(
  find "$SEARCH_ROOT" -type d \( -name 'LoomTV.app' -o -name 'Loom Media Server.app' \) -print0 2>/dev/null
)

if (( ${#APPS[@]} == 0 )); then
  echo "No top-level LoomTV macOS app bundle found under $SEARCH_ROOT" >&2
  exit 1
fi

for APP in "${APPS[@]}"; do
  echo "==> Verifying code signature: $APP"
  codesign --verify --deep --strict --verbose=2 "$APP"

  TEAM_ID="$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  if [[ -z "$TEAM_ID" || "$TEAM_ID" =~ ^(not[[:space:]]set|none|-|unknown)$ ]]; then
    echo "macOS app is not signed by a Developer ID identity: $APP" >&2
    exit 1
  fi
  if [[ "$TEAM_ID" != "$EXPECTED_TEAM_ID" ]]; then
    echo "macOS signing Team ID mismatch for $APP: expected $EXPECTED_TEAM_ID, found $TEAM_ID" >&2
    exit 1
  fi

  echo "==> Inspecting signing identity and entitlements"
  codesign -dvvv --entitlements :- "$APP" 2>&1 | sed -n '1,120p'

  echo "==> Checking Gatekeeper assessment"
  spctl --assess --type execute --verbose=2 "$APP"

  echo "==> Checking stapled notarization ticket"
  xcrun stapler validate "$APP"
done

echo "All macOS release app bundles are signed by $EXPECTED_TEAM_ID, Gatekeeper-assessable, and notarization-stapled."
