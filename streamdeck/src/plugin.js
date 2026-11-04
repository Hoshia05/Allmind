// Allmind Stream Deck plugin: BGM + soundboard + 할 일 keys that show what's playing / what's next.
//
// Stream Deck starts this file with Node (bundled to bin/plugin.js by tools/build-streamdeck.mjs) and
// these arguments: -port <n> -pluginUUID <id> -registerEvent <name> -info <json>. We speak the plain
// Stream Deck WebSocket protocol (no SDK — fewer moving parts) and talk to Allmind over HTTP:
//   GET  /deck/events          live state + track/sound lists (SSE; one connection per plugin)
//   GET  /deck/<action>?…      run an action (the same URLs the old "Website" keys use)
// Allmind can be on this PC (127.0.0.1:8080) or on the stream PC (its LAN address) — set once in
// any key's settings ("연결"), shared by every key on this PC.
'use strict';
const http = require('node:http');
const WebSocket = require('ws');

const arg = (n) => { const i = process.argv.indexOf(`-${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PORT = arg('port');
const UUID = arg('pluginUUID');
const REGISTER = arg('registerEvent');
const ACT_BGM = 'com.hoshia.allmind.bgm';
const ACT_SB = 'com.hoshia.allmind.sb';
const ACT_TODO = 'com.hoshia.allmind.todo';
const NEED = '0.31.0';
const NEED_LOOP_TODO = '0.42.0'; // bgm-loop, todo-next/undo (older Allmind answers "없는 동작")

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- Stream Deck socket ----------
const sd = new WebSocket(`ws://127.0.0.1:${PORT}`);
const send = (event, context, payload) => { if (sd.readyState === 1) sd.send(JSON.stringify({ event, context, payload })); };

const keys = new Map(); // context → { action, settings, last }
let global = { host: '', key: '' };
let gotGlobal = false;

sd.on('open', () => {
  sd.send(JSON.stringify({ event: REGISTER, uuid: UUID }));
  send('getGlobalSettings', UUID);
});
sd.on('close', () => process.exit(0));
sd.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  const { event, context, action, payload = {} } = m;
  switch (event) {
    case 'didReceiveGlobalSettings':
      global = { host: '', key: '', ...(payload.settings || {}) };
      gotGlobal = true;
      reconnect();
      break;
    case 'willAppear':
      keys.set(context, { action, settings: payload.settings || {}, last: {} });
      render(context);
      if (gotGlobal) ensure();
      break;
    case 'willDisappear':
      keys.delete(context);
      if (!keys.size) disconnect(); // nothing on screen → no connection to Allmind
      break;
    case 'didReceiveSettings':
      if (keys.has(context)) { keys.get(context).settings = payload.settings || {}; keys.get(context).last = {}; render(context); }
      break;
    case 'keyDown':
      if (keys.has(context)) keys.get(context).settings = payload.settings || keys.get(context).settings;
      press(context).catch((e) => log('press', e.message));
      break;
    case 'propertyInspectorDidAppear':
      toPI(context);
      break;
    case 'sendToPlugin':
      fromPI(context, payload);
      break;
  }
});

// ---------- Allmind connection ----------
const am = { up: false, version: '', error: '연결하는 중…', state: null, lists: { tracks: [], sounds: [] } };
let req = null;
let retry = null;
let watchdog = null;

function base() {
  let h = String(global.host || '').trim() || '127.0.0.1:8080';
  h = h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/:\d+$/.test(h) && !/^\[.*\]$/.test(h)) h += ':8080';
  return `http://${h}`;
}
const keyQ = () => (global.key ? `key=${encodeURIComponent(global.key)}` : '');

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function setDown(error) {
  const changed = am.up || am.error !== error;
  am.up = false;
  am.error = error;
  if (changed) { renderAll(); for (const c of keys.keys()) toPI(c); }
}

