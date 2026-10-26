// 치즈 룰렛 (Toonation-style): every N 치즈 in one donation = one spin.
// The server decides each result (crypto.randomInt, by weight) and logs it; the overlay only animates
// the wheel onto that result. Spins wait in a queue until an overlay has shown them, so a restart or
// an overlay reload mid-spin replays the same result instead of losing or re-rolling it.
import crypto from 'node:crypto';
import { loadState, saveState } from './config.js';

const MAX_LOG = 500;
const COLORS = ['#ff6b6b', '#ffd34d', '#5be37d', '#4fc3f7', '#b388ff', '#ff9f43', '#f06292', '#2fd8c8', '#9ccc65', '#ffb74d'];
export const DEFAULTS = {
  enabled: true,
  price: 1000,          // 치즈 per spin
  maxSpins: 10,         // per donation
  kinds: { CHAT: true, VIDEO: false, MISSION: false }, // which donation types count
  spinSec: 6,
  holdSec: 5,
  title: '치즈 룰렛',
  items: [
    { id: 'a', name: '꽝', weight: 40, color: COLORS[0] },
    { id: 'b', name: '애교 한 번', weight: 25, color: COLORS[1] },
    { id: 'c', name: '노래 한 소절', weight: 20, color: COLORS[2] },
    { id: 'd', name: '벌칙 게임', weight: 10, color: COLORS[3] },
    { id: 'e', name: '소원 들어주기', weight: 5, color: COLORS[4] },
  ],
};

export function clean(input, old = DEFAULTS) {
  const s = { ...old, ...(input || {}) };
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const items = (Array.isArray(s.items) ? s.items : []).slice(0, 24).map((it, i) => ({
    id: String(it?.id || crypto.randomBytes(4).toString('hex')).slice(0, 16),
    name: String(it?.name || '').trim().slice(0, 30) || `항목 ${i + 1}`,
    weight: num(it?.weight, 0, 1e6, 1),
    color: /^#[0-9a-f]{6}$/i.test(it?.color || '') ? it.color : COLORS[i % COLORS.length],
  }));
  if (items.length < 2) throw new Error('룰렛 항목은 2개 이상 있어야 해요');
  if (!items.some((it) => it.weight > 0)) throw new Error('확률이 0보다 큰 항목이 하나는 있어야 해요');
  return {
    enabled: !!s.enabled,
    price: Math.round(num(s.price, 100, 10_000_000, 1000)),
    maxSpins: Math.round(num(s.maxSpins, 1, 50, 10)),
    kinds: { CHAT: !!s.kinds?.CHAT, VIDEO: !!s.kinds?.VIDEO, MISSION: !!s.kinds?.MISSION },
    spinSec: num(s.spinSec, 2, 20, 6),
    holdSec: num(s.holdSec, 1, 30, 5),
    title: String(s.title || '치즈 룰렛').slice(0, 30),
    items,
  };
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
  constructor(chzzk, pack) {
    let st = loadState('roulette', null);
    try { st = clean(st || DEFAULTS); } catch { st = clean(DEFAULTS); }
    this.s = st;
    this.log = loadState('roulette-log', []); // newest last: { id, time, group, idx, of, nick, uid, amount, itemId, result, color, shown, done, test }
    this.ch = pack.channel(() => [['config', this.view()], ['queue', this.queue()]]);
    // live donations only (not the history Chzzk replays when the chat reconnects)
    chzzk.on('live-chat', (list) => { for (const m of list) if (m.kind === 'donation') this.onDonation(m); });
  }

  view() { return { title: this.s.title, items: this.s.items, spinSec: this.s.spinSec, holdSec: this.s.holdSec }; }
  queue() { return this.log.filter((r) => !r.shown).slice(0, 100); }
  settings() { return this.s; }

  setSettings(input) {
    this.s = clean(input, this.s);
    saveState('roulette', this.s);
    this.ch.send('config', this.view());
    return this.s;
  }

  spinsFor(amount) { return Math.min(this.s.maxSpins, Math.floor((Number(amount) || 0) / this.s.price)); }

  onDonation(d) {
    if (!this.s.enabled) return;
    const kind = String(d.donationType || 'CHAT').toUpperCase();
    if (!this.s.kinds[kind]) return;
    const n = this.spinsFor(d.amount);
    if (n < 1) return;
    this.add({ nick: d.nick || '익명', uid: d.uid || '', amount: d.amount, n, test: false });
  }

  add({ nick, uid, amount, n, test }) {
    const group = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    for (let i = 0; i < n; i++) {
      const it = pick(this.s.items);
      this.log.push({ id: `${group}-${i}`, time: Date.now(), group, idx: i + 1, of: n, nick: String(nick).slice(0, 30), uid, amount, itemId: it.id, result: it.name, color: it.color, shown: false, done: false, test: !!test });
    }
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    console.log(`[roulette] ${nick} ${amount}치즈 → ${n}회: ${this.log.slice(-n).map((r) => r.result).join(', ')}${test ? ' (테스트)' : ''}`);
    this._changed();
    return this.log.slice(-n);
  }

  test(spins = 1) {
    return this.add({ nick: '테스트', uid: '', amount: this.s.price * spins, n: Math.max(1, Math.min(10, Number(spins) || 1)), test: true });
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
    if (queue) this.ch.send('queue', this.queue());
  }

  attach(req, res) { this.ch.attach(req, res); }
  status() { return { overlays: this.ch.size, pending: this.queue().length, log: this.log.slice(-200).reverse(), settings: this.s }; }
}
