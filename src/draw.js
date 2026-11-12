// 시청자 추첨 (viewer draw, docs/plans/draw.md): collect viewers from chat, pick 1…n of them, stage the result
// on the /draw overlay (a slot-machine roll, or a 공중전 sortie where the losers get shot down) and read the
// winners' chat aloud (src/tts.js).
//
//   phase  idle → entry → ready → drawing → winners → idle
//   entry:   chat keyword (default `!참여`) adds a viewer; optional countdown (endsAt), 마감 / +30초 by hand
//   ready:   entry closed, waiting for 뽑기  (mode 'recent' skips entry: everyone who chatted lately is the pool)
//   drawing: the server has ALREADY picked (crypto.randomInt) — the overlay only stages the result and reports
//            back (`shown`); a reload replays the same draw from its seed
//   winners: the winners' chat lines go to the overlay as radio calls + TTS and are highlighted in the dashboard
//
// Fairness: every eligible viewer has the same odds. Donations and subscriptions never weigh in (no pay-to-win);
// "구독자만" is only a filter. Costs nothing while idle; the overlay's SSE exists only while an overlay is open.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { loadState, saveState } from './config.js';
import { speakable } from './tts.js';

export const DEFAULTS = {
  style: 'sortie',        // 'sortie' (공중전 출격) | 'roulette'
  mode: 'keyword',        // 'keyword' = viewers type the keyword | 'recent' = everyone who chatted in the last N minutes
  keyword: '!참여',
  recentMin: 10,
  entrySec: 60,           // length of the entry window, 0 = until 마감
  winners: 1,
  subsOnly: false,
  skipPast: 'stream',     // 'none' | 'stream' (not this stream's winners) | 'always'
  chatSec: 60,            // how long the winners' chat is read aloud, 0 = until 끝내기
  tts: { on: true, announce: true, volume: 80, maxLen: 60, voice: '' },
  notice: false,          // say "추첨 참여: …" / the winners in the chat (needs 치지직 연동 + 채팅 쓰기)
};
const STYLES = ['sortie', 'roulette'];
const SKIPS = ['none', 'stream', 'always'];
const MAX_ENTRANTS = 3000;
const MAX_PAST = 500;
const MAX_LOG = 30;
const ANIM_MAX = 150;           // names the overlay animates (it must stay readable and quick)
const REDRAW_SHOW = 12;         // names in a replacement draw's animation
const DRAW_TIMEOUT_MS = 90000;  // the overlay should answer long before this; without it the result is shown anyway
const STREAM_FALLBACK_MS = 8 * 3600 * 1000;
// the 테스트 추첨: fake viewers walk through the whole flow so it can be tried without real chat
const TEST_NICKS = ['별빛여행자', '라면조아', '새벽감성', '야근하는개발자', '고양이집사', '치즈덕후', '밤하늘', '코딩하는곰', '달빛산책', '피자왕', '구름빵', '민트초코', '호시아팬1호', '초보조종사', '에이스', '하늘바라기', '오늘도맑음', '커피수혈', '게임중독', '꿀잠', '햇살가득', '우주먼지', '소금빵', '불꽃슛', '느긋한토끼', '번개맨', '별똥별', '단팥빵', '파랑새', '눈사람'];
const TEST_LINES = ['와 진짜 당첨이에요?! 감사합니다 {:d_2:}', '호시아님 방송 항상 재미있게 보고 있어요 ㅎㅎ', '오늘 방송 너무 재밌었어요! 다음에도 또 해 주세요', '떨려서 손이 덜덜 떨려요… 정말 고마워요!'];
const testNick = (i) => (i < TEST_NICKS.length ? TEST_NICKS[i] : `${TEST_NICKS[i % TEST_NICKS.length]}${Math.floor(i / TEST_NICKS.length) + 1}`);

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const isStaff = (r) => r === 'streamer' || r === 'manager';
const pickN = (list, n) => { // n distinct items, uniformly, with a cryptographic RNG (partial Fisher–Yates)
  const a = list.slice();
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) { const j = i + crypto.randomInt(a.length - i); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
};

