// Tests for the official CHZZK Open API reader (docs/plans/chzzk-official.md): mapping of every official event against the old
// message shape, the Session manager (scopes, token refresh/roll-over, reconnect, connection cap, revoke), the official / unofficial
// switch without duplicates, the viewer card's 관리 actions (request shapes and error answers) and the 점검 line.
// Everything runs against tools/dev/mock-chzzk-open.mjs on loopback. No Naver host, no real token, nothing in %APPDATA%.
//   node --test tools/dev/test-chzzk-official.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ALLMIND_DEV = '1';
process.env.ALLMIND_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'allmind-chzzk-official-')); // before config.js is loaded
const { ChzzkOpen } = await import('../../src/chzzkopen.js');
const { Chzzk } = await import('../../src/chzzk.js');
const { ChzzkSession, mapChat, mapDonation, mapSubscription, SubscriberIndex, ALL_SCOPES } = await import('../../src/chzzkofficial.js');
const { ViewerCard } = await import('../../src/viewercard.js');
const { publicChat } = await import('../../src/api.js');
const { SioClient, engineUrl, parseSocket } = await import('../../src/socketio.js');
const { readerPreflight } = await import('../../src/preflight.js');
const { startMockChzzkOpen, CHANNEL, CHAT_CHANNEL } = await import('./mock-chzzk-open.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}
const quiet = () => {};
const VIEWER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// a full stack on a mock: ChzzkOpen (logged in) + Chzzk + ChzzkSession (+ ViewerCard)
async function stack({ mock, login = true, sessionOpts = {}, cfg = {} } = {}) {
  const config = {
    chzzkOpen: { apiBase: mock.apiBase, clientId: 'cid', clientSecret: 'csecret' },
    chzzk: { channelId: '', pollSeconds: 3600, chatHistory: 300, apiBase: 'http://127.0.0.1:1', gameApiBase: 'http://127.0.0.1:1', chatServer: '', ...cfg },
  };
  const open = new ChzzkOpen(config);
  if (login) {
    const t = mock.state.issue();
    open.auth = { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Date.now() + mock.state.accessTtlMs, refreshUntil: Date.now() + 30 * 86400000, loginAt: Date.now(), channelName: '호시아' };
  }
  const realSI = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const t = realSI(...a); t.unref?.(); return t; }; // Chzzk's constructor timers must not keep the test process alive
  const chzzk = new Chzzk(config);
  globalThis.setInterval = realSI;
  chzzk.channelId = CHANNEL;
  const session = new ChzzkSession({ open, log: quiet, backoffMs: [60, 120], minRollWaitMs: 150, ...sessionOpts });
  chzzk.attachOfficial(session);
  const card = new ViewerCard({ chzzk, chzzkOpen: open, session });
  const live = [];
  chzzk.on('live-chat', (l) => live.push(...l));
  return { config, open, chzzk, session, card, live, stop: () => session.stop() };
}
const chatEvent = (over = {}) => ({
  channelId: CHANNEL, senderChannelId: VIEWER, chatChannelId: CHAT_CHANNEL, content: '안녕하세요 {:d_12:}', messageTime: 1795333981000,
  profile: { nickname: '시청자1', badges: [{ imageUrl: 'https://img.example/b1.png' }], verifiedMark: true }, userRoleCode: 'common_user', emojis: { d_12: 'https://img.example/e12.png' }, ...over,
});

test('Socket.IO v2 helpers: URL and packets', () => {
  const u = new URL(engineUrl('https://ssio08.nchat.naver.com:443?auth=TOKEN'));
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.pathname, '/socket.io/');
  assert.equal(u.searchParams.get('EIO'), '3');
  assert.equal(u.searchParams.get('transport'), 'websocket');
  assert.equal(u.searchParams.get('auth'), 'TOKEN');
  assert.deepEqual(parseSocket('2["CHAT",{"a":1}]'), { type: '2', nsp: '/', id: '', data: ['CHAT', { a: 1 }] });
  assert.equal(parseSocket('0').type, '0');
  assert.equal(parseSocket('2["x"'), null);
});

