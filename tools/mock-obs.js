// Fake OBS for testing Arkbird without the stream PC.
//  - obs-websocket v5 on ws://127.0.0.1:4455 (password via MOCK_OBS_PASSWORD)
//  - Chrome DevTools endpoint on http://127.0.0.1:9222 pretending to be the 영도 browser source
// Simulates: a BGM media source that "plays" (20s per track), a 영도 that
// makes sound for 8s every 25s, and a YouTube ad with a skip button.
// Run: npm install && npm run mock
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const DONATION = process.env.MOCK_DONATION || '영도';
const BGM = process.env.MOCK_BGM || 'BGM Player';
const PASSWORD = process.env.MOCK_OBS_PASSWORD || '';
const TRACK_MS = Number(process.env.MOCK_TRACK_MS || 20000);

const inputs = new Map([
  [DONATION, { kind: 'browser_source', settings: { url: 'https://chzzk.naver.com/widget/video-donation?token=abc', width: 1280, height: 720 }, volumeDb: 0 }],
  ['Mic', { kind: 'wasapi_input_capture', settings: {}, volumeDb: 0 }],
  ['위플챗', { kind: 'browser_source', settings: { url: process.env.MOCK_CHAT_PAGE ? 'http://127.0.0.1:9333/overlay' : 'https://weflab.com/page/chat-overlay', width: 420, height: 760 }, volumeDb: 0 }],
  ['도네 알림', { kind: 'browser_source', settings: { url: 'https://weflab.com/page/alert', width: 1280, height: 720 }, volumeDb: 0 }],
]);
if (!process.env.MOCK_NO_BGM) inputs.set(BGM, { kind: 'ffmpeg_source', settings: {}, volumeDb: 0 });

let statSkips = 0;
let shotCount = 0;
if (process.env.MOCK_COUNT) setInterval(() => { console.log('SHOTS/s', shotCount); shotCount = 0; }, 1000);
const scene = { list: ['Main', 'Just Chatting', 'BRB', 'Ending'], current: 'Main' };
const media = { state: 'OBS_MEDIA_STATE_NONE', cursor: 0, duration: TRACK_MS, file: null };
const t0 = Date.now();
// MOCK_YD_INTRO=1: a real 영도's shape — 1 s alert, 5 s silence, then the video
const donationLoud = process.env.MOCK_YD_INTRO
  ? () => { const t = (Date.now() - t0) % 40000; return (t > 5000 && t < 6000) || (t > 11000 && t < 25000); }
  : () => (Date.now() - t0) % 25000 > 5000 && (Date.now() - t0) % 25000 < 13000;
const adShowing = () => donationLoud() && !adSkipped;
let adSkipped = false;
setInterval(() => { if (!donationLoud()) adSkipped = false; }, 500);

// Optional real JPEG frames (MOCK_FRAMES=dir with v00.jpg… and idle.jpg) so
// frame rates can be measured; otherwise SVG drawings are used.
import fs from 'node:fs';
const FRAMES_DIR = process.env.MOCK_FRAMES;
const frames = FRAMES_DIR ? fs.readdirSync(FRAMES_DIR).filter((f) => /^v\d+\.jpg$/.test(f)).sort().map((f) => fs.readFileSync(`${FRAMES_DIR}/${f}`)) : [];
const idleFrame = FRAMES_DIR ? fs.readFileSync(`${FRAMES_DIR}/idle.jpg`) : null;
// "video" plays at 30 fps while a 영도 is on
const VIDEO_FPS = Number(process.env.MOCK_VIDEO_FPS || 30);
const currentJpeg = () => (donationLoud() ? frames[Math.floor((Date.now() / (1000 / VIDEO_FPS)) % frames.length)] : idleFrame);
const SCREENSHOT_MS = Number(process.env.MOCK_SCREENSHOT_MS || 40); // OBS screenshot cost
const NO_SCREENCAST = !!process.env.MOCK_NO_SCREENCAST;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- obs-websocket ----------------
const wss = new WebSocketServer({ port: 4455 });
const clients = new Set();
function broadcast(eventType, eventData, mask) {
  for (const c of clients) {
    if (c.subs & mask) c.ws.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: mask, eventData } }));
  }
}

