# Xylem commands — `/api/v1/m/xylem/*`

> **v1 — signed off at Gate 3 by gemini (2026-11-24); built in M2 (2026-11-24, mock-tested, not released yet).** Changes from here on are additive only.
> Same auth, logging and error format as every `/api/v1` call ([auth.md](auth.md)): `Authorization: Bearer <token>`, `X-Allmind-Client`,
> answers `{ ok: true, … }` or `{ ok: false, code, error }`.

Xylem is an optional module ([README](README.md)). Its commands exist only when it is loaded: check `GET /api/v1/info` →
`modules[]` has `{ id: "xylem", commands: [...] }`. Without the module every path below answers 404 `not-found`.
Module version: `modules[].version` (now `1.0.0`). Changes inside apiLevel 1 are additive.

## `GET /api/v1/m/xylem/state` — read only
```json
{ "ok": true,
  "draw": { "phase": "idle", "count": 0 },
  "wheels": [ { "id": "w1", "title": "벌칙 룰렛" } ],
  "textBoxes": [ { "id": "1", "name": "텍스트 1", "visible": true } ],
  "vts": { "ready": true } }
```
- `draw.phase`: `idle` | `entry` (참여 받는 중) | `ready` (마감, 아직 안 뽑음) | `drawing` (overlay 연출 중) | `winners`. `count` = entrants.
- `wheels`: the free wheels (무료 룰렛) the owner saved on the Xylem page — the only ones `wheel` accepts. `textBoxes`: overlay text boxes.
- Lets the assistant build its tool lists from what exists instead of hard-coding ids.

## Commands
| Command | Body | Success | Errors |
|---|---|---|---|
| `POST …/text` | `{ "text": "…", "box"?: "1", "show"?: true }` | `{ "ok": true, "box": "1" }` | 400 `bad-request`: `text` missing or not a string, longer than **200** characters, unknown `box` |
| `POST …/draw` | `{ "action": "open" \| "close" \| "draw" \| "end" \| "cancel", "sec"?: 60 }` | `{ "ok": true, "phase": "entry" }` | 409 `conflict`: not possible in this phase (e.g. `close` when not open, `draw` with no entrants, `end` when not on the winners screen); 400 `bad-request`: unknown action |
| `POST …/wheel` | `{ "id": "w1" }` | `{ "ok": true, "results": ["꽝"] }` | 400 `bad-request`: unknown wheel id |
| `POST …/vts-throw` | `{}` | `{ "ok": true }` | 409 `conflict`: VTube Studio not connected, throws turned off by the owner (Xylem → VTube Studio), or the throw queue full |

Details:
- **`text`** puts exactly the given string on stream in an overlay text box (box 1 by default), visible unless `show: false`.
  `"text": ""` clears it. Only words the streamer said may reach it — never chat or other untrusted text (see the rule below).
- **`draw`** — 시청자 추첨: `open` starts entry (`sec` = entry time in seconds; omitted = the owner's default, `0` = until closed),
  `close` stops entry, `draw` picks winners (the overlay stages it), `end` leaves the winners screen, `cancel` resets from any phase.
  The draw is fair as before (server-side, equal odds). **An assistant-started `open` or `draw` never posts Xylem's chat notices**
  (entry / winners lines in Chzzk chat), even when the owner has notices on; the same actions from the dashboard still post them.
- **`wheel`** spins one free wheel once. Free wheels have no donation link (no pay-to-win impact). Donation roulettes are not offered.
- **`vts-throw`** throws one item at the model on the main PC. It bypasses the viewers' per-user cooldown (like the panel's test throw),
  so **the client rate-limits itself** (suggestion: at most one per few seconds; the platform does not enforce it in apiLevel 1).
- The commands have no confirmation step: all four are reversible stream fun the streamer asks for by voice.

## Not offered (stays on the Xylem page / dashboard)
Donation-roulette test spins, any settings (roulette, draw, text styles, 공중전 mode, VTS throw settings), clearing logs or past winners,
테스트 추첨, 다시 뽑기, the overlay pack check/apply/use (that's an update), uploading or removing VTS items, aim. Xylem's own chat
behavior towards viewers (`!룰렛` answers, notices from dashboard-started draws) is unchanged and not reachable from `/api/v1`.

## The rule for clients (same as [commands.md](commands.md), "Excluded actions")
1. No `/api/v1` command, platform or module, makes Allmind speak in chat as the streamer.
2. Overlay text is on-screen speech: give the LLM the `text` tool only with the streamer's own transcript as input, never chat,
   digests or other untrusted data; keep it short; treat a `text` call like any other named tool (one tool → one endpoint, plain-code mapping).

## Gate 3 outcome (gemini, 2026-11-24)
- `text` without a confirmation step: **approved**, given rule 2 (only the streamer's own transcript reaches it) and that it is capped
  at 200 characters and instantly reversible (`"text": ""` or `show: false`).
- `vts-throw` rate limit: **client-side in apiLevel 1** (StreamMaid: at most one per 3 s, in plain code); the platform's 409s
  (throws off, VTS not connected, queue full) stay as they are. A server-side limit can be added later (additive).
- `state` fields: **enough as written** (wheel ids + titles, text box ids + names, draw phase/count, VTS ready).