export function clean(input, old = DEFAULTS) {
  const s = { ...old, ...(input || {}) };
  const t = { ...DEFAULTS.tts, ...(old.tts || {}), ...(input?.tts || {}) };
  const keyword = String(s.keyword ?? '').trim().split(/\s+/)[0].slice(0, 20);
  return {
    style: STYLES.includes(s.style) ? s.style : 'sortie',
    mode: s.mode === 'recent' ? 'recent' : 'keyword',
    keyword: keyword.length >= 2 ? keyword : DEFAULTS.keyword,
    recentMin: Math.round(num(s.recentMin, 1, 120, 10)),
    entrySec: Math.round(num(s.entrySec, 0, 3600, 60)),
    winners: Math.round(num(s.winners, 1, 10, 1)),
    subsOnly: !!s.subsOnly,
    skipPast: SKIPS.includes(s.skipPast) ? s.skipPast : 'stream',
    chatSec: Math.round(num(s.chatSec, 0, 1800, 60)),
    tts: { on: !!t.on, announce: t.announce !== false, volume: Math.round(num(t.volume, 0, 100, 80)), maxLen: Math.round(num(t.maxLen, 10, 200, 60)), voice: String(t.voice || '').slice(0, 80) },
    notice: !!s.notice,
  };
}

export class ViewerDraw extends EventEmitter {
  constructor(chzzk, pack, chzzkOpen, tts) {
    super();
    this.chzzk = chzzk;
    this.chzzkOpen = chzzkOpen;
    this.tts = tts;
    const st = loadState('draw', {});
    this.s = clean(st.settings || DEFAULTS);
    this.past = Array.isArray(st.past) ? st.past.slice(-MAX_PAST) : [];       // { uid, nick, at }
    this.log = Array.isArray(st.log) ? st.log.slice(-MAX_LOG) : [];           // { at, style, total, winners:[{uid,nick}] }
    this.streamSince = null; // set when OBS starts streaming (skipPast 'stream')

    this.phase = 'idle';
    this.entrants = new Map(); // uid → { nick, sub, role, at, test }
    this.rejected = new Map(); // uid → 'subs' | 'past' | 'staff' (why a keyword didn't count)
    this.endsAt = 0;           // entry countdown (0 = none)
    this.chatEndsAt = 0;       // winners' chat countdown (0 = none)
    this.cur = null;           // the draw being staged (see draw())
    this.pool = [];            // eligible viewers of the last draw (for 다시 뽑기)
    this.entrantsAtDraw = 0;   // how many were in it
    this.winners = [];         // current winners [{ uid, nick }]
    this.chatLines = [];       // winners' lines this round (newest last)
    this.timers = { entry: null, chat: null, draw: null, state: null };
    this.test = false;         // a 테스트 추첨 is running: fake viewers only, real chat is ignored, nothing is remembered
    this.testTimers = [];

    this.ch = pack.channel(() => [
      ['state', this.view()],
      ...(this.phase === 'drawing' && this.cur ? [['draw', this.cur]] : []),
      ['chat-history', this.chatLines.slice(-6)],
    ]);
    chzzk.on('live-chat', (list) => { for (const m of list) if (m.kind === 'chat' && !m.hidden) this._onChat(m); });
  }

  get overlays() { return this.ch.size; }
  attach(req, res) { this.ch.attach(req, res); }
  streamStarted() { this.streamSince = Date.now(); }

  // ---------- settings ----------
  setSettings(input) {
    this.s = clean(input, this.s);
    this._save();
    this._changed();
    return this.s;
  }
  _save() { saveState('draw', { settings: this.s, past: this.past, log: this.log }); }

