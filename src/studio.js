// OBS controls for the dashboard: scene buttons, mic mute + level, and stream
// health (bitrate, dropped frames, encoder/render lag).
//
// Lean by design: scenes and mute come from OBS events (no polling); the mic
// level rides on the volume meters OBS already sends; stats are polled once
// every 2 s, only while someone is watching or the mirrors need the load guard,
// and that one poll feeds both the health line and the guard.
import { EventEmitter } from 'node:events';

const POLL_MS = 2000;

export class Studio extends EventEmitter {
  constructor(obs, cfg = {}) {
    super();
    this.obs = obs;
    this.micSetting = (cfg.mic || '').trim(); // '' = OBS's own "Mic/Aux" device
    this.scenes = [];
    this.scene = '';
    this.mic = { name: '', ok: false, muted: false, error: '' };
    this.micPeak = 0; // highest level since the last read (linear)
    this.health = null;
    this.prev = null; // previous stats sample, for per-interval rates
    this.wanted = () => false; // set by the server: is anyone watching?

    obs.on('connected', () => this._load());
    obs.on('disconnected', () => {
      this.scenes = [];
      this.scene = '';
      this.mic = { ...this.mic, ok: false };
      this.health = null;
      this.prev = null;
      this.emit('change');
    });
    obs.on('SceneListChanged', () => this._loadScenes());
    obs.on('SceneNameChanged', () => this._loadScenes());
    obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      this.scene = sceneName;
      this.emit('change');
    });
    obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
      if (inputName !== this.mic.name) return;
      this.mic.muted = inputMuted;
      this.emit('change');
    });
    obs.on('InputNameChanged', ({ oldInputName, inputName }) => {
      if (oldInputName === this.mic.name) { this.mic.name = inputName; this.emit('change'); }
    });
    obs.on('InputCreated', () => !this.mic.ok && this._loadMic());
    obs.on('InputRemoved', ({ inputName }) => inputName === this.mic.name && this._loadMic());
    obs.on('InputVolumeMeters', ({ inputs }) => {
      if (!this.mic.ok) return;
      const inp = inputs.find((i) => i.inputName === this.mic.name);
      if (!inp) return;
      for (const ch of inp.inputLevelsMul || []) this.micPeak = Math.max(this.micPeak, ch[1] ?? 0);
    });

    if (obs.connected) this._load();
    this.timer = setInterval(() => this._poll(), POLL_MS);
  }

  async _load() {
    await Promise.all([this._loadScenes(), this._loadMic()]);
  }

  async _loadScenes() {
    try {
      const r = await this.obs.call('GetSceneList');
      // OBS lists them bottom-up; the scene dock shows the highest index on top
      this.scenes = [...r.scenes].sort((a, b) => (b.sceneIndex ?? 0) - (a.sceneIndex ?? 0)).map((s) => s.sceneName);
      this.scene = r.currentProgramSceneName || this.scene;
      this.emit('change');
    } catch {}
  }

  async _loadMic() {
    let name = this.micSetting;
    try {
      if (!name) name = (await this.obs.call('GetSpecialInputs')).mic1 || '';
      if (!name) {
        this.mic = { name: '', ok: false, muted: false, error: 'OBS 설정 → 오디오에 마이크가 없어요. 방송 PC의 Allmind 설정에서 마이크 소스를 골라 주세요' };
      } else {
        const r = await this.obs.call('GetInputMute', { inputName: name });
        this.mic = { name, ok: true, muted: !!r.inputMuted, error: '' };
      }
    } catch {
      this.mic = { name, ok: false, muted: false, error: `"${name}" 소스를 OBS에서 찾을 수 없어요` };
    }
    this.emit('change');
  }

  async setScene(name) {
    if (!this.scenes.includes(name)) throw new Error(`"${name}" 장면이 없어요`);
    await this.obs.call('SetCurrentProgramScene', { sceneName: name });
    this.scene = name; // the event follows; this makes the button light up at once
    this.emit('change');
  }

  async toggleMic() {
    if (!this.mic.ok) throw new Error(this.mic.error || '마이크 소스를 찾을 수 없어요');
    const r = await this.obs.call('ToggleInputMute', { inputName: this.mic.name });
    this.mic.muted = !!r.inputMuted;
    this.emit('change');
    return this.mic.muted;
  }

  // mic level for the 10 Hz meter event: peak since the last call, in dB
  micDb() {
    const p = this.micPeak;
    this.micPeak = 0;
    if (!this.mic.ok || this.mic.muted) return -100;
    return p > 0 ? Math.round(20 * Math.log10(p) * 10) / 10 : -100;
  }

  async _poll() {
    if (!this.obs.connected || !this.wanted()) { this.prev = null; return; }
    let st, ss;
    try {
      [st, ss] = await Promise.all([this.obs.call('GetStats'), this.obs.call('GetStreamStatus').catch(() => null)]);
    } catch {
      return;
    }
    this.emit('stats', st); // the mirror load guard listens to this
    const now = Date.now();
    const cur = {
      at: now,
      bytes: ss?.outputBytes ?? 0,
      netSkip: ss?.outputSkippedFrames ?? 0,
      netTotal: ss?.outputTotalFrames ?? 0,
      encSkip: st.outputSkippedFrames ?? 0,
      encTotal: st.outputTotalFrames ?? 0,
      renSkip: st.renderSkippedFrames ?? 0,
      renTotal: st.renderTotalFrames ?? 0,
    };
    const p = this.prev && this.prev.live === !!ss?.outputActive ? this.prev : null;
    this.prev = { ...cur, live: !!ss?.outputActive };
    const pct = (skip, total, k) => {
      const ds = skip - (p ? p[k + 'Skip'] : skip), dt = total - (p ? p[k + 'Total'] : total);
      return dt > 0 ? Math.max(0, (100 * ds) / dt) : 0;
    };
    const h = {
      live: !!ss?.outputActive,
      reconnecting: !!ss?.outputReconnecting,
      kbps: p && ss?.outputActive ? Math.max(0, Math.round(((cur.bytes - p.bytes) * 8) / (now - p.at))) : null,
      // over the last 2 s — what's happening now
      dropPct: round2(pct(cur.netSkip, cur.netTotal, 'net')),
      encPct: round2(pct(cur.encSkip, cur.encTotal, 'enc')),
      renPct: round2(pct(cur.renSkip, cur.renTotal, 'ren')),
      // whole broadcast so far
      dropTotal: cur.netSkip,
      dropTotalPct: cur.netTotal ? round2((100 * cur.netSkip) / cur.netTotal) : 0,
      congestion: ss?.outputCongestion != null ? round2(ss.outputCongestion) : null,
      fps: st.activeFps ? Math.round(st.activeFps) : null,
      cpu: st.cpuUsage != null ? Math.round(st.cpuUsage) : null,
    };
    const worst = Math.max(h.dropPct, h.encPct, h.renPct);
    h.level = h.reconnecting || worst >= 3 ? 'bad' : worst >= 0.5 || (h.congestion ?? 0) >= 0.3 ? 'warn' : 'ok';
    this.health = h;
    this.emit('health', h);
  }

  status() {
    return { scenes: this.scenes, scene: this.scene, mic: this.mic };
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
