# `/api/v1` access: token, callers, errors

> **v1 — signed off at Gate 1 by gemini (2026-11-22); built in M5 (2026-11-22, mock-tested).** Changes from here on are additive only.

## The token
- Every `/api/v1/*` request needs the API token, **also from loopback** (127.0.0.1 / ::1). This includes the SSE stream
  `GET /api/v1/events`.
- Sent only as a header: `Authorization: Bearer <token>`. Never in the query string (it would end up in logs and browser history).
  A token in `?token=` is refused like a missing one.
- Format: 43 characters, URL-safe base64 of 32 random bytes. Compared in constant time.
- Where it comes from: the platform creates it the first time the owner opens the **API 토큰** card in the settings window
  (설정 창, stream PC only). The card shows it **once**, right after it is made, with a copy button (only its hash is kept); the owner pastes it into the
  client's own config. Lost → make a new one. **새로 만들기** replaces it: the old token stops working at once and open `/api/v1/events` streams using it are closed.
- The client keeps the token in its own config (e.g. Sidekick's `.env`). It must not read Allmind's files (`%APPDATA%\Allmind`).
- Stored in Allmind's data folder as a SHA-256 hash only. Not part of 설정 옮기기 exports (a moved install gets a new token).
- One token in apiLevel 1 (one assistant). Several named tokens can be added later without a breaking change.

Purpose, stated honestly: the token tells Allmind **who** is calling (for the log) and keeps `/api/v1` to clients the owner set up.
It is **not** a wall against another program running as the same Windows user on the stream PC: that program could read the
client's config. Loopback trust for OBS browser sources and the stream PC's own dashboard is unchanged (`isSelf`); those don't
use `/api/v1`.

## Who may connect
- Loopback with the token: always.
- Other devices (e.g. a client developed on the main PC against the stream PC's LAN address): only with the token **and** only while
  the settings toggle 다른 기기에서 대시보드 열기 허용 (`lanAccess`) is on — the same switch that already controls the dashboard on the LAN.
- The optional PIN for other devices does **not** apply to `/api/v1`; the token replaces it there.
- Remote-access mode (added 2026-11-23, settings 다른 기기에서 열기: 끄기 / 같은 네트워크 + Tailscale / Tailscale만, see
  `docs/plans/remote-access.md`): another device must also be on a network the mode allows; if not, the answer is 403 `lan-off`,
  the same code as before. A request reaching Allmind through Tailscale Serve/Funnel is refused the same way. A client on the stream
  PC itself (`127.0.0.1`) is allowed in every mode. `lanAccess` in the settings views means "mode isn't 끄기".
- The request guard still applies: Host allow-list; a request with an `Origin` header must be same-origin (browser pages on other
  sites can't call `/api/v1`). Non-browser clients send no `Origin`.

## Caller name and log
- Optional header `X-Allmind-Client: <name>/<version>` (≤ 40 visible ASCII characters, e.g. `sidekick/0.1.0`). Used only in the log;
  access depends on the token alone. Missing → `unknown`.
- Each call is logged once as `[api] <caller> <METHOD> <route> → <status>` in `allmind.log` (설정 창 → 로그 보내기). Event streams log
  connect and disconnect, not every event. Request bodies are not logged (chat text, labels).

## Errors
Every `/api/v1` answer is JSON. Success: `{ "ok": true, … }`. Failure: `{ "ok": false, "code": "<stable-code>", "error": "<Korean text for people>" }`.
Clients branch on `code` (stable English) and may show `error` (Korean, may change wording).

| HTTP | `code` | When |
|---|---|---|
| 401 | `token-missing` | no `Authorization: Bearer` header (or a token in the query string) |
| 401 | `token-invalid` | wrong or replaced token |
| 403 | `lan-off` | another device while `lanAccess` is off |
| 403 | `not-allowed` | the command exists but this target isn't allowed (e.g. a scene not on the assistant-allowed list) |
| 404 | `not-found` | unknown route, or a module that isn't loaded |
| 400 | `bad-request` | missing/invalid fields |
| 409 | `conflict` | the state doesn't allow it now (e.g. a mark while not recording) |
| 502 | `obs-unavailable` | OBS not connected or refused the request |
| 500 | `internal` | anything else (logged) |

Exception: a refusal by the request guard (foreign `Host`, cross-site `Origin`) is a plain-text 403 before `/api/v1` is reached.