wss.on('connection', (ws) => {
  const c = { ws, subs: 0, identified: false };
  const salt = crypto.randomBytes(16).toString('base64');
  const challenge = crypto.randomBytes(16).toString('base64');
  ws.send(JSON.stringify({
    op: 0,
    d: { obsWebSocketVersion: '5.5.0-mock', rpcVersion: 1, ...(PASSWORD ? { authentication: { salt, challenge } } : {}) },
  }));
  ws.on('message', (raw) => {
    const { op, d } = JSON.parse(raw);
    if (op === 1) {
      if (PASSWORD) {
        const h = (s) => crypto.createHash('sha256').update(s).digest('base64');
        if (d.authentication !== h(h(PASSWORD + salt) + challenge)) return ws.close(4009, 'Authentication failed.');
      }
      c.subs = d.eventSubscriptions;
      c.identified = true;
      clients.add(c);
      ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      log('client identified');
    }
    if (op === 6 && d.requestType === 'GetSourceScreenshot') shotCount++;
    if (op === 6 && c.identified && d.requestType === 'GetSourceScreenshot' && FRAMES_DIR && inputs.has(d.requestData.sourceName)) {
      // real JPEG, with a realistic delay for OBS rendering + encoding
      setTimeout(() => ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: true, code: 100 }, responseData: { imageData: 'data:image/jpg;base64,' + currentJpeg().toString('base64') } } })), SCREENSHOT_MS);
      return;
    }
    if (op === 6 && c.identified) {
      let responseData = {};
      let ok = true;
      let comment = '';
      try {
        if (process.env.MOCK_REQS) reqCounts[d.requestType] = (reqCounts[d.requestType] || 0) + 1;
        responseData = handle(d.requestType, d.requestData || {}) || {};
      } catch (e) {
        ok = false;
        comment = e.message;
      }
      ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: ok, code: ok ? 100 : 600, comment }, responseData } }));
    }
  });
  ws.on('close', () => clients.delete(c));
});

function need(name) {
  const i = inputs.get(name);
  if (!i) throw new Error(`No source was found by the name of \`${name}\`.`);
  return i;
}

// recording (for the ⭐ marker feature). MOCK_REC_DIR = where "videos" go;
// MOCK_NO_CHAPTERS = behave like an OBS without Hybrid MP4 chapter support.
const REC_DIR = process.env.MOCK_REC_DIR || '/tmp/mock-rec';
const sceneAdds = {};
const reqCounts = {};
if (process.env.MOCK_REQS) setInterval(() => { console.log('REQS/20s', JSON.stringify(reqCounts)); for (const k in reqCounts) delete reqCounts[k]; }, 20000);
const rec = { active: false, paused: false, acc: 0, since: 0, path: '', chapters: [] };
const recMs = () => rec.acc + (rec.active && !rec.paused ? Date.now() - rec.since : 0);
const recState = (s, extra = {}) => broadcast('RecordStateChanged', { outputActive: rec.active, outputState: 'OBS_WEBSOCKET_OUTPUT_' + s, outputPath: null, ...extra }, 1 << 6);
function recHandle(type, d) {
  const pad = (n) => String(n).padStart(2, '0');
  switch (type) {
    case 'GetRecordStatus': return { outputActive: rec.active, outputPaused: rec.paused, outputTimecode: '', outputDuration: Math.round(recMs()), outputBytes: 0 };
    case 'GetRecordDirectory': return { recordDirectory: REC_DIR };
    case 'StartRecord': {
      if (rec.active) throw new Error('Record is already active.');
      const n = new Date();
      Object.assign(rec, { active: true, paused: false, acc: 0, since: Date.now(), chapters: [],
        path: `${REC_DIR}/${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} ${pad(n.getHours())}-${pad(n.getMinutes())}-${pad(n.getSeconds())}.mp4` });
      fs.mkdirSync(REC_DIR, { recursive: true });
      log('record start', rec.path);
      setTimeout(() => recState('STARTING'), 10);
      setTimeout(() => recState('STARTED', { outputPath: rec.path }), 60);
      return;
    }
    case 'StopRecord': {
      if (!rec.active) throw new Error('Record is not active.');
      rec.acc = recMs(); rec.active = false; rec.paused = false;
      fs.writeFileSync(rec.path, JSON.stringify({ mock: true, durationMs: rec.acc, chapters: rec.chapters }));
      log('record stop', rec.path, (rec.acc / 1000).toFixed(1) + 's', rec.chapters.length, 'chapters');
      setTimeout(() => recState('STOPPING'), 10);
      setTimeout(() => recState('STOPPED', { outputPath: rec.path }), Number(process.env.MOCK_STOP_MS || 2500)); // OBS finishes the file first
      return { outputPath: rec.path };
    }
    case 'PauseRecord': rec.acc = recMs(); rec.paused = true; setTimeout(() => recState('PAUSED'), 10); return;
    case 'ResumeRecord': rec.since = Date.now(); rec.paused = false; setTimeout(() => recState('RESUMED'), 10); return;
    case 'CreateRecordChapter':
      if (process.env.MOCK_NO_CHAPTERS) throw new Error('Current recording format does not support chapters.');
      if (!rec.active) throw new Error('Record is not active.');
      rec.chapters.push({ t: recMs() / 1000, name: d.chapterName ?? `Unnamed ${rec.chapters.length + 1}` });
      log('chapter', rec.chapters.at(-1));
      return;
  }
  return undefined;
}

