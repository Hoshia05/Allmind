# BGM 무한 루프 — game music that loops like in the game (0.40.0)

Owner (2026-11-03): game tracks loop seamlessly in-game, but OST files end (intro → loop ×2 → fade). Wanted: a setlist
track can loop **indefinitely** until he stops it or picks another track. Proof of concept on the owner's
"219_ZERO.mp3" (Ace Combat Zero): loop 7,916,438 samples (179.511 s), seam 254.81 s → 75.30 s, 6 % difference
between the passes (live guitar varies), 30 ms crossfade; the owner listened to a 17-min render: "I don't feel the
seams at all".

## Why pre-rendered files (not seeking in OBS)
OBS's media source can't seek sample-exactly, and a websocket round trip at the loop end leaves an audible gap.
So Allmind renders, once per track and off the stream's hot path, two files that OBS plays as ordinary media:
- **A** = intro + the loop repeated (≥ 20 min), ending exactly at a loop end;
- **B** = the loop body repeated (≥ 60 min), starting at the loop start → content continues from A's end; OBS plays
  B with `looping: true`.
Joins inside a file are sample-exact with a 30 ms equal-power crossfade. The only non-seamless moments are the A→B
file switch (after ~20 min) and B's own restart (hourly): an OBS file (re)open, probably tens of ms — can't be
measured here (real OBS only). If it bothers the owner: a live endless stream served by Allmind (bigger change).

## Pieces
- `src/bgmloop.js` `BgmLoops`: per-track loop settings in `DATA_DIR/bgm-loops.json`
  `{[id]: {enabled, start, end, sr, source auto|tag|manual, score, mtime, size, files{a,b}, state, error}}`,
  rendered files in `DATA_DIR/bgm-loops/` (Opus 192 kb/s, 48 kHz; ~115 MB per looped track; LRU-trimmed to 4 GB).
  - **ffmpeg**: `config.bgm.ffmpeg` → `DATA_DIR/tools/ffmpeg.exe` → PATH / winget. Not bundled (exe ×4). On Windows a
    one-time download (gyan.dev "release essentials" zip, SHA-256 checked against its published `.sha256`,
    `Expand-Archive`, keep `ffmpeg.exe`) — only when the owner presses the button. Download untested here.
  - **analysis** in a worker thread (never blocks the server): decode 48 kHz s16 stereo once; features = 48 log bands
    (FFT 4096, hop 2048 at 24 kHz) → lag with the longest > 0.9-similar 8-s stretch = loop length; refine the length
    by cross-correlation (6 kHz, then full rate) at several points; seam = point in the first pass (after the intro,
    before the fade) where pass 1 and pass 2 differ least over 0.5 s. `LOOPSTART`/`LOOPLENGTH` tags (game rips) win
    when present. Low confidence → "못 찾았어요", manual entry.
  - **render** (ffmpeg encode at below-normal priority, `-threads 1`), progress reported.
  - **preview**: ±6 s around the seam as MP3 for the browser (the owner's ears, not OBS).
- `src/bgm.js`: `_select()` plays A for a loop-ready track; A ended → B with `looping:true`; next/prev/select leave the
  loop; turning the loop off while in B → `looping:false` so it ends and the setlist continues. Progress shows the
  position inside the original track (intro + one pass), seeking stays inside the current pass.
- Dashboard: 🔁 on every setlist row → 루프 sheet (find automatically, start/end with ±10 ms/±100 ms nudges, 이음새 듣기,
  저장하고 만들기 with progress, 끄기). Rows of loop tracks show 🔁; now playing shows "🔁 무한 반복".
- Mock: media speed-up + `looping` honoured; tests use the owner's ZERO file (not committed).