  // ---------- who may be in the pool ----------
  _pastSet() {
    if (this.s.skipPast === 'none') return new Set();
    const since = this.s.skipPast === 'stream' ? (this.streamSince ?? Date.now() - STREAM_FALLBACK_MS) : 0;
    return new Set(this.past.filter((p) => p.at >= since).map((p) => p.uid));
  }
  // why a viewer is out (null = eligible); checked when they enter AND again when the draw starts
  _why(e, uid, past = this._pastSet()) {
    if (isStaff(e.role)) return 'staff';
    if (this.s.subsOnly && !e.sub) return 'subs';
    if (past.has(uid)) return 'past';
    return null;
  }
  _eligible() {
    const past = this._pastSet();
    const out = [];
    for (const [uid, e] of this.entrants) if (!this._why(e, uid, past)) out.push({ uid, nick: e.nick, sub: !!e.sub });
    return out;
  }
  // mode 'recent': everyone who chatted within the last N minutes (Chzzk viewers only — YouTube lines have no uid)
  _recentPool() {
    const since = Date.now() - this.s.recentMin * 60000;
    const subs = new Set();
    for (const m of this.chzzk.chat) if (m.sub && m.uid) subs.add(m.uid);
    const past = this._pastSet();
    const out = [];
    for (const [uid, u] of this.chzzk.users) {
      const last = u.recent?.findLast?.((r) => r.kind === 'chat');
      if (!uid || !last || last.time < since) continue;
      const e = { nick: u.nick, role: u.role, sub: subs.has(uid) };
      if (!this._why(e, uid, past)) out.push({ uid, nick: u.nick || '이름 없음', sub: e.sub });
    }
    return out;
  }
  // the people a draw would pick from right now
  poolNow() { return this.s.mode === 'recent' && !this.test ? this._recentPool() : this._eligible(); }

  // ---------- chat in ----------
  _onChat(m) {
    if (!m.uid || this.test) return; // (a test run feeds its own fake lines; real viewers must not end up in it)
    if (this.phase === 'entry' && this.s.mode === 'keyword') {
      if (String(m.text || '').trim().split(/\s+/)[0] === this.s.keyword) this._enter(m);
    } else if (this.phase === 'winners') {
      const w = this.winners.find((x) => x.uid === m.uid);
      if (w) this._winnerLine(m, w);
    }
  }
  _enter(m) {
    const e = { nick: m.nick || '이름 없음', sub: !!m.sub, role: m.role || '', at: Date.now(), test: !!m.test };
    const why = this._why(e, m.uid);
    if (why) { if (!this.rejected.has(m.uid)) { this.rejected.set(m.uid, why); this._changed(); } return; }
    this.rejected.delete(m.uid);
    const had = this.entrants.get(m.uid);
    if (had) { if (had.nick !== e.nick) { had.nick = e.nick; this._changed(); } return; } // one entry per viewer
    if (this.entrants.size >= MAX_ENTRANTS) return;
    this.entrants.set(m.uid, e);
    this._changed();
  }
  _winnerLine(m, w) {
    const line = { uid: m.uid, nick: w.nick, text: String(m.text || '').slice(0, 200), emojis: m.emojis || {}, time: m.time || Date.now() };
    this.chatLines.push(line);
    if (this.chatLines.length > 30) this.chatLines.shift();
    this.ch.send('chat', line);
    if (m.id != null) { m.drawWinner = true; this.chzzk.emit('chat-update', m); } // highlighted in the dashboard chat
    else if (this.test) { // a test line shows (highlighted) in the dashboard chat only — not in reports or recording logs
      this.chzzk.addExternal([{ key: `test:${Date.now()}:${w.uid}`, id: 0, platform: 'chzzk', time: Date.now(), uid: '', nick: `테스트 · ${w.nick}`, role: '', member: false, verified: false, sub: null, badges: [], text: line.text, emojis: {}, kind: 'chat', amount: null, donationType: null, months: null, drawWinner: true }]);
    }
    this._say('chat', w.nick, speakable(m.text, this.s.tts.maxLen));
    this._changed(false);
  }