function disconnect() {
  clearTimeout(retry); retry = null;
  clearTimeout(watchdog);
  if (req) { const r = req; req = null; r.destroy(); }
}
function reconnect() { disconnect(); ensure(); }
function later(ms = 3000) { clearTimeout(retry); retry = setTimeout(() => { retry = null; ensure(); }, ms); }

function ensure() {
  if (req || retry || !keys.size) return;
  const url = `${base()}/deck/events${keyQ() ? `?${keyQ()}` : ''}`;
  let buf = '';
  let ev = 'message', data = '';
  const r = http.get(url, { headers: { Accept: 'text/event-stream' }, timeout: 8000 }, (res) => {
    if (res.statusCode === 403) { res.resume(); req = null; setDown('비밀 키가 맞지 않아요'); return later(10000); }
    if (res.statusCode === 404) { res.resume(); req = null; setDown(`Allmind ${NEED} 이상이 필요해요`); return later(30000); }
    if (res.statusCode !== 200) { res.resume(); req = null; setDown(`Allmind 응답 오류 (${res.statusCode})`); return later(); }
    r.setTimeout(0);
    res.setEncoding('utf8');
    const bark = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { log('no data for 40 s, reconnecting'); reconnect(); }, 40000); };
    bark();
    res.on('data', (chunk) => {
      bark();
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line === '') { if (data) onEvent(ev, data); ev = 'message'; data = ''; }
        else if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
      }
    });
    const gone = () => { clearTimeout(watchdog); if (req === r) { req = null; setDown('Allmind와 연결이 끊겼어요'); later(); } };
    res.on('error', gone); // reset mid-stream (Allmind closed)
    res.on('close', gone);
  });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', (e) => {
    if (req !== r) return;
    req = null;
    setDown(e.code === 'ECONNREFUSED' ? 'Allmind가 꺼져 있어요' : e.message === 'timeout' || e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' ? `${base().slice(7)}에 닿지 않아요` : `연결 실패 (${e.code || e.message})`);
    later();
  });
  req = r;
}

function onEvent(ev, data) {
  let d;
  try { d = JSON.parse(data); } catch { return; }
  if (ev === 'hello') {
    am.version = d.version || '';
    if (d.app !== 'allmind') return setDown('Allmind가 아닌 프로그램이에요');
    am.up = true; am.error = '';
    log('connected to Allmind', am.version, base());
    for (const c of keys.keys()) toPI(c);
  } else if (ev === 'state') {
    am.state = d;
    renderAll();
  } else if (ev === 'lists') {
    am.lists = { tracks: d.tracks || [], sounds: d.sounds || [] };
    renderAll();
    for (const c of keys.keys()) toPI(c);
  }
}

function call(action, params = {}) {
  const q = new URLSearchParams(params);
  if (global.key) q.set('key', global.key);
  const url = `${base()}/deck/${action}${q.toString() ? `?${q}` : ''}`;
  return new Promise((resolve) => {
    const r = http.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); } });
    });
    r.on('timeout', () => r.destroy(new Error('시간 초과')));
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

// ---------- what a key does ----------
const OPS = {
  [ACT_BGM]: { toggle: 'bgm-toggle', track: 'bgm-select', next: 'bgm-next', prev: 'bgm-prev', 'vol-up': 'bgm-vol-up', 'vol-down': 'bgm-vol-down', loop: 'bgm-loop' },
  [ACT_SB]: { play: 'sb-play', stop: 'sb-stop', 'vol-up': 'sb-vol-up', 'vol-down': 'sb-vol-down' },
  [ACT_TODO]: { next: 'todo-next', undo: 'todo-undo' },
};
const defaultOp = (action) => (action === ACT_BGM ? 'toggle' : action === ACT_TODO ? 'next' : 'play');
const tooOld = () => am.version && cmpVersion(am.version, NEED_LOOP_TODO) < 0;

