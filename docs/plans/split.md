# 파트 나누기 (split record) — plan, 2026-11-22

Owner's ask: one stream often covers several topics/games; the recording and the YouTube archive should be cut at a chosen moment
so each topic is its own archive. The cut ends the current recording + YouTube broadcast (they start uploading afterwards) and
**immediately** starts the next ones. **It can happen several times in one stream.**

General platform feature (no game/category names in code). Lives in core: recording + YouTube archive + Drive already are.

## What a split does (every time, from scratch — no state is kept "ready" between splits)
1. **Prepare YouTube part N+1 first** (the slow part, ~1–3 s of API calls, while part N keeps running): create a broadcast with the
   new title, privacy as chosen, auto-stop on, **bound to the same stream key**. If this fails the OBS split still happens (the
   recording is what can't be redone) and the owner is told the YouTube archive stayed in one piece.
2. **OBS cuts the file**: `SplitRecordFile` → OBS sends `RecordFileChanged {newOutputPath}` (obs-websocket ≥ 5.5; the owner has 5.6.2,
   advanced output, Hybrid MP4). Same recording output, no gap.
3. **Right after the event**: YouTube part N → `complete`, part N+1 → `live` (explicit transitions; autoStart is not trusted because
   the key is already receiving video). Reset `liveSince`, make `youtube.b` the new broadcast (ytchat follows its `liveChatId`).
4. `markers.js` closes part N (its own markers file next to its video, Drive queue item named from the title held for N) and
   starts part N+1 with its own clock at 0.
No spare broadcast is ever waiting while a stream runs, so YouTube is never confused about which one to start, and the existing
"never delete waiting broadcasts while streaming" rule is untouched. After the stream ends `_afterStream` ends the last part and
prepares the next stream's broadcast as before.

## Details that decide whether it works
- **Mark/chat times**: OBS's `outputDuration` may keep counting across a split or restart from 0 (unverified). At each split read
  `GetRecordStatus` and store it as `obsOffset`; the drift check / reconnect compare `outputDuration - obsOffset`. If a later reading
  is smaller than the offset, OBS reset it → offset 0.
- **Names**: before cutting, pin part N's title (`holdTitle`); the Drive name for N is captured at that moment (the `finished` event
  fires inside the split, before `prep` changes). Then part N+1 gets `prep.title/ytTitle/fileName` = what the owner typed and its own
  held title. Drive already appends " (2)" if two parts end up with the same name.
- **Drive**: parts are queued at the split but, as always, **uploaded only after the stream ends** (the uplink is protected on
  purpose). Not changed silently; an opt-in "upload finished parts during the stream" can come later.
- **OBS may refuse** (needs "automatic file splitting" in the recording settings; whether Hybrid MP4 allows it is unverified): treat
  OBS's error as the answer and show the setting to check. Fallback `mode: 'restart'` = StopRecord → wait for STOPPED → StartRecord:
  leaves a gap of a few seconds, so it is a **separate explicit confirmation**, never automatic.
- **Only streaming / only recording**: splits whatever is running (recording only, YouTube only, both). Neither → error.
- **Two presses** to confirm (like stopping a stream); a split can't be undone.

## UI
- 방송 준비 sheet: checkbox **적용하면서 ✂ 여기서 나누기** (new title/category/tags go to Chzzk as usual; the new title becomes part N+1's
  YouTube title and recording name).
- LIVE-pill sheet: card **✂ 파트 나누기** — next part's title (prefilled with the current title) + two-press button; shows "파트 N".
- Error from OBS → message + a separate "녹화를 껐다 켜서 나누기 (몇 초 비어요)" button with a confirm.

## Tests (mock) — what they can and cannot prove
Mock gets `SplitRecordFile`, `RecordFileChanged`, `MOCK_SPLIT_FAIL=1` (OBS refuses), `MOCK_SPLIT_RESET=1` (duration restarts at 0), and
YouTube `transition` to `live`/`complete` + a second broadcast on one key. Checks: part N's markers file has the right times, part N+1
starts at 0, Drive gets one item per part with the right names, N complete / N+1 live and private, repeated 3× in one stream, split
while only recording / only streaming, refusal path, restart path. **The mock only proves our own model of YouTube and OBS.** Real
first checks on the owner's PCs: does OBS accept the split with Hybrid MP4, how long is the YouTube gap, does the live chat follow.

## Not in scope
Auto-split by category change, splitting an existing file afterwards, uploading parts during the stream.
