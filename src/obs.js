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
      if (code === 4009) this.lastError = 'OBS rejected the password — check the OBS password in Allmind settings';
      else if (!wasConnected && !this.lastError?.startsWith('OBS rejected')) this.lastError = `Can't reach OBS at ${this.url} — is OBS open with the WebSocket server enabled?`;
      if (wasConnected) {
        this.lastError = 'Lost the connection to OBS; reconnecting…';
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
        this.connected = true;
        this.lastError = null;
        this.retryMs = 1000;
        this.emit('connected');
        this.emit('status');
        break;
      case OP.Event:
        this.emit('event', d.eventType, d.eventData || {});
        this.emit(d.eventType, d.eventData || {});
        break;
      case OP.RequestResponse: {
        const p = this.pending.get(d.requestId);
        if (!p) return;
        this.pending.delete(d.requestId);
        if (d.requestStatus.result) p.resolve(d.responseData || {});
        else p.reject(new Error(`${d.requestType}: ${d.requestStatus.comment || 'code ' + d.requestStatus.code}`));
        break;
      }
    }
  }

  call(requestType, requestData = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected to OBS'));
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