  // ---------- entry window ----------
  // sec: undefined = the saved length, 0 = until 마감
  open(sec) {
    if (this.s.mode === 'recent' && !this.test) throw new Error('"최근 채팅" 방식은 참여를 열 필요가 없어요 — 바로 뽑으면 돼요');
    if (this.phase === 'drawing' || this.phase === 'winners') throw new Error('지금 추첨이 진행 중이에요 — 끝내기를 먼저 눌러 주세요');
    const len = sec === undefined || sec === null ? this.s.entrySec : Math.round(num(sec, 0, 3600, 0));
    if (this.phase === 'idle') { this.entrants.clear(); this.rejected.clear(); } // reopening (마감된 참여) or changing the time of an open one keeps the people
    this._clearTimers();
    this.phase = 'entry';
    this.endsAt = len ? Date.now() + len * 1000 : 0;
    this._armEntry();
    this._notice(`🎟 추첨 참여: 채팅에 ${this.s.keyword}${len ? ` (${len >= 60 ? `${Math.round(len / 60 * 10) / 10}분` : `${len}초`} 동안)` : ''}`);
    this._changed();
  }
  _armEntry() {
    clearTimeout(this.timers.entry);
    if (this.phase === 'entry' && this.endsAt) this.timers.entry = setTimeout(() => this.close(true), Math.max(0, this.endsAt - Date.now()));
  }
  // 마감: entry stops, the people stay
  close(auto = false) {
    if (this.phase !== 'entry') throw new Error('참여를 받고 있지 않아요');
    clearTimeout(this.timers.entry);
    this.phase = 'ready';
    this.endsAt = 0;
    console.log(`[draw] 참여 ${auto ? '시간이 끝났어요' : '마감'} — ${this.entrants.size}명`);
    this._changed();
  }
  extend(sec = 30) {
    if (this.phase !== 'entry') throw new Error('참여를 받고 있을 때만 늘릴 수 있어요');
    const add = Math.round(num(sec, 5, 3600, 30)) * 1000;
    this.endsAt = Math.max(this.endsAt, Date.now()) + add;
    this._armEntry();
    this._changed();
  }
  remove(uid) {
    if (this.phase !== 'entry' && this.phase !== 'ready') throw new Error('참가자 목록은 참여를 받는 동안만 고칠 수 있어요');
    this.entrants.delete(String(uid));
    this._changed();
  }
  // test viewers (for trying the overlay and the draw without chat)
  testFill(n = 10) {
    if (this.phase !== 'entry' && this.phase !== 'ready') throw new Error('참여를 먼저 열어 주세요');
    const k = Math.round(num(n, 1, 200, 10));
    const base = [...this.entrants.keys()].filter((u) => u.startsWith('test:')).length;
    for (let i = 1; i <= k && this.entrants.size < MAX_ENTRANTS; i++) {
      const id = base + i;
      this.entrants.set(`test:${id}`, { nick: `테스트${String(id).padStart(2, '0')}`, sub: id % 3 === 0, role: '', at: Date.now(), test: true });
    }
    this._changed();
  }

  // ---------- the draw ----------
  draw() {
    if (this.phase === 'drawing' || this.phase === 'winners') throw new Error('지금 추첨이 진행 중이에요 — 끝내기를 먼저 눌러 주세요');
    if (this.phase === 'idle' && this.s.mode !== 'recent') throw new Error('먼저 "참여 열기"를 눌러 주세요');
    if (this.phase === 'entry') { clearTimeout(this.timers.entry); this.endsAt = 0; }
    const pool = this.poolNow();
    if (!pool.length) throw new Error('뽑을 참가자가 없어요 — 필터에 걸린 사람은 빠져요');
    const winners = pickN(pool, this.s.winners).map(({ uid, nick }) => ({ uid, nick }));
    this.pool = pool;
    this.entrantsAtDraw = pool.length;
    this.winners = [];
    this.chatLines = [];
    this._stage({ kind: 'draw', winners, others: pool.filter((p) => !winners.some((w) => w.uid === p.uid)), total: pool.length, show: ANIM_MAX });
    this.past.push(...winners.map((w) => ({ uid: w.uid, nick: w.nick, at: Date.now() })).filter((w) => !w.uid.startsWith('test:')));
    if (this.past.length > MAX_PAST) this.past.splice(0, this.past.length - MAX_PAST);
    if (!this.test) { // a test leaves no trace in the history
      this.log.push({ at: Date.now(), style: this.s.style, total: pool.length, winners });
      if (this.log.length > MAX_LOG) this.log.shift();
    }
    this._save();
    console.log(`[draw] ${this.s.style} 추첨 — ${pool.length}명 중 ${winners.map((w) => w.nick).join(', ')}`);
  }