test('every official event maps into the same internal shape as the unofficial reader (field by field)', () => {
  const subs = new SubscriberIndex();
  subs.replace([{ channelId: VIEWER, month: 7, tierNo: 2 }]);
  // the same viewer line as the unofficial socket would have sent it
  const old = Chzzk.prototype._normalize.call({ seq: 0 }, {
    msgTypeCode: 1, msgTime: 1795333981000, uid: VIEWER, msg: '안녕하세요 {:d_12:}',
    profile: JSON.stringify({ nickname: '시청자1', verifiedMark: true, userRoleCode: 'common_user', streamingProperty: { subscription: { accumulativeMonth: 7, tier: 2 } } }),
    extras: JSON.stringify({ emojis: { d_12: 'https://img.example/e12.png' } }),
  });
  const off = mapChat(chatEvent(), (uid) => subs.get(uid));
  for (const k of ['platform', 'time', 'uid', 'nick', 'role', 'verified', 'text', 'kind', 'amount', 'donationType', 'months']) assert.deepEqual(off[k], old[k], `field ${k}`);
  assert.deepEqual(off.emojis, old.emojis);
  assert.equal(off.key, old.key, 'same de-dup key');
  assert.deepEqual({ months: off.sub.months, tier: off.sub.tier }, { months: old.sub.months, tier: old.sub.tier }, 'sub comes from the subscriber list');
  assert.equal(off.sub.img, '', 'no badge image from the official API');
  // roles
  assert.equal(mapChat(chatEvent({ userRoleCode: 'streamer' })).role, 'streamer');
  assert.equal(mapChat(chatEvent({ userRoleCode: 'streaming_channel_manager' })).role, 'manager');
  assert.equal(mapChat(chatEvent({ userRoleCode: 'streaming_chat_manager' })).role, 'manager');
  assert.equal(mapChat(chatEvent({ userRoleCode: 'common_user' })).role, '');
  // unknown pieces are null / empty, never invented
  const bare = mapChat({ content: 'x', senderChannelId: VIEWER, profile: {} });
  assert.equal(bare.sub, null);
  assert.deepEqual(bare.badges, []);
  assert.equal(bare.verified, false);
  assert.equal(bare.nick, '');
  assert.deepEqual(bare.emojis, {});
  // 후원: CHAT and VIDEO; payAmount string -> number; no time in the event (receive time); anonymous -> 익명
  const d1 = mapDonation({ donationType: 'VIDEO', donatorChannelId: VIEWER, donatorNickname: '후원자', payAmount: '3000', donationText: '영도 부탁', emojis: {} }, 111);
  assert.deepEqual([d1.kind, d1.donationType, d1.amount, d1.nick, d1.uid, d1.time, d1.text], ['donation', 'VIDEO', 3000, '후원자', VIEWER, 111, '영도 부탁']);
  const d2 = mapDonation({ donationType: 'CHAT', payAmount: '1000', donationText: '' }, 5);
  assert.equal(d2.nick, '익명');
  assert.equal(d2.uid, '');
  const d3 = mapDonation({ donationType: 'CHAT', payAmount: 'abc' }, 5);
  assert.equal(d3.amount, null);
  // 구독
  const s1 = mapSubscription({ subscriberChannelId: VIEWER, subscriberNickname: '구독자', tierNo: 1, tierName: '기본 구독', month: 3 }, 9);
  assert.deepEqual([s1.kind, s1.months, s1.nick, s1.uid, s1.time], ['subscription', 3, '구독자', VIEWER, 9]);
  assert.match(s1.text, /3개월/);
  assert.deepEqual({ months: s1.sub.months, tier: s1.sub.tier }, { months: 3, tier: 1 });
  // the public /api/v1/events shapes (docs/contracts/events.md) stay the same keys as for the unofficial lines
  const pubOld = publicChat({ ...old, id: 1 });
  const pubOff = publicChat({ ...off, id: 1 });
  assert.equal(pubOff[0], 'chat');
  assert.deepEqual(Object.keys(pubOff[1]).sort(), Object.keys(pubOld[1]).sort());
  assert.deepEqual(Object.keys(publicChat({ ...d1, id: 2 })[1]).sort(), Object.keys(publicChat({ ...Chzzk.prototype._normalize.call({ seq: 0 }, { msgTypeCode: 10, msgTime: 1, uid: VIEWER, msg: 'x', profile: '{"nickname":"a"}', extras: '{"payAmount":1000,"donationType":"VIDEO"}' }), id: 2 })[1]).sort());
  assert.equal(publicChat({ ...s1, id: 3 })[1].kind, 'subscription');
  assert.equal(publicChat({ ...s1, id: 3 })[1].months, 3);
});

