# Remote access modes — home network or Tailscale

**Status: plan (2026-11-23), building now on `main`, no version bump.** Owner's request 2026-11-23; spec in the vault
(`Projects/Allmind/Remote Access Modes.md`). From now on this file is the source of truth; the vault note only tracks state.

## Why
- **Range:** a phone, tablet or a mod's device on the owner's tailnet can open the dashboard from anywhere, without port forwarding.
- **Security:** Tailscale traffic is encrypted (the LAN is plain HTTP) and only devices approved in the owner's Tailscale account
  can connect. That gain is only real in "Tailscale only" mode, which refuses other home-network devices.

## What the code does today (0.47.1 + M5 on `main`)
- `config.server.host`: `0.0.0.0` (default) or `127.0.0.1` when 다른 기기에서 대시보드 열기 허용 (`lanAccess`, a checkbox in the
  main settings form, saved with a restart) is off. Bound in `listen()`.
- `guard()` → `hostAllowed()`: IP literals, `localhost`, `*.localhost`, this PC's name (`.local`), `config.server.allowedHosts`.
  So `http://100.x.y.z:8080` passes; a MagicDNS name does not.
- `isSelf()` (`src/access.js`): loopback or one of this PC's own interface addresses — that includes this PC's **own** Tailscale
  address, and that is fine (it is this PC). Tailnet peers are other devices: PIN, settings lock (`isLocal`, loopback only) and the
  deck key apply. `ALLMIND_SELF_LOOPBACK_ONLY=1` (already shipped, tests use it) makes even this PC's LAN address count as another
  device; it can only make Allmind stricter.
- **Hole:** Tailscale Serve/Funnel reverse-proxy from `127.0.0.1` on the stream PC itself, so Allmind would treat a phone (or, with
  Funnel, the whole internet) as the stream PC: no PIN, settings open, deck without key.

## Verified Tailscale facts (2026-11-23)
| Fact | Value | Source |
|---|---|---|
| Tailnet IPv4 | `100.64.0.0/10` (RFC 6598 shared space) | kb/1015 "100.x addresses"; `net/tsaddr/tsaddr.go` `CGNATRange()` |
| Tailnet IPv6 | `fd7a:115c:a1e0::/48` (older nodes `fd7a:115c:a1e0:ab12::/64`, inside it) | kb/1033 "IP and DNS addresses"; `tsaddr.go` `TailscaleULARange()` |
| Serve, tailnet users | `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`, `Tailscale-Headers-Info` (not for Funnel or tagged nodes) | kb/1312 "Serve"; `ipn/ipnlocal/serve.go` `addTailscaleIdentityHeaders` |
| Funnel | `Tailscale-Funnel-Request: ?1` | `serve.go` (not in the kb pages) |
| Serve and Funnel, always | `X-Forwarded-For` (client IP), `X-Forwarded-Host` (incoming Host), `X-Forwarded-Proto: https` on TLS | `serve.go` `addProxyForwardedHeaders` (not in the kb pages) |
| This PC's MagicDNS name | `tailscale status --json` → `Self.DNSName`, FQDN **with a trailing dot** (`pc.tailnet.ts.net.`); IPs in `Self.TailscaleIPs` | `ipn/ipnstate/ipnstate.go` `PeerStatus` ("It ends with a dot"); kb/1080 "CLI" (`--json`: "format subject to change") |
| Windows CLI path | not documented (kb/1080: run the `.exe` from Command Prompt). Try PATH, then `%ProgramFiles%\Tailscale\tailscale.exe` | kb/1080, kb/1022 |
Sources: https://tailscale.com/kb/1015/100.x-addresses, https://tailscale.com/kb/1033/ip-and-dns-addresses,
https://tailscale.com/kb/1312/serve, https://tailscale.com/kb/1223/funnel, https://tailscale.com/kb/1080/cli,
https://github.com/tailscale/tailscale (`net/tsaddr/tsaddr.go`, `ipn/ipnlocal/serve.go`, `ipn/ipnstate/ipnstate.go`, `main`).

## Design
### 1. Setting `server.remoteAccess`: `off` / `lan` / `tailscale`
- UI (다른 기기에서 열기 card, replaces the `lanAccess` checkbox): **끄기** / **같은 네트워크 + Tailscale** / **Tailscale만**.
- Migration, computed on read (nothing is written until the owner changes it): a valid `server.remoteAccess` wins; otherwise
  host `127.0.0.1`/`localhost`/`::1` → `off`, anything else → `lan`. So nothing changes for existing installs.
