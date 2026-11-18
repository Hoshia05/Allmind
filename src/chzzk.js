// Chzzk live stats + chat (read-only).
// Uses the same public endpoints the chzzk.naver.com website uses. They're
// unofficial, so Naver can change them; everything here fails soft.
// The dashboard chat list is shared with YouTube chat (ytchat.js → addExternal).
import { EventEmitter } from 'node:events';
import { loadState, saveState } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CMD = { PING: 0, PONG: 10000, CONNECT: 100, CONNECTED: 10100, RECENT: 5101, RECENT_RESULT: 15101, CHAT: 93101, SPECIAL: 93102, BLIND: 94008 };

// Accepts a bare channel ID or any chzzk URL containing one.
export function parseChannelId(input) {
  const m = /([0-9a-f]{32})/i.exec(String(input || ''));
  return m ? m[1].toLowerCase() : null;
}

function safeJson(s) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export class Chzzk extends EventEmitter {
  constructor(config) {
    super();
    this.cfg = config.chzzk;
    const saved = loadState('chzzk', {});
    this.channelId = parseChannelId(saved.channelId || this.cfg.channelId);
    this.live = null; // latest live-detail summary
    this.liveError = null;
    this.peak = { openDate: null, count: 0 };
    this.history = []; // viewer count samples [{t, n}]

    this.chat = []; // ring buffer of normalized messages
    // Per-viewer notes for the nickname popup: what Allmind has seen since it started (memory only).
    this.users = new Map(); // uid -> { nick, role, firstSeen, lastSeen, chats, recent: [...] }
    // 후원/구독 for the current broadcast, kept separately (chat scrolls away)
    // and saved, so a Allmind restart mid-stream doesn't lose them.
    const savedDon = loadState('donations', {});
    this.donations = savedDon.list || [];
    this.donationSession = savedDon.session || null;
    this.readKeys = new Set(savedDon.read || []);
    this.chatState = 'idle'; // idle | connecting | connected | error
    this.chatError = null;
    this.chatChannelId = null;
    this.ws = null;
    this.seq = 0;
    // chat watchdog: a socket can die without a close event (sleep, Wi-Fi blip, server side) and then looks
    // "connected" forever with nothing coming in — anything at all from the server (chat, its PING, our PONG) resets this
    this.lastMsgAt = 0;
    this.connectAt = 0;
    this.chatCount = 0;
    this.unknownCmds = new Set();
    this.badMsgLogged = false;

    this._poll();
    setInterval(() => this._poll(), Math.max(5, this.cfg.pollSeconds) * 1000);
    setInterval(() => this._ping(), 20000);
  }

  // ---------------- channel ----------------
  setChannel(input) {
    const id = parseChannelId(input);
    if (!id) throw new Error('치지직 채널 주소나 채널 ID를 찾을 수 없어요 (32자리 영문+숫자)');
    this.channelId = id;
    saveState('chzzk', { channelId: id });
    this.live = null;
    this.history = [];
    this.chat = [];
    this.emit('chat-reset');
    this.clearDonations();
    this._disconnectChat();
    this._poll();
  }

  async _get(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.code && j.code !== 200) throw new Error(j.message || `code ${j.code}`);
    return j.content;
  }

  async _poll() {
    if (!this.channelId) {
      this.liveError = null;
      this.emit('change');
      return;
    }
    try {
      const c = await this._get(`${this.cfg.apiBase}/service/v3/channels/${this.channelId}/live-detail`);
      if (!c) throw new Error('채널을 찾을 수 없어요 — 채널 ID를 확인해 주세요');
      const isLive = c.status === 'OPEN';
      // New broadcast → start a fresh 후원 list.
      if (isLive && c.openDate && c.openDate !== this.donationSession) {
        if (this.donationSession) {
          this.donations = [];
          this.readKeys.clear();
          this.emit('donations-reset');
        }
        this.donationSession = c.openDate;
        this._saveDonations();
        // a new broadcast: start a fresh chat connection too. Allmind often runs for days (2026-11-18: 5 days, several
        // network drops) and an old socket can look connected while nothing arrives.
        if (this.ws && c.chatChannelId === this.chatChannelId) this.reconnect('for the new broadcast');
      }
      const n = c.concurrentUserCount ?? 0;
      if (isLive) {
        if (this.peak.openDate !== c.openDate) this.peak = { openDate: c.openDate, count: 0 };
        this.peak.count = Math.max(this.peak.count, n);
        this.history.push({ t: Date.now(), n });
        if (this.history.length > 240) this.history.shift(); // ~1h at 15s
      }
      this.live = {
        isLive,
        title: c.liveTitle || '',
        viewers: n,
        total: c.accumulateCount ?? null,
        openDate: c.openDate || null,
        category: c.liveCategoryValue || '',
        channelName: c.channel?.channelName || '',
        peak: isLive ? this.peak.count : null,
      };
      this.liveError = null;
      if (c.chatChannelId && c.chatChannelId !== this.chatChannelId) this._connectChat(c.chatChannelId);
      if (!c.chatChannelId && !this.ws) {
        this.chatState = 'idle';
        this.chatError = '방송이 꺼져 있어서 채팅방이 없어요';
      }
    } catch (e) {
      this.liveError = `치지직 정보를 불러오지 못함: ${e.message}`;
    }
    this.emit('change');
  }

  // ---------------- chat ----------------
  _serverUrl(cid) {
    if (this.cfg.chatServer) return this.cfg.chatServer;
    let sum = 0;
    for (const ch of cid) sum += ch.charCodeAt(0);
    return `wss://kr-ss${(Math.abs(sum) % 9) + 1}.chat.naver.com/chat`;
  }

  _disconnectChat() {
    const old = this.ws;
    this.ws = null;
    this.chatChannelId = null;
    old?.close();
  }

  async _connectChat(cid) {
    this._disconnectChat();
    this.chatChannelId = cid;
    this.chatState = 'connecting';
    this.chatError = null;
    this.emit('change');

    let token = null;
    try {
      const c = await this._get(`${this.cfg.gameApiBase}/nng_main/v1/chats/access-token?channelId=${cid}&chatType=STREAMING`);
      token = c?.accessToken ?? null;
    } catch (e) {
      // Reading usually still works without a token; note it and carry on.
      this.chatError = `채팅 토큰을 받지 못함 (${e.message}) — 토큰 없이 시도`;
    }
    if (this.chatChannelId !== cid) return; // superseded while we waited

    const url = this._serverUrl(cid);
    console.log(`[chat] connecting to ${url} (channel ${cid.slice(0, 6)}…, token ${token ? 'yes' : 'no'})`);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.connectAt = Date.now();
    this.lastMsgAt = Date.now();
    this.chatCount = 0;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (this.ws !== ws) return;
      this.ws = null;
      console.log('[chat] connection closed — reconnecting in 5 s');
      this.chatState = 'error';
      this.chatError = '채팅 연결이 끊김 — 다시 연결 중…';
      this.emit('change');
      const again = this.chatChannelId;
      this.chatChannelId = null; // let the next poll (or this timer) reconnect
      setTimeout(() => { if (!this.ws && again && !this.chatChannelId) this._connectChat(again); }, 5000);
    };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ ver: '2', svcid: 'game', cid, cmd: CMD.CONNECT, tid: 1, bdy: { uid: null, devType: 2001, accTkn: token, auth: 'READ' } }));
    });
    ws.addEventListener('message', (ev) => this._onChat(ws, cid, safeJson(ev.data)));
    ws.addEventListener('error', end);
    ws.addEventListener('close', end);
  }

  // 채팅 다시 연결 (the chat dot): drop the socket and connect to the current chat room again
  reconnect(why = 'requested from the dashboard') {
    const cid = this.chatChannelId;
    console.log(`[chat] reconnect ${why}`);
    this._disconnectChat();
    if (cid) this._connectChat(cid);
    else this._poll();
    return { ok: true };
  }

  _ping() {
    // watchdog: nothing at all from the server for 70 s (or stuck connecting for 30 s) → start over
    const quiet = Date.now() - this.lastMsgAt;
    if (this.ws && ((this.chatState === 'connected' && quiet > 70000) || (this.chatState === 'connecting' && Date.now() - this.connectAt > 30000))) {
      console.log(`[chat] ${this.chatState === 'connected' ? `nothing from the chat server for ${Math.round(quiet / 1000)} s` : 'stuck connecting'} — reconnecting`);
      const cid = this.chatChannelId;
      this._disconnectChat();
      if (cid) this._connectChat(cid);
      return;
    }
    if (this.ws && this.chatState === 'connected') {
      try {
        this.ws.send(JSON.stringify({ ver: '2', cmd: CMD.PING }));
      } catch {
        /* close handler will deal with it */
      }
    }
  }

  // one bad or unexpected message must not drop the rest of a batch (and leave the list empty)
  _norm(list) {
    const out = [];
    for (const m of list) {
      try { const n = m && this._normalize(m); if (n) out.push(n); } catch (e) {
        if (!this.badMsgLogged) { this.badMsgLogged = true; console.error(`[chat] could not read a message (${e.message}); fields: ${Object.keys(m || {}).join(',')}`); }
      }
    }
    return out;
  }

  _onChat(ws, cid, msg) {
    if (!msg || this.ws !== ws) return;
    this.lastMsgAt = Date.now();
    switch (msg.cmd) {
      case CMD.PING:
        ws.send(JSON.stringify({ ver: '2', cmd: CMD.PONG }));
        break;
      case CMD.CONNECTED:
        this.chatState = 'connected';
        this.chatError = null;
        this.sid = msg.bdy?.sid;
        console.log(`[chat] connected${this.sid ? '' : ' (no session id in the answer)'}`);
        ws.send(JSON.stringify({ ver: '2', svcid: 'game', cid, sid: this.sid, cmd: CMD.RECENT, tid: 2, bdy: { recentMessageCount: 50 } }));
        this.emit('change');
        break;
      case CMD.RECENT_RESULT: {
        const raw = msg.bdy?.messageList || [];
        const list = this._norm(raw);
        console.log(`[chat] recent messages: ${list.length}${raw.length !== list.length ? ` of ${raw.length}` : ''}`);
        // Replace whatever we had: the server's recent list is the truth on (re)connect.
        const seen = new Set(this.chat.map((m) => m.key));
        const fresh = list.filter((m) => !seen.has(m.key));
        this._add(fresh);
        break;
      }
      case CMD.CHAT:
      case CMD.SPECIAL: {
        const arr = Array.isArray(msg.bdy) ? msg.bdy : [msg.bdy];
        const list = this._norm(arr);
        if (!this.chatCount && list.length) console.log('[chat] first live message received');
        this.chatCount += list.length;
        this._add(list);
        // Only these are "live" (the RECENT_RESULT history replayed on reconnect is not):
        // the recording log (markers.js) listens to this one.
        if (list.length) this.emit('live-chat', list);
        break;
      }
      case CMD.BLIND: {
        // A manager hid a message: grey it out here too.
        const b = msg.bdy || {};
        const t = b.messageTime ?? b.msgTime;
        const hit = this.chat.find((m) => m.time === t && (!b.userId || m.uid === b.userId));
        if (hit) {
          hit.hidden = true;
          this.emit('chat-update', hit);
        }
        break;
      }
      case CMD.PONG:
        break;
      default:
        if (!this.unknownCmds.has(msg.cmd)) { this.unknownCmds.add(msg.cmd); console.log(`[chat] unknown message type ${msg.cmd} (fields: ${Object.keys(msg).join(',')})`); }
    }
  }

  _normalize(m) {
    const profile = safeJson(m.profile) || {};
    const extras = safeJson(m.extras) || {};
    const type = m.msgTypeCode ?? m.messageTypeCode ?? 1;
    const time = m.msgTime ?? m.messageTime ?? Date.now();
    const uid = m.uid ?? m.userId ?? '';
    const text = String(m.msg ?? m.content ?? '');
    let kind = 'chat';
    if (type === 10) kind = 'donation';
    else if (type === 11 || type === 12) kind = 'subscription';
    else if (type === 30 || type === 121) kind = 'system';
    const role = profile.userRoleCode === 'streamer' ? 'streamer' : /manager/.test(profile.userRoleCode || '') ? 'manager' : '';
    // the badges Chzzk shows before a nickname: subscription (with its month count), then the channel's
    // viewer badges (후원 랭킹, events …), then activity badges the viewer picked
    const subP = profile.streamingProperty?.subscription;
    const sub = subP && (subP.accumulativeMonth || subP.badge?.imageUrl)
      ? { months: Number(subP.accumulativeMonth) || 0, tier: Number(subP.tier) || 1, img: subP.badge?.imageUrl || '' } : null;
    const badges = [
      profile.streamingProperty?.realTimeDonationRanking?.badge?.imageUrl, // 실시간 후원 랭킹
      ...(Array.isArray(profile.viewerBadges) ? profile.viewerBadges : []).map((v) => v?.badge?.imageUrl),
      ...(Array.isArray(profile.activityBadges) ? profile.activityBadges : []).filter((b) => b && b.activated !== false).map((b) => b.imageUrl),
    ].filter(Boolean);
    return {
      key: `${time}:${uid}:${text.slice(0, 20)}`,
      id: ++this.seq,
      platform: 'chzzk',
      time,
      uid,
      nick: String(profile.nickname || (kind === 'donation' ? '익명' : '')),
      role,
      sub,
      verified: profile.verifiedMark === true,
      badges: [...new Set(badges)].slice(0, 4),
      text,
      emojis: extras.emojis || {},
      kind,
      amount: extras.payAmount ?? null,
      donationType: extras.donationType || null, // CHAT | VIDEO | MISSION …
      months: extras.month ?? null,
    };
  }

  // 채팅 화면 지우기: every dashboard empties its chat list (viewer info and donations stay)
  clearChat() {
    this.chat = [];
    this.emit('chat-reset');
  }
  // a line in the chat list itself, e.g. "— 방송 시작 —" (dashboard only, not sent to Chzzk)
  note(text) {
    const m = { key: `note:${Date.now()}`, id: ++this.seq, time: Date.now(), uid: '', nick: '', role: '', badges: [], text: String(text), emojis: {}, kind: 'system', divider: true, amount: null, donationType: null, months: null };
    this.chat.push(m);
    const max = this.cfg.chatHistory || 300;
    if (this.chat.length > max) this.chat.splice(0, this.chat.length - max);
    this.emit('chat', [m]);
  }

  // chat from another platform (ytchat.js), already shaped like ours: shares the dashboard list, the
  // 🧹 and the history a new dashboard gets — but not Chzzk's viewer info, donations or the games
  addExternal(list) {
    if (!list.length) return;
    for (const m of list) m.id = ++this.seq;
    this.chat.push(...list);
    const max = this.cfg.chatHistory || 300;
    if (this.chat.length > max) this.chat.splice(0, this.chat.length - max);
    this.emit('chat', list);
  }

  _add(list) {
    if (!list.length) return;
    const fresh = list.filter((m) => (m.kind === 'donation' || m.kind === 'subscription') && !this.donations.some((d) => d.key === m.key));
    if (fresh.length) {
      this.donations.push(...fresh);
      if (this.donations.length > 1000) this.donations.splice(0, this.donations.length - 1000);
      this._saveDonations();
      this.emit('donations', fresh);
    }
    for (const m of list) this._noteUser(m);
    this.chat.push(...list);
    const max = this.cfg.chatHistory || 300;
    if (this.chat.length > max) this.chat.splice(0, this.chat.length - max);
    this.emit('chat', list);
  }

  _noteUser(m) {
    if (!m.uid || m.kind === 'system') return;
    let u = this.users.get(m.uid);
    if (!u) {
      if (this.users.size >= 5000) this.users.delete(this.users.keys().next().value); // oldest first
      u = { nick: m.nick, role: m.role, firstSeen: m.time, lastSeen: m.time, chats: 0, recent: [] };
      this.users.set(m.uid, u);
    }
    if (m.nick) u.nick = m.nick;
    u.role = m.role || u.role;
    u.firstSeen = Math.min(u.firstSeen, m.time);
    u.lastSeen = Math.max(u.lastSeen, m.time);
    if (m.kind === 'chat') u.chats++;
    u.recent.push({ time: m.time, kind: m.kind, text: String(m.text || '').slice(0, 300), amount: m.amount ?? null, donationType: m.donationType, months: m.months ?? null, emojis: m.emojis || {} });
    if (u.recent.length > 30) u.recent.shift();
  }

  // Everything Allmind knows about one viewer (nickname popup).
  userInfo(uid) {
    uid = String(uid || '');
    const u = this.users.get(uid);
    const dons = this.donations.filter((d) => d.uid === uid);
    const money = dons.filter((d) => d.kind === 'donation');
    const subs = dons.filter((d) => d.kind === 'subscription');
    const fromChat = this.chat.find((m) => m.uid === uid);
    if (!u && !dons.length && !fromChat) return { found: false, uid };
    return {
      found: true,
      uid,
      nick: u?.nick || dons.at(-1)?.nick || fromChat?.nick || '',
      role: u?.role || fromChat?.role || '',
      badges: fromChat?.badges || [],
      sub: [...this.chat].reverse().find((m) => m.uid === uid && m.sub)?.sub || null,
      firstSeen: u?.firstSeen ?? dons[0]?.time ?? null,
      lastSeen: u?.lastSeen ?? dons.at(-1)?.time ?? null,
      chats: u?.chats || 0,
      recent: (u?.recent || []).slice(-15).reverse(),
      donations: { count: money.length, total: money.reduce((a, d) => a + (Number(d.amount) || 0), 0) },
      subMonths: subs.reduce((a, d) => Math.max(a, Number(d.months) || 0), 0) || null,
      channelUrl: /^[0-9a-f]{32}$/i.test(uid) ? `https://chzzk.naver.com/${uid}` : null,
    };
  }

  _saveDonations() {
    saveState('donations', { session: this.donationSession, list: this.donations, read: [...this.readKeys] });
  }

  donationList() {
    return this.donations.map((d) => ({ ...d, read: this.readKeys.has(d.key) }));
  }

  markRead(key, read = true) {
    if (read) this.readKeys.add(key);
    else this.readKeys.delete(key);
    this._saveDonations();
    this.emit('donation-read', { key, read });
  }

  markAllRead() {
    for (const d of this.donations) this.readKeys.add(d.key);
    this._saveDonations();
    this.emit('donations-reset');
  }

  clearDonations() {
    this.donations = [];
    this.readKeys.clear();
    this._saveDonations();
    this.emit('donations-reset');
  }

  status() {
    return {
      channelId: this.channelId,
      live: this.live,
      error: this.liveError,
      history: this.history.slice(-60).map((h) => h.n),
      chat: { state: this.chatState, error: this.chatError },
    };
  }
}
