// 치즈 룰렛 (투네이션-style 룰렛 후원, docs/plans/roulette-v2.md). Several donation roulettes, each with
// its own price: a donation of exactly price × n 치즈 (n ≤ maxSpins) spins that roulette n times; any other
// amount is a normal donation. Plus 무료 룰렛 (wheels) the streamer spins from the Xylem page.
// Viewers see the odds on the /roulette-board overlay and via the `!룰렛` chat command.
// Every item has a rarity tier (자동 = by its chance) that the overlay celebrates differently, and a
// donation worth several spins is shown fast with a summary card at the end.
// The server decides each result (crypto.randomInt, by weight) and logs it; the overlay only animates
// the wheel onto that result. Spins wait in a queue until an overlay has shown them, so a restart or
// an overlay reload mid-spin replays the same result instead of losing or re-rolling it.
import crypto from 'node:crypto';
import { loadState, saveState } from './config.js';

const MAX_LOG = 500;
const COLORS = ['#ff6b6b', '#ffd34d', '#5be37d', '#4fc3f7', '#b388ff', '#ff9f43', '#f06292', '#2fd8c8', '#9ccc65', '#ffb74d'];
const DEFAULT_ITEMS = [
  { id: 'a', name: '꽝', weight: 40, color: COLORS[0] },
  { id: 'b', name: '애교 한 번', weight: 25, color: COLORS[1] },
  { id: 'c', name: '노래 한 소절', weight: 20, color: COLORS[2] },
  { id: 'd', name: '벌칙 게임', weight: 10, color: COLORS[3] },
  { id: 'e', name: '소원 들어주기', weight: 5, color: COLORS[4] },
];
export const DEFAULTS = {
  enabled: true,
  maxSpins: 10,         // per donation
  kinds: { CHAT: true, VIDEO: false, MISSION: false }, // which donation types count
  spinSec: 6,
  holdSec: 5,
  fastFrom: 3,          // a donation worth this many spins or more is shown fast + summary (0 = never)
  roulettes: [{ id: 'main', title: '치즈 룰렛', price: 1000, enabled: true, items: DEFAULT_ITEMS }],
  wheels: [],           // 무료 룰렛: [{ id, title, items }]
  board: { mode: 'every', everyMin: 10, showSec: 15, onCommand: true, hideWhileSpinning: true },
  chat: { enabled: true, command: '!룰렛', cooldownSec: 30 },
};
const BOARD_MODES = ['off', 'always', 'every'];

const TIERS = ['auto', 'normal', 'rare', 'legend'];
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const newId = () => crypto.randomBytes(4).toString('hex');
function cleanItems(list, what = '룰렛') {
  const items = (Array.isArray(list) ? list : []).slice(0, 24).map((it, i) => ({
    id: String(it?.id || newId()).slice(0, 16),
    name: String(it?.name || '').trim().slice(0, 30) || `항목 ${i + 1}`,
    weight: num(it?.weight, 0, 1e6, 1),
    color: /^#[0-9a-f]{6}$/i.test(it?.color || '') ? it.color : COLORS[i % COLORS.length],
    tier: TIERS.includes(it?.tier) ? it.tier : 'auto',
  }));
  if (items.length < 2) throw new Error(`${what} 항목은 2개 이상 있어야 해요`);
  if (!items.some((it) => it.weight > 0)) throw new Error(`${what}: 확률이 0보다 큰 항목이 하나는 있어야 해요`);
  return items;
}
// 자동 tier: 5 % or less → 전설, 15 % or less → 희귀, else 일반
export function tierOf(it, items) {
  if (it.tier && it.tier !== 'auto') return it.tier;
  const total = items.reduce((a, x) => a + Math.max(0, x.weight), 0) || 1;
  const p = Math.max(0, it.weight) / total;
  return p <= 0.05 ? 'legend' : p <= 0.15 ? 'rare' : 'normal';
}
const withTiers = (items) => items.map((it) => ({ ...it, tierEff: tierOf(it, items) }));
// "12%" / "2.5%" — what viewers see
export function pctText(it, items) {
  const total = items.reduce((a, x) => a + Math.max(0, x.weight), 0) || 1;
  const p = (Math.max(0, it.weight) / total) * 100;
  return `${p < 10 ? Number(p.toFixed(1)) : Math.round(p)}%`;
}

