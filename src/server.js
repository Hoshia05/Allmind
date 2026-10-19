// Stream Desk — runs on the stream PC next to OBS.
// Serves the dashboard (open it from the main PC) and a small launcher /
// settings window that only works on the stream PC itself.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, readAsset, configPath, ROOT, DATA_DIR, CONFIG_DIR, IS_EXE } from './config.js';
import { OBSClient } from './obs.js';
import { BGM } from './bgm.js';
import { DonationViewer, Interact, ProgramViewer, QUALITY } from './donation.js';
import { Chzzk, parseChannelId } from './chzzk.js';
import { FrameFeed } from './feed.js';
import { ChzzkRemote } from './remote.js';
import { Studio } from './studio.js';
import { Markers } from './markers.js';
import { Soundboard } from './soundboard.js';
import * as win from './win.js';

const VERSION = '0.16.3';
// Flags only (in the exe, argv[1] can be the exe path itself).
const args = new Set(process.argv.slice(1).filter((a) => a.startsWith('--')));
const config = loadConfig();
const PORT = config.server.port;

// ---------- logging (the exe has no console window) ----------
if (IS_EXE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFile = path.join(DATA_DIR, 'stream-desk.log');
  try { if (fs.statSync(logFile).size > 1 << 20) fs.renameSync(logFile, logFile + '.old'); } catch {}
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...a) => out.write(`${new Date().toISOString()} ${level.toUpperCase()} ${a.join(' ')}\n`);
  }
  process.on('uncaughtException', (e) => console.error('uncaught', e.stack || e));
  process.on('unhandledRejection', (e) => console.error('unhandled', e?.stack || e));
}

function lanAddresses() {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  // Home networks first (192.168.x / 10.x / 172.16-31.x), virtual adapters last.
  const score = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return ips.sort((a, b) => score(a) - score(b)).map((ip) => `http://${ip}:${PORT}`);
}
const launcherUrl = () => `http://127.0.0.1:${PORT}/launcher`;
const openLauncher = () => win.openAppWindow(launcherUrl(), { width: 500, height: 820 });
const openDashboardHere = () => win.openAppWindow(`http://127.0.0.1:${PORT}/`, { width: 1500, height: 900 });

// ---------- single instance ----------
async function otherInstanceRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'stream-desk';
  } catch {
    return false;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(PORT, config.server.host);
  });
}

