# VTube Studio — chat interaction with the model

**Status: step 1 being built (0.33.0): connection + 던지기 (throwing).** Owner's decisions 2026-10-27:
VTS runs on the **main PC**; start with the base connection and throwing only; lay groundwork for
viewers changing model parts (hair, clothes … — set up as **expressions** in VTS) by chat/donation later.

## Connection (`src/vts.js`)

- VTS public API: WebSocket `ws://<main PC>:8001` (VTS → 설정 → "API 시작", port changeable).
  Envelope `{apiName:'VTubeStudioPublicAPI', apiVersion:'1.0', requestID, messageType:'XRequest', data}`,
  answers `XResponse` or `APIError` (`data.errorID`, `data.message`), events `XEvent`.
- Auth: `AuthenticationTokenRequest {pluginName:'Allmind', pluginDeveloper:'Hoshia', pluginIcon}` → popup in
  VTS (main PC) → token (stored in `DATA_DIR/vts-auth.json`, never logged) → `AuthenticationRequest` each
  connect. Denied = errorID 50. Then `PermissionRequest {requestedPermission:'LoadCustomImagesAsItems'}`
  (second popup) because thrown items are our own images (`customDataBase64`, JPG/PNG/GIF, 64–2048 px,
  < 5 MB; first load of each image asks once more unless whitelisted → `customDataSkipAskingUserIfWhitelisted`).
- Connects only while `config.vts.enabled`; reconnects with backoff (5 → 60 s). Nothing polled; the model
  position is read once per throw (`CurrentModelRequest`).
- Unknown: whether VTS accepts connections from another PC (it broadcasts its API state on the LAN via
  UDP 47779, which suggests yes). Main PC firewall may need to allow VTS. Verify on the real setup.

## 던지기 (`src/vtsthrow.js`)

- Triggers: chat commands (default `!던지기`, `!던져`), optional donations (N 치즈 per throw, max per
  donation, off by default), test buttons on the Xylem page. Per-viewer cooldown (20 s), max items in the
  air (5), queue drains one throw every 0.35 s. Thrower's name is **not** shown (owner: no 네임드).
- Items: images uploaded on the Xylem page (`DATA_DIR/vts-items/`), or the built-in set
  (`public/vts-items/`: cheese, heart, star) when none are uploaded.
- One throw: `ItemLoadRequest` just off a random side edge (x ±1.25, y −0.2…0.8), `unloadWhenPluginDisconnects`
  → `ItemMoveRequest` to the head (0.45 s, `easeIn`, spinning) → hit: injected `FaceAngleX/Y/Z` offsets
  (`InjectParameterDataRequest mode:'add'`, a damped wobble at 30 Hz for ~0.9 s, re-sent within VTS's
  1 s rule), optional hit hotkey, optional red flash (`ColorTintRequest` 255/150/150 for 0.15 s → white),
  optional knock-back (`MoveModelRequest`, absolute there-and-back) → item bounces off and falls
  (`ItemMoveRequest` 0.8 s `easeOut`) → `ItemUnloadRequest`.
- Aim: head = model position + offset. Offset set by **조준 맞추기**: Allmind drops a marker item, the owner
  drags it onto the head in VTS, the `ItemEvent` "DroppedUnpinned"/"DroppedPinned" gives its position →
  offset stored. Default offset (0, 0.25).

## Later: viewers change model parts (expressions)

Groundwork in step 1: `vts.expressions()` (ExpressionStateRequest) + `vts.setExpression(file, on, fade)`,
listed with on/off test buttons on the Xylem VTS panel. Planned shape:

- **Rules**: `{ trigger: chat '!머리 단발' | donation ≥ N 치즈 | roulette result id, expression file(s), duration
  (s, 0 = until changed), group }`. A **group** (e.g. "머리", "옷") holds mutually exclusive expressions:
  turning one on turns the others in the group off. A group default expression for "back to normal".
- Cooldowns per rule, a queue so two changes don't fight, the 끄기 switch, and a "reset all" at stream end.
- VTS recommends hotkeys over direct expression activation (the user can always undo a hotkey); we use
  direct activation but keep a reset button and deactivate our expressions when the plugin disconnects.

## Test

`tools/mock-vts.js` (started by `tools/dev/up.sh` when `MOCK_VTS=1`, default on): a fake VTS API on :8001
that approves auth/permission, keeps items/model state, answers the requests above and logs them, and
can fire `ItemEvent` drops (`curl -X POST :8002/drop -d {"x":0.1,"y":0.05}`; request counts at `:8002/stats`). Real VTS behaviour (coordinates, popups,
LAN access) is only verified on the owner's PC.
