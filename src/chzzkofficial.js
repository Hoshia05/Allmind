// Chat, 후원 and 구독 through CHZZK's OFFICIAL Open API Session (docs/plans/chzzk-official.md, docs read 2026-11-25).
//   GET  /open/v1/sessions/auth                          -> { url }   (user token; max 3 connections per user)
//   Socket.IO to that url                                -> SYSTEM {type: connected, data: {sessionKey}}
//   POST /open/v1/sessions/events/subscribe/{chat|donation|subscription}?sessionKey=...   (scopes 채팅 메시지 조회 / 후원 조회 / 구독 조회)
//   events CHAT, DONATION, SUBSCRIPTION (+ SYSTEM subscribed / unsubscribed / revoked)
// Events are mapped into the SAME internal message shape src/chzzk.js has always used (field with no official source = null / empty,
// never invented): see the mappers below and docs/plans/chzzk-official.md section 2.
import { EventEmitter } from 'node:events';
import { SioClient } from './socketio.js';

export const SCOPES = {
  chat: '채팅 메시지 조회',
  donation: '후원 조회',
  subscription: '구독 조회',
  send: '채팅 메시지 쓰기',
  notice: '채팅 공지 쓰기',
  restrictRead: '활동제한 조회',
  restrictWrite: '활동제한 쓰기',
  subscribers: '채널 구독자 조회',
  me: '유저 정보 조회',
  settingRead: '방송 설정 조회',
  settingWrite: '방송 설정 변경',
};
/** Every scope Allmind asks for in the CHZZK Developers app (the 점검 line lists the missing ones). */
export const ALL_SCOPES = Object.values(SCOPES);

const ROLE = {
  streamer: 'streamer',
  streaming_channel_manager: 'manager',
  streaming_chat_manager: 'manager',
};

const str = (v) => (v == null ? '' : String(v));
const emojisOf = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? m : {});

/** CHAT event -> internal chat message (no id: src/chzzk.js assigns it). `subOf(uid)` -> { months, tier, img } | null */
export function mapChat(d, subOf = () => null) {
  const profile = d?.profile && typeof d.profile === 'object' ? d.profile : {};
  const time = Number(d?.messageTime) || Date.now();
  const uid = str(d?.senderChannelId);
  const text = str(d?.content);
  const badges = (Array.isArray(profile.badges) ? profile.badges : [])
    .map((b) => (typeof b === 'string' ? b : b?.imageUrl || b?.image || b?.url || ''))
    .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  return {
    key: `${time}:${uid}:${text.slice(0, 20)}`,
    platform: 'chzzk',
    time,
    uid,
    nick: str(profile.nickname),
    role: ROLE[d?.userRoleCode] || '',
    sub: subOf(uid) || null,
    verified: profile.verifiedMark === true,
    badges: [...new Set(badges)].slice(0, 4),
    text,
    emojis: emojisOf(d?.emojis),
    kind: 'chat',
    amount: null,
    donationType: null,
    months: null,
    chatChannelId: str(d?.chatChannelId) || null,
    official: true,
  };
}

/** DONATION event -> internal 후원 message. The official event has no time field: receive time. */
export function mapDonation(d, now = Date.now()) {
  const uid = str(d?.donatorChannelId);
  const text = str(d?.donationText);
  const amount = Number(d?.payAmount);
  return {
    key: `${now}:${uid}:${text.slice(0, 20)}`,
    platform: 'chzzk',
    time: now,
    uid,
    nick: str(d?.donatorNickname) || '익명',
    role: '',
    sub: null,
    verified: false,
    badges: [],
    text,
    emojis: emojisOf(d?.emojis),
    kind: 'donation',
    amount: Number.isFinite(amount) ? amount : null,
    donationType: str(d?.donationType) || null, // CHAT | VIDEO (the official API has no MISSION)
    months: null,
    official: true,
  };
}

