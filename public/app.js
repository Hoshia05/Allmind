// Allmind control page. Talks only to the helper on the stream PC.
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
    if (res.status === 401) return toPin();
    const data = await res.json();
    if (!data.ok) toast(data.error || '요청이 실패했어요', true);
    return data;
  } catch {
    toast('Allmind에 연결할 수 없어요', true);
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

// ---------------- optional PIN for other devices ----------------
// The server answers 401 once this device must (again) enter the PIN — PIN just turned on, or "모든 기기 로그아웃".
// EventSource can't see status codes, so after a dropped connection ask /api/access.
function toPin() {
  location.replace('/pin?next=' + encodeURIComponent(location.pathname + location.search));
  return { ok: false };
}
let pinChecking = false;
async function checkPin() {
  if (pinChecking) return;
  pinChecking = true;
  try { const a = await (await fetch('/api/access', { cache: 'no-store' })).json(); if (a.required && !a.paired) toPin(); } catch {}
  pinChecking = false;
}

// ---------------- live state ----------------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { S = JSON.parse(e.data); S.bgm.tracks = TRACKS; render(); });
  // the setlist comes separately, only when it changes
  es.addEventListener('bgmpos', (e) => { if (!S) return; Object.assign(S.bgm.media, JSON.parse(e.data)); renderProgress(); });
  es.addEventListener('tracks', (e) => { TRACKS = JSON.parse(e.data); if (S) { S.bgm.tracks = TRACKS; lastTracksKey = ''; renderBgm(); } });
  es.addEventListener('health', (e) => renderHealth(JSON.parse(e.data)));
  es.addEventListener('level', (e) => renderLevel(JSON.parse(e.data)));
  es.addEventListener('toast', (e) => { const d = JSON.parse(e.data); toast(d.text, !!d.bad, d.long); });
  es.addEventListener('chat-history', (e) => chatReset(JSON.parse(e.data)));
  es.addEventListener('fps', (e) => renderFps(JSON.parse(e.data)));
  es.addEventListener('chat', (e) => chatAdd(JSON.parse(e.data)));
  es.addEventListener('todo', (e) => window.todoState?.(JSON.parse(e.data)));
  es.addEventListener('todo-start', (e) => window.todoReminder?.(JSON.parse(e.data)));
  es.addEventListener('chat-update', (e) => chatUpdate(JSON.parse(e.data)));
  es.addEventListener('donations-history', (e) => donReset(JSON.parse(e.data)));
  es.addEventListener('donations', (e) => donAdd(JSON.parse(e.data)));
  es.addEventListener('donation-read', (e) => donRead(JSON.parse(e.data)));
  es.onerror = () => {
    $('chips').innerHTML = '<span class="chip bad">Allmind 연결 끊김 — 다시 연결하는 중</span>';
    checkPin();
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
  renderUploads();
  if (!$('prepWrap').hidden) renderPrepTargets();
  renderViewerState();
  renderBgm();
  renderLive();
  renderChatState();
  renderStudio();
  renderMarks();
  renderSoundboard();
  window.renderObs?.();
  if (typeof followDonation === 'function') followDonation();
  window.syncAlertMirror?.();
}

// New-version notice (the stream PC's Allmind checks GitHub; installing is done in its settings window).
let UPD = null;
let updDismissed = '';
try { updDismissed = localStorage.getItem('sd.updDismissed') || ''; } catch {}
async function loadUpdate() {
  try {
    const r = await fetch('/api/update', { cache: 'no-store' });
    UPD = await r.json();
    if (S) renderBanners();
  } catch {}
}

// ✕ on a banner hides it on this device for 6 hours — or until its message changes (a new problem shows again)
const BANNER_HIDE_MS = 6 * 3600000;
let bannerHidden = {};
try { bannerHidden = JSON.parse(localStorage.getItem('allmind.bannersHidden') || '{}') || {}; } catch {}
function hideBanner(key) {
  const now = Date.now();
  for (const [k, t] of Object.entries(bannerHidden)) if (t < now) delete bannerHidden[k];
  bannerHidden[key] = now + BANNER_HIDE_MS;
  try { localStorage.setItem('allmind.bannersHidden', JSON.stringify(bannerHidden)); } catch {}
}

function renderBanners() {
  const { obs, bgm, donation, interact } = S;
  const out = [];
  // key: what the banner is about + its message, so the same problem stays hidden but a different one doesn't
  const B = (key, cls, inner) => { if (!((bannerHidden[key] || 0) > Date.now())) out.push(`<div class="banner ${cls}" data-key="${esc(key)}"><span class="banner-text">${inner}</span><button class="banner-x" data-act="hide-banner" title="닫기 — 이 기기에서 6시간 동안 안 보여요 (내용이 바뀌면 다시 보여요)" aria-label="닫기">✕</button></div>`); };
  if (UPD?.available && UPD.latest !== updDismissed) {
    out.push(`<div class="banner info">Allmind ${esc(UPD.latest)} 업데이트가 있어요 (지금 ${esc(UPD.current)}) — 방송 PC의 Allmind 설정 창에서 설치할 수 있어요. <button class="btn" data-act="dismiss-update">나중에</button></div>`);
  }
  if (!obs.connected) {
    B(`obs:${obs.error || ''}`, 'bad', `OBS에 연결할 수 없음 — ${esc(obs.error || obs.url)}. OBS에서 도구 → WebSocket 서버 설정을 켜고, 비밀번호를 방송 PC의 Allmind 설정에 넣어 주세요.`);
  } else {
    if (bgm.sourceError) B(`bgm:${bgm.sourceError}`, '', `${esc(bgm.sourceError)}${bgm.sourceMissing ? ' <button class="btn" data-act="create-bgm">현재 장면에 만들기</button>' : ''}`);
    if (donation.error) B(`donation:${donation.error}`, '', esc(donation.error));
    // OBS opened from its own shortcut: no 영도 클릭 전달 / 광고 넘기기 / 치지직 리모컨
    if (S.obsDebug === false) {
      const live = S.obsStreaming || S.marks?.recording;
      B('obsdebug', '', `OBS가 Allmind 밖에서 켜져서 <b>영도 클릭·광고 스킵·치지직 리모컨</b>이 안 돼요 — ${live ? '방송·녹화가 끝나면 OBS를 다시 켜 주세요' : 'OBS를 Allmind 옵션으로 다시 켤게요 <button class="btn" data-act="obs-relaunch">OBS 다시 켜기</button>'}<br><span class="muted small">다음부터 OBS를 직접 켜도 되게 하려면: 방송 PC 설정 창 → OBS → <b>OBS 바로가기 고치기</b></span>`);
    }
  }
  if (S.streamReconnect) B('reconnect', 'bad', `📡 방송 연결이 끊겨서 OBS가 다시 연결하는 중이에요 (${Math.max(1, Math.round((Date.now() - S.streamReconnect.since) / 1000))}초째) — 인터넷(공유기·랜선)을 확인해 주세요. 다시 연결되면 저절로 사라져요`);
  if (S.obsAudio?.warn) B(`obsaudio:${S.obsAudio.ms}`, 'bad', `🔊 OBS가 소리를 <b>${S.obsAudio.ms}ms</b> 늦게 내보내고 있어요${S.obsAudio.source ? ` (${esc(S.obsAudio.source)} 때문)` : ''} — 방송 중에는 줄일 수 없어요. 방송이 끝나면(또는 쉬는 시간에) OBS를 다시 켜면 돌아와요`);
  if (S.chzzk.error) B(`chzzk:${S.chzzk.error}`, '', esc(S.chzzk.error));
  // YouTube archive guard: shown on every device (phone too) while OBS streams
  const ya = S.youtube?.alert;
  if (ya) B(`yt:${ya.text}`, ya.level === 'warn' ? '' : 'bad', `📺 ${esc(ya.text)}${ya.adopt ? ' <button class="btn" data-act="yt-adopt">이 키를 Allmind가 쓰기</button>' : ''}${ya.url ? ` <a class="btn" href="${esc(ya.url)}" target="_blank" rel="noopener">YouTube 스튜디오</a>` : ''}`);
  if (S.google?.error) B(`google:${S.google.error}`, 'bad', esc(S.google.error));
  if (S.chzzkOpen?.error) B(`chzzkopen:${S.chzzkOpen.error}`, '', esc(S.chzzkOpen.error));
  else if (S.chzzkOpen?.expiresSoon) B('chzzkopen:expires', '', '치지직 연동이 곧 만료돼요 — 방송 PC의 설정 창에서 다시 로그인해 주세요');
  const up = S.drive?.items?.find((i) => i.status === 'uploading');
  if (up) B(`drive-up:${up.id}`, 'info', `☁️ 드라이브에 올리는 중 ${pct(up)}% · ${esc(up.name)}${S.drive.speed ? ` · ${S.drive.speed} Mbps` : ''}`);
  const failed = S.drive?.items?.find((i) => i.status === 'error');
  if (failed) B(`drive-fail:${failed.id}:${failed.error || ''}`, 'bad', `☁️ 드라이브 업로드 실패: ${esc(failed.name)} — ${esc(failed.error || '')} <button class="btn" data-act="drive-retry" data-id="${esc(failed.id.replace(/m$/, ''))}">다시 시도</button>`);
  if (bgm.folderError) B(`bgmfolder:${bgm.folderError}`, '', esc(bgm.folderError));
  if (interact.enabled && !interact.connected && interact.error && S.obsDebug !== false) { // (no debugging option: the OBS banner above says it)
    let html = `클릭 전달: ${esc(interact.error)}`;
    if (interact.candidates?.length) {
      html += ' ' + interact.candidates
        .map((c) => `<button class="btn" data-act="pick-target" data-url="${esc(c.url)}" title="${esc(c.url)}">${esc(shortUrl(c.url))}</button>`)
        .join(' ');
    }
    B(`interact:${interact.error}`, '', html);
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
function renderProgress() {
  const m = S.bgm.media;
  $('progressFill').style.width = m.duration ? `${(100 * m.cursor) / m.duration}%` : '0';
  $('tCur').textContent = fmt(m.cursor);
  $('tDur').textContent = fmt(m.duration);
}

function renderBgm() {
  const b = S.bgm;
  const cur = b.tracks.find((t) => t.id === b.currentId);
  $('bgmSource').textContent = b.sourceName;
  $('nowTitle').textContent = cur ? cur.title : '—';
  $('nowSub').textContent = (b.media.loopPart ? '🔁 무한 반복' + (cur?.folder ? ' · ' : '') : '') + (cur?.folder || '');
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
  renderProgress();
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
  $('apDot').className = 'tab-dot' + (ap.enabled ? (ap.active ? ' active' : ' on') : '');
  $('apDot').title = !ap.enabled ? '꺼짐' : ap.active ? '영도 재생 중' : '켜짐';
  $('apState').textContent = !ap.enabled ? '' : ap.active ? (ap.mode === 'duck' ? '영도 재생 중 · 볼륨 낮춤' : '영도 재생 중 · 일시정지') : '대기 중';

  $('count').textContent = `(${b.tracks.length})`;
  const key = b.tracks.map((t) => t.id).join('|') + '#' + b.currentId + '#' + $('search').value + '#' + JSON.stringify(b.loops || {});
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
        ${loopBtn(t.id)}
      </li>`)
    .join('');
}

// meter scale: -60 dB .. 0 dB
const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
const pctToDb = (p) => Math.round((p / 100) * 60 - 60);

function renderLevel({ db, mic, obs }) {
  if (obs) window.obsLevels?.(obs);
  if (mic !== undefined) {
    // mic meter: -60..0 dB; turns orange near clipping
    const pct = dbToPct(mic);
    $('micFill').style.width = `${pct}%`;
    $('micFill').style.background = mic > -6 ? 'var(--warn)' : '';
  }
  $('meterFill').style.width = `${dbToPct(db)}%`;
  $('meter').classList.toggle('hot', S && db > S.bgm.autoPause.thresholdDb);
}

// ---------------- OBS source mirrors (영도, 방송 화면, 도네 알림) ----------------
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
    const want = !document.hidden && !document.body.classList.contains('xy-open') && active(); // not behind the Xylem view
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
donationLoop.kick = donationLoop.sync;
document.addEventListener('visibilitychange', () => { donationLoop.sync(); programLoop.sync(); window.syncAlertMirror?.(); });

// small corner badge: how the picture is arriving
function renderFps({ donation, program }) {
  if (mainTab === 'program') {
    if (programLoop.on && programLoop.frames > 0) $('programEmpty').style.display = 'none';
    const b = $('stageBadge');
    if (programLoop.error) { b.textContent = '⚠ ' + programLoop.error; return; }
    const scene = S?.program?.scene ? ` · ${S.program.scene}` : '';
    b.textContent = program && programLoop.on ? `방송 화면${scene} · ${program.fps} fps${program.limited ? guardText(program) : ''}` : '';
    return;
  }
  // Frames are arriving: drop the "waiting" overlay even if the browser
  // never reports the image as loaded (it doesn't always for live streams).
  if (donationLoop.on && donationLoop.frames > 0) $('stageEmpty').style.display = 'none';
  const b = $('stageBadge');
  if (!donationLoop.on || donation.mode === 'idle') { b.textContent = ''; return; }
  if (donationLoop.error) { b.textContent = '⚠ ' + donationLoop.error; return; }
  const how = donation.mode === 'obs-idle' ? '정지 화면' : 'OBS';
  b.textContent = (donation.fps ? `${how} · ${donation.fps} fps` : how) + (donation.limited ? guardText(donation) : '');
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
  // when alerts are paused, the 리모컨's button turns into "알림 재시작"
  $('rcPause').classList.toggle('paused', /재개|시작|켜기/.test(r.pauseLabel || ''));
  const why = !r.connected ? (r.error || '치지직 리모컨에 연결되지 않음') : r.needsLogin ? 'OBS의 리모컨 독에서 네이버에 로그인해 주세요' : '';
  $('rcSkip').title = why || '치지직 리모컨의 넘기기 버튼을 눌러요';
  $('rcStop').title = why || (r.videoPlaying ? `재생 중: ${r.videoInfo || '영도'} — 눌러서 정지` : '지금 재생 중인 영도가 없어요');
  $('rcPause').title = why || '치지직 리모컨의 알림 정지/재개 버튼을 눌러요';
}
async function remotePress(path) {
  buzz();
  const r = S.remote;
  if (!r.connected) return toast(`${r.error || '치지직 리모컨에 연결되지 않음'} — 방송 PC의 Allmind 창에서 설정 방법을 확인하세요`, true);
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
  if (li && ev.target.closest('.loop-btn')) { ev.stopPropagation(); openLoop(li.dataset.id); return; }
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

// ---------------- 방송 준비 (title for Chzzk + YouTube archive + file name) ----------------
const pct = (i) => (i.size ? Math.floor((i.offset / i.size) * 100) : 0);
const prepState = { category: null, loaded: false, autoYt: true, autoFile: true };
const p2d = (n) => String(n).padStart(2, '0');
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${p2d(d.getMonth() + 1)}-${p2d(d.getDate())}`; };
const fillTpl = (tpl, title) => String(tpl || '{date} - {title}').replace(/\{date\}/g, todayYmd()).replace(/\{title\}/g, title).replace(/\s+/g, ' ').trim();

async function openPrep() {
  $('prepWrap').hidden = false;
  $('prepResults').innerHTML = '';
  renderPrepTargets();
  renderUploads();
  if (prepState.loaded) return;
  $('prepSrc').textContent = '불러오는 중…';
  const r = await api('prep/load');
  if (!r.ok) return;
  prepState.loaded = true;
  $('prepTitle').value = r.title || '';
  prepState.category = r.category || null;
  $('prepTags').value = (r.tags || []).join(', ');
  // separately typed YouTube title / file name from the last apply (else they follow the Chzzk title)
  prepState.autoYt = !r.ytTitle;
  prepState.autoFile = !r.fileName;
  if (r.ytTitle) $('prepYt').value = r.ytTitle;
  if (r.fileName) $('prepFile').value = r.fileName;
  $('prepSrc').textContent = r.from === 'chzzk' ? '· 치지직에서 불러옴' : '· 마지막으로 적용한 값';
  if (r.warn) toast(r.warn, true);
  renderPrepTargets();
  $('prepTitle').focus();
}
function closePrep() { $('prepWrap').hidden = true; }

function renderPrepTargets() {
  if (!S) return;
  const title = $('prepTitle').value.trim();
  const c = prepState.category;
  $('prepCat').textContent = c ? c.categoryValue || c.categoryId : '없음';
  const yt = S.google?.youtube && S.youtube?.hasKey && S.youtube?.enabled;
  // same clean-up as the upload (Windows can't have \\ / : * ? " < > | in names)
  const safe = (s) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (prepState.autoYt) $('prepYt').value = title ? fillTpl(S.prep?.ytTemplate, title) : '';
  if (prepState.autoFile) $('prepFile').value = title ? safe(fillTpl(S.prep?.fileTemplate, safe(title))) : '';
  $('prepYtAuto').hidden = prepState.autoYt;
  $('prepFileAuto').hidden = prepState.autoFile;
  $('ytHint').textContent = !yt ? '· 연동 안 됨 (설정 창에서 Google 로그인 + 스트림 키)' : prepState.autoYt ? '· 자동 (치지직 제목)' : '· 직접 입력';
  $('fileHint').textContent = prepState.autoFile ? '· 자동 (치지직 제목) — 드라이브에 올릴 때 이름' : '· 직접 입력 — 드라이브에 올릴 때 이름';
  $('prepCatQ').disabled = !S.chzzkOpen?.configured;
  $('prepCatQ').placeholder = S.chzzkOpen?.configured ? '검색해서 바꾸기…' : '치지직 연동 후 검색 가능';
}

let catTimer = null;
$('prepCatQ').addEventListener('input', () => {
  clearTimeout(catTimer);
  const q = $('prepCatQ').value.trim();
  if (!q) { $('prepCats').hidden = true; return; }
  catTimer = setTimeout(async () => {
    const r = await api('prep/categories', { q });
    if (!r.ok) return;
    const items = [{ categoryType: '', categoryId: '', categoryValue: '카테고리 없음' }, ...r.items];
    $('prepCats').innerHTML = items.map((c, i) => `<button type="button" data-i="${i}">${esc(c.categoryValue)}<span class="muted small"> ${esc(c.categoryType)}</span></button>`).join('');
    $('prepCats').hidden = false;
    $('prepCats').onclick = (ev) => {
      const b = ev.target.closest('button[data-i]');
      if (!b) return;
      const c = items[Number(b.dataset.i)];
      prepState.category = c.categoryId ? c : null;
      $('prepCats').hidden = true;
      $('prepCatQ').value = '';
      renderPrepTargets();
    };
  }, 300);
});
$('prepTitle').addEventListener('input', renderPrepTargets);
// typing in the YouTube / file field detaches it from the Chzzk title; ↺ 자동 re-attaches
$('prepYt').addEventListener('input', () => { prepState.autoYt = false; renderPrepTargets(); }); // left empty = automatic on apply
$('prepFile').addEventListener('input', () => { prepState.autoFile = false; renderPrepTargets(); }); // left empty = automatic on apply
$('prepYtAuto').addEventListener('click', () => { prepState.autoYt = true; renderPrepTargets(); });
$('prepFileAuto').addEventListener('click', () => { prepState.autoFile = true; renderPrepTargets(); });
$('prepBtn').addEventListener('click', openPrep);
$('prepClose').addEventListener('click', closePrep);
$('prepWrap').addEventListener('click', (ev) => { if (ev.target === $('prepWrap')) closePrep(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('prepWrap').hidden) closePrep(); });
$('prepApply').addEventListener('click', async () => {
  const btn = $('prepApply');
  btn.disabled = true;
  $('prepNote').textContent = '적용 중…';
  const r = await api('prep/apply', { title: $('prepTitle').value, category: prepState.category, tags: $('prepTags').value, ytTitle: prepState.autoYt ? '' : $('prepYt').value, fileName: prepState.autoFile ? '' : $('prepFile').value });
  btn.disabled = false;
  $('prepNote').textContent = '';
  if (!r.ok) return;
  const line = (name, x, okText) => `<li class="${x.ok ? 'ok' : x.skipped ? 'skip' : 'bad'}">${x.ok ? '✓' : x.skipped ? '–' : '✕'} <b>${name}</b> ${esc(x.ok ? okText : x.error || '')}</li>`;
  $('prepResults').innerHTML =
    line('치지직', r.results.chzzk, '제목·카테고리·태그 적용') +
    line('유튜브', r.results.youtube, r.results.youtube.title || '') +
    line('녹화 파일', r.results.file, `${r.results.file.name}.mp4 (녹화가 끝나면 이 이름으로 올려요)`);
  if (r.results.chzzk.ok !== false && r.results.youtube.ok !== false) toast('방송 준비 적용 완료');
});

function renderUploads() {
  if (!S?.drive || $('prepWrap').hidden) return;
  const d = S.drive;
  $('driveFolder').hidden = !d.folderUrl;
  if (d.folderUrl) $('driveFolder').href = d.folderUrl;
  const vids = (d.items || []).filter((i) => i.kind === 'video');
  let html;
  if (!S.google?.drive) html = '<li class="muted small">Google에 로그인하면 녹화가 끝날 때마다 자동으로 올려요 (방송 PC 설정 창)</li>';
  else if (!vids.length) html = '<li class="muted small">아직 올린 녹화가 없어요. 녹화가 끝나면 여기에 나타나요.</li>';
  else {
    const label = { waiting: d.paused ? '방송·녹화가 끝나면 올려요' : '대기 중', uploading: '올리는 중', done: '완료', error: '실패' };
    html = vids.map((i) => {
      const editable = i.status === 'waiting' && !i.offset;
      const name = editable ? `<input class="up-name" data-id="${esc(i.id)}" value="${esc(i.name)}" title="올리기 전이라 이름을 바꿀 수 있어요">` : i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.name)}</a>` : `<span>${esc(i.name)}</span>`;
      const bar = i.status === 'uploading' || (i.status === 'waiting' && i.offset) ? `<div class="up-bar"><i style="width:${pct(i)}%"></i></div>` : '';
      const retry = i.status === 'error' ? `<button class="btn small-btn" data-up="retry" data-id="${esc(i.id)}">다시 시도</button>` : '';
      const rm = i.status !== 'uploading' ? `<button class="btn ghost small-btn" data-up="remove" data-id="${esc(i.id)}" title="목록에서 지우기 (파일은 그대로)">✕</button>` : '';
      const sizeGb = (i.size / 2 ** 30).toFixed(2);
      return `<li class="up ${i.status}"><div class="up-top">${name}${retry}${rm}</div><div class="muted small">${label[i.status] || i.status}${i.status === 'uploading' || i.offset ? ` · ${pct(i)}%` : ''} · ${sizeGb} GB${i.error ? ` · ${esc(i.error)}` : ''}</div>${bar}</li>`;
    }).join('');
  }
  if (document.activeElement?.classList.contains('up-name')) return; // don't rebuild while a name is being typed
  if ($('upList').innerHTML !== html) $('upList').innerHTML = html;
}
$('upList').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-up]');
  if (b) api(`drive/${b.dataset.up}`, { id: b.dataset.id });
});
$('upList').addEventListener('change', async (ev) => {
  const el = ev.target.closest('.up-name');
  if (!el) return;
  const r = await api('drive/rename', { id: el.dataset.id, name: el.value });
  if (r.ok) toast('업로드 이름을 바꿨어요');
});

// ---------------- banner buttons ----------------
$('banners').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'hide-banner') {
    const key = btn.closest('.banner')?.dataset.key;
    if (key) { hideBanner(key); renderBanners(); }
    return;
  }
  if (btn.dataset.act === 'dismiss-update') {
    updDismissed = UPD?.latest || '';
    try { localStorage.setItem('sd.updDismissed', updDismissed); } catch {}
    renderBanners();
  }
  if (btn.dataset.act === 'yt-adopt') {
    if (!confirm('OBS가 지금 보내고 있는 유튜브 스트림 키를 Allmind가 관리하게 할까요?\n다음 방송부터는 이 키에 비공개 방송을 미리 만들어 둬요. OBS 설정은 그대로 두면 돼요.')) return;
    const r = await api('youtube/adopt');
    if (r.ok) toast(`유튜브 키를 바꿨어요${r.keyName ? `: ${r.keyName}` : ''}`);
  }
  if (btn.dataset.act === 'obs-relaunch') {
    if (!confirm('OBS를 닫았다가 Allmind 옵션으로 다시 켤까요? (10~20초 걸려요)')) return;
    btn.disabled = true; btn.textContent = 'OBS 다시 켜는 중…';
    const r = await api('obs/relaunch');
    btn.disabled = false; btn.textContent = 'OBS 다시 켜기';
    if (r.ok) toast(r.already ? '이미 Allmind 옵션으로 켜져 있어요' : 'OBS를 다시 켰어요 — 연결되면 클릭 전달·리모컨이 돼요');
    return;
  }
  if (btn.dataset.act === 'create-bgm') {
    const r = await api('bgm/create-source');
    if (r.ok) toast(`"${S.bgm.sourceName}" 소스를 "${r.scene}" 장면에 만들었어요`);
  }
  if (btn.dataset.act === 'drive-retry') api('drive/retry', { id: btn.dataset.id });
  if (btn.dataset.act === 'pick-target') {
    // Use the URL's host+path as the match, so query strings (tokens) can change freely.
    let match = btn.dataset.url;
    try { const u = new URL(match); match = u.host + u.pathname; } catch {}
    api('donation/target', { match });
  }
});

// ---------------- keyboard shortcuts ----------------
document.addEventListener('keydown', (ev) => {
  if (!S?.shortcuts) return; // off unless turned on in the settings window
  // never while typing: any text field (even one without type="text"), select, editable element, or an IME composition
  if (ev.isComposing || ev.target.closest?.('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=range]), textarea, select, [contenteditable]')) return;
  if (ev.code === 'Space') { ev.preventDefault(); api('bgm/toggle'); }
  if (ev.key === 'n' || ev.key === 'N') api('bgm/next');
  if (ev.key === 's' || ev.key === 'S') $('skipBtn').click();
  if (ev.key === 'f' || ev.key === 'F') $('fullBtn').click();
  if (/^[0-9]$/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat) { const s = S?.soundboard?.sounds?.[ev.key === '0' ? 9 : Number(ev.key) - 1]; if (s) playSound(s.id); }
  if ((ev.key === 'm' || ev.key === 'M') && !ev.repeat && !ev.ctrlKey && !ev.metaKey && !ev.altKey) markNow();
});

connectEvents();
loadUpdate();
setInterval(loadUpdate, 30 * 60 * 1000);
donationLoop.kick();

// ---------------- live stats ----------------
function renderLive() {
  const { live, history } = S.chzzk;
  const on = !!live?.isLive;
  // the pill also shows OBS's own outputs and opens the 방송 · 녹화 sheet
  const op = S.obsPanel || { stream: {}, record: {} };
  const sending = !!op.stream.active;
  const rec = op.record.active ? `<span class="rec${op.record.paused ? ' paused' : ''}">${op.record.paused ? '녹화 멈춤' : 'REC'}</span>` : '';
  $('livePill').innerHTML = (on ? 'LIVE' : sending ? '송출 중' : 'OFFLINE') + rec;
  $('livePill').classList.toggle('on', on || sending);
  $('livePill').classList.toggle('busy', !!(op.stream.busy || op.record.busy));
  $('livePill').title = '방송 · 녹화 켜기/끄기' + (sending && !on ? '\nOBS는 송출 중이지만 치지직에는 아직 방송이 안 보여요' : '');
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
if (!['text', 'donations'].includes(chatTab)) chatTab = 'text'; // the old 리모컨 / 위플챗 tabs are gone
const MAX_CHAT = 300;

function nickColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 75% 72%)`;
}

// which platform a line came from: a small mark before the badges
const PLAT = {
  chzzk: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="4" fill="#00ffa3"/><path d="M4.2 4.5h7.6L8 9h3.8v2.5H4.2L8 7H4.2z" fill="#0b0f10"/></svg>',
  youtube: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect y="2" width="16" height="12" rx="3.5" fill="#ff0033"/><path d="M6.5 5.4v5.2L10.8 8z" fill="#fff"/></svg>',
};
const platformIcon = (m) => `<span class="plat ${m.platform === 'youtube' ? 'yt' : 'cz'}" title="${m.platform === 'youtube' ? '유튜브' : '치지직'}">${PLAT[m.platform === 'youtube' ? 'youtube' : 'chzzk']}</span>`;

function chatHtml(m) {
  const t = new Date(m.time);
  const tm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  // Emotes arrive as {:name:} plus a name → image URL map.
  const text = esc(m.text).replace(/\{:([^:{}]+):\}/g, (all, name) =>
    m.emojis?.[name] ? `<img class="emo" src="${esc(m.emojis[name])}" alt="${esc(name)}" title="${esc(name)}">` : all);
  if (m.kind === 'system') return `<li class="msg system${m.divider ? ' divider' : ''}" data-id="${m.id}">${text}</li>`;
  const yt = m.platform === 'youtube';
  const role = m.role ? `<span class="role ${m.role}">${m.role === 'streamer' ? '스트리머' : yt ? '모더레이터' : '매니저'}</span>` : '';
  const sub = m.sub ? (m.sub.img ? `<img class="badge sub" src="${esc(m.sub.img)}" alt="구독" title="구독 ${m.sub.months}개월${m.sub.tier > 1 ? ` · ${m.sub.tier}티어` : ''}">`
    : `<span class="sub-pill" title="구독 ${m.sub.months}개월">${m.sub.months}</span>`) : '';
  const member = m.member ? '<span class="sub-pill yt" title="유튜브 채널 멤버">멤버</span>' : '';
  const badges = (m.badges || []).map((u) => `<img class="badge" src="${esc(u)}" alt="">`).join('');
  const verified = m.verified ? '<span class="verified" title="인증된 계정">✔</span>' : '';
  let amt = '';
  if (m.kind === 'donation') {
    if (yt) amt = `<span class="amt">${m.amountText ? `슈퍼챗 · ${esc(m.amountText)}` : '슈퍼챗'}</span>`;
    else {
      const what = m.donationType === 'VIDEO' ? '영도' : m.donationType === 'MISSION' ? '미션' : '후원';
      amt = `<span class="amt">${what} · ${Number(m.amount || 0).toLocaleString('ko-KR')} 치즈</span>`;
    }
  }
  if (m.kind === 'subscription') amt = `<span class="amt">${yt ? '멤버십' : '구독'}${m.months ? ` · ${m.months}개월` : ''}</span>`;
  const click = m.uid && !yt; // the viewer card knows Chzzk viewers only
  const nick = m.nick ? `<span class="nick${click ? ' clickable' : ''}"${click ? ` data-uid="${esc(m.uid)}" title="눌러서 시청자 정보 보기"` : ''} style="color:${nickColor(m.nick)}">${esc(m.nick)}</span>${verified}` : '';
  return `<li class="msg ${m.kind}${yt ? ' yt' : ''}${m.hidden ? ' hidden-msg' : ''}" data-id="${m.id}">${amt}<span class="tm">${tm}</span>${platformIcon(m)}${sub}${member}${badges}${role}${nick}${text}</li>`;
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

// ---------- viewer popup (click a nickname) ----------
// Shows what Allmind has seen from this viewer since it started: chats, recent lines, 후원/구독.
const fmtTime = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// Laid out like Chzzk's own chat popup: picture, badges, follow date, message / 임시 제한 / 활동 제한 counts and
// the 관리 actions. The Chzzk parts come from /api/chzzk/card (through the logged-in 리모컨 dock in OBS) and fill
// in a moment later; Allmind's own numbers (후원, 구독, recent lines) show at once.
const UC_ICON = {
  pin: '<path d="M14 4l6 6-3 1-4 4 .5 4.5L12 21l-3.5-3.5L4 21l-.5-.5L7 17l-3.5-3.5 1.5-1.5 4.5.5 4-4z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" fill="currentColor" stroke="none"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
};
const ucIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UC_ICON[k]}</svg>`;
let ucState = null; // { uid, msgId, at, u, c, arm }

async function openUserCard(uid, at, msgId) {
  const card = $('userCard');
  card.hidden = false;
  ucState = { uid, msgId: msgId || null, at, u: null, c: null, cLoading: true, arm: '' };
  card.innerHTML = '<div class="muted small">불러오는 중…</div>';
  placeCard(card, at);
  const me = ucState;
  fetch(`/api/chzzk/user?uid=${encodeURIComponent(uid)}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    .then((u) => { if (ucState === me) { me.u = u; renderUserCard(); } });
  fetch(`/api/chzzk/card?uid=${encodeURIComponent(uid)}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    .then((c) => { if (ucState === me) { me.c = c?.ok ? c : null; me.cLoading = false; renderUserCard(); } });
}

function renderUserCard() {
  const st = ucState, card = $('userCard');
  if (!st || card.hidden || !st.u) return;
  const u = st.u, p = st.c?.profile || null, n = st.c?.counts || null;
  if (!u.found && !p) { card.innerHTML = st.cLoading ? '<div class="muted small">불러오는 중…</div>' : '<div class="muted small">이 시청자 정보가 아직 없어요</div>'; return; }
  const nick = p?.nick || u.nick || '이름 없음';
  const role = p?.role ?? u.role;
  const sub = p?.sub || u.sub;
  const badges = (sub?.img ? `<img class="badge sub" src="${esc(sub.img)}" alt="구독" title="구독 ${sub.months}개월${sub.tier > 1 ? ` · ${sub.tier}티어` : ''}">` : '')
    + (p?.badges || u.badges || []).map((b) => `<img class="badge" src="${esc(b)}" alt="">`).join('');
  const roleTag = role ? `<span class="role ${role}">${role === 'streamer' ? '스트리머' : '매니저'}</span>` : '';
  const avatar = p?.image ? `<img class="uc-avatar" src="${esc(p.image)}" alt="">` : `<span class="uc-avatar none">${esc([...nick][0] || '?')}</span>`;
  const follow = p ? (p.followDate ? `${p.followDate} 부터 팔로우` : '팔로우하지 않음') : st.cLoading ? '…' : '';
  const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ko-KR'));
  // Chzzk's counts when the dock could ask for them; else what Allmind saw since it started
  const stats = n
    ? [['메시지', num(n.messages)], ['임시 제한', num(n.tempRestricts)], ['활동 제한', num(n.restricts) + (n.restricted ? ' <small>(제한 중)</small>' : '')]]
    : [['메시지', `${num(u.chats || 0)}<small title="Allmind가 켜진 뒤 본 채팅">*</small>`], ['임시 제한', st.cLoading ? '…' : '—'], ['활동 제한', st.cLoading ? '…' : '—']];
  const extra = [
    u.donations?.count ? `후원 ${u.donations.count}번 · ${u.donations.total.toLocaleString('ko-KR')} 치즈` : '',
    sub?.months ? `구독 ${sub.months}개월` : u.subMonths ? `구독 ${u.subMonths}개월` : '',
    u.firstSeen ? `Allmind에서 처음 본 시각 ${fmtTime(u.firstSeen)}` : '',
  ].filter(Boolean).join(' · ');
  const lines = (u.recent || []).map((r) => {
    const text = esc(r.text).replace(/\{:([^:{}]+):\}/g, (all, name) => r.emojis?.[name] ? `<img class="emo" src="${esc(r.emojis[name])}" alt="${esc(name)}">` : all);
    const tag = r.kind === 'donation' ? `<span class="uc-tag don">${Number(r.amount || 0).toLocaleString('ko-KR')}</span>` : r.kind === 'subscription' ? '<span class="uc-tag sub">구독</span>' : '';
    return `<li><span class="tm">${fmtTime(r.time)}</span>${tag}${text || '<span class="muted">(내용 없음)</span>'}</li>`;
  }).join('');
  // actions — the dangerous ones ask for a second press
  const can = !!st.c?.canManage, isStreamer = role === 'streamer', isMgr = role === 'manager';
  const act = (key, icon, label, { need = can, danger = false, confirm = '', title = '' } = {}) => {
    const armed = st.arm === key;
    const off = !need;
    return `<button class="uc-act${danger ? ' danger' : ''}${armed ? ' armed' : ''}" data-act="${key}"${off ? ' disabled' : ''}${confirm ? ` data-confirm="1"` : ''} title="${esc(off ? (title || 'OBS의 치지직 리모컨 독(네이버 로그인)이 연결되어 있어야 해요') : title)}">${ucIcon(icon)}<span>${armed ? esc(confirm) : esc(label)}</span></button>`;
  };
  const acts = isStreamer ? '' : [
    act('notice', 'pin', '메시지 상단 고정', { need: can && !!st.msgId, title: st.msgId ? '' : '채팅 목록에서 메시지의 닉네임을 눌렀을 때만 돼요' }),
    isMgr ? act('unmanager', 'shield', '채팅 운영자 해제', { confirm: '한 번 더 누르면 운영자에서 해제해요' })
      : act('manager', 'shield', '채팅 운영자 임명', { confirm: '한 번 더 누르면 채팅 운영자로 임명해요' }),
    act('temp', 'clock', '임시 제한', { confirm: '한 번 더 누르면 임시 제한해요' }),
    n?.restricted ? act('unrestrict', 'user', '활동 제한 해제', { confirm: '한 번 더 누르면 활동 제한을 풀어요' })
      : act('restrict', 'user', '활동 제한', { confirm: '한 번 더 누르면 활동 제한해요 (채널에서 채팅 금지)' }),
    act('blind', 'trash', '메시지 삭제', { need: !!st.msgId && (can || !!S?.chzzkOpen?.loggedIn), danger: true, confirm: '한 번 더 누르면 이 메시지를 삭제해요',
      title: st.msgId ? '치지직 연동 로그인 또는 리모컨 독이 필요해요' : '채팅 목록에서 메시지의 닉네임을 눌렀을 때만 돼요' }),
  ].join('');
  const err = st.c?.errors?.length ? `<div class="uc-err" title="${esc(st.c.errors.join('\n'))}">치지직 정보 일부를 못 가져왔어요</div>` : '';
  card.innerHTML = `
    <div class="uc-top">
      ${avatar}
      <div class="uc-who"><div class="uc-name"><span class="nick" style="color:${nickColor(nick)}">${esc(nick)}</span>${p?.verified ? '<span class="verified" title="인증된 계정">✔</span>' : ''}${roleTag}</div>
        <div class="uc-badges">${badges}</div></div>
      ${u.channelUrl ? `<a class="btn ghost icon uc-ic" href="${esc(u.channelUrl)}" target="_blank" rel="noopener" title="치지직 채널 열기">${ucIcon('out')}</a>` : ''}
      <button class="btn ghost icon uc-x" title="닫기">✕</button>
    </div>
    ${follow ? `<div class="uc-follow">${ucIcon('heart')}<span>${esc(follow)}</span></div>` : ''}
    <div class="uc-stats">${stats.map(([k, v]) => `<div class="uc-stat"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${extra ? `<div class="muted small">${extra}</div>` : ''}
    ${err}
    ${acts ? `<div class="uc-acts">${acts}</div>` : ''}
    ${lines ? `<details class="uc-recent"><summary>최근 채팅 ${u.recent.length}줄 <span class="muted">(Allmind가 켜진 뒤)</span></summary><ol class="uc-lines">${lines}</ol></details>` : ''}`;
  placeCard(card, st.at);
}

$('userCard').addEventListener('click', async (ev) => {
  const b = ev.target.closest('.uc-act');
  if (!b || b.disabled || !ucState) return;
  ev.stopPropagation();
  const key = b.dataset.act, st = ucState;
  if (b.dataset.confirm && st.arm !== key) { st.arm = key; renderUserCard(); clearTimeout(st.armT); st.armT = setTimeout(() => { if (st.arm === key) { st.arm = ''; renderUserCard(); } }, 4000); return; }
  st.arm = '';
  b.disabled = true;
  const r = await api('chzzk/act', { action: key, uid: st.uid, msgId: st.msgId });
  if (r.ok) {
    toast(r.done);
    if (ucState === st) { st.cLoading = true; openUserCard(st.uid, st.at, st.msgId); }
  } else if (ucState === st) renderUserCard();
});

function placeCard(card, at) {
  if (window.matchMedia('(max-width: 640px)').matches) { card.style.left = card.style.top = ''; return; } // phones: bottom sheet (CSS)
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(at.x + 8, innerWidth - r.width - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(at.y + 8, innerHeight - r.height - 8))}px`;
}
for (const id of ['chatList', 'donList']) {
  $(id).addEventListener('click', (ev) => {
    const n = ev.target.closest('[data-uid]');
    if (!n) return;
    ev.stopImmediatePropagation(); // not the 후원 card's own click (mark as read)
    // from the chat list we also know which message (상단 고정 / 메시지 삭제)
    const li = id === 'chatList' ? n.closest('li[data-id]') : null;
    openUserCard(n.dataset.uid, { x: ev.clientX, y: ev.clientY }, li ? Number(li.dataset.id) : null);
  });
}
document.addEventListener('click', (ev) => {
  const card = $('userCard');
  if (!card.hidden && (ev.target.closest('.uc-x') || !ev.target.closest('#userCard'))) card.hidden = true;
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') $('userCard').hidden = true; });
$('newMsgs').addEventListener('click', () => {
  $('chatList').scrollTop = $('chatList').scrollHeight;
  $('newMsgs').hidden = true;
});

function setChatTab(tab) {
  chatTab = tab;
  pref.set('chatTab', tab);
  for (const b of $('chatTabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('chatText').hidden = tab !== 'text';
  $('chatSend').hidden = tab !== 'text';
  $('chatDonations').hidden = tab !== 'donations';

  renderChatState();
  window.syncAlertMirror?.(); // defined further down, once the 후원 tab code has loaded
}
$('chatTabs').addEventListener('click', (ev) => { if (ev.target.dataset?.tab) setChatTab(ev.target.dataset.tab); });

// ---------- sending chat (official CHZZK API, as the logged-in streamer account) ----------
let chatSending = false, chatLastSent = 0;
function renderChatSend() {
  const ok = !!S?.chzzkOpen?.loggedIn;
  $('chatInput').disabled = !ok;
  $('chatSendBtn').disabled = !ok || chatSending;
  $('chatInput').placeholder = ok ? '채팅 보내기 (Enter)' : '채팅을 보내려면 설정 창에서 치지직 연동 로그인';
}
$('chatInput').addEventListener('input', () => {
  const n = [...$('chatInput').value].length;
  $('chatCount').textContent = n > 80 ? `${n}/100` : '';
});
$('chatSend').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || chatSending) return;
  if (Date.now() - chatLastSent < 1000) return toast('조금 천천히 보내 주세요', true);
  chatSending = true; renderChatSend();
  const r = await api('chat/send', { message: text });
  chatSending = false; chatLastSent = Date.now();
  if (r.ok) { $('chatInput').value = ''; $('chatCount').textContent = ''; }
  renderChatSend();
  $('chatInput').focus();
});

function renderChatState() {
  if (!S) return;
  renderChatSend();
  renderTopChecks();
  const { channelId, chat } = S.chzzk;
  $('channelForm').hidden = !!channelId;
  if (!channelId && chatTab === 'donations') $('donList').innerHTML = '<li class="don-empty">치지직 채널을 연결하면 후원이 여기에 모여요</li>';
  $('remoteBtn').disabled = !channelId;
  const dot = $('chatDot');
  dot.className = 'state-dot ' + (chat.state === 'connected' ? 'ok' : chat.state === 'error' ? 'bad' : channelId ? 'warn' : '');
  const yc = S.ytChat;
  const ko = (x) => ({ connected: '연결됨', connecting: '연결 중', error: '문제 있음', idle: '대기', off: '꺼짐' })[x] || x;
  dot.title = `치지직: ${chat.error || ko(chat.state)}` + (yc && yc.state !== 'off' ? `\n유튜브: ${yc.error || ko(yc.state)}` : '');
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
  window.dockRefresh?.();
  pref.set('chatVisible', show);
}
$('chatToggle').addEventListener('click', () => applyChatVisible($('layout').classList.contains('no-chat')));
applyChatVisible(pref.get('chatVisible', true));
setChatTab(chatTab);

// ---------------- 치지직 리모컨 ----------------
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
    <div class="don-top"><span class="don-amt">${amt}</span><span class="don-type">${type}</span><span class="don-nick${d.uid ? ' clickable' : ''}"${d.uid ? ` data-uid="${esc(d.uid)}"` : ''}>${esc(d.nick || '익명')}</span><span class="tm">${tm}</span></div>
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
      ? '방송 PC의 Allmind 설정 → "도네 알림 브라우저 소스"에서 소스를 골라 주세요'
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
  $('musicAuto').hidden = t !== 'auto';
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
      const musicMin = document.querySelector('#musicBgm').hidden ? 200 : $('bgmPlayer').scrollHeight + 150;
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
  donationLoop.sync(); programLoop.sync(); alertMirrorLoop.sync();
}
function setMobilePanel(p) {
  if (p === 'xylem') return setXylem(true);
  if (xylemOpen) setXylem(false);
  pref.set('mPanel', p);
  for (const c of ['chat', 'music', 'alert', 'todo']) document.body.classList.toggle('mp-' + c, c === p);
  for (const b of $('mnav').children) b.classList.toggle('on', b.dataset.mp === p);
  syncMirrors();
}

// ---------------- Xylem inside the dashboard ----------------
// The 🎮 Xylem button (and the phone tab) swaps the dashboard panels for the Xylem page, so a phone or iPad
// doesn't have to juggle two tabs. The page is loaded the first time and then only hidden — switching back
// is instant and the panels keep their place. While Xylem shows, the dashboard's OBS pictures stop; while the
// dashboard shows, the hidden Xylem page stops polling. Ctrl/Shift/middle-click still opens a separate window.
let xylemOpen = false;
function setXylem(on) {
  xylemOpen = !!on;
  pref.set('xylemOpen', xylemOpen);
  const f = $('xyFrame');
  if (xylemOpen && !f.src) f.src = '/xylem?embed=1';
  $('xyView').hidden = !xylemOpen;
  document.body.classList.toggle('xy-open', xylemOpen);
  $('xylemBtn').textContent = xylemOpen ? '← 대시보드' : '🎮 Xylem';
  $('xylemBtn').classList.toggle('accent', xylemOpen);
  const mp = pref.get('mPanel', 'chat');
  for (const b of $('mnav').children) b.classList.toggle('on', xylemOpen ? b.dataset.mp === 'xylem' : b.dataset.mp === mp);
  try { f.contentWindow?.postMessage({ allmind: 'xylem-visible', visible: xylemOpen }, location.origin); } catch {}
  syncMirrors();
  window.dockRefresh?.();
}
$('xylemBtn').addEventListener('click', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return; // a separate window, as before
  ev.preventDefault();
  buzz();
  setXylem(!xylemOpen);
});
// the embedded page's "← 대시보드" / "새 창" buttons
addEventListener('message', (ev) => {
  if (ev.origin !== location.origin || ev.source !== $('xyFrame').contentWindow) return;
  if (ev.data?.allmind === 'xylem-close') setXylem(false);
  if (ev.data?.allmind === 'xylem-ready') ev.source.postMessage({ allmind: 'xylem-visible', visible: xylemOpen }, location.origin);
});
$('mnav').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mp]');
  if (b) { buzz(); setMobilePanel(b.dataset.mp); }
});
setMobilePanel(pref.get('mPanel', 'chat') === 'xylem' ? 'chat' : pref.get('mPanel', 'chat'));
if (pref.get('xylemOpen', false)) setXylem(true);
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
  for (const m of [donationLoop, programLoop, alertMirrorLoop]) m.restart();
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

// phones: the 리모컨 button lives in the ⚙ menu (no room in the top bar)
$('devRemote').addEventListener('click', () => { $('devMenu').hidden = true; openRemoteWindow(); });

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
  } catch { toast('Allmind에 연결할 수 없어요', true); }
}
$('markBtn').addEventListener('click', markNow);
$('markMore').addEventListener('click', (ev) => { ev.stopPropagation(); $('markMenu').hidden = !$('markMenu').hidden; });
document.addEventListener('click', (ev) => {
  if (!$('markMenu').hidden && !ev.target.closest('#markMenu, #markMore')) $('markMenu').hidden = true;
});

// why the OBS-load guard is holding the previews back
function guardText(f) {
  return f.why === 'encode' ? ' · OBS 부하 보호 중 (인코딩 지연)' : f.why === 'render' ? ' · OBS 부하 보호 중 (렌더링 지연)' : ' · OBS 부하 보호 중';
}


// ---------------- 사운드보드 ----------------
// One button per file in the soundboard folder. A new sound replaces the one
// playing; pressing the playing one stops it. Keys 1–9, 0 play the first ten.
let sbKey = '';
function renderSoundboard() {
  const sb = S.soundboard;
  if (!sb) return;
  const msg = $('sbMsg');
  let text = '', html = '';
  if (sb.folderError === 'none') text = '방송 PC의 Allmind 설정에서 사운드보드 폴더를 지정하면 여기에 버튼이 생겨요';
  else if (sb.folderError) text = sb.folderError;
  else if (!S.obs?.connected) text = 'OBS 연결을 기다리는 중…';
  else if (!sb.sourceOk) html = `OBS에 <b>${esc(sb.sourceName)}</b> 소스가 없어요 <button class="btn small-btn" id="sbCreate">만들기</button><br><span class="muted">BGM 소스가 있는 모든 장면(또는 그룹)에 추가돼요</span>`;
  else if (!sb.sounds.length) text = '폴더에 사운드 파일이 없어요';
  if (html) { if (msg.dataset.h !== html) { msg.innerHTML = html; msg.dataset.h = html; } } else { msg.textContent = text; msg.dataset.h = ''; }
  msg.hidden = !text && !html;
  if (document.activeElement !== $('sbVol')) $('sbVol').value = sb.volumeDb;
  $('sbVolVal').textContent = `${sb.volumeDb} dB`;
  $('sbStop').disabled = !sb.playing;
  const grid = $('sbGrid');
  const key = sb.sounds.map((s) => s.id).join('|') + '#' + sb.sourceOk;
  if (key !== sbKey) {
    sbKey = key;
    grid.textContent = '';
    sb.sounds.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'sb-btn';
      b.dataset.id = s.id;
      b.title = s.id;
      b.disabled = !sb.sourceOk;
      if (i < 10) { const k = document.createElement('span'); k.className = 'sb-key'; k.textContent = i === 9 ? '0' : String(i + 1); b.append(k); }
      const t = document.createElement('span'); t.className = 'sb-title'; t.textContent = s.title;
      b.append(t);
      grid.append(b);
    });
  }
  for (const b of grid.children) b.classList.toggle('playing', b.dataset.id === sb.playing);
}
function playSound(id) {
  buzz();
  const b = [...$('sbGrid').children].find((x) => x.dataset.id === id);
  if (b) { b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit'); }
  api('sb/play', { id });
}
$('sbGrid').addEventListener('click', (ev) => {
  const b = ev.target.closest('.sb-btn');
  if (b) playSound(b.dataset.id);
});
$('sbMsg').addEventListener('click', async (ev) => {
  if (ev.target.id !== 'sbCreate') return;
  ev.target.disabled = true;
  const r = await api('sb/create-source');
  if (r.ok) toast(`사운드보드 소스를 만들었어요 (${(r.scenes || []).join(', ')})`);
  ev.target.disabled = false;
});
$('sbStop').addEventListener('click', () => api('sb/stop'));
$('sbVol').addEventListener('input', () => { $('sbVolVal').textContent = `${$('sbVol').value} dB`; });
$('sbVol').addEventListener('change', () => api('sb/volume', { db: Number($('sbVol').value) }));


// ---------------- 채팅 화면 지우기 · 방송 전 점검 · 방송 기록 ----------------
$('chatClearBtn').addEventListener('click', async () => {
  if (!confirm('채팅 화면을 지울까요? (모든 기기에서 지워져요. 후원 목록과 시청자 정보는 그대로예요)')) return;
  await api('chat/clear');
});

function renderTopChecks() {
  const p = S?.preflight;
  const b = $('checkBadge');
  const n = p ? p.bad + p.warn : 0;
  b.hidden = !n;
  b.textContent = n;
  b.className = p?.bad ? 'bad' : '';
  $('checkBtn').title = p ? (n ? `방송 전 점검: 문제 ${p.bad}개, 확인할 것 ${p.warn}개` : '방송 전 점검: 모두 괜찮아요') : '방송 전 점검';
  const r = S?.reports;
  $('reportDot').hidden = !r?.unseen;
}

const CHECK_IC = { ok: '✅', warn: '⚠️', bad: '❌', info: 'ℹ️', off: '–' };
async function runCheck() {
  $('checkRun').disabled = true;
  $('checkSum').textContent = '점검하는 중…'; $('checkSum').className = 'check-sum';
  const r = await api('preflight');
  $('checkRun').disabled = false;
  if (!r.ok) return;
  const t = new Date(r.at);
  $('checkWhen').textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 점검`;
  $('checkSum').className = `check-sum ${r.bad ? 'bad' : r.warn ? 'warn' : 'ok'}`;
  $('checkSum').textContent = r.bad ? `❌ 방송 전에 고쳐야 할 것 ${r.bad}개${r.warn ? ` · 확인할 것 ${r.warn}개` : ''}` : r.warn ? `⚠️ 확인할 것 ${r.warn}개 — 나머지는 괜찮아요` : '✅ 모두 괜찮아요 — 방송 준비 끝!';
  const groups = [];
  for (const it of r.items) { let g = groups.find((x) => x.name === it.group); if (!g) groups.push(g = { name: it.group, items: [] }); g.items.push(it); }
  $('checkList').innerHTML = groups.map((g) => `<div class="check-group"><h4>${esc(g.name)}</h4>${g.items.map((it) => `<div class="check-row ${it.status}"><span class="ic">${CHECK_IC[it.status] || ''}</span><span class="lb">${esc(it.label)}<span>${esc(it.detail)}</span></span>${it.fix ? `<span class="fx">→ ${esc(it.fix)}</span>` : '<span></span>'}</div>`).join('')}</div>`).join('');
}
$('checkBtn').addEventListener('click', () => { $('checkWrap').hidden = false; runCheck(); });
$('checkRun').addEventListener('click', runCheck);
$('checkClose').addEventListener('click', () => { $('checkWrap').hidden = true; });
$('checkWrap').addEventListener('click', (ev) => { if (ev.target === $('checkWrap')) $('checkWrap').hidden = true; });

const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
const fmtWhen = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
async function showReport(id) {
  const r = await api('report', id ? { id } : {});
  if (!r.ok) return;
  $('reportPick').innerHTML = r.list.map((x) => `<option value="${esc(x.id)}">${esc(fmtWhen(x.startedAt))} · ${esc(x.title || '제목 없음').slice(0, 30)}</option>`).join('') || '<option>아직 없어요</option>';
  const p = r.report;
  if (!p) { $('reportBody').innerHTML = `<p class="muted">${r.live ? '지금 방송 중이에요 — 방송이 끝나면 리포트가 생겨요.' : '아직 리포트가 없어요. OBS로 방송을 켰다가 끄면 저절로 만들어져요.'}</p>`; return; }
  $('reportPick').value = p.id;
  if (!p.stale && r.latest?.id === p.id) api('report/seen', { id: p.id });
  const h = p.health || {};
  const q = (v, warn, bad) => (v == null ? '<span class="muted">–</span>' : `<span class="${v >= bad ? 'rep-bad' : v >= warn ? 'rep-warn' : 'rep-good'}">${v}%</span>`);
  const card = (k, v, sub = '') => `<div class="rep-card"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const up = p.uploads || [];
  const upHtml = up.length ? up.map((u) => `<li>${esc(u.name)} — ${u.status === 'done' ? `<span class="rep-good">올림</span>${u.url ? ` · <a href="${esc(u.url)}" target="_blank" rel="noopener">열기</a>` : ''}` : u.status === 'uploading' ? `올리는 중 ${u.pct}%` : u.status === 'error' ? `<span class="rep-bad">실패</span> ${esc(u.error || '')}` : '대기 중'}</li>`).join('') : '<li class="muted">이 방송의 녹화 업로드가 없어요</li>';
  $('reportBody').innerHTML = `
    <div class="rep-title">${esc(p.title || '제목 없음')}</div>
    <div class="rep-when">${esc(fmtWhen(p.startedAt))} – ${esc(fmtWhen(p.endedAt))}${p.category ? ` · ${esc(p.category)}` : ''}${p.stale ? ' · Allmind가 꺼져 있어서 끝 부분은 빠졌을 수 있어요' : ''}</div>
    <div class="rep-grid">
      ${card('방송 시간', fmtDur(p.endedAt - p.startedAt))}
      ${card('최고 시청자', p.peak.toLocaleString())}
      ${card('채팅', p.chats.toLocaleString(), `${p.chatters}명 참여 · 처음 온 ${p.newChatters}명`)}
      ${card('후원', `${p.cheese.toLocaleString()} 치즈`, `${p.donations}건${p.videos ? ` · 영도 ${p.videos}` : ''}`)}
      ${card('구독', p.subs)}
      ${card('⭐ 마크', p.marks)}
      ${card('룰렛', `${p.roulette.spins}회`, p.roulette.todo.length ? `<span class="rep-warn">남은 결과 ${p.roulette.todo.length}개</span>` : '')}
      ${card('방송 품질', h.dropPct == null ? '–' : `${h.dropPct}%`, `드롭 ${h.dropFrames ?? '–'}프레임 · 렌더 ${h.renderPct ?? '–'}% · 인코딩 ${h.encodePct ?? '–'}%`)}
    </div>
    <div class="rep-sec"><h4>방송 품질</h4><ul>
      <li>네트워크 드롭: ${q(h.dropPct, 0.5, 2)} · 렌더 지연: ${q(h.renderPct, 0.5, 2)} · 인코딩 지연: ${q(h.encodePct, 0.5, 2)}</li>
    </ul></div>
    <div class="rep-sec"><h4>유튜브 아카이브</h4><ul><li>${!p.yt?.enabled ? '<span class="muted">안 씀</span>' : p.yt.live ? `<span class="rep-good">비공개로 올라갔어요</span> · ${esc(p.yt.title || '')}${p.yt.id ? ` · <a href="https://studio.youtube.com/video/${esc(p.yt.id)}/edit" target="_blank" rel="noopener">유튜브 스튜디오</a>` : ''}` : '<span class="rep-bad">유튜브 방송이 시작되지 않았어요</span>'}</li></ul></div>
    <div class="rep-sec"><h4>녹화 업로드</h4><ul>${upHtml}</ul></div>
    ${p.plan && (p.plan.done.length || p.plan.left.length) ? `<div class="rep-sec"><h4>할 일</h4><ul>${p.plan.done.map((t) => `<li class="rep-good">✔ ${esc(t)}</li>`).join('')}${p.plan.left.map((t) => `<li class="muted">다음에: ${esc(t)}</li>`).join('')}</ul></div>` : ''}
    ${p.roulette.todo.length ? `<div class="rep-sec"><h4>아직 안 한 룰렛 결과</h4><ul>${p.roulette.todo.slice(0, 10).map((t) => `<li>${esc(t.nick)} — ${esc(t.result)}</li>`).join('')}${p.roulette.todo.length > 10 ? `<li class="muted">외 ${p.roulette.todo.length - 10}개 — Xylem 창의 룰렛 기록에서 완료 체크</li>` : ''}</ul></div>` : ''}
    <div class="rep-sec"><h4>방송 중 생긴 문제</h4><ul>${p.problems.length ? p.problems.map((x) => `<li>${esc(new Date(x.at).toTimeString().slice(0, 5))} ${esc(x.text)}</li>`).join('') : '<li class="rep-good">없었어요</li>'}</ul></div>`;
}
$('reportBtn').addEventListener('click', () => { $('reportWrap').hidden = false; showReport(); });
$('reportPick').addEventListener('change', () => showReport($('reportPick').value));
$('reportClose').addEventListener('click', () => { $('reportWrap').hidden = true; });
$('reportWrap').addEventListener('click', (ev) => { if (ev.target === $('reportWrap')) $('reportWrap').hidden = true; });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { $('checkWrap').hidden = true; $('reportWrap').hidden = true; } });


// ---------------- 할 일 (오늘 / 창고 / 한 것) ----------------
// A place for the games, content and talk topics thought of between streams, so they aren't forgotten
// once the stream starts. 오늘 = picked for this stream (shown again when the stream starts), 창고 = all ideas,
// 한 것 = checked off (moved there when the stream ends). Checking one off while recording drops a ⭐ mark.
(() => {
  let items = [], tags = [];
  let tab = pref.get('todoTab', 'tonight');
  let filter = '';                       // 창고: tag filter
  let oldest = pref.get('todoOldest', true); // 창고: oldest first, so ideas don't sink
  let editing = null;                    // item id being edited
  let armed = null;                      // item id whose ✕ was pressed once
  const panel = $('todoPanel');
  const fold = (on) => { panel.classList.toggle('folded', on); pref.set('todoFolded', on); };
  fold(pref.get('todoFolded', true)); // fixed layouts: folded until opened (a tab in the free layout)

  const age = (t) => {
    const d = Math.floor((Date.now() - t) / 86400000);
    return d < 1 ? '오늘' : d < 7 ? `${d}일` : d < 60 ? `${Math.floor(d / 7)}주` : `${Math.floor(d / 30)}달`;
  };
  const dayOf = (t) => { const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
  const tagHtml = (t) => (t ? `<span class="td-tag t-${esc(t)}">${esc(t)}</span>` : '');
  const noteHtml = (it) => (it.note ? `<span class="td-note" title="${esc(it.note)}">📝</span>` : '');

  function itemHtml(it) {
    if (editing === it.id) {
      return `<li class="todo-edit" data-id="${esc(it.id)}">
        <input data-f="title" value="${esc(it.title)}" maxlength="120">
        <select data-f="tag"><option value="">분류 없음</option>${tags.map((t) => `<option${t === it.tag ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <textarea data-f="note" placeholder="메모 (링크, 준비할 것…)" maxlength="1000">${esc(it.note)}</textarea>
        <div class="row-btns"><button class="btn accent small-btn" data-do="save">저장</button><button class="btn ghost small-btn" data-do="cancel">취소</button>
        <button class="btn ghost small-btn${armed === it.id ? ' danger' : ''}" data-do="del" style="margin-left:auto">${armed === it.id ? '한 번 더 누르면 지워요' : '지우기'}</button></div></li>`;
    }
    const title = `<span class="td-title" data-do="edit" title="눌러서 고치기${it.note ? '\n\n' + esc(it.note) : ''}">${esc(it.title)}${noteHtml(it)}</span>`;
    if (it.status === 'tonight') {
      return `<li class="td-item${it.done ? ' done' : ''}" data-id="${esc(it.id)}"><input type="checkbox" data-do="check"${it.done ? ' checked' : ''} title="했어요 (녹화 중이면 ⭐ 마크도)">${title}${tagHtml(it.tag)}
        ${it.done ? '' : '<button class="td-act" data-do="to-idea" title="창고로 돌려보내기">↩</button>'}</li>`;
    }
    if (it.status === 'idea') {
      return `<li class="td-item" data-id="${esc(it.id)}">${tagHtml(it.tag)}${title}<span class="td-age" title="창고에 들어온 지">${age(it.moved)}</span>
        <button class="td-act go" data-do="to-tonight" title="이번 방송에 하기">오늘 +</button></li>`;
    }
    return `<li class="td-item done" data-id="${esc(it.id)}">${tagHtml(it.tag)}${title}<button class="td-act" data-do="to-idea" title="다시 창고로 (또 하고 싶을 때)">↩</button></li>`;
  }

  function render() {
    const tonight = items.filter((x) => x.status === 'tonight');
    const ideas = items.filter((x) => x.status === 'idea');
    const done = items.filter((x) => x.status === 'done');
    const open = tonight.filter((x) => !x.done).length;
    $('tdN1').textContent = open ? String(open) : '';
    $('mnavTodo').textContent = open ? String(open) : '';
    $('tdN2').textContent = ideas.length ? String(ideas.length) : '';
    for (const b of $('todoTabs').children) b.classList.toggle('on', b.dataset.tt === tab);
    $('todoInput').placeholder = tab === 'tonight' ? '오늘 할 것 추가 (Enter)' : '생각난 것 바로 적기 (Enter)';
    // 창고: tag filter + sort
    if (tab === 'idea' && ideas.length) {
      const used = tags.filter((t) => ideas.some((x) => x.tag === t));
      $('todoFilter').innerHTML = (used.length ? ['', ...used].map((t) => `<button class="td-chip${filter === t ? ' on' : ''}" data-filter="${esc(t)}">${t ? esc(t) : '전체'}</button>`).join('') : '')
        + `<button class="td-sort" data-do="sort">${oldest ? '오래된 것부터 ▾' : '최근 것부터 ▾'}</button>`;
    } else $('todoFilter').innerHTML = '';
    let list, empty;
    if (tab === 'tonight') {
      list = [...tonight].sort((a, b) => a.done - b.done || a.moved - b.moved);
      empty = ideas.length ? `오늘 할 걸 아직 안 골랐어요<br><button class="btn small-btn" data-goto="idea" style="margin-top:6px">창고에서 고르기 (${ideas.length})</button>` : '위 칸에 오늘 할 것을 적어 보세요';
    } else if (tab === 'idea') {
      list = ideas.filter((x) => !filter || x.tag === filter).sort((a, b) => (oldest ? a.moved - b.moved : b.moved - a.moved));
      empty = '생각난 게임·콘텐츠·이야깃거리를 위 칸에 바로 적어 두세요';
    } else {
      list = [...done].sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
      empty = '방송에서 체크한 것이 방송이 끝나면 여기로 와요';
    }
    let html = '', lastDay = '';
    for (const it of list) {
      if (tab === 'done') { const d = dayOf(it.doneAt || it.moved); if (d !== lastDay) { html += `<li class="td-day">${d}</li>`; lastDay = d; } }
      html += itemHtml(it);
    }
    $('todoList').innerHTML = html || `<li class="td-empty">${empty}</li>`;
  }

  window.todoState = (v) => {
    items = v.items || []; tags = v.tags || [];
    if (!$('todoTag').options.length || $('todoTag').options.length !== tags.length + 1) {
      $('todoTag').innerHTML = '<option value="">분류</option>' + tags.map((t) => `<option>${esc(t)}</option>`).join('');
    }
    if (editing && !items.some((x) => x.id === editing)) editing = null;
    // don't wipe an edit in progress
    if (editing && $('todoList').contains(document.activeElement)) return;
    render();
  };

  function setTab(t) { tab = t; pref.set('todoTab', t); editing = null; armed = null; render(); }
  $('todoTabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tt]'); if (b) { fold(false); setTab(b.dataset.tt); } });
  $('todoFold').addEventListener('click', () => fold(!panel.classList.contains('folded')));
  panel.querySelector('.panel-head h2').addEventListener('click', () => fold(!panel.classList.contains('folded')));

  $('todoAdd').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = $('todoInput').value.trim();
    if (!title) return;
    if (tab === 'done') setTab('idea');
    const r = await api('todo/add', { title, tag: $('todoTag').value, tonight: tab === 'tonight' });
    if (r.ok) { $('todoInput').value = ''; $('todoTag').value = ''; if (tab === 'tonight') toast('오늘 할 것에 넣었어요'); }
  });

  $('todoFilter').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-filter]');
    if (c) { filter = c.dataset.filter; render(); return; }
    if (ev.target.closest('[data-do=sort]')) { oldest = !oldest; pref.set('todoOldest', oldest); render(); }
  });

  $('todoList').addEventListener('click', async (ev) => {
    const go = ev.target.closest('[data-goto]');
    if (go) { setTab(go.dataset.goto); return; }
    const el = ev.target.closest('[data-do]');
    const li = ev.target.closest('[data-id]');
    if (!el || !li) return;
    const id = li.dataset.id, what = el.dataset.do;
    if (what === 'check') {
      buzz();
      const r = await api('todo/check', { id, done: el.checked });
      if (r.ok && r.marked) toast(`⭐ "${r.item.title}" — 녹화에 마크도 남겼어요`);
      return;
    }
    if (what === 'edit') { editing = id; armed = null; render(); $('todoList').querySelector('[data-f=title]')?.focus(); return; }
    if (what === 'cancel') { editing = null; armed = null; render(); return; }
    if (what === 'save') {
      const f = (k) => li.querySelector(`[data-f=${k}]`).value;
      const r = await api('todo/update', { id, patch: { title: f('title'), tag: f('tag'), note: f('note') } });
      if (r.ok) { editing = null; render(); }
      return;
    }
    if (what === 'del') {
      if (armed !== id) { armed = id; render(); setTimeout(() => { if (armed === id) { armed = null; render(); } }, 4000); return; }
      armed = null; editing = null;
      await api('todo/remove', { id });
      return;
    }
    if (what === 'to-tonight') { buzz(); const r = await api('todo/update', { id, patch: { status: 'tonight' } }); if (r.ok) toast(`오늘 할 것: ${r.item.title}`); return; }
    if (what === 'to-idea') { await api('todo/update', { id, patch: { status: 'idea' } }); return; }
  });
  $('todoList').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('.todo-edit input')) { ev.preventDefault(); ev.target.closest('.todo-edit').querySelector('[data-do=save]').click(); }
    if (ev.key === 'Escape' && editing) { editing = null; render(); }
  });

  // show the panel (from the reminder): free layout → its tab, phones → 음악 tab, fixed layout → unfold
  function openPanel(t) {
    if (typeof xylemOpen !== 'undefined' && xylemOpen) setXylem(false);
    fold(false);
    setTab(t);
    if (!window.dockShow?.('todo') && matchMedia('(max-width: 640px), (max-height: 500px) and (orientation: landscape)').matches) setMobilePanel('todo');
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // the stream started: what was planned for tonight
  window.todoReminder = (r) => {
    const t = r.tonight || [];
    if (!t.length && !r.ideas) return;
    $('todoPopBody').innerHTML = t.length
      ? `<div><b>오늘 할 것 ${t.length}개</b></div><ol>${t.map((x) => `<li>${esc(x.title)}${x.tag ? ` <span class="td-tag t-${esc(x.tag)}">${esc(x.tag)}</span>` : ''}</li>`).join('')}</ol>`
      : `<p>오늘 할 것을 아직 안 골랐어요.<br><span class="muted">창고에 ${r.ideas}개가 기다리고 있어요.</span></p>`;
    $('todoPopOpen').textContent = t.length ? '할 일 열기' : '창고 열기';
    $('todoPopOpen').dataset.tab = t.length ? 'tonight' : 'idea';
    $('todoPopWrap').hidden = false;
  };
  const closePop = () => { $('todoPopWrap').hidden = true; };
  $('todoPopOk').addEventListener('click', closePop);
  $('todoPopClose').addEventListener('click', closePop);
  $('todoPopWrap').addEventListener('click', (ev) => { if (ev.target === $('todoPopWrap')) closePop(); });
  $('todoPopOpen').addEventListener('click', () => { closePop(); openPanel($('todoPopOpen').dataset.tab); });
  render();
})();