  // a winner doesn't answer: one more from everyone who is left (same style, a short staging)
  redraw(uid) {
    if (this.phase !== 'winners') throw new Error('당첨자가 나온 뒤에만 다시 뽑을 수 있어요');
    const old = this.winners.find((w) => w.uid === String(uid));
    if (!old) throw new Error('그 당첨자를 찾을 수 없어요');
    this.passed = (this.passed || new Set()).add(old.uid);
    const taken = new Set([...this.winners.map((w) => w.uid), ...this.passed]);
    const rest = this.pool.filter((p) => !taken.has(p.uid));
    if (!rest.length) throw new Error('더 뽑을 참가자가 없어요');
    const [nw] = pickN(rest, 1);
    this.winners = this.winners.filter((w) => w.uid !== old.uid); // its chat is no longer read
    clearTimeout(this.timers.chat);
    this.chatEndsAt = 0;
    this._stage({ kind: 'redraw', replaces: old.uid, winners: [{ uid: nw.uid, nick: nw.nick }], others: rest.filter((p) => p.uid !== nw.uid), total: rest.length, show: REDRAW_SHOW });
    if (!nw.uid.startsWith('test:')) { this.past.push({ uid: nw.uid, nick: nw.nick, at: Date.now() }); this._save(); }
    const entry = this.log.at(-1), at = entry ? entry.winners.findIndex((w) => w.uid === old.uid) : -1;
    if (at >= 0) entry.winners[at] = { uid: nw.uid, nick: nw.nick };
    console.log(`[draw] 다시 뽑기 — ${old.nick} → ${nw.nick}`);
  }

  // Everything the overlay needs to play a draw: who won (already decided), a seed for the staging, and the names
  // it may show (the winners plus a random sample of the others, at most `show`).
  _stage({ kind, replaces = null, winners, others, total, show }) {
    const sample = pickN(others, Math.max(0, show - winners.length));
    const names = pickN([...winners, ...sample], winners.length + sample.length).map((p) => ({ u: p.uid, n: p.nick }));
    this.cur = {
      id: crypto.randomBytes(5).toString('hex'), seed: crypto.randomInt(1, 2 ** 31), style: this.s.style, kind, replaces,
      w: winners.length, winners, names, total, startedAt: Date.now(),
    };
    this.phase = 'drawing';
    this.endsAt = 0;
    clearTimeout(this.timers.draw);
    this.timers.draw = setTimeout(() => this._afterDraw(), DRAW_TIMEOUT_MS);
    this._changed();
    if (this.ch.size) this.ch.send('draw', this.cur);
    else { console.log('[draw] 오버레이가 연결돼 있지 않아서 연출 없이 결과만 보여요'); this._afterDraw(); }
  }

  // the overlay finished the staging (POST /api/draw/shown)
  shown(id) {
    if (this.phase === 'drawing' && this.cur && this.cur.id === String(id)) this._afterDraw();
  }
  // 연출 건너뛰기: the panel's way out when the overlay never reports back
  skip() {
    if (this.phase !== 'drawing') throw new Error('연출 중이 아니에요');
    this._afterDraw();
    this.ch.send('skip', {}); // the overlay drops the staging and shows the result at once
  }
  _afterDraw() {
    if (this.phase !== 'drawing' || !this.cur) return;
    clearTimeout(this.timers.draw);
    const fresh = this.cur.winners;
    this.winners = [...this.winners, ...fresh];
    this.phase = 'winners';
    this.chatEndsAt = this.s.chatSec ? Date.now() + this.s.chatSec * 1000 : 0;
    clearTimeout(this.timers.chat);
    if (this.chatEndsAt) this.timers.chat = setTimeout(() => this.end(), this.s.chatSec * 1000);
    const names = fresh.map((w) => w.nick);
    if (this.s.tts.on && this.s.tts.announce) this._say('announce', names[0], `${names.join(', ')}님 당첨!`);
    this._notice(`🎉 당첨: ${names.join(', ')}님 축하해요!`);
    if (this.test) this._testWinnerLines(fresh);
    this._changed();
  }

