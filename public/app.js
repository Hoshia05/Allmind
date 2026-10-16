// Stream Desk control page. Talks only to the helper on the stream PC.
const $ = (id) => document.getElementById(id);
let S = null; // latest state from the helper
let TRACKS = []; // the setlist (sent only when it changes)

// ---------------- helpers ----------------
async function api(path, body = {}) {
  try {
    const res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) toast(data.error || 'Request failed', true);
    return data;
  } catch {
    toast('Stream Desk helper is not reachable', true);
    return { ok: false };
  }
}

function toast(text, bad = false, long = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), bad || long ? 8000 : 2500);
}

function fmt(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// short vibration on touch phones that support it (Android), if turned on
function buzz() {
  try { if (pref.get('vibrate', true) && navigator.vibrate) navigator.vibrate(12); } catch {}
}

const pref = {
  get(k, d) { try { const v = localStorage.getItem('sd.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sd.' + k, JSON.stringify(v)); } catch {} },
};

// ---------------- live state ----------------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { S = JSON.parse(e.data); S.bgm.tracks = TRACKS; render(); });
  // the setlist comes separately, only when it changes
  es.addEventListener('tracks', (e) => { TRACKS = JSON.parse(e.data); if (S) { S.bgm.tracks = TRACKS; lastTracksKey = ''; renderBgm(); } });
  es.addEventListener('health', (e) => renderHealth(JSON.parse(e.data)));
  es.addEventListener('level', (e) => renderLevel(JSON.parse(e.data)));
  es.addEventListener('toast', (e) => { const d = JSON.parse(e.data); toast(d.text, false, d.long); });
  es.addEventListener('chat-history', (e) => chatReset(JSON.parse(e.data)));
  es.addEventListener('fps', (e) => renderFps(JSON.parse(e.data)));
  es.addEventListener('chat', (e) => chatAdd(JSON.parse(e.data)));
  es.addEventListener('chat-update', (e) => chatUpdate(JSON.parse(e.data)));
  es.addEventListener('donations-history', (e) => donReset(JSON.parse(e.data)));
  es.addEventListener('donations', (e) => donAdd(JSON.parse(e.data)));
  es.addEventListener('donation-read', (e) => donRead(JSON.parse(e.data)));
  es.onerror = () => {
    $('chips').innerHTML = '<span class="chip bad">Helper offline — retrying</span>';
  };
}

// ---------------- rendering ----------------
function chip(label, cls, title = '') {
  return `<span class="chip ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

function render() {
  if (!S) return;
  const { obs, bgm, donation, interact } = S;

  // status chips
  const chipsHtml = [
    chip(obs.connected ? 'OBS 연결됨' : 'OBS 연결 안 됨', obs.connected ? 'ok' : 'bad', obs.error || obs.url),
    chip('영도 소스', !obs.connected ? '' : donation.sourceOk && !donation.error ? 'ok' : 'bad', donation.error || donation.sourceName),
    chip('클릭 전달', !interact.enabled ? '' : interact.connected ? 'ok' : 'warn', interact.error || interact.target?.url || ''),
    chip('BGM 소스', !obs.connected ? '' : bgm.sourceOk ? 'ok' : 'bad', bgm.sourceError || bgm.sourceName),
    chip('치지직', !S.chzzk.channelId ? '' : S.chzzk.error ? 'bad' : S.chzzk.chat.state === 'connected' ? 'ok' : 'warn', S.chzzk.error || S.chzzk.chat.error || ''),
  ].join('');
  if ($('chips').innerHTML !== chipsHtml) $('chips').innerHTML = chipsHtml;

  // links (only rebuild if changed)
  const linksHtml = (S.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener"${l.popup ? ' data-popup="1"' : ''}>${esc(l.name)}</a>`).join('');
  if ($('links').innerHTML !== linksHtml) $('links').innerHTML = linksHtml;

  renderBanners();
  renderViewerState();
  renderBgm();
  renderLive();
  renderChatState();
  renderStudio();
  renderMarks();
  window.syncChatPage?.();
  if (typeof followDonation === 'function') followDonation();
  window.syncAlertMirror?.();
}

function renderBanners() {
  const { obs, bgm, donation, interact } = S;
  const out = [];
  if (!obs.connected) {
    out.push(`<div class="banner bad">OBS에 연결할 수 없음 — ${esc(obs.error || obs.url)}. OBS에서 도구 → WebSocket 서버 설정을 켜고, 비밀번호를 방송 PC의 Stream Desk 설정에 넣어 주세요.</div>`);
  } else {
    if (bgm.sourceError) {
      const canCreate = bgm.sourceError.startsWith('No Media Source');
      out.push(`<div class="banner">${esc(bgm.sourceError)}.${canCreate ? ' <button class="btn" data-act="create-bgm">현재 장면에 만들기</button>' : ''}</div>`);
    }
    if (donation.error) out.push(`<div class="banner">${esc(donation.error)}</div>`);
  }
  if (S.chzzk.error) out.push(`<div class="banner">${esc(S.chzzk.error)}</div>`);
  if (bgm.folderError) out.push(`<div class="banner">${esc(bgm.folderError)}</div>`);
  if (interact.enabled && !interact.connected && interact.error) {
    let html = `<div class="banner">클릭 전달: ${esc(interact.error)}`;
    if (interact.candidates?.length) {
      html += ' ' + interact.candidates
        .map((c) => `<button class="btn" data-act="pick-target" data-url="${esc(c.url)}" title="${esc(c.url)}">${esc(shortUrl(c.url))}</button>`)
        .join(' ');
    }
    out.push(html + '</div>');
  }
  const html = out.join('');
  if ($('banners').innerHTML !== html) $('banners').innerHTML = html;
}

function shortUrl(u) {
  try { const x = new URL(u); return (x.host + x.pathname).slice(0, 40); } catch { return u.slice(0, 40); }
}

function renderViewerState() {
  const { interact } = S;
  $('autoSkip').checked = !!interact.autoSkip;
  if (document.activeElement !== $('qualitySel')) $('qualitySel').value = (mainTab === 'program' ? S.program?.quality : S.donation.quality) || 'balanced';
  renderRemote();
  $('autoSkip').disabled = !interact.enabled;
  $('skipBtn').disabled = !interact.connected;
  $('stage').classList.toggle('interactive', $('clickThrough').checked && interact.connected);
}

let lastTracksKey = '';
function renderBgm() {
  const b = S.bgm;
  const cur = b.tracks.find((t) => t.id === b.currentId);
  $('bgmSource').textContent = b.sourceName;
  $('nowTitle').textContent = cur ? cur.title : '—';
  $('nowSub').textContent = cur?.folder || '';
  const playing = !!b.media.playing;
  $('playBtn').textContent = playing ? '⏸' : '▶';
  $('playBtn').classList.toggle('loading', !!b.media.loading);
  // Honest status line under the title
  let warn = '';
  if (b.sourceOk && playing && !b.sourceActive) warn = '⚠ BGM 소스가 지금 장면에 없어서 소리가 안 나요 — 모든 장면에 추가해 주세요';
  else if (b.sourceOk && b.loadedOutside) warn = 'OBS에서 셋리스트 밖의 파일을 재생 중';
  else if (b.autoPause.active && b.autoPause.heldPaused) warn = '영도 재생 중이라 잠시 멈춤';
  $('bgmWarn').textContent = warn;
  $('bgmWarn').className = 'bgm-warn small' + (warn.startsWith('⚠') ? ' bad' : '');
  $('progressFill').style.width = b.media.duration ? `${(100 * b.media.cursor) / b.media.duration}%` : '0';
  $('tCur').textContent = fmt(b.media.cursor);
  $('tDur').textContent = fmt(b.media.duration);
  if (document.activeElement !== $('vol')) $('vol').value = b.volumeDb;
  $('volVal').textContent = `${b.volumeDb} dB`;

  for (const btn of $('playMode').children) btn.classList.toggle('on', btn.dataset.mode === b.playMode);

  const ap = b.autoPause;
  $('apEnabled').checked = ap.enabled;
  for (const btn of $('apMode').children) btn.classList.toggle('on', btn.dataset.mode === ap.mode);
  $('thrVal').textContent = `${ap.thresholdDb} dB`;
  $('meterThresh').style.left = `${dbToPct(ap.thresholdDb)}%`;
  if (document.activeElement !== $('resumeAfter')) $('resumeAfter').value = ap.resumeAfterMs;
  $('resumeVal').textContent = `${(ap.resumeAfterMs / 1000).toFixed(1)}s`;
  const intro = ap.introHoldMs ?? 10000;
  if (document.activeElement !== $('introHold')) $('introHold').value = intro;
  $('introVal').textContent = `${(intro / 1000).toFixed(0)}s`;
  document.querySelector('.auto').classList.toggle('active', ap.active);
  $('apState').textContent = !ap.enabled ? '' : ap.active ? (ap.mode === 'duck' ? '영도 재생 중 · 볼륨 낮춤' : '영도 재생 중 · 일시정지') : '대기 중';

  $('count').textContent = `(${b.tracks.length})`;
  const key = b.tracks.map((t) => t.id).join('|') + '#' + b.currentId + '#' + $('search').value;
  if (key !== lastTracksKey) {
    lastTracksKey = key;
    renderTracks();
  }
}

