// 영도 panel backend.
//  - Viewer: grabs frames of the 영도 browser source straight from OBS, so
//    what you see is exactly what's on stream (same ads, same timing).
//    Frames are only taken while someone is looking at the page.
//  - Interact: talks to OBS's built-in browser through the Chrome DevTools
//    protocol (needs OBS launched with --remote-debugging-port), so clicks
//    on the viewer land in OBS's copy of the page, and "skip ad" can be
//    pressed for you.
import { EventEmitter } from 'node:events';
import { loadState, saveState } from './config.js';

// Picture quality for the 영도 mirror, switchable from the dashboard.
// JPEG quality is 0–100; PNG is lossless but much bigger and slower for OBS.
export const QUALITY = {
  light: { label: '가볍게 (30fps)', format: 'jpg', q: 70, maxWidth: 960, fps: 30, parallel: 2 },
  smooth: { label: '부드럽게', format: 'jpg', q: 65, maxWidth: 960, fps: 60, parallel: 3 },
  balanced: { label: '균형', format: 'jpg', q: 85, maxWidth: 1280, fps: 60, parallel: 3 },
  high: { label: '고화질', format: 'jpg', q: 95, maxWidth: 4096, fps: 60, parallel: 3 },
  lossless: { label: '무손실 (PNG)', format: 'png', q: -1, maxWidth: 4096, fps: 20, parallel: 2 },
};

export class DonationViewer {
  // key: which entry of config.sources this mirrors ('donation' or 'chat').
  constructor(obs, config, key = 'donation') {
    this.obs = obs;
    this.key = key;
    this.sourceName = config.sources[key];
    this.cfg = config.viewer;
    this.quality = key === 'donation' ? loadState('viewer', {}).quality || 'balanced' : key;
    if (key === 'donation' && !QUALITY[this.quality]) this.quality = 'balanced';
    this.size = { width: 800, height: 600 };
    this.sourceOk = false;
    this.error = null;
    obs.on('connected', () => this.refreshInfo());
    obs.on('InputSettingsChanged', ({ inputName }) => {
      if (inputName === this.sourceName) this.refreshInfo();
    });
    for (const ev of ['InputCreated', 'InputNameChanged']) obs.on(ev, ({ inputName }) => { if (inputName === this.sourceName && !this.sourceOk) this.refreshInfo(); });
  }

  async refreshInfo() {
    if (!this.sourceName) {
      this.sourceOk = false;
      this.error = 'not-set';
      return;
    }
    try {
      const { inputSettings, inputKind } = await this.obs.call('GetInputSettings', { inputName: this.sourceName });
      const { defaultInputSettings } = await this.obs.call('GetInputDefaultSettings', { inputKind }).catch(() => ({ defaultInputSettings: {} }));
      const s = { ...defaultInputSettings, ...inputSettings };
      this.size = { width: s.width || 800, height: s.height || 600 };
      this.kind = inputKind;
      // a Browser source can also point at a local file instead of a URL
      this.url = s.url || (s.is_local_file && s.local_file ? 'file:///' + String(s.local_file).replace(/\\/g, '/') : '');
      this.onUrl?.(this.url);
      this.sourceOk = true;
      this.error = inputKind === 'browser_source' || this.key !== 'donation' ? null : `"${this.sourceName}"이(가) 브라우저 소스가 아니라서 클릭 전달이 안 돼요 (${inputKind})`;
    } catch {
      this.sourceOk = false;
      this.error = `OBS에 "${this.sourceName}" 소스가 없어요 — Allmind 설정의 소스 이름을 확인해 주세요`;
    }
  }

  // One screenshot of the source from OBS. FrameFeed decides how often.
  async grab() {
    // 영도 uses the chosen preset; the 위플챗 / 도네 alert mirrors use fixed settings.
    const p = QUALITY[this.quality] || (this.key === 'alert' ? { format: 'jpg', q: 88, maxWidth: 1280 } : { format: 'jpg', q: 85, maxWidth: 720 });
    const { imageData } = await this.obs.call('GetSourceScreenshot', {
      sourceName: this.sourceName,
      imageFormat: p.format,
      imageWidth: Math.min(p.maxWidth, this.size.width),
      imageCompressionQuality: p.q,
    });
    const m = /^data:([^;]+);base64,(.*)$/s.exec(imageData);
    const type = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
    return { buf: Buffer.from(m[2], 'base64'), type, at: Date.now() };
  }