// ---------------- 🔁 무한 반복 (game music that loops like in the game) ----------------
// Per setlist track: find the loop (Allmind analyses the file), listen to the seam, nudge it, then Allmind renders
// loop files once; the track then plays until stopped or another track is picked. docs/plans/bgm-loop.md
function loopBtn(id) {
  const l = S?.bgm?.loops?.[id];
  const on = l?.enabled;
  const busy = l && (l.state === 'building' || l.state === 'analyzing');
  const title = !l ? '무한 반복 설정' : busy ? (l.state === 'building' ? `루프 파일 만드는 중 ${l.progress ?? 0}%` : '루프 찾는 중…') : l.state === 'error' ? '루프 파일을 못 만들었어요 — 눌러서 확인' : on ? (l.ready ? '무한 반복 켜짐' : '무한 반복 켜짐 (파일 준비 전)') : '무한 반복 꺼짐';
  return `<button class="loop-btn${on ? ' on' : ''}${busy ? ' busy' : ''}${l?.state === 'error' ? ' err' : ''}" title="${esc(title)}">${busy && l.state === 'building' ? `${l.progress ?? 0}%` : '🔁'}</button>`;
}
const fmtMs = (s) => { if (s == null || !Number.isFinite(s)) return ''; const m = Math.floor(s / 60); const r = s - m * 60; return `${m}:${r.toFixed(3).padStart(6, '0')}`; };
const parseMs = (t) => { const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(t)); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
let loopEd = null; // { id, title, start, end, score, source, found, info, ffmpeg, busy }

