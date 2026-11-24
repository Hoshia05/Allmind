#!/usr/bin/env node
// M0 characterization test (docs/plans/modules.md): one call per Xylem feature + the platform basics, against the mock.
// It records what the server does TODAY (status codes, ok flags, event names, snapshot keys) and fails when that changes,
// so every refactor step (M1, M5, M2 …) must keep it green.
//
//   node tools/dev/smoke.mjs                    starts the mock (tools/dev/up.sh), runs, stops it (down.sh)
//   node tools/dev/smoke.mjs --running          use an already running mock + server on :8080 (leaves it running)
//   node tools/dev/smoke.mjs --update-baseline  write tools/dev/smoke-baseline.json from this run (only when a change is intended)
//
// Additive changes pass (new snapshot keys, new checks); removed keys or a check that behaves differently fail.
// Works on Linux and Windows (Git Bash's `sh` on PATH). Mock-only by nature: says nothing about real OBS/Chzzk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE = path.join(ROOT, 'tools/dev/smoke-baseline.json');
const args = new Set(process.argv.slice(2));
const PORT = 8080;
const MOCK = 9333;
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny HTTP + SSE helpers (node:http, so Host/Origin can be set) ----------
function request(method, p, { body, headers = {}, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, type: res.headers['content-type'] || '' });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout ${method} ${p}`)));
    if (data) req.write(data);
    req.end();
  });
}
const get = (p, o) => request('GET', p, o);
const post = (p, body = {}, o = {}) => request('POST', p, { ...o, body });

// Opens an SSE stream; collects {event, data} until close(). wait(pred, ms) resolves with the first matching event.
function sse(p, { headers = {} } = {}) {
  const events = [];
  const waiters = [];
  let res0;
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { accept: 'text/event-stream', ...headers } }, (res) => {
    res0 = res;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = (blk.match(/^event: ?(.*)$/m) || [, 'message'])[1];
        const raw = blk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data: ?/, '')).join('\n');
        if (!raw && !/^event:/m.test(blk)) continue; // comment / keep-alive
        let data = raw;
        try { data = JSON.parse(raw); } catch {}
        const ev = { event, data };
        events.push(ev);
        for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(ev); }
      }
    });
  });
  req.on('error', () => {});
  return {
    events,
    status: () => res0?.statusCode,
    wait(pred, ms = 5000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no matching event on ${p} within ${ms} ms (got: ${[...new Set(events.map((e) => e.event))].join(', ') || 'nothing'})`)); }, ms) };
        waiters.push(w);
      });
    },
    close() { req.destroy(); },
  };
}

const mockChat = (body) => request('POST', '/mock/chat', { body, port: MOCK });
const obsCmd = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools/dev/obs.mjs'), ...a], { cwd: ROOT, encoding: 'utf8' });
const result = (r) => ({ status: r.status, ok: r.json?.ok ?? null });

// ---------- the checks: each returns a small, stable "behavior" object that goes into the baseline ----------
const checks = [];
const check = (group, name, fn) => checks.push({ group, name, fn });

