#!/usr/bin/env bash
# Assemble the embedded LivePremier Plus app for the desktop bundle.
#
# This is nearly the simplest prepare.sh in the fleet, and deliberately so:
# LivePremier Plus has no build step, and one dependency, which is optional —
# node-hid, the Speed Editor's USB access (plugins/speed-editor/link.js says why
# a page cannot do it). Staging the app is a copy of three directories and an
# `npm ci` of that one package, trimmed to the prebuilt addon for the target.
# node-hid ships N-API prebuilds for every platform, so nothing is compiled
# here; if this script ever grows a build, something has gone wrong.
#
# Produces src-tauri/node[.exe] and src-tauri/livepremier-plus-app/ (both
# git-ignored; they ship inside the bundle). Run before `npm run tauri build`.
#
# NODE_PLATFORM overrides the embedded runtime arch (win-x64 / darwin-arm64 /
# darwin-x64 / linux-x64 / linux-arm64); defaults to the host. node-hid's
# prebuilds cover every target, so this can still be cross-staged: the addon
# for the target is kept and the rest removed.
set -euo pipefail

NODE_VERSION="v22.20.0"

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win" ;;
    *) os="linux" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) arch="x64" ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM="${NODE_PLATFORM:-$(detect_platform)}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"     # launcher/
REPO="$(cd "$HERE/.." && pwd)"               # livepremier-plus repo root
TAURI="$HERE/src-tauri"
APP="$TAURI/livepremier-plus-app"

echo "==> staging the app (server + panels)"
rm -rf "$APP"
mkdir -p "$APP"
# server/ holds the proxy and its setup page; src/ holds the hook and the panel
# modules, which the proxy serves to the browser and reads the hook from;
# plugins/ holds the built-in plugins, each feature that has moved into one.
# The repo layout is preserved because server/index.js resolves all three
# relative to itself. A plugin that is missing is left out rather than fatal,
# so forgetting a line here ships a build with features quietly absent —
# test/packaging.test.js checks this list.
cp -R "$REPO/server" "$APP/server"
cp -R "$REPO/src" "$APP/src"
cp -R "$REPO/plugins" "$APP/plugins"
cp "$REPO/package.json" "$APP/package.json"
cp "$REPO/package-lock.json" "$APP/package-lock.json"

echo "==> staging node-hid (the Speed Editor's USB access)"
# --ignore-scripts: its install script only checks for a prebuild and falls back
# to node-gyp; the prebuilds are in the package, and a fallback compile on a
# release runner would build for the wrong target when cross-staging.
( cd "$APP" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )
case "$PLATFORM" in
  darwin-universal) __keep="darwin-arm64 darwin-x64" ;;
  win-*)            __keep="win32-${PLATFORM#win-}" ;;
  *)                __keep="$PLATFORM" ;;
esac
for __d in "$APP/node_modules/node-hid/prebuilds"/*; do
  __name="$(basename "$__d")"; __ok=""
  for __k in $__keep; do
    case "$__name" in HID-"$__k"|HID_hidraw-"$__k") __ok=1 ;; esac
  done
  [ -n "$__ok" ] || rm -rf "$__d"
done
# Headers and C sources, needed only to compile what is already prebuilt.
rm -rf "$APP/node_modules/node-addon-api" "$APP/node_modules/node-hid/src" "$APP/node_modules/node-hid/hidapi"
__left="$(ls "$APP/node_modules/node-hid/prebuilds" | tr '\n' ' ')"
[ -n "$__left" ] || { echo "no node-hid prebuild for $PLATFORM" >&2; exit 1; }
echo "    node-hid prebuilds: $__left"

echo "==> fetching self-contained Node $NODE_VERSION ($PLATFORM)"
# nodejs.org publishes no universal macOS build, so the single universal macOS
# bundle needs both runtimes fetched and merged. The app binary being fat is not
# enough on its own: a universal app around an arm64-only node would launch on
# an Intel Mac and then fail the moment it started its server.
if [[ "$PLATFORM" == darwin-universal ]]; then
  for __a in arm64 x64; do
    TARBALL="node-$NODE_VERSION-darwin-$__a"
    curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.tar.gz" -o "$TAURI/node.tar.gz"
    tar xzf "$TAURI/node.tar.gz" -C "$TAURI"
    cp "$TAURI/$TARBALL/bin/node" "$TAURI/node.$__a"
    rm -rf "$TAURI/$TARBALL" "$TAURI/node.tar.gz"
  done
  lipo -create "$TAURI/node.arm64" "$TAURI/node.x64" -output "$TAURI/node"
  # tauri.conf.json globs its resources, so an intermediate left here would be
  # shipped inside the app alongside the real one.
  rm -f "$TAURI/node.arm64" "$TAURI/node.x64"
  chmod +x "$TAURI/node"
  __archs="$( lipo -archs "$TAURI/node" )"
  echo "    embedded node: $__archs"
  case "$__archs" in
    *arm64*) ;;
    *) echo "embedded node has no arm64 slice: $__archs" >&2; exit 1 ;;
  esac
  case "$__archs" in
    *x86_64*) ;;
    *) echo "embedded node has no x86_64 slice: $__archs" >&2; exit 1 ;;
  esac
  echo "prepared: $TAURI/node (universal) + $APP (server + panels)"
elif [[ "$PLATFORM" == win-* ]]; then
  TARBALL="node-$NODE_VERSION-$PLATFORM"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.zip" -o "$TAURI/node.zip"
  ( cd "$TAURI"
    if command -v unzip >/dev/null 2>&1; then unzip -q -o node.zip
    elif command -v 7z >/dev/null 2>&1; then 7z x -y node.zip >/dev/null
    else tar -xf node.zip; fi )
  cp "$TAURI/$TARBALL/node.exe" "$TAURI/node.exe"
  rm -rf "$TAURI/$TARBALL" "$TAURI/node.zip"
  echo "prepared: $TAURI/node.exe + $APP"
else
  TARBALL="node-$NODE_VERSION-$PLATFORM"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.tar.gz" -o "$TAURI/node.tar.gz"
  tar xzf "$TAURI/node.tar.gz" -C "$TAURI"
  cp "$TAURI/$TARBALL/bin/node" "$TAURI/node"
  chmod +x "$TAURI/node"
  rm -rf "$TAURI/$TARBALL" "$TAURI/node.tar.gz"
  echo "prepared: $TAURI/node + $APP (server + panels)"
fi