export function clean(input, old = DEFAULTS) {
  const s = { ...old, ...(input || {}) };
  // before 0.36 there was one donation roulette: { title, price, items }
  if (!Array.isArray(input?.roulettes) && input?.items) s.roulettes = [{ id: 'main', title: input.title || '치즈 룰렛', price: input.price || 1000, enabled: true, items: input.items }];
  const roulettes = (Array.isArray(s.roulettes) ? s.roulettes : []).slice(0, 8).map((r, i) => {
    const title = String(r?.title || '').trim().slice(0, 30) || `룰렛 ${i + 1}`;
    return { id: String(r?.id || newId()).slice(0, 16), title, price: Math.round(num(r?.price, 100, 10_000_000, 1000)), enabled: r?.enabled !== false, items: cleanItems(r?.items, title) };
  });
  if (!roulettes.length) throw new Error('후원 룰렛이 하나는 있어야 해요 (안 쓰려면 꺼 두세요)');
  const prices = new Map();
  for (const r of roulettes) {
    if (prices.has(r.price)) throw new Error(`"${prices.get(r.price)}"·"${r.title}" 두 룰렛의 가격이 같아요 (${r.price.toLocaleString()} 치즈) — 가격으로 룰렛을 고르니까 서로 달라야 해요`);
    prices.set(r.price, r.title);
  }
  const wheels = (Array.isArray(s.wheels) ? s.wheels : []).slice(0, 8).map((w, i) => ({
    id: String(w?.id || newId()).slice(0, 16),
    title: String(w?.title || '').trim().slice(0, 30) || `무료 룰렛 ${i + 1}`,
    items: cleanItems(w?.items, String(w?.title || `무료 룰렛 ${i + 1}`)),
  }));
  const b = { ...DEFAULTS.board, ...(s.board || {}) };
  const c = { ...DEFAULTS.chat, ...(s.chat || {}) };
  const command = String(c.command || '').trim().split(/\s+/)[0].slice(0, 20);
  return {
    enabled: !!s.enabled,
    maxSpins: Math.round(num(s.maxSpins, 1, 50, 10)),
    kinds: { CHAT: !!s.kinds?.CHAT, VIDEO: !!s.kinds?.VIDEO, MISSION: !!s.kinds?.MISSION },
    spinSec: num(s.spinSec, 2, 20, 6),
    holdSec: num(s.holdSec, 1, 30, 5),
    fastFrom: Math.round(num(s.fastFrom, 0, 50, 3)),
    roulettes,
    wheels,
    board: { mode: BOARD_MODES.includes(b.mode) ? b.mode : 'every', everyMin: Math.round(num(b.everyMin, 1, 120, 10)), showSec: Math.round(num(b.showSec, 5, 120, 15)), onCommand: !!b.onCommand, hideWhileSpinning: !!b.hideWhileSpinning },
    chat: { enabled: !!c.enabled, command: command.length >= 2 ? command : '!룰렛', cooldownSec: Math.round(num(c.cooldownSec, 5, 600, 30)) },
  };
}

// Which roulette an amount buys, and how many spins: exactly price × n, the largest price wins
export function match(s, amount) {
  const a = Math.round(Number(amount) || 0);
  let best = null;
  for (const r of s.roulettes) {
    if (!r.enabled || a < r.price || a % r.price) continue;
    const n = a / r.price;
    if (n > s.maxSpins) continue;
    if (!best || r.price > best.r.price) best = { r, n };
  }
  return best;
}
// amounts that could mean two roulettes (shown as a warning in the panel)
export function overlaps(s) {
  const out = [];
  const on = s.roulettes.filter((r) => r.enabled);
  for (const small of on) for (const big of on) {
    if (big.price <= small.price || big.price % small.price) continue;
    const k = big.price / small.price;
    if (k <= s.maxSpins) out.push(`${big.price.toLocaleString()} 치즈는 "${small.title}" ${k}회가 아니라 "${big.title}" 1회로 돌아가요`);
  }
  return out;
}