// platform basics
check('platform', 'ping', async () => {
  const r = await get('/api/ping');
  if (r.json?.version !== VERSION) throw new Error(`version ${r.json?.version} != package.json ${VERSION}`);
  return { status: r.status, app: r.json.app };
});
check('platform', 'pages', async () => {
  const out = {};
  for (const p of ['/', '/launcher', '/mark']) out[p] = (await get(p)).status;
  return out;
});
check('platform', 'dashboard-sse', async () => {
  const s = sse('/api/events');
  try {
    const st = await s.wait((e) => e.event === 'state');
    await s.wait((e) => e.event === 'chat-history');
    return { status: s.status(), snapshotKeys: Object.keys(st.data).sort() };
  } finally { s.close(); }
});
check('platform', 'scene', async () => {
  const s = sse('/api/events');
  try {
    const r = await post('/api/scene', { name: 'BRB' });
    await s.wait((e) => e.event === 'state' && e.data?.studio?.scene === 'BRB');
    const back = await post('/api/scene', { name: 'Main' });
    const bad = await post('/api/scene', { name: '없는 장면' });
    return { set: result(r), back: result(back), unknown: result(bad) };
  } finally { s.close(); }
});
check('platform', 'bgm', async () => ({
  next: result(await post('/api/bgm/next')),
  prev: result(await post('/api/bgm/prev')),
  volume: result(await post('/api/bgm/volume', { db: -20 })),
  toggle: result(await post('/api/bgm/toggle')),
  toggleBack: result(await post('/api/bgm/toggle')),
}));
check('platform', 'soundboard', async () => {
  await post('/api/sb/create-source'); // the mock OBS starts without the "Soundboard" source (result depends on earlier runs)
  return { play: result(await post('/api/sb/play', { id: '박수.mp3' })), stop: result(await post('/api/sb/stop')) };
});
check('platform', 'todo', async () => {
  const add = await post('/api/todo/add', { title: 'smoke 할 일', tonight: true });
  const id = add.json?.item?.id;
  const chk = await post('/api/todo/check', { id: String(id || ''), done: true });
  const un = await post('/api/todo/check', { id: String(id || ''), done: false });
  const rm = await post('/api/todo/remove', { id: String(id || '') });
  return { add: result(add), gotId: !!id, check: result(chk), uncheck: result(un), remove: result(rm) };
});
check('platform', 'mark', async () => {
  const idle = await post('/api/mark', { label: 'smoke' }); // not recording → 409
  obsCmd('StartRecord');
  let rec = null;
  for (let i = 0; i < 20 && !(rec?.status === 200); i++) { await sleep(250); rec = await post('/api/mark', { label: 'smoke' }); }
  const marks = await get('/api/marks');
  const label = await post('/api/mark/label', { index: 0, label: 'smoke 2' });
  obsCmd('StopRecord');
  await sleep(500);
  return { idle: idle.status, recording: rec?.status, marksStatus: marks.status, label: result(label) };
});
check('platform', 'chat-and-donation', async () => {
  const s = sse('/api/events');
  try {
    await s.wait((e) => e.event === 'state');
    const tag = `smoke-${Date.now()}`;
    await mockChat({ nick: '스모크', text: tag });
    const chat = await s.wait((e) => e.event === 'chat' && JSON.stringify(e.data).includes(tag));
    await mockChat({ nick: '스모크', text: `${tag}-don`, amount: 1000 });
    const don = await s.wait((e) => e.event === 'donations' && JSON.stringify(e.data).includes(`${tag}-don`));
    const line = (Array.isArray(chat.data) ? chat.data : [chat.data]).flat().find((m) => JSON.stringify(m).includes(tag)) || {};
    return { chatEvent: chat.event, donationEvent: don.event, chatFields: Object.keys(line).sort() };
  } finally { s.close(); }
});
check('platform', 'deck', async () => {
  const s = sse('/deck/events');
  try {
    const hello = await s.wait((e) => e.event === 'hello');
    const t1 = await get('/deck/bgm-toggle');
    const t2 = await get('/deck/bgm-toggle');
    const bad = await get('/deck/no-such-action');
    return { sse: s.status(), hello: hello.event, toggle: [t1.status, t2.status], unknown: bad.status };
  } finally { s.close(); }
});
check('platform', 'guard', async () => ({
  foreignHost: (await get('/api/ping', { headers: { host: 'evil.example' } })).status,
  foreignOrigin: (await post('/api/todo/add', { text: 'x' }, { headers: { origin: 'http://evil.example' } })).status,
  crossSiteDeck: (await get('/deck/mark', { headers: { 'sec-fetch-site': 'cross-site' } })).status,
}));

