# 치즈 룰렛 v2 — 투네이션식 후원 룰렛 (0.36)

Owner's asks (2026-10-28): tell a roulette donation apart from a normal one, let viewers see each
item's odds/rarity, work like 투네이션's 룰렛 후원.

## How 투네이션 does it
Its donation page has a **룰렛 후원** tab: the viewer picks one of the streamer's roulettes, sees every
item with its **확률** and the price, pays, and the result plays on stream. Normal donations go through
another tab, so they never spin.

## What Chzzk allows
Allmind can't add a tab to Chzzk's donation window — a viewer only sends 치즈 + a message. So:

- **Exact price** picks the roulette (owner's choice). Each donation roulette has its own price;
  an amount of exactly `price × n` (1 ≤ n ≤ maxSpins) spins it n times. Anything else is a normal
  donation. If several roulettes match (1,000 and 2,000; 4,000 = 4× small or 2× big), the one with the
  **largest price** (fewest spins) wins; the panel warns about such overlaps. Two roulettes may not
  share a price.
- **Several donation roulettes** (max 8), each `{ id, title, price, enabled, items }`. 무료 룰렛
  (`wheels`) stay as they are.
- **Odds visible to viewers**:
  - `/roulette-board` — a second OBS browser source: each roulette's price, items with % and tier
    (★ 전설 / ✦ 희귀), one page per roulette when there are several. Modes: 항상 / N분마다 S초 / 끔,
    plus "show on `!룰렛`". Hidden while a spin is on screen (optional). Own SSE channel
    (`/api/roulette/board-events`) so it doesn't count as a roulette overlay or ack spins.
  - `!룰렛` chat command (configurable) → Allmind answers in chat through the CHZZK Open API
    (`chzzkOpen.sendChat`, 100 chars per message, split, at most 4 messages, 1 s apart), global
    cooldown 30 s. Without chat permission it only shows the board.

## Data
Settings: `{ enabled, maxSpins, kinds, spinSec, holdSec, fastFrom, roulettes[], wheels[],
board: { mode: off|always|every, everyMin, showSec, onCommand, hideWhileSpinning },
chat: { enabled, command, cooldownSec } }`. Old settings (`title`, `price`, `items`) migrate to
`roulettes[0]`. Log rows gain `rid`/`rtitle` (donation roulette); free wheels keep `wheel`/`wheelTitle`.

## Not in scope
Viewers choosing by message keyword (owner chose exact price). VTS 던지기 donations still count any
amount on their own setting.