async function openLoop(id) {
  const t = S.bgm.tracks.find((x) => x.id === id);
  loopEd = { id, title: t?.title || id, start: null, end: null, msg: '불러오는 중…' };
  $('loopTitle').textContent = loopEd.title;
  $('loopWrap').hidden = false;
  renderLoop();
  let r;
  try { r = await (await fetch(`/api/bgm/loop?id=${encodeURIComponent(id)}`, { cache: 'no-store' })).json(); } catch { r = { ok: false, error: 'Allmind에 연결할 수 없어요' }; }
  if (!loopEd || loopEd.id !== id) return;
  if (!r.ok) { loopEd.msg = r.error; renderLoop(); return; }
  Object.assign(loopEd, { ffmpeg: r.ffmpeg, windows: r.windows, msg: '' });
  if (r.loop?.start != null) Object.assign(loopEd, { start: r.loop.start, end: r.loop.end, score: r.loop.score, source: r.loop.source, saved: { start: r.loop.start, end: r.loop.end }, enabled: r.loop.enabled });
  renderLoop();
  if (loopEd.start == null && r.ffmpeg?.state === 'ok') findLoopPoints();
}

async function findLoopPoints() {
  const ed = loopEd;
  ed.busy = 'detect'; ed.msg = '곡을 분석하는 중… (몇 초 걸려요)'; renderLoop();
  const r = await api('bgm/loop/detect', { id: ed.id });
  if (loopEd !== ed) return;
  ed.busy = null;
  if (!r.ok) { ed.msg = r.error || '분석하지 못했어요'; renderLoop(); return; }
  if (r.found) {
    Object.assign(ed, { start: r.start, end: r.end, score: r.score, source: r.source, msg: '' });
    ed.found = r.source === 'tag' ? '파일에 적힌 루프 지점을 찾았어요' : `반복 구간을 찾았어요 — 일치도 ${r.score}%`;
  } else {
    ed.found = null;
    ed.msg = r.reason === 'short' ? '곡이 너무 짧아요' : r.start != null ? `반복 구간이 확실하지 않아요 (일치도 ${r.score}%) — 들어 보고 직접 고쳐 주세요` : '반복되는 구간을 못 찾았어요 — 게임 음악이 아니거나 한 번만 연주되는 곡일 수 있어요. 직접 지정할 수 있어요';
    if (r.start != null) Object.assign(ed, { start: r.start, end: r.end, score: r.score, source: r.source });
  }
  renderLoop();
}