/** SUBSCRIPTION event -> internal 구독 message (no text in the official event: generated). */
export function mapSubscription(d, now = Date.now()) {
  const uid = str(d?.subscriberChannelId);
  const month = Number(d?.month);
  const tier = Number(d?.tierNo);
  const label = [str(d?.tierName) || '구독', tier > 0 ? `티어${tier}` : ''].filter(Boolean).join(' ');
  const text = `${label}${Number.isFinite(month) && month > 0 ? ` · ${month}개월` : ''}`;
  return {
    key: `${now}:${uid}:${text.slice(0, 20)}`,
    platform: 'chzzk',
    time: now,
    uid,
    nick: str(d?.subscriberNickname),
    role: '',
    sub: Number.isFinite(month) && month > 0 ? { months: month, tier: tier > 0 ? tier : 1, img: '' } : null,
    verified: false,
    badges: [],
    text,
    emojis: {},
    kind: 'subscription',
    amount: null,
    donationType: null,
    months: Number.isFinite(month) ? month : null,
    official: true,
  };
}

/** Who is a subscriber (channels/subscribers list + 구독 events), so chat lines can carry `sub` like before. */
export class SubscriberIndex {
  constructor() { this.map = new Map(); this.loadedAt = 0; this.ok = false; }
  get(uid) { return this.map.get(uid) || null; }
  set(uid, months, tier) { if (uid) this.map.set(uid, { months: Number(months) || 0, tier: Number(tier) || 1, img: '' }); }
  replace(list) {
    const next = new Map();
    for (const s of list) if (s?.channelId) next.set(String(s.channelId), { months: Number(s.month) || 0, tier: Number(s.tierNo) || 1, img: '' });
    this.map = next;
    this.loadedAt = Date.now();
    this.ok = true;
  }
  get size() { return this.map.size; }
}

