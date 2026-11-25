# Allmind on Chzzk's official Open API: parity audit (Phase 1)

**Status: Phase 1 done 2026-11-25 (claude-code); Stan answered the STOP questions the same day (keep 미션 후원 as an off-by-default opt-in reader switch, keep the viewer/peak/19+ numbers as an off-by-default opt-in poll, add the scopes 채널 구독자 조회 and 유저 정보 조회). Phase 2 (the build) is done and mock-tested; the real check with Stan is pending.** The verdict below was STOP before those answers.

Context: Stan decided (2026-11-25) that Allmind goes fully onto the official CHZZK Open API where possible. This document checks how much of today's behaviour survives. Everything below was traced from the code at `dde7bf6` (0.50.1) and checked against the official docs, read on **2026-11-25**: https://chzzk.gitbook.io/chzzk — Authorization, Session, Chat, Restriction, Live, Channel, Category, User, Tips and Updates (last entry 2026.03) were all readable; Drops was not needed. Anything the docs do not say is marked **(docs silent)**.

## Summary for Stan (한국어 + English)

- **공식 API로 되는 것 / Covered:** 채팅(글, 닉네임, 역할, 이모티콘, ✔), 후원(CHAT, **VIDEO=영도**), 구독 이벤트, Xylem·SkyEye·StreamMaid가 쓰는 채팅 정보, 임시 제한, 활동 제한(+해제), 메시지 숨기기, 공지.
- **막히는 것 / STOP items for you:**
  1. **미션 후원(MISSION):** 공식 후원 이벤트는 `CHAT`, `VIDEO` 두 종류뿐이에요. Allmind는 미션 후원을 라벨과 룰렛 종류(미션)에 쓰고 있어요. 미션 후원을 받으세요? / The official donation event has only CHAT and VIDEO; Allmind labels and filters MISSION.
  2. **시청자 수 · 최고 시청자 · 방송 시간(openDate) · 19세 표시 · "방송 중" 여부:** 공식 API에 **내 채널의 라이브 상태를 묻는 호출이 없어요** (`GET /open/v1/lives`는 전체 방송 목록이고 시청자 순이라 내 방송을 찾으려면 수십~수백 페이지를 넘겨야 해요). / No official call for your own channel's on-air state, viewer count or 19+ flag.
- **조금 달라지는 것 / Degraded:** 구독 뱃지·개월(구독자 목록 권한이 따로 필요), 메시지 삭제 → 숨기기, 상단 고정은 뷰어의 글 그대로가 아니라 새 글(100자)로 등록.
- **사라지는 것 / Lost:** 채팅 기록 50개(연결 때), 다른 사람이 숨긴 글 회색 표시, 팔로우 날짜, 채팅 횟수·제한 횟수, 채팅 운영자 임명(→ "치지직 스튜디오에서 열기" 링크).
- 질문은 섹션 4 끝에 있어요.

## 1. Inventory: what Allmind uses today from the unofficial endpoints

Unofficial hosts: `api.chzzk.naver.com` (live-detail poll, `_get`), `comm-api.game.naver.com` (chat access token, profile card), `wss://kr-ssN.chat.naver.com/chat` (chat socket, cmd protocol), and `chzzk.naver.com/studio` web endpoints called **through the 리모컨 dock** (`remote.request`, `dockGet`) as the logged-in streamer. Already official today: 방송 준비 (`lives/setting` GET/PATCH, category search) and `sendChat` (`src/chzzkopen.js`), and the blind call in `viewercard.js` (official first).

