#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEARCH_ROOT="${1:-$ROOT_DIR/out/builder}"
EXPECTED_TEAM_ID="${MACOS_TEAM_ID:-${APPLE_TEAM_ID:-}}"
RELEASE_TAG_VALUE="${RELEASE_TAG:-}"
EXPECTED_BUNDLE_ID="${MACOS_BUNDLE_ID:-com.mallenkb.loommediaserver}"

if [[ -z "$EXPECTED_TEAM_ID" ]]; then
  echo "MACOS_TEAM_ID (or APPLE_TEAM_ID) is required for final macOS signature verification." >&2
  exit 1
fi
if [[ ! "$EXPECTED_TEAM_ID" =~ ^[A-Za-z0-9]{2,}$ ]]; then
  echo "MACOS_TEAM_ID must be a non-empty Team ID." >&2
  exit 1
fi
if [[ ! "$RELEASE_TAG_VALUE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "RELEASE_TAG must be a stable vMAJOR.MINOR.PATCH tag for final macOS verification." >&2
  exit 1
fi
EXPECTED_VERSION="${RELEASE_TAG_VALUE#v}"

if [[ ! -d "$SEARCH_ROOT" ]]; then
  echo "macOS release output directory does not exist: $SEARCH_ROOT" >&2
  exit 1
fi

declare -a APPS=()
declare -a DMGS=()
declare -a ZIPS=()
DISCOVERY_FILE="$(mktemp "${TMPDIR:-/tmp}/loomtv-mac-release-discovery.XXXXXX")"
trap 'rm -f "$DISCOVERY_FILE"' EXIT

if ! find "$SEARCH_ROOT" -type d \( -name 'LoomTV.app' -o -name 'Loom Media Server.app' \) -print0 >"$DISCOVERY_FILE"; then
  echo "Could not enumerate macOS app bundles under $SEARCH_ROOT" >&2
  exit 1
fi
while IFS= read -r -d '' app; do
  APPS+=("$app")
done <"$DISCOVERY_FILE"
if ! find "$SEARCH_ROOT" -type f -name 'LoomTV-*.dmg' -print0 >"$DISCOVERY_FILE"; then
  echo "Could not enumerate final macOS DMGs under $SEARCH_ROOT" >&2
  exit 1
fi
while IFS= read -r -d '' dmg; do
  DMGS+=("$dmg")
done <"$DISCOVERY_FILE"
if ! find "$SEARCH_ROOT" -type f -name 'LoomTV-*.zip' -print0 >"$DISCOVERY_FILE"; then
  echo "Could not enumerate final macOS ZIPs under $SEARCH_ROOT" >&2
  exit 1
fi
while IFS= read -r -d '' zip; do
  ZIPS+=("$zip")
done <"$DISCOVERY_FILE"

if (( ${#APPS[@]} == 0 )); then
  echo "No LoomTV macOS app bundle found under $SEARCH_ROOT" >&2
  exit 1
fi
if (( ${#DMGS[@]} == 0 )); then
  echo "No final LoomTV DMG found under $SEARCH_ROOT" >&2
  exit 1
fi
if (( ${#ZIPS[@]} == 0 )); then
  echo "No final LoomTV ZIP found under $SEARCH_ROOT" >&2
  exit 1
fi

bundle_value() {
  local app_path="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "$app_path/Contents/Info.plist"
}

verify_app() {
  local app_path="$1"
  local label="$2"
  local team_id
  local bundle_id
  local bundle_version
  local signing_details

  [[ -d "$app_path/Contents" ]] || {
    echo "$label is not a complete macOS app bundle: $app_path" >&2
    return 1
  }
  [[ -f "$app_path/Contents/Info.plist" ]] || {
    echo "$label is missing Contents/Info.plist: $app_path" >&2
    return 1
  }

  echo "==> Verifying code signature: $label ($app_path)"
  if ! codesign --verify --deep --strict --verbose=2 "$app_path"; then
    echo "codesign verification failed for $label: $app_path" >&2
    return 1
  fi

  if ! signing_details="$(codesign -dvvv "$app_path" 2>&1)"; then
    echo "Could not read signing identity for $label: $app_path" >&2
    return 1
  fi
  team_id="$(printf '%s\n' "$signing_details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  if [[ -z "$team_id" || "$team_id" =~ ^(not[[:space:]]set|none|-|unknown)$ ]]; then
    echo "$label is not signed by a Developer ID identity: $app_path" >&2
    return 1
  fi
  if [[ "$team_id" != "$EXPECTED_TEAM_ID" ]]; then
    echo "macOS signing Team ID mismatch for $label: expected $EXPECTED_TEAM_ID, found $team_id" >&2
    return 1
  fi

  if ! bundle_id="$(bundle_value "$app_path" CFBundleIdentifier)"; then
    echo "Could not read CFBundleIdentifier for $label: $app_path" >&2
    return 1
  fi
  if [[ "$bundle_id" != "$EXPECTED_BUNDLE_ID" ]]; then
    echo "macOS bundle identifier mismatch for $label: expected $EXPECTED_BUNDLE_ID, found $bundle_id" >&2
    return 1
  fi
  if ! bundle_version="$(bundle_value "$app_path" CFBundleShortVersionString)"; then
    echo "Could not read CFBundleShortVersionString for $label: $app_path" >&2
    return 1
  fi
  if [[ "$bundle_version" != "$EXPECTED_VERSION" ]]; then
    echo "macOS bundle version mismatch for $label: expected $EXPECTED_VERSION, found $bundle_version" >&2
    return 1
  fi

  echo "==> Inspecting signing identity and entitlements: $label"
  if ! codesign -dvvv --entitlements :- "$app_path" 2>&1 | sed -n '1,120p'; then
    echo "Could not inspect signing entitlements for $label: $app_path" >&2
    return 1
  fi

  echo "==> Checking Gatekeeper assessment: $label"
  if ! spctl --assess --type execute --verbose=2 "$app_path"; then
    echo "Gatekeeper rejected $label: $app_path" >&2
    return 1
  fi

  echo "==> Checking stapled notarization ticket: $label"
  if ! xcrun stapler validate "$app_path"; then
    echo "Stapled notarization validation failed for $label: $app_path" >&2
    return 1
  fi
}

for app in "${APPS[@]}"; do
  verify_app "$app" "packaged app bundle"
done

verify_dmg() {
  local dmg_path="$1"
  local mount_dir
  local attached=0
  local app_path
  local -a mounted_apps=()

  echo "==> Verifying final DMG: $dmg_path"
  if ! hdiutil verify "$dmg_path"; then
    echo "DMG integrity verification failed: $dmg_path" >&2
    return 1
  fi
  if ! spctl --assess --type open --verbose=2 "$dmg_path"; then
    echo "Gatekeeper rejected final DMG: $dmg_path" >&2
    return 1
  fi
  if ! xcrun stapler validate "$dmg_path"; then
    echo "Stapled notarization validation failed for final DMG: $dmg_path" >&2
    return 1
  fi

  mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/loomtv-dmg-mount.XXXXXX")"
  if ! hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg_path" >/dev/null; then
    rm -rf "$mount_dir"
    echo "Could not mount final DMG read-only: $dmg_path" >&2
    return 1
  fi
  attached=1
  if ! find "$mount_dir" -mindepth 1 -maxdepth 1 -type d -name '*.app' -print0 >"$DISCOVERY_FILE"; then
    hdiutil detach "$mount_dir" -force >/dev/null || true
    rm -rf "$mount_dir"
    echo "Could not enumerate the mounted DMG: $dmg_path" >&2
    return 1
  fi
  while IFS= read -r -d '' app_path; do
    mounted_apps+=("$app_path")
  done <"$DISCOVERY_FILE"

  if (( ${#mounted_apps[@]} != 1 )); then
    if (( attached )); then hdiutil detach "$mount_dir" -force >/dev/null || true; fi
    rm -rf "$mount_dir"
    echo "Final DMG must contain exactly one top-level app bundle: $dmg_path" >&2
    return 1
  fi
  if ! verify_app "${mounted_apps[0]}" "read-only mounted DMG app"; then
    if (( attached )); then hdiutil detach "$mount_dir" -force >/dev/null || true; fi
    rm -rf "$mount_dir"
    return 1
  fi
  if ! hdiutil detach "$mount_dir" -force >/dev/null; then
    rm -rf "$mount_dir"
    echo "Could not detach the read-only DMG mount: $dmg_path" >&2
    return 1
  fi
  attached=0
  rm -rf "$mount_dir"
}

verify_zip() {
  local zip_path="$1"
  local extract_dir
  local app_path
  local -a extracted_apps=()

  echo "==> Extracting and verifying final rewritten ZIP: $zip_path"
  extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/loomtv-zip-extract.XXXXXX")"
  if ! ditto -x -k "$zip_path" "$extract_dir"; then
    rm -rf "$extract_dir"
    echo "Could not extract final ZIP: $zip_path" >&2
    return 1
  fi
  if ! find "$extract_dir" -mindepth 1 -maxdepth 2 -type d -name 'LoomTV.app' -print0 >"$DISCOVERY_FILE"; then
    rm -rf "$extract_dir"
    echo "Could not enumerate the extracted ZIP: $zip_path" >&2
    return 1
  fi
  while IFS= read -r -d '' app_path; do
    extracted_apps+=("$app_path")
  done <"$DISCOVERY_FILE"

  if (( ${#extracted_apps[@]} != 1 )); then
    rm -rf "$extract_dir"
    echo "Final ZIP must contain exactly one top-level LoomTV.app bundle: $zip_path" >&2
    return 1
  fi
  if ! verify_app "${extracted_apps[0]}" "extracted rewritten ZIP app"; then
    rm -rf "$extract_dir"
    return 1
  fi
  rm -rf "$extract_dir"
}

for dmg in "${DMGS[@]}"; do
  verify_dmg "$dmg"
done
for zip in "${ZIPS[@]}"; do
  verify_zip "$zip"
done

echo "Verified ${#APPS[@]} packaged app bundle(s), ${#DMGS[@]} final DMG(s), and ${#ZIPS[@]} rewritten ZIP(s) for Team ID $EXPECTED_TEAM_ID, bundle $EXPECTED_BUNDLE_ID, version $EXPECTED_VERSION, Gatekeeper, and notarization."
