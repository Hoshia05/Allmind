# Stream Desk — notes for Claude

Stream Desk is a one-exe dashboard for a two-PC Chzzk (치지직) VTuber stream (호시아).
It runs on the **stream PC** next to OBS (Ryzen 3600X + RTX 2070, meant to run only
OBS + Stream Desk) and is used from browsers on the main PC, an iPad and a phone.
It talks to OBS over obs-websocket v5, to OBS's browser sources over Chrome DevTools
(OBS is started with `--remote-debugging-port=9222`), and to Chzzk's web endpoints.

## Working rules (the owner's standing preferences)

- **Talk to the owner in English unless they write Korean.** All UI text and the README are **Korean**.
- **Commit locally; don't push to GitHub until asked.** When asked, push `main`
  (see "GitHub" below). Never push tags or try to create releases — they're blocked.
- **Deliverable = one exe.** After a change: bump the version, build, send
  `dist/StreamDesk-<ver>.exe` to the owner as a file, and delete the previous exe from `dist/`.
  No README/zip alongside unless asked.
- **Lean matters.** Every OBS request and every preview frame costs the stream PC.
  Prefer OBS events over polling; poll only while a dashboard is open (`clients.size`).
- **Test against the mock before claiming something works**, and say plainly what was
  only tested with the mock (real OBS/Chzzk/weflab behaviour can differ).
- Commit messages end with the attribution lines the session provides.

## Versioning, build, release

- Version lives in **two places**: `package.json` `"version"` and `VERSION` in `src/server.js`.
- First time in a session: `sh tools/setup-build.sh` (fetches Windows node.exe of the same
  version via npm, xz-embedded via git, zig via pip → `.build-tools/`, git-ignored).
- Build + verify: `sh tools/build-all.sh` → `dist/StreamDesk-<ver>.exe` (~20 MB;
  `dist/StreamDesk.exe` is the 82 MB unpacked app, don't send that).
- How it's built: `tools/build-exe.mjs` bundles `src/` with esbuild into a Node SEA with
  every file in `public/` as an asset; `tools/build-launcher.mjs` wraps it in a tiny C
  launcher (`tools/launcher/launcher.c`) that unpacks an xz payload. New files in
  `public/` are picked up automatically.
- Release (owner does it on github.com): Releases → new → tag `vX.Y.Z` → attach the exe +
  `THIRD_PARTY_NOTICES.txt` → publish. Give the owner Korean release notes to paste.

## GitHub

Repo: `Hoshia05/CentralStreamingHQ` (private, MIT). The session can push `main` but
**cannot** create repos, push tags, or touch releases (403). If the repo isn't attached,
attach it with the add_repo tool (access: push), clone it, then push **from that clone**:
`git -C <clone> pull --ff-only <this checkout> main && git -C <clone> push origin main`.

## Develop & test (mock OBS + mock Chzzk, no Windows needed)

```
sh tools/dev/up.sh [MOCK_X=1 …]   # makes .dev/ fixtures + config, starts mock + server
                                   # dashboard: http://127.0.0.1:8080
sh tools/dev/down.sh               # always stop them when done
node tools/dev/obs.mjs StartRecord # send any obs-websocket request to the mock
node tools/dev/sse-stats.mjs 10    # what the dashboard receives per second
```
Logs: `.dev/server.log`, `.dev/mock.log`. Playwright + Chromium are available for UI
checks and screenshots (no WebKit, so Safari/iPad behaviour can't be tested here).

Useful mock switches (`tools/mock-obs.js`): `MOCK_CHAT_PAGE=1` (fake 위플챗 page,
`=deny` to refuse framing), `MOCK_YD_INTRO=1` (영도 = alert, silence, video),
`MOCK_SKIP_EVERY_MS` / `MOCK_SKIP_TRANSITION=1` / `MOCK_OBS_STRUGGLES=1` (OBS skipped
frames, for the load guard), `MOCK_NO_CHAPTERS=1`, `MOCK_STOP_MS` (recording stop delay),
`MOCK_REQS=1` (prints OBS request counts every 20 s), `MOCK_TRACK_MS`, `MOCK_SB_MS`.

## Code map

- `src/server.js` — HTTP + SSE server, wires everything, all `/api/*` routes, the OBS-load
  guard, the 영도-active logic (auto tab switch), launcher/settings endpoints (local only).
- `src/obs.js` — obs-websocket client (`call`, events re-emitted by name).
- `src/bgm.js` — BGM setlist on one OBS Media Source; 영도 auto-pause (sound level of the
  영도 source, `introHoldMs`, 리모컨 hold). Emits `change` (full state) and `pos` (progress only).
- `src/soundboard.js` — soundboard: one Media Source "Soundboard", folder watched.
- `src/coverless.js` — art-free copies of MP3/FLAC (cover art made OBS audio buffering creep).
- `src/donation.js` — 영도 viewer (OBS screenshots), `Interact` (DevTools: click-through,
  ad skip), `ProgramViewer` (방송 화면), quality presets `QUALITY`.
- `src/feed.js` — `FrameFeed`: paced OBS screenshots shared by all viewers; adaptive fps; `fpsCap` from the guard.
- `src/studio.js` — scenes, mic mute/level, stream health (GetStats every 2 s only while watched).
- `src/markers.js` — ⭐ marks for VOD Scout (record chapters + `<video>.markers.json`).
- `src/remote.js` — 치지직 리모컨 dock in OBS via DevTools (■ 정지 / 넘기기 / 알림 정지).
- `src/chzzk.js` — live status, chat, donations (unofficial endpoints; can break).
- `src/config.js` — config/state paths (`%APPDATA%\StreamDesk` in the exe), defaults from
  `config.example.json`, import from older versions. `src/win.js` — Windows bits (tray, firewall, pickers).
- `public/index.html`, `app.js`, `style.css` — dashboard. `dock.js` — free panel layout
  (columns, slots, tabs; saved per browser in `localStorage['sd.dock']`; only on wide
  landscape screens). `launcher.*` — settings window on the stream PC. `mark.html` — /mark page.

## Things learned the hard way

- **OBS screenshots aren't free**: each preview frame is an extra scene render on the
  stream PC's GPU. 60 fps previews measurably dropped stream frames; 30 fps didn't.
  The guard ignores skips during scene transitions (stinger) and one-off blips.
- **Moving an iframe in the DOM reloads it** — the 위플챗 page would lose its chat.
  `dock.js` only moves nodes when needed; tabs hide with a class, never by moving.
- A hidden scene item is "inactive": OBS stops its audio. The BGM/Soundboard sources
  must stay visible (the owner scales their group to 0 instead of hiding).
- Real OBS sends `RecordStateChanged STOPPED` only after the file is finished (seconds
  later) — use `STOPPING` for timing. Hybrid MP4 is needed for record chapters.
- OBS's own state isn't reset between streams unless it restarts; the owner's frame drops
  were mostly an OBS left open ~25 h. Ask for the OBS log (`%APPDATA%\obs-studio\logs`,
  end-of-session lagged/skipped-frame lines) and `data\stream-desk.log` (`[guard]` lines)
  when diagnosing performance.
- iPad Safari can't read the MJPEG stream reliably; the client falls back to long-poll
  `/api/frame` automatically.
- Never ask for or keep `service.json` / Multi-RTMP config — they contain stream keys.

## Model split (to save tokens)

Big or fuzzy work (new feature design, debugging from logs): plan first and write the plan
to `docs/plans/<topic>.md`. Clear, specified work (implement a plan, small fixes, build,
release notes): any model can do it from the plan + this file. Start a fresh session per
feature rather than continuing one very long conversation.
