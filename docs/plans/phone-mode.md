# 폰 모드 (plan, 2026-11-05)

Owner: the PC layout and a phone/iPad layout can't share one design; wants a separate mode optimized for mobile.
Devices: **iPad Pro 12.9"** and **Galaxy Z Fold 7**. He hasn't used the mobile views much, so the choices below
are ours to make.

## Which screen gets what
| Screen | CSS size (approx.) | Today | Plan |
|---|---|---|---|
| Fold 7 cover (folded) | ~410 × 900 | phone layout (bottom tabs) | **폰 모드** |
| Fold 7 inner (unfolded) | ~880 × 1000, near-square | tablet-portrait layout | **폰 모드, two columns** (home + chat side by side) |
| iPad 12.9 portrait | 1024 × 1366 | tablet-portrait layout | 폰 모드, two columns (switch in ⚙ to go back) |
| iPad 12.9 landscape | 1366 × 1024 | free dock layout (desktop) | unchanged — it's a desk-sized screen |

Switch: ⚙ (이 기기 설정) → 화면: **자동 / 폰 모드 / PC 화면**, saved per device (`pref`). 자동 = the table above.

## Layout
- **Top strip** (one line): LIVE/REC pill (opens 방송 · 녹화), viewers, uptime, health dot, ⚙. Everything else in
  the top bar (점검, 방송 기록, 방송 준비, 리모컨, Xylem) moves into the 홈 tab or the ⚙ menu.
- **Bottom tabs**: **홈 · 채팅 · 음악 · 화면 · 더보기**.
  - **홈** (new): big touch targets for what's pressed mid-stream —
    마이크 (with level), ⭐ 마크, scene buttons, BGM ▶/⏸ + 다음 + current track, 영도 넘기기 / 광고 스킵 / 알림 정지,
    pinned OBS sources and audio (from the OBS panel), 오늘 할 일 (unchecked items, tap to check), 방송 준비 / 점검 shortcuts.
  - **채팅**: full height, with the send box; donations as a filter, as now.
  - **음악**: player + setlist + 사운드보드 (grid).
  - **화면**: 방송 화면 / 영도 / 알림 화면 mirrors — **only this tab runs a mirror**, so the phone doesn't pull
    preview frames while you're on 홈 or 채팅 (lighter for the stream PC than today).
  - **더보기**: 할 일 (full list), Xylem, 방송 기록, 리모컨, 설정.
- Two-column variant (Fold inner, iPad portrait): 홈 on the left, chat on the right; the other tabs as on the phone.

## How (reuse, don't duplicate)
- `body.phone-mode` class + CSS; panels are **moved/restyled, not duplicated** — the render functions address
  elements by id, so one copy of each control. iframes (Xylem) must not be moved after load (see CLAUDE.md).
- The 홈 tab is a new container that hosts *existing* controls where possible (mic button, mark button, scene
  buttons, BGM transport) and a few new compact widgets (pinned OBS rows reuse `#obsBody` rendering, todo "오늘" list).
- Mirrors: extend the existing "is this panel on screen" check so only the 화면 tab streams.
- Haptics (`buzz()`) on the 홈 buttons; minimum 44 px touch targets; safe-area insets for the Fold's cutout.

## Testing
Playwright (Chromium) at 412×915, 884×1000 and 1024×1366, screenshots per tab; no WebKit here, so iPad Safari
needs the owner's check. Mirror request counts per tab with `MOCK_REQS=1`.

## Size
One release (~0.45). Mostly CSS + the 홈 container + the mode switch; no server changes.
