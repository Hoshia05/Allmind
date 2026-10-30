// 방송 리포트: one summary per stream, made when OBS's stream output stops.
// Counted while live: duration, peak viewers, chat / chatters / first-time chatters, donations, subs,
// ⭐ marks, roulette spins, dropped / lagged frames (OBS stats at start and stop: 2 requests per
// stream), YouTube archive state, problems seen (OBS lost, YouTube alarm, chat lost). Survives an
// Allmind restart mid-stream (DATA_DIR/report-current.json). Last 30 in DATA_DIR/reports.json.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { loadState, saveState } from './config.js';

const KEEP = 30;

export class StreamReports extends EventEmitter {
  constructor(c) {
    super();
    this.c = c; // { obs, chzzk, youtube, markers, roulette, drive }
    this.list = loadState('reports', []);
    this.cur = loadState('report-current', null);
    this.seen = loadState('reports-seen', { id: null }).id;
    this.saveT = null;
    // everyone who has ever chatted while Allmind was running → "첫 채팅" count
    this.known = new Set(loadState('known-chatters', []));
    this.knownT = null;
    const { chzzk, youtube, obs, markers } = c;
    chzzk.on('live-chat', (list) => {
      const r = this.cur;
      if (!r) { for (const m of list) if (m.kind === 'chat' && m.uid) this._know(m.uid); return; }
      for (const m of list) {
        if (m.hidden) continue;
        if (m.kind === 'chat') {
          r.chats++;
          if (m.uid && !r.chatters.includes(m.uid)) {
            r.chatters.push(m.uid);
            if (!this.known.has(m.uid)) r.newChatters++;
          }
          if (m.uid) this._know(m.uid);
        } else if (m.kind === 'donation') { r.donations++; r.cheese += Number(m.amount) || 0; if (m.donationType === 'VIDEO') r.videos++; }
        else if (m.kind === 'subscription') r.subs++;
      }
      this._dirty();
    });
    chzzk.on('change', () => {
      const r = this.cur;
      if (!r) return;
      const l = chzzk.live;
      if (l?.isLive) {
        if (l.viewers > r.peak) { r.peak = l.viewers; this._dirty(); }
        if (l.title && !r.titles.includes(l.title)) { r.titles.push(l.title); this._dirty(); }
        if (l.category) r.category = l.category;
      }
      if (chzzk.chatState !== 'connected' && r.chatWasUp && chzzk.live?.isLive) this.problem('chat', '치지직 채팅 연결이 끊겼어요');
      r.chatWasUp = chzzk.chatState === 'connected';
    });
    youtube.on('change', () => {
      const r = this.cur;
      if (!r) return;
      const b = youtube.b;
      if (b?.life === 'live' && !r.yt.live) { r.yt.live = true; r.yt.title = b.title; r.yt.id = b.id || null; this._dirty(); }
      if (b && b.privacy !== 'private' && b.life === 'live') this.problem('ytpublic', `유튜브가 ${b.privacy}로 바뀌었어요 (Allmind가 비공개로 되돌림)`);
      if (youtube.alert) this.problem('ytalert', String(youtube.alert.text || youtube.alert));
    });
    obs.on('disconnected', () => { if (this.cur) this.problem('obs', 'OBS 연결이 끊겼어요'); });
    markers.on('change', () => {
      const r = this.cur;
      if (!r) return;
      const n = markers.status().count || 0;
      if (n > r.marksSeen) { r.marks += n - r.marksSeen; r.marksSeen = n; this._dirty(); }
      if (n < r.marksSeen) r.marksSeen = n; // a new recording started
    });
  }

  _know(uid) {
    if (this.known.has(uid)) return;
    this.known.add(uid);
    if (this.known.size > 50000) this.known.delete(this.known.values().next().value);
    if (!this.knownT) this.knownT = setTimeout(() => { this.knownT = null; saveState('known-chatters', [...this.known]); }, 30000);
  }

  problem(key, text) {
    const r = this.cur;
    if (!r) return;
    const last = r.problems.findLast((p) => p.key === key);
    if (last && Date.now() - last.at < 5 * 60000) return; // once per 5 min per kind
    r.problems.push({ key, text: String(text).slice(0, 200), at: Date.now() });
    if (r.problems.length > 30) r.problems.shift();
    this._dirty();
  }

  async _stats() {
    try {
      const [st, ss] = await Promise.all([this.c.obs.call('GetStats'), this.c.obs.call('GetStreamStatus')]);
      return { netSkip: ss.outputSkippedFrames ?? 0, netTotal: ss.outputTotalFrames ?? 0, renSkip: st.renderSkippedFrames ?? 0, renTotal: st.renderTotalFrames ?? 0, encSkip: st.outputSkippedFrames ?? 0, encTotal: st.outputTotalFrames ?? 0 };
    } catch { return null; }
  }