function renderLoop() {
  const ed = loopEd;
  if (!ed) return;
  const live = S?.bgm?.loops?.[ed.id];
  const ff = ed.ffmpeg;
  let html = '';
  if (ff && ff.state !== 'ok') {
    const dl = ff.state === 'downloading';
    html += `<div class="loop-note">무한 반복을 만들려면 <b>ffmpeg</b>(음악·영상 도구)가 필요해요. 처음 한 번만 받으면 돼요.</div>
      ${ed.windows ? `<div class="row-btns"><button class="btn accent" data-lp="ffmpeg" ${dl ? 'disabled' : ''}>${dl ? `받는 중… ${ff.progress ?? 0}%` : 'ffmpeg 받기 (약 100 MB)'}</button></div>` : '<div class="loop-note muted">이 PC에 ffmpeg를 설치해 주세요.</div>'}
      ${ff.error ? `<div class="loop-note bad">${esc(ff.error)}</div>` : ''}`;
    $('loopBody').innerHTML = html;
    return;
  }
  const has = ed.start != null && ed.end != null;
  const nudge = (k) => [-100, -10, 10, 100].map((d) => `<button class="btn ghost small-btn" data-nudge="${k}" data-d="${d}">${d > 0 ? '+' : ''}${d}</button>`).join('');
  html += `<p class="loop-note muted">게임처럼 끝없이 이어지는 버전을 만들어요. 반복 구간을 찾아서 들어 보고, 괜찮으면 저장하세요. 원본 파일은 그대로예요.</p>`;
  if (ed.msg) html += `<div class="loop-note${/못|않|없|실패|짧/.test(ed.msg) ? ' warn' : ''}">${esc(ed.msg)}</div>`;
  if (ed.found) html += `<div class="loop-note good">✔ ${esc(ed.found)}</div>`;
  html += `<div class="loop-grid">
      <label>루프 시작<input class="mono" data-f="start" value="${fmtMs(ed.start)}" placeholder="1:15.291"></label><div class="nudges">${nudge('start')}<span class="muted small">ms</span></div>
      <label>루프 끝<input class="mono" data-f="end" value="${fmtMs(ed.end)}" placeholder="4:14.802"></label><div class="nudges">${nudge('end')}<span class="muted small">ms</span></div>
    </div>
    ${has ? `<div class="loop-sum muted small">인트로 ${fmtMs(ed.start)} · 반복 ${fmtMs(ed.end - ed.start)}${ed.score != null ? ` · 일치도 ${ed.score}%` : ''}${ed.source === 'manual' ? ' · 직접 고침' : ed.source === 'tag' ? ' · 파일 태그' : ''}</div>
    <div class="loop-wave">
      <canvas id="loopWave" height="120"></canvas>
      <div class="loop-wave-bar">
        <span class="lw-key"><i class="heard"></i>들리는 소리</span><span class="lw-key"><i class="ghost"></i>원곡 (반대쪽)</span>
        <span class="lw-zoom">${[[2, '±2초'], [0.5, '±0.5초'], [0.1, '±0.1초']].map(([z, t]) => `<button class="btn ghost small-btn${(ed.zoom || 2) === z ? ' on' : ''}" data-zoom="${z}">${t}</button>`).join('')}</span>
      </div>
      <div class="muted small">가운데 세로선이 이음새예요. 두 선이 양쪽에서 겹치면 자연스럽게 이어져요 — 어긋나면 ±10/±100으로 맞춰 보세요.</div>
    </div>` : ''}
    <div class="row-btns">
      <button class="btn" data-lp="listen" ${has ? '' : 'disabled'}>▶ 이음새 듣기</button>
      <button class="btn ghost" data-lp="detect" ${ed.busy ? 'disabled' : ''}>${ed.busy === 'detect' ? '찾는 중…' : '자동으로 다시 찾기'}</button>
    </div>
    <div class="loop-note muted small" id="loopListenHint">${ed.listening ? '이음새는 6초쯤이에요 — 끊기거나 튀는 느낌이 없으면 성공' : ''}</div>`;
  const building = live?.state === 'building';
  const dirty = !ed.saved || Math.abs(ed.saved.start - ed.start) > 1e-6 || Math.abs(ed.saved.end - ed.end) > 1e-6;
  html += `<div class="loop-foot">
      ${building ? `<div class="loop-progress"><i style="width:${live.progress ?? 0}%"></i></div><div class="muted small">무한 반복 파일 만드는 중… ${live.progress ?? 0}% (1~2분, 방송에는 영향 없어요)</div>` : ''}
      ${live?.state === 'error' ? `<div class="loop-note bad">파일을 만들지 못했어요: ${esc(live.error || S.bgm.loops[ed.id]?.error || '')}</div>` : ''}
      ${!building && live?.ready && !dirty ? `<div class="loop-note good">✔ 준비됐어요 — 이 곡은 멈추거나 다른 곡을 고를 때까지 계속 반복돼요</div>` : ''}
      <div class="row-btns">
        <button class="btn accent" data-lp="save" ${has && !building && (dirty || !live?.enabled || live?.state === 'error') ? '' : 'disabled'}>${ed.saved && !dirty ? (live?.enabled ? '저장됨' : '무한 반복 켜기') : '저장하고 만들기'}</button>
        ${ed.saved && live?.enabled ? '<button class="btn ghost" data-lp="off">무한 반복 끄기</button>' : ''}
        ${ed.saved ? '<button class="btn ghost danger" data-lp="remove" style="margin-left:auto">루프 지우기</button>' : ''}
      </div>
    </div>`;
  $('loopBody').innerHTML = html;
  if (has) wantWave();
}