function renderTracks() {
  const b = S.bgm;
  const q = $('search').value.trim().toLowerCase();
  const list = $('tracks');
  if (!b.tracks.length) {
    list.innerHTML = `<li class="empty">${b.folderError ? '음악 폴더를 찾을 수 없어요' : '폴더에 음악 파일이 없어요'}</li>`;
    return;
  }
  list.innerHTML = b.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !q || t.title.toLowerCase().includes(q) || t.folder.toLowerCase().includes(q))
    .map(({ t, i }) => `
      <li data-id="${esc(t.id)}" draggable="${q ? 'false' : 'true'}" class="${t.id === b.currentId ? 'current' : ''}">
        <span class="grip" title="Drag to reorder">⋮⋮</span>
        <span class="num">${i + 1}</span>
        <span class="t" title="${esc(t.id)}">${esc(t.title)}</span>
        ${t.folder ? `<span class="f">${esc(t.folder)}</span>` : ''}
      </li>`)
    .join('');
}

// meter scale: -60 dB .. 0 dB
const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
const pctToDb = (p) => Math.round((p / 100) * 60 - 60);

function renderLevel({ db, mic }) {
  if (mic !== undefined) {
    // mic meter: -60..0 dB; turns orange near clipping
    const pct = dbToPct(mic);
    $('micFill').style.width = `${pct}%`;
    $('micFill').style.background = mic > -6 ? 'var(--warn)' : '';
  }
  $('meterFill').style.width = `${dbToPct(db)}%`;
  $('meter').classList.toggle('hot', S && db > S.bgm.autoPause.thresholdDb);
}

