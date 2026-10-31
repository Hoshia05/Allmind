# One chat list: Chzzk + YouTube (0.37.0)

Owner (2026-10-31): drop 위플랩 (unused); the dashboard chat should show every connected chat, which
platform each line is from, and Chzzk subscription badges.

- **위플챗 removed**: `chatViewer`/`chatPage`/`feeds.chat`, the 위플챗 tab + ⇄, `sources.chat` in settings and 점검,
  `viewer.chatFps`, mock source + `MOCK_CHAT_PAGE`. The 도네 알림 mirror (후원 tab) stays.
- **Chzzk** (`chzzk.js _normalize`): `platform:'chzzk'`, `sub {months,tier,img}` from
  `profile.streamingProperty.subscription`, `badges` = viewerBadges + activityBadges (≤4), `verified`.
  Nickname colour codes (`streamingProperty.nicknameColor.colorCode`) are not mapped — palette unknown.
- **YouTube** (`ytchat.js`): official `liveChatMessages.list` with the existing YouTube login. Only while the
  watched broadcast (`youtube.b`) is live, **not private** and has `snippet.liveChatId` — a private archive has no
  chat, so no quota is spent. Poll ≥ `youtube.chatPollSec` (10 s), ×2 after 3 quiet polls, honours
  `pollingIntervalMillis`; quotaExceeded stops for the day; liveChatEnded/Disabled/NotFound = that chat id is dead.
  `streamList` (push, cheaper) is gRPC-only — not worth the dependency. Lines go through `chzzk.addExternal()`
  (shared list, 🧹, history for new dashboards; not Chzzk's viewer info/donations/`live-chat`, so no games,
  roulette or report) and into the markers chat log with `platform:'youtube'`.
- **Privacy setting** (`youtube.privacy` private|unlisted|public, settings → 유튜브 아카이브 → 공개 범위): needed
  because the guard forced everything private. Now it lowers anything MORE public than chosen (never raises a
  broadcast, so a private test stays private), except Allmind's own *waiting* broadcasts, which are set to exactly
  the chosen value.
- Mock: YouTube broadcasts carry `liveChatId`; `GET /g/youtube/v3/liveChat/messages` (private → liveChatDisabled,
  `MOCK_YT_QUOTA=1` → quotaExceeded), `GET /g/_yt/chat` = call count. Chzzk profiles carry subscription/viewer badges.
- Not verified on real YouTube: quota cost per call, whether `snippet.liveChatId` is on the broadcast we read,
  message shapes beyond the docs.
