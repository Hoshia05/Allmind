# `/api/v1` commands, info, and the excluded-actions rule

> **v1 — signed off at Gate 1 by gemini (2026-11-22); built in M5 (2026-11-22, mock-tested).** Changes from here on are additive only.

All commands are `POST` with a JSON body (`Content-Type: application/json`), answer JSON, and wrap code the dashboard already uses
(no second implementation). Each command does one thing; there is no generic "call any route" command.

## `GET /api/v1/info` (built, M1)
```json
{ "ok": true, "version": "0.47.1", "apiLevel": 1,
  "modules": [ { "id": "xylem", "name": "Xylem", "version": "1.0.0", "commands": ["POST /api/v1/m/xylem/text"] } ],
  "capabilities": [] }
```
- `modules`: loaded optional modules; empty when Allmind runs alone. `commands`: the module's own `/api/v1/m/<id>/…` routes.
- `capabilities` (M5): names of what this Allmind offers, so a client can check before using it:
  `events`, `scene`, `mark`, `bgm`, `sound`, `todo`, `deck-signal`. All seven are present since M5.

## Platform commands (M5)

### `POST /api/v1/scene`
Body `{ "name": "BRB" }` (as `/api/scene`) → `{ "ok": true, "scene": "BRB" }`.
- Only scenes the owner ticked as **assistant-allowed** in the settings window (a wrong scene can show a desktop or a private
  source). The list is empty by default, so until the owner fills it every call answers 403 `not-allowed`.
- Unknown scene → 400 `bad-request`; OBS not connected → 502 `obs-unavailable`.
- The allowed list is shown to clients nowhere else; `hello.state.scene` and `stream` events tell the current scene.

### `POST /api/v1/mark`
Body `{ "label": "디코 친구 개웃김" }` (optional, ≤ 200 characters) → `{ "ok": true, "t": 1234.5, "part": 1, "count": 3 }`.
- Same as the ⭐ button: a mark in the markers file (and an OBS chapter when possible). `t` = seconds into this part's video.
- Not recording → 409 `conflict`. Also produces a `mark` event.

### `POST /api/v1/bgm`
Body `{ "action": "toggle" | "next" | "prev" | "select" | "volume", "id"?: "<track id>", "db"?: -20 }` → `{ "ok": true }`.
- `select` needs `id` (a track id as the setlist has it; clients get ids only from the owner's config for now — a read
  command for the setlist can be added later). `volume` needs `db` (−60 … 0).
- Same code as the dashboard's BGM buttons, including 영도 auto-pause behavior.

### `POST /api/v1/sound`
Body `{ "action": "play", "id": "박수.mp3" }` or `{ "action": "stop" }` → `{ "ok": true }`.
- `id`: a soundboard file name. Missing "Soundboard" source in OBS → 409 `conflict`.

### `POST /api/v1/todo`
Body `{ "action": "check", "id": "<item id>", "done": true }`, `{ "action": "next" }` or `{ "action": "undo" }` → `{ "ok": true }`.
- `next` checks the first unchecked 오늘 item in the dashboard's order (like the Stream Deck's 할 일 key); `undo` unchecks the
  latest checked one. Nothing to check/undo → 409 `conflict`.

## Module commands
- A module's assistant-facing commands are **its own routes**, registered through `ctx.route` under `/api/v1/m/<id>/…` and
  listed in `/api/v1/info` `modules[].commands`. They are not part of the platform's command list and appear only when the module
  is loaded. Same auth, logging and error format as above (the platform wraps them).
- **Xylem** (overlay text, 시청자 추첨 open/close/draw, roulette, VTS throw) arrives with M2, before Sidekick v1; its routes get
  their own section here then (Gate 3 review).

## Excluded actions (the rule)
`/api/v1` — platform and modules alike — never offers an account-level or destructive action. Today that means, with the
dashboard route each would wrap:

| Excluded | Dashboard route (stays dashboard/settings-only) |
|---|---|
| Stream or recording start/stop | `POST /api/obs/output` |
| ✂ 파트 나누기 (split) | `POST /api/record/split`, `prep/apply {split}` |
| Title / category | `POST /api/prep/apply` |
| Sending chat as the streamer (Chzzk or YouTube) | `POST /api/chat/send` |
| Blind, 임시 제한/활동 제한, manager role, notice | `POST /api/chzzk/act` |
| Settings, logins, launcher, OBS start/relaunch, firewall, remove-all | `/api/launcher/*`, `POST /api/obs/relaunch` |
| Updates | `/api/update/*` |

Rules for later additions:
1. A new command may only be added here if it is neither account-level nor destructive (can't end, rename or split the
   broadcast, speak as the streamer, act on a viewer, change settings, or install anything).
2. If a risky action is ever wanted, the assistant may only **ask** for it; it runs after the owner confirms through their own
   input — a Stream Deck key or the dashboard — never because of LLM output or chat. That needs its own design here first.
3. The assistant side gives its LLM only named tools, each mapped in plain code to exactly one endpoint in this file; no generic
   HTTP/fetch tool. Chat never reaches a tool-calling turn as instructions.