async function press(context) {
  const k = keys.get(context);
  if (!k) return;
  if (!am.up) { send('showAlert', context); ensure(); return; }
  const op = k.settings.op || defaultOp(k.action);
  const name = OPS[k.action]?.[op];
  if (!name) return send('showAlert', context);
  const params = {};
  if (name === 'bgm-select') { if (!k.settings.track) return send('showAlert', context); params.id = k.settings.track; }
  if (name === 'sb-play') { if (!k.settings.sound) return send('showAlert', context); params.name = k.settings.sound; }
  if (/vol-/.test(name) && Number(k.settings.step) > 0) params.step = String(Number(k.settings.step));
  const r = await call(name, params);
  if (!r.ok) { log(name, 'failed:', r.error); send('showAlert', context); return; }
  if (name === 'todo-next' || name === 'todo-undo') send('showOk', context);
}

// ---------- drawing ----------
const C = { bg: '#101a1d', dim: '#2a3539', teal: '#2fd8c8', on: '#21b35b', amber: '#ffb020', red: '#ff5a5a', fg: '#e8f1f2', mute: '#7d8b8f' };
const svg = (bg, body) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="0" fill="${bg}"/>${body}</svg>`)}`;
const G = {
  play: (c) => `<path d="M56 30 L98 56 L56 82 Z" fill="${c}"/>`,
  pause: (c) => `<rect x="52" y="30" width="14" height="52" rx="3" fill="${c}"/><rect x="78" y="30" width="14" height="52" rx="3" fill="${c}"/>`,
  next: (c) => `<path d="M44 32 L80 56 L44 80 Z" fill="${c}"/><rect x="84" y="32" width="12" height="48" rx="2" fill="${c}"/>`,
  prev: (c) => `<path d="M100 32 L64 56 L100 80 Z" fill="${c}"/><rect x="48" y="32" width="12" height="48" rx="2" fill="${c}"/>`,
  stop: (c) => `<rect x="48" y="32" width="48" height="48" rx="5" fill="${c}"/>`,
  note: (c) => `<path d="M64 26 L100 18 L100 70" stroke="${c}" stroke-width="8" fill="none" stroke-linejoin="round"/><circle cx="56" cy="80" r="12" fill="${c}"/><circle cx="92" cy="72" r="12" fill="${c}"/><path d="M64 26 L64 80" stroke="${c}" stroke-width="8"/>`,
  bell: (c) => `<path d="M72 22 C52 22 46 40 46 56 L46 70 L38 80 L106 80 L98 70 L98 56 C98 40 92 22 72 22 Z" fill="${c}"/><circle cx="72" cy="88" r="7" fill="${c}"/>`,
  vol: (c, up) => `<path d="M34 46 L50 46 L70 30 L70 82 L50 66 L34 66 Z" fill="${c}"/>${up ? `<path d="M86 56 h26 M99 43 v26" stroke="${c}" stroke-width="8" stroke-linecap="round"/>` : `<path d="M86 56 h26" stroke="${c}" stroke-width="8" stroke-linecap="round"/>`}`,
  off: (c) => `<path d="M40 40 L104 104 M104 40 L40 104" stroke="${c}" stroke-width="8" stroke-linecap="round" opacity=".7"/>`,
  // 🔁 two arrows chasing each other
  loop: (c) => `<path d="M40 62 V54 Q40 40 54 40 H92" stroke="${c}" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M88 28 L104 40 L88 52 Z" fill="${c}"/><path d="M104 50 V58 Q104 72 90 72 H52" stroke="${c}" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M56 60 L40 72 L56 84 Z" fill="${c}"/>`,
  // a progress ring under the loop while the loop files are being made (p 0–100)
  ring: (c, p) => { const r = 44, L = 2 * Math.PI * r; return `<circle cx="72" cy="56" r="${r}" stroke="${C.dim}" stroke-width="5" fill="none"/><circle cx="72" cy="56" r="${r}" stroke="${c}" stroke-width="5" fill="none" stroke-dasharray="${(L * p) / 100} ${L}" transform="rotate(-90 72 56)"/>`; },
  check: (c, done) => `<rect x="38" y="22" width="68" height="68" rx="12" stroke="${c}" stroke-width="7" fill="none"/>${done ? `<path d="M52 56 L66 70 L92 40" stroke="${c}" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : ''}`,
  undo: (c) => `<path d="M50 44 H86 Q104 44 104 62 Q104 80 86 80 H58" stroke="${c}" stroke-width="8" fill="none" stroke-linecap="round"/><path d="M58 28 L38 44 L58 60 Z" fill="${c}"/>`,
  // small count in the top-right corner
  badge: (n, bg, fg) => `<circle cx="116" cy="26" r="20" fill="${bg}"/><text x="116" y="34" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700" fill="${fg}">${n}</text>`,
};

