// Xylem page shell: sidebar of modules (from the pack manifest), pack status/update in the header,
// and one panel module per feature (<id>.panel.js → export function mount(el, x) → optional unmount()).
// Everything here is part of the hot-swappable pack; the server parts live in Allmind.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state = null;
const listeners = new Set();
let current = null; // { id, unmount }
let packVersion = null;

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'x-toast' + (bad ? ' bad' : '');
  el.textContent = text;
  $('xToasts').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 2600);
}

async function post(p, body = {}) {
  try {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) toast(j.error || '실패했어요', true);
    return j;
  } catch {
    toast('Allmind에 연결할 수 없어요', true);
    return { ok: false };
  }
}

// Overlay addresses for OBS: always localhost (the browser source runs on the stream PC).
const overlayUrl = (p) => `http://localhost:${location.port || 80}${p}`;
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했어요'); }
  catch { prompt('복사하세요 (Ctrl+C)', text); }
}

// what panels get
const x = {
  get state() { return state; },
  onState(fn) { listeners.add(fn); if (state) fn(state); return () => listeners.delete(fn); },
  post, toast, esc, copy, overlayUrl,
  refresh: () => poll(true),
};

async function poll(force) {
  if (document.hidden && !force) return;
  try {
    const r = await fetch('/api/xylem/state', { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) return;
    state = j;
    renderHeader();
    renderNav();
    for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
  } catch {}
}

function renderHeader() {
  const p = state.pack;
  const parts = [`<span>팩 <b class="mono">v${esc(p.version)}</b>${p.active ? '' : ' (내장)'}</span>`];
  if (p.available) parts.push(`<span class="new">새 팩 v${esc(p.remote.version)}</span><button class="btn accent sm" data-act="apply">지금 적용</button>`);
  else if (p.needsAllmind) parts.push(`<span class="pill warn">새 팩 v${esc(p.remote.version)} — Allmind ${esc(p.needsAllmind)} 필요</span>`);
  parts.push(`<button class="btn ghost sm" data-act="check" ${p.checking ? 'disabled' : ''}>${p.checking ? '확인 중…' : '팩 확인'}</button>`);
  if (p.active || p.rollback.length) {
    const opts = [`<option value="">되돌리기…</option>`, ...p.rollback.map((v) => `<option value="${esc(v)}">v${esc(v)}</option>`), p.active ? `<option value="builtin">내장 팩 v${esc(p.builtin)}</option>` : ''].join('');
    parts.push(`<select class="in" data-act="use" style="padding:3px 6px">${opts}</select>`);
  }
  if (p.error) parts.push(`<span class="pill warn" title="${esc(p.error)}">확인 실패</span>`);
  parts.push(`<span class="small">Allmind ${esc(state.allmind)}</span>`);
  const html = parts.join('');
  if ($('xPack').dataset.html !== html) { $('xPack').innerHTML = html; $('xPack').dataset.html = html; }
}

$('xPack').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  b.disabled = true;
  if (b.dataset.act === 'check') { const r = await post('/api/xylem/check'); if (r.ok && !r.pack.available && !r.pack.error) toast('최신 팩이에요'); }
  if (b.dataset.act === 'apply') { const r = await post('/api/xylem/apply'); if (r.ok) toast(`팩 v${r.pack.version} 적용 — 오버레이가 새로고침돼요`); }
  poll(true);
});
$('xPack').addEventListener('change', async (ev) => {
  const s = ev.target.closest('select[data-act=use]');
  if (!s || !s.value) return;
  const v = s.value === 'builtin' ? null : s.value;
  if (!confirm(`${v ? `팩 v${v}` : '내장 팩'}(으)로 되돌릴까요? 열려 있는 오버레이가 새로고침돼요.`)) { s.value = ''; return; }
  const r = await post('/api/xylem/use', { version: v });
  if (r.ok) toast('되돌렸어요');
});

function renderNav() {
  const mods = state.pack.modules || [];
  const html = mods.map((m) => `<button data-id="${esc(m.id)}" class="${current?.id === m.id ? 'on' : ''}"><span>${esc(m.icon || '•')}</span>${esc(m.name)}<span class="dot ${state.overlays?.[m.id] ? 'live' : ''}" title="${state.overlays?.[m.id] ? `오버레이 ${state.overlays[m.id]}개 연결됨` : '연결된 오버레이 없음'}"></span></button>`).join('');
  if ($('xNav').dataset.html !== html) { $('xNav').innerHTML = html; $('xNav').dataset.html = html; }
  if (!current && mods.length) open(location.hash.slice(1) && mods.some((m) => m.id === location.hash.slice(1)) ? location.hash.slice(1) : mods[0].id);
}
$('xNav').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-id]');
  if (b) open(b.dataset.id);
});

async function open(id) {
  const m = (state.pack.modules || []).find((x) => x.id === id);
  if (!m) return;
  try { current?.unmount?.(); } catch {}
  listeners.clear();
  current = { id };
  history.replaceState(null, '', `#${id}`);
  renderNav();
  $('xBody').innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const mod = await import(`/xylem/${m.panel}?v=${encodeURIComponent(state.pack.version)}`);
    $('xBody').innerHTML = '';
    current.unmount = mod.mount($('xBody'), x, m) || null;
  } catch (e) {
    $('xBody').innerHTML = `<div class="card"><b>이 패널을 불러오지 못했어요.</b><div class="hint">${esc(e.message)}</div><div class="hint">팩을 되돌리거나 다시 적용해 보세요.</div></div>`;
  }
}

// reload when the pack changes (applied here or from another device)
function listen() {
  const es = new EventSource('/api/xylem/events');
  es.addEventListener('hello', (e) => {
    const v = JSON.parse(e.data).pack;
    if (packVersion && v !== packVersion) location.reload();
    packVersion = v;
  });
  es.addEventListener('reload', () => location.reload());
}

listen();
poll(true);
setInterval(poll, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });

// On the stream PC this page is an Allmind app window: keep it grouped under the pinned Allmind taskbar icon
// (Allmind ≥ 0.36.6 tags windows titled "Xylem"; older ones just answer 404, which is fine)
if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) {
  const taskbar = () => fetch('/api/launcher/taskbar', { method: 'POST' }).catch(() => {});
  taskbar();
  addEventListener('focus', taskbar);
}