// ---- waveform around the seam (server sends min/max peaks for the current points: GET /api/bgm/loop/peaks) ----
let waveT = null, waveSeq = 0;
function wantWave() {
  const ed = loopEd;
  if (!ed || ed.start == null || ed.end == null) return;
  const zoom = ed.zoom || 2;
  const key = `${ed.start}|${ed.end}|${zoom}`;
  drawWave(ed.waveKey !== key);
  if (ed.waveKey === key || ed.waveWant === key) return;
  ed.waveWant = key;
  clearTimeout(waveT);
  waveT = setTimeout(async () => { // nudges come in bursts: ask once they settle
    const seq = ++waveSeq;
    let r;
    try { r = await (await fetch(`/api/bgm/loop/peaks?id=${encodeURIComponent(ed.id)}&start=${ed.start}&end=${ed.end}&span=${zoom}&bins=600`, { cache: 'no-store' })).json(); } catch { r = { ok: false, error: 'Allmind에 연결할 수 없어요' }; }
    if (loopEd !== ed || seq !== waveSeq) return;
    ed.waveWant = null;
    if (r.ok) { ed.wave = r; ed.waveKey = key; ed.waveErr = null; } else ed.waveErr = r.error;
    drawWave(ed.waveKey !== key);
  }, ed.wave ? 150 : 0);
}
window.addEventListener('resize', () => { if (loopEd) drawWave(loopEd.waveKey !== `${loopEd.start}|${loopEd.end}|${loopEd.zoom || 2}`); });
function drawWave(stale) {
  const ed = loopEd, c = $('loopWave');
  if (!ed || !c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 400, h = 120;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#2fd8c8', muted = css.getPropertyValue('--muted').trim() || '#7b9b9a', warn = css.getPropertyValue('--warn').trim() || '#ffb547';
  const mid = h / 2;
  g.fillStyle = 'rgba(255,255,255,.03)'; g.fillRect(0, 0, w / 2, h); // left = before the jump
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, mid + .5); g.lineTo(w, mid + .5); g.stroke();
  const W = ed.wave;
  if (W) {
    g.globalAlpha = stale ? 0.35 : 1;
    const bw = w / W.bins;
    const lane = (arr, color, alpha, outline) => {
      g.globalAlpha = (stale ? 0.35 : 1) * alpha;
      if (outline) { g.strokeStyle = color; g.lineWidth = 1.25; }
      else g.fillStyle = color;
      for (let b = 0; b < W.bins; b++) {
        const lo = arr[b * 2], hi = arr[b * 2 + 1];
        if (lo == null) continue;
        const y1 = mid - (hi / 127) * (mid - 6), y2 = mid - (lo / 127) * (mid - 6);
        if (outline) { g.beginPath(); g.moveTo(b * bw + bw / 2, y1); g.lineTo(b * bw + bw / 2, Math.max(y2, y1 + 1)); g.stroke(); }
        else g.fillRect(b * bw, y1, Math.max(1, bw), Math.max(1, y2 - y1));
      }
    };
    lane(W.ghost, muted, 0.55, false);
    lane(W.heard, accent, 0.85, true);
    g.globalAlpha = 1;
  }
  g.strokeStyle = warn; g.lineWidth = 2; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke(); // the seam
  g.fillStyle = muted; g.font = '11px system-ui, sans-serif';
  const span = W?.span ?? (ed.zoom || 2);
  const lab = (s) => (span < 1 ? `${Math.round(s * 1000)}ms` : `${s}초`);
  g.textAlign = 'left'; g.fillText(`← 루프 끝 전 −${lab(span)}`, 6, 14);
  g.textAlign = 'right'; g.fillText(`루프 시작 후 +${lab(span)} →`, w - 6, 14);
  if (!W || ed.waveErr) { g.textAlign = 'center'; g.fillText(ed.waveErr || '파형 불러오는 중…', w / 2, h - 10); }
}

