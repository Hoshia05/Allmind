// VTube Studio public API client (docs/plans/vts.md). VTS runs on the main PC; Allmind connects to
// ws://<main PC>:8001 with Node's built-in WebSocket. First connect asks the owner to allow Allmind in a
// VTS popup; the token is kept in DATA_DIR/vts-auth.json (a secret: never logged). Connected only while
// config.vts.enabled.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { loadState, saveState, readAsset } from './config.js';

const PLUGIN = { pluginName: 'Allmind', pluginDeveloper: 'Hoshia' };

export const vtsUrl = (host) => {
  let h = String(host || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!h) return null; // no default: VTS runs on the main PC, never on this one
  if (!/:\d+$/.test(h)) h += ':8001';
  return `ws://${h}`;
};

export class VTS extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.auth = loadState('vts-auth', {}); // { token }
    this.ws = null;
    this.state = 'off';      // off | connecting | auth (waiting for the popup) | ready | error
    this.error = null;
    this.pending = new Map();
    this.retryMs = 5000;
    this.timer = null;
    this.model = null;       // { name, id, position }
    this.canCustomItems = false;
    this.version = null;
  }

  get cfg() { return this.config.vts || {}; }
  get url() { return vtsUrl(this.cfg.host); }
  get ready() { return this.state === 'ready'; }

  status() {
    return { enabled: !!this.cfg.enabled, url: this.url || '', host: String(this.cfg.host || ''), state: this.state, error: this.error, model: this.model?.name || null, customItems: this.canCustomItems, version: this.version, hasToken: !!this.auth.token };
  }

  // (re)apply config.vts: start, stop or move to another address
  apply() {
    const want = !!this.cfg.enabled;
    if (!want) return this.stop();
    if (!this.url) { this.stop(false); return this._set('error', '메인 PC의 VTube Studio 주소를 넣어 주세요 (예: 192.168.0.5:8001)'); }
    if (this.ws && this.wsUrl === this.url) return;
    this.stop(false);
    this._connect();
  }

  stop(clearState = true) {
    clearTimeout(this.timer); this.timer = null;
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.close(); } catch {} }
    this._failAll('VTube Studio 연결이 끊겼어요');
    if (clearState) { this._set('off', null); }
  }

  // forget the token (e.g. the owner revoked Allmind in VTS) and ask again
  forget() {
    console.log('[vts] forgetting the token, asking VTube Studio again');
    this.auth = {};
    saveState('vts-auth', this.auth);
    this.stop(false);
    if (this.cfg.enabled) this._connect();
  }

  _set(state, error) {
    if (this.state === state && this.error === error) return;
    this.state = state; this.error = error;
    this.emit('change');
  }

  _failAll(msg) {
    for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(new Error(msg)); }
    this.pending.clear();
  }

  _retry() {
    if (!this.cfg.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this._connect(); }, this.retryMs);
    this.retryMs = Math.min(60000, this.retryMs * 2);
  }

  // "다시 연결": keep a connection that is waiting for the owner to click "allow" in VTS — a new
  // connection would ask again and the first click would go to the closed one
  reconnect() {
    if (this.state === 'auth' && this.ws && this.wsUrl === this.url) return;
    this.stop(false);
    this.apply();
  }

  _connect() {
    if (!this.cfg.enabled) return;
    const url = this.url;
    if (!url) return this._set('error', '메인 PC의 VTube Studio 주소를 넣어 주세요 (예: 192.168.0.5:8001)');
    this.wsUrl = url;
    this._set('connecting', this.error);
    let ws;
    // the 'ws' package, not Node's built-in WebSocket: with the built-in one VTS's answer to the
    // token request arrived as an empty message on the owner's PC (0.35.2 log). No compression either.
    try { ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 8000, maxPayload: 32 * 1024 * 1024 }); } catch (e) { this._set('error', `주소가 올바르지 않아요 (${url})`); return this._retry(); }
    this.ws = ws;
    let opened = false;
    ws.on('open', () => { opened = true; console.log(`[vts] connected to ${url}`); this._handshake().catch((e) => { this._set('error', e.message); try { ws.close(); } catch {} }); });
    ws.on('message', (data, isBinary) => this._onMessage(isBinary ? data : data.toString('utf8')));
    const end = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._failAll('VTube Studio 연결이 끊겼어요');
      this.model = null;
      if (opened) console.log('[vts] connection closed');
      const msg = opened ? 'VTube Studio 연결이 끊겼어요' : `${url.replace('ws://', '')}에 연결할 수 없어요 — 메인 PC에서 VTube Studio가 켜져 있고 API가 켜져 있는지 확인해 주세요`;
      this._set('error', this.state === 'error' && this.error && opened ? this.error : msg);
      this.emit('down');
      this._retry();
    };
    ws.on('close', end);
    ws.on('error', (e) => { if (!opened) console.warn('[vts] connect failed:', e.code || e.message); end(); });
  }

  // VTS sends JSON text frames. Be lenient about what arrives (binary frames, a BOM, NULs, two objects
  // in one frame): a token answer that couldn't be read left Allmind waiting forever (0.35.1 log).
  _onMessage(raw) {
    if (typeof Blob !== 'undefined' && raw instanceof Blob) { raw.arrayBuffer().then((ab) => this._onMessage(ab), () => {}); return; }
    let text;
    if (typeof raw === 'string') text = raw;
    else {
      const buf = raw instanceof ArrayBuffer ? Buffer.from(raw) : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.from(String(raw));
      text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    }
    text = text.replace(/^﻿/, '').replace(/\u0000/g, '').trim();
    if (!text) { console.warn(`[vts] empty message (${typeof raw === 'string' ? 'text' : 'binary'})`); return; }
    let list = [];
    try { list = [JSON.parse(text)]; } catch {
      // several objects in one frame?
      try { list = text.replace(/}\s*{/g, '}\n{').split('\n').map((x) => JSON.parse(x)); } catch { list = []; }
    }
    if (!list.length) {
      // last resort: pull the token (and which request it answers) out of the text
      const tok = /"authenticationToken"\s*:\s*"([^"]{8,})"/.exec(text);
      const rid = /"requestID"\s*:\s*"([^"]*)"/.exec(text);
      const type = /"messageType"\s*:\s*"([^"]*)"/.exec(text);
      const preview = text.slice(0, 160).replace(/[0-9a-f]{24,}/gi, '…');
      console.warn(`[vts] unreadable message (${typeof raw === 'string' ? 'text' : 'binary'}, ${text.length} chars, type ${type?.[1] || '?'}): ${preview}`);
      if (tok) list = [{ messageType: 'AuthenticationTokenResponse', requestID: rid?.[1], data: { authenticationToken: tok[1] } }];
      else return;
    }
    for (const m of list) this._handle(m);
  }

  _handle(m) {
    if (!m || typeof m !== 'object') return;
    if (this.state === 'auth' || this.state === 'connecting') console.log(`[vts] ← ${m.messageType || '?'}`);
    // a token can arrive after its request was given up (connection restarted while the popup was up)
    if (m.messageType === 'AuthenticationTokenResponse' && m.data?.authenticationToken && m.data.authenticationToken !== this.auth.token) {
      const late = !(m.requestID && this.pending.has(m.requestID));
      this.auth = { token: m.data.authenticationToken };
      saveState('vts-auth', this.auth);
      console.log('[vts] allowed in VTube Studio — token received');
      if (late) { console.log('[vts] (late answer) reconnecting to log in with it'); setTimeout(() => { this.stop(false); this.apply(); }, 300); return; }
    }
    const p = m.requestID && this.pending.get(m.requestID);
    if (p) {
      this.pending.delete(m.requestID); clearTimeout(p.t);
      if (m.messageType === 'APIError') { const e = new Error(m.data?.message || 'VTS 오류'); e.code = m.data?.errorID; p.reject(e); }
      else p.resolve(m.data || {});
      return;
    }
    if (m.messageType === 'APIError') console.warn(`[vts] error from VTube Studio: ${m.data?.errorID} ${m.data?.message || ''}`);
    if (m.messageType?.endsWith('Event')) this.emit('event', m.messageType, m.data || {});
  }

  // one request → its response data (rejects on APIError, with err.code = VTS errorID)
  request(type, data = {}, timeoutMs = 8000) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('VTube Studio에 연결되어 있지 않아요'));
    const requestID = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestID); reject(new Error(`VTS 응답 없음 (${type})`)); }, timeoutMs);
      this.pending.set(requestID, { resolve, reject, t });
      ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType: `${type}Request`, data }));
    });
  }
  // for the authenticated-only calls
  call(type, data, timeoutMs) {
    if (!this.ready) return Promise.reject(new Error(this.state === 'auth' ? 'VTube Studio에서 Allmind를 허용해 주세요' : 'VTube Studio에 연결되어 있지 않아요'));
    return this.request(type, data, timeoutMs);
  }

  async _handshake() {
    const st = await this.request('APIState');
    this.version = st.vTubeStudioVersion || null;
    if (!this.auth.token) {
      console.log('[vts] asking VTube Studio to allow Allmind (popup on the main PC)');
      this._set('auth', 'VTube Studio(메인 PC)에 뜬 창에서 Allmind를 허용해 주세요 — 창이 안 보이면 VTS 설정 화면을 닫아 보거나 "허용 다시 받기"');
      const icon = iconB64();
      let r;
      try { r = await this.request('AuthenticationToken', { ...PLUGIN, ...(icon ? { pluginIcon: icon } : {}) }, 5 * 60 * 1000); }
      catch (e) { throw new Error(e.code === 50 ? 'VTube Studio에서 Allmind를 거절했어요 — 다시 연결을 눌러 허용해 주세요' : e.message); }
      this.auth = { token: r.authenticationToken };
      saveState('vts-auth', this.auth);
    }
    const a = await this.request('Authentication', { ...PLUGIN, authenticationToken: this.auth.token });
    console.log(`[vts] authentication: ${a.authenticated ? 'ok' : 'refused'}${a.reason ? ` (${a.reason})` : ''}`);
    if (!a.authenticated) {
      this.auth = {}; saveState('vts-auth', this.auth);
      throw new Error('VTube Studio에서 Allmind 허용이 취소됐어요 — 다시 연결을 눌러 주세요');
    }
    this.retryMs = 5000;
    // our thrown items are our own images → one more permission (asked once)
    try {
      const pr = await this.request('Permission', {});
      this.canCustomItems = !!pr.permissions?.find((x) => x.name === 'LoadCustomImagesAsItems')?.granted;
      if (!this.canCustomItems) {
        this._set('auth', 'VTube Studio에 뜬 창에서 "이미지 불러오기" 권한을 허용해 주세요 (던질 물건)');
        const g = await this.request('Permission', { requestedPermission: 'LoadCustomImagesAsItems' }, 5 * 60 * 1000);
        this.canCustomItems = !!g.grantSuccess;
      }
      console.log(`[vts] custom images: ${this.canCustomItems ? 'allowed' : 'not allowed'}`);
    } catch (e) { this.canCustomItems = false; console.warn('[vts] permission request failed:', e.message); }
    await this.refreshModel().catch(() => {});
    this._set('ready', this.canCustomItems ? null : '이미지 불러오기 권한이 없어서 물건을 던질 수 없어요 — 다시 연결해서 허용해 주세요');
    this.emit('ready');
  }

  async refreshModel() {
    const m = await this.request('CurrentModel');
    this.model = m.modelLoaded ? { name: m.modelName, id: m.modelID, position: m.modelPosition } : null;
    return this.model;
  }

  // ---------- groundwork for viewers changing model parts (expressions) ----------
  async expressions() {
    const r = await this.call('ExpressionState', { details: false });
    return (r.expressions || []).map((e) => ({ name: e.name, file: e.file, active: !!e.active }));
  }
  setExpression(file, active, fadeTime = 0.25) { return this.call('ExpressionActivation', { expressionFile: String(file), active: !!active, fadeTime }); }
  async hotkeys() {
    const r = await this.call('HotkeysInCurrentModel', {});
    return (r.availableHotkeys || []).map((h) => ({ id: h.hotkeyID, name: h.name, type: h.type, file: h.file }));
  }
  triggerHotkey(id) { return this.call('HotkeyTrigger', { hotkeyID: String(id) }); }
}

let iconCache = null;
function iconB64() { // VTS wants exactly 128×128 (PNG/JPG)
  if (iconCache !== null) return iconCache || undefined;
  const buf = readAsset('public/vts-items/plugin-icon.png');
  iconCache = buf ? buf.toString('base64') : '';
  return iconCache || undefined;
}