  setQuality(name) {
    if (!QUALITY[name]) throw new Error('Unknown quality');
    this.quality = name;
    saveState('viewer', { quality: name });
    this.onQuality?.(QUALITY[name]);
  }

  refresh() {
    return this.obs.call('PressInputPropertiesButton', { inputName: this.sourceName, propertyName: 'refreshnocache' });
  }

  status() {
    return { sourceName: this.sourceName, sourceOk: this.sourceOk, error: this.error, size: this.size, quality: this.quality };
  }
}

// ---------------------------------------------------------------------------
// What's on stream right now: screenshots of OBS's current program scene.
export class ProgramViewer {
  // Its own 화질 setting (same presets as the 영도), remembered across restarts.
  constructor(obs) {
    this.obs = obs;
    // 30 fps by default: it's for checking what's on stream, and every
    // preview frame is an extra render for OBS (60 fps measurably costs frames)
    this.quality = loadState('program', {}).quality || 'light';
    if (!QUALITY[this.quality]) this.quality = 'light';
    this.scene = null;
    this.baseWidth = 1920;
    obs.on('connected', () => this.refreshInfo());
    obs.on('CurrentProgramSceneChanged', ({ sceneName }) => { this.scene = sceneName; });
  }

  async refreshInfo() {
    try {
      this.scene = (await this.obs.call('GetCurrentProgramScene')).currentProgramSceneName;
      const v = await this.obs.call('GetVideoSettings');
      this.baseWidth = v.baseWidth || 1920;
    } catch {
      /* not connected yet */
    }
  }

  async grab() {
    if (!this.scene) await this.refreshInfo();
    if (!this.scene) throw new Error('no program scene');
    const p = QUALITY[this.quality];
    const { imageData } = await this.obs.call('GetSourceScreenshot', {
      sourceName: this.scene,
      imageFormat: p.format,
      imageWidth: Math.min(p.maxWidth, this.baseWidth),
      imageCompressionQuality: p.q,
    });
    const m = /^data:([^;]+);base64,(.*)$/s.exec(imageData);
    const type = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
    return { buf: Buffer.from(m[2], 'base64'), type, at: Date.now() };
  }

  setQuality(name) {
    if (!QUALITY[name]) throw new Error('Unknown quality');
    this.quality = name;
    saveState('program', { quality: name });
    this.onQuality?.(QUALITY[name]);
  }

  status() {
    return { scene: this.scene, quality: this.quality };
  }
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol link into OBS's browser source.
export class Interact extends EventEmitter {
  constructor(config) {
    super();
    this.cfg = config.interact;
    const saved = loadState('interact', {});
    // Empty match = automatic: use the URL of the 영도 source as OBS reports it.
    this.match = saved.targetUrlMatch ?? this.cfg.targetUrlMatch ?? '';
    this.autoMatch = '';
    this.autoSkip = saved.autoSkipAds ?? this.cfg.autoSkipAds;
    this.ws = null;
    this.connected = false;
    this.target = null;
    this.candidates = [];
    this.error = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> frame/target id of out-of-process iframes (e.g. the YouTube player)
    this.lastSkipAt = 0;
    if (this.cfg.enabled) {
      this._loop();
      setInterval(() => this._autoSkipTick(), 1000);
    } else {
      this.error = 'Interact is turned off in the config';
    }
  }

