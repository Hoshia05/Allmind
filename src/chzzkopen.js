// CHZZK's official Open API (https://chzzk.gitbook.io/chzzk/), used for the 방송 준비 panel:
// read/change the stream title, category and tags. Separate from src/chzzk.js, which reads chat
// and live status from Chzzk's unofficial web endpoints without any login.
//
// The owner registers an app at CHZZK Developers (client ID + secret, login redirect URL =
// Allmind's loopback callback, scopes 방송 설정 조회/변경) and logs in once. Tokens in
// DATA_DIR/chzzk-auth.json (secret). Access token: 1 day; refresh token: 30 days and single-use,
// so every refresh stores the new one.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { loadState, saveState } from './config.js';
import { fetchRetry } from './google.js';

export class ChzzkOpen extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.auth = loadState('chzzk-auth', null); // { accessToken, refreshToken, expiresAt, refreshUntil, channelName }
    this.pending = new Map();
    this.error = null;
    this.refreshing = null;
  }

  get cfg() { return this.config.chzzkOpen || {}; }
  get apiBase() { return (this.cfg.apiBase || 'https://openapi.chzzk.naver.com').replace(/\/+$/, ''); }
  get authUrl() { return this.cfg.authUrl || 'https://chzzk.naver.com/account-interlock'; }

  configured() { return !!(this.cfg.clientId && this.cfg.clientSecret); }
  loggedIn() { return !!this.auth?.refreshToken; }

  status() {
    return {
      configured: this.configured(),
      loggedIn: this.loggedIn(),
      account: this.auth?.channelName || '',
      // a refresh token that isn't used for 30 days dies; warn a few days before
      expiresSoon: !!(this.auth?.refreshUntil && this.auth.refreshUntil - Date.now() < 5 * 86400000),
      error: this.error,
    };
  }

  loginUrl(redirect) {
    if (!this.configured()) throw new Error('먼저 치지직 클라이언트 ID와 시크릿을 넣어 주세요');
    const state = crypto.randomBytes(16).toString('hex');
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60000) this.pending.delete(k);
    this.pending.set(state, { at: Date.now() });
    return `${this.authUrl}?${new URLSearchParams({ clientId: this.cfg.clientId, redirectUri: redirect, state })}`;
  }

  async _token(body) {
    const res = await fetchRetry(`${this.apiBase}/auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    const c = j.content || j;
    if (!res.ok || !c.accessToken) throw Object.assign(new Error(j.message || `HTTP ${res.status}`), { status: res.status });
    this.auth = {
      ...(this.auth || {}),
      accessToken: c.accessToken,
      refreshToken: c.refreshToken || this.auth?.refreshToken,
      expiresAt: Date.now() + (Number(c.expiresIn) || 86400) * 1000,
      refreshUntil: Date.now() + 30 * 86400000,
    };
    saveState('chzzk-auth', this.auth);
  }

  async callback({ code, state }) {
    if (!code) throw new Error('로그인을 취소했어요');
    if (!this.pending.has(state)) throw new Error('로그인 요청이 만료됐어요. 설정 창에서 다시 눌러 주세요');
    this.pending.delete(state);
    try {
      await this._token({ grantType: 'authorization_code', code, state });
    } catch (e) {
      throw new Error(`치지직 로그인 실패: ${e.message}`);
    }
    this.error = null;
    try {
      const me = await this.api('GET', '/open/v1/users/me');
      this.auth.channelName = me.channelName || '';
      saveState('chzzk-auth', this.auth);
    } catch {}
    console.log(`[chzzk-open] logged in${this.auth.channelName ? ` as ${this.auth.channelName}` : ''}`);
    this.emit('change');
  }

  async logout() {
    const t = this.auth?.refreshToken;
    this.auth = null;
    saveState('chzzk-auth', null);
    this.emit('change');
    if (t) {
      fetch(`${this.apiBase}/auth/v1/token/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, token: t, tokenTypeHint: 'refresh_token' }),
      }).catch(() => {});
    }
  }

  async accessToken(force = false) {
    if (!this.loggedIn()) throw new Error('치지직에 로그인하지 않았어요');
    if (!force && this.auth.accessToken && Date.now() < this.auth.expiresAt - 60000) return this.auth.accessToken;
    // single-use refresh token: never refresh twice at the same time
    this.refreshing ||= this._token({ grantType: 'refresh_token', refreshToken: this.auth.refreshToken })
      .catch((e) => {
        if (e.status === 400 || e.status === 401) {
          this.error = '치지직 로그인이 만료됐어요 — 설정 창에서 다시 로그인해 주세요';
          this.auth = null;
          saveState('chzzk-auth', null);
          this.emit('change');
        }
        throw e;
      })
      .finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.auth.accessToken;
  }

  // user = true: the owner's access token; false: client auth (e.g. category search)
  async api(method, path, body, { user = true, query } = {}) {
    const url = new URL(this.apiBase + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { 'Content-Type': 'application/json' };
      if (user) headers.Authorization = `Bearer ${await this.accessToken(attempt > 0)}`;
      else Object.assign(headers, { 'Client-Id': this.cfg.clientId, 'Client-Secret': this.cfg.clientSecret });
      const res = await fetchRetry(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 401 && user && attempt === 0) continue;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || `치지직 API 오류 ${res.status}`);
      return j.content ?? {};
    }
    throw new Error('치지직 인증 실패');
  }

  // { title, category: { categoryType, categoryId, categoryValue }, tags }
  async getSetting() {
    const c = await this.api('GET', '/open/v1/lives/setting');
    return { title: c.defaultLiveTitle || '', category: c.category?.categoryId ? c.category : null, tags: c.tags || [] };
  }

  async setSetting({ title, category, tags }) {
    const body = {};
    if (title) body.defaultLiveTitle = title;
    if (category !== undefined) {
      body.categoryType = category?.categoryType || 'ETC';
      body.categoryId = category?.categoryId || '';
    }
    if (tags) body.tags = tags;
    await this.api('PATCH', '/open/v1/lives/setting', body);
  }

  async searchCategory(q) {
    const c = await this.api('GET', '/open/v1/categories/search', undefined, { user: false, query: { query: q, size: 20 } });
    return (c.data || []).map((x) => ({ categoryType: x.categoryType, categoryId: x.categoryId, categoryValue: x.categoryValue, posterImageUrl: x.posterImageUrl }));
  }
}

// Tags: CHZZK refuses spaces and special characters.
export function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,\n]/);
  return [...new Set(list.map((t) => String(t).replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean))].slice(0, 5);
}