test('official reader: chat / 후원 / 구독 arrive once, in the old shape, with no unofficial socket', async (t) => {
  const mock = await startMockChzzkOpen();
  const s = await stack({ mock });
  t.after(async () => { s.stop(); await mock.close(); });
  mock.state.subscribers = [{ channelId: VIEWER, channelName: '시청자1', month: 5, tierNo: 1 }];
  let connectCalls = 0;
  s.chzzk._connectChat = () => { connectCalls += 1; }; // must never be used while the official reader is in charge
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  assert.equal(s.chzzk.mode, 'official');
  assert.equal(s.chzzk.readerStatus().label, '공식 API');
  await until(() => mock.openSessions()[0]?.events.size === 3, 'all three subscriptions');
  await until(() => s.session.subs.size === 1, 'subscriber list loaded');

  mock.emit('CHAT', chatEvent());
  mock.emit('DONATION', { donationType: 'VIDEO', channelId: CHANNEL, donatorChannelId: VIEWER, donatorNickname: '후원자', payAmount: '5000', donationText: '영도!', emojis: {} });
  mock.emit('SUBSCRIPTION', { channelId: CHANNEL, subscriberChannelId: VIEWER, subscriberNickname: '구독자', tierNo: 1, tierName: '기본', month: 6 });
  await until(() => s.live.length === 3, 'three live lines');
  assert.deepEqual(s.live.map((m) => m.kind), ['chat', 'donation', 'subscription']);
  assert.equal(s.live[0].sub.months, 5, 'subscriber badge rebuilt from the subscriber list');
  assert.equal(s.live[0].text, '안녕하세요 {:d_12:}');
  assert.equal(s.live[1].donationType, 'VIDEO');
  assert.equal(s.live[1].amount, 5000);
  assert.equal(s.chzzk.chatChannelId, CHAT_CHANNEL, 'chatChannelId comes from the chat event');
  assert.deepEqual(s.chzzk.donations.map((d) => d.kind), ['donation', 'subscription'], 'dashboard 후원 list');
  assert.equal(s.chzzk.chat.length, 3);
  assert.deepEqual(s.live.map((m) => m.id), [1, 2, 3], 'one internal id each');
  assert.equal(connectCalls, 0, 'the unofficial chat socket is never opened in official mode');
  assert.equal(s.chzzk.ws, null);
  // exactly one session was needed
  assert.equal(mock.state.sessions.length, 1);
  assert.ok(mock.state.calls.filter((c) => c.path === '/open/v1/sessions/auth').every((c) => c.auth === 'user'));
});

test('scopes: login with all, some or no scopes', async (t) => {
  // some: no 후원/구독 scopes -> chat works, the 점검 line lists what to tick
  const some = await startMockChzzkOpen({ scopes: ['채팅 메시지 조회', '유저 정보 조회'] });
  const a = await stack({ mock: some });
  t.after(async () => { a.stop(); await some.close(); });
  a.session.start();
  await until(() => a.chzzk.chatState === 'connected', 'chat connected with only the chat scope');
  await until(() => a.session.missing.has('후원 조회') && a.session.missing.has('구독 조회') && a.session.missing.has('채널 구독자 조회'), 'missing scopes noticed');
  assert.equal(a.chzzk.mode, 'official', 'chat alone keeps the official reader');
  const st = a.chzzk.readerStatus();
  assert.ok(st.missing.includes('후원 조회') && st.missing.includes('구독 조회'));
  assert.deepEqual(st.requiredScopes, ALL_SCOPES);
  for (const need of ['채팅 메시지 조회', '후원 조회', '구독 조회', '채팅 메시지 쓰기', '채팅 공지 쓰기', '활동제한 조회', '활동제한 쓰기', '채널 구독자 조회', '유저 정보 조회', '방송 설정 조회', '방송 설정 변경']) assert.ok(ALL_SCOPES.includes(need), need);
  const pf = readerPreflight(st);
  assert.equal(pf.status, 'warn');
  assert.match(pf.text, /후원 조회/);
  assert.match(pf.hint, /다시 해/);

  // none: no chat scope -> the official reader is not usable, the labelled fallback takes over (never both)
  const none = await startMockChzzkOpen({ scopes: [] });
  const b = await stack({ mock: none });
  t.after(async () => { b.stop(); await none.close(); });
  b.session.start();
  await until(() => b.session.missing.has('채팅 메시지 조회'), 'chat scope refused');
  assert.equal(b.session.usable(), false);
  assert.equal(b.chzzk.mode, 'unofficial-fallback');
  assert.match(b.chzzk.readerStatus().label, /치지직 로그인 없이/);
  assert.match(readerPreflight(b.chzzk.readerStatus()).text, /비공식 \(로그인 필요\)/);
  assert.equal(none.state.sessions.length >= 0, true);
  b.stop();

  // all (default) is covered by the other tests; and no login at all:
  const m3 = await startMockChzzkOpen();
  const c = await stack({ mock: m3, login: false });
  t.after(async () => { c.stop(); await m3.close(); });
  c.session.start();
  await sleep(150);
  assert.equal(c.chzzk.mode, 'unofficial-fallback');
  assert.equal(m3.state.calls.length, 0, 'no login: no Open API call at all');
});

