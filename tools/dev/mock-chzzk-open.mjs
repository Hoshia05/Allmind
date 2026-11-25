// A mock of CHZZK's official Open API and its Session socket (docs: https://chzzk.gitbook.io/chzzk, read 2026-11-25), for
// tools/dev/test-chzzk-official.mjs. Everything is in memory on loopback; no Naver host is contacted.
//   HTTP   POST /auth/v1/token (single-use refresh tokens) · GET /open/v1/sessions/auth (max 3 per user) · POST /open/v1/sessions/events/subscribe/{chat|donation|subscription}
//          GET /open/v1/users/me · GET /open/v1/channels (Client auth) · GET /open/v1/channels/subscribers · restrict-channels · temporary-restrict-channels
//          POST /open/v1/chats/{send|notice|blind-message} · GET /open/v1/lives/setting
//   Socket Socket.IO v2 / Engine.IO v3 over WebSocket at /socket.io/ (the protocol the docs name: client 1.0.0 to 2.0.3)
// Options: scopes (the scope names the app "has"), accessTtlMs (how long an access token lives), streamer (false = blind-message answers 400).
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const CHANNEL = '0123456789abcdef0123456789abcdef';
export const CHAT_CHANNEL = 'chatchannel00000000000000000001';

export async function startMockChzzkOpen({ scopes = null, accessTtlMs = 86400000, streamer = true } = {}) {
  const ALL = ['채팅 메시지 조회', '후원 조회', '구독 조회', '채팅 메시지 쓰기', '채팅 공지 쓰기', '활동제한 조회', '활동제한 쓰기', '채널 구독자 조회', '유저 정보 조회', '방송 설정 조회', '방송 설정 변경'];
  const state = {
    scopes: new Set(scopes || ALL),
    accessTtlMs,
    streamer,
    calls: [],
    refreshCount: 0,
    tokenSeq: 0,
    validAccess: new Map(), // token -> expiry ms
    validRefresh: new Set(),
    sessions: [], // { id, key, ws, token, events:Set, open }
    sessionSeq: 0,
    maxSessions: 3,
    subscribers: [], // { channelId, channelName, month, tierNo }
    restricted: [], // { restrictedChannelId }
    refused: [], // log of 403s by scope
  };
  const newTokens = () => {
    state.tokenSeq += 1;
    const accessToken = `access-${state.tokenSeq}`;
    const refreshToken = `refresh-${state.tokenSeq}`;
    state.validAccess.set(accessToken, Date.now() + state.accessTtlMs);
    state.validRefresh.add(refreshToken);
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: String(Math.max(1, Math.round(state.accessTtlMs / 1000))) };
  };
  state.issue = newTokens;

  const body = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
  const send = (res, code, content) => {
    res.writeHead(200 === code ? 200 : code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(code === 200 ? { code: 200, message: null, content } : { code, message: content }));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const b = req.method === 'GET' ? {} : await body(req);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
    state.calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body: b, auth: bearer ? 'user' : req.headers['client-id'] ? 'client' : 'none', token: bearer });
    if (p === '/auth/v1/token' && req.method === 'POST') {
      if (b.grantType === 'refresh_token') {
        if (!state.validRefresh.has(b.refreshToken)) return send(res, 401, 'INVALID_TOKEN');
        state.validRefresh.delete(b.refreshToken); // single use
        state.refreshCount += 1;
        return send(res, 200, newTokens());
      }
      return send(res, 400, '잘못된 값을 입력했습니다.');
    }
    const needUser = () => {
      const exp = state.validAccess.get(bearer);
      if (!exp || exp < Date.now()) { send(res, 401, 'INVALID_TOKEN'); return false; }
      return true;
    };
    const needScope = (name) => {
      if (!needUser()) return false;
      if (!state.scopes.has(name)) { state.refused.push(name); send(res, 403, 'FORBIDDEN'); return false; }
      return true;
    };
    if (p === '/open/v1/sessions/auth') {
      if (!needUser()) return undefined;
      const live = state.sessions.filter((s) => s.open).length;
      if (live >= state.maxSessions) return send(res, 400, '연결 가능한 세션 수를 초과했습니다.');
      return send(res, 200, { url: `http://127.0.0.1:${server.address().port}?auth=${bearer}` });
    }
    const sub = /^\/open\/v1\/sessions\/events\/subscribe\/(chat|donation|subscription)$/.exec(p);
    if (sub && req.method === 'POST') {
      const scope = { chat: '채팅 메시지 조회', donation: '후원 조회', subscription: '구독 조회' }[sub[1]];
      if (!needScope(scope)) return undefined;
      const s = state.sessions.find((x) => x.key === url.searchParams.get('sessionKey') && x.open);
      if (!s) return send(res, 400, '잘못된 값을 입력했습니다.');
      s.events.add(sub[1].toUpperCase());
      s.ws.send(`42${JSON.stringify(['SYSTEM', { type: 'subscribed', data: { eventType: sub[1].toUpperCase(), channelId: CHANNEL } }])}`);
      return send(res, 200, {});
    }
    if (p === '/open/v1/users/me') { if (!needScope('유저 정보 조회')) return undefined; return send(res, 200, { channelId: CHANNEL, channelName: '호시아' }); }
    if (p === '/open/v1/channels' && req.method === 'GET') {
      if (req.headers['client-id'] !== 'cid' || req.headers['client-secret'] !== 'csecret') return send(res, 401, 'INVALID_CLIENT');
      const ids = String(url.searchParams.get('channelIds') || '').split(',');
      return send(res, 200, { data: ids.map((id) => ({ channelId: id, channelName: `닉-${id.slice(0, 4)}`, channelImageUrl: `https://img.example/${id.slice(0, 4)}.png`, followerCount: 1234, verifiedMark: false })) });
    }
    if (p === '/open/v1/channels/subscribers') {
      if (!needScope('채널 구독자 조회')) return undefined;
      const page = Number(url.searchParams.get('page') || 0);
      const size = Number(url.searchParams.get('size') || 30);
      return send(res, 200, { data: state.subscribers.slice(page * size, page * size + size) });
    }
    if (p === '/open/v1/restrict-channels') {
      if (req.method === 'GET') { if (!needScope('활동제한 조회')) return undefined; return send(res, 200, { data: state.restricted, page: {} }); }
      if (!needScope('활동제한 쓰기')) return undefined;
      if (req.method === 'POST') { state.restricted.push({ restrictedChannelId: b.targetChannelId }); return send(res, 200, {}); }
      if (req.method === 'DELETE') { state.restricted = state.restricted.filter((x) => x.restrictedChannelId !== b.targetChannelId); return send(res, 200, {}); }
    }
    if (p === '/open/v1/temporary-restrict-channels') {
      if (!needScope('활동제한 쓰기')) return undefined;
      if (!b.targetChannelId || !b.chatChannelId) return send(res, 400, '존재하지 않는 사용자');
      return send(res, 200, {});
    }
    if (p === '/open/v1/chats/blind-message') {
      if (!needScope('채팅 메시지 쓰기')) return undefined;
      if (!state.streamer) return send(res, 400, '스트리머가 아닙니다.');
      if (b.messageTime === 404) return send(res, 404, '해당 메시지를 찾을 수 없습니다.');
      return send(res, 200, {});
    }
    if (p === '/open/v1/chats/notice') { if (!needScope('채팅 공지 쓰기')) return undefined; return send(res, 200, {}); }
    if (p === '/open/v1/chats/send') { if (!needScope('채팅 메시지 쓰기')) return undefined; return send(res, 200, { messageId: 'm1' }); }
    if (p === '/open/v1/lives/setting') {
      if (!needScope('방송 설정 조회')) return undefined;
      return send(res, 200, { defaultLiveTitle: '테스트 방송', category: { categoryType: 'GAME', categoryId: 'g1', categoryValue: '에이스 컴뱃' }, tags: ['a'] });
    }
    return send(res, 404, 'NOT_FOUND');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    const token = u.searchParams.get('auth') || '';
    const ok = u.pathname === '/socket.io/' && u.searchParams.get('EIO') === '3' && u.searchParams.get('transport') === 'websocket' && (state.validAccess.get(token) || 0) > Date.now() - 1000;
    if (!ok) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.sessionSeq += 1;
      const s = { id: state.sessionSeq, key: `sk-${state.sessionSeq}`, ws, token, events: new Set(), open: true };
      state.sessions.push(s);
      ws.on('message', (m) => { if (String(m) === '2') ws.send('3'); }); // the CLIENT pings in Engine.IO v3
      ws.on('close', () => { s.open = false; });
      ws.send(`0${JSON.stringify({ sid: `e${s.id}`, upgrades: [], pingInterval: 25000, pingTimeout: 60000 })}`);
      ws.send('40');
      ws.send(`42${JSON.stringify(['SYSTEM', { type: 'connected', data: { sessionKey: s.key } }])}`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    state,
    apiBase: `http://127.0.0.1:${server.address().port}`,
    /** Push an event to every OPEN session that subscribed to it. kind: CHAT | DONATION | SUBSCRIPTION */
    emit(kind, data) { for (const s of state.sessions) if (s.open && s.events.has(kind)) s.ws.send(`42${JSON.stringify([kind, data])}`); },
    sendSystem(type, data, which = 'all') { for (const s of state.sessions) if (s.open && (which === 'all' || s.key === which)) s.ws.send(`42${JSON.stringify(['SYSTEM', { type, data }])}`); },
    dropAll() { for (const s of state.sessions) if (s.open) s.ws.terminate(); },
    openSessions() { return state.sessions.filter((s) => s.open); },
    async close() {
      for (const s of state.sessions) try { s.ws.terminate(); } catch {}
      wss.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}