  async _loop() {
    while (true) {
      if (!this.connected) {
        try {
          await this._connect();
        } catch (e) {
          this._setError(e.message);
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  _setError(msg) {
    if (msg !== this.error) {
      this.error = msg;
      this.emit('change');
    }
  }

  async _connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this._connectOnce().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async _connectOnce() {
    if (this.connected) return;
    const base = `http://127.0.0.1:${this.cfg.debugPort}`;
    let list;
    try {
      const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2000) });
      list = await res.json();
    } catch {
      this.candidates = [];
      throw new Error(`OBS browser debugging isn't on — start OBS from Allmind (OBS 시작 button)`);
    }
    this.candidates = list.filter((t) => t.type === 'page').map((t) => ({ url: t.url, title: t.title }));
    const match = this.effectiveMatch();
    const target = match && list.find((t) => t.type === 'page' && t.url.includes(match));
    if (!target) {
      if (!match) this.needUrl?.(); // ask OBS again: the first answer may have come too early
      throw new Error(match ? `No OBS browser page whose URL contains "${match}" — pick the 영도 below` : (this.urlHint?.() || 'Waiting for the 영도 source URL from OBS…'));
    }
    await this._open(target);
  }

  _open(target) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener('open', async () => {
        this.ws = ws;
        this.connected = true;
        this.target = { url: target.url, title: target.title };
        this.error = null;
        this.sessions.clear();
        try {
          await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        } catch {
          /* older CEF: frames are reached through isolated worlds instead */
        }
        this.emit('change');
        resolve();
      });
      ws.addEventListener('message', (ev) => this._onMessage(JSON.parse(ev.data)));
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        reject(new Error("Couldn't open the DevTools connection (is --remote-allow-origins=* set?)"));
        if (this.ws !== ws) return; // an older connection we already replaced
        const was = this.connected;
        this.connected = false;
        this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error('DevTools connection closed'));
        this.pending.clear();
        if (was) {
          this.error = '영도 브라우저 소스와 연결이 끊겼어요 — 다시 연결하는 중…';
          this.emit('change');
        }
      };
      // As with OBS: Node's WebSocket may fire only 'error' and never 'close'.
      ws.addEventListener('error', end);
      ws.addEventListener('close', end);
    });
  }

  _onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Target.attachedToTarget') this.sessions.set(msg.params.sessionId, msg.params.targetInfo?.targetId);
    if (msg.method === 'Target.detachedFromTarget') this.sessions.delete(msg.params.sessionId);
  }

  send(method, params = {}, sessionId) {
    if (!this.connected) return Promise.reject(new Error('Not connected to the 영도 browser source'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 3000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  // One probe context per frame, created once and reused (frames are reloaded
  // when a new 영도 starts, which invalidates them; then we make a new one).
  async _worldFor(frameId) {
    if (!this.worlds) this.worlds = new Map();
    if (this.worlds.has(frameId)) return this.worlds.get(frameId);
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId, worldName: 'allmind', grantUniveralAccess: true });
    this.worlds.set(frameId, executionContextId);
    if (this.worlds.size > 50) this.worlds.delete(this.worlds.keys().next().value);
    return executionContextId;
  }

  // nx, ny are 0..1 positions on the viewer; size is the browser source's page size.
  async click(nx, ny, size) {
    const x = nx * size.width;
    const y = ny * size.height;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async hover(nx, ny, size) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx * size.width, y: ny * size.height });
  }

  async wheel(nx, ny, deltaY, size) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: nx * size.width, y: ny * size.height, deltaX: 0, deltaY });
  }

  // Finds a visible "skip ad" button in the current frame and reports where it is.
  // It doesn't click: YouTube ignores script clicks, so we click like a real mouse.
  _locateScript() {
    const sels = JSON.stringify(this.cfg.skipSelectors);
    return `(() => { for (const s of ${sels}) { const b = document.querySelector(s);
      if (b && (b.offsetWidth || b.offsetHeight)) { const r = b.getBoundingClientRect();
        return { sel: s, x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; } }
      return null; })()`;
  }

  // Where a child frame sits on the page (main-frame CSS pixels) and how it's scaled.
  async _frameOffset(frameId, frame) {
    await this.send('DOM.enable').catch(() => {});
    const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId });
    const { model } = await this.send('DOM.getBoxModel', { backendNodeId });
    const q = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
    const left = Math.min(q[0], q[2], q[4], q[6]);
    const top = Math.min(q[1], q[3], q[5], q[7]);
    const width = Math.max(q[0], q[2], q[4], q[6]) - left;
    const height = Math.max(q[1], q[3], q[5], q[7]) - top;
    return { left, top, sx: frame.vw ? width / frame.vw : 1, sy: frame.vh ? height / frame.vh : 1 };
  }

  async _trustedClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // Looks for a visible "skip ad" button in every frame of the page and
  // presses it with a real (trusted) mouse click at its position.
  async skipAd() {
    const expression = this._locateScript();
    const evalIn = (params, sessionId) =>
      this.send('Runtime.evaluate', { expression, returnByValue: true, ...params }, sessionId)
        .then((r) => (r?.exceptionDetails && !r?.result ? undefined : r?.result?.value || null))
        .catch(() => undefined);

    const finds = []; // { hit, frameId, isMain }
    // 1) frames in the page's own process, via an isolated world
    try {
      const { frameTree } = await this.send('Page.getFrameTree');
      const frames = [];
      (function collect(node, isMain) {
        frames.push({ id: node.frame.id, isMain });
        (node.childFrames || []).forEach((c) => collect(c, false));
      })(frameTree, true);
      await Promise.all(frames.map((f) =>
        this._worldFor(f.id)
          .then((contextId) => evalIn({ contextId }).then((hit) => {
            if (hit === undefined) this.worlds.delete(f.id); // context went away (page changed)
            return hit;
          }))
          .then((hit) => hit && finds.push({ hit, frameId: f.id, isMain: f.isMain }))
          .catch(() => this.worlds?.delete(f.id))));
    } catch {
      const hit = await evalIn({});
      if (hit) finds.push({ hit, isMain: true });
    }
    // 2) out-of-process iframes (the YouTube player usually is one)
    await Promise.all([...this.sessions].map(([sid, frameId]) =>
      evalIn({}, sid).then((hit) => hit && finds.push({ hit, frameId, isMain: false }))));

    for (const f of finds) {
      const b = f.hit;
      try {
        const off = f.isMain ? { left: 0, top: 0, sx: 1, sy: 1 } : await this._frameOffset(f.frameId, b);
        const x = off.left + (b.x + b.w / 2) * off.sx;
        const y = off.top + (b.y + b.h / 2) * off.sy;
        await this._trustedClick(x, y);
        console.log(`[interact] skip ad: ${b.sel} at ${Math.round(x)},${Math.round(y)}`);
        this.lastSkipAt = Date.now();
        this.emit('skipped', b.sel);
        return b.sel;
      } catch (e) {
        console.log(`[interact] skip ad: couldn't position ${b.sel}: ${e.message}`);
      }
    }
    return null;
  }

  async _autoSkipTick() {
    if (!this.autoSkip || !this.connected) return;
    // Ads only exist while a 영도 video plays: skip the probing otherwise.
    if (this.isVideoActive && !this.isVideoActive()) return;
    try {
      await this.skipAd();
    } catch {
      /* ignore */
    }
  }

  setAutoSkip(on) {
    this.autoSkip = !!on;
    this._persist();
    this.emit('change');
  }

  effectiveMatch() {
    return this.match || this.autoMatch;
  }

  // Called with the 영도 browser source's URL whenever OBS reports it.
  setSourceUrl(url) {
    let m = '';
    try {
      const u = new URL(url);
      m = u.host + u.pathname; // ignore the query string (tokens can rotate)
    } catch {
      m = url || '';
    }
    if (m === this.autoMatch) return;
    this.autoMatch = m;
    if (!this.match && this.cfg.enabled) {
      const old = this.ws;
      this.ws = null;
      this.connected = false;
      old?.close();
      this._connect().catch((e) => this._setError(e.message)).finally(() => this.emit('change'));
    }
  }

  setMatch(match) {
    this.match = String(match || '');
    this._persist();
    const old = this.ws;
    this.ws = null;
    this.connected = false;
    old?.close();
    this._connect().catch((e) => this._setError(e.message)).finally(() => this.emit('change'));
  }

  _persist() {
    saveState('interact', { targetUrlMatch: this.match, autoSkipAds: this.autoSkip });
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      connected: this.connected,
      error: this.connected ? null : this.error,
      target: this.target,
      match: this.effectiveMatch(),
      matchIsAuto: !this.match,
      candidates: this.connected ? [] : this.candidates,
      autoSkip: this.autoSkip,
      lastSkipAt: this.lastSkipAt,
    };
  }
}
