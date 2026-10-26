# Google: YouTube archive guard + automatic Drive upload

Owner's problems (2026-10-26):
- He simulcasts every stream to YouTube as a **private** archive (OBS Multi-RTMP plugin, the
  "Stream now" / default stream key). Often the YouTube side never goes live because Studio still
  shows the previous stream's results screen, and he sometimes forgets to make it private. It
  **must never be public**.
- After each stream he uploads the recording (+ `….markers.json`) to a Google Drive folder by hand
  in the browser, for his editors and SkyEye. No Drive app on the stream PC.

Answers he gave: Drive = browser upload today; keep the original (copy, not move);
YouTube = fix automatically; setup = Stream now / default key.

## One Google sign-in (shared)

- The owner creates a Google Cloud project once (guide in the settings window + README):
  enable **YouTube Data API v3** and **Google Drive API**, OAuth consent screen "External",
  add himself, **publish it ("In production")** — in "Testing" Google expires refresh tokens after
  7 days. Unverified is fine for one user; the login shows "Google hasn't verified this app" →
  Advanced → continue.
- OAuth client type **Desktop app**; he pastes client ID + secret into the settings window.
- Login: settings window → "Google 로그인" opens the consent page; redirect to the loopback
  `http://127.0.0.1:<port>/api/google/callback` (local-only route), PKCE + state.
- Scopes: `https://www.googleapis.com/auth/youtube` (sensitive) and
  `https://www.googleapis.com/auth/drive.file` (only files/folders Allmind creates).
- Tokens in `DATA_DIR/google.json`. **Secret**: never shown on the dashboard, never in the log
  bundle, never logged. Access token refreshed on demand.
- `src/google.js`: `GoogleAuth` (token store, refresh, `fetch` wrapper with retry/backoff),
  base URLs configurable so the mock can stand in.

## YouTube archive guard (`src/youtube.js`)

Fix for the results screen: don't rely on the persistent "Stream now" broadcast at all.
- Setup: Allmind creates its own reusable stream key "Allmind 아카이브"
  (`liveStreams.insert`) and shows it **once, in the local settings window** so he can paste it
  into the Multi-RTMP YouTube target (one time). Allmind doesn't store the key; it keeps the
  stream **id**. (Using the default key with scheduled broadcasts is possible but which broadcast
  YouTube starts is unclear — verify before offering it.)
- **Always keep one ready broadcast**: private, `enableAutoStart`, `enableAutoStop`, bound to that
  stream, title from a template (`{date} 방송 아카이브`). Ensured at Allmind start, after each
  stream ends, and again when OBS starts streaming. Existing upcoming one is reused (id stored);
  anything not private is fixed (`liveBroadcasts.update`).
- While OBS streams (only then): check the broadcast every 60 s (1 quota unit).
  - privacy ≠ private → set private at once + red toast.
  - not live 90 s after OBS started → red banner on the dashboard (+ phone) with a link to Live
    Control Room.
  - after the stream: let auto-stop end it; if still live 2 min later, `transition complete`.
- Quota: ~50–200 units per stream (limit 10,000/day).
- Note: obs-websocket can't see Multi-RTMP plugin outputs, so "OBS started streaming"
  (`StreamStateChanged`) is the trigger.

## Drive upload (`src/drive.js`)

- After a recording stops and its markers file is written: queue the video, then the
  `.markers.json`. Folder: one Allmind creates ("Allmind 녹화", id stored). He can move it anywhere
  in his Drive (drive.file keeps access) or point SkyEye at it.
- Resumable upload (16 MB chunks), session URI + offset in `DATA_DIR/uploads.json` → survives
  restarts and network drops; retries with backoff.
- **Never uploads while OBS streams or records** (pauses mid-file, continues afterwards).
  Optional speed limit. Never deletes or moves the local file.
- Progress in the settings window and a small line on the dashboard; toast when done/failed.

## Upload names (owner's request 2026-10-26)

