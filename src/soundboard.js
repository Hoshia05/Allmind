// Soundboard: short sound files from one folder, each a button on the
// dashboard. Drives one OBS Media Source (like the BGM player), so a new
// sound replaces the one that's playing; pressing the playing one stops it.
//
// Light: the folder is listed once and re-listed when it changes; OBS tells
// us when a sound ends (no polling).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, DATA_DIR } from './config.js';
import { Coverless } from './coverless.js';

const ACTION = (a) => `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${a}`;
const MAX_SOUNDS = 120;

export class Soundboard extends EventEmitter {
  constructor(obs, config) {
    super();
    this.obs = obs;
    this.cfg = config.soundboard || {};
    this.exts = (this.cfg.extensions || config.bgm.extensions || ['.mp3', '.wav', '.ogg']).map((e) => e.toLowerCase());
    this.sourceName = config.sources.soundboard || 'Soundboard';
    this.bgmName = config.sources.bgm;
    this.coverless = new Coverless(path.join(DATA_DIR, 'bgm-cache'));
    const saved = loadState('soundboard', {});
    this.volumeDb = Number.isFinite(saved.volumeDb) ? saved.volumeDb : (this.cfg.volumeDb ?? -10);
    this.sounds = [];
    this.folderError = null;
    this.sourceOk = false;
    this.playing = null; // id of the sound that's playing
    this.playSeq = 0;

    this.rescan();
    this._watch();
    obs.on('connected', () => this._onConnected());
    obs.on('disconnected', () => { this.sourceOk = false; this.playing = null; this._changed(); });
    obs.on('MediaInputPlaybackEnded', ({ inputName }) => {
      if (inputName !== this.sourceName || !this.playing) return;
      // OBS also reports "ended" for the old file when we load a new one;
      // only clear if no newer play started in the last moment.
      const seq = this.playSeq;
      setTimeout(() => { if (seq === this.playSeq && Date.now() - this.startedAt > 250) { this.playing = null; this._changed(); } }, 120);
    });
    obs.on('InputCreated', ({ inputName }) => inputName === this.sourceName && this._onConnected());
    obs.on('InputRemoved', ({ inputName }) => { if (inputName === this.sourceName) { this.sourceOk = false; this._changed(); } });
    if (obs.connected) this._onConnected();
  }

