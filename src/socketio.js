// A minimal Socket.IO v2 client (Engine.IO v3, WebSocket transport only) on top of `ws`, for CHZZK's official Session API.
// The docs (chzzk.gitbook.io/chzzk/chzzk-api/session, read 2026-11-25) say the session socket speaks Socket.IO and name the
// client versions 1.0.0 to 2.0.3, so this implements just what that needs, from the public protocol description:
//   URL        ws(s)://host/socket.io/?EIO=3&transport=websocket&<the query of the URL the API gave us, e.g. auth=...>
//   Engine.IO  "0{json}" open (pingInterval/pingTimeout) · "2" ping (the CLIENT pings in v3) · "3" pong · "1" close · "4<payload>" message
//   Socket.IO  "40" connected to the default namespace · "41" disconnect · "42[\"event\", data]" event · "44..." error
// No binary packets, no acks, no namespaces other than "/". It is covered by tools/dev/test-chzzk-official.mjs against a mock
// that speaks the same protocol; it has NOT been run against Naver's real server (Stan's real check does that).
// Why not the socket.io-client package: the docs only support the old 1.x-2.0.3 line, and Allmind's single dependency is `ws`.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export function engineUrl(apiUrl) {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
  u.pathname = '/socket.io/';
  u.searchParams.set('EIO', '3');
  u.searchParams.set('transport', 'websocket');
  return u.toString();
}

/** Parse one Engine.IO text frame: { type, data } where type is the Engine.IO packet digit. */
export function parseEngine(frame) {
  const s = String(frame);
  return { type: s[0], data: s.slice(1) };
}

/** Parse a Socket.IO packet body (after the Engine.IO "4"): { type, nsp, id, data } or null. */
export function parseSocket(body) {
  const s = String(body);
  const type = s[0];
  let i = 1;
  let nsp = '/';
  if (s[i] === '/') {
    const end = s.indexOf(',', i);
    nsp = end === -1 ? s.slice(i) : s.slice(i, end);
    i = end === -1 ? s.length : end + 1;
  }
  let id = '';
  while (i < s.length && s[i] >= '0' && s[i] <= '9') { id += s[i]; i += 1; }
  const rest = s.slice(i);
  let data;
  if (rest) { try { data = JSON.parse(rest); } catch { return null; } }
  return { type, nsp, id, data };
}

export class SioClient extends EventEmitter {
  /** @param {string} apiUrl the URL from GET /open/v1/sessions/auth */
  constructor(apiUrl, { WebSocketImpl = WebSocket, connectTimeoutMs = 8000 } = {}) {
    super();
    this.url = engineUrl(apiUrl);
    this.WS = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.ws = null;
    this.closed = false;
    this.connected = false;
    this.pingTimer = null;
    this.pongTimer = null;
    this.connectTimer = null;
  }

  connect() {
    const ws = new this.WS(this.url);
    this.ws = ws;
    this.connectTimer = setTimeout(() => this._fail(new Error('Socket.IO 연결 시간 초과')), this.connectTimeoutMs);
    this.connectTimer.unref?.();
    ws.on('message', (data) => this._frame(typeof data === 'string' ? data : data.toString('utf8')));
    ws.on('error', (e) => this._fail(e));
    ws.on('close', () => this._end('close'));
    return this;
  }

  _frame(frame) {
    const p = parseEngine(frame);
    if (p.type === '0') { // engine open
      let info = {};
      try { info = JSON.parse(p.data); } catch {}
      const every = Math.max(1000, Number(info.pingInterval) || 25000);
      this.pongWait = Math.max(1000, Number(info.pingTimeout) || 60000);
      this.pingTimer = setInterval(() => this._ping(), every);
      this.pingTimer.unref?.();
    } else if (p.type === '3') { // pong
      clearTimeout(this.pongTimer);
    } else if (p.type === '1') {
      this._end('server-close');
    } else if (p.type === '4') {
      const s = parseSocket(p.data);
      if (!s || s.nsp !== '/') return;
      if (s.type === '0') {
        this.connected = true;
        clearTimeout(this.connectTimer);
        this.emit('connect');
      } else if (s.type === '1') {
        this._end('server-disconnect');
      } else if (s.type === '2' && Array.isArray(s.data) && typeof s.data[0] === 'string') {
        this.emit('event', s.data[0], s.data[1]);
      } else if (s.type === '4') {
        this.emit('error', new Error(`Socket.IO error: ${JSON.stringify(s.data)}`));
      }
    }
  }

  _ping() {
    if (this.closed || !this.ws) return;
    try { this.ws.send('2'); } catch { return this._end('send-failed'); }
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => this._fail(new Error('Socket.IO ping timeout')), this.pongWait || 60000);
    this.pongTimer.unref?.();
  }

  _fail(err) {
    if (this.closed) return;
    this.emit('error', err);
    this._end('error');
  }

  _end(reason) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.connectTimer);
    try { this.ws?.close(); } catch {}
    this.emit('close', reason);
  }

  close() { this._end('local'); }
}
