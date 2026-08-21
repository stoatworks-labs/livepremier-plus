#!/usr/bin/env bash
# Assemble the embedded LivePremier Plus app for the desktop bundle.
#
# This is the simplest prepare.sh in the fleet, and deliberately so: LivePremier
# Plus has no dependencies, no build step and no native addons, so staging it is
# a copy of two directories. There is no npm install here and there should never
# need to be one — if this script ever grows a build, something has gone wrong
# with the app's zero-dependency rule.
#
# Produces src-tauri/node[.exe] and src-tauri/livepremier-plus-app/ (both
# git-ignored; they ship inside the bundle). Run before `npm run tauri build`.
#
# NODE_PLATFORM overrides the embedded runtime arch (win-x64 / darwin-arm64 /
# darwin-x64 / linux-x64 / linux-arm64); defaults to the host. Unlike the
# launchers that carry native prebuilds, this one can be cross-staged freely.
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
# modules, which the proxy serves to the browser and reads the hook from. The
# repo layout is preserved because server/index.js resolves both relative to
# itself.
cp -R "$REPO/server" "$APP/server"
cp -R "$REPO/src" "$APP/src"
cp "$REPO/package.json" "$APP/package.json"

echo "==> fetching self-contained Node $NODE_VERSION ($PLATFORM)"
if [[ "$PLATFORM" == win-* ]]; then
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