  // ---------- folder ----------
  rescan() {
    const folder = this.cfg.folder;
    if (!folder) {
      this.folderError = 'none';
      this.sounds = [];
    } else if (!fs.existsSync(folder)) {
      this.folderError = `사운드보드 폴더를 찾을 수 없어요: ${folder}`;
      this.sounds = [];
    } else {
      this.folderError = null;
      const out = [];
      const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= MAX_SOUNDS) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (this.exts.includes(path.extname(e.name).toLowerCase())) out.push(path.relative(folder, full));
        }
      };
      walk(folder);
      out.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
      this.sounds = out.map((id) => ({ id, title: path.parse(id).name }));
    }
    this._changed();
  }

  // New files dropped into the folder show up by themselves.
  _watch() {
    if (!this.cfg.folder || !fs.existsSync(this.cfg.folder)) return;
    try {
      let t = null;
      this.watcher = fs.watch(this.cfg.folder, { recursive: true }, () => {
        clearTimeout(t);
        t = setTimeout(() => this.rescan(), 800);
      });
      this.watcher.on('error', () => {});
    } catch {}
  }

  // ---------- OBS ----------
  async _onConnected() {
    try {
      await this.obs.call('GetInputSettings', { inputName: this.sourceName });
      this.sourceOk = true;
      await this._applyVolume();
    } catch {
      this.sourceOk = false;
    }
    this._changed();
  }

  async play(id) {
    if (!this.sourceOk) throw new Error(`OBS에 "${this.sourceName}" 소스가 없어요 — 사운드보드에서 만들어 주세요`);
    if (!this.sounds.some((s) => s.id === id)) throw new Error('없는 사운드예요');
    if (this.playing === id) return this.stop(); // press again = stop
    const seq = ++this.playSeq;
    this.playing = id;
    this.startedAt = Date.now();
    this._changed();
    const file = await this.coverless.fileFor(path.join(this.cfg.folder, id));
    if (seq !== this.playSeq) return;
    await this.obs.call('SetInputSettings', {
      inputName: this.sourceName,
      inputSettings: { is_local_file: true, local_file: file, looping: false, restart_on_activate: false, close_when_inactive: false, clear_on_media_end: true },
    });
    await this.obs.call('TriggerMediaInputAction', { inputName: this.sourceName, mediaAction: ACTION('RESTART') }).catch(() => {});
  }

  async stop() {
    this.playSeq++;
    this.playing = null;
    this._changed();
    if (this.sourceOk) await this.obs.call('TriggerMediaInputAction', { inputName: this.sourceName, mediaAction: ACTION('STOP') }).catch(() => {});
  }

  async setVolume(db) {
    this.volumeDb = Math.max(-60, Math.min(0, Number(db)));
    saveState('soundboard', { volumeDb: this.volumeDb });
    await this._applyVolume();
    this._changed();
  }

  async _applyVolume() {
    if (this.sourceOk) await this.obs.call('SetInputVolume', { inputName: this.sourceName, inputVolumeDb: this.volumeDb }).catch(() => {});
  }

  // Creates the source wherever the BGM source is, so sounds play in every
  // scene the music plays in. Copies the BGM source's audio tracks and
  // monitoring, so the recording's track split stays the same.
  async createSource() {
    const { scenes, currentProgramSceneName } = await this.obs.call('GetSceneList');
    const targets = new Set();
    const groups = new Set();
    for (const { sceneName } of scenes) {
      let items = [];
      try { items = (await this.obs.call('GetSceneItemList', { sceneName })).sceneItems; } catch { continue; }
      if (items.some((i) => i.sourceName === this.bgmName)) targets.add(sceneName);
      for (const g of items.filter((i) => i.isGroup)) {
        try {
          const inner = (await this.obs.call('GetGroupSceneItemList', { sceneName: g.sourceName })).sceneItems;
          if (inner.some((i) => i.sourceName === this.bgmName)) { groups.add(g.sourceName); targets.add(sceneName); }
        } catch {}
      }
    }
    const first = [...groups][0] || [...targets][0] || currentProgramSceneName;
    let placed = new Set();
    // into the BGM's group if possible (one item covers every scene with that group)
    try {
      await this.obs.call('CreateInput', { sceneName: first, inputName: this.sourceName, inputKind: 'ffmpeg_source', inputSettings: { is_local_file: true, looping: false, restart_on_activate: false, close_when_inactive: false, clear_on_media_end: true }, sceneItemEnabled: true });
      placed.add(first);
    } catch (e) {
      if (!groups.has(first)) throw e;
      await this.obs.call('CreateInput', { sceneName: currentProgramSceneName, inputName: this.sourceName, inputKind: 'ffmpeg_source', inputSettings: { is_local_file: true, looping: false, close_when_inactive: false }, sceneItemEnabled: true });
      placed.add(currentProgramSceneName);
      groups.clear();
    }
    // every other scene the BGM plays in, unless the group already covers it
    if (!groups.size) {
      for (const s of targets) {
        if (placed.has(s)) continue;
        try { await this.obs.call('CreateSceneItem', { sceneName: s, sourceName: this.sourceName, sceneItemEnabled: true }); placed.add(s); } catch {}
      }
    }
    try {
      const { monitorType } = await this.obs.call('GetInputAudioMonitorType', { inputName: this.bgmName });
      await this.obs.call('SetInputAudioMonitorType', { inputName: this.sourceName, monitorType });
      const { inputAudioTracks } = await this.obs.call('GetInputAudioTracks', { inputName: this.bgmName });
      await this.obs.call('SetInputAudioTracks', { inputName: this.sourceName, inputAudioTracks });
    } catch {
      await this.obs.call('SetInputAudioMonitorType', { inputName: this.sourceName, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }).catch(() => {});
    }
    await this._onConnected();
    return [...placed];
  }

  status() {
    return {
      sourceName: this.sourceName,
      sourceOk: this.sourceOk,
      folder: this.cfg.folder || '',
      folderError: this.folderError,
      sounds: this.sounds,
      playing: this.playing,
      volumeDb: this.volumeDb,
    };
  }

  _changed() {
    this.emit('change');
  }
}
