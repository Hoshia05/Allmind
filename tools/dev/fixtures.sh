#!/bin/sh
# Test media for the mock setup, in .dev/ (git-ignored). Needs ffmpeg.
#   .dev/frames/  v00..v29.jpg + idle.jpg   (mock 영도/program pictures, MOCK_FRAMES)
#   .dev/music/   a few songs in subfolders, one with cover art
#   .dev/sounds/  short soundboard clips
#   .dev/config.json  Stream Desk config pointing at the mock OBS/Chzzk
set -e
cd "$(dirname "$0")/../.."
D=.dev; mkdir -p $D/frames $D/music/Lofi $D/music/Game $D/sounds $D/data
f() { ffmpeg -v error -y "$@"; }
[ -f $D/frames/idle.jpg ] || {
  f -f lavfi -i testsrc2=s=1280x720:r=30:d=1 -q:v 4 -start_number 0 $D/frames/v%02d.jpg
  f -f lavfi -i color=0x111111:s=1280x720:d=1 -frames:v 1 $D/frames/idle.jpg
}
[ -f "$D/music/Lofi/night drive.mp3" ] || {
  f -f lavfi -i sine=f=330:d=40 -f lavfi -i color=red:s=300x300:d=1 -map 0 -map 1 -c:a libmp3lame -c:v mjpeg -disposition:v attached_pic -frames:v 1 "$D/music/Lofi/night drive.mp3"
  f -f lavfi -i sine=f=392:d=40 -c:a libmp3lame "$D/music/Lofi/rainy cafe.mp3"
  f -f lavfi -i sine=f=262:d=40 -c:a flac "$D/music/Game/boss theme.flac"
  f -f lavfi -i sine=f=523:d=20 -c:a libvorbis "$D/music/opening jingle.ogg"
}
[ -f "$D/sounds/박수.mp3" ] || for n in 박수 웃음소리 빵빠레 띠용 드럼롤 "실패 효과음"; do
  f -f lavfi -i "sine=f=$((400 + ${#n} * 60)):d=1.2" -c:a libmp3lame "$D/sounds/$n.mp3"
done
[ -f $D/config.json ] || cat > $D/config.json <<JSON
{
  "obs": { "password": "hunter2", "url": "ws://127.0.0.1:4455", "path": "" },
  "bgm": { "folder": "$PWD/$D/music" },
  "soundboard": { "folder": "$PWD/$D/sounds" },
  "chzzk": { "apiBase": "http://127.0.0.1:9333", "gameApiBase": "http://127.0.0.1:9333", "chatServer": "ws://127.0.0.1:9333/chat", "pollSeconds": 5, "channelId": "0123456789abcdef0123456789abcdef" },
  "app": { "startObs": false },
  "sources": { "donation": "영도", "chat": "위플챗", "bgm": "BGM Player", "alert": "도네 알림" },
  "server": { "port": 8080 }
}
JSON
echo "fixtures ready in $D/"