// ---------------- OBS source mirrors (영도 + 위플챗) ----------------
// The helper sends a continuous stream of images. Instead of letting <img>
// show it (Chrome's live-image mode didn't draw OBS's frames for everyone),
// we read the stream ourselves, decode each frame and draw it on a canvas.
// The stream only runs while the picture is actually on screen.
const enc = new TextEncoder();
const CT = enc.encode('Content-Type:');
function indexOf(buf, pat, from = 0) {
  outer: for (let i = from; i <= buf.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}
const CRLF2 = enc.encode('\r\n\r\n');

function makeMirror({ img, empty, src, active, missing }) {
  const m = { on: false, frames: 0, error: '' };
  const canvas = $(img);
  const ctx = canvas.getContext('2d');
  let ctrl = null;
  let decoding = false;

  async function draw(bytes, type) {
    if (decoding) return; // still busy with the previous one: skip, stay live
    decoding = true;
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.fillStyle = '#000'; // transparent parts of the page show as black, like on stream
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      m.frames++;
      m.error = '';
      $(empty).style.display = 'none';
    } catch (e) {
      m.error = `프레임을 그리지 못함 (${type}, ${bytes.length} bytes)`;
      console.warn('[mirror]', m.error, e);
    } finally {
      decoding = false;
    }
  }

  // Two ways to receive frames:
  //  'stream' — one long response carrying every frame (lightest);
  //  'poll'   — ask for one frame at a time. Fallback for browsers that
  //             can't read the stream (seen on iPad Safari).
  m.mode = 'stream';
  async function runStream(myCtrl) {
    const start = m.frames;
    // no picture within 4 s while OBS is up → this browser can't read the stream
    const watchdog = setTimeout(() => {
      if (m.frames === start && S?.obs.connected && ctrl === myCtrl) {
        console.warn('[mirror]', src, 'stream gave no frames — switching to one-frame-at-a-time');
        m.mode = 'poll';
        myCtrl.abort();
        run();
      }
    }, 4000);
    try {
      const cap = pref.get('saver', false) ? '&maxFps=15' : '';
      const res = await fetch(`/api/stream?src=${src}&raw=1${cap}&t=${Date.now()}`, { signal: myCtrl.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
        // pull out every complete part: headers, blank line, Content-Length bytes
        while (true) {
          const h = indexOf(buf, CT);
          if (h < 0) { if (buf.length > 64) buf = buf.slice(buf.length - 64); break; }
          const he = indexOf(buf, CRLF2, h);
          if (he < 0) break;
          const head = new TextDecoder().decode(buf.subarray(h, he));
          const len = Number(/Content-Length:\s*(\d+)/i.exec(head)?.[1]);
          const type = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1].trim() || 'image/jpeg';
          const start = he + 4;
          if (!len || buf.length < start + len) break;
          const body = buf.slice(start, start + len);
          buf = buf.slice(start + len);
          draw(body, type);
        }
      }
    } catch (e) {
      if (myCtrl.signal.aborted) return 'aborted';
      // failed before a single frame: try the other way right away
      if (m.frames === start && S?.obs.connected) { m.mode = 'poll'; clearTimeout(watchdog); return 'switch'; }
    } finally {
      clearTimeout(watchdog);
    }
    return 'ended';
  }

  async function runPoll(myCtrl) {
    let seq = 0, fails = 0;
    while (!myCtrl.signal.aborted) {
      try {
        const cap = pref.get('saver', false) ? '&maxFps=15' : '';
        const r = await fetch(`/api/frame?src=${src}&after=${seq}${cap}&t=${Date.now()}`, { signal: myCtrl.signal, cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fails = 0;
        seq = Number(r.headers.get('X-Seq')) || seq;
        await draw(new Uint8Array(await r.arrayBuffer()), r.headers.get('Content-Type') || 'image/jpeg');
      } catch {
        if (myCtrl.signal.aborted) return 'aborted';
        if (++fails >= 3) return 'ended';
        await new Promise((ok) => setTimeout(ok, 700));
      }
    }
    return 'aborted';
  }

  async function run() {
    ctrl = new AbortController();
    const myCtrl = ctrl;
    let how = m.mode === 'poll' ? await runPoll(myCtrl) : await runStream(myCtrl);
    if (how === 'switch' && ctrl === myCtrl && m.on) how = await runPoll(myCtrl);
    if (how === 'aborted') return;
    // ended (helper restarted, source missing…): show why and retry
    if (m.on && ctrl === myCtrl) {
      $(empty).textContent = S && !S.obs.connected ? 'OBS 연결 대기 중…' : missing;
      $(empty).style.display = '';
      m.on = false;
      setTimeout(m.sync, 2000);
    }
  }

  m.sync = () => {
    const want = !document.hidden && active();
    if (want && !m.on) {
      m.on = true;
      run();
    } else if (!want && m.on) {
      m.on = false;
      ctrl?.abort(); // closes the stream
    }
  };
  // reconnect with new settings (데이터 절약 on/off)
  m.restart = () => {
    if (m.on) { m.on = false; ctrl?.abort(); }
    m.sync();
  };
  return m;
}
// is this panel on screen right now? (hidden column, phone tab bar, …)
const shown = (el) => !!el && el.offsetParent !== null;
// Main panel: 방송 화면 (OBS program output) or 영도. Only the visible one is captured.
let mainTab = pref.get('mainTab', 'program');
const donationLoop = makeMirror({ img: 'frame', empty: 'stageEmpty', src: 'donation', active: () => mainTab === 'donation', missing: '영도 소스를 찾을 수 없음' });
const programLoop = makeMirror({ img: 'programFrame', empty: 'programEmpty', src: 'program', active: () => mainTab === 'program', missing: 'OBS 방송 화면을 가져올 수 없음' });
const chatMirrorLoop = makeMirror({
  img: 'chatFrame', empty: 'chatMirrorEmpty', src: 'chat', missing: '위플챗 소스를 찾을 수 없음',
  active: () => chatTab === 'mirror' && shown($('chatPanel')) && !chatPageMode(),
});
donationLoop.kick = donationLoop.sync;
chatMirrorLoop.kick = () => chatMirrorLoop.sync();
document.addEventListener('visibilitychange', () => { donationLoop.sync(); programLoop.sync(); chatMirrorLoop.sync(); window.syncAlertMirror?.(); });

// small corner badge: how the picture is arriving
function renderFps({ donation, chat, program }) {
  if (mainTab === 'program') {
    if (programLoop.on && programLoop.frames > 0) $('programEmpty').style.display = 'none';
    const b = $('stageBadge');
    if (programLoop.error) { b.textContent = '⚠ ' + programLoop.error; return; }
    const scene = S?.program?.scene ? ` · ${S.program.scene}` : '';
    b.textContent = program && programLoop.on ? `방송 화면${scene} · ${program.fps} fps${program.limited ? ' · OBS 부하 보호 중' : ''}` : '';
    return;
  }
  // Frames are arriving: drop the "waiting" overlay even if the browser
  // never reports the image as loaded (it doesn't always for live streams).
  if (donationLoop.on && donationLoop.frames > 0) $('stageEmpty').style.display = 'none';
  if (chatMirrorLoop.on && chatMirrorLoop.frames > 0) $('chatMirrorEmpty').style.display = 'none';
  const b = $('stageBadge');
  if (!donationLoop.on || donation.mode === 'idle') { b.textContent = ''; return; }
  if (donationLoop.error) { b.textContent = '⚠ ' + donationLoop.error; return; }
  const how = donation.mode === 'screencast' ? '실시간' : donation.mode === 'obs-idle' ? '정지 화면' : 'OBS';
  b.textContent = (donation.fps ? `${how} · ${donation.fps} fps` : how) + (donation.limited ? ' · OBS 부하 보호 중' : '');
}


function stagePoint(ev) {
  const r = $('frame').getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width;
  const y = (ev.clientY - r.top) / r.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y, px: ev.clientX, py: ev.clientY } : null;
}
function canInteract() {
  if (mainTab !== 'donation') return false;
  return $('clickThrough').checked && S?.interact.connected;
}

let swipedAt = 0;
$('frame').addEventListener('click', (ev) => {
  if (!canInteract()) return;
  if (Date.now() - swipedAt < 400) return; // that was a swipe, not a tap
  const p = stagePoint(ev);
  if (!p) return;
  const sr = $('stage').getBoundingClientRect();
  const dot = document.createElement('div');
  dot.className = 'ripple';
  dot.style.left = `${p.px - sr.left}px`;
  dot.style.top = `${p.py - sr.top}px`;
  $('stage').append(dot);
  setTimeout(() => dot.remove(), 600);
  api('donation/click', { x: p.x, y: p.y });
});

let hoverAt = 0;
$('frame').addEventListener('mousemove', (ev) => {
  if (!canInteract() || Date.now() - hoverAt < 150) return;
  const p = stagePoint(ev);
  if (!p) return;
  hoverAt = Date.now();
  fetch('/api/donation/hover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: p.x, y: p.y }) }).catch(() => {});
});

let wheelAt = 0;
$('stage').addEventListener('wheel', (ev) => {
  if (!canInteract()) return;
  ev.preventDefault();
  if (Date.now() - wheelAt < 80) return;
  wheelAt = Date.now();
  const p = stagePoint(ev);
  if (p) api('donation/wheel', { x: p.x, y: p.y, deltaY: ev.deltaY });
}, { passive: false });

// Touch: a swipe on the 영도 scrolls the page inside OBS (like the mouse wheel).
(() => {
  let sw = null;
  const frame = $('frame');
  frame.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' || !canInteract()) return;
    sw = { id: ev.pointerId, y0: ev.clientY, last: ev.clientY, moved: false };
  });
  frame.addEventListener('pointermove', (ev) => {
    if (!sw || ev.pointerId !== sw.id) return;
    if (!sw.moved && Math.abs(ev.clientY - sw.y0) < 12) return;
    sw.moved = true;
    const dy = sw.last - ev.clientY;
    if (Math.abs(dy) < 6 || Date.now() - wheelAt < 60) return;
    wheelAt = Date.now();
    sw.last = ev.clientY;
    const p = stagePoint(ev);
    if (p) fetch('/api/donation/wheel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: p.x, y: p.y, deltaY: dy * 3 }) }).catch(() => {});
  });
  const end = (ev) => {
    if (!sw || ev.pointerId !== sw.id) return;
    if (sw.moved) swipedAt = Date.now();
    sw = null;
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);
})();

$('clickThrough').checked = pref.get('clickThrough', true);
$('clickThrough').addEventListener('change', () => { pref.set('clickThrough', $('clickThrough').checked); render(); });
$('autoSkip').addEventListener('change', () => api('donation/autoskip', { on: $('autoSkip').checked }));
$('qualitySel').addEventListener('change', async () => {
  const q = $('qualitySel').value;
  // the menu sets the quality of whichever picture is showing
  const r = await api(mainTab === 'program' ? 'program/quality' : 'donation/quality', { quality: q });
  if (r.ok && q === 'lossless') toast('무손실은 선명하지만 fps가 낮아질 수 있어요');
  $('qualitySel').blur();
});

// 넘기기 / 알림 정지: pressed on the real 치지직 리모컨 (an OBS browser dock).
function renderRemote() {
  const r = S.remote;
  const ok = r.connected && !r.needsLogin;
  for (const id of ['rcSkip', 'rcPause']) $(id).classList.toggle('off', !ok);
  // 영도 정지 only lights up while a 영도 is actually playing on the 리모컨
  $('rcStop').classList.toggle('off', !(ok && r.videoPlaying));
  $('rcStop').classList.toggle('live', ok && r.videoPlaying);
  $('rcSkip').textContent = r.skipLabel || '넘기기';
  $('rcPause').textContent = r.pauseLabel || '알림 정지';
  // when alerts are paused, the 리모컨's button usually turns into "알림 재개"
  $('rcPause').classList.toggle('paused', /재개|시작|켜기/.test(r.pauseLabel || ''));
  const why = !r.connected ? (r.error || '치지직 리모컨에 연결되지 않음') : r.needsLogin ? 'OBS의 리모컨 독에서 네이버에 로그인해 주세요' : '';
  $('rcSkip').title = why || '치지직 리모컨의 넘기기 버튼을 눌러요';
  $('rcStop').title = why || (r.videoPlaying ? `재생 중: ${r.videoInfo || '영도'} — 눌러서 정지` : '지금 재생 중인 영도가 없어요');
  $('rcPause').title = why || '치지직 리모컨의 알림 정지/재개 버튼을 눌러요';
}
async function remotePress(path) {
  buzz();
  const r = S.remote;
  if (!r.connected) return toast(`${r.error || '치지직 리모컨에 연결되지 않음'} — 방송 PC의 Stream Desk 창에서 설정 방법을 확인하세요`, true);
  if (r.needsLogin) return toast('OBS의 치지직 리모컨 독에서 네이버에 로그인해 주세요', true);
  const res = await api(path);
  if (res.ok) toast(`리모컨: "${res.pressed}" 눌렀어요`);
}
$('rcSkip').addEventListener('click', () => remotePress('remote/skip'));
$('rcStop').addEventListener('click', () => {
  if (S.remote.connected && !S.remote.needsLogin && !S.remote.videoPlaying) return toast('지금 재생 중인 영도가 없어요');
  remotePress('remote/stop');
});
$('rcPause').addEventListener('click', () => remotePress('remote/pause'));
$('skipBtn').addEventListener('click', async () => {
  const r = await api('donation/skip');
  if (r.ok && !r.skipped) toast('스킵 버튼이 아직 없어요');
});
$('refreshBtn').addEventListener('click', async () => {
  if (confirm('OBS의 영도 소스를 새로고침할까요? 재생 중인 영도가 끊길 수 있어요.')) {
    const r = await api('donation/refresh');
    if (r.ok) toast('영도 소스를 새로고침했어요');
  }
});
function setPseudoFs(on) {
  $('stage').classList.toggle('pseudo-fs', on);
  $('fsExit').hidden = !on;
}
$('fullBtn').addEventListener('click', () => {
  const st = $('stage');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  if (st.classList.contains('pseudo-fs')) return setPseudoFs(false);
  const req = st.requestFullscreen || st.webkitRequestFullscreen;
  if (req) {
    Promise.resolve(req.call(st)).catch(() => setPseudoFs(true));
  } else {
    setPseudoFs(true);
  }
});
$('fsExit').addEventListener('click', () => setPseudoFs(false));

// ---------------- BGM controls ----------------
$('playBtn').addEventListener('click', () => { buzz(); api('bgm/toggle'); });
$('prevBtn').addEventListener('click', () => { buzz(); api('bgm/prev'); });
$('nextBtn').addEventListener('click', () => { buzz(); api('bgm/next'); });
$('vol').addEventListener('input', () => { $('volVal').textContent = `${$('vol').value} dB`; });
$('vol').addEventListener('change', () => api('bgm/volume', { db: Number($('vol').value) }));
$('progress').addEventListener('click', (ev) => {
  if (!S?.bgm.media.duration) return;
  const r = $('progress').getBoundingClientRect();
  api('bgm/seek', { ms: ((ev.clientX - r.left) / r.width) * S.bgm.media.duration });
});
$('playMode').addEventListener('click', (ev) => {
  const m = ev.target.dataset?.mode;
  if (m) api('bgm/mode', { mode: m });
});
$('rescanBtn').addEventListener('click', async () => {
  const r = await api('bgm/rescan');
  if (r.ok) toast('음악 폴더를 다시 읽었어요');
});
$('search').addEventListener('input', renderTracks);

$('tracks').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (li && !ev.target.classList.contains('grip')) api('bgm/select', { id: li.dataset.id });
});