test('token refresh mid-session: the next session is opened before the token expires, no gap, no duplicate', async (t) => {
  const mock = await startMockChzzkOpen({ accessTtlMs: 70000 }); // chzzkopen treats a token as expired 60 s early: rolls about every second here
  const s = await stack({ mock, sessionOpts: { rollMarginMs: 68000 } });
  t.after(async () => { s.stop(); await mock.close(); });
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  await until(() => mock.state.refreshCount >= 1 && mock.state.sessions.length >= 2, 'roll-over happened', 6000);
  await until(() => mock.openSessions().length === 1, 'old session closed, one left');
  assert.ok(mock.openSessions().length <= 3, 'never above the cap');
  const n0 = s.live.length;
  mock.emit('CHAT', chatEvent({ content: '롤오버 뒤 한 줄', messageTime: 1795333999000 }));
  await until(() => s.live.length === n0 + 1, 'line after the roll-over');
  await sleep(200);
  assert.equal(s.live.length, n0 + 1, 'delivered exactly once');
  assert.equal(s.live.at(-1).text, '롤오버 뒤 한 줄');
  // the new session used a refreshed token
  const tokens = new Set(mock.state.calls.filter((c) => c.path === '/open/v1/sessions/auth').map((c) => c.token));
  assert.ok(tokens.size >= 2, 'a refreshed access token was used');
});

test('disconnect and reconnect with backoff; the connection cap is respected', async (t) => {
  const mock = await startMockChzzkOpen();
  const s = await stack({ mock });
  t.after(async () => { s.stop(); await mock.close(); });
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  const first = mock.state.sessions[0].key;
  mock.dropAll();
  await until(() => mock.state.sessions.length === 2 && mock.openSessions()[0]?.events.size === 3, 'reconnected and re-subscribed');
  assert.notEqual(mock.openSessions()[0].key, first);
  await until(() => s.chzzk.chatState === 'connected', 'connected again');
  mock.emit('CHAT', chatEvent({ content: '다시 연결됨' }));
  await until(() => s.live.some((m) => m.text === '다시 연결됨'), 'chat after reconnect');
  assert.equal(s.live.filter((m) => m.text === '다시 연결됨').length, 1);
  // cap: the API refuses a 4th session; the manager keeps trying with backoff and reports it
  const m2 = await startMockChzzkOpen();
  m2.state.maxSessions = 0;
  const c = await stack({ mock: m2 });
  t.after(async () => { c.stop(); await m2.close(); });
  c.session.start();
  await until(() => c.session.state === 'error' && /세션/.test(c.session.error), 'cap error reported');
  assert.equal(c.chzzk.chatState, 'error');
  assert.equal(c.chzzk.mode, 'official', 'a refused session is an error to show, not a silent switch to the other reader');
  m2.state.maxSessions = 3;
  await until(() => c.chzzk.chatState === 'connected', 'recovers when the cap frees up');
});

