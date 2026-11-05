# OBS controls (0.44)

Owner's ask (2026-11-05, after comparing with Bitfocus Companion): start/stop the stream and recording from
the dashboard, and toggle a few sources / control audio — without cluttering the dashboard.

## Decisions
- **No new buttons in the top bar.** The existing LIVE/OFFLINE pill becomes a button → sheet "방송 · 녹화".
  Start = one press inside the sheet (opening the sheet is the confirmation); **stop = two presses** (4 s window).
  The pill shows `REC` / `녹화 멈춤`, and `송출 중` when OBS streams but Chzzk doesn't show the stream yet.
  The sheet shows the 점검 counts before starting.
- **OBS panel is opt-in**: empty until the owner pins scene items (👁) and audio inputs (mute, volume, level)
  with "＋ 고르기". Dock: tab with 사운드보드 (`tabWith:'sb'`); fixed layouts: folded; phone: the 할 일 tab
  ("할 일·OBS"). Scene switching stays with the existing scene buttons; mic with the mic button.

## Implementation
- `src/obspanel.js` `ObsPanel`: pins in `obs-pins.json` `{items:[{scene,source}], audio:[name]}` (≤40 each);
  item ids via `GetSceneItemId` (groups: scene = group name), state from events only
  (`SceneItemEnableStateChanged`, `InputMuteStateChanged`, `InputVolumeChanged`, Stream/RecordStateChanged,
  renames). Levels = peak of `InputVolumeMeters` (already subscribed) for pinned inputs, sent in the 100 ms
  `level` SSE as `obs`. `catalog()` lists scenes → items (+ group children) and inputs where `GetInputVolume`
  succeeds — only when the picker opens.
- Routes: `POST /api/obs/output {what:stream|record, action:start|stop|pause|resume}`, `/api/obs/item`,
  `/api/obs/mute`, `/api/obs/volume` (client throttles to ~8/s), `/api/obs/pins`, `GET /api/obs/catalog`.
- Mock: Webcam / 공지 텍스트 / Game Capture (video only — GetInputVolume fails), Desktop Audio, Discord;
  items with ids ≥ 10 in Main / Just Chatting; Get/SetSceneItemEnabled, GetSceneItemId, SetInputMute,
  InputVolumeChanged.

## Not verified on real OBS
StartStream/StopStream/Pause/Resume from the dashboard, group items' ids, and the volume range (slider −60…0 dB;
a value above 0 dB set in OBS is shown but the slider sits at 0).