// drag to reorder
let dragId = null;
$('tracks').addEventListener('dragstart', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  dragId = li.dataset.id;
  ev.dataTransfer.effectAllowed = 'move';
});
$('tracks').addEventListener('dragover', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (!dragId || !li) return;
  ev.preventDefault();
  document.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  li.classList.add('drag-over');
});
$('tracks').addEventListener('drop', (ev) => {
  const li = ev.target.closest('li[data-id]');
  document.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  if (!dragId || !li || li.dataset.id === dragId) return;
  ev.preventDefault();
  const ids = S.bgm.tracks.map((t) => t.id);
  let to = ids.indexOf(li.dataset.id);
  if (ids.indexOf(dragId) < to) to -= 1;
  api('bgm/move', { id: dragId, index: to });
  dragId = null;
});
$('tracks').addEventListener('dragend', () => { dragId = null; });
// (HTML drag & drop doesn't work with fingers, so touch gets its own version)
$('tracks').addEventListener('pointerdown', (ev) => {
  if (ev.pointerType === 'mouse') return;
  const grip = ev.target.closest('.grip');
  const li = grip?.closest('li[data-id]');
  if (!li || $('search').value.trim()) return;
  ev.preventDefault();
  grip.setPointerCapture(ev.pointerId);
  li.classList.add('dragging');
  buzz();
  const list = $('tracks');
  let over = null, scroller = null, lastY = ev.clientY;
  const clear = () => list.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  const pick = () => {
    const r = list.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 40, lastY)?.closest('#tracks li[data-id]');
    clear();
    over = el && el !== li ? el : null;
    over?.classList.add('drag-over');
  };
  const move = (e) => { lastY = e.clientY; pick(); };
  // near the top/bottom edge: scroll the list
  scroller = setInterval(() => {
    const r = list.getBoundingClientRect();
    if (lastY < r.top + 36) list.scrollTop -= 12;
    else if (lastY > r.bottom - 36) list.scrollTop += 12;
    else return;
    pick();
  }, 30);
  const up = () => {
    clearInterval(scroller);
    grip.removeEventListener('pointermove', move);
    li.classList.remove('dragging');
    clear();
    if (over) {
      const ids = S.bgm.tracks.map((t) => t.id);
      let to = ids.indexOf(over.dataset.id);
      if (ids.indexOf(li.dataset.id) < to) to -= 1;
      api('bgm/move', { id: li.dataset.id, index: to });
    }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
});

// ---------------- auto-pause controls ----------------
$('apEnabled').addEventListener('change', () => api('autopause', { enabled: $('apEnabled').checked }));
$('apMode').addEventListener('click', (ev) => {
  const m = ev.target.dataset?.mode;
  if (m) api('autopause', { mode: m });
});
$('resumeAfter').addEventListener('input', () => { $('resumeVal').textContent = `${($('resumeAfter').value / 1000).toFixed(1)}s`; });
$('introHold').addEventListener('input', () => { $('introVal').textContent = `${($('introHold').value / 1000).toFixed(0)}s`; });
$('introHold').addEventListener('change', () => api('autopause', { introHoldMs: Number($('introHold').value) }));
$('resumeAfter').addEventListener('change', () => api('autopause', { resumeAfterMs: Number($('resumeAfter').value) }));

// drag the white line on the meter to set the trigger level
(() => {
  const meter = $('meter');
  let dragging = false;
  const setFrom = (ev, commit) => {
    const r = meter.getBoundingClientRect();
    const db = Math.min(-5, Math.max(-60, pctToDb(((ev.clientX - r.left) / r.width) * 100)));
    $('meterThresh').style.left = `${dbToPct(db)}%`;
    $('thrVal').textContent = `${db} dB`;
    if (commit) api('autopause', { thresholdDb: db });
  };
  meter.addEventListener('pointerdown', (ev) => { dragging = true; meter.setPointerCapture(ev.pointerId); setFrom(ev, false); });
  meter.addEventListener('pointermove', (ev) => dragging && setFrom(ev, false));
  meter.addEventListener('pointerup', (ev) => { if (dragging) { dragging = false; setFrom(ev, true); } });
})();

// ---------------- banner buttons ----------------
$('banners').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'create-bgm') {
    const r = await api('bgm/create-source');
    if (r.ok) toast(`"${S.bgm.sourceName}" 소스를 "${r.scene}" 장면에 만들었어요`);
  }
  if (btn.dataset.act === 'pick-target') {
    // Use the URL's host+path as the match, so query strings (tokens) can change freely.
    let match = btn.dataset.url;
    try { const u = new URL(match); match = u.host + u.pathname; } catch {}
    api('donation/target', { match });
  }
});

// ---------------- keyboard shortcuts ----------------
document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input[type=search], input[type=text], textarea')) return;
  if (ev.code === 'Space') { ev.preventDefault(); api('bgm/toggle'); }
  if (ev.key === 'n' || ev.key === 'N') api('bgm/next');
  if (ev.key === 's' || ev.key === 'S') $('skipBtn').click();
  if (ev.key === 'f' || ev.key === 'F') $('fullBtn').click();
  if ((ev.key === 'm' || ev.key === 'M') && !ev.repeat && !ev.ctrlKey && !ev.metaKey && !ev.altKey) markNow();
});

connectEvents();
donationLoop.kick();

