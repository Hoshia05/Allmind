// Allmind launcher / settings window (stream PC only).
const $ = (id) => document.getElementById(id);
const form = $('settings');
let info = null;
let formFilled = false;

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 2500);
}

async function call(path, body) {
  try {
    const res = await fetch(`/api/launcher${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) toast(data.error || '실패했어요', true);
    return data;
  } catch {
    return { ok: false, offline: true };
  }
}

function setDot(id, cls) { $(id).className = 'sdot ' + (cls || ''); }

// Chzzk status comes from the same live feed the dashboard uses.
let live = null;
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { live = JSON.parse(e.data); renderLive(); });
  es.addEventListener('bye', () => { document.body.innerHTML = '<p style="padding:30px;color:#7b9b9a">Allmind가 종료됐어요. 이 창은 닫아도 돼요.</p>'; });
}

function renderLive() {
  if (!live) return;
  const c = live.chzzk;
  if (!c.channelId) { setDot('dChzzk', ''); $('vChzzk').textContent = '채널 미설정'; }
  else if (c.error) { setDot('dChzzk', 'bad'); $('vChzzk').textContent = c.error; }
  else {
    setDot('dChzzk', c.chat.state === 'connected' ? 'ok' : 'warn');
    $('vChzzk').textContent = c.live?.isLive ? `방송 중 · 시청자 ${c.live.viewers}` : '오프라인 (방송 시작 시 연결)';
  }
  const it = live.interact;
  if (it.connected) { setDot('dClick', 'ok'); $('vClick').textContent = '켜짐 (영도 연결됨)'; }
  else { setDot('dClick', 'warn'); $('vClick').textContent = it.error || '대기 중'; }
  basicStatus();
}

async function refresh() {
  const r = await call('');
  if (!r.ok) return;
  info = r;
  $('ver').textContent = 'v' + r.version;

  const o = r.obs;
  if (o.running) { setDot('dObs', o.debugOn ? 'ok' : 'warn'); $('vObs').textContent = o.debugOn ? '실행 중' : '실행 중 (클릭 전달 꺼짐)'; }
  else { setDot('dObs', o.exe ? '' : 'bad'); $('vObs').textContent = o.exe ? '꺼짐' : 'OBS를 찾을 수 없음'; }
  setDot('dConn', o.connected ? 'ok' : o.running ? 'bad' : '');
  $('vConn').textContent = o.connected ? '연결됨' : o.running ? (o.error || '연결 안 됨') : '—';
  if (!launching) {
    $('startObs').disabled = o.running || !o.exe;
    $('startObs').textContent = o.running ? 'OBS 실행 중' : 'OBS 시작';
  }

  const note = $('obsNote');
  if (o.running && !o.debugOn) {
    note.hidden = false;
    note.textContent = 'OBS가 Allmind 밖에서 켜져서 클릭 전달·광고 스킵이 꺼져 있어요. 방송 중이 아닐 때 OBS를 닫고 "OBS 시작"으로 다시 켜 주세요.';
  } else if (o.running && !o.connected) {
    note.hidden = false;
    note.textContent = 'OBS에 연결할 수 없어요. 아래 "OBS 연결"의 안내대로 WebSocket 서버를 켜고 비밀번호를 넣어 주세요.';
  } else if (!o.exe) {
    note.hidden = false;
    note.textContent = 'OBS 설치 위치를 찾지 못했어요. 아래 "OBS 연결"의 OBS 위치에 obs64.exe 경로나 OBS 폴더를 넣어 주세요.';
  } else {
    note.hidden = true;
  }

  $('addr').textContent = r.addresses[0] || '네트워크 없음';
  const rc = r.remote;
  setDot('dRc', rc.connected ? (rc.needsLogin ? 'warn' : 'ok') : '');
  $('vRc').textContent = rc.connected ? (rc.needsLogin ? '연결됨 — 독에서 네이버 로그인이 필요해요' : `연결됨 (${[rc.skipLabel, rc.pauseLabel].filter(Boolean).join(' · ') || '버튼 확인 중'})`) : (rc.error || '연결 안 됨');
  $('rcUrl').textContent = r.remoteUrl || '치지직 채널을 먼저 설정해 주세요';
  const fw = r.firewall;
  $('fwRow').hidden = !fw?.checked || r.settings?.lanAccess === false; // no firewall question when only this PC may connect
  if (fw?.checked) {
    setDot('dFw', fw.ok ? 'ok' : 'bad');
    $('vFw').textContent = fw.ok ? '방화벽 허용됨 — 메인 PC에서 열 수 있어요' : '방화벽이 막고 있어요 — 메인 PC에서 안 열려요';
    $('fwBtn').hidden = fw.ok;
  }
  $('otherAddrs').textContent = r.addresses.length > 1 ? `안 열리면: ${r.addresses.slice(1).join(' · ')}` : '';

  // inputs from OBS → suggestions for the source-name fields
  const browserFirst = [...r.inputs].sort((a, b) => (a.kind === 'browser_source' ? -1 : 0) - (b.kind === 'browser_source' ? -1 : 0));
  $('inputList').innerHTML = browserFirst.map((i) => `<option value="${escapeAttr(i.name)}">${i.kind}</option>`).join('');
  $('inputsHint').textContent = r.inputs.length ? `OBS 소스 ${r.inputs.length}개 — 입력칸을 클릭하면 목록에서 고를 수 있어요` : 'OBS에 연결되면 소스 목록에서 고를 수 있어요';

  if (!formFilled) fillForm(r);
  basicStatus();
}

function escapeAttr(s) { return String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]); }

function fillForm(r) {
  formFilled = true;
  const s = r.settings;
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  }
  form.elements.runAtLogin.checked = r.runAtLogin;
  showCount(r.musicCount);
  showSbCount(r.soundCount);
  if (!r.isExe) form.elements.runAtLogin.closest('label').hidden = true;
  dirty(false);
}

function showCount(n) {
  const el = $('folderCount');
  if (n === null || n === undefined) { el.textContent = form.elements.folder.value ? '폴더를 찾을 수 없어요' : ''; el.className = 'hint bad'; }
  else { el.textContent = `음악 파일 ${n}개`; el.className = n ? 'hint good' : 'hint bad'; }
}

function showSbCount(n) {
  const el = $('sbFolderCount');
  if (!form.elements.sbFolder.value) { el.textContent = ''; return; }
  if (n === null || n === undefined) { el.textContent = '폴더를 찾을 수 없어요'; el.className = 'hint bad'; }
  else { el.textContent = `사운드 파일 ${n}개`; el.className = n ? 'hint good' : 'hint bad'; }
}
let sbTimer;
form.elements.sbFolder.addEventListener('input', () => {
  clearTimeout(sbTimer);
  sbTimer = setTimeout(async () => showSbCount((await call('/folder-count', { path: form.elements.sbFolder.value })).count), 400);
});
$('pickSbFolder').addEventListener('click', async () => {
  $('pickSbFolder').disabled = true;
  const r = await call('/pick-folder', { start: form.elements.sbFolder.value || form.elements.folder.value });
  $('pickSbFolder').disabled = false;
  if (r.path) {
    form.elements.sbFolder.value = r.path;
    showSbCount((await call('/folder-count', { path: r.path })).count);
  }
});

let countTimer;
form.elements.folder.addEventListener('input', () => {
  clearTimeout(countTimer);
  countTimer = setTimeout(async () => showCount((await call('/folder-count', { path: form.elements.folder.value })).count), 400);
});

$('pickFolder').addEventListener('click', async () => {
  $('pickFolder').disabled = true;
  const r = await call('/pick-folder', { start: form.elements.folder.value });
  $('pickFolder').disabled = false;
  if (r.path) {
    form.elements.folder.value = r.path;
    showCount((await call('/folder-count', { path: r.path })).count);
  }
});

$('pwToggle').addEventListener('click', () => {
  const el = form.elements.obsPassword;
  el.type = el.type === 'password' ? 'text' : 'password';
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const settings = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    settings[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  const r = await call('/save', { settings });
  if (!r.ok) return;
  await waitForRestart(r.newUrl ? new URL(r.newUrl).origin : location.origin);
});

// Show the overlay, wait for the restarted app, then reload the settings page.
async function waitForRestart(base, text = '다시 시작 중…', tries = 60) {
  $('overlayText').textContent = text;
  $('overlay').hidden = false;
  for (let i = 0; i < tries; i++) {
    await new Promise((res) => setTimeout(res, 500));
    try {
      const p = await fetch(base + '/api/ping', { cache: 'no-store' });
      if (p.ok && i > 1) { location.href = base + '/launcher'; return; }
    } catch {}
  }
  $('overlayText').textContent = '다시 시작하지 못했어요. Allmind를 다시 실행해 주세요.';
}

let launching = false;
$('startObs').addEventListener('click', async () => {
  const btn = $('startObs');
  launching = true;
  btn.disabled = true;
  btn.textContent = 'OBS 시작 중…';
  const r = await call('/start-obs', {});
  launching = false;
  if (r.ok) toast('OBS가 켜졌어요');
  refresh();
});
$('fwBtn').addEventListener('click', async () => {
  const btn = $('fwBtn');
  btn.disabled = true;
  btn.textContent = '관리자 권한 확인 중…';
  const r = await call('/firewall', {});
  btn.disabled = false;
  btn.textContent = '방화벽 허용';
  if (r.ok) toast('방화벽을 허용했어요 — 메인 PC에서 새로고침해 보세요');
  refresh();
});
$('copyRc').addEventListener('click', async () => {
  const t = $('rcUrl').textContent;
  if (!t.startsWith('http')) return toast('치지직 채널을 먼저 설정해 주세요', true);
  try { await navigator.clipboard.writeText(t); toast('리모컨 주소를 복사했어요'); }
  catch { getSelection().selectAllChildren($('rcUrl')); toast('주소를 선택했어요 — Ctrl+C로 복사하세요'); }
});
$('openDash').addEventListener('click', () => call('/open-dashboard', {}));
$('openData').addEventListener('click', () => call('/open-data', {}));
$('logsBtn').addEventListener('click', async () => {
  const btn = $('logsBtn');
  btn.disabled = true;
  const r = await call('/logs', {});
  btn.disabled = false;
  if (r.ok) toast(`바탕화면에 ${r.name} 를 만들었어요 — 이 파일을 보내 주세요`);
});
$('copyAddr').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('addr').textContent); toast('주소를 복사했어요'); }
  catch { getSelection().selectAllChildren($('addr')); toast('주소를 선택했어요 — Ctrl+C로 복사하세요'); }
});
$('quitBtn').addEventListener('click', async () => {
  if (confirm('Allmind를 종료할까요? 대시보드와 BGM 자동 일시정지가 멈춰요. (OBS는 계속 켜져 있어요)')) await call('/quit', {});
});

refresh();
connectEvents();
setInterval(refresh, 4000);


// ---------------- updates ----------------
let updBusy = false;
async function upd(path) {
  try {
    const r = await fetch(`/api/update${path}`, path ? { method: 'POST' } : { cache: 'no-store' });
    return await r.json();
  } catch {
    return { ok: false, offline: true };
  }
}

function renderUpdate(u) {
  if (!u || u.ok === false && !u.current) return;
  const mb = (n) => (n / 1048576).toFixed(1);
  let dot = 'ok';
  let text;
  if (u.phase === 'downloading') { dot = 'warn'; text = `새 버전 ${u.latest} 받는 중… ${Math.round((u.progress || 0) * 100)}%`; }
  else if (u.phase === 'installing') { dot = 'warn'; text = '설치하고 다시 시작하는 중…'; }
  else if (u.phase === 'dry-ready') { dot = 'ok'; text = `(시험) 받기·검증까지 끝났어요 — 실행 파일이 아니라 시작하지 않아요`; }
  else if (u.phase === 'error') { dot = 'bad'; text = u.error || '업데이트에 실패했어요'; }
  else if (u.available) { dot = 'warn'; text = `새 버전 ${u.latest} (현재 ${u.current}) · ${mb(u.size)} MB`; }
  else if (u.checking) { dot = ''; text = '확인 중…'; }
  else if (u.error) { dot = 'warn'; text = `확인하지 못했어요 (${u.error})`; }
  else if (u.checkedAt) {
    const t = new Date(u.checkedAt);
    text = `최신 버전이에요 (${u.current}) · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 확인`;
  } else { dot = ''; text = `현재 ${u.current} · 아직 확인하지 않았어요`; }
  setDot('dUpd', dot);
  $('vUpd').textContent = text;
  $('vUpd').title = text;

  const busy = u.phase === 'downloading' || u.phase === 'installing';
  $('updBar').hidden = !busy;
  $('updFill').style.width = `${Math.round((u.phase === 'installing' ? 1 : u.progress || 0) * 100)}%`;
  $('updInstall').hidden = !u.available || u.phase === 'installing';
  $('updInstall').disabled = busy;
  $('updCheck').disabled = busy || u.checking;
  $('updHint').hidden = !u.available;
  const notes = (u.notes || '').trim();
  $('updNotes').hidden = !(u.available && notes);
  $('updNotesText').textContent = notes;
}

async function refreshUpdate() {
  if (updBusy) return;
  renderUpdate(await upd(''));
}

$('updCheck').addEventListener('click', async () => {
  $('updCheck').disabled = true;
  renderUpdate({ ...(await upd('')), checking: true });
  const u = await upd('/check');
  renderUpdate(u);
  if (u.ok && !u.available && !u.error) toast('이미 최신 버전이에요');
});

$('updInstall').addEventListener('click', async () => {
  updBusy = true;
  $('updInstall').disabled = true;
  // the request returns once the download is done, so show progress meanwhile
  const poll = setInterval(async () => { const u = await upd(''); if (u.phase) renderUpdate(u); }, 400);
  const r = await upd('/install');
  clearInterval(poll);
  updBusy = false;
  if (r.restarting) return waitForRestart(location.origin, '업데이트를 설치하고 다시 시작하는 중…', 120);
  if (!r.ok) toast(r.error || '업데이트에 실패했어요', true);
  renderUpdate(await upd(''));
});

refreshUpdate();
setInterval(refreshUpdate, 60 * 1000);

// ---------- 연동: Google (YouTube archive + Drive) and CHZZK ----------
const lf = $('linksForm');
let linksFilled = false;
let links = null;

function fillLinks(r) {
  linksFilled = true;
  const v = {
    googleClientId: r.google.clientId, googleClientSecret: r.google.clientSecret,
    chzzkClientId: r.chzzk.clientId, chzzkClientSecret: r.chzzk.clientSecret,
    youtubeEnabled: r.youtube.enabled, titleTemplate: r.youtube.titleTemplate,
    driveEnabled: r.drive.enabled, nameTemplate: r.drive.nameTemplate, maxMbps: r.drive.maxMbps, driveFolder: r.drive.folder || '',
  };
  for (const [k, x] of Object.entries(v)) {
    const el = lf.elements[k];
    if (el.type === 'checkbox') el.checked = !!x; else el.value = x ?? '';
  }
}

function renderLinks(r) {
  links = r;
  $('chzzkRedirect').textContent = r.chzzk.redirect;
  const g = r.google;
  const gAny = g.youtube || g.drive;
  const gPart = gAny && !g.loggedIn; // one of the two consents is missing
  setDot('dGoogle', g.loggedIn ? 'ok' : gPart ? 'warn' : g.error ? 'bad' : '');
  $('vGoogle').textContent = g.loggedIn ? `로그인됨${g.account ? ` · ${g.account}` : ''}`
    : gPart ? `${g.youtube ? '유튜브만' : '드라이브만'} 연결됨 — "Google 로그인"을 다시 눌러 나머지도 허용해 주세요`
    : g.error || (g.configured ? '로그인 필요' : '설정 필요 (아래 안내)');
  $('googleLogout').hidden = !gAny;
  $('googleLogin').textContent = g.loggedIn ? '다시 로그인' : 'Google 로그인';

  const y = r.youtube;
  const b = y.broadcast;
  let yt = '꺼짐';
  let ytDot = '';
  if (y.enabled && !g.youtube) yt = 'Google 로그인 필요';
  else if (y.enabled && !y.hasKey) { yt = '스트림 키 필요 (아래 버튼)'; ytDot = 'warn'; }
  else if (y.enabled && y.error) { yt = y.error; ytDot = 'bad'; }
  else if (y.enabled && b) {
    const life = { created: '준비 중', ready: '대기 중 (방송 시작하면 자동 시작)', live: '방송 중', liveStarting: '시작하는 중', complete: '끝남', testing: '테스트 중' }[b.life] || b.life;
    yt = `${b.privacy === 'private' ? '🔒 비공개' : b.privacy} · ${life} · ${b.title}`;
    ytDot = y.alert ? 'bad' : b.privacy === 'private' ? 'ok' : 'warn';
  } else if (y.enabled) yt = '준비 중…';
  setDot('dYt', ytDot);
  $('vYt').textContent = yt;
  $('vYt').title = yt;
  $('ytKey').textContent = y.hasKey ? '키 다시 만들기' : '스트림 키 만들기';
  $('ytShowKey').hidden = !y.hasKey;
  $('ytKey').disabled = $('ytShowKey').disabled = !g.youtube;

  const d = r.drive;
  const up = d.items.find((i) => i.status === 'uploading');
  const waiting = d.items.filter((i) => i.status === 'waiting' && i.kind === 'video').length;
  const err = d.items.find((i) => i.status === 'error');
  let dv = !d.enabled ? '꺼짐' : !g.drive ? 'Google 로그인 필요' : d.needsReauth ? 'Google 로그인을 한 번 더 해 주세요 (고른 폴더에 올리려면 드라이브 권한이 더 필요해요)' : err ? `실패: ${err.name}` : up ? `올리는 중 ${Math.floor((up.offset / up.size) * 100)}% · ${up.name}` : waiting ? `대기 ${waiting}개${d.paused ? ' (방송·녹화 끝나면)' : ''}` : '녹화가 끝나면 자동으로 올려요';
  $('driveFolderNote').innerHTML = d.custom ? (d.folderName ? `지금 올리는 곳: <a href="${d.folderUrl}" target="_blank" rel="noopener">${escapeAttr(d.folderName)}</a>` : '폴더는 다음 업로드 때 확인해요') : (d.folderUrl ? `지금 올리는 곳: <a href="${d.folderUrl}" target="_blank" rel="noopener">Allmind 녹화</a>` : '');
  setDot('dDrive', !d.enabled || !g.drive ? '' : d.needsReauth ? 'warn' : err ? 'bad' : 'ok');
  $('vDrive').textContent = dv;

  const c = r.chzzk;
  setDot('dChzzkOpen', c.loggedIn ? (c.expiresSoon ? 'warn' : 'ok') : c.error ? 'bad' : '');
  $('vChzzkOpen').textContent = c.loggedIn ? `로그인됨${c.account ? ` · ${c.account}` : ''}${c.expiresSoon ? ' · 곧 만료' : ''}` : c.error || (c.configured ? '로그인 필요' : '설정 필요 (아래 안내)');
  $('chzzkLogout').hidden = !c.loggedIn;
  $('chzzkLogin').textContent = c.loggedIn ? '다시 로그인' : '치지직 로그인';

  linksStatus();
  if (!linksFilled) fillLinks(r);
}

async function refreshLinks() {
  const r = await call('/links');
  if (r.ok) renderLinks(r);
}

function linksValues() {
  const o = {};
  for (const el of lf.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  return o;
}
async function saveLinks(quiet) {
  const r = await call('/links-save', linksValues());
  if (r.ok) { renderLinks(r); if (!quiet) toast('저장했어요'); }
  return r.ok;
}
lf.addEventListener('submit', (ev) => { ev.preventDefault(); saveLinks(); });

$('googleLogin').addEventListener('click', async () => {
  if (!(await saveLinks(true))) return;
  const r = await call('/google-login', {});
  if (r.ok) toast('브라우저에서 Google 허용 화면 2번(유튜브 → 드라이브)을 차례로 마쳐 주세요');
});
$('googleLogout').addEventListener('click', async () => { await call('/google-logout', {}); refreshLinks(); });
$('chzzkLogin').addEventListener('click', async () => {
  if (!(await saveLinks(true))) return;
  const r = await call('/chzzk-login', {});
  if (r.ok) toast('브라우저에서 치지직 로그인을 마쳐 주세요');
});
$('chzzkLogout').addEventListener('click', async () => { await call('/chzzk-logout', {}); refreshLinks(); });

function showKey(r) {
  $('keyAddr').textContent = r.address;
  $('keyVal').textContent = r.key;
  $('keyBox').hidden = false;
}
$('ytKey').addEventListener('click', async () => {
  if (links?.youtube.hasKey && !confirm('새 스트림 키를 만들면 OBS의 유튜브 키도 새 것으로 바꿔야 해요. 계속할까요?')) return;
  const r = await call('/youtube-key', {});
  if (r.ok) { showKey(r); refreshLinks(); }
});
$('ytShowKey').addEventListener('click', async () => {
  if (!$('keyBox').hidden) { $('keyBox').hidden = true; return; }
  const r = await call('/youtube-showkey', {});
  if (r.ok) showKey(r);
});
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); toast('복사했어요'); } catch { toast('복사하지 못했어요', true); }
});

refreshLinks();
setInterval(refreshLinks, 5000);


// ---------------- Stream Deck URLs ----------------
const deck = { data: null };
const deckBase = () => $('deckWhere').value || location.origin;
function renderDeck() {
  const d = deck.data;
  if (!d) return;
  const cur = $('deckWhere').value;
  const opts = [
    ...d.addresses.map((a, i) => ({ v: a, t: `메인 PC 등 다른 PC에서 (${a})${i ? ' — 안 되면 이 주소' : ''}` })),
    { v: location.origin, t: '이 PC(방송 PC)에서' },
  ];
  $('deckWhere').innerHTML = opts.map((o) => `<option value="${escapeAttr(o.v)}">${escapeAttr(o.t)}</option>`).join('');
  if (cur && opts.some((o) => o.v === cur)) $('deckWhere').value = cur;
  if (document.activeElement !== $('deckToken')) $('deckToken').value = d.token || '';
  const lan = d.addresses[0] || location.origin;
  $('deckDl').textContent = `${lan}/streamdeck/Allmind.streamDeckPlugin`;
  $('deckHost').textContent = lan.replace(/^https?:\/\//, '');
  $('deckList').innerHTML = d.groups.map((g) => {
    const rows = g.items.map((it) => `<div class="deck-item"><span>${escapeAttr(it.label)}</span><button class="btn small-btn" data-path="${escapeAttr(it.path)}">복사</button></div>`).join('');
    const empty = g.title === '사운드보드' && !d.groups.find((x) => x.title === g.title).items.some((it) => it.label.startsWith('▶'))
      ? '<div class="muted small">사운드보드 폴더에 파일이 있으면 하나씩 여기 나타나요.</div>' : '';
    return `<h3 class="deck-h">${escapeAttr(g.title)}</h3>${rows}${empty}`;
  }).join('');
}
async function loadDeck() {
  const r = await call('/deck');
  if (!r.ok) return;
  deck.data = r;
  renderDeck();
}
$('deckTip').addEventListener('toggle', () => { if ($('deckTip').open) loadDeck(); });
$('deckWhere').addEventListener('change', renderDeck);
$('deckList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-path]');
  if (!b) return;
  const url = deckBase() + b.dataset.path;
  try { await navigator.clipboard.writeText(url); toast('주소를 복사했어요'); }
  catch { prompt('주소를 복사하세요 (Ctrl+C)', url); }
});
$('deckInstall').addEventListener('click', async () => {
  const r = await call('/deck-plugin', {});
  if (r.ok) toast(r.dryRun ? `개발 모드: 플러그인 ${r.bytes} bytes (설치는 Windows에서만)` : '스트림덱 앱에서 설치를 눌러 주세요');
});
$('deckDlCopy').addEventListener('click', async () => {
  const url = $('deckDl').textContent;
  try { await navigator.clipboard.writeText(url); toast('주소를 복사했어요'); }
  catch { prompt('주소를 복사하세요 (Ctrl+C)', url); }
});
$('deckTokenSave').addEventListener('click', async () => {
  const r = await call('/deck-save', { token: $('deckToken').value.trim() });
  if (!r.ok) return;
  deck.data = r;
  renderDeck();
  toast(r.hasToken ? '비밀 키를 저장했어요 — 플러그인의 연결 설정에도 같은 키를 넣어 주세요' : '비밀 키를 껐어요');
});
loadDeck(); // token + addresses (the URL list itself is only shown when the details are opened)


// ---------------- settings export / import ----------------
$('expBtn').addEventListener('click', async () => {
  const p = $('expPass').value;
  if (p.length < 8) return toast('비밀번호는 8자 이상으로 해 주세요', true);
  if (p !== $('expPass2').value) return toast('비밀번호 확인이 달라요', true);
  $('expBtn').disabled = true;
  const r = await call('/export', { passphrase: p });
  $('expBtn').disabled = false;
  if (r.ok) { toast(`바탕화면에 ${r.name} 을(를) 만들었어요`); $('expPass').value = $('expPass2').value = ''; }
});
let impText = null;
async function readImp() {
  const f = $('impFile').files[0];
  if (!f) { toast('설정 파일을 골라 주세요', true); return null; }
  if (f.size > 20 * 1024 * 1024) { toast('설정 파일이 너무 커요', true); return null; }
  return f.text();
}
$('impFile').addEventListener('change', () => { $('impSummary').hidden = true; impText = null; });
$('impCheck').addEventListener('click', async () => {
  impText = await readImp();
  if (!impText) return;
  $('impCheck').disabled = true;
  const r = await call('/import', { text: impText, passphrase: $('impPass').value, apply: false });
  $('impCheck').disabled = false;
  if (!r.ok) return;
  const s = r.summary;
  const yes = (b) => (b ? '✓' : '–');
  const when = s.from.created ? new Date(s.from.created).toLocaleString() : '?';
  $('impSummary').innerHTML = `
    <b>${escapeAttr(s.from.host || '?')}</b>에서 ${escapeAttr(when)}에 만든 파일 (Allmind ${escapeAttr(s.from.version || '?')})
    <ul>
      <li>OBS 비밀번호 ${yes(s.obs)} · 치지직 채널 ${yes(s.channel)}</li>
      <li>Google 로그인 ${yes(s.google)} · 유튜브 스트림 키 ${yes(s.youtubeKey)} · 치지직 연동 로그인 ${yes(s.chzzkLogin)}</li>
      <li>BGM 폴더: ${escapeAttr(s.bgmFolder || '없음')}</li>
      <li>사운드보드 폴더: ${escapeAttr(s.sbFolder || '없음')}</li>
    </ul>
    <div class="muted small">적용하면 이 PC의 설정이 이 파일 내용으로 바뀌고 Allmind가 다시 시작돼요. 지금 설정은 설정 폴더의 "가져오기 전 백업"에 남겨 둬요.
    폴더 위치가 이 PC와 다르면 적용 후 설정에서 고쳐 주세요. 치지직 연동 로그인은 한 번 쓰면 바뀌는 방식이라, 두 PC에서 번갈아 쓰면 한쪽은 다시 로그인해야 할 수 있어요.
    대시보드 패널 배치는 브라우저마다 따로라서 옮겨지지 않아요.</div>
    <div class="row-btns tight"><button class="btn accent" type="button" id="impApply">이 PC에 적용하고 다시 시작</button></div>`;
  $('impSummary').hidden = false;
  $('impApply').addEventListener('click', async () => {
    if (!confirm('지금 설정을 이 파일 내용으로 바꾸고 Allmind를 다시 시작할까요?')) return;
    $('impApply').disabled = true;
    const a = await call('/import', { text: impText, passphrase: $('impPass').value, apply: true });
    if (a.ok) { toast('가져왔어요 — 다시 시작하는 중…'); setTimeout(() => location.reload(), 4000); }
    else $('impApply').disabled = false;
  });
});


// ---------------- setting modules: status pills, step checks, open/closed ----------------
// Each <details class="mod"> is one function. Its pill shows how far it's set up;
// [data-step] items in its quick guide get a ✓ as the matching condition becomes true.
const MODS = [...document.querySelectorAll('details.mod[data-group]')];
const stepDone = {};
const modState = {}; // id → { cls, text }
let openPref = {};
try { openPref = JSON.parse(localStorage.getItem('allmind.launcher.open') || '{}'); } catch {}
const decided = new Set();
const auto = new Set(); // ids whose next toggle event is our own default, not the user

function setMod(id, cls, text) {
  const m = $(id);
  if (!m) return;
  modState[id] = { cls, text };
  const pill = m.querySelector('[data-pill]');
  pill.className = `pill ${cls}`;
  pill.textContent = text;
  applySteps();
}
// Once per page: remembered open/closed per card; otherwise only the first basic card that still
// needs something opens, so a first-time user is walked through them top to bottom.
function decideDefaults() {
  if (decideDefaults.done) return;
  decideDefaults.done = true;
  const firstTodo = MODS.find((m) => m.dataset.group === 'basic' && ['todo', 'bad', 'warn'].includes(modState[m.id]?.cls));
  for (const m of document.querySelectorAll('details.mod')) {
    if (decided.has(m.id)) continue;
    const want = m.id in openPref ? openPref[m.id] : m === firstTodo;
    if (m.open !== want) { auto.add(m.id); m.open = want; }
  }
}
function step(key, done) { stepDone[key] = !!done; }
function applySteps() {
  for (const li of document.querySelectorAll('[data-step]')) li.classList.toggle('done', !!stepDone[li.dataset.step]);
}

function openMod(id) {
  const m = $(id);
  if (!m) return;
  m.open = true;
  m.scrollIntoView({ behavior: 'smooth', block: 'start' });
  m.classList.add('flash');
  setTimeout(() => m.classList.remove('flash'), 1200);
}
document.addEventListener('click', (ev) => {
  const o = ev.target.closest('[data-open]');
  if (o) return openMod(o.dataset.open);
  const g = ev.target.closest('a[data-goto]');
  if (g) { ev.preventDefault(); openMod(g.getAttribute('href').slice(1)); }
});
for (const m of document.querySelectorAll('details.mod')) {
  m.addEventListener('toggle', () => {
    if (auto.delete(m.id)) return;
    openPref[m.id] = m.open;
    try { localStorage.setItem('allmind.launcher.open', JSON.stringify(openPref)); } catch {}
  });
  // user clicks count even before the default was decided
  m.querySelector('summary').addEventListener('click', () => decided.add(m.id));
}

// unsaved changes in the main settings (they need a restart to apply)
function dirty(on) { $('saveBar').hidden = !on; }
for (const el of form.elements) {
  if (el.type === 'submit') continue;
  el.addEventListener('input', () => dirty(true));
  el.addEventListener('change', () => dirty(true));
}

function basicStatus() {
  if (!info) return;
  const o = info.obs, s = info.settings;
  step('obs.server', o.connected); step('obs.password', !!s.obsPassword); step('obs.connected', o.connected);
  setMod('m-obs', o.connected ? 'ok' : !o.exe ? 'bad' : !o.running ? 'todo' : 'bad',
    o.connected ? '연결됨' : !o.exe ? 'OBS를 못 찾음' : !o.running ? (s.obsPassword ? 'OBS 꺼짐' : '설정 필요') : (s.obsPassword ? '연결 안 됨' : '비밀번호 필요'));

  const ch = live?.chzzk?.channelId || s.channel;
  step('channel.set', !!ch);
  setMod('m-channel', ch ? 'ok' : 'todo', ch ? (live?.chzzk?.live?.isLive ? '방송 중' : '설정됨') : '설정 필요');

  const music = info.musicCount;
  const src = live?.bgm?.sourceOk;
  step('bgm.folder', music > 0); step('bgm.source', !!src); step('sb.folder', info.soundCount > 0);
  setMod('m-bgm', !music ? 'todo' : src === false ? 'warn' : 'ok',
    !music ? (s.folder ? '폴더에 음악 없음' : '설정 필요') : src === false ? '소스 만들기 필요' : `${music}곡${info.soundCount ? ` · 효과음 ${info.soundCount}` : ''}`);

  const names = new Set(info.inputs.map((i) => i.name));
  const has = (n) => !!n && (!o.connected || names.has(n));
  step('sources.donation', has(s.donation)); step('sources.chat', has(s.chat)); step('sources.saved', has(s.donation) && has(s.chat));
  const missing = [['영도', s.donation], ['위플챗', s.chat]].filter(([, n]) => !has(n)).map(([l]) => l);
  if (!o.connected) setMod('m-sources', '', 'OBS 연결 후 확인');
  else setMod('m-sources', missing.length ? 'warn' : 'ok', missing.length ? `${missing.join('·')} 소스 확인` : '영도 ✓ · 위플챗 ✓');

  const fw = info.firewall;
  step('fw.ok', fw?.ok || !fw?.checked);
  const lan = info.settings?.lanAccess !== false;
  $('lanOff').hidden = lan; $('addrRow').hidden = !lan; $('otherAddrs').hidden = !lan;
  for (const el of $('m-mainpc').querySelectorAll('.steps, .tip-line:not(#lanOff)')) el.hidden = !lan;
  $('lanOffPort').textContent = info.settings?.port || location.port || 8080;
  if (!lan) setMod('m-mainpc', 'ok', '이 PC에서만');
  else setMod('m-mainpc', fw?.checked && !fw.ok ? 'bad' : 'ok', fw?.checked && !fw.ok ? '방화벽이 막음' : info.addresses[0] ? info.addresses[0].replace(/^https?:\/\//, '') : '네트워크 없음');

  const rc = info.remote;
  step('rc.connected', rc.connected); step('rc.login', rc.connected && !rc.needsLogin);
  setMod('m-remote', rc.connected ? (rc.needsLogin ? 'warn' : 'ok') : 'off', rc.connected ? (rc.needsLogin ? '독에서 로그인 필요' : '연결됨') : '안 씀');

  const n = info.deckPlugins || 0;
  step('deck.connected', n > 0);
  setMod('m-deck', n ? 'ok' : 'off', n ? `플러그인 ${n}대 연결됨` : '안 씀');
  if (live) decideDefaults(); // channel/BGM-source states come from the live feed
}

function linksStatus() {
  const r = links;
  if (!r) return;
  const g = r.google, y = r.youtube, d = r.drive, c = r.chzzk;
  step('google.configured', g.configured); step('google.youtube', g.youtube); step('google.drive', g.drive && !d.needsReauth);
  setMod('m-google', g.loggedIn ? 'ok' : g.youtube || g.drive ? 'warn' : g.error ? 'bad' : g.configured ? 'todo' : 'off',
    g.loggedIn ? '로그인됨' : g.youtube ? '드라이브 허용 필요' : g.drive ? '유튜브 허용 필요' : g.error ? '오류' : g.configured ? '로그인 필요' : '안 씀');

  step('yt.enabled', y.enabled); step('yt.key', y.hasKey);
  setMod('m-youtube', !y.enabled ? 'off' : !g.youtube ? 'todo' : !y.hasKey ? 'todo' : y.error || y.alert ? 'bad' : 'ok',
    !y.enabled ? '꺼짐' : !g.youtube ? 'Google 연결 필요' : !y.hasKey ? '스트림 키 필요' : y.alert ? '확인 필요' : y.error ? '오류' : '준비됨');

  const err = d.items.find((i) => i.status === 'error');
  step('drive.enabled', d.enabled); step('drive.folder', d.custom);
  setMod('m-drive', !d.enabled ? 'off' : !g.drive ? 'todo' : d.needsReauth ? 'warn' : err ? 'bad' : 'ok',
    !d.enabled ? '꺼짐' : !g.drive ? 'Google 연결 필요' : d.needsReauth ? '다시 로그인 필요' : err ? '업로드 실패' : d.custom ? (d.folderName || '내 폴더') : '켜짐');

  step('chzzk.configured', c.configured); step('chzzk.loggedIn', c.loggedIn);
  setMod('m-chzzkopen', c.loggedIn ? (c.expiresSoon ? 'warn' : 'ok') : c.error ? 'bad' : c.configured ? 'todo' : 'off',
    c.loggedIn ? (c.expiresSoon ? '곧 만료' : '로그인됨') : c.error ? '오류' : c.configured ? '로그인 필요' : '안 씀');
}

// Keep this window grouped under the pinned Allmind icon: Windows only knows it's Allmind (not Edge) once
// Allmind has tagged it, which can miss a window that opened late or that Edge reset (win.js stampAppWindows)
const taskbar = () => fetch('/api/launcher/taskbar', { method: 'POST' }).catch(() => {});
taskbar();
addEventListener('focus', taskbar);

// ---------------- remove Allmind from this (borrowed) PC ----------------
call('/remove-all-info').then((r) => { if (r?.ok) $('rmExePath').textContent = r.exe ? `(${r.exe})` : ''; if (r?.ok && !r.exe) $('rmExe').closest('label').hidden = true; });
$('rmAll').addEventListener('click', async () => {
  const typed = prompt('이 PC에서 Allmind의 설정·로그인·기록을 모두 지우고 Allmind를 꺼요.\n되돌릴 수 없어요. 계속하려면 "지우기"라고 입력해 주세요.');
  if (typed === null) return;
  if (typed.trim() !== '지우기') return toast('"지우기"라고 입력해야 지워져요', true);
  let r = await call('/remove-all', { confirm: '지우기', exe: $('rmExe').checked });
  if (!r.ok) return;
  if (r.pendingUploads) {
    const list = r.pendingUploads.slice(0, 5).map((n) => `· ${n}`).join('\n');
    if (!confirm(`아직 드라이브에 안 올라간 녹화가 있어요:\n${list}${r.pendingUploads.length > 5 ? `\n외 ${r.pendingUploads.length - 5}개` : ''}\n\n지우면 업로드가 멈추고 녹화 파일은 이 PC에만 남아요 (OBS 녹화 폴더). USB 등으로 직접 옮겼다면 [확인], 업로드를 기다리려면 [취소].`)) return;
    r = await call('/remove-all', { confirm: '지우기', exe: $('rmExe').checked, ignoreUploads: true });
    if (!r.ok) return;
  }
  $('overlay').querySelector('.spinner').hidden = true;
  $('overlayText').textContent = r.dryRun ? `(소스 실행 — 실제로는 안 지움) ${r.paths.join(', ')}` : 'Allmind를 지웠어요. 이 창을 닫으면 끝이에요.';
  $('overlay').hidden = false;
});