test('official / unofficial switch: only the reader in charge delivers, nothing twice', async (t) => {
  const mock = await startMockChzzkOpen();
  const s = await stack({ mock });
  t.after(async () => { s.stop(); await mock.close(); });
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  mock.emit('CHAT', chatEvent({ content: 'one', messageTime: 1 }));
  await until(() => s.live.length === 1, 'one line');
  // Stan switches on 비공식 연결 (미션 후원 포함): the official events are ignored from now on
  s.chzzk.cfg.unofficialReader = true;
  assert.equal(s.chzzk.mode, 'unofficial-optin');
  mock.emit('CHAT', chatEvent({ content: 'two (official, must be ignored)', messageTime: 2 }));
  await sleep(150);
  assert.equal(s.live.length, 1, 'no official line while the unofficial reader is on');
  // ... and back
  s.chzzk.cfg.unofficialReader = false;
  assert.equal(s.chzzk.mode, 'official');
  mock.emit('CHAT', chatEvent({ content: 'three', messageTime: 3 }));
  await until(() => s.live.length === 2, 'official again');
  assert.deepEqual(s.live.map((m) => m.text), ['one', 'three']);
  // a channel mismatch (logged in as another channel) is not usable officially
  s.session.channelId = 'f'.repeat(32);
  assert.equal(s.chzzk.mode, 'unofficial-fallback');
  assert.equal(s.chzzk.readerStatus().channelMismatch, true);
});

test('revoked permission: the manager stops, shows the reason, and a new login clears it', async (t) => {
  const mock = await startMockChzzkOpen();
  const s = await stack({ mock });
  t.after(async () => { s.stop(); await mock.close(); });
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  mock.sendSystem('revoked', { eventType: 'CHAT', channelId: CHANNEL });
  await until(() => s.session.state === 'revoked', 'revoked');
  assert.match(s.session.error, /다시 로그인/);
  assert.equal(s.chzzk.mode, 'unofficial-fallback', 'a revoked permission means the official reader cannot carry chat');
  s.open.auth.loginAt = Date.now() + 1; // the owner logs in again
  s.session.noteLogin();
  assert.equal(s.session.state, 'idle');
  assert.equal(s.chzzk.mode, 'official');
  await until(() => s.chzzk.chatState === 'connected', 'connected after the new login', 12000);
});

test('viewer card: official profile, 관리 action request shapes and error answers', async (t) => {
  const mock = await startMockChzzkOpen();
  const s = await stack({ mock });
  t.after(async () => { s.stop(); await mock.close(); });
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  mock.emit('CHAT', chatEvent({ content: '이 글에 조치', messageTime: 1795333981234 }));
  await until(() => s.live.length === 1, 'line');
  const msgId = s.live[0].id;
  const calls = () => mock.state.calls;
  const last = (p) => [...calls()].reverse().find((c) => c.path === p);

  const card = await s.card.card(VIEWER);
  assert.equal(card.canManage, true);
  assert.equal(card.profile.nick, `닉-${VIEWER.slice(0, 4)}`);
  assert.equal(card.profile.followDate, '', 'no follow date in the official API');
  assert.equal(card.counts.restricted, false);
  assert.equal(card.counts.messages, null, 'no message counts in the official API');
  assert.equal(last('/open/v1/channels').auth, 'client', 'the profile uses Client-Id / Client-Secret');

  await s.card.act('temp', VIEWER, msgId);
  assert.deepEqual(last('/open/v1/temporary-restrict-channels').body, { targetChannelId: VIEWER, chatChannelId: CHAT_CHANNEL });
  await s.card.act('restrict', VIEWER, msgId);
  assert.deepEqual(last('/open/v1/restrict-channels').body, { targetChannelId: VIEWER });
  assert.equal(last('/open/v1/restrict-channels').method, 'POST');
  s.card.cache.clear();
  assert.equal((await s.card.card(VIEWER)).counts.restricted, true, '활동 제한 중 shows from the restriction list');
  await s.card.act('unrestrict', VIEWER, msgId);
  assert.equal(last('/open/v1/restrict-channels').method, 'DELETE');
  assert.deepEqual(last('/open/v1/restrict-channels').body, { targetChannelId: VIEWER });
  const r = await s.card.act('blind', VIEWER, msgId);
  assert.equal(r.done, '메시지를 숨겼어요', 'labelled 숨기기, not 삭제');
  assert.deepEqual(last('/open/v1/chats/blind-message').body, { chatChannelId: CHAT_CHANNEL, messageTime: 1795333981234, senderChannelId: VIEWER });
  assert.equal(s.chzzk.chat[0].hidden, true);
  const n = await s.card.act('notice', VIEWER, msgId);
  assert.match(n.done, /100자/);
  assert.deepEqual(last('/open/v1/chats/notice').body, { message: '이 글에 조치' });
  // text longer than 100 characters is cut for the notice
  mock.emit('CHAT', chatEvent({ content: '가'.repeat(150), messageTime: 1795333981999 }));
  await until(() => s.live.length === 2, 'long line');
  await s.card.act('notice', VIEWER, s.live[1].id);
  assert.equal(last('/open/v1/chats/notice').body.message.length, 100);
  // no official endpoint for 채팅 운영자
  await assert.rejects(() => s.card.act('manager', VIEWER, msgId), /스튜디오/);
  await assert.rejects(() => s.card.act('unmanager', VIEWER, msgId), /스튜디오/);
  await assert.rejects(() => s.card.act('temp', CHANNEL, msgId), /내 채널/);

  // answers: 400 "스트리머가 아닙니다", 403 (scope), 404
  mock.state.streamer = false;
  await assert.rejects(() => s.card.act('blind', VIEWER, msgId), /스트리머 계정/);
  mock.state.streamer = true;
  mock.state.scopes.delete('활동제한 쓰기');
  await assert.rejects(() => s.card.act('temp', VIEWER, msgId), /활동제한 쓰기.*권한.*다시 해/);
  mock.state.scopes.add('활동제한 쓰기');
  mock.emit('CHAT', chatEvent({ content: '없는 글', messageTime: 404 }));
  await until(() => s.live.length === 3, 'third line');
  await assert.rejects(() => s.card.act('blind', VIEWER, s.live[2].id), /찾지 못했어요/);
  // not logged in: no actions
  s.open.auth = null;
  await assert.rejects(() => s.card.act('restrict', VIEWER, msgId), /로그인/);
  assert.equal((await s.card.card('b'.repeat(32))).canManage, false);
});

