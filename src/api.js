// Public local API /api/v1 (M5, docs/contracts/): the API token, caller names, and the event stream's own client set.
// Routes and the platform wiring live in server.js; this file holds what must stay small and obviously right.
//
// Token: 32 random bytes, URL-safe base64 (43 chars), required on every /api/v1 call as `Authorization: Bearer <token>`,
// also from loopback. Only its SHA-256 is stored (DATA_DIR/api-token.json; not part of 설정 옮기기). The settings window shows
// a new token once, right after 새로 만들기; renewing closes every open event stream that used the old one.
// Events: GET /api/v1/events has its own client set (never the dashboard's `clients`), so an open stream never turns on
// dashboard-only work (OBS polling, preview frames, level pushes).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const MAX_BUFFER = 1 << 20; // a client this far behind is dropped; it reconnects and gets `hello` again
const PING_MS = 25000;

export class ApiV1 {
  constructor({ dataDir, log = console.log }) {
    this.file = path.join(dataDir, 'api-token.json');
    this.log = log;
    this.saved = null; // { hash (hex), createdAt }
    try { this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.clients = new Set(); // { res, caller, gen }
    this.gen = 0; // bumps on every renew; streams of an older generation are closed
    this.lastUse = null; // { at, caller, route }
  }

  get hasToken() { return !!this.saved?.hash; }

  // 새로 만들기 (or the first token): returns the token in clear — the only time it exists outside the client's config
  renew() {
    const token = crypto.randomBytes(32).toString('base64url');
    this.saved = { hash: sha(token).toString('hex'), createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.gen++;
    for (const c of [...this.clients]) { try { c.res.end(); } catch {} this.clients.delete(c); }
    this.log('[api] new API token made; old streams closed');
    return token;
  }

  static caller(req) {
    const c = String(req.headers['x-allmind-client'] || '').replace(/[^\x21-\x7e]/g, '').slice(0, 40);
    return c || 'unknown';
  }

  // → null when allowed, else { status, code, error }
  check(req, url) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m || url.searchParams.has('token')) return { status: 401, code: 'token-missing', error: 'API 토큰이 없어요 (Authorization: Bearer)' };
    if (!this.hasToken) return { status: 401, code: 'token-invalid', error: 'API 토큰이 아직 없어요 — 설정 창에서 만들어 주세요' };
    const a = sha(m[1]);
    const b = Buffer.from(this.saved.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, code: 'token-invalid', error: 'API 토큰이 맞지 않아요' };
    return null;
  }

  used(caller, route) { this.lastUse = { at: Date.now(), caller, route }; }

  // ---------- GET /api/v1/events ----------
  attach(req, res, caller, hello) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const c = { res, caller, gen: this.gen };
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now(), ...hello })}\n\n`);
    this.clients.add(c);
    this.log(`[api] ${caller} events connected (${this.clients.size} open)`);
    const ping = setInterval(() => this._write(c, ': ping\n\n'), PING_MS);
    const done = () => {
      clearInterval(ping);
      if (this.clients.delete(c)) this.log(`[api] ${caller} events disconnected (${this.clients.size} open)`);
    };
    req.on('close', done);
    res.on('close', done);
  }

  emit(event, data) {
    if (!this.clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify({ at: Date.now(), ...data })}\n\n`;
    for (const c of [...this.clients]) this._write(c, payload);
  }

  _write(c, payload) {
    if (c.gen !== this.gen || c.res.writableLength > MAX_BUFFER) {
      this.clients.delete(c);
      try { c.res.end(); } catch {}
      if (c.gen === this.gen) this.log(`[api] ${c.caller} events dropped (client too slow)`);
      return;
    }
    c.res.write(payload);
  }

  status() {
    return {
      hasToken: this.hasToken,
      createdAt: this.saved?.createdAt || null,
      lastUse: this.lastUse,
      streams: this.clients.size,
    };
  }
}

// A chat line (src/chzzk.js / src/ytchat.js shape) → the public `chat` / `donation` event, or null when it must not be sent:
// system notices, dividers, 🧪 테스트 추첨 fake viewers (uid test:…). See docs/contracts/events.md.
export function publicChat(m) {
  if (!m || m.divider || !['chat', 'donation', 'subscription'].includes(m.kind)) return null;
  const uid = String(m.uid || '');
  if (uid.startsWith('test:')) return null;
  const base = {
    platform: m.platform === 'youtube' ? 'youtube' : 'chzzk',
    id: String(m.key || ''),
    uid,
    nick: String(m.nick || ''),
    role: m.role === 'streamer' || m.role === 'manager' ? m.role : 'viewer',
    text: String(m.text || '').slice(0, 500),
  };
  if (m.kind === 'donation') {
    return ['donation', {
      ...base,
      amount: Number.isFinite(Number(m.amount)) && m.amount !== null && m.amount !== '' ? Number(m.amount) : null,
      ...(m.amountText ? { amountText: String(m.amountText).slice(0, 30) } : {}),
      donationType: m.donationType || null,
    }];
  }
  const out = {
    ...base,
    kind: m.kind,
    verified: !!m.verified,
    sub: m.sub ? { months: Number(m.sub.months) || 0, tier: Number(m.sub.tier) || 1 } : null,
  };
  if (m.platform === 'youtube') out.member = !!m.member;
  if (m.kind === 'subscription') out.months = Number.isFinite(Number(m.months)) && m.months !== null ? Number(m.months) : null;
  return ['chat', out];
}
