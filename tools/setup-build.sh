#!/bin/sh
# One-time setup for building the Windows exe on Linux/macOS/WSL.
# Puts everything in .build-tools/ (git-ignored):
#   node.exe       — Windows Node, SAME version as the `node` running the build
#   xz-embedded/   — public-domain xz decoder used by the launcher
# and installs zig (via pip) to compile the launcher. Needs: node, npm, git, xz, python3/pip.
set -e
cd "$(dirname "$0")/.."
T=.build-tools
mkdir -p "$T"
V=$(node -p 'process.versions.node')
if [ ! -f "$T/node.exe" ] || [ "$(cat "$T/node.version" 2>/dev/null)" != "$V" ]; then
  echo "fetching Windows node.exe v$V (npm package node-win-x64)…"
  rm -rf "$T/winnode" && mkdir -p "$T/winnode"
  (cd "$T/winnode" && npm pack "node-win-x64@$V" --silent >/dev/null && tar xzf node-win-x64-*.tgz)
  cp "$T/winnode/package/bin/node.exe" "$T/node.exe" && echo "$V" > "$T/node.version"
  rm -rf "$T/winnode"
fi
[ -d "$T/xz-embedded" ] || git clone --depth 1 https://github.com/tukaani-project/xz-embedded "$T/xz-embedded"
python3 -m ziglang version >/dev/null 2>&1 || pip install ziglang 2>/dev/null || pip install --break-system-packages ziglang
command -v xz >/dev/null || { echo "missing: xz (install xz-utils)"; exit 1; }
[ -d node_modules ] || npm install
echo "build tools ready in $T (node $V)"
