#!/bin/sh
# Start the mock OBS/Chzzk + Allmind from source, in the background.
#   sh tools/dev/up.sh [MOCK_ENV=value …]     e.g.  sh tools/dev/up.sh MOCK_YT_PUBLIC=1
# Dashboard: http://127.0.0.1:8080   Logs: .dev/mock.log, .dev/server.log   Stop: sh tools/dev/down.sh
# Works on Linux and on Windows (Git Bash). ALLMIND_DEV=1 keeps a source run on Windows from opening windows,
# adding a tray icon, copying a launcher to %LOCALAPPDATA%\Allmind or checking the firewall; every file stays in .dev/.
# No ffmpeg on PATH? Pass its folder: FFMPEG_DIR="/c/path/to/ffmpeg/bin" sh tools/dev/up.sh
cd "$(dirname "$0")/../.."
D=.dev
[ -n "$FFMPEG_DIR" ] && PATH="$FFMPEG_DIR:$PATH" && export PATH
[ -f $D/config.json ] || sh tools/dev/fixtures.sh || exit 1
sh tools/dev/down.sh
mkdir -p $D/rec $D/drive $D/updates $D/obs-logs
export ALLMIND_DEV=1 ALLMIND_UPDATES_DIR=$D/updates ALLMIND_OBS_LOG_DIR=$D/obs-logs
env MOCK_FRAMES=$D/frames MOCK_OBS_PASSWORD=hunter2 MOCK_REC_DIR=$D/rec MOCK_DRIVE_DIR=$D/drive "$@" node tools/mock-obs.js > $D/mock.log 2>&1 & echo $! > $D/mock.pid
[ "$MOCK_VTS" = 0 ] || { node tools/mock-vts.js > $D/vts.log 2>&1 & echo $! > $D/vts.pid; }
sleep 1
ALLMIND_CONFIG=$D/config.json ALLMIND_DATA=$D/data node src/server.js > $D/server.log 2>&1 & echo $! > $D/server.pid
sleep 3
echo "up: http://127.0.0.1:8080"
