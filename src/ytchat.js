// YouTube live chat → the dashboard chat list (next to Chzzk's, marked as YouTube).
//
// Only while the YouTube broadcast Allmind watches (youtube.js) is live AND not private: a private
// archive has no viewers, so there is nothing to read and no quota is spent. Official Data API,
// liveChatMessages.list with the YouTube login Allmind already has. Every call costs quota (the
// project's daily 10,000 units are shared with the archive guard), so it polls no faster than
// config.youtube.chatPollSec (default 10 s), slows to 2× that while the chat is quiet, and stops
// for the day on quotaExceeded. (streamList would be cheaper but is gRPC only — too heavy here.)
// Dashboard only: YouTube viewers don't play the Xylem games, spin the roulette or land in reports.
import { EventEmitter } from 'node:events';

const ENDED = /liveChatEnded|liveChatDisabled|liveChatNotFound|forbidden/i;

export class YouTubeChat extends EventEmitter {
  constructor(google, youtube, config) {
    super();
    this.g = google;
    this.yt = youtube;
    this.config = config;
    this.chatId = '';   // the chat being read
    this.dead = '';     // a chat id YouTube said is closed/disabled: not retried
    this.token = '';
    this.timer = null;
    this.quiet = 0;     // polls in a row without new messages
    this.seen = new Set();
    this.st = { state: 'off', error: null, count: 0, calls: 0 };
    this.quotaDay = '';
    youtube.on('change', () => this._sync());
  }

  get cfg() { return this.config.youtube || {}; }
  status() { return { ...this.st, chatId: this.chatId || null }; }
  _set(p) {
    const before = JSON.stringify(this.st);
    Object.assign(this.st, p);
    if (JSON.stringify(this.st) !== before) this.emit('change');
  }

  // what youtube.js knows decides whether there is a chat worth reading
  _want() {
    const b = this.yt.b;
    if (this.cfg.chat === false || !this.yt.streaming || !b) return '';
    if (b.life !== 'live' || b.privacy === 'private' || !b.chatId) return '';
    if (this.quotaDay === new Date().toDateString()) return '';
    return b.chatId === this.dead ? '' : b.chatId;
  }

  _sync() {
    const want = this._want();
    if (want === this.chatId) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.chatId = want;
    this.token = '';
    this.quiet = 0;
    this.seen.clear();
    if (!want) {
      if (this.st.state === 'connected' || this.st.state === 'connecting') this._set({ state: 'off', error: null });
      return;
    }
    console.log(`[ytchat] reading live chat ${want}`);
    this._set({ state: 'connecting', error: null, count: 0 });
    this._poll();
  }

  async _poll() {
    const id = this.chatId;
    if (!id) return;
    let wait = 30000;
    try {
      const r = await this.g.api('GET', '/youtube/v3/liveChat/messages', {
        query: { liveChatId: id, part: 'snippet,authorDetails', maxResults: 200, ...(this.token ? { pageToken: this.token } : {}) },
      });
      if (id !== this.chatId) return;
      const first = !this.token;
      this.token = r.nextPageToken || this.token;
      const list = (r.items || []).filter((x) => x?.id && !this.seen.has(x.id)).map((x) => this._normalize(x)).filter(Boolean);
      for (const x of r.items || []) if (x?.id) this.seen.add(x.id);
      if (this.seen.size > 3000) this.seen = new Set([...this.seen].slice(-1000));
      // the first answer is the recent backlog: show the last few lines only
      const fresh = first ? list.slice(-30) : list;
      if (fresh.length) this.emit('chat', fresh);
      this.quiet = list.length ? 0 : this.quiet + 1;
      const min = Math.max(3, Number(this.cfg.chatPollSec) || 10) * 1000;
      wait = Math.max(min * (this.quiet >= 3 ? 2 : 1), Number(r.pollingIntervalMillis) || 0);
      this._set({ state: 'connected', error: null, count: this.st.count + list.length, calls: this.st.calls + 1 });
    } catch (e) {
      if (id !== this.chatId) return;
      const why = `${e.reason || ''} ${e.message}`;
      if (/quotaExceeded|dailyLimitExceeded/i.test(why)) {
        this.quotaDay = new Date().toDateString();
        console.log('[ytchat] YouTube API quota used up for today — chat reading stopped');
        this._set({ state: 'error', error: '오늘 쓸 수 있는 YouTube API 할당량을 다 써서 유튜브 채팅을 그만 읽어요 (내일 다시)' });
        this.chatId = '';
        return;
      }
      if (ENDED.test(why) || e.status === 404) {
        console.log(`[ytchat] chat ${id} not readable: ${why.trim()}`);
        this.dead = id;
        this._set({ state: 'error', error: /disabled/i.test(why) ? '이 유튜브 방송은 채팅이 꺼져 있어요' : '유튜브 채팅을 읽을 수 없어요 (끝났거나 꺼진 채팅)' });
        this.chatId = '';
        return;
      }
      if (/rateLimitExceeded/i.test(why)) wait = 20000;
      console.log(`[ytchat] poll failed: ${why.trim()}`);
      this._set({ state: 'error', error: `유튜브 채팅 연결 문제 — 다시 시도 중 (${e.message})` });
    }
    if (id === this.chatId) this.timer = setTimeout(() => this._poll(), wait);
  }

  // the same shape as Chzzk's chat lines (chzzk.js _normalize), platform 'youtube'
  _normalize(x) {
    const s = x.snippet || {};
    const a = x.authorDetails || {};
    const type = s.type || 'textMessageEvent';
    let kind = 'chat', amountText = '', months = null;
    let text = s.displayMessage ?? s.textMessageDetails?.messageText ?? '';
    if (type === 'superChatEvent' || type === 'superStickerEvent') {
      kind = 'donation';
      const d = s.superChatDetails || s.superStickerDetails || {};
      amountText = d.amountDisplayString || '';
      text = d.userComment ?? (type === 'superStickerEvent' ? d.superStickerMetadata?.altText || '' : text);
    } else if (type === 'newSponsorEvent') {
      kind = 'subscription';
      text = text || '멤버십 가입';
    } else if (type === 'memberMilestoneChatEvent') {
      kind = 'subscription';
      months = s.memberMilestoneChatDetails?.memberMonth ?? null;
      text = s.memberMilestoneChatDetails?.userComment ?? '';
    } else if (type === 'membershipGiftingEvent') {
      kind = 'subscription';
      text = `멤버십 ${s.membershipGiftingDetails?.giftMembershipsCount || ''}개 선물`;
    } else if (type === 'giftMembershipReceivedEvent') {
      kind = 'subscription';
      text = '멤버십 선물 받음';
    } else if (type === 'messageDeletedEvent' || type === 'userBannedEvent' || type === 'tombstone' || type === 'chatEndedEvent') {
      return null;
    } else if (type !== 'textMessageEvent') {
      return null; // polls, sponsor-only mode changes …
    }
    const time = Date.parse(s.publishedAt) || Date.now();
    return {
      key: `yt:${x.id}`,
      id: 0, // given by chzzk.addExternal
      platform: 'youtube',
      time,
      uid: a.channelId ? `yt:${a.channelId}` : '',
      nick: a.displayName || '',
      role: a.isChatOwner ? 'streamer' : a.isChatModerator ? 'manager' : '',
      member: !!a.isChatSponsor,
      verified: !!a.isVerified,
      sub: null,
      badges: [],
      text: String(text || ''),
      emojis: {},
      kind,
      amount: null,
      amountText,
      donationType: null,
      months,
    };
  }
}
