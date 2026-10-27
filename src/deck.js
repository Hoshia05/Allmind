// Stream Deck (and any other launcher) support: plain URLs that run one action.
//
//   http://<stream PC>:8080/deck/bgm-toggle
//   http://<stream PC>:8080/deck/sb-play?name=박수
//
// Stream Deck's built-in "Website" action (with "Access in background") only sends GET, and the
// dashboard's /api/* routes want POST + JSON — so these are thin GET aliases. Same Allmind
// instance for every deck/PC; state lives on the stream PC. Optional secret: config.deck.token,
// then every URL needs `?key=<token>` (a web page could otherwise trigger them with an <img>).
import crypto from 'node:crypto';

const norm = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export class Deck {
  constructor({ config, bgm, soundboard, markers }) {
    this.config = config;
    this.bgm = bgm;
    this.sb = soundboard;
    this.markers = markers;
    // Live state for the Allmind Stream Deck plugin (GET /deck/events). Separate from the dashboard's
    // SSE on purpose: a deck plugin is always connected, and must not count as "a dashboard is open".
    this.clients = new Set();
    this.sent = { state: '', lists: '' };
    this.timer = null;
    const changed = () => this.clients.size && this._schedule();
    bgm.on('change', changed);
    soundboard.on('change', changed);
    // name → { label, args?, run(params) }
    this.actions = {
      'bgm-toggle': { label: 'BGM 재생/일시정지', run: async () => { await this.bgm.toggle(); } },
      'bgm-play': { label: 'BGM 재생', run: async () => { await this.bgm.play(); } },
      'bgm-pause': { label: 'BGM 일시정지', run: async () => { await this.bgm.pause(); } },
      'bgm-next': { label: 'BGM 다음 곡', run: async () => { await this.bgm.next(); } },
      'bgm-select': { label: 'BGM 이 곡 재생 (재생 중인 곡이면 일시정지)', run: (p) => this._bgmSelect(p.get('id')) },
      'bgm-prev': { label: 'BGM 이전 곡 (3초 넘으면 처음부터)', run: async () => { await this.bgm.prev(); } },
      'bgm-vol-up': { label: 'BGM 볼륨 +3dB', run: (p) => this._vol(this.bgm, num(p.get('step'), 3)) },
      'bgm-vol-down': { label: 'BGM 볼륨 −3dB', run: (p) => this._vol(this.bgm, -num(p.get('step'), 3)) },
      'sb-play': { label: '사운드보드 재생 (같은 키를 또 누르면 멈춤)', run: (p) => this._sbPlay(p.get('name')) },
      'sb-stop': { label: '사운드보드 정지', run: async () => { await this.sb.stop(); } },
      'sb-vol-up': { label: '사운드보드 볼륨 +3dB', run: (p) => this._vol(this.sb, num(p.get('step'), 3)) },
      'sb-vol-down': { label: '사운드보드 볼륨 −3dB', run: (p) => this._vol(this.sb, -num(p.get('step'), 3)) },
      'mark': { label: '⭐ 순간 표시', run: async (p) => { const r = await this.markers.mark(p.get('label')); if (!r.ok) throw new Error(r.reason === 'not recording' ? '녹화 중이 아니에요' : r.reason === 'OBS not connected' ? 'OBS에 연결되어 있지 않아요' : r.reason || '표시하지 못했어요'); return { t: r.t }; } },
    };
  }

  get token() { return String(this.config.deck?.token || ''); }

  authorized(params) {
    if (!this.token) return true;
    const a = Buffer.from(String(params.get('key') || ''));
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async _vol(target, delta) {
    await target.setVolume(target.volumeDb + delta);
    return { volumeDb: target.volumeDb };
  }

  // by file path (the dashboard's id) or title, ignoring case; a unique partial title also works
  findSound(name) {
    const q = norm(name);
    if (!q) throw new Error('name= 에 사운드 이름을 넣어 주세요');
    const all = this.sb.sounds;
    const exact = all.filter((s) => norm(s.id) === q || norm(s.title) === q);
    const hit = exact.length ? exact : all.filter((s) => norm(s.title).includes(q) || norm(s.id).includes(q));
    if (hit.length === 1) return hit[0];
    if (!hit.length) throw new Error(`"${name}" 사운드를 찾지 못했어요`);
    throw new Error(`"${name}" 와 맞는 사운드가 ${hit.length}개예요 — 이름을 더 정확히 써 주세요`);
  }

  async _bgmSelect(id) {
    id = String(id || '');
    if (!this.bgm.tracks.has(id)) throw new Error('그 곡이 셋리스트에 없어요');
    if (this.bgm.currentId === id && this.bgm.media.playing) await this.bgm.pause();
    else if (this.bgm.currentId === id) await this.bgm.play();
    else await this.bgm.select(id);
    return { track: this.bgm.tracks.get(id).title };
  }

  // ---------- live state for the plugin ----------
  summary() {
    const b = this.bgm, sb = this.sb;
    return {
      bgm: { ok: !!b.sourceOk, playing: !!b.media.playing, currentId: b.currentId, title: b.tracks.get(b.currentId)?.title || '', volumeDb: b.volumeDb },
      sb: { ok: !!sb.sourceOk, playing: sb.playing, volumeDb: sb.volumeDb },
    };
  }
  lists() {
    return {
      tracks: this.bgm.order.map((id) => this.bgm.tracks.get(id)).filter(Boolean).map((t) => ({ id: t.id, title: t.title, folder: t.folder || '' })),
      sounds: this.sb.sounds.map((s) => ({ id: s.id, title: s.title })),
    };
  }
  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this._push(); }, 60);
  }
  _push(only) {
    for (const [ev, data] of [['lists', this.lists()], ['state', this.summary()]]) {
      const j = JSON.stringify(data);
      if (!only && j === this.sent[ev]) continue;
      this.sent[ev] = j;
      for (const res of only ? [only] : this.clients) res.write(`event: ${ev}\ndata: ${j}\n\n`);
    }
  }
  attach(req, res, version) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ app: 'allmind', version })}\n\n`);
    for (const [ev, data] of [['lists', this.lists()], ['state', this.summary()]]) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  async _sbPlay(name) {
    const s = this.findSound(name);
    await this.sb.play(s.id);
    return { sound: s.title };
  }

  // → { status, body }
  async run(name, params) {
    if (!this.authorized(params)) return { status: 403, body: { ok: false, error: '키(key)가 맞지 않아요' } };
    const a = this.actions[name];
    if (!a) return { status: 404, body: { ok: false, error: `없는 동작이에요: ${name}`, actions: Object.keys(this.actions) } };
    try {
      const r = await a.run(params);
      return { status: 200, body: { ok: true, action: name, ...(r || {}) } };
    } catch (e) {
      return { status: 400, body: { ok: false, action: name, error: e.message } };
    }
  }

  // For the settings window: every URL, ready to copy (path + query only; the window adds the address).
  catalog() {
    const k = this.token ? `key=${encodeURIComponent(this.token)}` : '';
    const mk = (name, q = '') => `/deck/${name}${[q, k].filter(Boolean).length ? `?${[q, k].filter(Boolean).join('&')}` : ''}`;
    const groups = [
      { title: 'BGM', items: ['bgm-toggle', 'bgm-play', 'bgm-pause', 'bgm-next', 'bgm-prev', 'bgm-vol-up', 'bgm-vol-down'].map((n) => ({ label: this.actions[n].label, path: mk(n) })) },
      {
        title: '사운드보드',
        items: [
          ...this.sb.sounds.map((s) => ({ label: `▶ ${s.title}`, path: mk('sb-play', `name=${encodeURIComponent(s.id)}`) })),
          ...['sb-stop', 'sb-vol-up', 'sb-vol-down'].map((n) => ({ label: this.actions[n].label, path: mk(n) })),
        ],
      },
      { title: '녹화', items: [{ label: this.actions.mark.label, path: mk('mark') }] },
    ];
    return { hasToken: !!this.token, groups };
  }
}