  // 끝내기: the winners' chat window closes
  end() {
    if (this.phase !== 'winners') throw new Error('당첨자 화면이 아니에요');
    this._toIdle();
  }
  // 취소 / 처음으로: from any phase
  reset() { this._toIdle(); }
  _toIdle() {
    this._clearTimers();
    this._stopTest();
    const was = this.phase;
    this.phase = 'idle';
    this.entrants.clear(); this.rejected.clear();
    this.endsAt = 0; this.chatEndsAt = 0;
    this.cur = null; this.pool = []; this.winners = []; this.passed = null; this.entrantsAtDraw = 0;
    if (was !== 'idle') this.ch.send('end', {});
    this._changed();
  }
  clearPast() { this.past = []; this._save(); this._changed(); }

  // ---------- speech ----------
  _say(kind, nick, text) {
    if (!this.s.tts.on || !text || !this.ch.size) return; // nobody to hear it: don't spend a PowerShell spawn
    this.tts.synth(text, this.s.tts.voice)
      .then((r) => this.ch.send('tts', { ...r, kind, nick, text, volume: this.s.tts.volume }))
      .catch((e) => { console.log(`[draw] 음성 실패: ${e.message}`); this.emit('tts-error', e.message); });
  }
  // the panel's test button: the overlay plays it when one is open, otherwise the panel does
  async ttsTest(text) {
    const t = speakable(text || '안녕하세요, 호시아 방송에 오신 걸 환영해요!', this.s.tts.maxLen);
    if (!t) throw new Error('읽을 수 있는 글자가 없어요');
    const r = await this.tts.synth(t, this.s.tts.voice);
    const overlay = this.ch.size > 0;
    if (overlay) this.ch.send('tts', { ...r, kind: 'test', nick: '테스트', text: t, volume: this.s.tts.volume });
    return { ...r, text: t, overlay, real: this.tts.real, volume: this.s.tts.volume };
  }
  // as if the first winner had typed this (to try the radio feed and the voice without a real viewer)
  testChat(text) {
    if (this.phase !== 'winners' || !this.winners.length) throw new Error('당첨자가 나온 뒤에 쓸 수 있어요');
    this._winnerLine({ uid: this.winners[0].uid, text: String(text || '당첨됐어요! 감사합니다 {:d_2:}'), emojis: {}, time: Date.now() }, this.winners[0]);
  }

