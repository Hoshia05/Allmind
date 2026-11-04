// Stream Deck (and any other launcher) support: plain URLs that run one action.
//
//   http://<stream PC>:8080/deck/bgm-toggle
//   http://<stream PC>:8080/deck/sb-play?name=박수
//
// Stream Deck's built-in "Website" action (with "Access in background") only sends GET, and the
// dashboard's /api/* routes want POST + JSON — so these are thin GET aliases. Same Allmind
// instance for every deck/PC; state lives on the stream PC. Optional secret: config.deck.token,
// then every URL from another device needs `?key=<token>` (the stream PC itself doesn't). Turning on the optional
// PIN for other devices creates a token if there is none — the plugin has no browser to enter a PIN in.
import crypto from 'node:crypto';

const norm = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export class Deck {
  constructor({ config, bgm, soundboard, markers, todo }) {
    this.config = config;
    this.bgm = bgm;
    this.sb = soundboard;
    this.markers = markers;
    this.todo = todo;
    // Live state for the Allmind Stream Deck plugin (GET /deck/events). Separate from the dashboard's
    // SSE on purpose: a deck plugin is always connected, and must not count as "a dashboard is open".
    this.clients = new Set();
    this.sent = { state: '', lists: '' };
    this.timer = null;
    const changed = () => this.clients.size && this._schedule();
    bgm.on('change', changed);
    soundboard.on('change', changed);
    todo?.on('change', changed); // (🔁 loop changes arrive as bgm 'change')
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
      'bgm-loop': { label: 'BGM 🔁 무한 반복 켜기/끄기 (지금 곡)', run: (p) => this._bgmLoop(p.get('on')) },
      'todo-next': { label: '할 일: 오늘 할 것 다음 항목 체크', run: () => this._todoNext() },
      'todo-undo': { label: '할 일: 마지막 체크 되돌리기', run: () => this._todoUndo() },
      'mark': { label: '⭐ 순간 표시', run: async (p) => { const r = await this.markers.mark(p.get('label')); if (!r.ok) throw new Error(r.reason === 'not recording' ? '녹화 중이 아니에요' : r.reason === 'OBS not connected' ? 'OBS에 연결되어 있지 않아요' : r.reason || '표시하지 못했어요'); return { t: r.t }; } },
    };
  }

  get token() { return String(this.config.deck?.token || ''); }

  // trusted = the request comes from the stream PC itself (its own Stream Deck plugin needs no key; another site's
  // <img> on this PC is already refused by server.js guard() via Sec-Fetch-Site)
  authorized(params, trusted = false) {
    if (!this.token || trusted) return true;
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

  // 🔁 무한 반복 for the track that's on now (on=1/0 forces a side; otherwise it flips). Only for a track whose loop
  // points were already set once in the dashboard's 🔁 editor — a key press shouldn't put an unchecked seam on stream.
  _bgmLoop(on) {
    const id = this.bgm.currentId;
    if (!id || !this.bgm.tracks.has(id)) throw new Error('지금 고른 곡이 없어요');
    const v = this.bgm.loops.view(id);
    if (!v || v.start == null) throw new Error('이 곡은 아직 무한 반복 설정이 없어요 — 대시보드 셋리스트의 🔁에서 먼저 저장해 주세요');
    const want = on === '1' || on === 'true' ? true : on === '0' || on === 'false' ? false : !v.enabled;
    const r = this.bgm.loops.setEnabled(id, want);
    this.bgm.loopChanged(id);
    return { track: this.bgm.tracks.get(id).title, enabled: r.enabled, state: r.state };
  }

  // 오늘 할 것, in the dashboard's order (oldest first); the next one is the first unchecked
  _tonight() { return this.todo ? this.todo.items.filter((x) => x.status === 'tonight').sort((a, b) => a.moved - b.moved) : []; }
  async _todoNext() {
    if (!this.todo) throw new Error('할 일을 쓸 수 없어요');
    const it = this._tonight().find((x) => !x.done);
    if (!it) throw new Error('오늘 할 것을 다 했어요');
    const r = await this.todo.check(it.id, true);
    return { item: it.title, marked: r.marked };
  }
  async _todoUndo() {
    if (!this.todo) throw new Error('할 일을 쓸 수 없어요');
    const last = this._tonight().filter((x) => x.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
    if (!last) throw new Error('되돌릴 체크가 없어요');
    await this.todo.check(last.id, false);
    return { item: last.title };
  }

  // ---------- live state for the plugin ----------
  summary() {
    const b = this.bgm, sb = this.sb;
    const lv = b.currentId ? b.loops?.view(b.currentId) : null;
    const tonight = this._tonight();
    const next = tonight.find((x) => !x.done);
    return {
      bgm: {
        ok: !!b.sourceOk, playing: !!b.media.playing, currentId: b.currentId, title: b.tracks.get(b.currentId)?.title || '', volumeDb: b.volumeDb,
        // 🔁 for the current track: set = loop points saved once; state idle/analyzing/building/ready/error; progress 0–100 while building
        loop: lv && lv.start != null ? { set: true, enabled: lv.enabled, ready: !!lv.ready, state: lv.state, progress: lv.progress, error: lv.error } : { set: false },
      },
      sb: { ok: !!sb.sourceOk, playing: sb.playing, volumeDb: sb.volumeDb },
      todo: { total: tonight.length, left: tonight.filter((x) => !x.done).length, next: next?.title || '' },
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
  async run(name, params, trusted = false) {
    if (!this.authorized(params, trusted)) return { status: 403, body: { ok: false, error: '키(key)가 맞지 않아요' } };
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
      { title: '🔁 무한 반복 · 할 일', items: ['bgm-loop', 'todo-next', 'todo-undo'].map((n) => ({ label: this.actions[n].label, path: mk(n) })) },
      { title: '녹화', items: [{ label: this.actions.mark.label, path: mk('mark') }] },
    ];
    return { hasToken: !!this.token, groups };
  }
}
