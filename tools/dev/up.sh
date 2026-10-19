#!/bin/sh
# Start the mock OBS/Chzzk + Arkbird from source, in the background.
#   sh tools/dev/up.sh [MOCK_ENV=value …]     e.g.  sh tools/dev/up.sh MOCK_CHAT_PAGE=1
# Dashboard: http://127.0.0.1:8080   Logs: .dev/mock.log, .dev/server.log   Stop: sh tools/dev/down.sh
cd "$(dirname "$0")/../.."
D=.dev
[ -f $D/config.json ] || sh tools/dev/fixtures.sh
sh tools/dev/down.sh
env MOCK_FRAMES=$D/frames MOCK_OBS_PASSWORD=hunter2 "$@" node tools/mock-obs.js > $D/mock.log 2>&1 & echo $! > $D/mock.pid
sleep 1
ARKBIRD_CONFIG=$D/config.json ARKBIRD_DATA=$D/data node src/server.js > $D/server.log 2>&1 & echo $! > $D/server.pid
sleep 3
echo "up: http://127.0.0.1:8080"
