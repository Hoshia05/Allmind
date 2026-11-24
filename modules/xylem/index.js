// Xylem — viewer interaction (공중전, 치즈 룰렛, 시청자 추첨, 텍스트, VTS 던지기) as an optional Allmind module
// (docs/plans/modules.md M2, docs/plans/m2-xylem.md). Reaches the platform only through ctx; every route and page keeps the path
// it had inside the platform, so the dashboard, the Xylem page, OBS browser sources and the hot-swappable pack keep working.
// Assistant commands: /api/v1/m/xylem/* (docs/contracts/xylem.md).
import crypto from 'node:crypto';
import path from 'node:path';
import { setHost } from './host.js';
import { XylemPack } from './pack.js';
import { Dogfight } from './dogfight.js';
import { Roulette } from './roulette.js';
import { ViewerDraw } from './draw.js';
import { TextBoxes } from './textbox.js';
import { VTSThrow } from './vtsthrow.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const OVERLAY_PAGES = ['/dogfight', '/roulette', '/roulette-board', '/text', '/draw'];
const TEXT_MAX = 200; // assistant overlay text

// pack files with "no-cache" + a content ETag (same behavior as the platform's static files)
function sendFile(req, res, body, name) {
  const tag = `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: tag });
  res.end(body);
}
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
// an /api/v1 error with a contract code (docs/contracts/auth.md); the platform answers { ok:false, code, error }
const v1Error = (status, code, message) => Object.assign(new Error(message), { status, code });

export function register(ctx) {
  setHost(ctx);
  const { chat, chatSender, tts, vts } = ctx.services;
  if (!chat || !tts || !vts) throw new Error('needs ctx.services.chat, tts and vts');

  // ---------- the parts (same construction as in the platform before M2) ----------
  const xylem = new XylemPack({ xylem: ctx.config }, ctx.version);
  const xylemPage = xylem.channel(); // open /xylem pages: told to reload on a pack switch
  const dogfight = new Dogfight(chat, xylem);
  const roulette = new Roulette(chat, xylem, chatSender);
  const draw = new ViewerDraw(chat, xylem, chatSender, tts); // 시청자 추첨 (/draw overlay)
  draw.on('tts-error', (msg) => ctx.toast({ text: `추첨 음성: ${msg}`, bad: true, long: true }));
  const textBoxes = new TextBoxes(xylem); // 텍스트: on-screen text boxes (/text?id=…)
  const vtsThrow = new VTSThrow(vts, chat);
  ctx.events.on('stream', (active) => { if (active) draw.streamStarted(); }); // "지난 당첨자 제외 (이번 방송)" counts from here
  // while a Xylem page is open, look for a newer pack every 3 min (one small GitHub request)
  setInterval(() => { if (xylemPage.size) xylem.check().catch(() => {}); }, 3 * 60000).unref();

  const xylemState = () => ({
    allmind: ctx.version,
    pack: xylem.status(),
    chat: chat.chatState,
    overlays: { dogfight: dogfight.overlays, roulette: roulette.ch.size, rouletteBoard: roulette.boardCh.size, text: textBoxes.ch.size, draw: draw.overlays },
    draw: draw.status(),
    text: textBoxes.status(),
    roulette: roulette.status(),
    board: dogfight.board(),
    dogfight: dogfight.status(),
    vts: { ...vts.status(), throw: vtsThrow.status() },
  });

  // ---------- the stream report's roulette part (moved out of src/report.js) ----------
  const todoOf = (rows) => rows.filter((x) => !x.done && !x.wheel).map((x) => ({ id: x.id, nick: x.nick, result: x.result }));
  ctx.reportSection('roulette', {
    build: ({ startedAt, endedAt }) => {
      const rows = roulette.log.filter((x) => x.time >= startedAt && x.time <= endedAt && !x.test);
      return { spins: rows.length, todo: todoOf(rows) };
    },
    // when a report is shown: which of its spins are still to do
    refresh: (saved) => {
      const rows = roulette.log.filter((x) => (saved?.todo || []).some((t) => t.id === x.id));
      return { ...saved, todo: rows.filter((x) => !x.done).map((x) => ({ id: x.id, nick: x.nick, result: x.result })) };
    },
  });

  // ---------- pages: the Xylem page and the OBS overlays, from the active pack ----------
  const page = (name) => (req, res) => {
    const body = xylem.file(name);
    if (!body) return sendJson(res, 404, { error: 'Not found' });
    sendFile(req, res, body, name);
  };
  ctx.route('GET', '/xylem', page('index.html'), { raw: true, pinPage: true });
  ctx.route('GET', '/xylem/index.html', page('index.html'), { raw: true, pinPage: true });
  ctx.route('GET', '/xylem/', page('index.html'), { raw: true, pinPage: true });
  ctx.route('GET', '/xylem/', (req, res, url) => {
    const name = url.pathname === '/xylem/' ? 'index.html' : decodeURIComponent(url.pathname.slice(7));
    if (name.includes('..')) return sendJson(res, 404, { error: 'Not found' });
    page(name)(req, res);
  }, { raw: true, prefix: true });
  for (const p of OVERLAY_PAGES) ctx.route('GET', p, page(`${p.slice(1)}.html`), { raw: true });

  // ---------- channels and acknowledgements the overlays use (no PIN: OBS browser sources) ----------
  ctx.sse('/api/xylem/state', (req, res) => sendJson(res, 200, { ok: true, ...xylemState() })); // polled by the Xylem page
  ctx.sse('/api/xylem/events', (req, res) => xylemPage.attach(req, res));
  ctx.sse('/api/roulette/events', (req, res) => roulette.attach(req, res), { pinFree: true });
  ctx.sse('/api/roulette/board-events', (req, res) => roulette.attachBoard(req, res), { pinFree: true });
  ctx.sse('/api/draw/events', (req, res) => draw.attach(req, res), { pinFree: true });
  ctx.sse('/api/text/events', (req, res, url) => textBoxes.attach(req, res, url.searchParams.get('preview') === '1'), { pinFree: true });
  ctx.sse('/api/dogfight/events', (req, res) => dogfight.attach(req, res), { pinFree: true });
  ctx.route('POST', '/api/draw/shown', async (req, res) => { draw.shown(String((await readBody(req)).id || '')); sendJson(res, 200, { ok: true }); }, { raw: true, pinFree: true });
  ctx.route('POST', '/api/roulette/shown', async (req, res) => { roulette.shown(String((await readBody(req)).id || '')); sendJson(res, 200, { ok: true }); }, { raw: true, pinFree: true });
  ctx.route('POST', '/api/dogfight/result', async (req, res) => sendJson(res, 200, { ok: true, ...dogfight.result(await readBody(req)) }), { raw: true, pinFree: true });
  ctx.route('POST', '/api/dogfight/cmd', async (req, res) => { dogfight.inject(await readBody(req)); sendJson(res, 200, { ok: true }); }, { raw: true });
  // the draw overlay's speech files (/api/draw/tts/<16 hex>.wav): random ids that only the overlay is told about
  ctx.route('GET', '/api/draw/tts/', (req, res, url) => {
    const m = /^\/api\/draw\/tts\/([0-9a-f]{16})\.wav$/.exec(url.pathname);
    const wav = m && tts.read(m[1]);
    if (!wav) return sendJson(res, 404, { ok: false });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
    res.end(wav);
  }, { raw: true, prefix: true, pinFree: true });
  ctx.route('GET', '/api/vts/item', (req, res, url) => {
    const buf = vtsThrow.itemFile(url.searchParams.get('file'));
    if (!buf) return sendJson(res, 404, { ok: false });
    const ext = path.extname(url.searchParams.get('file') || '').toLowerCase();
    res.writeHead(200, { 'Content-Type': ext === '.gif' ? 'image/gif' : ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache' });
    res.end(buf);
  }, { raw: true });

  // ---------- the Xylem page's and dashboard's actions (answered as { ok: true, ... }, errors → 400) ----------
  const routes = {
    'POST /api/xylem/check': async () => ({ pack: await xylem.check() }),
    'POST /api/xylem/apply': async () => ({ pack: await xylem.apply() }),
    'POST /api/xylem/use': (b) => ({ pack: xylem.use(b.version || null) }),
    'POST /api/text/set': (b) => ({ box: textBoxes.set(String(b.id || ''), b.patch || {}) }),
    'POST /api/text/forget': (b) => ({ box: textBoxes.forget(String(b.id || ''), String(b.text ?? '')) }),
    'POST /api/text/add': (b) => ({ box: textBoxes.add(b.copyFrom ? String(b.copyFrom) : null) }),
    'POST /api/text/remove': (b) => textBoxes.remove(String(b.id || '')),
    'POST /api/text/preset-save': (b) => textBoxes.savePreset(b.name, String(b.id || '')),
    'POST /api/text/preset-delete': (b) => textBoxes.deletePreset(b.name),
    // 시청자 추첨 (draw.js)
    'POST /api/draw/settings': (b) => ({ settings: draw.setSettings(b.settings) }),
    'POST /api/draw/open': (b) => { draw.open(b.sec); return {}; },
    'POST /api/draw/close': () => { draw.close(); return {}; },
    'POST /api/draw/extend': (b) => { draw.extend(b.sec); return {}; },
    'POST /api/draw/draw': () => { draw.draw(); return {}; },
    'POST /api/draw/skip': () => { draw.skip(); return {}; },
    'POST /api/draw/redraw': (b) => { draw.redraw(String(b.uid || '')); return {}; },
    'POST /api/draw/end': () => { draw.end(); return {}; },
    'POST /api/draw/reset': () => { draw.reset(); return {}; },
    'POST /api/draw/remove': (b) => { draw.remove(String(b.uid || '')); return {}; },
    'POST /api/draw/clear-past': () => { draw.clearPast(); return {}; },
    'POST /api/draw/test-run': (b) => { draw.runTest(b.n); return {}; },
    'POST /api/draw/test-fill': (b) => { draw.testFill(b.n); return {}; },
    'POST /api/draw/test-chat': (b) => { draw.testChat(b.text); return {}; },
    'POST /api/draw/tts-test': async (b) => ({ tts: await draw.ttsTest(b.text) }),
    'GET /api/draw/voices': async () => ({ voices: await tts.voices(), real: tts.real }),
    'POST /api/roulette/settings': (b) => ({ settings: roulette.setSettings(b.settings) }),
    'POST /api/roulette/test': (b) => ({ spins: roulette.test(b.spins, b.rid ? String(b.rid) : null) }),
    'POST /api/roulette/board-show': () => { roulette.showBoard(); return { boards: roulette.boardCh.size }; },
    'POST /api/roulette/done': (b) => roulette.setDone(String(b.id), b.done),
    'POST /api/roulette/skip': () => roulette.skipAll(),
    'POST /api/roulette/clear-log': () => roulette.clearLog(),
    'POST /api/roulette/wheel-spin': (b) => ({ spins: roulette.spinWheel(String(b.id || ''), b.spins) }),
    'POST /api/dogfight/reset': () => dogfight.reset(),
    'POST /api/dogfight/mode': (b) => ({ mode: dogfight.setMode(b) }),
    // VTS 던지기 (the VTS connection itself stays in the platform)
    'POST /api/vts/throw-settings': (b) => ({ settings: vtsThrow.setSettings(b.settings) }),
    'POST /api/vts/test-throw': (b) => {
      const n = Math.max(1, Math.min(10, Number(b.count) || 1));
      let r;
      for (let i = 0; i < n; i++) r = vtsThrow.request({ source: 'test', force: true, side: Number(b.side) || undefined });
      if (!r.ok) throw new Error(r.reason);
      return {};
    },
    'POST /api/vts/items': (b) => vtsThrow.addItem(b.name, b.data),
    'POST /api/vts/items-remove': (b) => vtsThrow.removeItem(b.file),
    'POST /api/vts/aim-start': () => vtsThrow.startAim(),
    'POST /api/vts/aim-stop': () => vtsThrow.stopAim(),
  };
  for (const [key, fn] of Object.entries(routes)) {
    const [method, p] = key.split(' ');
    ctx.route(method, p, fn);
  }

  // ---------- assistant commands: /api/v1/m/xylem/* (docs/contracts/xylem.md; token + logging by the platform) ----------
  // Only on-stream fun the streamer asked for; never settings, logs, donation-roulette test spins or a pack switch.
  const conflict = (fn) => { try { return fn(); } catch (e) { throw v1Error(409, 'conflict', e.message); } };
  ctx.route('GET', '/api/v1/m/xylem/state', () => ({
    draw: { phase: draw.phase, count: draw.status().count },
    wheels: roulette.s.wheels.map((w) => ({ id: w.id, title: w.title })),
    textBoxes: textBoxes.boxes.map((b) => ({ id: b.id, name: b.name, visible: b.visible })),
    vts: { ready: !!vts.ready },
  }));
  ctx.route('POST', '/api/v1/m/xylem/text', (b) => {
    if (typeof b.text !== 'string') throw v1Error(400, 'bad-request', 'text가 없어요');
    if (b.text.length > TEXT_MAX) throw v1Error(400, 'bad-request', `text는 ${TEXT_MAX}자까지예요`);
    const box = b.box === undefined || b.box === null ? textBoxes.boxes[0] : textBoxes.boxes.find((x) => x.id === String(b.box));
    if (!box) throw v1Error(400, 'bad-request', '그 텍스트 칸이 없어요');
    textBoxes.set(box.id, { text: b.text, visible: b.show !== false });
    return { box: box.id };
  });
  ctx.route('POST', '/api/v1/m/xylem/draw', (b) => {
    switch (b.action) {
      case 'open': conflict(() => draw.open(b.sec, { quiet: true })); break; // never a chat notice as the streamer
      case 'close': conflict(() => draw.close()); break;
      case 'draw': conflict(() => draw.draw({ quiet: true })); break;
      case 'end': conflict(() => draw.end()); break;
      case 'cancel': draw.reset(); break;
      default: throw v1Error(400, 'bad-request', 'action은 open, close, draw, end, cancel 중 하나예요');
    }
    return { phase: draw.phase };
  });
  ctx.route('POST', '/api/v1/m/xylem/wheel', (b) => {
    const id = String(b.id || '');
    if (!roulette.s.wheels.some((w) => w.id === id)) throw v1Error(400, 'bad-request', '그 무료 룰렛이 없어요');
    const rows = roulette.spinWheel(id, 1);
    return { results: rows.map((r) => r.result) };
  });
  ctx.route('POST', '/api/v1/m/xylem/vts-throw', () => {
    // the owner's on/off switch for throws applies to the assistant too (the panel's test button ignores it on purpose)
    if (!vtsThrow.s.enabled) throw v1Error(409, 'conflict', 'VTS 던지기가 꺼져 있어요 (Xylem → VTube Studio)');
    const r = vtsThrow.request({ source: 'assistant', force: true });
    if (!r.ok) throw v1Error(409, 'conflict', r.reason);
    return {};
  });

  ctx.log('ready');
}