The owner names archives `[date] - [title about the content]`. Do it automatically **on the Drive
copy only** (the local OBS file keeps its name, since we copy):
- Template `config.drive.nameTemplate`, default `{date} - {title}`; `{date}` = recording start,
  local time, `YYYY-MM-DD` (owner confirmed: `2026-10-26`).
- `{title}` = the Chzzk live title (`chzzk.js` already polls it). Take the title that was shown for
  the **longest** part of the recording (titles get edited mid-stream), remembered by `markers.js`
  per recording. Not live while recording → fall back to the category, then `녹화`.
- Clean it for Windows (SkyEye/editors download it): drop `\ / : * ? " < > |` and control chars,
  collapse spaces, trim to ~150 chars. Keep the extension.
- Same name for the markers file: `<new name>.markers.json` (+ its `recording.file` field is the
  **Drive** name, so SkyEye matches them). Two recordings on one day with the same title →
  ` (2)`, ` (3)`.
- Shown in the upload list before it starts; the owner can edit the name there (until the upload
  begins).
- Nice to have: the YouTube archive broadcast gets the same title (one `liveBroadcasts.update`
  once the Chzzk title is known).

## "방송 준비" panel — one place for the stream title (owner's request 2026-10-26)

Today he sets the title in three places: Chzzk dashboard, YouTube, and the file name. One panel on
the **dashboard** (so it works from the main PC/phone, like scenes) with:
- **제목** (one field), **카테고리** (search box), **태그**; loads the current Chzzk values on open.
- **적용** → Chzzk title/category/tags via the **official CHZZK Open API**
  (`PATCH /open/v1/lives/setting`, scope "방송 설정 변경"; `GET` same path to read, scope
  "방송 설정 조회"; body `defaultLiveTitle`, `categoryType` GAME|SPORTS|ETC, `categoryId`, `tags`;
  tags can't contain spaces/special chars; title can't be empty) — docs:
  https://chzzk.gitbook.io/chzzk/chzzk-api/live . Needs an app registered at CHZZK Developers
  (client id/secret, redirect to Allmind's loopback callback) and one Naver login — a second
  sign-in next to Google, same token-store design (`DATA_DIR/chzzk-auth.json`, secret). Check
  whether app registration needs approval and how long tokens last (refresh) before building.
- Same apply also sets the **YouTube archive broadcast title** (`{date} - {title}`, template) and
  becomes the **Drive upload name** default (the "longest-shown title" rule still covers mid-stream
  edits made on Chzzk directly).
- Shows a check per target (✓ 치지직 · ✓ 유튜브 · 파일 이름) and the error if one failed.
- Category search: Open API has a category search endpoint — confirm path when building.
- Without the Chzzk login the panel still works for YouTube + file name (Chzzk read-only from the
  existing unofficial polling).

## Settings

`config.google = { clientId, clientSecret }`, `config.youtube = { enabled, titleTemplate }`,
`config.drive = { enabled, maxMbps }` (+ state: stream id, broadcast id, folder id in DATA_DIR).
Settings window card "Google (유튜브 아카이브 · 드라이브 업로드)" with login status, the two
toggles, the setup guide, and the one-time stream key display.

## Tests (mock)

Mock Google in `tools/mock-obs.js`: token endpoint, liveStreams/liveBroadcasts (list, insert, bind,
update, transition, lifecycle that goes "live" when the mock OBS streams), Drive files + resumable
upload (checks chunk offsets, can drop a chunk). Real Google behaviour (unverified-app screen,
auto-start with a dedicated key, quota) can only be checked by the owner.

## Log bundle (#6, separate, small)

Settings window → "로그 보내기": zip on the Desktop with `allmind.log` (+ `.old`), the newest 3 OBS
logs (`%APPDATA%\obs-studio\logs`), the newest OBS crash report, and `info.txt` (version, OS,
OBS connection, settings **without** passwords/tokens). Each file capped to its last 5 MB.
Explorer opens with the zip selected.