// public local API (/api/v1, docs/contracts/)
// M5: every /api/v1 call needs the token (Authorization: Bearer), also on loopback. The smoke test makes a fresh one through
// the settings window's route (loopback only), like the owner pressing 새로 만들기.
let TOKEN = '';
const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}`, 'x-allmind-client': 'smoke/1' });
const v1 = (r) => ({ status: r.status, ok: r.json?.ok ?? null, code: r.json?.code ?? null });
const v1post = (p, body) => post(p, body, { headers: auth() });
async function newToken() {
  const r = await post('/api/launcher/api-token', { renew: true });
  if (!r.json?.token) throw new Error(`no token from /api/launcher/api-token (${r.status} ${r.text.slice(0, 100)})`);
  TOKEN = r.json.token;
  return r;
}
const apiStatus = async () => (await get('/api/launcher/api-token')).json || {};

check('platform', 'v1-info', async () => {
  await newToken();
  const r = await get('/api/v1/info', { headers: auth() });
  const j = r.json || {};
  if (j.version !== VERSION) throw new Error(`info.version ${j.version} != ${VERSION}`);
  return {
    status: r.status, keys: Object.keys(j).sort(), apiLevel: j.apiLevel,
    modules: Array.isArray(j.modules) ? j.modules.map((m) => m.id) : null,
    capabilitiesIsList: Array.isArray(j.capabilities),
    capabilities: j.capabilities,
    unknown: (await get('/api/v1/nope', { headers: auth() })).status,
    post: (await post('/api/v1/info', {}, { headers: auth() })).status,
  };
});
check('v1', 'auth', async () => ({
  none: v1(await get('/api/v1/info')),
  wrong: v1(await get('/api/v1/info', { headers: auth('x'.repeat(43)) })),
  query: v1(await get(`/api/v1/info?token=${TOKEN}`)),
  notBearer: v1(await get('/api/v1/info', { headers: { authorization: TOKEN } })),
  ok: v1(await get('/api/v1/info', { headers: auth() })),
  eventsNoToken: v1(await get('/api/v1/events')),
  foreignOrigin: (await post('/api/v1/mark', {}, { headers: { ...auth(), origin: 'http://evil.example' } })).status,
  unknown: v1(await get('/api/v1/nope', { headers: auth() })),
}));
check('v1', 'excluded-actions', async () => {
  const out = {};
  for (const p of ['/api/v1/chat/send', '/api/v1/obs/output', '/api/v1/record/split', '/api/v1/prep/apply', '/api/v1/chzzk/act', '/api/v1/launcher/save', '/api/v1/update/install', '/api/v1/stream']) {
    out[p] = (await v1post(p, {})).status;
  }
  return out;
});
check('v1', 'events', async () => {
  const s = sse('/api/v1/events', { headers: auth() });
  try {
    const hello = await s.wait((e) => e.event === 'hello');
    const st = await apiStatus();
    const tag = `v1-${Date.now()}`;
    await mockChat({ nick: '에이피아이', text: tag });
    const chat = await s.wait((e) => e.event === 'chat' && e.data?.text === tag);
    await mockChat({ nick: '에이피아이', text: `${tag}-don`, amount: 2000 });
    const don = await s.wait((e) => e.event === 'donation' && e.data?.text === `${tag}-don`);
    await sleep(300);
    const donAsChat = s.events.some((e) => e.event === 'chat' && e.data?.text === `${tag}-don`);
    // 🧪 테스트 추첨: fake viewers (uid test:…) must never reach /api/v1/events
    await post('/api/draw/test-run', { n: 4 });
    await sleep(3500);
    await post('/api/draw/reset');
    const testLines = s.events.filter((e) => String(e.data?.uid || '').startsWith('test:')).length;
    const sig = await get('/deck/signal?name=ptt&state=down');
    const sigEv = await s.wait((e) => e.event === 'deck-signal' && e.data?.name === 'ptt');
    const sigUp = await get('/deck/signal?name=ptt&state=up');
    const badName = (await get('/deck/signal?name=nope&state=down')).status;
    const badState = (await get('/deck/signal?name=mute&state=hold')).status;
    return {
      sse: s.status(), helloKeys: Object.keys(hello.data).sort(), stateKeys: Object.keys(hello.data.state || {}).sort(),
      streams: st.streams, dashboards: st.dashboards, // an open /api/v1/events must not count as a dashboard
      chatKeys: Object.keys(chat.data).sort(), chatPlatform: chat.data.platform, donationKeys: Object.keys(don.data).sort(),
      donAsChat, testLines,
      signal: [sig.status, sigUp.status], signalKeys: Object.keys(sigEv.data).sort(), signalState: sigEv.data.state, badName, badState,
    };
  } finally { s.close(); }
});
check('v1', 'commands', async () => {
  const s = sse('/api/v1/events', { headers: auth() });
  try {
    await s.wait((e) => e.event === 'hello');
    const out = {};
    await post('/api/launcher/api-scenes', { scenes: [] });
    out.sceneNotAllowed = v1(await v1post('/api/v1/scene', { name: 'BRB' }));
    out.allow = (await post('/api/launcher/api-scenes', { scenes: ['BRB', 'Main'] })).status;
    out.scene = v1(await v1post('/api/v1/scene', { name: 'BRB' }));
    out.sceneEvent = (await s.wait((e) => e.event === 'stream' && e.data?.what === 'scene' && e.data?.scene === 'BRB')).event;
    out.sceneBack = v1(await v1post('/api/v1/scene', { name: 'Main' }));
    out.sceneMissing = v1(await v1post('/api/v1/scene', {}));
    await post('/api/launcher/api-scenes', { scenes: [] });

    out.markIdle = v1(await v1post('/api/v1/mark', {}));
    obsCmd('StartRecord');
    await s.wait((e) => e.event === 'stream' && e.data?.what === 'recording' && e.data?.on === true);
    let m = null;
    for (let i = 0; i < 20 && m?.status !== 200; i++) { await sleep(250); m = await v1post('/api/v1/mark', { label: 'v1' }); }
    out.mark = { ...v1(m), keys: Object.keys(m.json || {}).sort() };
    const mev = await s.wait((e) => e.event === 'mark' && e.data?.label === 'v1');
    out.markEventKeys = Object.keys(mev.data).sort();
    const split = await post('/api/record/split', { title: 'smoke 2부' });
    out.split = split.status;
    const pev = await s.wait((e) => e.event === 'part', 10000);
    out.partEvent = { keys: Object.keys(pev.data).sort(), part: pev.data.part, previous: pev.data.previous };
    obsCmd('StopRecord');
    await sleep(800);

    await post('/api/sb/create-source');
    out.bgm = {
      next: v1(await v1post('/api/v1/bgm', { action: 'next' })),
      volume: v1(await v1post('/api/v1/bgm', { action: 'volume', db: -20 })),
      toggle: v1(await v1post('/api/v1/bgm', { action: 'toggle' })),
      toggleBack: v1(await v1post('/api/v1/bgm', { action: 'toggle' })),
      bad: v1(await v1post('/api/v1/bgm', { action: 'explode' })),
    };
    out.sound = {
      play: v1(await v1post('/api/v1/sound', { action: 'play', id: '박수.mp3' })),
      stop: v1(await v1post('/api/v1/sound', { action: 'stop' })),
      unknown: v1(await v1post('/api/v1/sound', { action: 'play', id: '없는 소리.mp3' })),
    };
    const add = await post('/api/todo/add', { title: 'v1 할 일', tonight: true });
    out.todo = {
      next: v1(await v1post('/api/v1/todo', { action: 'next' })),
      undo: v1(await v1post('/api/v1/todo', { action: 'undo' })),
      check: v1(await v1post('/api/v1/todo', { action: 'check', id: add.json?.item?.id, done: true })),
      uncheck: v1(await v1post('/api/v1/todo', { action: 'check', id: add.json?.item?.id, done: false })),
      bad: v1(await v1post('/api/v1/todo', { action: 'nope' })),
    };
    await post('/api/todo/remove', { id: add.json?.item?.id });
    return out;
  } finally { s.close(); }
});
check('v1', 'token-renew', async () => {
  const old = TOKEN;
  const s = sse('/api/v1/events', { headers: auth() });
  await s.wait((e) => e.event === 'hello');
  await newToken(); // 새로 만들기: the old token stops working and its streams are closed
  await sleep(300);
  const st = await apiStatus();
  s.close();
  return {
    oldToken: v1(await get('/api/v1/info', { headers: auth(old) })),
    newToken: v1(await get('/api/v1/info', { headers: auth() })),
    streamsAfter: st.streams,
    statusKeys: Object.keys(st).sort(),
  };
});

// Xylem (one call per feature)
check('xylem', 'state', async () => {
  const r = await get('/api/xylem/state');
  return { status: r.status, keys: Object.keys(r.json || {}).sort(), packModules: (r.json?.pack?.modules || []).map((m) => m.id).sort() };
});
check('xylem', 'pages', async () => {
  const out = {};
  for (const p of ['/xylem', '/dogfight', '/roulette', '/roulette-board', '/text?id=1', '/draw']) out[p] = (await get(p)).status;
  return out;
});
check('xylem', 'pack-check', async () => result(await post('/api/xylem/check')));
check('xylem', 'draw', async () => {
  const s = sse('/api/draw/events');
  try {
    const r = await post('/api/draw/test-run', { n: 5 });
    const ev = await s.wait((e) => e.event !== 'message' || e.data);
    await post('/api/draw/reset');
    return { testRun: result(r), sse: s.status(), gotEvent: !!ev };
  } finally { s.close(); }
});
check('xylem', 'roulette', async () => {
  const s = sse('/api/roulette/events');
  try {
    const r = await post('/api/roulette/test', { spins: 1 });
    const ev = await s.wait(() => true);
    await post('/api/roulette/skip');
    return { test: result(r), spins: Array.isArray(r.json?.spins) ? 'array' : typeof r.json?.spins, sse: s.status(), gotEvent: !!ev };
  } finally { s.close(); }
});
check('xylem', 'dogfight', async () => {
  const s = sse('/api/dogfight/events');
  try {
    await sleep(200);
    const r = await post('/api/dogfight/cmd', { nick: '스모크', text: '!미사일' });
    const ev = await s.wait((e) => JSON.stringify(e.data).includes('미사일'));
    return { cmd: r.status, sse: s.status(), event: ev.event };
  } finally { s.close(); }
});
check('xylem', 'text', async () => {
  const s = sse('/api/text/events');
  try {
    const r = await post('/api/text/set', { id: '1', patch: { text: 'smoke' } });
    const ev = await s.wait((e) => JSON.stringify(e.data).includes('smoke'));
    const clear = await post('/api/text/set', { id: '1', patch: { text: '' } });
    return { set: result(r), clear: result(clear), sse: s.status(), event: ev.event };
  } finally { s.close(); }
});
check('xylem', 'vts-throw', async () => result(await post('/api/vts/test-throw', { count: 1 })));
check('xylem', 'tts-voices', async () => ({ status: (await get('/api/draw/voices')).status }));

// M2: Xylem's own assistant commands under /api/v1/m/xylem/* (docs/contracts/xylem.md, Gate 3). Uses TOKEN from the v1 checks.
check('xylem', 'v1-commands', async () => {
  if (!TOKEN) await newToken();
  const info = (await get('/api/v1/info', { headers: auth() })).json || {};
  const mod = (info.modules || []).find((m) => m.id === 'xylem') || null;
  const out = {
    module: mod ? { name: mod.name, commands: [...mod.commands].sort() } : null,
    noToken: v1(await post('/api/v1/m/xylem/text', { text: 'x' })),
  };
  const st = await get('/api/v1/m/xylem/state', { headers: auth() });
  out.state = { ...v1(st), keys: Object.keys(st.json || {}).sort(), drawKeys: Object.keys(st.json?.draw || {}).sort() };
  const boxId = st.json?.textBoxes?.[0]?.id;
  const s = sse('/api/text/events');
  try {
    const tag = `assistant-${Date.now()}`;
    out.text = v1(await v1post('/api/v1/m/xylem/text', { text: tag }));
    out.textEvent = (await s.wait((e) => JSON.stringify(e.data).includes(tag))).event;
    out.textBox = v1(await v1post('/api/v1/m/xylem/text', { box: boxId, text: '', show: true }));
    out.textBadBox = v1(await v1post('/api/v1/m/xylem/text', { box: 'nope', text: 'x' }));
    out.textTooLong = v1(await v1post('/api/v1/m/xylem/text', { text: 'x'.repeat(201) }));
  } finally { s.close(); }
  out.draw = {
    open: v1(await v1post('/api/v1/m/xylem/draw', { action: 'open', sec: 0 })),
    close: v1(await v1post('/api/v1/m/xylem/draw', { action: 'close' })),
    closeAgain: v1(await v1post('/api/v1/m/xylem/draw', { action: 'close' })),
    drawEmpty: v1(await v1post('/api/v1/m/xylem/draw', { action: 'draw' })),
    cancel: v1(await v1post('/api/v1/m/xylem/draw', { action: 'cancel' })),
    bad: v1(await v1post('/api/v1/m/xylem/draw', { action: 'explode' })),
  };
  out.wheelUnknown = v1(await v1post('/api/v1/m/xylem/wheel', { id: 'nope' }));
  out.throw = v1(await v1post('/api/v1/m/xylem/vts-throw', {}));
  // excluded through Xylem too: donation-roulette test spins, settings, pack apply
  out.excluded = {};
  for (const p of ['/api/v1/m/xylem/roulette-test', '/api/v1/m/xylem/settings', '/api/v1/m/xylem/pack-apply']) out.excluded[p] = (await v1post(p, {})).status;
  return out;
});

// ---------- run ----------
function ensureDirsBefore() {
  if (process.platform !== 'win32') return [];
  return [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map((d) => path.join(d, 'Allmind')).filter((d) => !fs.existsSync(d));
}

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { if ((await get('/api/ping')).status === 200) return; } catch {}
    await sleep(250);
  }
  throw new Error('server on :8080 did not answer — is the mock running? (sh tools/dev/up.sh)');
}

function compare(name, want, got, path0 = '') {
  const diffs = [];
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    for (const k of Object.keys(want)) diffs.push(...compare(name, want[k], got?.[k], `${path0}.${k}`));
  } else if (Array.isArray(want) && /(Keys|keys|Fields|packModules)$/.test(path0)) { // lists of names: new ones are fine
    const missing = want.filter((k) => !(got || []).includes(k));
    if (missing.length) diffs.push(`${name}${path0}: missing ${missing.join(', ')}`);
  } else if (JSON.stringify(want) !== JSON.stringify(got)) {
    diffs.push(`${name}${path0}: was ${JSON.stringify(want)}, now ${JSON.stringify(got)}`);
  }
  return diffs;
}

const absentBefore = ensureDirsBefore();
let started = false;
if (!args.has('--running')) {
  const r = spawnSync('sh', ['tools/dev/up.sh'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('up.sh failed'); process.exit(2); }
  started = true;
}
let failed = 0;
const got = {};
try {
  await waitUp();
  await sleep(1500); // let OBS/chat/VTS connect on the mock
  for (const c of checks) {
    const key = `${c.group}/${c.name}`;
    try {
      got[key] = await c.fn();
      console.log(`  ok    ${key}`);
    } catch (e) {
      failed++;
      got[key] = { error: e.message };
      console.log(`  FAIL  ${key}: ${e.message}`);
    }
  }
} finally {
  if (started) spawnSync('sh', ['tools/dev/down.sh'], { cwd: ROOT, stdio: 'inherit' });
}

const leaked = absentBefore.filter((d) => fs.existsSync(d));
if (leaked.length) { failed++; console.log(`  FAIL  dev run wrote outside .dev/: ${leaked.join(', ')}`); }

if (args.has('--update-baseline')) {
  if (failed) { console.error(`\n${failed} check(s) failed — baseline NOT written`); process.exit(1); }
  fs.writeFileSync(BASELINE, JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), version: VERSION, checks: got }, null, 2) + '\n');
  console.log(`\nbaseline written: ${path.relative(ROOT, BASELINE)} (${Object.keys(got).length} checks)`);
  process.exit(0);
}
if (!fs.existsSync(BASELINE)) { console.error('\nno baseline yet — run with --update-baseline'); process.exit(1); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).checks;
const diffs = [];
for (const [k, want] of Object.entries(base)) {
  if (!(k in got)) { diffs.push(`${k}: check missing`); continue; }
  diffs.push(...compare(k, want, got[k]));
}
for (const d of diffs) console.log(`  DIFF  ${d}`);
const added = Object.keys(got).filter((k) => !(k in base));
if (added.length) console.log(`  new checks (not in baseline): ${added.join(', ')}`);
if (failed || diffs.length) { console.error(`\nsmoke: ${failed} failed, ${diffs.length} differ from the baseline`); process.exit(1); }
console.log(`\nsmoke: ${checks.length} checks match the baseline (mock only)`);