- Bind: `off` → `127.0.0.1` (as today), `lan`/`tailscale` → `0.0.0.0`. Saving writes both `remoteAccess` and `host`.
- Switching between `lan` and `tailscale` applies at once (no restart) and closes open connections the new mode refuses.
  Switching to or from `off` changes the bind, so it restarts Allmind like the settings save does.
- `lanAccess` (boolean) stays in every existing view (`/api/launcher`, `/api/launcher/access`, the API 토큰 card) = mode isn't `off`.
  The main settings form no longer sends it; an old client sending `lanAccess: false` still means `off`.

### 2. Address classifier and mode check (`src/netmode.js`, pure, unit-tested)
- `classify(addr)` → `loopback` | `tailnet` | `private` | `public` (`::ffff:` and `%zone` stripped). `private` = 10/8, 172.16/12,
  192.168/16, 169.254/16, IPv6 ULA `fc00::/7` and link-local `fe80::/10`; `tailnet` is checked first (its IPv6 range is inside the ULA).
- `allowed(mode, cls, self)`: `self` (the stream PC, `isSelf`) → always. `off` → nothing else. `lan` → `private` + `tailnet`
  (a **public** source is refused: small hardening against an accidental port forward). `tailscale` → `tailnet` only.
- Runs at the top of the request handler, **before** the guard and the PIN. Refusal: plain-text 403 (or JSON `lan-off` for
  `/api/v1`), one `[access]` log line per reason per minute. A refused device never reaches the PIN page.

### 3. Serve/Funnel guard (every mode)
A request **from loopback** carrying any of `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-Headers-Info`,
`Tailscale-Funnel-Request`, `X-Forwarded-For`, `X-Forwarded-Host` is refused (403, logged). Runs before the Host check (the
MagicDNS name below would otherwise let a Serve hostname through). Nothing Allmind serves on the stream PC sends these (OBS browser
sources, the settings window, the Stream Deck plugin, StreamMaid); a local reverse proxy in front of Allmind isn't supported.

### 4. This PC's MagicDNS name
`tailscale status --json` once at start (2 s timeout, after `listen()`, never awaited by startup) and again when the card asks
(at most once per minute). `Self.DNSName` without the trailing dot joins the Host allow-list, plus `Self.TailscaleIPs` for the card.
Never `*.ts.net`. CLI looked up on PATH, then `%ProgramFiles%\Tailscale\tailscale.exe`; missing or failing → no name, no error.
It only reads, so it also runs in the dev harness.

### 5. Card
Shows the addresses labeled **같은 네트워크** (LAN) and **Tailscale** (100.x, and the MagicDNS name when known). Warnings: `tailscale`
chosen but no Tailscale address found; PIN off in any mode but `off`. Notes: the Stream Deck on the main PC needs Tailscale too in
Tailscale-only mode and must point at the stream PC's 100.x address.

### 6. `/api/v1`
Other devices need the token **and** a mode that allows their network; a mode refusal answers 403 `lan-off` (existing code, contract
stays additive; one line added to `docs/contracts/auth.md`). StreamMaid on 127.0.0.1 is `self` → allowed in every mode.

## Tests (mock; real Tailscale is the owner's test)
- `node --test tools/dev/test-netmode.mjs`: classifier, mode table, migration, proxy-header detection.
- `node tools/dev/test-remote.mjs`: against the mock with `ALLMIND_SELF_LOOPBACK_ONLY=1` (the LAN address acts as a LAN device):
  accepted in `lan`, refused in `tailscale` (plain 403 / `lan-off` JSON on `/api/v1`); loopback requests with each proxy header
  refused in `lan` and `tailscale`; plain loopback still fine; switching modes closes a refused device's open connection.
  `off` is covered by the unit tests (live, it rebinds to 127.0.0.1, so the LAN address can't even connect).
- Unchanged: `node tools/dev/smoke.mjs`, `node tools/dev/v1-client.mjs` (run in every mode), `node tools/check-boundary.mjs` (75).
No test-only switch is added.

## Out of scope
Serve/HTTPS certificates, Funnel, Tailscale ACLs, bundling Tailscale, changing the firewall automatically.