// ---------------- live stats ----------------
function renderLive() {
  const { live, history } = S.chzzk;
  const on = !!live?.isLive;
  $('livePill').textContent = on ? 'LIVE' : 'OFFLINE';
  $('livePill').classList.toggle('on', on);
  $('viewers').textContent = on ? live.viewers.toLocaleString('ko-KR') : '–';
  $('peak').textContent = on && live.peak != null ? live.peak.toLocaleString('ko-KR') : '–';
  $('liveTitle').textContent = live?.title || (S.chzzk.channelId ? '' : '채널을 연결하면 방송 정보가 보여요');
  $('category').textContent = live?.category || '';
  // sparkline of the last ~15 min
  const pts = on ? history : [];
  if (pts.length > 1) {
    const max = Math.max(...pts), min = Math.min(...pts), span = Math.max(1, max - min);
    $('sparkLine').setAttribute('points', pts.map((n, i) => `${(i / (pts.length - 1)) * 120},${26 - ((n - min) / span) * 24}`).join(' '));
  } else {
    $('sparkLine').setAttribute('points', '');
  }
  tickUptime();
}

function tickUptime() {
  const live = S?.chzzk.live;
  if (!live?.isLive || !live.openDate) { $('uptime').textContent = '–'; return; }
  // Chzzk gives "YYYY-MM-DD HH:mm:ss" in Korean time.
  const start = new Date(live.openDate.replace(' ', 'T') + '+09:00').getTime();
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  $('uptime').textContent = `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(tickUptime, 1000);

// ---------------- chat ----------------
let chatTab = pref.get('chatTab', 'text');
if (!['text', 'mirror', 'donations'].includes(chatTab)) chatTab = 'text'; // the old 리모콘 tab is gone
const MAX_CHAT = 300;

function nickColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 75% 72%)`;
}

function chatHtml(m) {
  const t = new Date(m.time);
  const tm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  // Emotes arrive as {:name:} plus a name → image URL map.
  const text = esc(m.text).replace(/\{:([^:{}]+):\}/g, (all, name) =>
    m.emojis?.[name] ? `<img class="emo" src="${esc(m.emojis[name])}" alt="${esc(name)}" title="${esc(name)}">` : all);
  if (m.kind === 'system') return `<li class="msg system" data-id="${m.id}">${text}</li>`;
  const role = m.role ? `<span class="role ${m.role}">${m.role === 'streamer' ? '스트리머' : '매니저'}</span>` : '';
  const badges = (m.badges || []).map((u) => `<img class="badge" src="${esc(u)}" alt="">`).join('');
  let amt = '';
  if (m.kind === 'donation') {
    const what = m.donationType === 'VIDEO' ? '영도' : m.donationType === 'MISSION' ? '미션' : '후원';
    amt = `<span class="amt">${what} · ${Number(m.amount || 0).toLocaleString('ko-KR')} 치즈</span>`;
  }
  if (m.kind === 'subscription') amt = `<span class="amt">구독${m.months ? ` · ${m.months}개월` : ''}</span>`;
  const nick = m.nick ? `<span class="nick" style="color:${nickColor(m.nick)}">${esc(m.nick)}</span>` : '';
  return `<li class="msg ${m.kind}${m.hidden ? ' hidden-msg' : ''}" data-id="${m.id}">${amt}<span class="tm">${tm}</span>${badges}${role}${nick}${text}</li>`;
}

function nearBottom() {
  const el = $('chatList');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function chatReset(list) {
  $('chatList').innerHTML = list.length ? list.map(chatHtml).join('') : '<li class="chat-empty" id="chatEmpty">아직 채팅이 없어요</li>';
  $('chatList').scrollTop = $('chatList').scrollHeight;
  $('newMsgs').hidden = true;
}

function chatAdd(list) {
  const el = $('chatList');
  const stick = nearBottom();
  $('chatEmpty')?.remove();
  el.insertAdjacentHTML('beforeend', list.map(chatHtml).join(''));
  while (el.children.length > MAX_CHAT) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
  else $('newMsgs').hidden = false;
}

function chatUpdate(m) {
  const li = $('chatList').querySelector(`[data-id="${m.id}"]`);
  if (li) li.outerHTML = chatHtml(m);
}

$('chatList').addEventListener('scroll', () => { if (nearBottom()) $('newMsgs').hidden = true; });
$('newMsgs').addEventListener('click', () => {
  $('chatList').scrollTop = $('chatList').scrollHeight;
  $('newMsgs').hidden = true;
});

function setChatTab(tab) {
  chatTab = tab;
  $('chatPanel').classList.toggle('show-mirror', tab === 'mirror');
  pref.set('chatTab', tab);
  for (const b of $('chatTabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('chatText').hidden = tab !== 'text';
  $('chatDonations').hidden = tab !== 'donations';
  $('chatMirror').hidden = tab !== 'mirror';

  renderChatState();
  chatMirrorLoop.kick();
  window.syncChatPage?.();
  window.syncAlertMirror?.(); // defined further down, once the 후원 tab code has loaded
}
$('chatTabs').addEventListener('click', (ev) => { if (ev.target.dataset?.tab) setChatTab(ev.target.dataset.tab); });

function renderChatState() {
  if (!S) return;
  const { channelId, chat } = S.chzzk;
  $('channelForm').hidden = !!channelId || chatTab === 'mirror';
  if (!channelId && chatTab === 'donations') $('donList').innerHTML = '<li class="don-empty">치지직 채널을 연결하면 후원이 여기에 모여요</li>';
  $('remoteBtn').disabled = !channelId;
  const dot = $('chatDot');
  dot.className = 'state-dot ' + (chatTab === 'mirror' ? (S.chatSource.sourceOk ? 'ok' : 'bad') : chat.state === 'connected' ? 'ok' : chat.state === 'error' ? 'bad' : channelId ? 'warn' : '');
  dot.title = chatTab === 'mirror' ? (S.chatSource.error || S.chatSource.sourceName) : (chat.error || chat.state);
  if (!channelId && chatTab === 'text') $('chatList').innerHTML = '';
  else if (chat.state !== 'connected' && chat.error && $('chatEmpty')) $('chatEmpty').textContent = chat.error;
}

$('channelForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = await api('chzzk/channel', { channel: $('channelInput').value });
  if (r.ok) toast('치지직 채널을 연결했어요');
});

// show / hide the chat column
function applyChatVisible(show) {
  $('layout').classList.toggle('no-chat', !show);
  $('chatToggle').textContent = show ? '채팅 숨기기' : '채팅 보이기';
  pref.set('chatVisible', show);
  chatMirrorLoop.kick();
}
$('chatToggle').addEventListener('click', () => applyChatVisible($('layout').classList.contains('no-chat')));
applyChatVisible(pref.get('chatVisible', true));
setChatTab(chatTab);

// ---------------- 치지직 리모콘 ----------------
// studio.chzzk.naver.com/<channel>/remotecontrol needs the Naver login,
// so it runs in this browser (where you're logged in), not on the helper.
function remoteUrl() {
  const id = S?.chzzk.channelId;
  return id ? `https://studio.chzzk.naver.com/${id}/remotecontrol` : null;
}
let remoteWin = null;
function openRemoteWindow() {
  const url = remoteUrl();
  if (!url) return toast('먼저 치지직 채널을 연결해 주세요', true);
  if (remoteWin && !remoteWin.closed) { remoteWin.focus(); return; }
  // a slim window at the right edge of the screen
  const w = 440, h = Math.min(900, screen.availHeight - 40);
  const left = (screen.availLeft ?? 0) + screen.availWidth - w - 10;
  const top = (screen.availTop ?? 0) + 20;
  remoteWin = window.open(url, 'chzzkRemote', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!remoteWin) toast('팝업이 막혔어요 — 주소창 오른쪽에서 팝업을 허용해 주세요', true);
}
$('remoteBtn').addEventListener('click', openRemoteWindow);

// ---------------- 후원 tab ----------------
// Donations and subscriptions for this broadcast, newest on top.
let donations = [];

function richText(m) {
  return esc(m.text).replace(/\{:([^:{}]+):\}/g, (all, name) =>
    m.emojis?.[name] ? `<img class="emo" src="${esc(m.emojis[name])}" alt="${esc(name)}" title="${esc(name)}">` : all);
}

function donHtml(d) {
  const t = new Date(d.time);
  const tm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  let amt, type, cls = d.kind;
  if (d.kind === 'subscription') {
    amt = d.months ? `${d.months}개월` : '구독';
    type = '구독';
  } else {
    amt = `${Number(d.amount || 0).toLocaleString('ko-KR')} 치즈`;
    type = d.donationType === 'VIDEO' ? '영도' : d.donationType === 'MISSION' ? '미션' : '후원';
    if (d.donationType === 'VIDEO') cls += ' video';
  }
  return `<li class="don ${cls}${d.read ? ' read' : ''}" data-key="${esc(d.key)}" title="클릭해서 읽음 표시">
    <div class="don-top"><span class="don-amt">${amt}</span><span class="don-type">${type}</span><span class="don-nick">${esc(d.nick || '익명')}</span><span class="tm">${tm}</span></div>
    <div class="don-msg">${richText(d)}</div></li>`;
}

function donRender() {
  const list = $('donList');
  if (!donations.length) {
    list.innerHTML = '<li class="don-empty">이번 방송의 후원·구독이 여기에 모여요</li>';
  } else {
    list.innerHTML = donations.slice().reverse().map(donHtml).join('');
  }
  donSummary();
}

function donSummary() {
  const dons = donations.filter((d) => d.kind === 'donation');
  $('donCount').textContent = dons.length.toLocaleString('ko-KR');
  $('donTotal').textContent = dons.reduce((s, d) => s + Number(d.amount || 0), 0).toLocaleString('ko-KR');
  $('subCount').textContent = donations.filter((d) => d.kind === 'subscription').length;
  const unread = donations.filter((d) => !d.read).length;
  $('donUnread').textContent = unread ? String(unread) : '';
  $('mnavUnread').textContent = unread ? String(unread) : '';
}

function donReset(list) { donations = list; donRender(); }
function donAdd(list) {
  donations.push(...list.map((d) => ({ ...d, read: false })));
  $('donList').querySelector('.don-empty')?.remove();
  $('donList').insertAdjacentHTML('afterbegin', list.slice().reverse().map((d) => donHtml(d)).join(''));
  donSummary();
}
function donRead({ key, read }) {
  const d = donations.find((x) => x.key === key);
  if (d) d.read = read;
  $('donList').querySelector(`[data-key="${CSS.escape(key)}"]`)?.classList.toggle('read', read);
  donSummary();
}

$('donList').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-key]');
  if (!li) return;
  api('chzzk/donation-read', { key: li.dataset.key, read: !li.classList.contains('read') });
});
$('donReadAll').addEventListener('click', () => api('chzzk/donations-read-all'));