const delay = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export class ChzzkSession extends EventEmitter {
  /**
   * @param {{ open: import('./chzzkopen.js').ChzzkOpen, log?: Function, SioImpl?: typeof SioClient, rollMarginMs?: number,
   *           subscriberEveryMs?: number, backoffMs?: number[] }} opts
   */
  constructor({ open, log = console.log, SioImpl = SioClient, rollMarginMs = 5 * 60000, subscriberEveryMs = 5 * 60000, minRollWaitMs = 30000, backoffMs = [1000, 2000, 4000, 8000, 15000, 30000, 60000] }) {
    super();
    this.open = open;
    this.log = log;
    this.Sio = SioImpl;
    this.rollMarginMs = rollMarginMs;
    this.subscriberEveryMs = subscriberEveryMs;
    this.minRollWaitMs = minRollWaitMs;
    this.backoffMs = backoffMs;
    this.subs = new SubscriberIndex();
    this.active = null; // { sio, sessionKey, events:Set }  — the only session whose events are accepted
    this.pending = null;
    this.running = false;
    this.state = 'idle'; // idle | connecting | connected | error | revoked
    this.error = null;
    this.missing = new Set(); // scope names the API refused (403)
    this.attempt = 0;
    this.timers = new Set();
    this.channelId = '';
    this.sessionsCreated = 0;
    this.me = null;
  }

  /** True when the official path can carry chat: logged in, not revoked, the chat scope not refused. */
  usable() {
    return this.open.loggedIn() && this.state !== 'revoked' && !this.missing.has(SCOPES.chat);
  }

  status() {
    return { state: this.state, error: this.error, missing: [...this.missing], subscribers: this.subs.size, sessions: this.sessionsCreated, channelId: this.channelId };
  }

  /** A new login (Open API) clears "revoked" and the scopes that were refused: the owner may have ticked more of them. */
  noteLogin() {
    const at = this.open.auth?.loginAt || 0;
    if (at === this.loginAt) return;
    this.loginAt = at;
    this.missing.clear();
    this.attempt = 0;
    if (this.state === 'revoked') { this.state = 'idle'; this.error = null; }
    this.emit('change');
  }

  /** The dashboard's 🔄: drop the active session, the loop opens a new one. */
  reconnect() { this.active?.sio.close(); }

  start() {
    if (this.running) return;
    this.running = true;
    this._connectLoop();
  }

  stop() {
    this.running = false;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
    for (const s of [this.active, this.pending]) s?.sio.close();
    this.active = null;
    this.pending = null;
    this.state = 'idle';
  }

  _timer(fn, ms, every = false) {
    const t = every ? setInterval(fn, ms) : setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  async _connectLoop() {
    while (this.running) {
      this.noteLogin();
      if (!this.open.loggedIn()) { this.state = 'idle'; this.error = null; await delay(5000); continue; }
      if (this.state === 'revoked') { await delay(1000); continue; }
      this.state = 'connecting';
      this.emit('change');
      try {
        const s = await this._open();
        this.active = s;
        this.attempt = 0;
        this.state = 'connected';
        this.error = null;
        this.log(`[chzzk-session] connected (events: ${[...s.events].join(',')})`);
        this.emit('change');
        this._afterConnect();
        await new Promise((resolve) => { s.onEnd = resolve; });
      } catch (e) {
        this.error = e.message;
        this.state = 'error';
        this.emit('change');
        this.log(`[chzzk-session] ${e.message}`);
      }
      this.active = null;
      if (!this.running) return;
      if (this.state === 'revoked') continue;
      const wait = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
      this.attempt += 1;
      if (this.state === 'connected') { this.state = 'connecting'; this.emit('change'); }
      await delay(wait);
    }
  }

  /** Create a session, wait for `connected`, subscribe. Resolves to the session record; rejects with a readable message. */
  async _open() {
    let url;
    try {
      url = (await this.open.api('GET', '/open/v1/sessions/auth'))?.url;
    } catch (e) {
      if (e.status === 403) this._missing(SCOPES.chat, e);
      throw new Error(`세션을 만들지 못했어요: ${e.message}`);
    }
    if (!url) throw new Error('세션 주소를 받지 못했어요');
    this.sessionsCreated += 1;
    const sio = new this.Sio(url);
    const rec = { sio, sessionKey: '', events: new Set(), onEnd: null };
    sio.on('error', () => {}); // the close handler deals with it
    sio.on('close', () => {
      if (this.pending === rec) this.pending = null;
      if (this.active === rec) { this.log('[chzzk-session] connection closed'); rec.onEnd?.(); }
    });
    sio.on('event', (name, data) => this._event(rec, name, data));
    let keyTimer = null;
    const keyed = new Promise((resolve, reject) => {
      // whichever comes first (key, close, timeout) also clears the 10 s timer
      const settle = (fn) => (v) => { clearTimeout(keyTimer); fn(v); };
      rec.gotKey = settle(resolve);
      rec.failKey = settle(reject);
      sio.on('close', () => rec.failKey(new Error('연결이 끊어졌어요')));
      keyTimer = setTimeout(() => reject(new Error('세션 연결 응답이 없어요')), 10000);
      keyTimer.unref?.();
    });
    this.pending = rec;
    sio.connect();
    try {
      await keyed;
      for (const kind of ['chat', 'donation', 'subscription']) {
        try {
          await this.open.api('POST', `/open/v1/sessions/events/subscribe/${kind}`, undefined, { query: { sessionKey: rec.sessionKey } });
          rec.events.add(kind);
        } catch (e) {
          if (e.status === 403) this._missing(SCOPES[kind], e);
          else throw new Error(`${kind} 이벤트를 구독하지 못했어요: ${e.message}`);
        }
      }
      if (!rec.events.has('chat')) throw new Error(`치지직 앱에 "${SCOPES.chat}" 권한이 없어요`);
    } catch (e) {
      sio.close();
      if (this.pending === rec) this.pending = null;
      throw e;
    }
    this.pending = null;
    return rec;
  }

  _missing(scope, e) {
    if (!this.missing.has(scope)) this.log(`[chzzk-session] 403: missing scope "${scope}"`);
    this.missing.add(scope);
    this.emit('change');
  }

  _event(rec, name, data) {
    if (name === 'SYSTEM') {
      const t = data?.type;
      if (t === 'connected') { rec.sessionKey = str(data?.data?.sessionKey); if (rec.sessionKey) rec.gotKey?.(); }
      else if (t === 'revoked') {
        this.log(`[chzzk-session] permission revoked (${data?.data?.eventType || '?'}): log in again`);
        this.state = 'revoked';
        this.error = '치지직 권한이 회수됐어요 — 설정 창에서 다시 로그인해 주세요';
        this.emit('change');
        rec.sio.close();
      }
      return;
    }
    if (rec !== this.active) return; // a not-yet-active (rolling) or old session: only the active one counts, so nothing is duplicated
    if (name === 'CHAT') this.emit('messages', [mapChat(data, (uid) => this.subs.get(uid))]);
    else if (name === 'DONATION') this.emit('messages', [mapDonation(data)]);
    else if (name === 'SUBSCRIPTION') {
      const m = mapSubscription(data);
      if (m.uid && m.sub) this.subs.set(m.uid, m.sub.months, m.sub.tier);
      this.emit('messages', [m]);
      this._timer(() => this.refreshSubscribers().catch(() => {}), 10000);
    }
  }

  /** After a successful connect: who am I, the subscriber list, and the token roll-over timer. */
  _afterConnect() {
    this.checkMe().catch(() => {});
    this.refreshSubscribers().catch(() => {});
    if (!this.subTimer) this.subTimer = this._timer(() => this.refreshSubscribers().catch(() => {}), this.subscriberEveryMs, true);
    this._scheduleRoll();
  }

  _scheduleRoll() {
    clearTimeout(this.rollTimer);
    const exp = this.open.auth?.expiresAt || 0;
    const wait = Math.max(this.minRollWaitMs, exp - Date.now() - this.rollMarginMs);
    this.rollTimer = this._timer(() => this.roll().catch((e) => {
      this.log(`[chzzk-session] roll-over failed: ${e.message} (trying again)`);
      // try again (at least minRollWaitMs later); if the token runs out first, the session closes and the loop reconnects
      if (this.running && this.active) this._scheduleRoll();
    }), wait);
  }

  /** Before the access token expires: refresh it, open the NEXT session, switch events to it, then close the old one. */
  async roll() {
    if (!this.running || !this.active) return;
    await this.open.accessToken(true); // single-use refresh token: one refresh at a time (chzzkopen handles that)
    const next = await this._open();
    const old = this.active;
    this.active = next;
    next.onEnd = old.onEnd;
    old.onEnd = null; // the loop keeps waiting on the new session
    old.sio.close();
    this.log('[chzzk-session] rolled over to a new session before the token expired');
    this.emit('change');
    this._scheduleRoll();
  }

  async checkMe() {
    try {
      this.me = await this.open.api('GET', '/open/v1/users/me');
      this.channelId = str(this.me?.channelId);
      this.emit('change');
    } catch (e) {
      if (e.status === 403) this._missing(SCOPES.me, e);
    }
  }

  async refreshSubscribers() {
    if (!this.open.loggedIn() || this.missing.has(SCOPES.subscribers)) return;
    const all = [];
    try {
      for (let page = 0; page < 40; page++) {
        const c = await this.open.api('GET', '/open/v1/channels/subscribers', undefined, { query: { page, size: 50, sort: 'RECENT' } });
        const data = Array.isArray(c?.data) ? c.data : [];
        all.push(...data);
        if (data.length < 50) break;
      }
    } catch (e) {
      if (e.status === 403) this._missing(SCOPES.subscribers, e);
      return;
    }
    this.subs.replace(all);
    this.emit('change');
  }
}
