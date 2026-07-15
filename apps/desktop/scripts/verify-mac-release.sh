#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEARCH_ROOT="${1:-$ROOT_DIR/out/builder}"

APP="$(find "$SEARCH_ROOT" -type d -name '*.app' -print -quit 2>/dev/null || true)"
if [[ -z "$APP" ]]; then
  echo "No macOS app bundle found under $SEARCH_ROOT" >&2
  exit 1
fi

echo "==> Verifying code signature: $APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Inspecting signing identity and entitlements"
codesign -dvvv --entitlements :- "$APP" 2>&1 | sed -n '1,120p'

echo "==> Checking Gatekeeper assessment"
spctl --assess --type execute --verbose=2 "$APP"

echo "==> Checking stapled notarization ticket"
xcrun stapler validate "$APP"

echo "macOS release artifact is signed, Gatekeeper-assessable, and notarization-stapled."