// Weighted pick with a cryptographic RNG. Weights may have decimals (e.g. 12.5 %).
export function pick(items) {
  const w = items.map((it) => Math.round(Math.max(0, it.weight) * 1000));
  const total = w.reduce((a, b) => a + b, 0);
  let r = crypto.randomInt(total);
  for (let i = 0; i < items.length; i++) { if (r < w[i]) return items[i]; r -= w[i]; }
  return items[items.length - 1];
}

export class Roulette {
  // chzzkOpen (optional): answers the `!룰렛` command in chat
  constructor(chzzk, pack, chzzkOpen = null) {
    let st = loadState('roulette', null);
    try { st = clean(st || DEFAULTS); } catch { st = clean(DEFAULTS); }
    this.s = st;
    this.chzzkOpen = chzzkOpen;
    this.log = loadState('roulette-log', []); // newest last: { id, time, group, idx, of, nick, uid, amount, itemId, result, color, tier, rid, rtitle, wheel, wheelTitle, shown, done, test }
    this.ch = pack.channel(() => [['config', this.view()], ['queue', this.queue()]]);
    // the odds board (/roulette-board): its own channel, so it neither counts as a roulette overlay nor acks spins
    this.boardCh = pack.channel(() => [['config', this.view()], ['busy', this.queue().length > 0]]);
    this.lastAnswer = 0;
    this.nextBoard = Date.now() + 60000;
    setInterval(() => this._boardTick(), 15000).unref?.();
    // live messages only (not the history Chzzk replays when the chat reconnects)
    chzzk.on('live-chat', (list) => {
      for (const m of list) {
        if (m.kind === 'donation') this.onDonation(m);
        else if (m.kind === 'chat') this.onChat(m);
      }
    });
  }

  view() {
    return {
      roulettes: this.s.roulettes.filter((r) => r.enabled).map((r) => ({ id: r.id, title: r.title, price: r.price, items: withTiers(r.items) })),
      wheels: this.s.wheels.map((w) => ({ id: w.id, title: w.title, items: withTiers(w.items) })),
      spinSec: this.s.spinSec, holdSec: this.s.holdSec, fastFrom: this.s.fastFrom, maxSpins: this.s.maxSpins,
      enabled: this.s.enabled, board: this.s.board, command: this.s.chat.enabled ? this.s.chat.command : '',
    };
  }
  queue() { return this.log.filter((r) => !r.shown).slice(0, 100); }
  settings() { return this.s; }

  setSettings(input) {
    this.s = clean(input, this.s);
    saveState('roulette', this.s);
    this.ch.send('config', this.view());
    this.boardCh.send('config', this.view());
    return this.s;
  }

  onDonation(d) {
    if (!this.s.enabled) return;
    const kind = String(d.donationType || 'CHAT').toUpperCase();
    if (!this.s.kinds[kind]) return;
    const m = match(this.s, d.amount);
    if (!m) return; // not a roulette price: a normal donation
    this.add({ nick: d.nick || '익명', uid: d.uid || '', amount: d.amount, n: m.n, test: false, roulette: m.r });
  }

  add({ nick, uid, amount, n, test, wheel = null, roulette = null }) {
    const group = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const items = wheel ? wheel.items : roulette.items;
    for (let i = 0; i < n; i++) {
      const it = pick(items);
      this.log.push({
        id: `${group}-${i}`, time: Date.now(), group, idx: i + 1, of: n, nick: String(nick).slice(0, 30), uid, amount,
        itemId: it.id, result: it.name, color: it.color, tier: tierOf(it, items),
        rid: roulette ? roulette.id : null, rtitle: roulette ? roulette.title : null,
        wheel: wheel ? wheel.id : null, wheelTitle: wheel ? wheel.title : null,
        shown: false, done: false, test: !!test,
      });
    }
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    console.log(`[roulette] ${wheel ? `무료 룰렛 "${wheel.title}"` : `"${roulette.title}" ${nick} ${amount}치즈`} → ${n}회: ${this.log.slice(-n).map((r) => r.result).join(', ')}${test ? ' (테스트)' : ''}`);
    this._changed();
    return this.log.slice(-n);
  }

  // 무료 룰렛: spun by the streamer from the Xylem page
  spinWheel(id, spins = 1) {
    const w = this.s.wheels.find((x) => x.id === id);
    if (!w) throw new Error('그 무료 룰렛이 없어요 — 저장했는지 확인해 주세요');
    return this.add({ nick: w.title, uid: '', amount: 0, n: Math.max(1, Math.min(10, Number(spins) || 1)), test: false, wheel: w });
  }