### 1a. Chat message (`Chzzk._normalize`, `src/chzzk.js`) — every field of the internal shape
| Field | Source today | Where it is shown / used |
|---|---|---|
| `time` | `msgTime` | de-dup key, blind/notice body, markers chat `t`, v1 `at` |
| `key` | `time:uid:text[0..20]` | de-dup, v1 `id` |
| `id` | local counter | dashboard rows, viewer-card actions |
| `uid` | `uid`/`userId` (= channel id, 32 hex) | dashboard viewer card, Xylem (추첨 entrants, dogfight and VTS-throw commands), v1 `uid`, `users` map |
| `nick` | `profile.nickname` | dashboard (hash-coloured locally), Xylem, v1, markers log, StreamMaid |
| `role` | `profile.userRoleCode` → `streamer` / `manager` / `''` | dashboard role pill, Xylem (`role`), v1 `role`, markers log |
| `verified` | `profile.verifiedMark` | dashboard ✔, v1 `verified` |
| `sub` `{months, tier, img}` | `profile.streamingProperty.subscription` | dashboard sub badge/pill, **Xylem 추첨 `subsOnly`** (`draw.js` reads `m.sub`), v1 `sub {months,tier}`, viewer card |
| `badges` (≤4 image urls) | 후원 랭킹 badge, `viewerBadges`, `activityBadges` | dashboard badge strip, viewer card |
| `text` | `msg` | everything (500-char cap in v1 and markers); emoticons stay `{:code:}` |
| `emojis` | `extras.emojis` (map code → url) | dashboard emoticon rendering, user `recent`, viewer-card notice body |
| `kind` | `msgTypeCode`: 10 donation, 11/12 subscription, 30/121 system, else chat | splits chat / 후원 list / system lines |
| `amount` | `extras.payAmount` | 후원 list, report, v1 donation `amount`, Xylem roulette |
| `donationType` | `extras.donationType` (`CHAT` / `VIDEO` / `MISSION`) | 후원 list label (후원/영도/미션), Xylem roulette kinds filter (checkboxes CHAT/VIDEO/MISSION), v1 `donationType` |
| `months` | `extras.month` | 구독 line in the 후원 list, v1 `months` |
| `hidden` | server BLIND event (94008) | dashboard greys the line out |
Not used by Allmind (so not a loss): nickname colour from Chzzk, profile image in chat lines (the card fetches it separately), message ids.
Also: **RECENT** (the last 50 lines requested on connect) fills the dashboard list on (re)connect; special/system notices (types 30/121, cmd 93006) become `system` lines or are ignored. 후원/구독 are kept per broadcast (`openDate` change resets them) and saved in `donations.json`.

### 1b. Live status (`Chzzk._poll`, `live-detail` every `pollSeconds`)
`status` (OPEN = on air), `liveTitle`, `concurrentUserCount` (→ viewers, peak, 15 s history graph), `accumulateCount` (total), `openDate` (uptime clock, new-broadcast reset of the 후원 list and chat reconnect), `liveCategoryValue`, `channel.channelName`, `adult` (19+), `chatChannelId` (needed to connect the chat socket; empty for anonymous requests on 19+ broadcasts, then asked again through the dock).
Used by: dashboard header (on-air, viewers, graph, uptime `tickUptime`, 19 pill), 점검 (`preflight.js`: on-air line, 19+ warning), `report.js` (peak viewers, titles, category, "chat dropped while live"), `streamTitle()` (file/title helpers), 방송 준비 defaults, launcher page line, the chat connect gating.