  // ---------- 테스트 추첨: the whole flow with fake viewers ----------
  // entry (a short countdown, viewers trickling in — some subscribers, a streamer and a double entry that get filtered
  // like real ones) → draw after the entry closes → the winners "type" a few lines (radio, voice, dashboard highlight).
  // Everything goes through the same code as real chat; nothing is remembered afterwards (no past winners, no log),
  // nothing is sent to Chzzk, and real chat lines are ignored while it runs.
  runTest(n = 30) {
    if (this.phase !== 'idle') throw new Error('지금 진행 중인 추첨이 있어요 — 끝내기나 취소를 먼저 눌러 주세요');
    const count = Math.round(num(n, 3, 200, 30));
    const secs = 12;
    this.test = true;
    this.open(secs);
    const spread = 8000;
    for (let i = 0; i < count; i++) {
      this._testAfter(400 + (spread * i) / count, () => this._enter({ uid: `test:${i + 1}`, nick: testNick(i), sub: i % 3 === 2, role: '', test: true }));
    }
    this._testAfter(2500, () => this._enter({ uid: 'test:staff', nick: '방송인(테스트)', sub: true, role: 'streamer', test: true })); // filtered: staff
    this._testAfter(3500, () => this._enter({ uid: 'test:1', nick: testNick(0), sub: false, role: '', test: true }));               // filtered: second entry
    // when the countdown has run out the entry closes by itself; then the draw starts
    this._testAfter(secs * 1000 + 2200, () => { if (this.phase === 'ready') { try { this.draw(); } catch (e) { console.log(`[draw] 테스트: ${e.message}`); } } });
    console.log(`[draw] 테스트 추첨 시작 — 가짜 시청자 ${count}명`);
  }
  _testWinnerLines(fresh) {
    if (!fresh.length) return;
    TEST_LINES.slice(0, 3).forEach((text, i) => {
      const w = fresh[i % fresh.length];
      this._testAfter(2800 + i * 6500, () => { if (this.phase === 'winners' && this.winners.some((x) => x.uid === w.uid)) this._winnerLine({ uid: w.uid, text, emojis: {}, time: Date.now(), test: true }, w); });
    });
  }
  _testAfter(ms, fn) {
    const t = setTimeout(() => { this.testTimers = this.testTimers.filter((x) => x !== t); if (this.test) fn(); }, ms);
    this.testTimers.push(t);
  }
  _stopTest() {
    for (const t of this.testTimers) clearTimeout(t);
    this.testTimers = [];
    this.test = false;
  }

  // ---------- chat notice (off by default) ----------
  _notice(text) {
    if (this.test || !this.s.notice || !(this.chzzkOpen?.configured() && this.chzzkOpen.loggedIn())) return;
    this.chzzkOpen.sendChat(text).catch((e) => console.log(`[draw] 채팅 알림을 못 보냈어요: ${e.message}`));
  }

  // ---------- what others see ----------
  _clearTimers() { for (const k of ['entry', 'chat', 'draw']) clearTimeout(this.timers[k]); }
  _changed(save = false) {
    if (save) this._save();
    if (this.timers.state) return;
    this.timers.state = setTimeout(() => { // bursts of entries become one update
      this.timers.state = null;
      this.ch.send('state', this.view());
      this.emit('change');
    }, 150);
  }
  // for the overlay
  view() {
    const last = [...this.entrants.values()].slice(-6).map((e) => e.nick);
    return {
      phase: this.phase, now: Date.now(), endsAt: this.endsAt, chatEndsAt: this.chatEndsAt,
      count: this.phase === 'drawing' || this.phase === 'winners' ? (this.entrantsAtDraw ?? 0) : this.entrants.size,
      last, mode: this.s.mode, keyword: this.s.keyword, recentMin: this.s.recentMin, style: this.s.style,
      winners: this.winners, drawId: this.cur?.id || null, tts: { on: this.s.tts.on, volume: this.s.tts.volume }, test: this.test,
    };
  }
  // for the Xylem panel
  status() {
    const eligible = this.phase === 'entry' || this.phase === 'ready' ? this._eligible().length : this.s.mode === 'recent' ? this._recentPool().length : 0;
    const why = { subs: 0, past: 0, staff: 0 };
    for (const r of this.rejected.values()) why[r]++;
    const past = this._pastSet();
    return {
      ...this.view(),
      settings: this.s,
      overlays: this.ch.size,
      eligible,
      entrants: [...this.entrants].slice(-400).map(([uid, e]) => ({ uid, nick: e.nick, sub: !!e.sub, test: !!e.test, out: this._why(e, uid, past) })),
      rejected: why,
      pastCount: this.past.length,
      past: this.past.slice(-30).reverse(),
      log: this.log.slice(-10).reverse(),
      chatLines: this.chatLines.slice(-12),
      winnerList: this.winners,
      canChat: !!(this.chzzkOpen?.configured() && this.chzzkOpen.loggedIn()),
      tts: { ...this.s.tts, real: this.tts.real, waiting: this.tts.waiting },
    };
  }
}
