// BGM setlist: scans a music folder on the stream PC and drives one OBS
// Media Source with it. Also owns auto-pause: when the 영도 source makes
// sound, the BGM pauses (or ducks) and comes back after it goes quiet.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, DATA_DIR } from './config.js';
import { Coverless } from './coverless.js';

const ACTION = (a) => `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${a}`;
const PLAY_MODES = ['loop-list', 'shuffle', 'repeat-one'];
// OBS reports these while a file is starting; to the user that's "playing".
const PLAYING_STATES = new Set(['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_OPENING', 'OBS_MEDIA_STATE_BUFFERING']);
// Compare file paths the way Windows does: either slash, any case.
const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

function walk(dir, exts, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, base, out);
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(path.relative(base, full));
  }
  return out;
}

export class BGM extends EventEmitter {
  constructor(obs, config) {
    super();
    this.obs = obs;
    this.cfg = config.bgm;
    this.sourceName = config.sources.bgm;
    this.donationName = config.sources.donation;
    this.coverless = new Coverless(path.join(DATA_DIR, 'bgm-cache'));
    this.fileOf = new Map(); // song id → file OBS actually loads
    this.idOfFile = new Map(); // and back (normalised path → id)

    const saved = loadState('bgm', {});
    this.order = saved.order || [];
    this.currentId = saved.currentId || null;
    this.volumeDb = saved.volumeDb ?? this.cfg.defaultVolumeDb;
    this.playMode = PLAY_MODES.includes(saved.playMode) ? saved.playMode : 'loop-list';
    this.autoPause = { ...config.autoPause, ...(saved.autoPause || {}) };

    this.tracks = new Map(); // id -> { id, title, folder }
    this.media = { state: 'unknown', cursor: 0, duration: 0, playing: false };
    this.sourceActive = true; // is the BGM source in the scene that's on air?
    this.selectedAt = 0;
    this.cmdSeq = 0; // bumps on every command; stale status reads are discarded
    this.playedSinceSelect = false;
    this.queue = Promise.resolve(); // transport commands run one at a time
    this.endedHandledFor = null;
    this.sourceOk = false;
    this.sourceError = null;
    this.folderError = null;

    // auto-pause runtime
    this.level = -Infinity; // 영도 peak dB
    this.loudSince = null;
    this.lastLoud = 0;
    this.autoActive = false; // currently holding BGM down because of a 영도
    this.autoPausedBgm = false; // we paused it (so we may resume it)

    this.rescan();
    obs.on('connected', () => this._onConnected());
    obs.on('MediaInputPlaybackEnded', ({ inputName }) => {
      if (inputName === this.sourceName) this._refresh(true);
    });
    // Anything that changes the player in OBS (including someone using OBS's own
    // media controls) → re-read the truth right away instead of waiting for the poll.
    for (const ev of ['MediaInputPlaybackStarted', 'MediaInputActionTriggered', 'InputSettingsChanged', 'SceneItemEnableStateChanged', 'CurrentProgramSceneChanged']) {
      obs.on(ev, (d) => {
        if (!d.inputName || d.inputName === this.sourceName) this._refresh();
      });
    }
    obs.on('InputVolumeMeters', ({ inputs }) => this._onMeters(inputs));
    obs.on('disconnected', () => {
      this.level = -Infinity;
      this.sourceOk = false;
      this.sourceError = null;
      this.media = { state: 'unknown', cursor: 0, duration: 0, playing: false };
      this._changed();
    });
    obs.on('InputRemoved', ({ inputName }) => {
      if (inputName === this.sourceName) { this.sourceOk = false; this.sourceError = 'BGM source was removed in OBS'; this._changed(); }
    });

    // Song changes and endings arrive as OBS events; the poll only moves the
    // progress bar. So: every second while a dashboard is open, every 5 s otherwise.
    this.watching = () => true; // set by the server
    let idle = 0;
    setInterval(() => { if (this.watching() || ++idle % 5 === 0) this._refresh(); }, 1000);
    setInterval(() => this._autoTick(Date.now()), 200);
  }