  test(spins = 1, rid = null) {
    const r = this.s.roulettes.find((x) => x.id === rid) || this.s.roulettes[0];
    const n = Math.max(1, Math.min(10, Number(spins) || 1));
    return this.add({ nick: '테스트', uid: '', amount: r.price * n, n, test: true, roulette: r });
  }

  // ---------- telling viewers the odds ----------
  // `!룰렛` in chat → the board shows, and Allmind answers in chat (if it may send chat)
  onChat(m) {
    const c = this.s.chat;
    if (!this.s.enabled || !c.enabled) return;
    if (String(m.text || '').trim().split(/\s+/)[0] !== c.command) return;
    if (Date.now() - this.lastAnswer < c.cooldownSec * 1000) return;
    this.lastAnswer = Date.now();
    if (this.s.board.onCommand) this.showBoard();
    this._answer().catch((e) => console.log(`[roulette] ${c.command} answer not sent: ${e.message}`));
  }
  chatLines() {
    const lines = [];
    const on = this.s.roulettes.filter((r) => r.enabled);
    for (const r of on) {
      const items = r.items.filter((it) => it.weight > 0);
      const parts = items.map((it) => { const t = tierOf(it, r.items); return `${t === 'legend' ? '★' : t === 'rare' ? '✦' : ''}${it.name} ${pctText(it, r.items)}`; });
      let line = `🎡 ${r.title} ${r.price.toLocaleString()}치즈:`;
      for (const p of parts) {
        if ([...`${line} ${p}`].length > 100) { lines.push(line); line = `└ ${p}`; } else line = line.endsWith(':') ? `${line} ${p}` : `${line} · ${p}`;
      }
      lines.push(line);
    }
    if (on.length) lines.push(`정확히 그 금액(또는 2배·3배… 최대 ${this.s.maxSpins}배)으로 후원하면 돌아가요. 다른 금액은 일반 후원이에요.`);
    const MAX = 4;
    return lines.length > MAX ? [...lines.slice(0, MAX - 1), '나머지는 방송 화면의 룰렛 안내를 봐 주세요'] : lines;
  }
  async _answer() {
    if (!(this.chzzkOpen?.configured() && this.chzzkOpen.loggedIn())) throw new Error('치지직 연동이 안 되어 있어요');
    for (const [i, line] of this.chatLines().entries()) {
      if (i) await new Promise((r) => setTimeout(r, 1000));
      await this.chzzkOpen.sendChat(line);
    }
  }
  showBoard(sec = this.s.board.showSec) {
    this.boardCh.send('show', { sec });
    this.nextBoard = Date.now() + this.s.board.everyMin * 60000;
  }
  _boardTick() {
    const b = this.s.board;
    if (!this.s.enabled || b.mode !== 'every' || !this.boardCh.size) return;
    if (Date.now() >= this.nextBoard) this.showBoard();
  }

  // the overlay finished showing one spin
  shown(id) {
    const r = this.log.find((x) => x.id === id);
    if (r && !r.shown) { r.shown = true; this._changed(); }
  }
  skipAll() {
    for (const r of this.log) r.shown = true;
    this._changed();
  }
  setDone(id, done) {
    const r = this.log.find((x) => x.id === id);
    if (!r) throw new Error('기록을 찾을 수 없어요');
    r.done = !!done;
    this._changed(false);
  }
  clearLog() {
    this.log = this.log.filter((r) => !r.shown); // never drop spins that haven't been shown yet
    this._changed(false);
  }

  _changed(queue = true) {
    saveState('roulette-log', this.log);
    if (queue) { this.ch.send('queue', this.queue()); this.boardCh.send('busy', this.queue().length > 0); }
  }

  attach(req, res) { this.ch.attach(req, res); }
  attachBoard(req, res) { this.boardCh.attach(req, res); }
  status() {
    return { overlays: this.ch.size, boards: this.boardCh.size, pending: this.queue().length, log: this.log.slice(-200).reverse(), settings: this.s, overlaps: overlaps(this.s), chatLines: this.chatLines(), canChat: !!(this.chzzkOpen?.configured() && this.chzzkOpen.loggedIn()) };
  }
}
