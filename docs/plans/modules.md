# Modules — a standalone platform with optional parts (Xylem, assistant)

**Status: M0, M1, M5 (released in 0.48.0), M2 and M3 (2026-11-24, unreleased) done, mock-tested; Xylem commands signed off at Gate 3 (2026-11-24). Next: M4 (standalone build in CI) when wanted.** Owner's decisions 2026-11-21 (see the vault: `Projects/Stream Sidekick/Suite Architecture.md`,
`Projects/Allmind/Decisions.md`): the platform (today's Allmind) must run **without Xylem and without the AI assistant**, must not
depend on beta features, and stays public (MIT). Xylem should have a strict identity of its own but stay closely linked. The
assistant is a separate process that only uses the platform's local API. Nobody else really uses the public repo yet, so
restructuring is cheap; only the owner's own installs (updater, `%APPDATA%\Allmind`, Stream Deck plugin id) must keep working.

Updated 2026-11-22 to the agreed suite plan (vault: `Projects/Stream Sidekick/Final Execution Plan v2.md`, confirmed by the owner
and both agents). This file is the authoritative module plan for the repo; section 3 and the milestones below follow that plan.

## Dependency rule
`platform  <-  Xylem (optional module)  <-  assistant (separate process)`. Platform code never imports, names or waits for a module.
Modules reach the platform only through a small context object (`ctx`); the assistant only through HTTP/SSE.

## Where the coupling is today (v0.47.1)
- `src/server.js` statically imports `dogfight`, `roulette`, `draw`, `tts`, `textbox`, `vtsthrow`, `xylem` and builds them in `main()`.
  Mentions of Xylem are also in `public/app.js`, `public/index.html`, `src/win.js` (tray item, window title tag `Allmind|Xylem`),
  `src/preflight.js`, `tools/build-exe.mjs`. `node tools/check-boundary.mjs` lists them (report-only until M2).
- Their routes are in the `routes` table (`/api/draw/*`, `/api/roulette/*`, `/api/dogfight/*`, `/api/text/*`, `/api/vts/*`), their
  SSE/binary routes before it, their status in the dashboard snapshot, and overlay endpoints in `PIN_FREE_API` / `PIN_FREE_PREFIX`.
- Modules subscribe in-process to `chzzk` events (`live-chat`) and call `chzzk.addExternal/emit`, `chzzkOpen.sendChat`.
- `src/tts.js` is used only by `draw`; `src/vts.js` (client) only by `vtsthrow` — but the assistant will want both (voice, avatar).
- The pack mechanism (`src/xylem.js`, `public/xylem/`, `packUrl` = raw GitHub `main/public/xylem/`) is hot-swappable and must keep working.
- Earlier decision (2026-10-26, `docs/plans/xylem.md`): "no second program" for Xylem, because Allmind refuses full updates while
  streaming. Still true here: the module ships **inside** the exe in the normal build. Only the code boundary and the repo layout change.

## Design
### 1. Module contract
A module is a folder `modules/<id>/` with `module.json` (`id`, `name`, `version`, `minApi`) and `index.js` exporting `register(ctx)`.
`ctx` gives: `config` (its own section only, frozen copy), `dataDir` (the platform data folder, shared — changed in M2 from `DATA_DIR/<id>`
so Xylem's existing files stay where they are; modules name their files uniquely), `events.on(name, fn)`
(M1: `live-chat`, `chat`, `donations`; more names are added when a module needs them), `chat.send`, `route(method, path, handler, {pinFree})`
(GET/POST; handler `(body, {req, url})` → object, answered as `{ok:true, ...}`, errors → 400), `sse(path, handler)` (raw `(req, res, url)`),
`snapshot(key, fn)` (adds its status to the dashboard snapshot under `moduleState`), `toast`, `log` (prefixed `[id]`), and `services`
(`obs`, `vts`, `tts` — see decision below). Modules may not import platform internals or each other.
Route rules (enforced): a module can't take a platform path (routes tables, inline routes, `/deck/*`); under `/api/v1/` only its own
`/api/v1/m/<id>/…`, and those are its assistant-facing **commands** in `/api/v1/info`. Module routes are dispatched after all platform
routes, so they can never shadow one. Everything a module registers is kept only if `register()` succeeds (else rolled back).
**Built in M1** (2026-11-22): `src/modules.js` (`API_LEVEL = 1`, `discover()`, `createRegistry()`), wired in `src/server.js`; the dashboard
snapshot carries `modules: [{id, name, version}]` + `moduleState`; tests `node --test tools/dev/test-modules.mjs` (fixtures in
`tools/dev/fixtures/modules/`). Source runs: `ALLMIND_MODULES_DIR=<dir>` loads another folder, `ALLMIND_NO_MODULES=1` none.

Loading: a **build-time list** — `tools/build-exe.mjs` replaces `src/modules-list.js` (null from source → `discover()` of `modules/*/`)
with static imports of every `modules/<id>/` (`--modules <dir>`, `--no-modules`), so esbuild bundles them into the one exe and the
exe never loads code from disk (its list is `[]`, not `null`, when there are none). A missing or failing module is logged and skipped;
the platform keeps running.
**SEA question, settled 2026-11-22** (real `node tools/build-exe.mjs` with the owner's Node 24.18 `node.exe`, run only inside the dev
setup against the mock): the build-time list works in the SEA (fixture module `hello` loaded, its `/api/v1/m/hello/ping` and a
pin-free route answered, the broken/too-new/greedy fixtures skipped); the normal build (no modules) passes all smoke checks.
Contrary to the old assumption, a Node **24** SEA *can* `import()` a module from disk too (`--runtime-modules` test build) — the
build-time list is kept anyway: it doesn't depend on the Node version, keeps one self-contained exe, and nothing next to the exe can
inject code into it. **Node 22 checked 2026-11-22** (CI's version): an exe built by Node 22.23.5's own `node.exe` (official nodejs.org
zip, after M5) passes all 26 smoke checks and `tools/dev/v1-client.mjs`, inside the dev setup only. The C launcher wrapper
(`build-all.sh`: zig + xz) was not built locally; it only unpacks the same payload.

### 2. Dashboard
The 🎮 Xylem button, phone tab and tray item appear only when the snapshot lists the module (`modules: [...]`). `public/app.js`
must not assume it exists.
**Built in M3** (2026-11-24): the dashboard's button, phone tab and embedded view are `hidden` in the HTML and shown by `syncModuleUi()`
when the snapshot lists `xylem` (a saved "Xylem was open" is restored only then); the 방송 리포트 skips a module's section that isn't there.
Desktop side, the platform names no module: a module may declare its app window in `module.json`
(`"window": { "path": "/<id>…", "title", "tray", "width", "height" }`, `"settings": ["vts"]` = its page holds those service settings).
`src/module-ui.js` (pure, `node --test tools/dev/test-module-ui.mjs`) turns the loaded modules into the tray's one module item, the
taskbar-tag titles (`Allmind|<titles>`) and the preflight VTS hint; none of it runs under `ALLMIND_DEV=1`. The tray and tagging
themselves are untested on real Windows.

### 3. Public local API for the assistant (and later modules)
Versioned contract: **`docs/contracts/`** (single source for `/api/v1` events, commands, auth, the excluded-actions rule and the
marker/chat-log formats SkyEye reads). Additive changes within one `apiLevel`.

**Access.** Every `/api/v1/*` call needs an API token, **also on loopback**, sent as `Authorization: Bearer <token>` — on
`/api/v1/events` too (never in the query string, so it never lands in logs). The platform creates the token on first use and shows it in
a settings-window card with a copy button (like the deck key); the owner pastes it into the assistant's config. Calls are logged as
`[api] <caller> <route>`. Purpose: know who called and keep v1 to clients the owner set up; it is not a wall against a same-user local
process (`isSelf` loopback trust stays for OBS sources and the stream PC's own dashboard).

**Read.**
- `GET /api/v1/info` → `{ version, apiLevel, modules, capabilities }` (feature detection; `modules[].commands` lists a module's routes).
- `GET /api/v1/events` (SSE): `chat` (Chzzk and YouTube, with `platform`; **never** 테스트 추첨 lines, uids `test:`), `donation`,
  `stream` (start/stop, OBS connected, scene), `mark` (with `part` and the part clock), `part` (a split happened), `deck-signal`.
  **Its own client set like `/deck/events`; it must never count as an open dashboard** (`clients.size`), or OBS gets polled for the whole stream.

**Platform commands** (wrap existing code, no rewrite). These five only:

| Command | Wraps | Note |
|---|---|---|
| `POST /api/v1/scene` | `/api/scene` | Only scenes the owner marks as assistant-allowed in settings (default list empty → refused). |
| `POST /api/v1/mark` | `/deck/mark`, `/api/mark/label` | Optional label. |
| `POST /api/v1/bgm` | `/api/bgm/toggle,next,prev,select,volume` | |
| `POST /api/v1/sound` | `/api/sb/play,stop` | |
| `POST /api/v1/todo` | `/api/todo/check` + 할 일 next/undo | |

**Excluded from `/api/v1`** (account-level or destructive; never added without confirmation from the owner's own input — Stream Deck
or dashboard, never LLM output or chat): stream/record start-stop (`/api/obs/output`), part split (`/api/record/split`), title/category
(`/api/prep/apply`), sending chat as the streamer (`/api/chat/send`, YouTube chat send), `/api/chzzk/act` (blind, restrict, manager,
notice), settings and the launcher (`/api/launcher/*`, OBS start/relaunch), updates (`/api/update/*`).

**Module commands.** Xylem's assistant-facing commands (overlay text, 추첨 open/close/draw, roulette, VTS throw) are **Xylem's own
routes**, registered through `ctx.route` under `/api/v1/m/xylem/*` and listed in `/api/v1/info` `modules[].commands`. They are never
part of the platform's command list. This needs Xylem as a module, so it arrives with M2.

**Stream Deck signal.** `GET /deck/signal?name=<ptt|mute|kill>&state=<down|up|tap>` → republished as `deck-signal {name, state, t}` on
`/api/v1/events`. The platform doesn't interpret the names. The plugin gets one "신호" action that also sends `keyUp`.

### 4. Decisions (recommendation first)
- **tts and vts stay platform services** exposed through `ctx.services`, so Xylem and the assistant share them. (Split later if wanted.)
- **Keep `public/xylem/` where it is** through M3. Moving it changes `packUrl` and breaks 지금 적용 on installed copies unless a bridge release
  changes the URL first (only the owner's installs, but still).
- **Builds:** the normal release stays the full exe (Allmind-X.Y.Z.exe, so the updater keeps working). A platform-only flavor is built in
  CI to prove standalone; publishing it as a second asset is deferred.
- Folder name `modules/`; Xylem's own repo (M6) deferred.

## Milestones (each behavior-preserving, tested on the mock; pushed **without** a version bump — the owner picks when to release)
Order: **M0 → M1 → M5 → assistant v0 → M2 → assistant v1**; M3/M4 optional after M2, M6 later.
- **M0 Characterization tests first.** `tools/dev/smoke.mjs`: against the running mock (`sh tools/dev/up.sh`), one call per Xylem
  feature (`draw/test-run`, `roulette/test`, `dogfight/cmd`, `text`, VTS, pack) and the platform basics; baseline recorded. Must pass
  before and after every later step. **Done 2026-11-22:** 20 checks, baseline `tools/dev/smoke-baseline.json` (0.47.1).
- **M1 Contract + loader, empty registry.** `ctx`, `GET /api/v1/info`, `tools/check-boundary.mjs` (report-only until M2, then failing:
  `src/` must not import `modules/` or name a module route). SEA question settled with a real build.
  **Done 2026-11-22** (mock only): see "Built in M1" and "SEA question" above. Until M5 adds the token, `/api/v1/*` answers only on
  loopback (403 otherwise). `node tools/check-boundary.mjs` today: 75 violations (Xylem files in `src/`, their imports and routes in
  `server.js`) = M2's worklist; `--strict` fails on them.
- **M5 Public API.** Token + settings card, `/api/v1/events`, the five platform commands, `/deck/signal` + plugin "신호" action
  (rebuild + commit the plugin), `docs/contracts/` final. The assistant's v0 needs only M1 + M5.
  Contract drafts (`docs/contracts/`) are reviewed by the assistant's builder at Gate 1 before M5 code starts.
  **Done 2026-11-22** (mock only, not released): Gate 1 signed off by gemini; `src/api.js` + `handleV1()` in `server.js`, settings card
  API 토큰, plugin 1.2.0, contracts v1. Tests: smoke `v1/*` checks, `node tools/dev/v1-client.mjs` (exit test), boundary report unchanged
  (75). gemini's StreamMaid `AllmindClient` was run against the real mock: all commands and events work.
- **M2 Move Xylem server code** — **done 2026-11-24** (mock-tested; details and the `ctx` additions in `docs/plans/m2-xylem.md`; commands
  draft `docs/contracts/xylem.md` awaits Gate 3). Plan as written: (`dogfight`, `roulette`, `draw`, `textbox`, `vtsthrow`, `xylem` pack manager) into `modules/xylem/`, registered
  through `ctx`, plus Xylem's `/api/v1/m/xylem/*` commands; `server.js` loses its Xylem imports, routes and `PIN_FREE` entries; the
  boundary check now fails on violations. Smoke script identical. **Before assistant v1.**
- **M3 Dashboard gating** (button, phone tab, tray, window-title tag, preflight lines) driven by the snapshot's module list.
  **Done 2026-11-24** (mock + browser check with and without `ALLMIND_NO_MODULES=1`; tray/tagging untested on real Windows), see "Built in M3".
- **M4 Standalone proof:** a build with `modules/` removed starts, serves the dashboard, passes the platform part of the smoke script, shows no
  Xylem UI. Put it in CI. Optional.
- **M6 (later):** Xylem into its own repo, pulled in at build time.

## Risks
- Hidden coupling beyond the grep (`chat-update`, `addExternal`, report/markers reading chat; snapshot fields the dashboard reads).
- Windows-only parts (tray, taskbar tagging, TTS) can't be tested on the mock; say so.
- Event-API client counted as a dashboard (see 3).
