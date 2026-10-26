# Allmind — notes for Claude

(Names so far: Stream Desk → Arkbird (0.17.0) → **Allmind (0.20.0)**. The code still imports settings from `%APPDATA%\Arkbird` and `%APPDATA%\StreamDesk`, honours the old "Arkbird"/"Stream Desk" firewall rules and startup shortcuts, and deletes the old `%LOCALAPPDATA%\Arkbird` folder. The release workflow attaches every exe **twice** (`Allmind-X.Y.Z.exe` + identical `Arkbird-X.Y.Z.exe`) because Arkbird 0.17–0.19's updater only matches the old asset name — drop that once nobody runs Arkbird. The GitHub repo is `Hoshia05/Allmind` (renamed CentralStreamingHQ → ArkBird → Allmind; old URLs redirect, so older builds whose saved config still says `Hoshia05/ArkBird` keep updating).)

Allmind is a one-exe dashboard for a two-PC Chzzk (치지직) VTuber stream (호시아).
It runs on the **stream PC** next to OBS (Ryzen 3600X + RTX 2070, meant to run only
OBS + Allmind) and is used from browsers on the main PC, an iPad and a phone.
It talks to OBS over obs-websocket v5, to OBS's browser sources over Chrome DevTools
(OBS is started with `--remote-debugging-port=9222`), and to Chzzk's web endpoints.

## Working rules (the owner's standing preferences)

- **Talk to the owner in English unless they write Korean.** All UI text and the README are **Korean**.
- **Commit locally; push `main` once a change is finished and tested.** The owner said on 2026-10-19
  that pushing anytime is fine (they work remotely and update through the in-app updater). A push that
  bumps the version publishes a release automatically — so only bump when the owner wants a release.
  Don't push half-done work. (See "GitHub" below.) Never push tags or create releases yourself — blocked;
  the Actions workflow does it.
- **Deliverable = one exe.** After a change: bump the version, build, send
  `dist/Allmind-<ver>.exe` to the owner as a file, and delete the previous exe from `dist/`.
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
- Build + verify: `sh tools/build-all.sh` → `dist/Allmind-<ver>.exe` (~20 MB;
  `dist/Allmind.exe` is the 82 MB unpacked app, don't send that).
- How it's built: `tools/build-exe.mjs` bundles `src/` with esbuild into a Node SEA with
  every file in `public/` as an asset; `tools/build-launcher.mjs` wraps it in a tiny C
  launcher (`tools/launcher/launcher.c`) that unpacks an xz payload. New files in
  `public/` are picked up automatically.
- **Release is automatic** (`.github/workflows/release.yml`): bump the version in both places, add
  Korean notes as `docs/release-notes/X.Y.Z.md` (copy `TEMPLATE.md`), commit, and — when the owner
  says push — push `main`. GitHub Actions builds the exe and publishes release `vX.Y.Z` with the exe
  + `THIRD_PARTY_NOTICES.txt`; the in-app updater then offers it. No notes file → it creates a
  **draft** instead (owner publishes it on github.com). Nothing happens if `vX.Y.Z` already exists.
  Still send the owner the exe from the local build for immediate testing. The workflow can't be
  tested locally; if a run fails, read it on the repo's Actions tab (owner pastes the error).

## GitHub

Repo: `Hoshia05/Allmind` (private, MIT). The session can push `main` but
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
Use **Python** Playwright (`python3 -I script.py`, `from playwright.sync_api import sync_playwright`);
there is no Node Playwright package. Put test scripts in the scratchpad, not the repo.

Useful mock switches (`tools/mock-obs.js`): `MOCK_CHAT_PAGE=1` (fake 위플챗 page,
`=deny` to refuse framing), `MOCK_YD_INTRO=1` (영도 = alert, silence, video),
`MOCK_SKIP_EVERY_MS` / `MOCK_SKIP_TRANSITION=1` / `MOCK_OBS_STRUGGLES=1` (OBS skipped
frames, for the load guard), `MOCK_NO_CHAPTERS=1`, `MOCK_STOP_MS` (recording stop delay),
`MOCK_REQS=1` (prints OBS request counts every 20 s), `MOCK_TRACK_MS`, `MOCK_SB_MS`.
Google/CHZZK mocks (under :9333 `/g/…`, `/c/…`; fixtures point config there; logins bounce straight back):
`MOCK_YT_NOSTART=1`, `MOCK_YT_PUBLIC=1` (turns public when live), `MOCK_YT_NOFEED=1`, `MOCK_DRIVE_FAIL=n`
(n-th chunk fails once), `MOCK_DRIVE_DIR`, `MOCK_REC_SIZE=bytes` (size of the fake video), OBS `StartStream`/`StopStream`.
`ALLMIND_YT_CHECK_MS=4000` speeds up the YouTube checks for tests. Log in on the mock with
`curl -s -X POST localhost:8080/api/launcher/google-login -d '{}' -H 'content-type: application/json'` → `curl -sL <url>`.
Updater tests: `MOCK_UPDATE=9.9.9` (fake GitHub release on :9333; `MOCK_UPDATE_BAD=size|hash|mz`,
`MOCK_UPDATE_NODIGEST=1`), `MOCK_OFFLINE=1` (OBS not streaming — otherwise installs are refused).
From source the install is always a dry run (downloads + verifies, doesn't start the file); set
`ALLMIND_UPDATES_DIR` to keep it out of your home dir. The real Windows replace-and-restart can't be tested here.

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
- `src/markers.js` — ⭐ marks + chat log for VOD Scout/SkyEye (record chapters + `<video>.markers.json`, format v2: `markers` + `chat`). Monotonic recording clock (pauses excluded, 60 s `GetRecordStatus` drift check), 15 s dirty-save, recovery after restart, `gap` items. Chat comes from `chzzk` `'live-chat'` (live CHAT/SPECIAL only, not the RECENT_RESULT replay); toggle `config.markers.saveChat` (off = v1, marks only).
- `src/google.js` — Google OAuth (desktop client, loopback callback `/api/google/callback`, PKCE), token store `DATA_DIR/google-auth.json` (secret!), `api()` + `fetchRetry`. **Two sign-ins in a row** (YouTube, then Drive; the callback 302s to the second consent) because Google answers a combined `youtube` + `drive.file` request with "Error 400 invalid_request: scopes that cannot be requested together"; tokens per group (`has('youtube'|'drive')`, `token(group)`), `api()` picks the group from the path. Plan: `docs/plans/google-archive.md`.
- `src/youtube.js` — YouTube archive guard: own reusable stream key, always one private auto-start broadcast ready, checks every 60 s only while OBS streams (force private, not-live alarm), ends it after. `fillTemplate`/`ymd` for `{date} - {title}`. Remembers the channel the key was made on; a login to another channel or "Stream not found" forgets the key (`_keyGone`) and asks for a new one.
- `src/drive.js` — Drive upload queue (`DATA_DIR/uploads.json`): resumable 16 MB chunks, resumes after restart, never while streaming/recording, name from the longest-shown title (`markers.js` tracks it), markers file uploaded with `recording.file` = Drive name. `safeName`. Target = `config.drive.folder` (owner's own folder link, `parseFolderId`) — needs the **full `drive` scope** (0.30; drive.file can't see folders made in the browser; `google.driveFull()`, `needsReauth`), else the self-made "Allmind 녹화" folder. YouTube login can be the brand channel while Drive is the main account (separate consents).
- `src/chzzkopen.js` — official CHZZK Open API (`openapi.chzzk.naver.com`): OAuth (account-interlock, single-use refresh tokens), `lives/setting` GET/PATCH, category search. Used by the 방송 준비 sheet (`/api/prep/*`).
- `src/remote.js` — 치지직 리모컨 dock in OBS via DevTools (■ 정지 / 넘기기 / 알림 정지).
- `src/dogfight.js` + `public/xylem/dogfight.html` (Xylem pack) — 공중전 overlay (OBS browser source `/dogfight`, 1920×1080, transparent). Server relays `!` chat commands (not donations — owner wants no pay-to-win) over `/api/dogfight/events` (only while an overlay is connected) and keeps the wins/kills board in `DATA_DIR/dogfight.json`; the game runs entirely in the page. Test without chat: `POST /api/dogfight/cmd {nick,text}` or `/dogfight?demo=1`. Weapons (0.26): `!미사일`, `!플레어`, `!회피` (cobra + 3.5 s evade window because chat lags the stream), `!특수` (random of `SPECIALS`: QAAM/4AAM/HPAA/ADMM/EML/TLS, 25 s); bots use evade/specials themselves; `?help=0` hides the on-screen command list. Boss round (0.27): `!보스` (streamer/manager) or `?boss=N` → everyone (min. 3 jets, bots as wingmen) vs. the fortress `boss` (turrets, missile salvos, telegraphed beam; `!회피` cuts beam damage); HP/firepower scale with jet count — tuned by headless sims (`update(1/30)` loop) so an active chat usually wins in ~50–70 s and an idle one usually loses.
- **Xylem** (`docs/plans/xylem.md`) — viewer interaction inside Allmind, patchable mid-stream. `src/xylem.js` = pack manager: the files in `public/xylem/` (page shell `index.html`/`xylem.js`/`xylem.css`, overlays `<id>.html`, panels `<id>.panel.js` exporting `mount(el, x)`, `manifest.json` with modules + sha256 per file) are served from the active downloaded pack (`DATA_DIR/xylem-pack/<ver>/`) or the built-in one; `apply()` downloads `config.xylem.packUrl` (raw GitHub `main/public/xylem/`), verifies hashes, switches and sends `reload` to every overlay/page SSE — **no restart**. `minAllmind` guards packs that need new server code. `src/roulette.js` = 치즈 roulette (server picks with `crypto.randomInt`, queue acked by the overlay, log). Page `/xylem`, overlays `/roulette`, `/dogfight`. **Live patch workflow**: edit `public/xylem/*`, `node tools/xylem-pack.mjs --bump`, commit, push `main` *without* bumping Allmind's version (no exe release) → owner presses 지금 적용. Mock: `MOCK_PACK_DIR=<dir>` serves a pack at `:9333/xylem-pack/` (fixtures point `xylem.packUrl` there).
- `src/deck.js` — Stream Deck / launcher URLs: `GET /deck/<action>[?name=…&key=…]` (bgm-toggle/play/pause/next/prev/vol-up/vol-down, sb-play?name=/sb-stop/sb-vol-*, mark). Plain GET because Stream Deck's Website action can't POST; optional `config.deck.token`. Settings-window card lists the URLs (`/api/launcher/deck`). Mic/scene stay with OBS's own Stream Deck plugin (owner's choice).
- `src/backup.js` — 설정 옮기기: export/import of config.json + data\*.json (not `uploads`) as one `.allmind` file, encrypted with the owner's passphrase (scrypt N=2^16 → AES-256-GCM; no built-in key on purpose). Import previews (`apply:false`), copies current settings to `가져오기 전 백업 <time>`, `freezeState()` stops pending writes, then restarts.
- `src/chzzk.js` — live status, chat, donations (unofficial endpoints; can break).
- `src/update.js` — in-app updater (`docs/plans/updater.md`): latest GitHub release → download → verify → start the new exe with `--restart`. Refuses while OBS streams/records. Release **tag must be `vX.Y.Z` and the asset `Allmind-X.Y.Z.exe`**. After an update the exe the owner originally started is overwritten in place (launcher env `ALLMIND_ORIGIN`/`ALLMIND_LAUNCHER`, `win.syncOriginLauncher`) — Windows-only, untested on a real PC.
- `src/config.js` — config/state paths (`%APPDATA%\Allmind` in the exe), defaults from
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
  end-of-session lagged/skipped-frame lines) and `data\allmind.log` (`[guard]` lines)
  when diagnosing performance.
- `dock.js` slot heights are *shares* of a column (flex-grow). Shares below 1 in total
  leave a panel only part-filling its column, so `normalize()` keeps each column's shares
  summing to its slot count and `render()` rescales over the visible slots (채팅 숨기기).
- 클릭 전달 (`Interact`) finds the 영도 page in OBS by the source's URL, which only comes from
  `DonationViewer.refreshInfo()`. It re-asks while the URL is missing and `urlHint` explains
  why (no source / not a Browser source / empty URL). Local-file Browser sources use `file:///`.
- iPad Safari can't read the MJPEG stream reliably; the client falls back to long-poll
  `/api/frame` automatically.
- Never ask for or keep `service.json` / Multi-RTMP config — they contain stream keys. Same for
  `google-auth.json` / `chzzk-auth.json` (refresh tokens). The YouTube key Allmind creates is shown
  only in the local settings window and never stored (only the stream id).
- Not verified against the real services yet (mock only): Google unverified-app login, auto-start of
  a fresh broadcast on Allmind's own key, Drive upload of a multi-GB file, CHZZK app registration /
  redirect URL (`http://localhost:<port>/api/chzzk-open/callback`), `/open/v1/users/me`, tag rules.

## The owner's machine

When the session is linked to the owner's computer (`mcp__remote-devices__*`), it is the
**stream PC**. Folder access must be requested per folder (`device_request_folder_access`);
`%APPDATA%\Allmind` can't be granted, so ask the owner for logs. To install a build:
`SendUserFile` the exe, then `device_commit_files` it into `~/Downloads` (the owner keeps
`Allmind-<ver>.exe` there). There's no device shell, and files can't be deleted.

## Model split (to save tokens)

Big or fuzzy work (new feature design, debugging from logs): plan first and write the plan
to `docs/plans/<topic>.md`. Clear, specified work (implement a plan, small fixes, build,
release notes): any model can do it from the plan + this file. Start a fresh session per
feature rather than continuing one very long conversation.
