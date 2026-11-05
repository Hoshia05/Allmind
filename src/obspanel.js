// OBS controls for the dashboard (docs/plans/obs-controls.md):
//  • stream / recording start-stop (the live bar's LIVE and REC badges open a confirm sheet)
//  • the "OBS" panel: only the scene items and audio inputs the owner pinned — 👁 on/off, mute, volume, level
// Lean: everything comes from OBS events (no polling); levels ride on the InputVolumeMeters OBS already sends.
import { EventEmitter } from 'node:events';
import { loadState, saveState } from './config.js';

const MAX_PINS = 40;
const key = (scene, source) => `${scene}\u0000${source}`;

export class ObsPanel extends EventEmitter {
  constructor(obs) {
    super();
    this.obs = obs;
    const p = loadState('obs-pins', null) || {};
    this.pins = {
      items: (Array.isArray(p.items) ? p.items : []).filter((x) => x?.scene && x?.source).slice(0, MAX_PINS).map((x) => ({ scene: String(x.scene), source: String(x.source) })),
      audio: (Array.isArray(p.audio) ? p.audio : []).filter(Boolean).slice(0, MAX_PINS).map(String),
    };
    this.items = new Map();  // key → { scene, source, id, enabled, ok }
    this.audio = new Map();  // name → { name, muted, db, ok }
    this.peaks = new Map();  // name → highest level since the last read (linear)
    this.stream = { active: false, reconnecting: false, busy: false };
    this.record = { active: false, paused: false, busy: false };
    this._resetMaps();

    obs.on('connected', () => this._load());
    obs.on('disconnected', () => { this._resetMaps(); this.stream.active = false; this.record.active = false; this._changed(); });
    obs.on('StreamStateChanged', ({ outputActive, outputState }) => {
      this.stream.active = !!outputActive;
      this.stream.reconnecting = /RECONNECTING$/.test(outputState || '');
      if (/(STARTED|STOPPED|RECONNECTED)$/.test(outputState || '')) this.stream.busy = false;
      this._changed();
    });
    obs.on('RecordStateChanged', ({ outputActive, outputState }) => {
      const s = outputState || '';
      if (/STARTED|RESUMED/.test(s)) this.record = { active: true, paused: false, busy: false };
      else if (/PAUSED/.test(s)) this.record = { active: true, paused: true, busy: false };
      else if (/STOPPED/.test(s)) this.record = { active: false, paused: false, busy: false };
      else this.record.active = !!outputActive;
      this._changed();
    });
    obs.on('SceneItemEnableStateChanged', ({ sceneName, sceneItemId, sceneItemEnabled }) => {
      for (const it of this.items.values()) if (it.scene === sceneName && it.id === sceneItemId) { it.enabled = sceneItemEnabled; this._changed(); }
    });
    for (const ev of ['SceneItemCreated', 'SceneItemRemoved']) {
      obs.on(ev, ({ sceneName }) => { if (this.pins.items.some((x) => x.scene === sceneName)) this._loadItems(); });
    }
    obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      const a = this.audio.get(inputName); if (a) { a.muted = inputMuted; this._changed(); }
    });
    obs.on('InputVolumeChanged', ({ inputName, inputVolumeDb }) => {
      const a = this.audio.get(inputName); if (a) { a.db = inputVolumeDb; this._changed(); }
    });
    obs.on('InputVolumeMeters', ({ inputs }) => {
      if (!this.audio.size) return;
      for (const inp of inputs) {
        if (!this.audio.has(inp.inputName)) continue;
        let peak = this.peaks.get(inp.inputName) || 0;
        for (const ch of inp.inputLevelsMul || []) peak = Math.max(peak, ch[1] ?? 0);
        this.peaks.set(inp.inputName, peak);
      }
    });
    // renames in OBS follow the pins
    obs.on('InputNameChanged', ({ oldInputName, inputName }) => this._rename((x) => x === oldInputName, inputName, 'source'));
    obs.on('SceneNameChanged', ({ oldSceneName, sceneName }) => this._rename((x) => x === oldSceneName, sceneName, 'scene'));
    if (obs.connected) this._load();
  }

  _resetMaps() {
    this.items = new Map(this.pins.items.map((x) => [key(x.scene, x.source), { ...x, id: null, enabled: false, ok: false }]));
    this.audio = new Map(this.pins.audio.map((n) => [n, { name: n, muted: false, db: 0, ok: false }]));
    this.peaks = new Map();
  }

  _rename(match, to, field) {
    let hit = false;
    if (field === 'source') {
      this.pins.audio = this.pins.audio.map((n) => (match(n) ? ((hit = true), to) : n));
      for (const x of this.pins.items) if (match(x.source)) { x.source = to; hit = true; }
    } else for (const x of this.pins.items) if (match(x.scene)) { x.scene = to; hit = true; }
    if (hit) { saveState('obs-pins', this.pins); this._resetMaps(); this._load(); }
  }

  _changed() {
    if (this.t) return;
    this.t = setTimeout(() => { this.t = null; this.emit('change'); }, 40);
  }

  status() {
    return {
      stream: { ...this.stream },
      record: { ...this.record },
      items: [...this.items.values()].map(({ scene, source, enabled, ok }) => ({ scene, source, enabled, ok })),
      audio: [...this.audio.values()].map(({ name, muted, db, ok }) => ({ name, muted, db: Math.round(db * 10) / 10, ok })),
    };
  }

  // levels of the pinned audio since the last call, in dB (for the dashboard's 100 ms 'level' event)
  levels() {
    if (!this.audio.size) return null;
    const out = {};
    for (const n of this.audio.keys()) {
      const p = this.peaks.get(n) || 0;
      out[n] = p > 0 ? Math.max(-60, Math.round(20 * Math.log10(p))) : -60;
      this.peaks.set(n, 0);
    }
    return out;
  }

  async _load() {
    if (!this.obs.connected) return;
    try { const s = await this.obs.call('GetStreamStatus'); this.stream.active = !!s.outputActive; this.stream.reconnecting = !!s.outputReconnecting; } catch {}
    try { const r = await this.obs.call('GetRecordStatus'); this.record.active = !!r.outputActive; this.record.paused = !!r.outputPaused; } catch {}
    await Promise.all([this._loadItems(), this._loadAudio()]);
    this._changed();
  }

  async _loadItems() {
    for (const it of this.items.values()) {
      try {
        const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName: it.scene, sourceName: it.source });
        const { sceneItemEnabled } = await this.obs.call('GetSceneItemEnabled', { sceneName: it.scene, sceneItemId });
        Object.assign(it, { id: sceneItemId, enabled: sceneItemEnabled, ok: true });
      } catch { Object.assign(it, { id: null, ok: false }); }
    }
    this._changed();
  }

  async _loadAudio() {
    for (const a of this.audio.values()) {
      try {
        const [m, v] = await Promise.all([this.obs.call('GetInputMute', { inputName: a.name }), this.obs.call('GetInputVolume', { inputName: a.name })]);
        Object.assign(a, { muted: m.inputMuted, db: v.inputVolumeDb, ok: true });
      } catch { a.ok = false; }
    }
    this._changed();
  }

  _need() { if (!this.obs.connected) throw new Error('OBS에 연결되어 있지 않아요'); }

  // ---------- stream / recording ----------
  async output(what, action) {
    this._need();
    const map = {
      stream: { start: 'StartStream', stop: 'StopStream' },
      record: { start: 'StartRecord', stop: 'StopRecord', pause: 'PauseRecord', resume: 'ResumeRecord' },
    };
    const req = map[what]?.[action];
    if (!req) throw new Error('알 수 없는 동작이에요');
    const o = what === 'stream' ? this.stream : this.record;
    if (action === 'start' && o.active) throw new Error(what === 'stream' ? '이미 방송 중이에요' : '이미 녹화 중이에요');
    if (action !== 'start' && !o.active) throw new Error(what === 'stream' ? '방송 중이 아니에요' : '녹화 중이 아니에요');
    o.busy = true;
    this._changed();
    try {
      await this.obs.call(req);
      console.log(`[obs] ${what} ${action} (from the dashboard)`);
    } catch (e) {
      o.busy = false;
      this._changed();
      throw new Error(`OBS가 거절했어요: ${e.message}`);
    }
    setTimeout(() => { if (o.busy) { o.busy = false; this._changed(); } }, 15000); // in case the state event never comes
    return { ok: true };
  }

  // ---------- pinned items / audio ----------
  async toggleItem(scene, source, on) {
    this._need();
    const it = this.items.get(key(scene, source));
    if (!it?.ok) throw new Error('그 소스를 OBS에서 찾지 못했어요');
    const enabled = on === undefined ? !it.enabled : !!on;
    await this.obs.call('SetSceneItemEnabled', { sceneName: it.scene, sceneItemId: it.id, sceneItemEnabled: enabled });
    it.enabled = enabled;
    this._changed();
    return { enabled };
  }

  async setMute(name, muted) {
    this._need();
    const a = this.audio.get(name);
    if (!a?.ok) throw new Error('그 오디오를 OBS에서 찾지 못했어요');
    await this.obs.call('SetInputMute', { inputName: name, inputMuted: !!muted });
    a.muted = !!muted;
    this._changed();
    return { muted: a.muted };
  }

  async setVolume(name, db) {
    this._need();
    const a = this.audio.get(name);
    if (!a?.ok) throw new Error('그 오디오를 OBS에서 찾지 못했어요');
    const v = Math.max(-100, Math.min(26, Number(db)));
    if (!Number.isFinite(v)) throw new Error('볼륨 값이 이상해요');
    await this.obs.call('SetInputVolume', { inputName: name, inputVolumeDb: v });
    a.db = v;
    this._changed();
    return { db: v };
  }

  // everything that could be pinned: each scene's items (and the items inside its groups) + inputs that have audio
  async catalog() {
    this._need();
    const { scenes } = await this.obs.call('GetSceneList');
    const order = [...scenes].sort((a, b) => (b.sceneIndex ?? 0) - (a.sceneIndex ?? 0)).map((s) => s.sceneName);
    const out = [];
    for (const name of order) {
      const items = [];
      try {
        const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: name });
        for (const it of [...sceneItems].reverse()) { // OBS lists bottom-up; the Sources dock shows top first
          items.push({ scene: name, source: it.sourceName, group: null });
          if (it.isGroup) {
            try {
              const g = await this.obs.call('GetGroupSceneItemList', { sceneName: it.sourceName });
              for (const c of [...g.sceneItems].reverse()) items.push({ scene: it.sourceName, source: c.sourceName, group: it.sourceName });
            } catch {}
          }
        }
      } catch {}
      out.push({ name, items });
    }
    const audio = [];
    try {
      const { inputs } = await this.obs.call('GetInputList');
      for (const i of inputs) {
        try { await this.obs.call('GetInputVolume', { inputName: i.inputName }); audio.push(i.inputName); } catch {}
      }
    } catch {}
    return { scenes: out, audio, pins: this.pins };
  }

  setPins({ items, audio }) {
    const it = (Array.isArray(items) ? items : []).filter((x) => x && x.scene && x.source)
      .map((x) => ({ scene: String(x.scene).slice(0, 200), source: String(x.source).slice(0, 200) }));
    const au = (Array.isArray(audio) ? audio : []).filter(Boolean).map((x) => String(x).slice(0, 200));
    if (it.length > MAX_PINS || au.length > MAX_PINS) throw new Error(`각각 ${MAX_PINS}개까지 고를 수 있어요`);
    const seen = new Set();
    this.pins = { items: it.filter((x) => !seen.has(key(x.scene, x.source)) && seen.add(key(x.scene, x.source))), audio: [...new Set(au)] };
    saveState('obs-pins', this.pins);
    this._resetMaps();
    this._load();
    return { pins: this.pins };
  }
}