test('official mode live status: on-air and uptime from OBS, title/category from 방송 설정, viewers "–" unless the opt-in poll is on', async (t) => {
  const mock = await startMockChzzkOpen();
  const s = await stack({ mock });
  t.after(async () => { s.stop(); await mock.close(); });
  let obs = { live: false, startedAt: null };
  s.chzzk.obsLive = () => obs;
  s.chzzk.settingFn = () => s.open.getSetting();
  s.session.start();
  await until(() => s.chzzk.chatState === 'connected', 'connected');
  await s.chzzk._poll();
  assert.equal(s.chzzk.live.isLive, false);
  assert.equal(s.chzzk.live.title, '테스트 방송');
  assert.equal(s.chzzk.live.category, '에이스 컴뱃');
  assert.equal(s.chzzk.live.viewers, null);
  assert.equal(s.chzzk.live.peak, null);
  assert.equal(s.chzzk.live.adult, null);
  obs = { live: true, startedAt: Date.UTC(2026, 10, 25, 3, 0, 0) }; // 12:00:00 Korean time
  await s.chzzk._poll();
  assert.equal(s.chzzk.live.isLive, true);
  assert.equal(s.chzzk.live.openDate, '2026-11-25 12:00:00');
  assert.equal(s.chzzk.live.viewers, null, 'no viewer count without the opt-in poll');
  assert.equal(s.chzzk.donationSession, '2026-11-25 12:00:00', 'a new broadcast starts a fresh 후원 list');
});

test('점검 line text for the three readers', () => {
  assert.deepEqual(readerPreflight({ mode: 'official', missing: [], session: { state: 'connected' }, requiredScopes: ALL_SCOPES }).status, 'ok');
  assert.equal(readerPreflight({ mode: 'official', missing: [], session: { state: 'connected' }, requiredScopes: ALL_SCOPES }).text, '공식 API');
  assert.equal(readerPreflight({ mode: 'official', missing: ['후원 조회'], session: {}, requiredScopes: ALL_SCOPES }).status, 'warn');
  const opt = readerPreflight({ mode: 'unofficial-optin', requiredScopes: ALL_SCOPES });
  assert.match(opt.text, /미션 후원/);
  const fb = readerPreflight({ mode: 'unofficial-fallback', requiredScopes: ALL_SCOPES });
  assert.match(fb.text, /비공식 \(로그인 필요\)/);
  for (const sc of ALL_SCOPES) assert.ok(fb.hint.includes(sc), `the hint lists ${sc}`);
  assert.equal(readerPreflight({ mode: 'official', missing: [], channelMismatch: true, session: {}, requiredScopes: ALL_SCOPES }).status, 'warn');
  assert.equal(readerPreflight({ mode: 'official', missing: [], session: { state: 'revoked', error: '권한 회수' }, requiredScopes: ALL_SCOPES }).status, 'warn');
});