  // OBS stream output started
  async start() {
    if (this.cur && Date.now() - (this.cur.lastAt || this.cur.startedAt) < 10 * 60000) return; // Allmind restarted mid-stream: keep counting
    if (this.cur) await this.finish(true); // a stream we never saw end (Allmind was off): close it as it was
    // restarted within 10 min (OBS restarted, settings fixed, network…): it's the same stream — keep one report
    if (this.recent && Date.now() - this.recent.at < 10 * 60000) {
      const { r, rep } = this.recent;
      this.recent = null;
      const i = this.list.findIndex((x) => x.id === rep.id);
      if (i >= 0) { this.list.splice(i, 1); saveState('reports', this.list); }
      const gapS = Math.round((Date.now() - rep.endedAt) / 1000);
      const gap = gapS < 60 ? `${gapS}초` : `${Math.round(gapS / 60)}분`;
      r.endedAt = null; r.statsEnd = null; r.restarts = (r.restarts || 0) + 1;
      r.statsStart = await this._stats(); // OBS counts again from zero for the new output: health is the latest part
      r.problems.push({ key: `restart:${Date.now()}`, text: `방송이 꺼졌다가 ${gap} 뒤 다시 시작됐어요`, at: Date.now() });
      this.cur = r;
      this._dirty(true);
      this.emit('change');
      console.log(`[report] stream restarted after ${gapS} s — continuing the same report`);
      return;
    }
    this.cur = {
      id: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      startedAt: Date.now(), endedAt: null, peak: 0, titles: [], category: '',
      chats: 0, chatters: [], newChatters: 0, donations: 0, cheese: 0, videos: 0, subs: 0,
      marks: 0, marksSeen: this.c.markers.status().count || 0,
      yt: { enabled: this.c.youtube.status().enabled && this.c.youtube.status().hasKey, live: false, title: null, id: null },
      problems: [], statsStart: await this._stats(), chatWasUp: this.c.chzzk.chatState === 'connected',
    };
    this._dirty(true);
    console.log('[report] stream started');
  }

  // OBS says STOPPING: the stream's own counters are still there
  async stopping() {
    if (this.cur && !this.cur.statsEnd) this.cur.statsEnd = await this._stats();
  }

  async finish(stale = false) {
    const r = this.cur;
    if (!r) return null;
    this.cur = null;
    saveState('report-current', null);
    r.endedAt = stale ? r.lastAt || r.startedAt : Date.now();
    if (!r.statsEnd && !stale) r.statsEnd = await this._stats();
    const a = r.statsStart, b = r.statsEnd;
    const pct = (k) => {
      if (!b) return null;
      const ds = b[k + 'Skip'] - (a && b[k + 'Total'] >= a[k + 'Total'] ? a[k + 'Skip'] : 0);
      const dt = b[k + 'Total'] - (a && b[k + 'Total'] >= a[k + 'Total'] ? a[k + 'Total'] : 0);
      return dt > 0 ? Math.round((10000 * Math.max(0, ds)) / dt) / 100 : null;
    };
    const roulette = this.c.roulette.log.filter((x) => x.time >= r.startedAt && x.time <= r.endedAt && !x.test);
    const rep = {
      id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, stale,
      title: r.titles.at(-1) || '', titles: r.titles.slice(-5), category: r.category,
      peak: r.peak, chats: r.chats, chatters: r.chatters.length, newChatters: r.newChatters,
      donations: r.donations, cheese: r.cheese, videos: r.videos, subs: r.subs, marks: r.marks,
      roulette: { spins: roulette.length, todo: roulette.filter((x) => !x.done && !x.wheel).map((x) => ({ id: x.id, nick: x.nick, result: x.result })) },
      health: { dropPct: pct('net'), dropFrames: b && a ? Math.max(0, b.netSkip - a.netSkip) : b?.netSkip ?? null, renderPct: pct('ren'), encodePct: pct('enc') },
      yt: r.yt, problems: r.problems,
    };
    this.list.push(rep);
    if (!stale) this.recent = { r, rep, at: Date.now() };
    if (this.list.length > KEEP) this.list.splice(0, this.list.length - KEEP);
    saveState('reports', this.list);
    console.log(`[report] stream ended: ${Math.round((rep.endedAt - rep.startedAt) / 60000)} min, peak ${rep.peak}, ${rep.chats} chats, ${rep.donations} donations`);
    this.emit('change');
    if (!stale) this.emit('ready', rep);
    return rep;
  }

  _dirty(now = false) {
    if (!this.cur) return;
    this.cur.lastAt = Date.now();
    if (now) { saveState('report-current', this.cur); return; }
    if (this.saveT) return;
    this.saveT = setTimeout(() => { this.saveT = null; if (this.cur) saveState('report-current', this.cur); }, 15000);
  }

  markSeen(id) { this.seen = id; saveState('reports-seen', { id }); this.emit('change'); }

  // the upload rows of a report's recording (Drive queue items made after the stream started)
  uploads(rep) {
    return this.c.drive.status().items.filter((i) => i.at >= rep.startedAt && i.at <= (rep.endedAt || Date.now()) + 6 * 3600000 && i.kind === 'video')
      .map((i) => ({ name: i.name, status: i.status, pct: i.size ? Math.floor((i.offset / i.size) * 100) : 0, url: i.url, error: i.error }));
  }
  view(id) {
    const rep = id ? this.list.find((x) => x.id === id) : this.list.at(-1);
    if (!rep) return null;
    const roulette = this.c.roulette.log.filter((x) => rep.roulette.todo.some((t) => t.id === x.id));
    return { ...rep, roulette: { ...rep.roulette, todo: roulette.filter((x) => !x.done).map((x) => ({ id: x.id, nick: x.nick, result: x.result })) }, uploads: this.uploads(rep) };
  }
  summary() {
    const last = this.list.at(-1);
    return { count: this.list.length, latest: last ? { id: last.id, endedAt: last.endedAt } : null, unseen: !!(last && last.id !== this.seen && !last.stale), live: !!this.cur, list: this.list.slice().reverse().map((x) => ({ id: x.id, startedAt: x.startedAt, endedAt: x.endedAt, title: x.title, peak: x.peak })) };
  }
}
