#!/usr/bin/env bash
# Sign the embedded Node binary, and node-hid's prebuilt addon (the Speed
# Editor's USB access), before Tauri bundles the .app, so every nested Mach-O in
# the bundle is Developer-ID-signed with the hardened runtime and the whole app
# passes notarization. The addon is signed by the same identity as node, which
# is what library validation under the hardened runtime asks of it. No-op when no signing identity is configured
# (the build then produces an unsigned .dmg, as before).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # launcher/
NODE_BIN="$HERE/src-tauri/node"
ENTITLEMENTS="$HERE/src-tauri/entitlements.plist"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [ -z "$IDENTITY" ]; then
  echo "sign-embedded: APPLE_SIGNING_IDENTITY not set — skipping (unsigned build)."
  exit 0
fi
if [ ! -f "$NODE_BIN" ]; then
  echo "sign-embedded: $NODE_BIN not found — run scripts/prepare.sh first." >&2
  exit 1
fi

echo "sign-embedded: signing $NODE_BIN"
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" "$NODE_BIN"
codesign --verify --strict --verbose=2 "$NODE_BIN"

APP="$HERE/src-tauri/livepremier-plus-app"
while IFS= read -r -d '' addon; do
  echo "sign-embedded: signing ${addon#$HERE/}"
  codesign --force --timestamp --options runtime --sign "$IDENTITY" "$addon"
  codesign --verify --strict --verbose=2 "$addon"
done < <(find "$APP" -name '*.node' -print0)
echo "sign-embedded: done."