### 1c. Viewer card (`src/viewercard.js`)
Profile card (`nickname`, `profileImageUrl`, `userRoleCode`, `verifiedMark`, subscription, badges, `following.followDate`), counts (`chatMessageCount`, `temporaryRestrictCount`, `restrictCount`, flags `temporaryRestrict`, `restrict`) via the dock, and the 관리 actions: 상단 고정 (notice from the viewer's message), 메시지 삭제 (official blind first, then dock), 채팅 운영자 임명/해제, 임시 제한, 활동 제한, 활동 제한 해제. Stan decided earlier the 관리 actions stay in the code; now they move.

### 1d. Other Chzzk touch points
19+ chat via the dock (`dockGet`), 리모컨 buttons 넘기기 / 알림 정지·재시작 (`remote.js`, clicks in the OBS dock), 영도 skip-ad (`donation.js`, browser source in OBS; not a Chzzk API), `chat/send` (already official).

### 1e. Consumers of the chat/후원 shape (must not change)
`/api/v1/events` `chat`/`donation` (`publicChat` in `src/api.js`, contract `docs/contracts/events.md`: `platform, id, uid, nick, role, text, verified, sub, months` / `amount, donationType`), the markers chat log (`markers.addChat`: `t, type, nick, role, text, amount`), Xylem (`chat.on('live-chat')`, `chat.chat`, `chat.users`), dashboard SSE (`chat`, `chat-update`, `donations`).

## 2. Parity table

Official facts (docs, 2026-11-25): Session API = Socket.IO connection (client 1.0.0 to 2.0.3 per the docs), URL from `GET /open/v1/sessions/auth` (user token), URL valid only a limited time; events `CHAT`, `DONATION`, `SUBSCRIPTION` + `SYSTEM` (`connected`, `subscribed`, `unsubscribed`, `revoked`); subscribe with `POST /open/v1/sessions/events/subscribe/{chat|donation|subscription}` + `sessionKey`; scopes `채팅 메시지 조회`, `후원 조회`, `구독 조회`.
- `CHAT`: `channelId, senderChannelId, chatChannelId, profile{nickname, badges[], verifiedMark}, userRoleCode (streamer | common_user | streaming_channel_manager | streaming_chat_manager), content, emojis{key:url}, messageTime(ms)`.
- `DONATION`: `donationType (CHAT | VIDEO), channelId, donatorChannelId, donatorNickname, payAmount (String, 원), donationText, emojis` — **no time field**.
- `SUBSCRIPTION`: `channelId, subscriberChannelId, subscriberNickname, tierNo, tierName, month` — **no time, no message text**.

| # | Feature / field | Used by | Official equivalent (endpoint + scope) | Status |
|---|---|---|---|---|
| 1 | chat text | dashboard, Xylem, v1, markers, StreamMaid | `CHAT.content` (`채팅 메시지 조회`). Whether emoticons appear as `{:code:}` inside `content` is **(docs silent)**; `emojis` map has the urls | SAME (emoticon token format to verify live) |
| 2 | nickname | all | `profile.nickname` | SAME |
| 3 | uid | Xylem, card, v1 | `senderChannelId` (Allmind already treats `uid` as a channel id: `channelUrl`) | SAME |
| 4 | role | dashboard, Xylem, v1, markers | `userRoleCode`: streamer → streamer; `streaming_channel_manager`, `streaming_chat_manager` → manager; `common_user` → viewer | SAME |
| 5 | emoticons | dashboard | `CHAT.emojis` | SAME |
| 6 | verified ✔ | dashboard, v1 | `profile.verifiedMark` | SAME |
| 7 | subscription badge/months/tier | dashboard, **Xylem 추첨 subsOnly**, v1 `sub` | not in `CHAT`. `GET /open/v1/channels/subscribers` (`채널 구독자 조회`: channelId, month, tierNo; page ≤ 50, sort) + `SUBSCRIPTION` events can rebuild "is subscriber / months / tier"; badge image is not available | **DEGRADED** (extra scope; list is polled, not real time; no badge image) |
| 8 | other badges (후원 랭킹, viewer, activity) | dashboard strip, card | `profile.badges` is an `Object[]` with **undocumented fields** | DEGRADED / unknown (use `imageUrl` if the objects have one; else none). Cosmetic |
| 9 | message time | key, markers, blind body | `messageTime` | SAME |
| 10 | recent history (50) on connect | dashboard | none | **LOST** (cosmetic: list starts empty after a reconnect; SkyEye/v1 only ever used live lines) |
| 11 | blind events (others' hides greyed) | dashboard | none | LOST for hides done elsewhere; hides done through Allmind are still marked locally. Cosmetic |
| 12 | system/special lines (type 30/121) | dashboard | none | LOST. Cosmetic |
| 13 | 후원 CHAT: amount, nick, uid, text, emojis | 후원 list, report, v1, roulette | `DONATION` (`후원 조회`): `payAmount` (string → number), `donatorNickname`, `donatorChannelId`, `donationText`, `emojis`. Anonymous donors: representation **(docs silent)**, handled as nick `익명`, empty uid | SAME, except **time = receive time** (no time field) |
| 14 | 후원 VIDEO (영도) event | 후원 list ("영도"), roulette | `donationType: VIDEO`, same fields. Allmind uses no video details (the 영도 plays in the OBS browser source; `donation.js` only clicks skip) | SAME |
| 15 | **후원 MISSION (미션 후원)** | 후원 list label "미션", **Xylem roulette kind checkbox MISSION** | docs list only `CHAT | VIDEO` | **LOST — STOP item** |
| 16 | 구독 event: months, nick, uid | 후원 list "구독 · N개월", v1 `subscription` + `months` | `SUBSCRIPTION` (`구독 조회`): `month`, `tierNo`, `tierName`, nick/id. No text | SAME (text generated, e.g. "티어1 · 3개월 구독") |
| 17 | on-air flag / "방송 중" | header, uptime, 점검, report, new-broadcast reset | **none for the own channel.** `GET /open/v1/lives` is the list of **all** live broadcasts (Client auth, sorted by viewers, ≤ 20 per page, `page.next`) | **LOST** (OBS's stream state can stand in) |
| 18 | title / category / tags | header, `streamTitle()`, 방송 준비 | `GET /open/v1/lives/setting` (`방송 설정 조회`) = the configured values, not "what is on air" | DEGRADED |
| 19 | viewers, peak, 15 s graph, total | header, graph, report peak, 점검 | none for own channel (only by paging `/lives`) | **LOST** |
| 20 | openDate / uptime | uptime clock, 후원 reset per broadcast, chat reconnect | none | **LOST** (OBS stream start can stand in) |
| 21 | 19+ flag | 점검 warning, dashboard pill | `adult` exists only in the all-lives list | **LOST** |
| 22 | channel name | header, 점검 | `GET /open/v1/channels?channelIds=` (Client auth) or `GET /open/v1/users/me` (`유저 정보 조회`) | SAME |
| 23 | 19+ chat access | chat connect | the Session API is token based and does not need `chatChannelId` to subscribe; 19+ behaviour is **(docs silent)** | UNKNOWN, verify on a real 19+ stream |
| 24 | viewer profile (nick, picture, ✔, follower count) | card | `GET /open/v1/channels` (Client auth): `channelName, channelImageUrl, followerCount, verifiedMark` | SAME |
| 25 | follow date ("… 부터 팔로우") | card | `GET /open/v1/channels/followers` lists all followers (page ≤ 50, no lookup by id) | **LOST** |
| 26 | message / 임시 제한 / 활동 제한 counts | card | none; `GET /open/v1/restrict-channels` (`활동제한 조회`, ≤ 30 per page) tells whether someone is 활동 제한 (restrictedChannelId, dates) | LOST (counts), DEGRADED ("is restricted" via the list) |
| 27 | 임시 제한 | card | `POST /open/v1/temporary-restrict-channels` `{targetChannelId, chatChannelId}`, release `DELETE` (`활동제한 쓰기`); 400 / 403 documented | SAME |
| 28 | 활동 제한 + 해제 | card | `POST` / `DELETE /open/v1/restrict-channels` `{targetChannelId}` (`활동제한 쓰기`) | SAME |
| 29 | 메시지 삭제 | card | `POST /open/v1/chats/blind-message` `{chatChannelId, messageTime, senderChannelId}` (`채팅 메시지 쓰기`); 400 "스트리머가 아닙니다", 403, 404 | **DEGRADED** (hide, not delete; Allmind already calls this first) |
| 30 | 상단 고정 of the viewer's message | card | `POST /open/v1/chats/notice` (`채팅 공지 쓰기`): `message` (new text, ≤ 100 chars) **or** `messageId` of a message sent through the API. Chat events carry **no message id** | **DEGRADED**: pins the text as a new notice (≤ 100 chars), not the viewer's own message |
| 31 | 채팅 운영자 임명 / 해제 | card | none | **LOST** → button "치지직 스튜디오에서 열기" |
| 32 | 리모컨 넘기기, 알림 정지/재시작 | dashboard | none | unchanged (stays as is) |
| 33 | 영도 skip-ad | `donation.js` | not a Chzzk API | unchanged |
| 34 | send chat, 방송 준비 | `chzzkopen.js` | official already (`채팅 메시지 쓰기`, `방송 설정 조회/변경`) | SAME |

### Limits (docs, 2026-11-25)
- Session: **3 connections per user** (a user session only receives that user's own events), **10 per client**; **30 event subscriptions per session** (we need 3); the socket URL is valid for a limited time only (length **(docs silent)**) so connect right after creating it.
- Tokens: access token 1 day, refresh token 30 days and **single use** (Allmind's `chzzkopen.js` already stores the new one each time). Whether a running session survives its access token's expiry is **(docs silent)**: plan to create the next session (the cap of 3 allows one extra) before the token expires and drop the old one, never two chat paths at once.
- Rate limits: **not published**, only `429 TOO_MANY_REQUESTS` ("Quota 제한 초과"). Apps with no scope use for 90 days are deleted (`참고사항`). App ids/names may not contain chzzk/치지직/naver.
- Auth: user-token calls need `Authorization: Bearer <token>`; list/channel/category calls need `Client-Id` + `Client-Secret` headers. Responses are wrapped `{code, message, content}`.
- Session protocol: **Socket.IO client 1.0.0 to 2.0.3** (Engine.IO v3). No official history call, so no chat replay.

## 3. Options for each LOST or DEGRADED item

(a) drop; (b) link/button into Chzzk; (c) keep the unofficial code for just that item as an opt-in setting, **off by default**.

| Item | Recommendation | Why |
|---|---|---|
| **MISSION donations (#15)** | (a) drop if Stan doesn't receive 미션 후원; otherwise (c) **a whole-reader switch** "비공식 연결 (미션 후원 포함)", never both paths at once | the official event cannot carry it; the unofficial reader is all-or-nothing |
| **On-air / uptime / 후원 reset per broadcast (#17, #20)** | substitute **OBS stream state + OBS stream start time** (Allmind already has both); title/category from `lives/setting` | no official own-channel live call; the 후원 list reset per broadcast keeps working |
| **Viewers, peak, graph, total (#19)** | (a) drop (header shows "치지직에서 보기" link; report loses peak viewers), **or** (c) opt-in unofficial live-detail poll, off by default | paging `/lives` (all live broadcasts, 20 per page, sorted by viewers) would take dozens to hundreds of calls per poll against an unpublished quota |
| **19+ flag (#21)** | (a) drop (점검 loses the warning); the 방송 준비 sheet already shows the setting Stan chose | no official source |
| 19+ chat (#23) | keep the Session path; **verify live**; if it fails on 19+ the fallback is the labelled unofficial reader | docs silent |
| Subscriber badge/months (#7) | **DEGRADED with `채널 구독자 조회`**: poll the subscriber list (on connect, every few minutes, and when a `SUBSCRIPTION` event arrives); chat lines get `sub {months, tier}`; no image (dashboard shows the number pill) | keeps Xylem 추첨 subsOnly working and v1 `sub` |
| Other badges (#8) | use `badges[].imageUrl` if the objects have it, else none | undocumented, cosmetic |
| History on connect (#10), others' hides (#11), system lines (#12) | (a) drop | cosmetic; v1/markers/SkyEye never used them |
| Follow date (#25) | (a) drop (card shows nothing) | no lookup |
| Counts (#26) | (a) drop counts; show "활동 제한 중" from `restrict-channels` list when it is on file | |
| 메시지 삭제 → 숨기기 (#29) | relabel **숨기기** | official behaviour |
| 상단 고정 (#30) | keep, relabelled "공지로 올리기 (100자까지, 새 글로 등록)"; confirm before posting | cannot pin the original message |
| 채팅 운영자 (#31) | (b) "치지직 스튜디오에서 열기" link (Allmind already has the Studio url) | no endpoint |

## 4. Verdict: **STOP**

The GO rule (nothing LOST that the live stream depends on): chat text/nickname/roles/emoticons, 후원 incl. 영도, 구독, the Xylem chat inputs, the SkyEye chat log and StreamMaid's `/api/v1/events` shape are all covered (7 needs the extra subscriber scope, see above). **Two things force a STOP** because Stan decides:

1. **Mission donations (미션 후원)** are not in the official event (`CHAT | VIDEO` only) and Allmind uses them (the "미션" label and the Xylem roulette's MISSION kind). By the rule this is a STOP item.
2. **Live status of the own channel has no official source** (on-air, viewers, peak, uptime, 19+ flag). Not on the GO list, but visible to Stan every stream (header viewer count and graph, report peak, 점검 19+ warning). Recommended: OBS-based on-air/uptime, drop viewers/peak/19+ (or an off-by-default opt-in poll).

**Cosmetic losses for Stan's list (do not block GO):** chat history on connect, grey-out of others' hides, system lines, other badges, nickname colour (not used anyway), follow date, activity counts, 채팅 운영자 button (becomes a Studio link), 메시지 삭제 becomes 숨기기, 상단 고정 pins a new 100-char text, subscriber badge image. **Unchanged:** 리모컨 buttons, 영도 skip-ad.

### Questions for Stan (Phase 2 waits)
1. **미션 후원:** do you get any? If **no**: drop MISSION (label, roulette kind) and go official-only. If **yes**: do you want a setting "비공식 연결 (미션 후원 포함)", off by default, that you would switch on instead of the official path (never both)?
2. **시청자 수 / 최고 시청자 / 19세 표시:** drop them (recommended; on-air and uptime come from OBS), or keep an **off-by-default** opt-in poll of the unofficial live-detail endpoint just for these numbers?
3. **OK to add the scope `채널 구독자 조회`** (and `유저 정보 조회`) to your CHZZK Developers app, so subscriber badges and the 추첨 구독자 전용 filter keep working? (Without it they become "unknown".)
4. Anything in the cosmetic list above you do want to keep?

## 5. Phase 2 design notes (not started)

- One connection manager (`src/chzzksession.js`): create session (`GET /open/v1/sessions/auth`), connect, wait for `SYSTEM connected` → `sessionKey`, subscribe chat/donation/subscription, map events to the internal message shape, backoff reconnect, token refresh before expiry with a second session during roll-over (cap 3), never two paths at once, `revoked` → ask for a new login.
- **Dependency:** the docs name the Socket.IO v1-2.0.3 client. The repo's only dependency is `ws` (it keeps the exe small). Plan: a ~100-line Engine.IO v3 / Socket.IO v2 client on top of `ws` (packets from the public protocol spec: `0{open}`, ping `2` / pong `3`, `40` connect, `42["EVENT",{...}]`), tested against a mock written to the same protocol, **not verified against Naver's server until Stan's real check**. Alternative if that fails live: add `socket.io-client@2.x` as a dependency (old, bigger).
- Unofficial code stays only as the labelled no-login fallback (and whatever Stan opts into above); the dock paths (`dockGet`, dock-based 관리 calls) go away.

## 6. Phase 2 as built (shipped inside 0.51.0, announced in 0.52.0)
- `src/socketio.js` (minimal Socket.IO v2 client on `ws`, no new dependency), `src/chzzkofficial.js` (Session manager, event mappers, subscriber index), `src/chzzk.js` (`mode`: official | unofficial-optin | unofficial-fallback; official live status from OBS + 방송 설정), `src/viewercard.js` (official profile and 관리 actions, 숨기기, 공지, Studio link for 채팅 운영자), `src/chzzkopen.js` (errors carry `status`), settings `chzzk.unofficialReader` / `chzzk.liveStatsPoll` (both default false), 점검 line and 설정 창 rows, `readerPreflight`.
- Stan's answers: **미션 후원** = opt-in switch "비공식 연결 (미션 후원 포함)" that replaces the official reader while on (never both); **시청자 수 / 최고 시청자 / 19+** = opt-in unofficial live-detail poll for those numbers only; **scopes** 채널 구독자 조회 + 유저 정보 조회 added to the list the 점검 line and the 설정 창 show.
- Unofficial code that remains: the whole reader in `chzzk.js` (`_connectChat`, `_onChat`, `_poll` live-detail), including the 19+ dock lookup (`dockGet`), but only for the fallback and the opt-in; the 리모컨 buttons and 영도 skip-ad are untouched. Removed from the official path: every dock-based 관리 call and the anonymous profile card (kept only for the no-app fallback).
- Tests: `node --test tools/dev/test-chzzk-official.mjs` (11 tests against `tools/dev/mock-chzzk-open.mjs`).
- **Untested against Naver:** the Socket.IO protocol details, the emoticon token format in `content`, the `badges` object fields, the representation of anonymous donors, whether a session survives its token's expiry (the manager rolls over before it), 19+ behaviour, `chats/notice` side effects, rate limits.