// ---------------- 알림 화면 panel ----------------
// Live mirror of the 도네 alert OBS source, under the music panel.
const alertMirrorLoop = makeMirror({
  img: 'alertFrame', empty: 'alertMirrorEmpty', src: 'alert', missing: '도네 알림 소스를 찾을 수 없음',
  active: () => !!S?.alertSource?.sourceOk && shown(document.querySelector('.alert-panel')),
});
function renderAlertState() {
  const a = S?.alertSource;
  if (!a) return;
  $('alertDot').className = 'state-dot ' + (a.sourceOk ? 'ok' : a.error === 'not-set' ? '' : 'bad');
  if (!a.sourceOk) {
    $('alertMirrorEmpty').style.display = '';
    $('alertMirrorEmpty').textContent = a.error === 'not-set'
      ? '방송 PC의 Stream Desk 설정 → "도네 알림 브라우저 소스"에서 소스를 골라 주세요'
      : `"${a.sourceName}" 소스를 OBS에서 찾을 수 없어요`;
  }
  alertMirrorLoop.sync();
}
window.syncAlertMirror = renderAlertState;

// ---------------- music panel: BGM / 셋리스트 tabs ----------------
function setMusicTab(t) {
  pref.set('musicTab', t);
  for (const b of $('musicTabs').children) b.classList.toggle('on', b.dataset.mt === t);
  $('musicBgm').hidden = t !== 'bgm';
  $('musicList').hidden = t !== 'list';
  document.querySelector('.music').classList.toggle('show-list', t === 'list');
}
$('musicTabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mt]');
  if (b) setMusicTab(b.dataset.mt);
});
setMusicTab(pref.get('musicTab', 'bgm'));

// ---------------- resizable panels ----------------
// Each handle drags one size; sizes are remembered per browser.
(() => {
  const layout = $('layout');
  const DEFAULTS = { 'chat-w': null, 'side-w': null, 'viewer-chat': null, 'alert-h': null, 'stage-p': null };
  // upright tablet: picture across the top, its height set by the same handle
  const portrait = matchMedia('(orientation: portrait) and (min-width: 641px) and (max-width: 1380px)');
  const sizes = { ...DEFAULTS, ...pref.get('panelSizes', {}) };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function apply() {
    const st = layout.style;
    sizes['chat-w'] ? st.setProperty('--chat-w', sizes['chat-w'] + 'px') : st.removeProperty('--chat-w');
    sizes['side-w'] ? st.setProperty('--side-w', sizes['side-w'] + 'px') : st.removeProperty('--side-w');
    sizes['viewer-chat'] ? st.setProperty('--viewer-fr', sizes['viewer-chat'] + 'fr') : st.removeProperty('--viewer-fr');
    sizes['alert-h'] ? st.setProperty('--alert-h', sizes['alert-h'] + 'px') : st.removeProperty('--alert-h');
    sizes['alert-h'] ? st.setProperty('--alert-h-p', sizes['alert-h'] + 'px') : st.removeProperty('--alert-h-p');
    sizes['stage-p'] ? st.setProperty('--stage-max', sizes['stage-p'] + 'px') : st.removeProperty('--stage-max');
    // "shrink allowed" so a saved height never pushes it off-screen on a smaller window
    document.querySelector('.alert-panel').style.flex = sizes['alert-h'] ? `0 1 ${sizes['alert-h']}px` : '';
    document.querySelector('.side').classList.toggle('alert-sized', !!sizes['alert-h']);
  }

  function onDrag(kind, ev) {
    const L = layout.getBoundingClientRect();
    const W = L.width;
    if (kind === 'chat-w') {
      // left edge of the chat column; the side column stays put
      const side = document.querySelector('.side').getBoundingClientRect();
      sizes['chat-w'] = Math.round(clamp(side.left - 12 - ev.clientX, 260, W - (side.width + 12) - 12 - 360));
    } else if (kind === 'side-w') {
      sizes['side-w'] = Math.round(clamp(L.right - 16 - ev.clientX, 260, Math.min(700, W - 360 - 24)));
    } else if (kind === 'viewer-chat' && portrait.matches) {
      const stage = $('stage').getBoundingClientRect();
      sizes['stage-p'] = Math.round(clamp(ev.clientY - stage.top - 12 - 14, 160, L.height - (stage.top - L.top) - 220));
    } else if (kind === 'viewer-chat') {
      // viewer : chat ratio, chat row fixed at 2 parts
      const top = L.top + 12, bottom = L.bottom - 16;
      const viewerH = clamp(ev.clientY - top - 6, 150, bottom - top - 150);
      const chatH = bottom - top - 12 - viewerH;
      sizes['viewer-chat'] = +(2 * viewerH / chatH).toFixed(3);
    } else if (kind === 'alert-h') {
      const side = document.querySelector('.side').getBoundingClientRect();
      // the music panel needs at least its controls (BGM tab) or a few songs (셋리스트)
      const musicMin = document.querySelector('#musicBgm').hidden ? 200 : document.querySelector('#musicBgm').scrollHeight + 60;
      sizes['alert-h'] = Math.round(clamp(side.bottom - ev.clientY, 120, side.height - Math.min(musicMin, side.height - 132) - 12));
    }
    apply();
  }

  for (const h of document.querySelectorAll('.resizer')) {
    const kind = h.dataset.r;
    h.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      h.setPointerCapture(ev.pointerId);
      h.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = (e) => onDrag(kind, e);
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.classList.remove('dragging');
        document.body.classList.remove('resizing');
        pref.set('panelSizes', sizes);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up, { once: true });
      h.addEventListener('pointercancel', up, { once: true });
    });
    h.addEventListener('dblclick', () => {
      sizes[kind] = null;
      if (kind === 'viewer-chat') sizes['stage-p'] = null;
      apply();
      pref.set('panelSizes', sizes);
    });
  }
  apply();
})();