// Stream Deck doesn't wrap titles: split into short lines ourselves, at spaces where possible.
// Width in "latin letters" at the default title size; Hangul/CJK count as ~1.7.
const W = (ch) => (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? 1.7 : /[A-Z@#%&mwMW]/.test(ch) ? 1.3 : 1);
const width = (s) => [...s].reduce((a, ch) => a + W(ch), 0);
function wrap(s, lines = 2, max = 10) {
  const words = String(s || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  const push = () => { if (cur) out.push(cur); cur = ''; };
  for (let w of words) {
    if (!cur && width(w) <= max) { cur = w; continue; }
    if (cur && width(cur + ' ' + w) <= max) { cur += ' ' + w; continue; }
    push();
    while (width(w) > max) { // one long word: cut it
      let cut = '';
      for (const ch of w) { if (width(cut + ch) > max) break; cut += ch; }
      out.push(cut); w = w.slice(cut.length);
    }
    cur = w;
  }
  push();
  if (out.length > lines) { out.length = lines; let last = out[lines - 1]; while (last && width(last + '…') > max) last = [...last].slice(0, -1).join(''); out[lines - 1] = last + '…'; }
  return out.join('\n');
}
const db = (v) => (Number.isFinite(v) ? `${Math.round(v)} dB` : '');

function view(k) {
  const op = k.settings.op || defaultOp(k.action);
  if (!am.up) return { image: svg(C.bg, (k.action === ACT_BGM ? G.note : k.action === ACT_TODO ? (c) => G.check(c, false) : G.bell)(C.dim) + G.off(C.red)), title: '연결\n안 됨' };
  const st = am.state || { bgm: {}, sb: {} };
  if ((k.action === ACT_TODO || op === 'loop') && tooOld()) return { image: svg(C.bg, (k.action === ACT_TODO ? (c) => G.check(c, false) : G.loop)(C.dim)), title: 'Allmind\n업데이트 필요' };
  if (k.action === ACT_TODO) {
    const t = st.todo || { total: 0, left: 0, next: '' };
    if (op === 'undo') return { image: svg(C.bg, G.undo(t.total > t.left ? C.teal : C.mute)), title: '체크\n되돌리기' };
    if (!t.total) return { image: svg(C.bg, G.check(C.dim, false)), title: '오늘 할 것\n없음' };
    if (!t.left) return { image: svg('#0f2a1b', G.check(C.on, true)), title: '다 했어요!' };
    return { image: svg(C.bg, G.check(C.teal, false) + G.badge(t.left, C.teal, '#031a18')), title: wrap(t.next) };
  }
  if (k.action === ACT_BGM) {
    const b = st.bgm || {};
    if (!b.ok && op !== 'vol-up' && op !== 'vol-down') return { image: svg(C.bg, G.note(C.dim)), title: 'BGM 소스\n없음' };
    switch (op) {
      case 'toggle': return { image: svg(b.playing ? '#0f2a1b' : C.bg, (b.playing ? G.pause : G.play)(b.playing ? C.on : C.teal)), title: wrap(b.title || 'BGM') };
      case 'track': {
        const t = am.lists.tracks.find((x) => x.id === k.settings.track);
        if (!t) return { image: svg(C.bg, G.note(C.dim)), title: k.settings.track ? '곡이\n없어요' : '곡 선택\n필요' };
        const cur = b.currentId === t.id;
        const live = cur && b.playing;
        return { image: svg(live ? '#0f2a1b' : C.bg, G.note(live ? C.on : cur ? C.teal : C.mute)), title: wrap(t.title) };
      }
      case 'next': return { image: svg(C.bg, G.next(C.teal)), title: '다음 곡' };
      case 'prev': return { image: svg(C.bg, G.prev(C.teal)), title: '이전 곡' };
      case 'vol-up': case 'vol-down': return { image: svg(C.bg, G.vol(C.teal, op === 'vol-up')), title: `BGM\n${db(b.volumeDb)}` };
      case 'loop': {
        const l = b.loop || { set: false };
        if (!b.currentId) return { image: svg(C.bg, G.loop(C.dim)), title: '곡을\n고르세요' };
        if (!l.set) return { image: svg(C.bg, G.loop(C.dim)), title: '반복 설정\n필요' };
        if (l.state === 'error') return { image: svg(C.bg, G.loop(C.red)), title: '반복\n실패' };
        if (l.enabled && !l.ready) return { image: svg(C.bg, G.loop(C.amber) + G.ring(C.amber, l.progress || 0)), title: l.state === 'building' ? `만드는 중\n${l.progress || 0}%` : '준비 중' };
        if (l.enabled) return { image: svg('#0f2a1b', G.loop(C.on)), title: '무한 반복\n켜짐' };
        return { image: svg(C.bg, G.loop(C.mute)), title: '무한 반복\n꺼짐' };
      }
    }
  } else {
    const s = st.sb || {};
    if (!s.ok && op === 'play') return { image: svg(C.bg, G.bell(C.dim)), title: '사운드보드\n소스 없음' };
    switch (op) {
      case 'play': {
        const snd = am.lists.sounds.find((x) => x.id === k.settings.sound);
        if (!snd) return { image: svg(C.bg, G.bell(C.dim)), title: k.settings.sound ? '사운드가\n없어요' : '사운드\n선택 필요' };
        const live = s.playing === snd.id;
        return { image: svg(live ? '#33240a' : C.bg, (live ? G.stop : G.bell)(live ? C.amber : C.teal)), title: wrap(snd.title) };
      }
      case 'stop': return { image: svg(s.playing ? '#33240a' : C.bg, G.stop(s.playing ? C.amber : C.mute)), title: '정지' };
      case 'vol-up': case 'vol-down': return { image: svg(C.bg, G.vol(C.amber, op === 'vol-up')), title: `효과음\n${db(s.volumeDb)}` };
    }
  }
  return { image: svg(C.bg, G.off(C.dim)), title: '' };
}

function render(context) {
  const k = keys.get(context);
  if (!k) return;
  const v = view(k);
  if (v.image !== k.last.image) { send('setImage', context, { image: v.image, target: 0 }); k.last.image = v.image; }
  if (v.title !== k.last.title) { send('setTitle', context, { title: v.title, target: 0 }); k.last.title = v.title; }
}
function renderAll() { for (const c of keys.keys()) render(c); }

// ---------- property inspector ----------
function toPI(context) {
  const k = keys.get(context);
  if (!k) return;
  send('sendToPropertyInspector', context, {
    type: 'info',
    up: am.up, error: am.error, version: am.version, need: NEED,
    old: am.up && am.version && cmpVersion(am.version, NEED) < 0,
    host: global.host || '', key: global.key || '', base: base(),
    tracks: k.action === ACT_BGM ? am.lists.tracks : undefined,
    sounds: k.action === ACT_SB ? am.lists.sounds : undefined,
  });
}
function fromPI(context, p) {
  if (p.type === 'global') {
    global = { host: String(p.host || '').trim(), key: String(p.key || '').trim() };
    send('setGlobalSettings', UUID, global);
    am.error = '연결하는 중…';
    reconnect();
    for (const c of keys.keys()) toPI(c);
  } else if (p.type === 'hello') {
    toPI(context);
  }
}

process.on('uncaughtException', (e) => log('uncaught', e && e.stack));
