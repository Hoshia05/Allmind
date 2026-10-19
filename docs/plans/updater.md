# In-app updater

Goal: no more stacking `Arkbird-x.y.z.exe` files in Downloads. The owner presses
**Install** in the settings window between streams and the app replaces itself.

## How it works

1. `src/update.js` asks the GitHub API for the latest release of `config.update.repo`
   (`GET /repos/<repo>/releases/latest`, public, no token; 60 req/h limit is irrelevant
   at one check per 6 h). It compares the tag (`vX.Y.Z`) with `VERSION` and picks the
   asset named `Arkbird-X.Y.Z.exe` (size + optional `sha256:` digest from the API).
2. State is exposed at `GET /api/update` (everyone on the LAN may read it, so the
   dashboard can show a banner). `POST /api/update/check` and `/install` are local-only.
3. **Install**: refuse if OBS is streaming or recording (one-off `GetStreamStatus` /
   `GetRecordStatus`, no polling) → download to `%LOCALAPPDATA%\Arkbird\updates\` as
   `.part` → verify size, `MZ` header and sha256 (when GitHub provides it) → rename →
   spawn it detached with `--restart` (same trick as `restart()`; the new copy waits up to
   5 s for the port) → exit. The launcher inside that exe unpacks the new app and its
   `clean_old` removes the old unpacked copy.
4. Housekeeping at start: delete other `Arkbird-*.exe` next to the running app and
   downloaded installers with a version <= the running one.

## Rules

- Never installs by itself. Never while live/recording. Checks only: 30 s after start,
  then every 6 h, and on the button.
- A failed check is silent (log line, small "확인 실패" in the settings card).
- Not an exe (running from source) → check works, install only as a dry run
  (`ARKBIRD_UPDATE_DRY=1` also forces a dry run: downloads + verifies, doesn't start it).
- `config.update = { check, repo, apiBase }`; `check:false` turns it off.

## Not covered / to verify on the real stream PC

- The actual Windows spawn-and-replace (mock only tests download/verify/guard).
- Windows SmartScreen on a Node-downloaded exe (no Mark-of-the-Web, so it should be quiet).

## Later

GitHub Actions workflow that builds on `main` version bumps and publishes the release
(needs workflow-file push permission; see conversation).