$('loopBody').addEventListener('click', async (ev) => {
  const ed = loopEd;
  if (!ed) return;
  const z = ev.target.closest('[data-zoom]');
  if (z) { ed.zoom = Number(z.dataset.zoom); renderLoop(); return; }
  const n = ev.target.closest('[data-nudge]');
  if (n) {
    const k = n.dataset.nudge;
    if (ed[k] == null) return;
    ed[k] = Math.max(0, ed[k] + Number(n.dataset.d) / 1000);
    ed.source = 'manual'; ed.score = null; ed.found = null;
    renderLoop();
    return;
  }
  const b = ev.target.closest('[data-lp]');
  if (!b) return;
  const what = b.dataset.lp;
  if (what === 'ffmpeg') { const r = await api('bgm/loop/ffmpeg'); if (r.ok) { toast('ffmpeg 준비됐어요'); openLoop(ed.id); } return; }
  if (what === 'detect') return findLoopPoints();
  if (what === 'listen') {
    const a = $('loopAudio');
    a.src = `/api/bgm/loop/preview?id=${encodeURIComponent(ed.id)}&start=${ed.start}&end=${ed.end}&t=${Date.now()}`;
    ed.listening = true; renderLoop();
    a.play().catch(() => toast('미리듣기를 재생하지 못했어요', true));
    return;
  }
  if (what === 'save') {
    const r = await api('bgm/loop/save', { id: ed.id, start: ed.start, end: ed.end, source: ed.source || 'manual', score: ed.score ?? null });
    if (r.ok) { ed.saved = { start: ed.start, end: ed.end }; toast(r.loop.state === 'building' ? '무한 반복 파일을 만들기 시작했어요' : '무한 반복 켰어요'); if (r.loop.state !== 'building' && !r.loop.ready) await api('bgm/loop/enable', { id: ed.id, on: true }); renderLoop(); }
    return;
  }
  if (what === 'off') { const r = await api('bgm/loop/enable', { id: ed.id, on: false }); if (r.ok) toast('무한 반복을 껐어요 — 이 곡은 원래대로 끝나요'); return; }
  if (what === 'remove') {
    if (!confirm('이 곡의 루프 설정과 만든 파일을 지울까요?')) return;
    const r = await api('bgm/loop/remove', { id: ed.id });
    if (r.ok) { Object.assign(ed, { saved: null, start: null, end: null, found: null, score: null }); renderLoop(); }
  }
});
$('loopBody').addEventListener('change', (ev) => {
  const i = ev.target.closest('[data-f]');
  if (!i || !loopEd) return;
  const v = parseMs(i.value);
  if (!Number.isFinite(v)) { toast('시간은 분:초.밀리초 (예: 1:15.291)로 써 주세요', true); renderLoop(); return; }
  loopEd[i.dataset.f] = v; loopEd.source = 'manual'; loopEd.score = null; loopEd.found = null;
  renderLoop();
});
const closeLoop = () => { $('loopWrap').hidden = true; $('loopAudio').pause(); loopEd = null; };
$('loopClose').addEventListener('click', closeLoop);
$('loopWrap').addEventListener('click', (ev) => { if (ev.target === $('loopWrap')) closeLoop(); });
// keep the sheet's build progress live
setInterval(() => { if (loopEd && !$('loopWrap').hidden && !document.activeElement?.matches?.('#loopBody input')) renderLoop(); }, 1000);