// ---------------- main panel tabs + auto switch ----------------
function setMainTab(t) {
  mainTab = t;
  pref.set('mainTab', t);
  for (const b of $('mainTabs').children) b.classList.toggle('on', b.dataset.mt === t);
  document.querySelector('.viewer-panel').classList.toggle('tab-program', t === 'program');
  $('stageBadge').textContent = '';
  donationLoop.sync();
  programLoop.sync();
  if (S) renderViewerState();
}
$('mainTabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mt]');
  if (b) setMainTab(b.dataset.mt);
});
$('autoTab').checked = pref.get('autoTab', true);
$('autoTab').addEventListener('change', () => pref.set('autoTab', $('autoTab').checked));

// Like the BGM auto-pause: 영도 starts → show it; 영도 ends → back to 방송 화면.
// Picking a tab by hand still works; the next start/end switches again.
let wasDonationActive = null;
function followDonation() {
  if (!S) return;
  const active = !!S.donationActive;
  $('donLiveDot').hidden = !active;
  if (wasDonationActive !== null && active !== wasDonationActive && $('autoTab').checked) {
    setMainTab(active ? 'donation' : 'program');
  }
  wasDonationActive = active;
}
setMainTab(mainTab);

// 채팅 팝업 opens as a slim window beside the dashboard, like the 리모컨
$('links').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-popup]');
  if (!a) return;
  ev.preventDefault();
  const w = 400, h = Math.min(860, screen.availHeight - 40);
  const left = (screen.availLeft ?? 0) + screen.availWidth - w - 10;
  const win = window.open(a.href, 'chzzkChat', `popup=yes,width=${w},height=${h},left=${left},top=${(screen.availTop ?? 0) + 20}`);
  if (!win) toast('팝업이 막혔어요 — 주소창 오른쪽에서 팝업을 허용해 주세요', true);
});

// ---------------- phones: bottom tab bar ----------------
// Picks which panel fills the space under the picture. Hidden panels stop
// their OBS mirrors, so nothing is captured for a panel you can't see.
function syncMirrors() {
  donationLoop.sync(); programLoop.sync(); chatMirrorLoop.sync(); alertMirrorLoop.sync(); window.syncChatPage?.();
}
function setMobilePanel(p) {
  pref.set('mPanel', p);
  for (const c of ['chat', 'music', 'alert']) document.body.classList.toggle('mp-' + c, c === p);
  for (const b of $('mnav').children) b.classList.toggle('on', b.dataset.mp === p);
  syncMirrors();
}
$('mnav').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mp]');
  if (b) { buzz(); setMobilePanel(b.dataset.mp); }
});
setMobilePanel(pref.get('mPanel', 'chat'));
// layout changes (rotate the iPad, fold/unfold the phone): some panels appear or disappear
let layoutTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(syncMirrors, 250);
});

// ---------------- per-device settings (⚙) ----------------
const isPhone = matchMedia('(max-width: 640px), (max-height: 500px) and (orientation: landscape)').matches;
if (pref.get('saver', null) === null) pref.set('saver', isPhone); // phones start in 데이터 절약
$('optSaver').checked = pref.get('saver', false);
$('optVibrate').checked = pref.get('vibrate', true);
$('optVibrateWrap').hidden = !navigator.vibrate;
$('devBtn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  $('devMenu').hidden = !$('devMenu').hidden;
});
document.addEventListener('click', (ev) => {
  if (!$('devMenu').hidden && !ev.target.closest('#devMenu, #devBtn')) $('devMenu').hidden = true;
});
$('optSaver').addEventListener('change', () => {
  pref.set('saver', $('optSaver').checked);
  for (const m of [donationLoop, programLoop, chatMirrorLoop, alertMirrorLoop]) m.restart();
  toast($('optSaver').checked ? '데이터 절약: 이 기기는 최대 15fps로 받아요' : '데이터 절약 꺼짐');
});
$('optVibrate').addEventListener('change', () => { pref.set('vibrate', $('optVibrate').checked); buzz(); });

// chat text size (handy for an iPad on a stand)
function applyChatScale(v) {
  v = Math.round(Math.max(0.8, Math.min(1.6, v)) * 10) / 10;
  pref.set('chatScale', v);
  document.body.style.setProperty('--chat-scale', v);
  $('fontReset').textContent = `${Math.round(v * 100)}%`;
}
$('fontDown').addEventListener('click', () => applyChatScale(pref.get('chatScale', 1) - 0.1));
$('fontUp').addEventListener('click', () => applyChatScale(pref.get('chatScale', 1) + 0.1));
$('fontReset').addEventListener('click', () => applyChatScale(1));
applyChatScale(pref.get('chatScale', 1));

// keep the screen on: the real Wake Lock API needs https, which a LAN page
// doesn't have, so we fall back to a tiny silent looping video (what most
// "keep awake" sites do). Has to be started by a tap.
const AWAKE_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANDbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAm10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAAAAABAAAAAAHlbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABkG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVBzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMAEDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAWOAAAFjgAAABhzdHRzAAAAAAAAAAEAAAAIAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAIAAAAAQAAADRzdHN6AAAAAAAAAAAAAAAIAAAChgAAAAoAAAAKAAAACQAAAAkAAAAJAAAACQAAAAkAAAAUc3RjbwAAAAAAAAABAAADcwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAALPbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTIgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBX///w9FAAFC34AAAAAGQZo4CvqAAAAABkGaVAK+oAAAAAVBmmAV9QAAAAVBmoAU9QAAAAVBmqAU9QAAAAVBmsAU9QAAAAVBmuAS9Q==';
let awakeVideo = null, wakeLock = null;
async function setAwake(on) {
  pref.set('awake', on);
  if (on) {
    if (navigator.wakeLock && window.isSecureContext) {
      try { wakeLock = await navigator.wakeLock.request('screen'); return; } catch {}
    }
    if (!awakeVideo) {
      awakeVideo = document.createElement('video');
      awakeVideo.src = AWAKE_MP4;
      awakeVideo.muted = true;
      awakeVideo.loop = true;
      awakeVideo.playsInline = true;
      awakeVideo.setAttribute('playsinline', '');
      awakeVideo.setAttribute('aria-hidden', 'true');
      awakeVideo.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none';
      document.body.append(awakeVideo);
    }
    try { await awakeVideo.play(); } catch { $('optAwake').checked = false; pref.set('awake', false); toast('화면 꺼짐 방지를 켜지 못했어요', true); }
  } else {
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
    awakeVideo?.pause();
  }
}
$('optAwake').checked = pref.get('awake', false);
$('optAwake').addEventListener('change', () => setAwake($('optAwake').checked));
// browsers stop it when the tab is hidden; start again on return (or on the first tap after a reload)
document.addEventListener('visibilitychange', () => { if (!document.hidden && pref.get('awake', false)) setAwake(true); });
document.addEventListener('pointerdown', function firstTap() {
  document.removeEventListener('pointerdown', firstTap);
  if (pref.get('awake', false)) setAwake(true);
});

