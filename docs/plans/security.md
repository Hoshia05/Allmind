# Security — where Allmind stands (audit 2026-11-02, 0.39.0) and what to do, in order

Allmind is a local web server (port 8080) that can control OBS, the stream, Chzzk moderation (as the streamer, via the
리모컨 dock), YouTube/Drive (Google tokens), VTube Studio, and can start programs (OBS path) and update/delete itself.
So the question is: **who can make it do those things?**

## Findings

1. **Any web page can call the API (CSRF) — confirmed on the mock.** `readBody()` parses JSON whatever the
   Content-Type, and nothing checks `Origin`. A page on any site, open in any browser on the stream PC or on the same
   network, can send `fetch('http://<allmind>/api/…', {method:'POST', mode:'no-cors', body:'{…}'})` (a "simple"
   request — no preflight) and it runs. In a browser **on the stream PC** that includes the local-only settings routes
   (`isLocal` only checks the socket address): save settings (incl. `obs.path`, which `startObs()` later runs →
   program execution), sign out, `remove-all`, import settings. Reading answers back is blocked by CORS, but a write
   needs no answer. Test: `csrf.py` in the 2026-11-02 session (foreign origin → `/api/todo/add` → item appeared).
2. **DNS rebinding**: the `Host` header isn't checked, so a malicious domain that re-points itself to 127.0.0.1 /
   the LAN address becomes "same origin" and can also *read* answers (status, chat, settings view, Google client id).
3. **No login on the network.** With `lanAccess` on (default), anyone on the same Wi-Fi/LAN (housemates, guests, a
   studio network) can open the dashboard and do everything a dashboard can (OBS scenes, stream stop via OBS requests,
   chat as the streamer, 활동 제한, roulette, …). Settings stay stream-PC-only.
4. Secrets at rest: `config.json` holds the OBS password and the Google/CHZZK client secrets in plain text;
   `google-auth.json`/`chzzk-auth.json` hold refresh tokens. Normal for a desktop app (same as OBS's own files), but
   anyone/anything with access to `%APPDATA%\Allmind` gets them. `.allmind` exports are encrypted (good).
5. Supply chain: the exe updater and the Xylem pack both trust **GitHub `Hoshia05/Allmind`** (hash/digest checks
   protect against corruption, not against someone who controls the account). Xylem panels run on the dashboard's
   origin, so a bad pack could call every API. → the GitHub account's 2FA is a real part of Allmind's security.
6. Lower: `/deck/*` GET actions (skip track, mark…) can be triggered by an `<img>` on any page unless `deck.token` is set;
   OBS's DevTools port 9222 is bound to localhost by Chromium (fine); chat/overlay text is escaped in the dashboard.

## Plan (each step small, testable on the mock)

1. **Same-origin guard (fixes 1 + 2, invisible to the owner):** for every non-GET `/api/*`: require
   `Content-Type: application/json` (cross-site pages then need a CORS preflight, which we never grant), and if an
   `Origin` header is present it must equal the request's own host. For every request: `Host` must be an IP literal,
   `localhost`, or the PC's own name (blocks rebinding). Exempt: overlays/OBS browser sources (same origin anyway),
   the Stream Deck plugin (Node, no Origin), OAuth callbacks (GET). Check every client `fetch` sends the header
   (e.g. `/api/launcher/taskbar` posts with no body today).
2. **`obs.path` only via the file picker / must end in `obs64.exe`** (defense in depth for the program-start path).
3. **Optional PIN for other devices** (setting, off by default at first): devices other than the stream PC enter a
   PIN once; Allmind gives them a long random token (HttpOnly cookie, remembered per device, revocable "모든 기기 로그아웃").
   OBS browser sources on the stream PC never need it.
4. `deck.token` on by default for new installs (the plugin/settings card already support it).
5. Owner-side checklist (no code): GitHub 2FA + recovery codes; Google account 2FA; Naver 2-step; keep Windows
   firewall rule "private networks only"; turn `lanAccess` off on borrowed/studio PCs (already a setting).
