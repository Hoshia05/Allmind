# Modules — a standalone platform with optional parts (Xylem, assistant)

**Status: plan only, nothing built.** Owner's decisions 2026-11-21 (see the vault: `Projects/Stream Sidekick/Suite Architecture.md`,
`Projects/Allmind/Decisions.md`): the platform (today's Allmind) must run **without Xylem and without the AI assistant**, must not
depend on beta features, and stays public (MIT). Xylem should have a strict identity of its own but stay closely linked. The
assistant is a separate process that only uses the platform's local API. Nobody else really uses the public repo yet, so
restructuring is cheap; only the owner's own installs (updater, `%APPDATA%\Allmind`, Stream Deck plugin id) must keep working.

## Dependency rule
`platform  <-  Xylem (optional module)  <-  assistant (separate process)`. Platform code never imports, names or waits for a module.
Modules reach the platform only through a small context object (`ctx`); the assistant only through HTTP/SSE.

## Where the coupling is today (v0.46.5)
- `src/server.js` statically imports `dogfight`, `roulette`, `draw`, `tts`, `textbox`, `vtsthrow`, `xylem` (lines ~32–37, 43) and builds
  them in `main()` (~443–453). 27 lines in it mention Xylem; `public/app.js` 26, `public/index.html` 4, `src/win.js` 6 (tray item, window
  title tag `Allmind|Xylem`), `src/preflight.js` 2, `tools/build-exe.mjs` 1.
- Their routes are in the `routes` table (`/api/draw/*`, `/api/roulette/*`, `/api/dogfight/*`, `/api/text/*`, `/api/vts/*`, ~814–877), their
  SSE/binary routes before it (~1245–1267), their status in the dashboard snapshot (~465–471), and overlay endpoints in `PIN_FREE_API` /
  `PIN_FREE_PREFIX`.
- Modules subscribe in-process to `chzzk` events (`live-chat`) and call `chzzk.addExternal/emit`, `chzzkOpen.sendChat`.
- `src/tts.js` is used only by `draw`; `src/vts.js` (client) only by `vtsthrow` — but the assistant will want both (voice, avatar).
- The pack mechanism (`src/xylem.js`, `public/xylem/`, `packUrl` = raw GitHub `main/public/xylem/`) is hot-swappable and must keep working.
- Earlier decision (2026-10-26, `docs/plans/xylem.md`): "no second program" for Xylem, because Allmind refuses full updates while
  streaming. Still true here: the module ships **inside** the exe in the normal build. Only the code boundary and the repo layout change.

## Design
### 1. Module contract
A module is a folder `modules/<id>/` with `module.json` (`id`, `name`, `version`, `minApi`) and `index.js` exporting `register(ctx)`.
`ctx` gives: `config` (its own section only), `dataDir` (its own folder), `events.on(name, fn)` (chat, live-chat, donation, state),
`chat.send`, `route(method, path, handler, {pinFree})`, `sse(path, handler)`, `snapshot(key, fn)` (adds its status to the dashboard snapshot),
`toast`, `log`, and `services` (OBS, VTS, TTS — see decision below). Modules may not import platform internals or each other.
Loading: dev/source = dynamic `import()` of `modules/*/index.js` if present; exe = a registry generated at build time (esbuild bundles a
static list; a SEA can't read module files from disk — **unverified**, check first in M1). A missing or failing module is logged and
skipped; the platform keeps running.

### 2. Dashboard
The 🎮 Xylem button, phone tab and tray item appear only when the snapshot lists the module (`modules: [...]`). `public/app.js`
(26 mentions) must not assume it exists.

### 3. Public local API for the assistant (and later modules)
- `GET /api/v1/info` → `{ version, apiLevel, modules, capabilities }` (feature detection).
- `GET /api/v1/events` (SSE): chat, donations, stream/OBS state, marks, broadcast start/stop. **Its own client set like `/deck/events`;
  it must never count as an open dashboard** (`clients.size`), or OBS gets polled for the whole stream.
- Commands: wrap existing routes first (scene, mark, title, chat send, overlay text), no rewrite. Loopback needs no key; other
  addresses use a token like `deck.token`. Additive changes within one `apiLevel`. Documented in `docs/api.md`.

### 4. Decisions to make (recommendation first)
- **tts and vts stay platform services** exposed through `ctx.services`, so Xylem and the assistant share them. (Split later if wanted.)
- **Keep `public/xylem/` where it is** through M3. Moving it changes `packUrl` and breaks 지금 적용 on installed copies unless a bridge release
  changes the URL first (only the owner's installs, but still).
- **Builds:** the normal release stays the full exe (Allmind-X.Y.Z.exe, so the updater keeps working). A platform-only flavor is built in
  CI to prove standalone; publishing it as a second asset is open.
- Folder name `modules/` and own repo for Xylem later (`Hoshia05/Xylem` exists, only the abandoned first plan): open.

## Milestones (each behavior-preserving, tested on the mock; a push that bumps the version releases — bump only when the owner wants)
- **M0 Characterization tests first.** A mock-based smoke script (`tools/dev/smoke.mjs`): start mock + server, hit one call per Xylem feature
  (`draw/test-run`, `roulette/test`, `dogfight/cmd`, `text`, snapshot keys) and the platform basics; record the baseline. Must pass before and
  after every later step.
- **M1 Contract + loader, empty registry.** `ctx`, `GET /api/v1/info`, `tools/check-boundary.mjs` (fails if `src/` imports `modules/` or names
  a module route). Resolve the SEA question. No moves yet.
- **M2 Move Xylem server code** (`dogfight`, `roulette`, `draw`, `textbox`, `vtsthrow`, `xylem` pack manager) into `modules/xylem/`, registered
  through `ctx`; `server.js` loses its Xylem imports, routes and `PIN_FREE` entries. Smoke script identical.
- **M3 Dashboard gating** (button, phone tab, tray, window-title tag, preflight lines) driven by the snapshot's module list.
- **M4 Standalone proof:** a build with `modules/` removed starts, serves the dashboard, passes the platform part of the smoke script, shows no
  Xylem UI. Put it in CI.
- **M5 `/api/v1/events` + commands + `docs/api.md`.** The assistant's v0 needs only this milestone (and M1), not M2–M4.
- **M6 (optional, later):** Xylem into its own repo, pulled in at build time.

## Risks
- Hidden coupling beyond the grep (`chat-update`, `addExternal`, report/markers reading chat; snapshot fields the dashboard reads).
- The SEA/esbuild loading assumption above.
- Windows-only parts (tray, taskbar tagging, TTS) can't be tested here; mock only, say so.
- Event-API client counted as a dashboard (see 3).