// ---------------- OBS: 방송 · 녹화 켜기/끄기 + pinned sources/audio (docs/plans/obs-controls.md) ----------------
(() => {
  // --- 방송 · 녹화 sheet (opened from the LIVE pill) ---
  let armed = null; // 'stream:stop' / 'record:stop' after the first press
  let armT = null;
  const arm = (k) => { armed = k; clearTimeout(armT); armT = setTimeout(() => { armed = null; renderOut(); }, 4000); renderOut(); };
  const since = (ms) => fmtT(ms / 1000);
  function renderOut() {
    if ($('outWrap').hidden || !S) return;
    const op = S.obsPanel;
    const box = $('outBody');
    if (!S.obs.connected || !op) { box.innerHTML = '<div class="obs-empty">OBS에 연결되어 있지 않아요</div>'; return; }
    const st = op.stream, rc = op.record;
    const pf = S.preflight;
    const btn = (k, label, cls = '') => `<button class="btn ${cls}${armed === k ? ' armed' : ''}" data-out="${k}"${(k.startsWith('stream') ? st.busy : rc.busy) ? ' disabled' : ''}>${armed === k ? '한 번 더 누르면 꺼져요' : label}</button>`;
    const live = S.chzzk.live?.isLive;
    const warn = !st.active && pf && (pf.bad || pf.warn)
      ? `<div class="out-warn">방송 전 점검: ${pf.bad ? `문제 ${pf.bad}개` : ''}${pf.bad && pf.warn ? ', ' : ''}${pf.warn ? `확인할 것 ${pf.warn}개` : ''} · <a data-out="check">점검 보기</a></div>` : '';
    box.innerHTML = `
      <div class="out-row${st.active ? ' on' : ''}">
        <div class="k"><span class="dot"></span>방송</div>
        <div class="s">${st.busy ? 'OBS가 처리하는 중…' : st.reconnecting ? '다시 연결하는 중…' : st.active ? (live ? '송출 중 · 치지직 방송 중' : '송출 중 · 치지직에는 아직 안 보여요') : '꺼져 있어요'}</div>
        <div class="b">${st.active ? btn('stream:stop', '방송 끄기', 'danger') : btn('stream:start', '방송 시작', 'accent')}</div>
      </div>
      ${warn}
      <div class="out-row${rc.active ? (rc.paused ? ' paused' : ' on') : ''}">
        <div class="k"><span class="dot"></span>녹화</div>
        <div class="s">${rc.busy ? 'OBS가 처리하는 중…' : rc.active ? (rc.paused ? '일시정지' : '녹화 중') + (S.marks?.recording ? ` · ${since(S.marks.elapsedMs + (rc.paused ? 0 : Date.now() - marksGotAt))}` : '') : '꺼져 있어요'}</div>
        <div class="b">${rc.active ? (rc.paused ? btn('record:resume', '이어서') : btn('record:pause', '일시정지')) + btn('record:stop', '녹화 끄기', 'danger') : btn('record:start', '녹화 시작', 'accent')}</div>
      </div>
      <div class="muted small">끄는 버튼은 실수하지 않게 두 번 눌러야 해요.</div>`;
  }
  $('outBody').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-out]');
    if (!b) return;
    const k = b.dataset.out;
    if (k === 'check') { $('outWrap').hidden = true; $('checkBtn').click(); return; }
    const [what, action] = k.split(':');
    if (action === 'stop' && armed !== k) { arm(k); buzz(); return; }
    armed = null; clearTimeout(armT);
    buzz();
    b.disabled = true;
    const r = await api('obs/output', { what, action });
    if (r.ok) toast({ 'stream:start': '방송을 시작했어요', 'stream:stop': '방송을 껐어요', 'record:start': '녹화를 시작했어요', 'record:stop': '녹화를 껐어요', 'record:pause': '녹화를 멈췄어요', 'record:resume': '녹화를 이어서 해요' }[k]);
    renderOut();
  });
  $('livePill').addEventListener('click', () => { armed = null; $('outWrap').hidden = false; renderOut(); });
  const closeOut = () => { $('outWrap').hidden = true; armed = null; };
  $('outClose').addEventListener('click', closeOut);
  $('outWrap').addEventListener('click', (ev) => { if (ev.target === $('outWrap')) closeOut(); });
  setInterval(() => { if (!$('outWrap').hidden && S?.obsPanel?.record.active && !armed) renderOut(); }, 1000);

  // --- OBS panel ---
  const panel = $('obsPanel');
  const fold = (on) => { panel.classList.toggle('folded', on); pref.set('obsFolded', on); };
  fold(pref.get('obsFolded', true));
  $('obsFold').addEventListener('click', () => fold(!panel.classList.contains('folded')));
  let shapeKey = '';
  let dragging = null;     // audio name whose slider is held
  const sendVol = {};      // name → pending dB (sent at most every 120 ms)
  const fmtDb = (db) => (db <= -100 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`);
  const ak = (n) => esc(n);
  function render() {
    const op = S?.obsPanel;
    if (!op) return;
    const body = $('obsBody');
    const key = JSON.stringify([S.obs.connected, op.items.map((x) => [x.scene, x.source, x.ok]), op.audio.map((x) => [x.name, x.ok])]);
    if (key !== shapeKey) {
      shapeKey = key;
      if (!op.items.length && !op.audio.length) {
        body.innerHTML = '<div class="obs-empty">자주 켜고 끄는 소스(웹캠, 공지 텍스트…)와<br>오디오(디스코드, 데스크톱 소리…)를 <b>＋ 고르기</b>로 골라 두세요.</div>';
      } else {
        const multi = new Set(op.items.map((x) => x.scene)).size > 1;
        body.innerHTML =
          (op.items.length ? '<div class="obs-sec">소스</div>' + op.items.map((x, i) => `<div class="obs-row${x.ok ? '' : ' missing'}" data-i="${i}">
            <button class="obs-eye" data-do="eye" title="보이기 / 숨기기"${x.ok ? '' : ' disabled'}>👁</button>
            <span class="nm" title="${esc(x.scene)} › ${esc(x.source)}${x.ok ? '' : '\n(OBS에서 찾지 못했어요)'}">${esc(x.source)}${multi ? `<small>${esc(x.scene)}</small>` : ''}</span></div>`).join('') : '') +
          (op.audio.length ? '<div class="obs-sec">오디오</div>' + op.audio.map((a) => `<div class="obs-au${a.ok ? '' : ' missing'}" data-a="${ak(a.name)}">
            <button class="mute" data-do="mute" title="음소거 켜기/끄기"${a.ok ? '' : ' disabled'}></button>
            <span class="nm" title="${esc(a.name)}${a.ok ? '' : '\n(OBS에서 찾지 못했어요)'}">${esc(a.name)}</span><span class="db mono"></span>
            <div class="vol"><div class="lvl"><i></i></div><input type="range" min="-60" max="0" step="0.5"${a.ok ? '' : ' disabled'} title="볼륨"></div></div>`).join('') : '');
      }
    }
    op.items.forEach((x, i) => {
      const row = body.querySelector(`.obs-row[data-i="${i}"]`);
      row?.querySelector('.obs-eye').classList.toggle('on', !!x.enabled);
      if (row) row.querySelector('.obs-eye').textContent = x.enabled ? '👁' : '—';
    });
    for (const a of op.audio) {
      const row = [...body.querySelectorAll('.obs-au')].find((r) => r.dataset.a === a.name);
      if (!row) continue;
      row.classList.toggle('muted', !!a.muted);
      row.querySelector('.mute').textContent = a.muted ? '🔇' : '🔊';
      const db = dragging === a.name ? Number(row.querySelector('input').value) : a.db;
      row.querySelector('.db').textContent = fmtDb(db);
      if (dragging !== a.name && sendVol[a.name] === undefined) row.querySelector('input').value = Math.max(-60, Math.min(0, a.db));
    }
    renderOut();
  }
  window.renderObs = render;
  window.obsLevels = (lv) => {
    if (panel.classList.contains('folded') && !document.body.classList.contains('mp-todo') && !panel.closest('.layout.docked')) return;
    for (const row of $('obsBody').querySelectorAll('.obs-au')) {
      const v = lv[row.dataset.a];
      if (v !== undefined) row.querySelector('.lvl i').style.width = dbToPct(v) + '%';
    }
  };
  $('obsBody').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-do]');
    if (!b || !S?.obsPanel) return;
    buzz();
    if (b.dataset.do === 'eye') {
      const x = S.obsPanel.items[Number(b.closest('.obs-row').dataset.i)];
      if (x) { x.enabled = !x.enabled; render(); await api('obs/item', { scene: x.scene, source: x.source, on: x.enabled }); }
    } else if (b.dataset.do === 'mute') {
      const name = b.closest('.obs-au').dataset.a;
      const a = S.obsPanel.audio.find((y) => y.name === name);
      if (a) { a.muted = !a.muted; render(); await api('obs/mute', { name, muted: a.muted }); }
    }
  });
  let volT = null;
  const flushVol = () => {
    volT = null;
    for (const [name, db] of Object.entries(sendVol)) { delete sendVol[name]; api('obs/volume', { name, db }); }
  };
  $('obsBody').addEventListener('input', (ev) => {
    if (ev.target.type !== 'range') return;
    const row = ev.target.closest('.obs-au');
    const name = row.dataset.a;
    dragging = name;
    const db = Number(ev.target.value);
    row.querySelector('.db').textContent = fmtDb(db);
    const a = S.obsPanel.audio.find((y) => y.name === name); if (a) a.db = db;
    sendVol[name] = db;
    if (!volT) volT = setTimeout(flushVol, 120);
  });
  $('obsBody').addEventListener('change', (ev) => { if (ev.target.type === 'range') { dragging = null; } });

  // --- picker ---
  let cat = null;
  $('obsPick').addEventListener('click', async () => {
    $('obsPickWrap').hidden = false;
    $('obsPickBody').innerHTML = '<div class="obs-empty">OBS에서 목록을 가져오는 중…</div>';
    try {
      const r = await fetch('/api/obs/catalog', { cache: 'no-store' });
      if (r.status === 401) return toPin();
      cat = await r.json();
      if (!cat.ok) throw new Error(cat.error);
    } catch (e) { $('obsPickBody').innerHTML = `<div class="obs-empty">${esc(e.message || 'OBS 목록을 가져오지 못했어요')}</div>`; return; }
    const pinned = new Set(cat.pins.items.map((x) => x.scene + '\u0000' + x.source));
    const pa = new Set(cat.pins.audio);
    $('obsPickBody').innerHTML = '<h4>소스 (보이기 / 숨기기)</h4>' + cat.scenes.map((sc) => {
      const n = sc.items.filter((x) => pinned.has(x.scene + '\u0000' + x.source)).length;
      return `<details${n ? ' open' : ''}><summary>${esc(sc.name)}${n ? ` · ${n}개` : ''}</summary>${sc.items.length ? sc.items.map((x) =>
        `<label class="${x.group ? 'grp' : ''}"><input type="checkbox" data-scene="${esc(x.scene)}" data-source="${esc(x.source)}"${pinned.has(x.scene + '\u0000' + x.source) ? ' checked' : ''}>${esc(x.source)}</label>`).join('') : '<div class="muted small">소스가 없어요</div>'}</details>`;
    }).join('') + '<h4>오디오 (음소거 · 볼륨)</h4>' + (cat.audio.length ? cat.audio.map((n) =>
      `<label><input type="checkbox" data-audio="${esc(n)}"${pa.has(n) ? ' checked' : ''}>${esc(n)}</label>`).join('') : '<div class="muted small">소리가 있는 소스가 없어요</div>');
  });
  $('obsPickSave').addEventListener('click', async () => {
    const box = $('obsPickBody');
    // keep pins of scenes OBS doesn't have right now (another scene collection); the shown ones are replaced
    const shown = new Set(cat ? cat.scenes.flatMap((sc) => [sc.name, ...sc.items.map((x) => x.scene)]) : []);
    const items = (cat?.pins.items || []).filter((x) => !shown.has(x.scene));
    for (const c of box.querySelectorAll('input[data-source]:checked')) items.push({ scene: c.dataset.scene, source: c.dataset.source });
    const audio = [...box.querySelectorAll('input[data-audio]:checked')].map((c) => c.dataset.audio);
    const r = await api('obs/pins', { items, audio });
    if (r.ok) { $('obsPickWrap').hidden = true; fold(false); if (window.dockShow) window.dockShow('obs'); }
  });
  const closePick = () => { $('obsPickWrap').hidden = true; };
  $('obsPickClose').addEventListener('click', closePick);
  $('obsPickWrap').addEventListener('click', (ev) => { if (ev.target === $('obsPickWrap')) closePick(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeOut(); closePick(); } });
})();