  // ---------- setlist ----------
  rescan() {
    const folder = this.cfg.folder;
    if (!fs.existsSync(folder)) {
      this.folderError = `Music folder not found: ${folder} — 설정에서 음악 폴더를 지정해 주세요`;
      this.tracks.clear();
    } else {
      this.folderError = null;
      const files = walk(folder, this.cfg.extensions.map((e) => e.toLowerCase()));
      this.tracks = new Map(
        files.map((rel) => {
          const parsed = path.parse(rel);
          return [rel, { id: rel, title: parsed.name, folder: parsed.dir }];
        }),
      );
    }
    const known = this.order.filter((id) => this.tracks.has(id));
    const added = [...this.tracks.keys()].filter((id) => !known.includes(id)).sort((a, b) => a.localeCompare(b));
    this.order = [...known, ...added];
    if (this.currentId && !this.tracks.has(this.currentId)) this.currentId = null;
    this._persist();
    this._changed();
  }

  move(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
    this._persist();
    this._changed();
  }

  // ---------- transport ----------
  // Commands run strictly one after another, so a burst of "next" presses
  // can't interleave half-finished song switches.
  _cmd(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  select(id) { return this._cmd(() => this._select(id)); }
  play() { return this._cmd(() => this._play()); }
  pause() { return this._cmd(() => this._pause()); }
  toggle() {
    // Decide from OBS's current state, not a possibly second-old copy.
    return this._cmd(async () => {
      await this._refresh(true);
      return this.media.playing ? this._pause() : this._play();
    });
  }
  next() { return this._cmd(() => this._select(this._pickNext(1))); }
  prev() {
    return this._cmd(async () => {
      await this._refresh(true);
      // Like most players: restart the song if we're more than 3s in.
      if (this.media.cursor > 3000) return this._seek(0);
      return this._select(this._pickNext(-1));
    });
  }
  seek(ms) { return this._cmd(() => this._seek(ms)); }

  async _select(id) {
    if (!this.tracks.has(id)) throw new Error('Unknown track');
    this.cmdSeq++;
    this.currentId = id;
    this.autoPausedBgm = false;
    this.selectedAt = Date.now();
    this.playedSinceSelect = false;
    // OBS gets an audio-only copy when the file has cover art (see coverless.js)
    const file = await this._fileFor(id);
    await this.obs.call('SetInputSettings', {
      inputName: this.sourceName,
      inputSettings: {
        is_local_file: true,
        local_file: file,
        looping: false,
        restart_on_activate: false,
        close_when_inactive: false,
        clear_on_media_end: false,
      },
    });
    // RESTART, not PLAY: after a song has ended, OBS ignores PLAY and would
    // stay "ended" (which then looked like another song ending).
    await this._action('RESTART').catch(() => {});
    this._persist();
    // Make sure it really started; nudge once more if not.
    for (let i = 0; i < 8; i++) {
      await sleep(150);
      await this._refresh(true);
      if (this.media.playing) break;
      if (i === 3) await this._action('RESTART').catch(() => {});
    }
    await this._resetMonitoring();
    console.log(`[bgm] now playing: ${id} (${this.media.state})`);
    this._prepareNext(id);
  }

  async _fileFor(id) {
    const file = await this.coverless.fileFor(path.join(this.cfg.folder, id));
    this.fileOf.set(id, file);
    this.idOfFile.set(normPath(file), id);
    return file;
  }

  // Make the next song's art-free copy in the background, so it starts at once.
  _prepareNext(id) {
    if (this.playMode !== 'loop-list') return;
    const next = this.order[(this.order.indexOf(id) + 1) % this.order.length];
    if (next && next !== id) setTimeout(() => this._fileFor(next).catch(() => {}), 3000);
  }

  // OBS quirk: after a Media Source switches files (especially to a song with a
  // different sample rate), the *monitoring* copy (your headphones) can go
  // silent while the meter and the stream still have audio. Re-applying the
  // monitoring setting resets that feed. The stream/recording output is not
  // touched by this.
  async _resetMonitoring() {
    try {
      const { monitorType } = await this.obs.call('GetInputAudioMonitorType', { inputName: this.sourceName });
      if (!monitorType || monitorType === 'OBS_MONITORING_TYPE_NONE') return;
      await this.obs.call('SetInputAudioMonitorType', { inputName: this.sourceName, monitorType: 'OBS_MONITORING_TYPE_NONE' });
      await sleep(60);
      await this.obs.call('SetInputAudioMonitorType', { inputName: this.sourceName, monitorType });
    } catch (e) {
      console.warn('[bgm] monitor reset failed:', e.message);
    }
  }

  async _play() {
    this.cmdSeq++;
    this.autoPausedBgm = false;
    if (!this.currentId) {
      const first = this.order[0];
      if (!first) throw new Error('No tracks in the setlist');
      return this._select(first);
    }
    await this._refresh(true);
    if (!this._fileMatches() || ['OBS_MEDIA_STATE_ENDED', 'OBS_MEDIA_STATE_STOPPED', 'OBS_MEDIA_STATE_NONE', 'OBS_MEDIA_STATE_ERROR'].includes(this.media.state)) {
      return this._select(this.currentId);
    }
    await this._action('PLAY');
    await this._refresh(true);
  }

  async _pause() {
    this.cmdSeq++;
    this.autoPausedBgm = false;
    await this._action('PAUSE');
    await this._refresh(true);
  }

  async _seek(ms) {
    this.cmdSeq++;
    await this.obs.call('SetMediaInputCursor', { inputName: this.sourceName, mediaCursor: Math.max(0, Math.round(ms)) });
    await this._refresh(true);
  }

  _fileMatches() {
    if (!this.loadedFile || !this.currentId) return true;
    return this.idOfFile.get(this.loadedFile) === this.currentId || this.loadedFile === normPath(path.join(this.cfg.folder, this.currentId));
  }

  async setVolume(db) {
    this.volumeDb = Math.max(-60, Math.min(0, Number(db)));
    if (!(this.autoActive && this.autoPause.mode === 'duck')) await this._applyVolume(this.volumeDb);
    this._persist();
    this._changed();
  }

  setPlayMode(mode) {
    if (!PLAY_MODES.includes(mode)) throw new Error('Unknown play mode');
    this.playMode = mode;
    this._persist();
    this._changed();
  }

  setAutoPause(patch) {
    const allowed = ['enabled', 'mode', 'thresholdDb', 'triggerMs', 'resumeAfterMs', 'duckDb', 'introHoldMs'];
    for (const k of allowed) if (k in patch) this.autoPause[k] = patch[k];
    if (!this.autoPause.enabled && this.autoActive) this._release();
    this._persist();
    this._changed();
  }

  // Creates the Media Source in the current scene if it doesn't exist yet.
  async createSource() {
    const { currentProgramSceneName } = await this.obs.call('GetSceneList');
    await this.obs.call('CreateInput', {
      sceneName: currentProgramSceneName,
      inputName: this.sourceName,
      inputKind: 'ffmpeg_source',
      inputSettings: { is_local_file: true, looping: false, restart_on_activate: false, close_when_inactive: false },
      sceneItemEnabled: true,
    });
    await this.obs.call('SetInputAudioMonitorType', {
      inputName: this.sourceName,
      monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    });
    await this._onConnected();
    return currentProgramSceneName;
  }

  _pickNext(dir) {
    const n = this.order.length;
    if (!n) throw new Error('No tracks in the setlist');
    const i = this.order.indexOf(this.currentId);
    if (this.playMode === 'shuffle' && n > 1) {
      let j;
      do j = Math.floor(Math.random() * n); while (j === i);
      return this.order[j];
    }
    return this.order[i < 0 ? 0 : (i + dir + n) % n];
  }

  // Go to the next song when OBS says this one finished. Guarded so that the
  // "ended" OBS reports while switching files doesn't skip an extra song, and
  // each song only advances once (event and poll can both notice).
  _maybeAdvance() {
    if (this.media.state !== 'OBS_MEDIA_STATE_ENDED') return;
    // Only a song we actually saw playing can "finish". This stops a cascade
    // if OBS reports "ended" for a file that never started.
    if (!this.playedSinceSelect) return;
    if (Date.now() - this.selectedAt < 2000) return;
    if (!this.currentId || this.endedHandledFor === this.currentId + '@' + this.selectedAt) return;
    this.endedHandledFor = this.currentId + '@' + this.selectedAt;
    const id = this.playMode === 'repeat-one' ? this.currentId : this._pickNext(1);
    console.log(`[bgm] song ended, next: ${id}`);
    this.select(id).catch((e) => console.warn('[bgm] advance failed:', e.message));
  }


  _action(a) {
    return this.obs.call('TriggerMediaInputAction', { inputName: this.sourceName, mediaAction: ACTION(a) });
  }

  _applyVolume(db) {
    return this.obs.call('SetInputVolume', { inputName: this.sourceName, inputVolumeDb: db });
  }

  async _onConnected() {
    try {
      const { inputKind } = await this.obs.call('GetInputSettings', { inputName: this.sourceName });
      if (inputKind !== 'ffmpeg_source') {
        this.sourceOk = false;
        this.sourceError = `"${this.sourceName}" exists but is a ${inputKind}, not a Media Source`;
      } else {
        this.sourceOk = true;
        this.sourceError = null;
        await this._applyVolume(this.volumeDb);
      }
    } catch {
      this.sourceOk = false;
      this.sourceError = `No Media Source named "${this.sourceName}" in OBS yet`;
    }
    this._changed();
  }

  // Reads what OBS is really doing: play state, which file, and whether the
  // source is on air.
  //  - fresh=true waits for any read already in flight and does a new one,
  //    so a command never acts on information from before it ran.
  //  - A read that started before the latest command is thrown away; that was
  //    the bug that made the panel jump back to the previous song.
  async _refresh(fresh = false) {
    if (!this.obs.connected || !this.sourceOk) return;
    if (this.refreshing) {
      if (!fresh) return this.refreshing;
      await this.refreshing;
    }
    const seq = this.cmdSeq;
    this.refreshing = (async () => {
      try {
        // Play state every time; which file / on-air-ness change rarely, so
        // read those on commands, on OBS events, and every 3rd poll.
        const full = fresh || !this.lastFullRead || Date.now() - this.lastFullRead > 15000; // events cover the rest
        const [s, settings, active] = await Promise.all([
          this.obs.call('GetMediaInputStatus', { inputName: this.sourceName }),
          full ? this.obs.call('GetInputSettings', { inputName: this.sourceName }) : null,
          full ? this.obs.call('GetSourceActive', { sourceName: this.sourceName }).catch(() => ({ videoActive: true })) : null,
        ]);
        if (full) this.lastFullRead = Date.now();
        if (seq !== this.cmdSeq) return; // a command ran meanwhile; this read is stale
        this.media = {
          state: s.mediaState,
          cursor: s.mediaCursor ?? 0,
          duration: s.mediaDuration ?? 0,
          playing: PLAYING_STATES.has(s.mediaState),
          loading: s.mediaState === 'OBS_MEDIA_STATE_OPENING' || s.mediaState === 'OBS_MEDIA_STATE_BUFFERING',
        };
        if (s.mediaState === 'OBS_MEDIA_STATE_PLAYING') this.playedSinceSelect = true;
        // "videoActive" = shown in the program output. Audio only plays then.
        if (active) this.sourceActive = active.videoActive !== false;
        // The highlighted song is whatever file OBS actually has loaded.
        const file = settings ? normPath(settings.inputSettings?.local_file) : null;
        if (settings) this.loadedFile = file || null; // light polls keep the last full read
        if (file) {
          const base = normPath(this.cfg.folder).replace(/\/$/, '') + '/';
          const rel = file.startsWith(base) ? file.slice(base.length) : null;
          // an art-free copy from before a Allmind restart: it's the saved current song
          const cached = file.startsWith(normPath(this.coverless.dir) + '/') && this.currentId;
          if (cached && !this.idOfFile.has(file)) this.idOfFile.set(file, this.currentId);
          const id = this.idOfFile.get(file) || (rel && this.order.find((t) => normPath(t) === rel));
          this.loadedOutside = !id; // a file that isn't in the setlist folder
          if (id && id !== this.currentId) {
            // OBS has a different song than we think (changed in OBS itself).
            this.currentId = id;
            this.selectedAt = Date.now();
            this.playedSinceSelect = this.media.state === 'OBS_MEDIA_STATE_PLAYING';
            this._persist();
          }
        }
        this._maybeAdvance();
        // Only the position moved → a tiny progress update instead of the whole state
        const { cursor, ...rest } = this.media;
        const key = JSON.stringify([rest, this.currentId, this.sourceActive, this.loadedOutside]);
        if (key === this.lastKey && !fresh) this.emit('pos', { cursor, duration: this.media.duration, state: this.media.state });
        else { this.lastKey = key; this._changed(); }
      } catch {
        /* transient */
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  // ---------- auto-pause ----------
  _onMeters(inputs) {
    const inp = inputs.find((i) => i.inputName === this.donationName);
    if (!inp) return;
    let peak = 0;
    for (const ch of inp.inputLevelsMul || []) peak = Math.max(peak, ch[1] ?? 0);
    this.level = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    this._autoTick(Date.now());
  }

  _autoTick(now) {
    const ap = this.autoPause;
    if (!ap.enabled) return;
    if (this.level > ap.thresholdDb) {
      this.lastLoud = now;
      if (this.loudSince === null) this.loudSince = now;
      if (!this.autoActive && now - this.loudSince >= ap.triggerMs) this._engage();
    } else {
      this.loudSince = null;
      if (this.autoActive && this._mayResume(now)) this._release();
    }
  }

  // A 영도 starts with a short alert sound, then a few silent seconds while
  // the video loads, then the video. So after the first sound, stay paused for
  // a while (introHoldMs) even through silence — and for as long as the
  // 치지직 리모컨 says a 영도 is playing.
  _mayResume(now) {
    const ap = this.autoPause;
    const quiet = now - this.lastLoud;
    if (quiet < ap.resumeAfterMs) return false;
    if (now - this.engagedAt < (ap.introHoldMs ?? 10000)) return false;
    // the 리모컨 can tell us a video is still on; cap it in case it's wrong
    if (this.holdWhile?.() && quiet < 60000) return false;
    return true;
  }

  async _engage() {
    this.autoActive = true;
    this.engagedAt = Date.now();
    this._changed();
    try {
      if (this.autoPause.mode === 'duck') {
        await this._applyVolume(this.volumeDb + this.autoPause.duckDb);
      } else {
        await this._refresh();
        if (this.media.playing) {
          await this._action('PAUSE');
          this.autoPausedBgm = true;
          await this._refresh();
        }
      }
    } catch (e) {
      console.warn('[bgm] auto-pause failed:', e.message);
    }
    this._changed();
  }

  async _release() {
    this.autoActive = false;
    try {
      if (this.autoPause.mode === 'duck') await this._applyVolume(this.volumeDb);
      if (this.autoPausedBgm) {
        this.autoPausedBgm = false;
        await this._action('PLAY');
        await this._refresh();
      }
    } catch (e) {
      console.warn('[bgm] auto-resume failed:', e.message);
    }
    this._changed();
  }

  // ---------- plumbing ----------
  _persist() {
    saveState('bgm', {
      order: this.order,
      currentId: this.currentId,
      volumeDb: this.volumeDb,
      playMode: this.playMode,
      autoPause: this.autoPause,
    });
  }

  _changed() {
    this.emit('change');
  }

  snapshot() {
    return {
      sourceName: this.sourceName,
      sourceOk: this.sourceOk,
      sourceError: this.sourceError,
      folder: this.cfg.folder,
      folderError: this.folderError,
      tracks: this.order.map((id) => this.tracks.get(id)),
      currentId: this.currentId,
      media: this.media,
      sourceActive: this.sourceActive,
      loadedOutside: !!this.loadedOutside,
      volumeDb: this.volumeDb,
      playMode: this.playMode,
      autoPause: { ...this.autoPause, active: this.autoActive, heldPaused: this.autoPausedBgm },
    };
  }

  levelDb() {
    return Number.isFinite(this.level) ? Math.round(this.level * 10) / 10 : -100;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
