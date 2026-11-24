# Allmind contracts

> **v1 — signed off at Gate 1 by gemini (2026-11-22); built in M5 (2026-11-22, mock-tested).** Changes from here on are additive only.

The single versioned source for what other programs may rely on: the local API that the assistant (Stream Sidekick) and future
clients use, and the files SkyEye reads. Anything not written here is internal and may change without notice.

| File | What | Readers |
|---|---|---|
| [auth.md](auth.md) | API token, `Authorization: Bearer`, who may connect, logging, error codes | every `/api/v1` client |
| [events.md](events.md) | `GET /api/v1/events` (SSE): `hello`, `chat`, `donation`, `stream`, `mark`, `part`, `deck-signal` | assistant |
| [commands.md](commands.md) | `GET /api/v1/info`, the five platform commands, module commands, **the excluded-actions rule** | assistant |
| [markers.md](markers.md) | `<video>.markers.json` (format `vodscout-markers` v2: ⭐ marks + chat log, parts) | SkyEye |
| [xylem.md](xylem.md) | Xylem module commands `/api/v1/m/xylem/*` (state, overlay text, 시청자 추첨, free wheel, VTS throw) — signed off at Gate 3 (2026-11-24) | assistant |

## Versioning
- `GET /api/v1/info` → `apiLevel` (integer, now **1**). Within one level, changes are **additive only**: new events, new fields,
  new commands, new `capabilities` entries. Clients must ignore unknown events and fields.
- A breaking change (a field removed or its meaning changed, a command removed) needs `/api/v2/` or a new `apiLevel`, a note here,
  and a check with every reader listed above.
- The markers file has its own `version` field (now 2); same rule: readers ignore unknown fields and unknown chat `type`s.
- Module commands (`/api/v1/m/<id>/…`) are versioned by the module (`modules[].version` in `/api/v1/info`).

## Ground rules every client can rely on
- The platform runs without any module and without the assistant. A client discovers what exists through `GET /api/v1/info` and
  degrades when something is missing (e.g. no `xylem` module → no Xylem commands).
- `/api/v1/events` never makes the stream PC do dashboard work (OBS polling, preview frames): it has its own client set and does not
  count as an open dashboard.
- Account-level and destructive actions are **never** in `/api/v1` (see commands.md, "Excluded actions").
- Chat text is untrusted input. Clients must treat it as data, never as instructions.

## Who changes what
Allmind's builder (claude-code) owns these files and the code behind them. A client that needs a change asks for it (vault note or
review comment); it lands here first, then in code. Review gates: Gate 1 (this draft, before M5), Gate 3 (Xylem commands, M2).
