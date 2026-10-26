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

const p2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export function fillTemplate(tpl, { date, title }) {
  return String(tpl || '{date} - {title}').replace(/\{date\}/g, ymd(date)).replace(/\{title\}/g, title).replace(/\s+/g, ' ').trim();
}

export class YouTubeGuard extends EventEmitter {
  // getTitle(): the current stream title (방송 준비 panel / Chzzk), '' if unknown
  constructor(google, config, { getTitle }) {
    super();
    this.g = google;
    this.config = config;
    this.getTitle = getTitle;
    this.st = loadState('youtube', {}); // { streamId, broadcastId }
    this.b = null; // last seen broadcast summary
    this.alert = null; // { level, text } shown on the dashboard while live
    this.error = null;
    this.streaming = false;
    this.liveSince = 0;
    this.timer = null;
    this.busy = null;
    google.on('login', () => this.ensureReady('login').catch(() => {}));
  }

  get cfg() { return this.config.youtube || {}; }
  enabled() { return this.cfg.enabled !== false && this.g.loggedIn() && !!this.st.streamId; }

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
  _set(patch) { Object.assign(this, patch); this.emit('change'); }

  title() {
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
        if (READY.has(life) && b.snippet?.title !== this.title()) b = await this._retitle(b, this.title());
      } else {
        b = await this._create();
        console.log(`[youtube] new private broadcast ready (${why}): ${b.id}`);
      }
      this._set({ b: this._summary(b), error: null });
      return b;
    } catch (e) {
      this._set({ error: e.message });
      console.log(`[youtube] ensureReady failed: ${e.message}`);
      throw e;
    }
  }

  async _create() {
    const b = await this.g.api('POST', '/youtube/v3/liveBroadcasts', {
      query: { part: 'snippet,status,contentDetails' },
      body: {
        snippet: { title: this.title(), scheduledStartTime: new Date(Date.now() + 60000).toISOString(), description: '[allmind] 자동으로 만든 비공개 아카이브' },
        status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true, monitorStream: { enableMonitorStream: false } },
      },
    });
    this.st.broadcastId = b.id;
    this._save();
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
    const u = await this.g.api('PUT', '/youtube/v3/liveBroadcasts', {
      query: { part: 'snippet' },
      body: { id: b.id, snippet: { title, scheduledStartTime: b.snippet?.scheduledStartTime || new Date().toISOString(), description: b.snippet?.description || '' } },
    });
    return { ...b, snippet: { ...b.snippet, ...u.snippet, title } };
  }

  // 방송 준비 panel: set the archive title now (ready or already live).
  async setTitle(title) {
    if (!this.enabled()) return { skipped: true };
    let b = await this.ensureReady('title');
    const t = fillTemplate(this.cfg.titleTemplate || '{date} - {title}', { date: new Date(), title }).slice(0, 100);
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
    if (life !== 'live' && Date.now() - this.liveSince > NOT_LIVE_AFTER_MS) {
      let fed = null;
      try {
        const r = await this.g.api('GET', '/youtube/v3/liveStreams', { query: { part: 'status', id: this.st.streamId } });
        fed = r.items?.[0]?.status?.streamStatus === 'active';
      } catch {}
      alert = {
        level: 'bad',
        text: fed === false
          ? '유튜브 아카이브에 영상이 들어가지 않고 있어요 — OBS의 유튜브 송출(Multi-RTMP)과 스트림 키를 확인해 주세요'
          : '유튜브 아카이브 방송이 아직 시작되지 않았어요 — YouTube 스튜디오에서 확인해 주세요',
        url: this._summary(cur).url,
      };
    }
    this._set({ b: this._summary(cur), alert, error: null });
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

  forgetKey() {
    this.st = {};
    this._save();
    this._set({ b: null, alert: null, error: null });
  }
}
