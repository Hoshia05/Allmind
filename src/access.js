// Optional PIN for other devices (docs/plans/security.md, step 3).
// Off by default. When on, a browser that isn't the stream PC itself must enter the PIN once; it then gets a long
// random token in an HttpOnly cookie (remembered per device, ~400 days, renewed while used). "모든 기기 로그아웃"
// forgets every token. Only hashes are stored (DATA_DIR/access.json): the PIN as scrypt, tokens as SHA-256.
// Exempt (decided in server.js): the stream PC itself (loopback or one of its own addresses — OBS browser sources,
// the settings window), overlay pages + their channels, OAuth callbacks, and /deck/* (the Stream Deck plugin has no
// browser; it uses config.deck.token, which turning the PIN on creates if it's empty).
import crypto from 'node:crypto';
import os from 'node:os';
import { loadState, saveState } from './config.js';

export const COOKIE = 'allmind_device';
const MAX_AGE_S = 400 * 24 * 3600; // Chrome caps cookie lifetime at 400 days
const SEEN_EVERY_MS = 60 * 60 * 1000; // lastSeen (and the cookie) refreshed at most hourly — no write per request
// wrong guesses: per address 5 in a row → locked 5 min (then doubling, max 1 h); across all addresses 30 per hour
const PER_IP = 5, LOCK_MS = 5 * 60 * 1000, LOCK_MAX_MS = 60 * 60 * 1000, GLOBAL = 30, GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32, { N: 1 << 14, r: 8, p: 1 }).toString('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export const newDeckToken = () => crypto.randomBytes(12).toString('base64url');

export function checkPin(pin) {
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new Error('PIN은 숫자 4~8자리로 정해 주세요');
}

// "iPad", "iPhone", "Android", "Windows PC", "Mac" — just so the list in the settings window means something
export function deviceName(ua = '') {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android 폰' : 'Android 태블릿';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Linux|CrOS/.test(ua)) return 'Linux PC';
  return '기기';
}

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
export const cookieHeader = (token) => `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax`;

// This PC's own addresses: a browser on the stream PC that opens the LAN address (or an OBS source pointed at it)
// connects from one of these, not from 127.0.0.1. Refreshed every 30 s (DHCP, Wi-Fi changes).
let selfAddrs = null, selfAt = 0;
const norm = (a) => String(a || '').replace(/^::ffff:/, '').toLowerCase();
export function isSelf(req) {
  const a = norm(req.socket.remoteAddress);
  if (a === '127.0.0.1' || a === '::1' || a.startsWith('127.')) return true;
  if (process.env.ALLMIND_SELF_LOOPBACK_ONLY === '1') return false; // tests: the LAN address acts as another device
  if (!selfAddrs || Date.now() - selfAt > 30000) {
    selfAddrs = new Set();
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) selfAddrs.add(norm(i.address));
    selfAt = Date.now();
  }
  return selfAddrs.has(a);
}

export class Access {
  constructor() {
    const s = loadState('access', {});
    this.st = { enabled: false, pinSalt: '', pinHash: '', devices: [], ...s };
    if (!Array.isArray(this.st.devices)) this.st.devices = [];
    this.fails = new Map(); // address → { n, until, locks }
    this.globalFails = []; // timestamps
  }
  _save() { saveState('access', this.st); }

  get enabled() { return !!(this.st.enabled && this.st.pinHash); }
  get hasPin() { return !!this.st.pinHash; }

  status() {
    return {
      enabled: this.enabled,
      hasPin: this.hasPin,
      devices: this.st.devices.map((d) => ({ name: d.name, created: d.created, lastSeen: d.lastSeen })),
    };
  }

  // settings window: { enabled, pin? } — a new PIN is required the first time; changing it keeps paired devices
  configure({ enabled, pin }) {
    if (pin !== undefined && pin !== null && String(pin) !== '') {
      checkPin(pin);
      const salt = crypto.randomBytes(16).toString('hex');
      this.st.pinSalt = salt;
      this.st.pinHash = scrypt(pin, salt);
    }
    if (enabled && !this.st.pinHash) throw new Error('먼저 PIN을 정해 주세요');
    this.st.enabled = !!enabled;
    this._save();
    return this.status();
  }

  logoutAll() {
    const n = this.st.devices.length;
    this.st.devices = [];
    this._save();
    return n;
  }

  // → { ok, refresh? } — refresh: send the cookie again (sliding lifetime)
  check(req) {
    const tok = readCookie(req);
    if (!tok || tok.length < 20) return { ok: false };
    const h = sha(tok);
    const d = this.st.devices.find((x) => eq(x.hash, h));
    if (!d) return { ok: false };
    if (Date.now() - (d.lastSeen || 0) > SEEN_EVERY_MS) {
      d.lastSeen = Date.now();
      this._save();
      return { ok: true, refresh: tok };
    }
    return { ok: true };
  }

  _locked(addr) {
    const now = Date.now();
    this.globalFails = this.globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
    if (this.globalFails.length >= GLOBAL) return Math.ceil((this.globalFails[0] + GLOBAL_WINDOW_MS - now) / 60000);
    const f = this.fails.get(addr);
    if (f?.until > now) return Math.ceil((f.until - now) / 60000);
    return 0;
  }

  // → { ok:true, token } | { ok:false, error, status }
  pair(req, pin) {
    const addr = norm(req.socket.remoteAddress);
    if (!this.enabled) return { ok: false, status: 409, error: 'PIN이 꺼져 있어요 — 그냥 새로고침하면 돼요' };
    const wait = this._locked(addr);
    if (wait) return { ok: false, status: 429, error: `너무 많이 틀렸어요 — ${wait}분 뒤에 다시 해 보세요` };
    const good = /^\d{4,8}$/.test(String(pin ?? '')) && eq(scrypt(pin, this.st.pinSalt), this.st.pinHash);
    if (!good) {
      const f = this.fails.get(addr) || { n: 0, until: 0, locks: 0 };
      f.n++;
      this.globalFails.push(Date.now());
      let error = `PIN이 맞지 않아요 (남은 기회 ${PER_IP - f.n}번)`;
      if (f.n >= PER_IP) {
        const ms = Math.min(LOCK_MAX_MS, LOCK_MS * 2 ** f.locks);
        f.until = Date.now() + ms; f.locks++; f.n = 0;
        error = `너무 많이 틀렸어요 — ${Math.round(ms / 60000)}분 뒤에 다시 해 보세요`;
        console.log(`[access] PIN locked for ${addr} (${Math.round(ms / 60000)} min)`);
      }
      this.fails.set(addr, f);
      return { ok: false, status: 403, error };
    }
    this.fails.delete(addr);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.st.devices.push({ hash: sha(token), name: deviceName(req.headers['user-agent']), created: now, lastSeen: now });
    if (this.st.devices.length > 50) this.st.devices.sort((a, b) => b.lastSeen - a.lastSeen).length = 50; // forget the oldest
    this._save();
    console.log(`[access] paired ${deviceName(req.headers['user-agent'])} from ${addr}`);
    return { ok: true, token };
  }
}
