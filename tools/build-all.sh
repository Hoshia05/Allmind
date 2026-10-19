#!/bin/sh
# Build dist/StreamDesk-<version>.exe and check the packed app matches.
#   sh tools/build-all.sh
set -e
cd "$(dirname "$0")/.."
T=.build-tools
[ -f "$T/node.exe" ] && [ "$(cat $T/node.version)" = "$(node -p 'process.versions.node')" ] || sh tools/setup-build.sh
V=$(node -p 'require("./package.json").version')
rm -f dist/StreamDesk-*.exe
node tools/build-exe.mjs "$T/node.exe"
XZ_EMBEDDED="$T/xz-embedded" node tools/build-launcher.mjs
python3 - "dist/StreamDesk-$V.exe" <<'PY'
import struct, hashlib, lzma, sys
d = open(sys.argv[1], 'rb').read()
assert d[-8:] == b'SDPAYLD1', 'launcher trailer missing'
n = struct.unpack('<Q', d[-16:-8])[0]
ok = hashlib.sha256(lzma.decompress(d[-16-n:-16])).digest() == hashlib.sha256(open('dist/StreamDesk.exe', 'rb').read()).digest()
print('payload check:', 'OK' if ok else 'MISMATCH')
sys.exit(0 if ok else 1)
PY
echo "→ dist/StreamDesk-$V.exe"
