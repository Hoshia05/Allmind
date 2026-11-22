# Markers file + chat log (`<video>.markers.json`, format `vodscout-markers`)

> **DRAFT — awaiting gemini Gate 1 review.** Describes what Allmind **writes today** (0.47.1, `src/markers.js`), so it is a record
> of built behavior, not a plan. Moved here from SkyEye's `STREAM_DESK_MARKERS.md` (v1, ⭐ marks) and `docs/ALLMIND_CHAT_LOG.md`
> (v2, chat log); those two become pointers to this file (SkyEye repo, follow-up). Reader: SkyEye (`scout.read_chat_file`).
> Mock-tested only where noted.

## What it is
For every OBS recording (every **part** of one, see below) that has at least one ⭐ mark or one saved chat line, Allmind writes one
JSON file next to the video: `<video base name>.markers.json` (e.g. `2026-10-16 20-00-03.mp4` → `2026-10-16 20-00-03.markers.json`).
A recording with no marks and no chat gets no file. SkyEye treats marks as guaranteed highlight candidates and uses chat as context.

## Format (version 2)
```json
{
  "format": "vodscout-markers",
  "version": 2,
  "recording": {
    "file": "2026-10-20 20-00-03.mp4",
    "started_at": "2026-10-20T20:00:03.120+09:00",
    "duration": 14520.4,
    "obs_chapters": true
  },
  "markers": [
    { "t": 1234.5, "label": "", "created_at": "2026-10-20T20:20:37+09:00" }
  ],
  "chat": [
    { "t": 1230.6, "type": "chat",         "nick": "시청자1", "role": "viewer",   "text": "ㅋㅋㅋㅋㅋ" },
    { "t": 1290.2, "type": "donation",     "nick": "시청자2", "role": "viewer",   "text": "추락 장인", "amount": 1000 },
    { "t": 1295.0, "type": "subscription", "nick": "시청자3", "role": "viewer",   "text": "" },
    { "t": 1302.0, "type": "chat",         "nick": "호시아",  "role": "streamer", "text": "아니 이거 HOTAS 문제라니까" },
    { "t": 1310.4, "type": "chat",         "nick": "YT시청자", "role": "viewer",  "text": "hi", "platform": "youtube" },
    { "t": 1500.0, "type": "gap", "text": "chat disconnected 20:31–20:33" }
  ]
}
```
- `format` is always exactly `"vodscout-markers"` (readers look for it).
- `version`: `2` when the chat log is on (설정: 채팅 로그 저장, `markers.saveChat`, default on), `1` when it is off — then there is
  no `chat` key and only recordings with marks get a file (v1 = the original ⭐-only format).

### `recording`
- `file`: the video's file name at the time of recording (OBS's `outputPath`), or `null` if unknown (OBS was disconnected at the
  stop and no matching video was found). In the copy Allmind uploads to Google Drive, `file` is the **Drive name** of the video.
- `started_at`: local time with offset, milliseconds; when this part's recording started.
- `duration`: active length of **this part** in seconds, pauses excluded, 0.1 s steps. The owner renames videos before
  uploading, so SkyEye matches a markers file to its video by this length (±5 s).
- `obs_chapters`: `true` if OBS accepted `CreateRecordChapter` (OBS 30.2+, Recording Format = Hybrid MP4); the marks are then
  inside the video too.

### `markers[]`
- `t` (required): seconds into this part's video, from OBS's own `outputDuration` (pauses excluded), ms precision.
- `label`: optional note (≤ 200 characters), editable later in the dashboard. `created_at`: local time of the press.
- Several marks within a few seconds are all kept; SkyEye merges them.

### `chat[]` (version 2)
- `t` (required): seconds into this part's video when Allmind **received** the line, 0.1 s steps. No delay correction (SkyEye
  corrects stream delay itself). Measured on a monotonic clock, pauses excluded (lines during a pause get the pause's `t`),
  corrected against OBS's `outputDuration` once a minute.
- `type`: `chat` | `donation` | `subscription` | `gap`. Readers must ignore unknown types.
- `nick`: display name, ≤ 60 characters. **No user ids** are stored.
- `role`: `streamer` | `manager` | `viewer`.
- `text`: ≤ 500 characters; Chzzk emoticons as `{:code:}`.
- `amount`: donations, when known (치즈).
- `platform`: only on YouTube lines (`"youtube"`); Chzzk lines have no `platform` key (unchanged from before YouTube chat
  existed). YouTube donations carry `amountText` (e.g. `"₩5,000"`, ≤ 30 characters) instead of `amount`.
- `gap`: chat was not recorded for a while: `text` says when (`chat disconnected HH:MM–HH:MM`, `… (until the recording ended)`,
  or `chat not recorded (Allmind was closed)` after a restart of Allmind mid-recording). `t` = where the gap starts.
- Which lines: live lines only. Never the replay of recent messages on reconnect, never system notices, never 🧪 테스트 추첨 lines
  (those go to the dashboard list only).

### `allmind` (only while recording)
```json
"allmind": { "part": 2, "obs_offset": 3725400, "held_title": "2부 - 공포 게임" }
```
Present only in the in-progress file, so Allmind can recover the part clock after a restart; removed when the part ends.
Finished files never have it. Readers ignore it.

## Parts (✂ 파트 나누기, 0.47)
- A split cuts the recording mid-stream into parts (any number of times). **Each part is its own video with its own markers file**
  and its own clock: `t` and `duration` restart at 0 for every part, exactly as if it were a separate recording.
- The finished file doesn't say which part it was (no `allmind` block); the video's name and `started_at` tell them apart.
- If OBS refuses to split, the owner may stop and restart the recording instead; that also gives two parts, with a gap of a few
  seconds between them.
- **Mock only:** whether real OBS splits a Hybrid MP4 recording cleanly, and whether SkyEye handles a series of part files
  (each starting at 0) as expected — to be checked on a real recording.

## Where and when it's written
- While recording: `vodscout-markers-<started_at as yyyyMMdd-HHmmss>.json` in OBS's recording folder; saved within ~15 s of new
  chat and at once on a ⭐ press; written as temp file + rename (a crash never leaves a broken file). If the recording folder can't
  be written, a copy goes to Allmind's data folder.
- When the part ends (recording stops, or a split): renamed to `<video base name>.markers.json` next to that video. The dashboard
  shows a toast (`💬 채팅 N개 · ⭐ M개 저장됨 …`).
- Google Drive: after the stream Allmind uploads the video and its markers file to the owner's Drive folder (with `recording.file`
  set to the Drive name). SkyEye reads every `*.markers.json` in that folder and matches by name or by `duration`.
- Allmind restarted mid-recording: it finds the in-progress file (by `started_at`) and continues it, adding a `gap` item when
  time was lost. If Allmind is closed for good before the recording ends, the in-progress file stays as it was (with `allmind`).
- Checked on the mock 2026-11-22 (Windows harness): a finished file and an in-progress file have exactly the shape above.

## Recommended OBS setting
Settings → Output → Recording → **Recording Format: Hybrid MP4** (OBS 30.2+), so marks are also chapters inside the video
(`ffprobe -show_chapters <file>.mp4`). Check all audio tracks still appear after switching (SkyEye needs them separate).