// ---------------- OBS: scenes, mic, stream health ----------------
let scenesKey = '';
let scenePending = '';
function renderStudio() {
  const st = S.studio;
  if (!st) return;
  // scene buttons (rebuilt only when the list changes)
  const key = st.scenes.join('\n');
  if (key !== scenesKey) {
    scenesKey = key;
    $('scenes').innerHTML = st.scenes.map((n) => `<button data-scene="${esc(n)}">${esc(n)}</button>`).join('');
  }
  $('scenes').hidden = st.scenes.length < 2;
  for (const b of $('scenes').children) {
    b.classList.toggle('on', b.dataset.scene === st.scene);
    b.classList.toggle('pending', b.dataset.scene === scenePending && scenePending !== st.scene);
  }
  if (scenePending === st.scene) scenePending = '';
  // mic
  const m = st.mic;
  const btn = $('micBtn');
  btn.classList.toggle('muted', m.ok && m.muted);
  btn.classList.toggle('off', !m.ok);
  $('micLabel').textContent = !m.ok ? '마이크 ?' : m.muted ? '마이크 꺼짐' : '마이크';
  btn.title = !m.ok ? m.error : `${m.name} — 눌러서 ${m.muted ? '켜기' : '끄기'}`;
}
$('scenes').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-scene]');
  if (!b || b.classList.contains('on')) return;
  buzz();
  scenePending = b.dataset.scene;
  b.classList.add('pending');
  const r = await api('scene', { name: b.dataset.scene });
  if (!r.ok) { scenePending = ''; b.classList.remove('pending'); }
});
$('micBtn').addEventListener('click', async () => {
  if (!S?.studio?.mic.ok) return toast(S?.studio?.mic.error || '마이크 소스를 찾을 수 없어요', true);
  buzz();
  const r = await api('mic/toggle');
  if (r.ok) toast(r.muted ? '마이크를 껐어요' : '마이크를 켰어요');
});

function renderHealth(h) {
  const el = $('health');
  el.hidden = !h || !h.live;
  if (el.hidden) return;
  el.className = 'health ' + h.level;
  const rate = h.reconnecting ? '재연결 중…' : h.kbps != null ? `${h.kbps.toLocaleString('ko-KR')} kbps` : '송출 중';
  let extra = '';
  if (h.encPct > 0) extra += ` · 인코딩 지연 ${h.encPct}%`;
  if (h.renPct > 0) extra += ` · 렌더 지연 ${h.renPct}%`;
  // (on a phone only the rate shows while all is well, only the problem when not)
  $('healthText').innerHTML = `<span class="h-rate">${esc(rate)}</span><span class="h-sep"> · </span><span class="h-drop">드롭 ${h.dropPct}%</span>`
    + (extra ? `<span class="extra">${esc(extra)}</span>` : '');
  el.title = [
    `방송 송출 상태 (최근 2초)`,
    `비트레이트: ${h.kbps ?? '–'} kbps`,
    `네트워크 드롭: ${h.dropPct}% (방송 전체 ${h.dropTotal}프레임, ${h.dropTotalPct}%)`,
    `인코딩 지연: ${h.encPct}%   렌더 지연: ${h.renPct}%`,
    h.congestion != null ? `혼잡도: ${Math.round(h.congestion * 100)}%` : '',
    h.fps ? `OBS ${h.fps} fps · CPU ${h.cpu}%` : '',
  ].filter(Boolean).join('\n');
}
// touch screens have no hover tooltips: tap the health chip for the details
$('health').addEventListener('click', () => toast($('health').title.split('\n').slice(1).join(' · ')));

// phones: the 리모콘 button lives in the ⚙ menu (no room in the top bar)
$('devRemote').addEventListener('click', () => { $('devMenu').hidden = true; openRemoteWindow(); });

// ---------------- 위플챗: page mode ----------------
// Shows the 위플챗 overlay page itself (same URL as the OBS source), sized to
// the whole panel — instead of a picture of the OBS source, which is only as
// tall as the source. Falls back to the picture if the site refuses.
function chatPageMode() {
  const c = S?.chatSource;
  if (!c?.pageUrl || c.frameable === false) return false;
  return pref.get('chatView', 'page') === 'page';
}
function syncChatPage() {
  const f = $('chatPage');
  const want = chatPageMode() && chatTab === 'mirror' && shown($('chatPanel')) && !document.hidden;
  const url = want ? S.chatSource.pageUrl : '';
  if (want) {
    if (f.dataset.url !== url) { f.dataset.url = url; f.src = url; }
  } else if (f.dataset.url) {
    f.dataset.url = ''; f.removeAttribute('src'); // unload it: nothing runs while hidden
  }
  f.hidden = !want;
  $('chatFrame').hidden = want;
  $('chatMirror').classList.toggle('page', want);
  if (want) $('chatMirrorEmpty').style.display = 'none';
  const canPage = !!S?.chatSource?.pageUrl && S.chatSource.frameable !== false;
  $('chatModeBtn').hidden = !canPage;
  $('chatModeBtn').title = chatPageMode() ? '지금: 위플챗 페이지 (패널 크기에 맞춤) — 눌러서 OBS 화면으로' : '지금: OBS 화면 그대로 — 눌러서 위플챗 페이지로';
  chatMirrorLoop.sync();
}
window.syncChatPage = syncChatPage;
$('chatModeBtn').addEventListener('click', () => {
  pref.set('chatView', chatPageMode() ? 'obs' : 'page');
  syncChatPage();
  toast(chatPageMode() ? '위플챗 페이지를 패널 크기로 보여줘요' : 'OBS의 위플챗 화면을 그대로 보여줘요');
});
document.addEventListener('visibilitychange', syncChatPage);


// ---------------- ⭐ marks (moments for YouTube edits, read by VOD Scout) ----------------
let marksGotAt = 0;
let marksCount = -1;
let markEditing = false;
const fmtT = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function renderMarks() {
  const mk = S.marks;
  if (!mk) return;
  marksGotAt = Date.now();
  const grp = $('markGrp');
  grp.hidden = !mk.recording && !mk.count;
  grp.classList.toggle('rec', !!mk.recording && !mk.paused);
  grp.classList.toggle('paused', !!mk.paused);
  $('markBtn').disabled = !mk.recording;
  $('markBtn').title = mk.recording ? '지금 순간을 녹화에 마크 (M) · 유튜브 편집용' : '녹화 중이 아니에요';
  $('markCount').textContent = mk.count ? mk.count : '';
  if (marksCount >= 0 && mk.count > marksCount && mk.recording) flashMark(); // also for hotkey / phone presses
  marksCount = mk.count;
  tickMarks();
  $('markMenuSub').textContent = mk.recording ? (mk.paused ? '· 녹화 일시정지' : '· 녹화 중') : mk.file ? `· 저장됨: ${mk.file}` : '· 지난 녹화';
  if (markEditing) return; // don't redraw while a note is being typed
  const list = $('markList');
  list.textContent = '';
  if (!mk.marks.length) { list.innerHTML = '<li class="muted small">아직 마크가 없어요</li>'; return; }
  mk.marks.map((m, i) => [m, i]).reverse().forEach(([m, i]) => {
    const li = document.createElement('li');
    const t = document.createElement('span'); t.className = 'mono'; t.textContent = fmtT(m.t);
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = m.label || ''; inp.placeholder = '메모 (선택)'; inp.maxLength = 200;
    inp.addEventListener('focus', () => (markEditing = true));
    inp.addEventListener('blur', () => { markEditing = false; if (inp.value !== (m.label || '')) api('mark/label', { index: i, label: inp.value }); });
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
    li.append(t, inp);
    list.append(li);
  });
}
function tickMarks() {
  const mk = S?.marks;
  $('markTime').textContent = mk?.recording ? fmtT((mk.elapsedMs + (mk.paused ? 0 : Date.now() - marksGotAt)) / 1000) : '';
}
setInterval(tickMarks, 1000);
function flashMark() {
  const b = $('markBtn');
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
}
async function markNow() {
  if (!S?.marks?.recording) return toast('녹화 중이 아니에요', true);
  buzz();
  flashMark();
  try {
    const r = await fetch('api/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    if (j.ok) toast(`⭐ ${fmtT(j.t)} 마크 (${j.count})`);
    else toast(j.reason === 'not recording' ? '녹화 중이 아니에요' : `마크 실패: ${j.reason}`, true);
  } catch { toast('Stream Desk에 연결할 수 없어요', true); }
}
$('markBtn').addEventListener('click', markNow);
$('markMore').addEventListener('click', (ev) => { ev.stopPropagation(); $('markMenu').hidden = !$('markMenu').hidden; });
document.addEventListener('click', (ev) => {
  if (!$('markMenu').hidden && !ev.target.closest('#markMenu, #markMore')) $('markMenu').hidden = true;
});
