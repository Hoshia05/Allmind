# M2 — Xylem becomes a module (`modules/xylem/`)

**Status: code done 2026-11-24 (claude-code, mock-tested, no version bump); `docs/contracts/xylem.md` awaits gemini's Gate 3 review.** Part of `docs/plans/modules.md`; owner's go 2026-11-24.
Goal: `src/` no longer imports, names or routes anything of Xylem; Xylem reaches the platform only through `ctx`; every Xylem feature
behaves exactly as before (smoke baseline unchanged); Xylem offers its own assistant commands under `/api/v1/m/xylem/*` (contract draft
in `docs/contracts/xylem.md` for gemini's Gate 3 review). Dashboard gating (M3) and CI standalone proof (M4) are not part of this step.

## What moves
`src/dogfight.js`, `roulette.js`, `draw.js`, `textbox.js`, `vtsthrow.js`, `xylem.js` (pack manager) → `modules/xylem/` (same code,
imports rewritten to `ctx`), plus `modules/xylem/index.js` (`register(ctx)`: builds them, registers every route, page and channel) and
`module.json`. All their routes (`/api/draw/*`, `/api/roulette/*`, `/api/dogfight/*`, `/api/text/*`, `/api/xylem/*`, the VTS-throw routes,
the overlay channels and acks, `/api/draw/tts/<id>.wav`) and pages (`/xylem`, `/xylem/*`, `/dogfight`, `/roulette`, `/roulette-board`,
`/text`, `/draw`) keep their exact paths, so the dashboard, the Xylem page, OBS browser sources and the hot-swappable pack (`public/xylem/`,
`packUrl` unchanged) keep working.
**Stays platform:** `src/tts.js` and `src/vts.js` (services shared through `ctx.services`), the VTS connection routes (`/api/vts/connect`,
`reconnect`, `forget`, `expressions`, `expression`, `hotkeys`), the built-in pack files in `public/xylem/` (shipped as assets).

## `ctx` additions (additive; the module contract keeps `minApi` 1)
| Need (from the import map) | `ctx` |
|---|---|
| `loadState`/`saveState` with today's file names (so the owner's settings, logs, scoreboard survive) | `ctx.state.load(name, fallback)`, `ctx.state.save(name, value)` → the platform store (`DATA_DIR/<name>.json`; settings import still freezes it) |
| folders `DATA_DIR/xylem-pack`, `DATA_DIR/vts-items` | `ctx.dataDir` = the platform data folder (shared; M1 said `DATA_DIR/<id>` — no module used it yet, changed so existing data stays put) |
| `readAsset('public/xylem/…', 'public/vts-items/…')` | `ctx.assets.read(rel)` |
| Allmind's version (pack `minAllmind`) | `ctx.version` |
| `chzzk.on('live-chat')`, `.chat`, `.users`, `.addExternal`, `.emit('chat-update')`, `.chatState` | `ctx.services.chat` — a narrow facade with exactly those members |
| `chzzkOpen.configured/loggedIn/sendChat` (draw notices, `!룰렛` answer) | `ctx.services.chatSender` — facade with those three |
| `draw.streamStarted()` on stream start | `ctx.events.on('stream', fn(active))` |
| `speakable()` from `tts.js` | `services.tts.speakable(text)` (method added to `Tts`) |
| toasts (`추첨 음성` errors) | `ctx.toast` (exists) |
| the stream report reads the roulette log (`report.js`) | `ctx.reportSection(key, { build(range), refresh(saved) })` — `report.js` no longer knows the roulette |
| pages at fixed paths and under `/xylem/` | `ctx.route(…, { prefix: true })` (raw), `{ pinPage: true }` (asks for the PIN like the dashboard) |
| overlay channels exempt from the PIN | `{ pinFree: true }` (exists; now also for prefix routes) |

## Assistant commands (draft → `docs/contracts/xylem.md`, Gate 3)
`POST /api/v1/m/xylem/text`, `/draw`, `/wheel`, `/vts-throw` — overlay text, 시청자 추첨 open/close/draw/end, a free wheel (무료 룰렛, no
donation link), one VTS throw. Not offered: donation-roulette test spins, settings, logs, pack apply (an update), anything that sends chat
on its own initiative beyond Xylem's existing notices (flagged for review). Errors use the `/api/v1` codes: a module may throw an error
carrying `status` + `code` from the contract list; anything else → 400 `bad-request`.

## Tests
- Smoke (`tools/dev/smoke.mjs`): every existing check unchanged; the only intended baseline change is `/api/v1/info` listing the `xylem`
  module and its commands. New checks for the four commands (token required, happy path, validation).
- `node tools/check-boundary.mjs --strict` passes (0 violations); the remaining "Xylem" mentions in `public/app.js`, `win.js` are M3's.
- Unit tests (`tools/dev/test-modules.mjs`) extended for prefix routes, `pinPage`, `state`, `reportSection`.
- Standalone proof (preview of M4): `ALLMIND_NO_MODULES=1` → the platform part of the smoke suite passes, Xylem routes 404.
- Exe build with the module bundled; smoke against the exe in the dev setup.
