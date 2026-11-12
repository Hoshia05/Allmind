# 시청자 추첨 (viewer draw) — plan, 2026-11-12

**Status: built in 0.45.0 / pack 1.5.0** (see CLAUDE.md code map). Real Windows voice and real chat not yet tried by the owner.

Owner's ask: collect the viewers in chat, draw 1 or n of them, highlight the winner and read the winner's chat
aloud (TTS). Twist: besides a plain roulette, an **Ace Combat-style sortie** — every entrant launches as a jet,
the losers get shot down on the way, only the winner(s) reach the goal.
Similar tools exist (chzzk-vote: viewer draw with sub-only / skip past winners; cheezbooth live stage), none with
the TTS or the sortie.

## Rules (owner's decisions)
- **Entry window: by time or by hand.** Opening entry takes an optional duration (e.g. 30 s / 1 min / 3 min / custom
  or none). A countdown shows on the panel and the overlay; **마감** ends it any time, **+30초** extends it.
  Same for the winner-chat window: an optional duration **and** a **끝내기** button.
- **Entry modes:** `keyword` (default `!참여`, editable; one entry per uid) or `recent` (everyone who chatted in the last
  N minutes, from `chzzk.users[].lastSeen`; snapshot taken when the draw starts — no window needed).
- **Filters:** 구독자만, 지난 당첨자 제외 (this stream / always), streamer + managers excluded (`role`), YouTube chat
  lines excluded (no uid to reach them). Everyone has the **same odds** — no subscriber weighting (no-pay-to-win).
- **Fair pick on the server** (`crypto.randomInt`, like `roulette.js`), *before* any animation. The overlay only
  stages a result it is given; the sortie script is derived from a seed so a replay plays out identically.
- **다시 뽑기** for a winner who doesn't answer (draws one more from the remaining entrants, same style).

## Server: `src/draw.js` `ViewerDraw extends EventEmitter`
- State `draw.json`: settings `{style:'sortie'|'roulette', keyword, mode, recentMin, entrySec, winners, subsOnly,
  skipPast:'none'|'stream'|'always', chatSec, tts:{on, announce, volume, maxLen}}`, `past` winners (uid, nick, at),
  log of draws (keep 30).
- Runtime: `phase` `idle → entry → ready → drawing → winners → idle`; `entrants` Map uid → {nick, sub, badges, at};
  `endsAt` for the entry and chat windows (timers server-side; panel/overlay only show countdowns).
- Listens to `chzzk` `'live-chat'` (live lines only): during `entry` + keyword match → add (filters applied at entry
  time *and* re-checked at draw); during `winners` → a winner's line → `winner-chat` event (+ TTS).
- Routes `POST /api/draw/{settings,open,close,extend,draw,redraw,end,reset}`, `GET /api/draw/state`;
  SSE `/api/draw/events` for the overlay (**`PIN_FREE_API`**, only while an overlay is connected, like
  `/api/dogfight/events`). Dashboard/Xylem get state via the snapshot / Xylem's channel.
- Highlight winners' lines in the dashboard chat (`m.drawWinner = true` while the window is open).
- Optional chat notice via `chzzkOpen.sendChat` ("추첨 참여: 채팅에 !참여" / "당첨: ○○님") — off by default.

## TTS (Windows built-in voice)
- OBS CEF has no reliable `speechSynthesis`, so the stream PC renders speech: `src/tts.js` → PowerShell
  `System.Speech.Synthesis.SpeechSynthesizer` (Korean voice, prefers "Heami"; picker lists installed voices) →
  WAV in `DATA_DIR/tts/` (temp, deleted after 10 min) → served at `/api/draw/tts/<id>.wav` (PIN-free, random id)
  → the overlay plays it (`<audio>`), so OBS mixes it like any browser source (owner can route its track).
- One synth at a time, queue max 5 lines, line cut to `maxLen` (default 60 chars), emoji/URLs stripped,
  `announce` = "○○님 당첨!" before the chat lines. Off Windows: a silent WAV + log line (mock).
- Lean: a PowerShell spawn per line (~0.3–0.5 s CPU), only while a winner window is open.

## Overlays (Xylem pack, 1920×1080 transparent)
- `/draw` — one page, picks the style per draw.
  - **roulette:** names scroll in a slot-machine column, decelerate, land on the winner; winner card.
  - **sortie (~30–45 s):** launch in formation (callsign tags = nicknames) → gauntlet with escalating losses:
    SAM sites, flak, enemy fighters, clouds/lightning (reuse `makeWeather` ideas), canyon wall, a superweapon beam that
    takes several at once, joke losses (out of fuel, collision). Radio ticker: "○○ 격추!", "○○, 비상 탈출!".
    Slows down at n+1 left, final tunnel/canyon dash, "임무 완수" banner + winner card(s).
    Scale: >30 entrants → early waves remove groups so it never drags; the last ~12 keep readable tags; tested
    with 1, 2, 5, 30, 150 entrants and n = 1–3.
  - Entry phase: "추첨 참여: 채팅에 !참여" + countdown + live count (+ last few names).
  - Winner window: winner card + their chat lines as radio transmissions; TTS audio plays here.
  - Original art in the 공중전 style — no Ace Combat assets, music or names.
  - Reuse drawing code from `dogfight.html` by copy (it's one self-contained page); keep the script deterministic
    from `seed` (mulberry32) so `?demo=1&n=40&w=2&seed=7` previews offline.
- Panel `draw.panel.js` on the Xylem page: settings, 참여 열기 (duration chips + custom) / 마감 / +30초,
  live entrant list (remove one by hand), 뽑기, winners + 다시 뽑기, winner chat feed, 끝내기, TTS test button,
  overlay URL to copy, past winners.

## Release
Allmind minor (server: draw.js, tts.js, routes, chat highlight) + Xylem pack minor (`minAllmind` = that version).
Mock: `POST :9333/mock/chat` for entries; fake subs; check the overlay with Playwright screenshots per phase;
TTS mock-only (real Windows voice = owner's first check).
