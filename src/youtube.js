// YouTube archive guard (docs/plans/google-archive.md).
//
// The owner simulcasts every stream to YouTube as a PRIVATE archive (OBS Multi-RTMP plugin).
// The persistent "Stream now" broadcast sometimes doesn't start (Studio still on the last stream's
// results), and sometimes isn't private. So Allmind keeps its own reusable stream key and always
// has one fresh broadcast ready: private, auto-start, auto-stop, bound to that key.
// While OBS streams it checks once a minute: privacy (fixed at once) and "is it live yet".
// Only network requests to YouTube — nothing extra asked of OBS.
import { EventEmitter } from 'node:events';
import { loadState, saveState } from './config.js';

const CHECK_MS = Number(process.env.ALLMIND_YT_CHECK_MS) || 60 * 1000; // env only for mock tests
const NOT_LIVE_AFTER_MS = CHECK_MS * 1.5;
const AFTER_STREAM_MS = CHECK_MS * 2;
const READY = new Set(['created', 'ready', 'testStarting', 'testing']);
// Which broadcasts are Allmind's (only those are ever reused or deleted): the ids it made, kept in st.made.
// Before 0.36.7 they were marked by this description prefix instead — still recognised.
const OLD_MARK = '[allmind]';
// description of our broadcasts: the day it was streamed
export const descFor = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 방송`;

const p2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export function fillTemplate(tpl, { date, title }) {
  return String(tpl || '{date} - {title}').replace(/\{date\}/g, ymd(date)).replace(/\{title\}/g, title).replace(/\s+/g, ' ').trim();
}

export class YouTubeGuard extends EventEmitter {
  // getTitle(): the current stream title (방송 준비 panel / Chzzk), '' if unknown
  // getFullTitle(): a title typed separately for YouTube (used as is), '' if none
  constructor(google, config, { getTitle, getFullTitle }) {
    super();
    this.g = google;
    this.config = config;
    this.getTitle = getTitle;
    this.getFullTitle = getFullTitle || (() => '');
    this.st = loadState('youtube', {}); // { streamId, broadcastId }
    this.b = null; // last seen broadcast summary
    this.alert = null; // { level, text } shown on the dashboard while live
    this.error = null;
    this.streaming = false;
    this.liveSince = 0;
    this.timer = null;
    this.busy = null;
    google.on('login', () => {
      // logged in to a different channel: the saved key/broadcast belong to the old one
      const ch = google.auth?.channelId;
      if (ch && this.st.streamId && this.st.channelId && this.st.channelId !== ch) this._keyGone('다른 채널로 로그인했어요');
      this.ensureReady('login').catch(() => {});
    });
  }

  get cfg() { return this.config.youtube || {}; }
  enabled() { return this.cfg.enabled !== false && this.g.has('youtube') && !!this.st.streamId; }

  status() {
    return {
      enabled: this.cfg.enabled !== false,
      hasKey: !!this.st.streamId,
      broadcast: this.b,
      alert: this.alert,
      error: this.error,
      streaming: this.streaming,
    };
  }

  _save() { saveState('youtube', this.st); }
  _ours(b) { return !!b && ((this.st.made || []).includes(b.id) || String(b.snippet?.description || '').startsWith(OLD_MARK)); }
  _remember(id) { this.st.made = [...(this.st.made || []).filter((x) => x !== id), id].slice(-50); this._save(); }
  // "2026년 10월 29일 방송" for our broadcasts (old "[allmind] …" ones get it too); someone else's stays as it is
  _desc(b) { const cur = b?.snippet?.description || ''; return !cur || this._ours(b) ? descFor(new Date()) : cur; }
  _set(patch) { Object.assign(this, patch); this.emit('change'); }

  title() {
    const full = (this.getFullTitle() || '').trim();
    if (full) return full.slice(0, 100);
    const t = (this.getTitle() || '').trim() || '방송 아카이브';
    return fillTemplate(this.cfg.titleTemplate || '{date} - {title}', { date: new Date(), title: t }).slice(0, 100);
  }

  // One-time: Allmind's own reusable stream key. Returns the RTMP address + key to paste into OBS
  // (shown once in the local settings window; Allmind keeps only the stream id).
  async createKey() {
    const s = await this.g.api('POST', '/youtube/v3/liveStreams', {
      query: { part: 'snippet,cdn,contentDetails' },
      body: {
        snippet: { title: 'Allmind 아카이브' },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: true },
      },
    });
    this.st.streamId = s.id;
    this.st.channelId = this.g.auth?.channelId || '';
    this.st.broadcastId = null;
    this._save();
    console.log(`[youtube] created stream key ${s.id}`);
    await this.ensureReady('new key').catch(() => {});
    return { address: s.cdn?.ingestionInfo?.ingestionAddress || '', key: s.cdn?.ingestionInfo?.streamName || '' };
  }

  async showKey() {
    if (!this.st.streamId) throw new Error('아직 스트림 키를 만들지 않았어요');
    const r = await this.g.api('GET', '/youtube/v3/liveStreams', { query: { part: 'cdn', id: this.st.streamId } });
    const s = r.items?.[0];
    if (!s) throw new Error('YouTube에서 스트림 키를 찾을 수 없어요 — 새로 만들어 주세요');
    return { address: s.cdn?.ingestionInfo?.ingestionAddress || '', key: s.cdn?.ingestionInfo?.streamName || '' };
  }

  async _get(id) {
    const r = await this.g.api('GET', '/youtube/v3/liveBroadcasts', { query: { part: 'id,snippet,status,contentDetails', id } });
    return r.items?.[0] || null;
  }

  _summary(b) {
    return b ? {
      id: b.id,
      title: b.snippet?.title || '',
      privacy: b.status?.privacyStatus || '',
      life: b.status?.lifeCycleStatus || '',
      url: `https://studio.youtube.com/video/${b.id}/livestreaming`,
    } : null;
  }

  // Make sure a private, auto-starting broadcast is waiting (or running) for the next stream.
  ensureReady(why = '') {
    this.busy ||= this._ensureReady(why).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _ensureReady(why) {
    if (!this.enabled()) return null;
    try {
      let b = this.st.broadcastId ? await this._get(this.st.broadcastId) : null;
      const life = b?.status?.lifeCycleStatus;
      if (b && (READY.has(life) || life === 'live' || life === 'liveStarting')) {
        if (b.status.privacyStatus !== 'private') b = await this._makePrivate(b);
        if (READY.has(life) && b.contentDetails?.boundStreamId !== this.st.streamId) await this._bind(b.id);
        // also on stream start: the date in the title and description becomes the day it's really streamed
        if (READY.has(life) && (b.snippet?.title !== this.title() || b.snippet?.description !== this._desc(b))) b = await this._retitle(b, this.title());
      } else {
        // lost track of it (or it's used up): reuse one of our waiting broadcasts before making another
        const spare = await this._upcomingOurs().then((l) => l.find((x) => x.contentDetails?.boundStreamId === this.st.streamId) || l.find((x) => !x.contentDetails?.boundStreamId)).catch(() => null);
        if (spare) {
          b = spare;
          this.st.broadcastId = b.id;
          this._remember(b.id);
          if (b.status?.privacyStatus !== 'private') b = await this._makePrivate(b);
          if (b.contentDetails?.boundStreamId !== this.st.streamId) await this._bind(b.id);
          if (b.snippet?.title !== this.title() || b.snippet?.description !== this._desc(b)) b = await this._retitle(b, this.title());
          console.log(`[youtube] reusing waiting broadcast (${why}): ${b.id}`);
        } else {
          b = await this._create();
          console.log(`[youtube] new private broadcast ready (${why}): ${b.id}`);
        }
      }
      this._set({ b: this._summary(b), error: null });
      // not while a stream is starting: one of them might be the broadcast YouTube is about to start
      if (!this.streaming) this._tidy(b.id).catch((e) => console.log(`[youtube] tidy: ${e.message}`));
      return b;
    } catch (e) {
      // the saved key isn't on the logged-in channel (deleted, or another channel/account)
      if (/stream not found|liveStreamNotFound/i.test(`${e.message} ${e.reason || ''}`)) { this._keyGone('저장된 스트림 키가 지금 로그인한 채널에 없어요'); throw e; }
      this._set({ error: e.message });
      console.log(`[youtube] ensureReady failed: ${e.message}`);
      throw e;
    }
  }

  // Allmind's broadcasts that are still waiting to go live (never the owner's own)
  async _upcomingOurs() {
    const r = await this.g.api('GET', '/youtube/v3/liveBroadcasts', { query: { part: 'id,snippet,status,contentDetails', broadcastStatus: 'upcoming', broadcastType: 'all', maxResults: 50 } });
    return (r.items || []).filter((x) => this._ours(x));
  }
  // exactly one waiting broadcast on our key: the extra ones (left behind by a lost broadcast id …) only
  // confuse YouTube about which one to start, so delete them — they never went live, nothing is lost.
  // Ones on another key stay: OBS may still be sending to that key, and they'd be its only archive.
  async _tidy(keepId) {
    for (const b of await this._upcomingOurs()) {
      if (b.id === keepId) continue;
      const on = b.contentDetails?.boundStreamId;
      if (on && on !== this.st.streamId) continue;
      await this.g.api('DELETE', '/youtube/v3/liveBroadcasts', { query: { id: b.id } });
      console.log(`[youtube] deleted extra waiting broadcast ${b.id} ("${b.snippet?.title || ''}")`);
    }
  }

  async _create() {
    const b = await this.g.api('POST', '/youtube/v3/liveBroadcasts', {
      query: { part: 'snippet,status,contentDetails' },
      body: {
        snippet: { title: this.title(), scheduledStartTime: new Date(Date.now() + 60000).toISOString(), description: descFor(new Date()) },
        status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true, monitorStream: { enableMonitorStream: false } },
      },
    });
    this.st.broadcastId = b.id;
    this._remember(b.id);
    await this._bind(b.id);
    return (await this._get(b.id)) || b;
  }

  async _bind(id) {
    await this.g.api('POST', '/youtube/v3/liveBroadcasts/bind', { query: { id, part: 'id,contentDetails', streamId: this.st.streamId } });
  }

  async _makePrivate(b) {
    const u = await this.g.api('PUT', '/youtube/v3/liveBroadcasts', {
      query: { part: 'status' },
      body: { id: b.id, status: { privacyStatus: 'private', selfDeclaredMadeForKids: b.status?.selfDeclaredMadeForKids ?? false } },
    });
    console.log(`[youtube] broadcast ${b.id} was ${b.status?.privacyStatus} — set to private`);
    return { ...b, status: { ...b.status, ...u.status, privacyStatus: 'private' } };
  }

  async _retitle(b, title) {
    if (this._ours(b)) this._remember(b.id); // an old "[allmind] …" one loses that mark with its new description
    const u = await this.g.api('PUT', '/youtube/v3/liveBroadcasts', {
      query: { part: 'snippet' },
      body: { id: b.id, snippet: { title, scheduledStartTime: b.snippet?.scheduledStartTime || new Date().toISOString(), description: this._desc(b) } },
    });
    return { ...b, snippet: { ...b.snippet, ...u.snippet, title } };
  }

  // 방송 준비 panel: set the archive title now (ready or already live).
  async setTitle(title, full = '') {
    if (!this.enabled()) return { skipped: true };
    let b = await this.ensureReady('title');
    const t = (full || fillTemplate(this.cfg.titleTemplate || '{date} - {title}', { date: new Date(), title })).slice(0, 100);
    if (b && b.snippet?.title !== t) b = await this._retitle(b, t);
    this._set({ b: this._summary(b) });
    return { title: t };
  }

  // ---------- while OBS streams ----------

  onStreaming(active) {
    if (active === this.streaming) return;
    this.streaming = active;
    clearInterval(this.timer);
    this.timer = null;
    if (active) {
      this.liveSince = Date.now();
      this.ensureReady('stream start').catch(() => {});
      this.timer = setInterval(() => this.check().catch(() => {}), CHECK_MS);
      setTimeout(() => this.streaming && this.check().catch(() => {}), CHECK_MS / 3);
    } else {
      this._set({ alert: null });
      // auto-stop ends it; if it's still live a bit later, end it ourselves, then prepare the next one
      setTimeout(() => this._afterStream().catch((e) => console.log(`[youtube] after stream: ${e.message}`)), 2 * 60000);
    }
    this.emit('change');
  }

  async check() {
    if (!this.enabled() || !this.streaming) return;
    const b = this.st.broadcastId ? await this._get(this.st.broadcastId) : null;
    if (!b) { await this.ensureReady('missing'); return; }
    let cur = b;
    let alert = null;
    if (b.status.privacyStatus !== 'private') {
      cur = await this._makePrivate(b);
      this.emit('toast', { text: `🔒 유튜브 아카이브가 '${b.status.privacyStatus === 'public' ? '공개' : '일부 공개'}'로 되어 있어서 비공개로 바꿨어요`, bad: true });
    }
    const life = cur.status.lifeCycleStatus;
    this.elsewhere = null;
    if (life !== 'live' && Date.now() - this.liveSince > NOT_LIVE_AFTER_MS) {
      let fed = null;
      try {
        const r = await this.g.api('GET', '/youtube/v3/liveStreams', { query: { part: 'status', id: this.st.streamId } });
        fed = r.items?.[0]?.status?.streamStatus === 'active';
      } catch {}
      // Nothing on our key — is OBS sending to another key of this channel (YouTube's default "Stream now"
      // key, or an older key from before a new one was made)? Then the archive IS running, just not on ours.
      const other = await this._liveElsewhere().catch((e) => { console.log(`[youtube] active broadcasts: ${e.message}`); return null; });
      if (other && this._ours(other.b) && (other.streamId === this.st.streamId || !fed)) {
        // one of Allmind's own broadcasts is the live one (an extra one YouTube picked): follow it
        console.log(`[youtube] following our live broadcast ${other.b.id} (was watching ${this.st.broadcastId})`);
        this.st.broadcastId = other.b.id;
        if (other.streamId) this.st.streamId = other.streamId;
        this._save();
        cur = other.b.status?.privacyStatus === 'private' ? other.b : await this._makePrivate(other.b);
        this._tidy(cur.id).catch(() => {});
      } else if (other && !fed) {
        if (other.b.status?.privacyStatus !== 'private') {
          await this._makePrivate(other.b).catch((e) => console.log(`[youtube] couldn't make ${other.b.id} private: ${e.message}`));
          this.emit('toast', { text: `🔒 유튜브에 나가는 방송이 '${other.b.status.privacyStatus === 'public' ? '공개' : '일부 공개'}'로 되어 있어서 비공개로 바꿨어요`, bad: true });
        }
        this.elsewhere = { broadcastId: other.b.id, streamId: other.streamId, keyName: other.keyName };
        alert = {
          level: 'warn',
          text: `유튜브 아카이브는 나가고 있지만 OBS가 Allmind 키가 아닌 다른 스트림 키${other.keyName ? ` ('${other.keyName}')` : ''}로 보내고 있어요 — 비공개는 지켜 드려요. 옆의 버튼으로 그 키를 Allmind가 쓰게 하거나, OBS Multi-RTMP의 키를 설정 창의 Allmind 키로 바꿔 주세요`,
          url: `https://studio.youtube.com/video/${other.b.id}/livestreaming`,
          adopt: !!other.streamId,
        };
      } else {
        alert = {
          level: 'bad',
          text: fed === false
            ? `유튜브 아카이브에 영상이 들어가지 않고 있어요 — 로그인한 채널${this.g.auth?.account ? ` (${this.g.auth.account})` : ''}에 지금 나가는 방송이 없어요. OBS의 유튜브 송출(Multi-RTMP)이 켜져 있는지, 키가 이 채널 것인지 확인해 주세요`
            : '유튜브 아카이브 방송이 아직 시작되지 않았어요 — YouTube 스튜디오에서 확인해 주세요',
          url: this._summary(cur).url,
        };
      }
    }
    this._set({ b: this._summary(cur), alert, error: null });
  }

  // a broadcast that is live on the logged-in channel but isn't ours, and the key it runs on
  async _liveElsewhere() {
    const r = await this.g.api('GET', '/youtube/v3/liveBroadcasts', { query: { part: 'id,snippet,status,contentDetails', broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 } });
    const live = (r.items || []).filter((x) => x.id !== this.st.broadcastId && x.status?.lifeCycleStatus === 'live');
    // ours on our key first (an extra one YouTube picked), then ours on another key, then anything
    const b = live.find((x) => this._ours(x) && x.contentDetails?.boundStreamId === this.st.streamId) || live.find((x) => this._ours(x)) || live[0];
    if (!b) return null;
    const streamId = b.contentDetails?.boundStreamId || '';
    let keyName = '';
    if (streamId) {
      try { keyName = (await this.g.api('GET', '/youtube/v3/liveStreams', { query: { part: 'snippet', id: streamId } })).items?.[0]?.snippet?.title || ''; } catch {}
    }
    console.log(`[youtube] our key ${this.st.streamId} is idle; live instead: broadcast ${b.id} on key ${streamId || '?'} ${keyName ? `("${keyName}")` : ''}`);
    return { b, streamId, keyName };
  }

  // "이 키 쓰기": take over the key OBS is really sending to, and its live broadcast
  adoptLive() {
    const e = this.elsewhere;
    if (!e?.streamId) throw new Error('지금 다른 키로 나가는 방송이 없어요');
    console.log(`[youtube] adopting stream key ${e.streamId}${e.keyName ? ` ("${e.keyName}")` : ''} and broadcast ${e.broadcastId} (was ${this.st.streamId})`);
    this.st.streamId = e.streamId;
    this.st.broadcastId = e.broadcastId;
    this.st.channelId = this.g.auth?.channelId || this.st.channelId || '';
    this._save();
    this.elsewhere = null;
    this._set({ alert: null });
    this.check().catch(() => {});
    return { keyName: e.keyName };
  }

  async _afterStream() {
    if (this.streaming || !this.enabled() || !this.st.broadcastId) return;
    const b = await this._get(this.st.broadcastId);
    const life = b?.status?.lifeCycleStatus;
    if (life === 'live') {
      await this.g.api('POST', '/youtube/v3/liveBroadcasts/transition', { query: { broadcastStatus: 'complete', id: b.id, part: 'status' } });
      console.log(`[youtube] ended broadcast ${b.id}`);
    }
    if (!b || life === 'live' || life === 'complete' || life === 'revoked') {
      this.st.broadcastId = null;
      this._save();
    }
    await this.ensureReady('after stream');
  }

  _keyGone(why) {
    console.log(`[youtube] ${why} — forgetting stream ${this.st.streamId}`);
    this.st = {};
    this._save();
    this._set({ b: null, alert: null, error: `${why} — 설정 창 → 연동에서 "스트림 키 만들기"를 다시 누르고, 새 주소·키를 OBS Multi-RTMP에 넣어 주세요` });
  }
}