// MOCK_SKIP_EVERY_MS: OBS skips a few frames every N ms (like a heavy stinger);
// MOCK_SKIP_TRANSITION=1: those bursts happen during a scene transition.
let burstSkips = 0;
if (process.env.MOCK_SKIP_EVERY_MS) setInterval(() => {
  if (process.env.MOCK_SKIP_TRANSITION) broadcast('SceneTransitionStarted', { transitionName: 'Stinger' }, 1 << 4);
  setTimeout(() => { burstSkips += 8; }, 300);
  if (process.env.MOCK_SKIP_TRANSITION) setTimeout(() => broadcast('SceneTransitionEnded', { transitionName: 'Stinger' }, 1 << 4), 1500);
}, Number(process.env.MOCK_SKIP_EVERY_MS));

function handle(type, d) {
  switch (type) {
    case 'GetRecordStatus': case 'GetRecordDirectory': case 'StartRecord': case 'StopRecord': case 'PauseRecord': case 'ResumeRecord': case 'CreateRecordChapter':
      return recHandle(type, d);
    case 'GetVersion': return { obsVersion: '31.0.0-mock' };
    // MOCK_OBS_STRUGGLES=1: OBS skips frames while it's busy making screenshots
    case 'GetStats': { const sec = (Date.now() - t0) / 1000; return { renderSkippedFrames: process.env.MOCK_OBS_STRUGGLES ? (statSkips += 3) : burstSkips, renderTotalFrames: Math.round(sec * 60), outputSkippedFrames: 0, outputTotalFrames: Math.round(sec * 60), activeFps: 60, cpuUsage: 7.5 }; }
    case 'GetInputList': return { inputs: [...inputs].map(([n, i]) => ({ inputName: n, inputKind: i.kind })) };
    case 'GetCurrentProgramScene': return { currentProgramSceneName: scene.current };
    case 'SetCurrentProgramScene':
      if (!scene.list.includes(d.sceneName)) throw new Error('no scene');
      scene.current = d.sceneName; log('scene →', d.sceneName);
      setTimeout(() => broadcast('CurrentProgramSceneChanged', { sceneName: d.sceneName }, 1 << 2), 30);
      return;
    case 'GetSpecialInputs': return { desktop1: 'Desktop Audio', mic1: 'Mic' };
    case 'GetInputMute': need(d.inputName); return { inputMuted: !!need(d.inputName).muted };
    case 'ToggleInputMute': {
      const i = need(d.inputName); i.muted = !i.muted; log('mute', d.inputName, i.muted);
      setTimeout(() => broadcast('InputMuteStateChanged', { inputName: d.inputName, inputMuted: i.muted }, 1 << 3), 20);
      return { inputMuted: i.muted };
    }
    case 'GetStreamStatus': {
      const sec = (Date.now() - t0) / 1000;
      const drops = process.env.MOCK_DROPS ? Math.floor(sec * 2) : 0;
      return { outputActive: true, outputReconnecting: false, outputBytes: Math.round(sec * 6000 * 125 * (0.95 + Math.random() * 0.1)),
        outputTotalFrames: Math.round(sec * 60), outputSkippedFrames: drops, outputCongestion: process.env.MOCK_DROPS ? 0.4 : 0.02, outputDuration: sec * 1000 };
    }
    case 'GetVideoSettings': return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 };
    case 'GetSceneList': return { currentProgramSceneName: scene.current, scenes: scene.list.map((n, i, a) => ({ sceneName: n, sceneIndex: a.length - 1 - i })).reverse() };
    case 'GetInputSettings': { const i = need(d.inputName); return { inputKind: i.kind, inputSettings: i.settings }; }
    case 'GetInputDefaultSettings': return { defaultInputSettings: d.inputKind === 'browser_source' ? { width: 800, height: 600 } : {} };
    case 'SetInputSettings': {
      const i = need(d.inputName);
      Object.assign(i.settings, d.inputSettings);
      if (d.inputName === BGM && d.inputSettings.local_file) {
        // Like OBS: switching files fires a stray "ended" for the old one, then opens the new one.
        if (media.file) broadcast('MediaInputPlaybackEnded', { inputName: BGM }, 1 << 8);
        media.file = d.inputSettings.local_file;
        media.cursor = 0;
        // Like OBS: after a song has ended, loading a new file doesn't start it.
        if (media.state === 'OBS_MEDIA_STATE_ENDED' && process.env.MOCK_STICKY_END) { log('BGM loaded but stays ENDED:', media.file.split(/[\\/]/).pop()); return; }
        media.state = 'OBS_MEDIA_STATE_OPENING';
        setTimeout(() => { if (media.state === 'OBS_MEDIA_STATE_OPENING') { media.state = 'OBS_MEDIA_STATE_PLAYING'; broadcast('MediaInputPlaybackStarted', { inputName: BGM }, 1 << 8); } }, 300);
        log('BGM loading:', media.file.split(/[\\/]/).pop());
      }
      broadcast('InputSettingsChanged', { inputName: d.inputName, inputSettings: i.settings }, 1 << 3);
      return;
    }
    case 'GetSceneItemList': {
      // Main / Just Chatting hold the BGM directly; BRB has it inside the "Music" group
      const has = inputs.has(BGM);
      if (d.sceneName === 'BRB') return { sceneItems: [{ sourceName: 'Music', isGroup: true, sceneItemId: 1 }] };
      return { sceneItems: [...(has && ['Main', 'Just Chatting'].includes(d.sceneName) ? [{ sourceName: BGM, isGroup: false, sceneItemId: 2 }] : []), ...(sceneAdds[d.sceneName] || [])] };
    }
    case 'GetGroupSceneItemList': return { sceneItems: d.sceneName === 'Music' ? [{ sourceName: BGM, isGroup: false, sceneItemId: 3 }] : [] };
    case 'CreateSceneItem': {
      need(d.sourceName);
      (sceneAdds[d.sceneName] ||= []).push({ sourceName: d.sourceName, isGroup: false, sceneItemId: 9 });
      log('added', d.sourceName, 'to scene', d.sceneName);
      return { sceneItemId: 9 };
    }
    case 'GetInputAudioTracks': need(d.inputName); return { inputAudioTracks: need(d.inputName).tracks || { 1: true, 2: false, 3: true, 4: false, 5: false, 6: false } };
    case 'SetInputAudioTracks': need(d.inputName).tracks = d.inputAudioTracks; log('tracks', d.inputName, JSON.stringify(d.inputAudioTracks)); return;
    case 'CreateInput': {
      if (d.sceneName === 'Music' && !process.env.MOCK_GROUP_OK) throw new Error('Scene is a group');
      inputs.set(d.inputName, { kind: d.inputKind, settings: d.inputSettings || {}, volumeDb: 0 });
      log('created input', d.inputName, 'in', d.sceneName);
      return { inputUuid: crypto.randomUUID(), sceneItemId: 7 };
    }
    case 'SetInputAudioMonitorType': need(d.inputName).monitor = d.monitorType; log('monitor', d.inputName, '→', d.monitorType.replace('OBS_MONITORING_TYPE_', '')); return;
    case 'GetInputAudioMonitorType': return { monitorType: need(d.inputName).monitor || 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' };
    case 'SetInputVolume': need(d.inputName).volumeDb = d.inputVolumeDb; log(`volume ${d.inputName} → ${d.inputVolumeDb} dB`); return;
    case 'GetInputVolume': return { inputVolumeDb: need(d.inputName).volumeDb };
    case 'GetSourceActive': return { videoActive: !process.env.MOCK_BGM_INACTIVE || d.sourceName !== BGM, videoShowing: true };
    case 'GetMediaInputStatus': need(d.inputName); return { mediaState: media.state, mediaCursor: Math.round(media.cursor), mediaDuration: media.file ? media.duration : null };
    case 'SetMediaInputCursor': media.cursor = d.mediaCursor; return;
    case 'TriggerMediaInputAction': {
      need(d.inputName);
      if (d.inputName !== BGM) { // e.g. the soundboard: plays for MOCK_SB_MS, then "ended"
        const a = d.mediaAction.replace('OBS_WEBSOCKET_MEDIA_INPUT_ACTION_', '');
        const i = need(d.inputName);
        clearTimeout(i.endTimer);
        log('media action', d.inputName, a, (i.settings.local_file || '').split(/[\\/]/).pop());
        if (a === 'RESTART' || a === 'PLAY') i.endTimer = setTimeout(() => broadcast('MediaInputPlaybackEnded', { inputName: d.inputName }, 1 << 8), Number(process.env.MOCK_SB_MS || 1500));
        return;
      }
      const a = d.mediaAction.replace('OBS_WEBSOCKET_MEDIA_INPUT_ACTION_', '');
      if (a === 'PLAY' && media.file && !['OBS_MEDIA_STATE_OPENING', 'OBS_MEDIA_STATE_ENDED'].includes(media.state)) media.state = 'OBS_MEDIA_STATE_PLAYING';
      if (a === 'RESTART' && media.file) { media.cursor = 0; media.state = 'OBS_MEDIA_STATE_OPENING'; setTimeout(() => { if (media.state === 'OBS_MEDIA_STATE_OPENING') media.state = 'OBS_MEDIA_STATE_PLAYING'; }, 250); }
      if (a === 'PAUSE' && media.state === 'OBS_MEDIA_STATE_PLAYING') media.state = 'OBS_MEDIA_STATE_PAUSED';
      broadcast('MediaInputActionTriggered', { inputName: d.inputName, mediaAction: d.mediaAction }, 1 << 8);
      if (a === 'STOP') media.state = 'OBS_MEDIA_STATE_STOPPED';
      log('media action', a, '→', media.state);
      return;
    }
    case 'PressInputPropertiesButton': need(d.inputName); log('pressed', d.propertyName, 'on', d.inputName); return;
    case 'GetSourceScreenshot': {
      if (scene.list.includes(d.sourceName) && process.env.MOCK_PROGRAM_JPG) return { imageData: 'data:image/jpeg;base64,' + fs.readFileSync(process.env.MOCK_PROGRAM_JPG).toString('base64') };
      if (scene.list.includes(d.sourceName)) return { imageData: 'data:image/svg+xml;base64,' + Buffer.from(fakeProgram()).toString('base64') };
      need(d.sourceName);
      const svg = d.sourceName === '위플챗' ? fakeOverlay() : fakeFrame();
      return { imageData: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
    }
    default: throw new Error(`mock: ${type} not implemented`);
  }
}

// media clock + end events
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (media.state === 'OBS_MEDIA_STATE_PLAYING') {
    media.cursor += now - lastTick;
    if (media.cursor >= media.duration) {
      media.cursor = media.duration;
      media.state = 'OBS_MEDIA_STATE_ENDED';
      broadcast('MediaInputPlaybackEnded', { inputName: BGM }, 1 << 8);
      log('track ended');
    }
  }
  lastTick = now;
}, 100);

