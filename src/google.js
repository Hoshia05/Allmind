// One Google sign-in for the YouTube archive guard and the Drive upload (docs/plans/google-archive.md).
//
// Desktop-app OAuth: the owner makes his own Google Cloud project once and pastes its client ID +
// secret into the settings window. Login opens Google's consent page; Google redirects back to
// this app on 127.0.0.1 (loopback), with PKCE. The refresh token lives in DATA_DIR/google-auth.json
// and is never sent to dashboards, logs or the log bundle.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { loadState, saveState } from './config.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/drive.file',
];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GoogleError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// fetch with retries on network errors / 429 / 5xx (backoff 1 s, 3 s, 9 s)
export async function fetchRetry(url, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(opts.timeout || 30000) });
      if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
        last = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      last = e;
      if (i === tries - 1) break;
    }
    await sleep(1000 * 3 ** i);
  }
  throw last;
}

export class Google extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.auth = loadState('google-auth', null); // { refresh_token, access_token, expires_at, account }
    this.pending = new Map(); // state -> { verifier, redirect, at }
    this.error = null;
  }

  get cfg() { return this.config.google || {}; }
  get authUrl() { return this.cfg.authUrl || 'https://accounts.google.com/o/oauth2/v2/auth'; }
  get tokenUrl() { return this.cfg.tokenUrl || 'https://oauth2.googleapis.com/token'; }
  get apiBase() { return (this.cfg.apiBase || 'https://www.googleapis.com').replace(/\/+$/, ''); }

  configured() { return !!(this.cfg.clientId && this.cfg.clientSecret); }
  loggedIn() { return !!this.auth?.refresh_token; }

  status() {
    return {
      configured: this.configured(),
      loggedIn: this.loggedIn(),
      account: this.auth?.account || '',
      error: this.error,
    };
  }

  loginUrl(redirect) {
    if (!this.configured()) throw new Error('먼저 Google 클라이언트 ID와 보안 비밀번호를 넣어 주세요');
    const state = b64url(crypto.randomBytes(18));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60000) this.pending.delete(k);
    this.pending.set(state, { verifier, redirect, at: Date.now() });
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent', // always hand out a refresh token
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${this.authUrl}?${q}`;
  }

  async callback({ code, state, error }) {
    if (error) throw new Error(error === 'access_denied' ? '로그인을 취소했어요' : `Google 오류: ${error}`);
    const p = this.pending.get(state);
    if (!p) throw new Error('로그인 요청이 만료됐어요. 설정 창에서 다시 눌러 주세요');
    this.pending.delete(state);
    const res = await fetchRetry(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        redirect_uri: p.redirect, grant_type: 'authorization_code', code_verifier: p.verifier,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.refresh_token) throw new Error(`로그인 실패: ${j.error_description || j.error || res.status}`);
    this.auth = { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope || '' };
    this.error = null;
    // Which YouTube channel this is, to show in the settings window.
    try {
      const ch = await this.api('GET', '/youtube/v3/channels', { query: { part: 'snippet', mine: 'true' } });
      this.auth.account = ch.items?.[0]?.snippet?.title || '';
    } catch {}
    saveState('google-auth', this.auth);
    console.log(`[google] logged in${this.auth.account ? ` as ${this.auth.account}` : ''}`);
    this.emit('login');
    this.emit('change');
  }

  async logout() {
    const t = this.auth?.refresh_token;
    this.auth = null;
    saveState('google-auth', null);
    this.emit('change');
    if (t) fetch(`${this.cfg.revokeUrl || 'https://oauth2.googleapis.com/revoke'}?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
  }

  async token() {
    if (!this.loggedIn()) throw new GoogleError('Google에 로그인하지 않았어요', 401, 'notLoggedIn');
    if (this.auth.access_token && Date.now() < this.auth.expires_at - 60000) return this.auth.access_token;
    const res = await fetchRetry(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.auth.refresh_token, grant_type: 'refresh_token' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === 'invalid_grant') {
        // revoked, expired ("Testing" projects expire refresh tokens after 7 days) or password changed
        this.error = 'Google 로그인이 만료됐어요 — 설정 창에서 다시 로그인해 주세요';
        this.auth = null;
        saveState('google-auth', null);
        this.emit('change');
      }
      throw new GoogleError(`토큰 갱신 실패: ${j.error_description || j.error || res.status}`, res.status, j.error);
    }
    this.auth.access_token = j.access_token;
    this.auth.expires_at = Date.now() + (j.expires_in || 3600) * 1000;
    saveState('google-auth', this.auth);
    return j.access_token;
  }

  // JSON API call. path is relative to apiBase ("/youtube/v3/…") or a full URL.
  async api(method, path, { query, body, headers = {}, raw = false } = {}) {
    const url = new URL(path.startsWith('http') ? path : this.apiBase + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchRetry(url, {
        method,
        headers: { Authorization: `Bearer ${await this.token()}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) { this.auth.access_token = null; continue; }
      if (raw) return res;
      const text = await res.text();
      const j = text ? (() => { try { return JSON.parse(text); } catch { return { text }; } })() : {};
      if (!res.ok) {
        const reason = j.error?.errors?.[0]?.reason || j.error?.status || '';
        throw new GoogleError(j.error?.message || `HTTP ${res.status}`, res.status, reason);
      }
      return j;
    }
    throw new GoogleError('Google 인증 실패', 401, 'auth');
  }
}
