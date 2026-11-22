# `GET /api/v1/events` — the event stream

> **v1 — signed off at Gate 1 by gemini (2026-11-22); built in M5 (2026-11-22, mock-tested).** Changes from here on are additive only.

## The stream
- Server-Sent Events, `Content-Type: text/event-stream`. Each event is `event: <name>` + one `data:` line of JSON + a blank line.
  A comment line `: ping` every 25 s keeps idle connections alive; clients ignore comments.
- Needs `Authorization: Bearer <token>` (Node: any SSE client that sends headers, e.g. `fetch` + a stream reader or `eventsource`
  with headers). Without it → 401 JSON, no stream.
- **Own client set.** Connected clients are kept apart from the dashboard's. An open `/api/v1/events` never turns on dashboard-only
  work (OBS polling, preview frames, level/fps pushes, the 10-min pre-stream check). Measurable: with only this stream open the
  dashboard client count stays 0 and OBS requests stay at the idle rate.
- **No replay** in apiLevel 1: events that happen while a client is disconnected are lost (no `id:` / `Last-Event-ID`). After a
  (re)connect, the first `hello` carries the current state, so a restarted client knows where things stand. Replay can be added
  later (additive).
- Order: events are sent in the order the platform sees them. Clients must tolerate gaps (chat drops, restarts).
- Every `data` object has `at`: the platform's wall-clock time in ms since 1970 when it emitted the event.
- Unknown events and unknown fields must be ignored (additive changes, see [README](README.md)).
- Slow clients: if a client's socket buffer backs up (> ~1 MB unsent), the platform closes that stream; the client reconnects.

## Events

### `hello` — first event after connecting
```json
{ "at": 1795333981420, "version": "0.48.0", "apiLevel": 1, "caller": "sidekick/0.1.0",
  "state": { "obs": true, "live": true, "recording": true, "scene": "Main", "part": 1 } }
```
`state.part` is 0 when not recording. `version`/`apiLevel` as in `GET /api/v1/info`.

### `chat` — a live chat line (Chzzk or YouTube)
```json
{ "at": 1795333981420, "platform": "chzzk", "kind": "chat", "id": "1795333981000:9f3c…:안녕하세요",
  "uid": "9f3c…", "nick": "시청자1", "role": "viewer", "text": "안녕하세요 {:d_12:}", "verified": false,
  "sub": { "months": 3, "tier": 1 } }
```
- `platform`: `chzzk` | `youtube`. `kind`: `chat` | `subscription`. A subscription line has a top-level `months` (the month count of that subscription
  message, or `null`); `sub.months` is the viewer's subscription badge, present on any line.
- `id`: stable per message for de-duplication (Chzzk: time + uid + start of text; YouTube: `yt:<message id>`).
- `uid`: the platform's viewer id (`yt:<channel id>` for YouTube), for telling viewers apart. Not a name; may be empty.
- `role`: `streamer` | `manager` | `viewer`.
- `text`: as the platform sends it, ≤ 500 characters; Chzzk emoticons stay as `{:code:}`. **Untrusted input.**
- `sub`: Chzzk subscription badge `{ months, tier }` or `null`. YouTube adds `member: true|false`.
- Which lines are included: only **live** lines. Never the replay of recent messages on (re)connect, never 시청자 추첨's
  🧪 테스트 추첨 lines (uids `test:…`), never system notices or the dashboard's own dividers. This is the same set the markers
  chat log saves (`live-chat` + YouTube chat in the code).
- Chat volume: raids and 추첨 entry words can mean dozens of lines per second. The platform sends them all; filtering is the
  client's job (Plan v2 guardrail: the assistant filters locally).

### `donation` — a donation (Chzzk 치즈; YouTube Super Chat/Sticker when known)
```json
{ "at": 1795333981420, "platform": "chzzk", "id": "…", "uid": "…", "nick": "시청자2", "role": "viewer",
  "text": "추락 장인", "amount": 1000, "donationType": "CHAT" }
```
- A donation is sent **only** as `donation`, never also as `chat`.
- `amount`: number (치즈) or `null` if unknown; YouTube has `amountText` (e.g. `"₩5,000"`) instead. `donationType`: Chzzk's
  `CHAT` | `VIDEO` | `MISSION` … or `null`.
- Anonymous Chzzk donations have `nick: "익명"` and may have an empty `uid`.

### `stream` — broadcast, recording, OBS and scene changes
```json
{ "at": 1795333981420, "what": "live", "on": true }
{ "at": 1795333981420, "what": "recording", "on": false }
{ "at": 1795333981420, "what": "obs", "on": true }
{ "at": 1795333981420, "what": "scene", "scene": "BRB" }
```
- `what: live` — OBS's stream output started/stopped (from OBS's events, not polling). `recording` — OBS recording
  started/stopped. `obs` — Allmind connected to / lost OBS. `scene` — OBS's program scene changed (any cause).
- Sent only on changes; the current values are in `hello.state`.

### `mark` — a ⭐ mark was made (any source: Stream Deck, /mark page, dashboard, `POST /api/v1/mark`)
```json
{ "at": 1795333981420, "index": 2, "t": 1234.5, "part": 1, "label": "" }
```
- `t`: seconds into **this part's** video file (the part clock, restarts at 0 after a split) — the same `t` as in the markers file.
- `part`: 1, 2, … within this recording. `index`: 0-based position in this part's mark list. `label`: as typed (may be empty).

### `part` — the recording was split (✂ 파트 나누기)
```json
{ "at": 1795333981420, "part": 2, "previous": 1, "mode": "split" }
```
- Sent after the cut succeeded. `mode`: `split` (OBS split the file) | `restart` (recording stopped and started again).
- From now on `mark.t` counts from 0 in part `part`.

### `deck-signal` — a generic Stream Deck signal
```json
{ "at": 1795333981420, "name": "ptt", "state": "down" }
```
- From `GET /deck/signal?name=<ptt|mute|kill>&state=<down|up|tap>` (the plugin's "신호" action; deck key rules as for every
  `/deck/*` action). Republished as is; **the platform doesn't interpret the names**.
- `name`: `ptt` | `mute` | `kill` in apiLevel 1 (unknown names are refused with 400, so a typo doesn't reach the client silently).
- `state`: `down` (key pressed), `up` (released), `tap` (a key without hold support). Tap vs. hold is the client's call, from
  the `at` timestamps of `down`/`up`. The plugin sends `up` only for this action.
- Clients should act on `mute`/`kill` at `down`/`tap` without waiting for `up` (agreed 2026-11-22).
- Latency: the Stream Deck is on the main PC, so there is one LAN hop before `at` is stamped. A lost `up` is possible: clients
  must cap hold-to-talk themselves (Plan v2: ~20 s).
- Note for review: Plan v2 named this field `t`; it is `at` here like every other event, because `t` already means "seconds into
  the video" in `mark`.

## Not in the stream (by design)
Dashboard-only data (preview frames, audio levels, fps, BGM progress), viewer card details, settings, tokens. Module events
(e.g. Xylem's 추첨 phases) are not in this stream in apiLevel 1; a module can offer its own channel under `/api/v1/m/<id>/`.
