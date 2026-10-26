# Xylem — viewer interaction inside Allmind, patchable mid-stream

**Status: being built (0.29.0).** Owner's decision 2026-10-26: no second program. Allmind refuses
full updates while OBS streams/records (BGM, YouTube guard, uploads live there), so the parts we want
to patch live — game/roulette overlays and their settings pages — become a hot-swappable
**pack** that Allmind downloads and switches to without restarting. The (separate) `Hoshia05/Xylem`
repo only holds the abandoned first plan.

## Split of responsibilities

- **Allmind server (stable, normal updates after the stream):** chat/donation events in, state out.
  `src/xylem.js` = pack manager; `src/roulette.js` = 치즈 roulette rules, queue, log;
  `src/dogfight.js` = chat relay + ace board (as before). Generic, rarely changes.
- **Pack (hot-swappable, `public/xylem/`):** everything visual and every settings UI.
  - `manifest.json` — `{ version, minAllmind, modules: [{ id, name, icon, overlay, panel }], files: { path: sha256 } }`
  - `index.html` + `xylem.css` + `xylem.js` — the Xylem page shell (sidebar, header with pack status)
  - `<module>.html` — the OBS overlay; `<module>.panel.js` — ES module `export function mount(el, x)`
    giving that module's live controls + settings on the Xylem page.
  Embedded in the exe (build-exe now recurses into `public/` subfolders) = the **built-in pack**.

## Pack updates

- Source: `config.xylem.packUrl` (default `https://raw.githubusercontent.com/Hoshia05/Allmind/main/public/xylem/`;
  the repo is public). `GET manifest.json` → newer `version` (semver) and `minAllmind <= VERSION` → offer.
- Apply (button on the Xylem page, works while live): download every file in `manifest.files`, check
  each sha256, write to `DATA_DIR/xylem-pack/<version>/`, then make it active (`data/xylem.json`).
  Old downloaded versions kept (last 3) for **rollback**; "내장 팩" is always available.
- Serving: active downloaded pack if it is newer than the built-in one, else built-in. A new Allmind exe
  whose built-in pack is newer wins automatically.
- On switch: every overlay/panel SSE gets `reload` → OBS browser sources and open Xylem pages reload
  themselves within ~1 s. Overlays also reload when the version in a reconnect's `hello` differs.
- A pack needing new server features raises `minAllmind`; Allmind then says "Allmind 업데이트 필요".
- Dev mock: `XYLEM_PACK_URL=http://127.0.0.1:9333/xylem-pack/` (mock serves a bumped copy of `public/xylem`).

Mid-stream patch workflow: edit `public/xylem/*`, bump `manifest.json` version (+ regenerate hashes with
`node tools/xylem-pack.mjs`), push `main` (no Allmind version bump → no exe release). Owner presses 적용.

## Xylem page `/xylem`

Own window/tab (any device, like the dashboard). Dashboard top bar: a 🎮 Xylem button; tray menu
"Xylem 열기". Sidebar per module; header: pack version + update/rollback. Each panel: live control,
settings, overlay address (copy). Nothing on the dashboard itself.

## 치즈 룰렛

Owner's choices: price per spin, multiples (1,000 = 1 spin, 3,000 = 3), max per donation.
Server picks with `crypto.randomInt` by weight, logs, queues; overlay animates to the given result and
acks (`/api/roulette/shown`), so reloads replay the same spin. Log with ✓ 완료, test spins (marked),
skip, clear. Settings: on/off, title, price, max spins, donation kinds (CHAT/VIDEO/MISSION), spin/hold
seconds, items (name, weight, colour; % shown live). Overlay `http://localhost:8080/roulette`.

## 공중전

Overlay stays at `/dogfight` (OBS unchanged), now served from the pack. Panel: URL builder (lobby,
fighters, boss every N, board, help), 지금 시작 / 다음 판 보스전 (sent as the streamer), test pilot,
ranking + reset.