// ---------- HTTP plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// ---------- main ----------
async function main() {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  // Bind first, so a second double-click just brings up the window.
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (args.has('--restart') && attempt < 20) { await new Promise((r) => setTimeout(r, 250)); continue; }
      if (await otherInstanceRunning()) {
        openLauncher();
        setTimeout(() => process.exit(0), 500);
        return;
      }
      await win.alertBox(`포트 ${PORT}을(를) 다른 프로그램이 쓰고 있어서 Stream Desk를 시작할 수 없어요.\n설정 파일의 server.port 값을 바꿔 주세요:\n${configPath()}`);
      process.exit(1);
    }
  }

  const obs = new OBSClient(config.obs);
  const bgm = new BGM(obs, config);
  const viewer = new DonationViewer(obs, config);
  const interact = new Interact(config);
  const chatViewer = new DonationViewer(obs, config, 'chat');
  // The 위플챗 panel can show the overlay page itself (filling the panel, and
  // no OBS screenshots at all) — if the site allows being shown inside
  // another page. Checked once per URL from here, the stream PC.
  const chatPage = { url: '', frameable: null };
  chatViewer.onUrl = async (url) => {
    if (url === chatPage.url) return;
    chatPage.url = url;
    chatPage.frameable = null;
    if (!/^https?:\/\//i.test(url)) { chatPage.frameable = false; stateChanged(); return; }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
      const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
      const fa = /frame-ancestors\s+([^;]+)/i.exec(r.headers.get('content-security-policy') || '')?.[1]?.trim();
      chatPage.frameable = !(xfo.includes('deny') || xfo.includes('sameorigin') || (fa && !fa.includes('*')));
      r.body?.cancel().catch(() => {});
      console.log(`[chat] overlay page ${chatPage.frameable ? 'can' : 'cannot'} be shown directly`);
    } catch (e) {
      chatPage.frameable = null; // unknown: the page will just try
    }
    stateChanged();
  };
  const alertViewer = new DonationViewer(obs, config, 'alert');
  const remote = new ChzzkRemote(config);
  // The program preview is a full-scene capture that changes every frame (game
  // footage), so it gets its own light, fixed settings instead of the 영도 quality.
  const program = new ProgramViewer(obs);
  const studio = new Studio(obs, { mic: config.sources.mic });
  const markers = new Markers(obs, { fallbackDir: path.join(DATA_DIR, 'markers') });
  const soundboard = new Soundboard(obs, config);
  const chzzk = new Chzzk(config);
  viewer.onUrl = (url) => interact.setSourceUrl(url);
  // "a 영도 is playing": its audio was loud in the last 20 s, or the 리모컨 says so
  let lastDonationSound = 0;
  setInterval(() => { if (bgm.levelDb() > -50) lastDonationSound = Date.now(); }, 250);
  interact.isVideoActive = () => Date.now() - lastDonationSound < 20000 || !!remote?.status().videoPlaying;
  // For the dashboard's auto tab switch: is a 영도 playing *right now*?
  // (the 리모컨's ■ button is the clearest signal; sound covers the rest,
  //  with a few seconds of grace so a quiet moment doesn't flip it back)
  let donationActive = false;
  let donationActiveSince = 0;
  bgm.holdWhile = () => !!remote.status().videoPlaying; // keep BGM paused while the 리모컨 shows a 영도
  const isDonationActive = () => !!remote.status().videoPlaying || Date.now() - lastDonationSound < 4000;
  const feeds = {
    donation: new FrameFeed({
      name: 'donation',
      grab: () => viewer.grab(),
      fps: (QUALITY[viewer.quality] || {}).fps || config.viewer.fps,
      idleFps: 1,
      parallel: (QUALITY[viewer.quality] || {}).parallel || config.viewer.parallel,
    }),
    chat: new FrameFeed({ name: 'chat', grab: () => chatViewer.grab(), fps: config.viewer.chatFps, idleFps: 1, parallel: 1 }),
    // 도네 alerts animate, so give them a smoother rate than the chat overlay.
    alert: new FrameFeed({ name: 'alert', grab: () => alertViewer.grab(), fps: 20, idleFps: 1, parallel: 2 }),
    // what's on stream; capped at 30 since a full-scene capture is the heaviest one
    program: new FrameFeed({ name: 'program', grab: () => program.grab(), fps: QUALITY[program.quality].fps, idleFps: 2, parallel: QUALITY[program.quality].parallel }),
  };

  // Frame-at-a-time viewers keep a feed running for a few seconds after
  // their last request (the stream viewers do that just by staying connected).
  const holds = {};
  function pollHold(which) {
    let h = holds[which];
    if (!h) {
      h = holds[which] = { seq: 0, frame: null, waiters: new Set(), unsub: null, timer: null };
    }
    if (!h.unsub) {
      h.unsub = feeds[which].subscribe((f) => {
        h.frame = f;
        h.seq++;
        for (const w of [...h.waiters]) w();
      });
    }
    clearTimeout(h.timer);
    h.timer = setTimeout(() => { h.unsub?.(); h.unsub = null; h.frame = null; }, 4000);
    return h;
  }

  // ---------- live state to the pages (Server-Sent Events) ----------
  const clients = new Set();
  // The setlist can be hundreds of songs, so it isn't part of every state
  // update: it goes out as its own event, only when it actually changes.
  let tracksJson = '[]';
  const bgmState = () => {
    const { tracks, ...rest } = bgm.snapshot();
    const j = JSON.stringify(tracks);
    if (j !== tracksJson) {
      tracksJson = j;
      for (const res of clients) res.write(`event: tracks\ndata: ${j}\n\n`);
    }
    return rest;
  };
  const snapshot = () => ({
    obs: obs.status(),
    bgm: bgmState(),
    studio: studio.status(),
    marks: markers.status(),
    soundboard: soundboard.status(),
    donation: viewer.status(),
    interact: interact.status(),
    chatSource: { ...chatViewer.status(), pageUrl: chatPage.url, frameable: chatPage.frameable },
    alertSource: alertViewer.status(),
    remote: remote.status(),
    chzzk: chzzk.status(),
    links: links(),
    program: program.status(),
    donationActive,
  });
  // Top-right links: built from the connected channel. (Old configs carry
  // generic placeholder links to the Chzzk front page; those are dropped.)
  const PLACEHOLDER = new Set(['https://studio.chzzk.naver.com/', 'https://chzzk.naver.com/']);
  function links() {
    const id = chzzk.channelId;
    const own = id ? [
      { name: '치지직 스튜디오', url: `https://studio.chzzk.naver.com/${id}` },
      { name: '채팅 팝업', url: `https://chzzk.naver.com/live/${id}/chat`, popup: true },
      { name: '내 방송', url: `https://chzzk.naver.com/live/${id}` },
    ] : [];
    return [...own, ...(config.links || []).filter((l) => !PLACEHOLDER.has(l.url))];
  }
  const sendAll = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  let stateTimer = null;
  const stateChanged = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; sendAll('state', snapshot()); }, 50);
  };
  obs.on('status', stateChanged);
  obs.on('connected', () => setTimeout(stateChanged, 300));
  bgm.on('change', stateChanged);
  bgm.on('pos', (p) => clients.size && sendAll('bgmpos', p));
  bgm.watching = () => clients.size > 0;
  interact.on('change', stateChanged);
  chzzk.on('change', stateChanged);
  remote.on('change', stateChanged);
  studio.on('change', stateChanged);
  markers.on('change', stateChanged);
  soundboard.on('change', stateChanged);
  markers.on('saved', ({ count, file }) => sendAll('toast', { text: `⭐ 마크 ${count}개 저장됨${file ? ` — 영상과 함께 ${file} 도 올려 주세요` : ''}`, long: true }));
  studio.on('health', (h) => clients.size && sendAll('health', h));
  studio.wanted = () => clients.size > 0 || Object.values(feeds).some((f) => f.running);
  chzzk.on('chat', (list) => sendAll('chat', list));
  chzzk.on('chat-update', (m) => sendAll('chat-update', m));
  chzzk.on('chat-reset', () => sendAll('chat-history', []));
  chzzk.on('donations', (list) => sendAll('donations', list));
  chzzk.on('donation-read', (d) => sendAll('donation-read', d));
  chzzk.on('donations-reset', () => sendAll('donations-history', chzzk.donationList()));
  interact.on('skipped', (sel) => sendAll('toast', { text: '광고 스킵 완료', detail: sel }));
  setInterval(() => clients.size && sendAll('level', { db: bgm.levelDb(), active: bgm.autoActive, mic: studio.micDb() }), 100);
  setInterval(() => clients.size && sendAll('ping', Date.now()), 15000);
  setInterval(() => {
    let now = isDonationActive();
    // Same rule as the BGM auto-pause: a 영도 starts with a short alert, then a
    // few silent seconds before the video. Stay on the 영도 tab through that
    // gap (첫 알림 후 유지), instead of flicking back to 방송 화면 and again.
    if (!now && donationActive && Date.now() - donationActiveSince < (bgm.autoPause?.introHoldMs ?? 10000)) now = true;
    if (now !== donationActive) {
      donationActive = now;
      if (now) donationActiveSince = Date.now();
      console.log(`[app] 영도 ${now ? 'started' : 'ended'}`);
      stateChanged();
    }
  }, 250);
  viewer.onQuality = (p) => feeds.donation.setTarget(p.fps, p.parallel);
  program.onQuality = (p) => { feeds.program.setTarget(p.fps, p.parallel); stateChanged(); };

  // OBS-load guard: every mirror frame is rendered by OBS on the same GPU that
  // makes the stream. If OBS keeps skipping frames while mirrors run, lower
  // their frame rate; raise it again quickly once OBS is steady.
  // (uses the same 2-second OBS stats poll as the stream-health line)
  // Not every skip is ours: a heavy stinger makes OBS skip a few frames on
  // each transition, and an occasional single skip is noise. Reacting to those
  // used to ratchet the previews down to ~15 fps over a stream, so skips
  // during a scene transition are ignored, and a short dip needs to be real
  // (more than 2 frames and over 0.5% of the frames in that window).
  let prevStats = null;
  let steadySince = Date.now();
  let lastTransition = 0;
  for (const ev of ['SceneTransitionStarted', 'SceneTransitionEnded', 'SceneTransitionVideoEnded']) obs.on(ev, () => { lastTransition = Date.now(); });
  studio.on('stats', (st) => {
    const running = Object.values(feeds).some((f) => f.running);
    const now = Date.now();
    const cur = {
      skip: (st.renderSkippedFrames ?? 0) + (st.outputSkippedFrames ?? 0),
      ren: st.renderSkippedFrames ?? 0,
      total: (st.renderTotalFrames ?? 0) + (st.outputTotalFrames ?? 0),
    };
    const prev = prevStats;
    prevStats = running ? cur : null;
    if (!running || !prev) return;
    const dSkip = cur.skip - prev.skip;
    const dTotal = Math.max(1, cur.total - prev.total);
    const inTransition = now - lastTransition < 4000; // the 2 s window overlapped a transition
    if (dSkip > 2 && dSkip / dTotal > 0.005 && !inTransition) {
      const ren = (st.renderSkippedFrames ?? 0) - (prev.ren ?? 0);
      const why = ren >= dSkip - ren ? 'render' : 'encode';
      const fpsNow = Object.fromEntries(Object.entries(feeds).filter(([, f]) => f.running).map(([k, f]) => [k, f.stats().fps]));
      for (const f of Object.values(feeds)) { f.fpsCap = Math.max(15, Math.round(Math.min(f.fps, f.fpsCap) * 0.75)); f.guardWhy = why; }
      steadySince = now;
      console.log(`[guard] OBS skipped ${dSkip} of ${dTotal} frames (render ${ren}, encode ${dSkip - ren}) while mirrors ran at ${JSON.stringify(fpsNow)}, OBS cpu ${Math.round(st.cpuUsage ?? 0)}% → capped at ${feeds.program.fpsCap}`);
    } else if (now - steadySince >= 4000) {
      for (const f of Object.values(feeds)) if (f.fpsCap < f.fps) f.fpsCap = Math.min(f.fps, f.fpsCap + Math.max(5, Math.round(f.fpsCap * 0.25)));
      steadySince = now;
    }
  });
  setInterval(() => clients.size && sendAll('fps', { donation: feeds.donation.stats(), chat: feeds.chat.stats(), alert: feeds.alert.stats(), program: feeds.program.stats() }), 1000);

  // ---------- launcher helpers ----------
  // Firewall check runs PowerShell, so cache it (re-check at most once a minute).
  let fwCache = null;
  async function firewall(force = false) {
    if (force || !fwCache || Date.now() - fwCache.at > 60000) fwCache = { ...(await win.firewallStatus(PORT)), at: Date.now() };
    return fwCache;
  }

  // Cached: finding OBS reads the registry, and checking whether it runs
  // starts tasklist. Neither needs doing every few seconds; and when we're
  // connected to OBS it's obviously running.
  let obsExe = undefined;
  let runningCache = { at: 0, value: false };
  async function obsInfo() {
    if (obsExe === undefined || (!obsExe && Date.now() - (obsInfo.lastFind || 0) > 30000)) {
      obsExe = await win.findObs(config.obs.path);
      obsInfo.lastFind = Date.now();
    }
    const exe = obsExe;
    let running = obs.connected;
    if (!running) {
      if (Date.now() - runningCache.at > 8000) runningCache = { at: Date.now(), value: await win.isObsRunning() };
      running = runningCache.value;
    }
    let debugOn = false;
    try {
      debugOn = (await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(800) })).ok;
    } catch {}
    return { exe, running, debugOn };
  }

  async function startObs() {
    const info = await obsInfo();
    if (info.running) throw new Error('OBS가 이미 실행 중이에요');
    if (!info.exe) throw new Error('OBS를 찾을 수 없어요 — 설정에서 OBS 위치를 지정해 주세요');
    await win.launchObs(info.exe);
    runningCache.at = 0;
    // Confirm it actually came up (it can take a while on first launch).
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await win.isObsRunning()) {
        runningCache = { at: Date.now(), value: true };
        console.log('[obs] running');
        return { started: true };
      }
    }
    console.log('[obs] did not appear within 15s');
    throw new Error(`OBS가 켜지지 않았어요 (${info.exe}). 설정 폴더의 data\\stream-desk.log를 보내 주세요`);
  }

  function restart() {
    console.log('[app] restarting');
    const self = IS_EXE ? [] : [process.argv[1]];
    const passOn = [...args].filter((a) => a !== '--restart' && a !== '--minimized');
    server.close();
    for (const s of sockets) s.destroy();
    spawn(process.execPath, [...self, ...passOn, '--restart'], { detached: true, stdio: 'ignore', cwd: ROOT, windowsHide: true }).unref();
    setTimeout(() => process.exit(0), 100);
  }

  function quit() {
    console.log('[app] quit');
    sendAll('bye', {});
    setTimeout(() => process.exit(0), 200);
  }

  function countMusic(folder) {
    const exts = config.bgm.extensions.map((e) => e.toLowerCase());
    let n = 0;
    const walk = (d, depth) => {
      if (depth > 6 || n > 5000) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (exts.includes(path.extname(e.name).toLowerCase())) n++;
      }
    };
    if (!folder || !fs.existsSync(folder)) return null;
    walk(folder, 0);
    return n;
  }

  // ---------- API ----------
  const routes = {
    'POST /api/bgm/play': () => bgm.play(),
    'POST /api/bgm/pause': () => bgm.pause(),
    'POST /api/bgm/toggle': () => bgm.toggle(),
    'POST /api/bgm/next': () => bgm.next(),
    'POST /api/bgm/prev': () => bgm.prev(),
    'POST /api/bgm/select': (b) => bgm.select(b.id),
    'POST /api/bgm/seek': (b) => bgm.seek(b.ms),
    'POST /api/bgm/volume': (b) => bgm.setVolume(b.db),
    'POST /api/bgm/mode': (b) => bgm.setPlayMode(b.mode),
    'POST /api/bgm/move': (b) => bgm.move(b.id, b.index),
    'POST /api/bgm/rescan': () => bgm.rescan(),
    'POST /api/bgm/create-source': async () => ({ scene: await bgm.createSource() }),
    'POST /api/autopause': (b) => bgm.setAutoPause(b),
    'POST /api/donation/click': (b) => interact.click(b.x, b.y, viewer.size),
    'POST /api/donation/hover': (b) => interact.hover(b.x, b.y, viewer.size),
    'POST /api/donation/wheel': (b) => interact.wheel(b.x, b.y, b.deltaY, viewer.size),
    'POST /api/donation/skip': async () => ({ skipped: await interact.skipAd() }),
    'POST /api/donation/autoskip': (b) => interact.setAutoSkip(b.on),
    'POST /api/donation/target': (b) => interact.setMatch(b.match),
    'POST /api/donation/refresh': () => viewer.refresh(),
    'POST /api/donation/quality': (b) => viewer.setQuality(b.quality),
    'POST /api/program/quality': (b) => program.setQuality(b.quality),
    'POST /api/chzzk/channel': (b) => chzzk.setChannel(b.channel),
    'POST /api/remote/skip': () => remote.skip(),
    'POST /api/remote/pause': () => remote.togglePause(),
    'POST /api/remote/stop': () => remote.stopVideo(),
    'POST /api/scene': (b) => studio.setScene(String(b.name || '')),
    'POST /api/mark/label': (b) => markers.setLabel(Number(b.index), b.label),
    'POST /api/sb/play': (b) => soundboard.play(String(b.id || '')),
    'POST /api/sb/stop': () => soundboard.stop(),
    'POST /api/sb/volume': (b) => soundboard.setVolume(b.db),
    'POST /api/sb/rescan': () => soundboard.rescan(),
    'POST /api/sb/create-source': async () => ({ scenes: await soundboard.createSource() }),
    'POST /api/mic/toggle': async () => ({ muted: await studio.toggleMic() }),
    'POST /api/chzzk/donation-read': (b) => chzzk.markRead(b.key, b.read !== false),
    'POST /api/chzzk/donations-read-all': () => chzzk.markAllRead(),
    'POST /api/chzzk/donations-clear': () => chzzk.clearDonations(),
  };

  // Launcher / settings: stream PC only (they expose the OBS password).
  const localRoutes = {
    'GET /api/launcher': async () => {
      const info = await obsInfo();
      let inputs = [];
      if (obs.connected) {
        try {
          inputs = (await obs.call('GetInputList')).inputs.map((i) => ({ name: i.inputName, kind: i.inputKind }));
        } catch {}
      }
      return {
        version: VERSION,
        isExe: IS_EXE,
        firstRun: config._firstRun,
        importedFrom: config._importedFrom,
        configPath: configPath(),
        addresses: lanAddresses(),
        obs: { ...info, connected: obs.connected, error: obs.connected ? null : obs.lastError },
        runAtLogin: win.runAtLoginEnabled(),
        remote: remote.status(),
        remoteUrl: chzzk.channelId ? `https://studio.chzzk.naver.com/${chzzk.channelId}/remotecontrol` : null,
        firewall: await firewall(),
        inputs,
        musicCount: countMusic(config.bgm.folder),
        soundCount: config.soundboard?.folder ? countMusic(config.soundboard.folder) : undefined,
        settings: {
          obsPassword: config.obs.password,
          obsPort: Number(/:(\d+)/.exec(config.obs.url.replace(/^ws:\/\//, ''))?.[1] || 4455),
          obsPath: config.obs.path || info.exe || '',
          startObs: config.app.startObs,
          donation: config.sources.donation,
          chat: config.sources.chat,
          alert: config.sources.alert,
          mic: config.sources.mic || '',
          bgmSource: config.sources.bgm,
          folder: config.bgm.folder,
          sbFolder: config.soundboard?.folder || '',
          channel: chzzk.channelId || '',
          port: PORT,
        },
      };
    },
    'POST /api/launcher/save': async (b) => {
      const s = b.settings || {};
      if (s.channel) {
        if (!parseChannelId(s.channel)) throw new Error('치지직 채널 주소를 확인해 주세요 (32자리 영문+숫자 ID가 들어 있어야 해요)');
      }
      saveConfig({
        app: { startObs: !!s.startObs },
        obs: { password: s.obsPassword ?? '', url: `ws://127.0.0.1:${Number(s.obsPort) || 4455}`, path: s.obsPath || '' },
        sources: { donation: s.donation, chat: s.chat, alert: s.alert || '', mic: s.mic || '', bgm: s.bgmSource },
        bgm: { folder: s.folder || '' },
        soundboard: { folder: s.sbFolder || '' },
        chzzk: { channelId: parseChannelId(s.channel) || '' },
        server: { port: Number(s.port) || 8080 },
      });
      if (s.channel && parseChannelId(s.channel) !== chzzk.channelId) chzzk.setChannel(s.channel);
      if (typeof s.runAtLogin === 'boolean' && s.runAtLogin !== win.runAtLoginEnabled()) {
        await win.setRunAtLogin(s.runAtLogin, process.execPath);
      }
      const portChanged = (Number(s.port) || 8080) !== PORT;
      setTimeout(restart, 300);
      return { restarting: true, newUrl: portChanged ? `http://127.0.0.1:${Number(s.port)}/launcher` : null };
    },
    'POST /api/launcher/start-obs': () => startObs(),
    'POST /api/launcher/firewall': async () => {
      await win.allowFirewall(PORT);
      const st = await firewall(true);
      if (!st.ok) throw new Error('방화벽 규칙을 확인하지 못했어요 — 다시 시도해 주세요');
      return st;
    },
    'POST /api/launcher/pick-folder': async (b) => ({ path: await win.pickFolder(b.start) }),
    'POST /api/launcher/folder-count': (b) => ({ count: countMusic(b.path) }),
    'POST /api/launcher/open-dashboard': () => openDashboardHere(),
    'POST /api/launcher/open-data': () => win.openFolder(CONFIG_DIR),
    'POST /api/launcher/quit': () => quit(),
  };

  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;

    // ⭐ Mark moment: one request from anywhere on the LAN (a hotkey, a Stream
    // Deck key, the /mark page). 200 {ok,t,count} or 409 {ok:false,reason}.
    if (key === 'POST /api/mark') {
      const b = await readBody(req);
      const r = await markers.mark(b.label ?? url.searchParams.get('label'));
      return json(res, r.ok ? 200 : 409, r);
    }
    if (key === 'GET /api/marks') return json(res, 200, markers.status());
    if (key === 'GET /mark') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(readAsset('public/mark.html'));
    }

    if (key === 'GET /api/ping') return json(res, 200, { app: 'stream-desk', version: VERSION });

    if (key === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      res.write(`event: tracks\ndata: ${tracksJson}\n\n`); // (snapshot() just brought it up to date)
      if (studio.health) res.write(`event: health\ndata: ${JSON.stringify(studio.health)}\n\n`);
      res.write(`event: chat-history\ndata: ${JSON.stringify(chzzk.chat)}\n\n`);
      res.write(`event: donations-history\ndata: ${JSON.stringify(chzzk.donationList())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // Live picture as a continuous MJPEG stream: one long response, a new
    // JPEG part per frame. <img> shows it natively, no per-frame requests.
    if (key === 'GET /api/stream') {
      const feed = feeds[url.searchParams.get('src')] || feeds.donation;
      // raw=1: same bytes, but labelled as plain data. Safari handles the
      // "multipart/x-mixed-replace" type itself and never hands it to the page.
      const raw = url.searchParams.get('raw') === '1';
      res.writeHead(200, {
        'Content-Type': raw ? 'application/octet-stream' : 'multipart/x-mixed-replace; boundary=sdframe',
        'Cache-Control': 'no-store, no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('--sdframe\r\n');
      let busy = false;
      // per-device cap (데이터 절약 on a phone): skip frames for this client only.
      // The shared feed — and so OBS's work — is the same either way.
      const maxFps = Number(url.searchParams.get('maxFps')) || 0;
      const minGap = maxFps > 0 ? 1000 / maxFps : 0;
      // token bucket: averages to maxFps even when frames arrive in pairs
      let tokens = 2, lastAt = Date.now();
      const unsub = feed.subscribe((f) => {
        if (busy) return; // slow connection: skip frames rather than queue them
        if (minGap) {
          const now = Date.now();
          tokens = Math.min(2, tokens + (now - lastAt) / minGap);
          lastAt = now;
          if (tokens < 1) return;
          tokens -= 1;
        }
        // The boundary goes right after each frame so Chrome shows it immediately.
        const ok = res.write(`Content-Type: ${f.type}\r\nContent-Length: ${f.buf.length}\r\n\r\n`) && res.write(f.buf) && res.write('\r\n--sdframe\r\n');
        if (!ok) {
          busy = true;
          res.once('drain', () => (busy = false));
        }
      });
      req.on('close', unsub);
      return;
    }

    // One frame at a time (fallback for browsers that can't read the stream).
    // ?after=<seq> waits up to 2 s for a newer frame than the one it has.
    if (key === 'GET /api/frame') {
      const which = feeds[url.searchParams.get('src')] ? url.searchParams.get('src') : 'donation';
      const h = pollHold(which);
      const after = Number(url.searchParams.get('after')) || 0;
      const cap = Number(url.searchParams.get('maxFps')) || 0;
      const send = () => {
        if (res.writableEnded) return;
        if (!h.frame) return json(res, 503, { error: 'no frame yet' });
        res.writeHead(200, { 'Content-Type': h.frame.type, 'Cache-Control': 'no-store', 'X-Seq': String(h.seq) });
        res.end(h.frame.buf);
      };
      if (h.frame && h.seq > after) {
        // per-device cap (데이터 절약): space the replies out
        if (cap > 0) setTimeout(send, Math.max(0, 1000 / cap - (Date.now() - (h.lastServed || 0))));
        else send();
        h.lastServed = Date.now();
        return;
      }
      const done = () => { clearTimeout(t); h.waiters.delete(done); send(); };
      const t = setTimeout(done, 2000);
      h.waiters.add(done);
      req.on('close', () => { clearTimeout(t); h.waiters.delete(done); });
      return;
    }

    const handler = routes[key] || (localRoutes[key] && isLocal(req) ? localRoutes[key] : null);
    if (localRoutes[key] && !isLocal(req)) return json(res, 403, { ok: false, error: '설정은 방송 PC에서만 바꿀 수 있어요' });
    if (handler) {
      try {
        const result = await handler(req.method === 'POST' ? await readBody(req) : {});
        stateChanged();
        json(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'GET') {
      let rel = url.pathname === '/' ? 'index.html' : url.pathname === '/launcher' ? 'launcher.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!rel.includes('..')) {
        const body = readAsset(path.posix.join('public', rel));
        if (body) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          res.end(body);
          return;
        }
      }
    }
    json(res, 404, { error: 'Not found' });
  });

  console.log(`Stream Desk ${VERSION} on port ${PORT} — ${lanAddresses().join(', ') || 'no network'}`);
  if (!IS_EXE) {
    console.log(`\n  Launcher:  ${launcherUrl()}\n  Dashboard: ${lanAddresses()[0] || `http://localhost:${PORT}`}\n`);
  }

  obs.start();

  // ---------- desktop niceties ----------
  if (win.isWin) {
    win.startTray({
      exe: process.execPath,
      labels: { open: 'Stream Desk 열기', dashboard: '대시보드 열기 (이 PC)', quit: '종료' },
      onOpen: openLauncher,
      onDashboard: openDashboardHere,
      onQuit: quit,
    });
  }
  firewall().then((st) => console.log(`[firewall] inbound rule for ${PORT}: ${st.ok ? 'present' : 'MISSING'}`));
  if (config._importedFrom) console.log(`[config] imported settings from ${config._importedFrom}`);
  // If "start with Windows" is on, point it at this copy of the exe (the old one may be gone).
  if (IS_EXE && win.runAtLoginEnabled()) win.setRunAtLogin(true, process.execPath).catch(() => {});
  if (config.app.startObs && !args.has('--restart') && !config._firstRun) {
    startObs().then(() => console.log('[app] started OBS'), (e) => console.log('[app] OBS not started:', e.message));
  }
  if (!args.has('--restart') && !args.has('--minimized') && config.app.openWindowOnStart) openLauncher();
}

main().catch(async (e) => {
  console.error(e.stack || e);
  await win.alertBox(`Stream Desk를 시작하지 못했어요:\n${e.message}`);
  process.exit(1);
});