// volume meters at 20 Hz
setInterval(() => {
  const loud = donationLoud();
  const amp = loud ? 0.1 + Math.random() * 0.2 : 0;
  const bgmAmp = media.state === 'OBS_MEDIA_STATE_PLAYING' ? 0.2 : 0;
  broadcast('InputVolumeMeters', {
    inputs: [
      { inputName: DONATION, inputLevelsMul: [[amp * 0.6, amp, amp], [amp * 0.6, amp, amp]] },
      ...(inputs.has(BGM) ? [{ inputName: BGM, inputLevelsMul: [[bgmAmp, bgmAmp, bgmAmp]] }] : []),
      { inputName: 'Mic', inputLevelsMul: inputs.get('Mic')?.muted ? [[0, 0, 0]] : [[0.05, Math.random() < 0.5 ? 0.02 + Math.random() * 0.3 : 0.003, 0.3]] },
    ],
  }, 1 << 16);
}, 50);

function fakeFrame() {
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const loud = donationLoud();
  const ad = adShowing();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="${loud ? '#1d2a3a' : '#111'}"/>
  ${loud ? `<rect x="140" y="80" width="1000" height="560" rx="16" fill="${ad ? '#3a2a12' : '#203a5a'}"/>
  <text x="640" y="350" fill="#fff" font-size="54" font-family="sans-serif" text-anchor="middle">${ad ? 'AD — 광고' : '영도 영상 재생 중'}</text>
  ${ad ? '<rect x="900" y="540" width="200" height="60" rx="6" fill="#000a" stroke="#fff"/><text x="1000" y="580" fill="#fff" font-size="24" font-family="sans-serif" text-anchor="middle">광고 건너뛰기 ▶</text>' : ''}
  <text x="640" y="420" fill="#9bd" font-size="28" font-family="sans-serif" text-anchor="middle">후원자: 테스트 · 1,000 치즈</text>`
    : '<text x="640" y="370" fill="#555" font-size="32" font-family="sans-serif" text-anchor="middle">(대기 중 — 영도 없음)</text>'}
  <text x="20" y="700" fill="#888" font-size="20" font-family="monospace">mock t=${sec}s</text>
</svg>`;
}

// ---------------- fake DevTools (the 영도 browser source) ----------------
const cdpHttp = http.createServer((req, res) => {
  if (req.url.startsWith('/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'dock1', type: 'page', title: 'Chat dock', url: 'https://chzzk.naver.com/live/abc/chat', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/dock1' },
      { id: 'yd1', type: 'page', title: '영도', url: inputs.get(DONATION).settings.url, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/yd1' },
      { id: 'al1', type: 'page', title: 'Alerts', url: 'https://example.com/alerts', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/al1' },
      ...(process.env.MOCK_NO_REMOTE ? [] : [{ id: 'rc1', type: 'page', title: '호시아의 치지직 스튜디오', url: 'https://studio.chzzk.naver.com/0e0fbee493aba6660d50a0ca215ebe10/remotecontrol', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/rc1' }]),
    ]));
  } else {
    res.writeHead(404).end();
  }
});
const cdpWss = new WebSocketServer({ server: cdpHttp });
// fake 치지직 리모컨 dock: buttons "TTS 넘기기" and "알림 정지" ⇄ "알림 재개"
let rcPaused = false;
let videoStopped = false;
setInterval(() => { if (!donationLoud()) videoStopped = false; }, 500);
function remoteDock(ws) {
  ws.on('message', (raw) => {
    const { id, method, params } = JSON.parse(raw);
    let value = null;
    if (method === 'Runtime.evaluate') {
      const buttons = ['전체', '영상 후원', '미션 후원', '파티', 'TTS 넘기기', rcPaused ? '알림 재개' : '알림 정지'];
      if (params.expression.includes('isGreen')) {
        const playing = donationLoud() && !videoStopped;
        if (playing && params.expression.includes('CLICK = true')) { videoStopped = true; log('리모컨: pressed ■ (stop 영도)'); }
        value = playing ? { via: 'green', info: '라이너류트 님이 1,000 치즈를 후원하였습니다. 너 혼자 거기 살아' } : null;
      } else if (params.expression.includes('b.click()')) {
        const pattern = new RegExp(JSON.parse(/new RegExp\((".*?")\)/.exec(params.expression)[1]));
        const hit = buttons.find((b) => pattern.test(b));
        if (hit === '알림 정지' || hit === '알림 재개') rcPaused = !rcPaused;
        if (hit) log(`리모컨: pressed "${hit}"`);
        value = hit || null;
      } else {
        value = { buttons, needsLogin: !!process.env.MOCK_REMOTE_LOGIN, title: '리모컨' };
      }
    }
    ws.send(JSON.stringify({ id, result: { result: { type: 'object', value } } }));
  });
}

cdpWss.on('connection', (ws, req) => {
  log('DevTools client attached to', req.url);
  if (req.url.endsWith('/rc1')) return remoteDock(ws);
  ws.on('close', () => clearInterval(ws._cast));
  ws.on('message', (raw) => {
    const { id, method, params, sessionId } = JSON.parse(raw);
    let result = {};
    if (method === 'Target.setAutoAttach') {
      setTimeout(() => ws.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'yt-iframe', targetInfo: { type: 'iframe', targetId: 'yt-frame', url: 'https://www.youtube.com/embed/x' } } })), 50);
    }
    if (method === 'Page.startScreencast') {
      if (NO_SCREENCAST) {
        ws.send(JSON.stringify({ id, error: { code: -32000, message: 'Screencast not supported (mock)' } }));
        return;
      }
      log('screencast started', JSON.stringify(params));
      let last = null;
      ws._cast = setInterval(() => {
        if (!FRAMES_DIR) return;
        const jpg = currentJpeg();
        if (jpg === last) return; // like Chrome: no repaint, no frame
        last = jpg;
        ws.send(JSON.stringify({ method: 'Page.screencastFrame', params: { data: jpg.toString('base64'), sessionId: 1, metadata: {} } }));
      }, 33);
    }
    if (method === 'Page.stopScreencast') { clearInterval(ws._cast); log('screencast stopped'); }
    if (method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main' }, childFrames: [] } };
    if (method === 'Page.createIsolatedWorld') result = { executionContextId: 1 };
    if (method === 'Runtime.evaluate') {
      // The YouTube player is an out-of-process iframe at (140,80), 1000x560 on the page.
      // Its skip button sits at (760,460) 200x60 inside it = (900..1100, 540..600) on the page.
      const inYt = sessionId === 'yt-iframe' && adShowing() && /getBoundingClientRect/.test(params.expression);
      result = { result: inYt ? { type: 'object', value: { sel: '.ytp-skip-ad-button', x: 760, y: 460, w: 200, h: 60, vw: 1000, vh: 560 } } : { type: 'object', value: null } };
    }
    if (method === 'DOM.getFrameOwner') result = params.frameId === 'yt-frame' ? { backendNodeId: 5 } : (ws.send(JSON.stringify({ id, error: { message: 'no owner' } })), null);
    if (result === null) return;
    if (method === 'DOM.getBoxModel') result = { model: { content: [140, 80, 1140, 80, 1140, 640, 140, 640], width: 1000, height: 560 } };
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') log(`click at ${Math.round(params.x)},${Math.round(params.y)}`);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && adShowing() && params.x > 900 && params.x < 1100 && params.y > 540 && params.y < 600) {
      adSkipped = true;
      log('ad skipped via click-through');
    }
    ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
  });
});
cdpHttp.listen(9222, '127.0.0.1');

log(`mock OBS on ws://127.0.0.1:4455${PASSWORD ? ' (password set)' : ''}, DevTools on http://127.0.0.1:9222`);

// ---------------- fake Chzzk (live info + chat) on :9333 ----------------
// Point the helper at it with chzzk.apiBase / gameApiBase = http://127.0.0.1:9333
// and chzzk.chatServer = ws://127.0.0.1:9333/chat
const CHAT_CID = 'N1mockChat';
const names = ['치즈냥', '별빛여행자', 'pogchamp99', '호시아팬1호', '야근하는개발자', '새벽감성', 'Gura_KR', '라면조아'];
const lines = ['ㅋㅋㅋㅋㅋ', '안녕하세요!', '오늘 방송 몇시까지 해요?', '{:d_33:} {:d_33:}', 'BGM 좋다', '영도 개웃기네', '이거 무슨 게임이에요?', 'ㄹㅇㅋㅋ', '하이하이', '목소리 좋아요 {:d_2:}'];
const EMOJIS = { d_33: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#ffd34d"/><circle cx="7.5" cy="9" r="1.6"/><circle cx="14.5" cy="9" r="1.6"/><path d="M6 13q5 5 10 0" stroke="#000" fill="none" stroke-width="1.6"/></svg>').toString('base64'),
  d_2: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><path d="M11 19 3 11a4.5 4.5 0 0 1 8-5 4.5 4.5 0 0 1 8 5z" fill="#ff5c8a"/></svg>').toString('base64') };
const recent = [];
let viewers = 37;
const openDate = new Date(Date.now() - 83 * 60000 + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);

function fakeMsg(kind) {
  const nick = names[Math.floor(Math.random() * names.length)];
  const role = nick === '호시아팬1호' ? 'streaming_chat_manager' : 'common_user';
  const base = { uid: 'u_' + nick, msgTime: Date.now(), profile: JSON.stringify({ nickname: nick, userRoleCode: role, activityBadges: [] }) };
  if (kind === 'donation') {
    const video = Math.random() < 0.4;
    const amt = video ? 1000 : [1000, 1480, 2000, 5000, 10000][Math.floor(Math.random() * 5)];
    const msg = video ? '영도 보냅니다~' : ['방송 재밌어요!', '호시아 화이팅 {:d_2:}', 'BGM 제목 뭐예요?', '오늘도 고생 많으셨어요'][Math.floor(Math.random() * 4)];
    return { ...base, msgTypeCode: 10, msg, extras: JSON.stringify({ payAmount: amt, donationType: video ? 'VIDEO' : 'CHAT', emojis: EMOJIS }) };
  }
  if (kind === 'sub') return { ...base, msgTypeCode: 11, msg: '구독 3개월 됐어요!', extras: JSON.stringify({ month: 3, emojis: {} }) };
  return { ...base, msgTypeCode: 1, msg: lines[Math.floor(Math.random() * lines.length)], extras: JSON.stringify({ emojis: EMOJIS }) };
}
for (let i = 0; i < 12; i++) {
  const m = fakeMsg('chat');
  m.msgTime -= (12 - i) * 7000;
  recent.push(m);
}

const chzzkHttp = http.createServer((req, res) => {
  // fake 위플챗 overlay page (MOCK_CHAT_PAGE=1 points the 위플챗 source here)
  if (req.url.startsWith('/overlay')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(process.env.MOCK_CHAT_PAGE === 'deny' ? { 'X-Frame-Options': 'DENY' } : {}) });
    return res.end(`<!doctype html><body style="margin:0;background:transparent;font:16px sans-serif;color:#fff;display:flex;flex-direction:column;justify-content:flex-end;height:100vh">
      <div id=l style="padding:8px"></div><script>let n=0;setInterval(()=>{const d=document.createElement('div');d.textContent='위플챗 메시지 '+(++n);d.style.cssText='background:#0008;margin:4px 0;padding:6px 10px;border-radius:8px';l.append(d);if(l.children.length>40)l.firstChild.remove()},700)</script>`);
  }
  const send = (content, code = 200) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, message: null, content })); };
  if (/\/service\/v3\/channels\/[0-9a-f]{32}\/live-detail/.test(req.url)) {
    viewers = Math.max(5, viewers + Math.round((Math.random() - 0.45) * 4));
    return send({ liveTitle: '[테스트] 아머드코어 6 하면서 수다', status: 'OPEN', concurrentUserCount: viewers, accumulateCount: 412, openDate, liveCategoryValue: 'ARMORED CORE VI', chatChannelId: CHAT_CID, channel: { channelName: '호시아' } });
  }
  if (req.url.startsWith('/nng_main/v1/chats/access-token')) return send({ accessToken: 'mock-token', extraToken: 'x' });
  res.writeHead(404).end();
});
const chatWss = new WebSocketServer({ server: chzzkHttp, path: '/chat' });
chatWss.on('connection', (ws) => {
  log('chat client connected');
  const timers = [];
  const push = (cmd, bdy) => ws.readyState === 1 && ws.send(JSON.stringify({ ver: '2', cmd, svcid: 'game', cid: CHAT_CID, bdy }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.cmd === 100) {
      log('chat CONNECT with token', m.bdy.accTkn, 'auth', m.bdy.auth);
      push(10100, { sid: 'mock-sid', uuid: 'x' });
      timers.push(setInterval(() => { const x = fakeMsg('chat'); recent.push(x); push(93101, [x]); }, 1800));
      timers.push(setInterval(() => push(93102, [fakeMsg('donation')]), 2500));
      timers.push(setTimeout(() => push(93102, [fakeMsg('sub')]), 4000));
      timers.push(setTimeout(() => push(0, null), 3000));
      timers.push(setTimeout(() => { const v = recent[recent.length - 1]; push(94008, { messageTime: v.msgTime, userId: v.uid }); log('blinded one message'); }, 6000));
    }
    if (m.cmd === 5101) {
      push(15101, { messageList: recent.slice(-m.bdy.recentMessageCount).map((r) => ({ content: r.msg, messageTime: r.msgTime, userId: r.uid, profile: r.profile, extras: r.extras, messageTypeCode: r.msgTypeCode })) });
    }
    if (m.cmd === 10000) log('chat got PONG');
  });
  ws.on('close', () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); }));
});
chzzkHttp.listen(9333, '127.0.0.1');

function fakeOverlay() {
  const items = recent.slice(-9).map((r, i) => {
    const p = JSON.parse(r.profile);
    return `<text x="16" y="${470 + i * 32}" font-size="20" font-family="sans-serif" fill="#fff"><tspan fill="#ff9ec0" font-weight="bold">${p.nickname}</tspan> ${r.msg.replace(/\{:[^}]+:\}/g, '😊')}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="760" viewBox="0 0 420 760"><rect width="420" height="760" fill="#0000"/><rect x="6" y="440" width="408" height="310" rx="12" fill="#000a"/>${items}</svg>`;
}

function fakeProgram() {
  const t = ((Date.now() - t0) / 1000);
  const x = 200 + Math.round(Math.sin(t) * 600);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#20304a"/><text x="60" y="110" fill="#fff" font-size="72" font-family="sans-serif">방송 화면 (Main scene)</text><circle cx="${960 + x - 200}" cy="600" r="90" fill="#ffd34d"/><text x="60" y="1040" fill="#9bd" font-size="36" font-family="monospace">t=${t.toFixed(1)}s</text></svg>`;
}
