// Minimal obs-websocket v5 client (built into OBS 28+). No dependencies:
// uses the WebSocket client built into Node 22.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 };
// All normal event categories + InputVolumeMeters (high-volume, opt-in).
const EVENT_SUBSCRIPTIONS = 0x7ff | (1 << 16);

function sha256b64(s) {
  return crypto.createHash('sha256').update(s).digest('base64');
}

export class OBSClient extends EventEmitter {
  constructor({ url, password }) {
    super();
    this.setMaxListeners(30); // many modules each listen for connected/closed once — not a leak
    this.url = url;
    this.password = password || '';
    this.ws = null;
    this.connected = false;
    this.pending = new Map();
    this.nextId = 1;
    this.retryMs = 1000;
    this.stopped = false;
    this.lastError = null;
    this.version = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  _connect() {
    let ws;
    try {
      ws = new WebSocket(this.url, 'obswebsocket.json');
    } catch (err) {
      this._fail(err.message);
      return;
    }
    this.ws = ws;

    // Node's WebSocket fires only 'error' (no 'close') when the connection is
    // refused, so both paths funnel into one "ended" handler.
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      const wasConnected = this.connected;
      this.connected = false;
      for (const { reject } of this.pending.values()) reject(new Error('OBS disconnected'));
      this.pending.clear();
      if (code === 4009) {
        if (!this.lastError?.startsWith('OBS가 비밀번호')) console.warn('[obs] OBS rejected the password (Allmind settings → OBS 비밀번호 vs. OBS → 도구 → WebSocket 서버 설정)');
        this.lastError = 'OBS가 비밀번호를 거절했어요 — Allmind 설정의 OBS 비밀번호를 확인해 주세요';
      }
      else if (!wasConnected && code !== 4009 && !this.lastError?.startsWith('OBS가 비밀번호')) this.lastError = `OBS(${this.url})에 연결할 수 없어요 — OBS가 켜져 있고 WebSocket 서버가 켜져 있는지 확인해 주세요`;
      if (wasConnected) {
        this.lastError = 'OBS 연결이 끊겼어요 — 다시 연결하는 중…';
        console.log(`[obs] disconnected${code ? ` (code ${code})` : ''}`);
        this.emit('disconnected');
      }
      this.emit('status');
      this._retry();
    };
    ws.addEventListener('message', (ev) => this._onMessage(JSON.parse(ev.data)));
    ws.addEventListener('error', () => end());
    ws.addEventListener('close', (ev) => end(ev.code));
  }

  _retry() {
    if (this.stopped) return;
    setTimeout(() => this._connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }

  _fail(msg) {
    this.lastError = msg;
    this.emit('status');
    this._retry();
  }

  _send(op, d) {
    this.ws.send(JSON.stringify({ op, d }));
  }

  _onMessage({ op, d }) {
    switch (op) {
      case OP.Hello: {
        const identify = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
        if (d.authentication) {
          const secret = sha256b64(this.password + d.authentication.salt);
          identify.authentication = sha256b64(secret + d.authentication.challenge);
        }
        this.version = d.obsWebSocketVersion;
        this._send(OP.Identify, identify);
        break;
      }
      case OP.Identified:
        this.retryMs = 1000;
        // OBS accepts the connection while it is still loading its scene collection; requests then fail
        // (code 207 "not ready") and every module would conclude its source doesn't exist. So only
        // announce 'connected' once OBS really answers.
        this._whenReady(this.ws).then((ok) => {
          if (!ok) return;
          this.connected = true;
          this.lastError = null;
          console.log(`[obs] connected (obs-websocket ${this.version || '?'})`);
          this.emit('connected');
          this.emit('status');
        });
        break;
      case OP.Event:
        // another scene collection = other sources: let every module look again
        if (d.eventType === 'SceneCollectionChanged' && this.connected) setTimeout(() => this.connected && this.emit('connected'), 500);
        this.emit('event', d.eventType, d.eventData || {});
        this.emit(d.eventType, d.eventData || {});
        break;
      case OP.RequestResponse: {
        const p = this.pending.get(d.requestId);
        if (!p) return;
        this.pending.delete(d.requestId);
        if (d.requestStatus.result) p.resolve(d.responseData || {});
        else { const e = new Error(`${d.requestType}: ${d.requestStatus.comment || 'code ' + d.requestStatus.code}`); e.code = d.requestStatus.code; p.reject(e); }
        break;
      }
    }
  }

  call(requestType, requestData = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected to OBS'));
    return this._call(requestType, requestData);
  }

  // Polls until OBS has loaded its scene collection (max 2 min, then carries on anyway).
  // false = this connection ended meanwhile.
  async _whenReady(ws) {
    const t0 = Date.now();
    for (let n = 0; ; n++) {
      if (this.ws !== ws || ws.readyState !== 1) return false;
      try {
        await this._call('GetSceneList');
        await this._call('GetInputList');
        if (n) console.log(`[obs] OBS finished loading after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return true;
      } catch (e) {
        if (Date.now() - t0 > 120000) { console.warn(`[obs] OBS still not ready after 2 min (${e.message}); carrying on`); return true; }
        if (!n) { console.log(`[obs] connected, waiting for OBS to finish loading (${e.message})`); this.lastError = 'OBS가 아직 장면을 불러오는 중이에요…'; this.emit('status'); }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  _call(requestType, requestData = {}) {
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType}: timed out`));
      }, 5000);
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send(OP.Request, { requestType, requestId, requestData });
    });
  }

  status() {
    return { connected: this.connected, url: this.url, error: this.connected ? null : this.lastError, version: this.version };
  }
}
