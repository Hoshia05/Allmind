// 텍스트 panel on the Xylem page: type text onto the stream and style it live.
// Every box is its own OBS browser source (/text?id=…). Style / animation changes go out as you drag;
// the text itself goes out on 보내기 (Ctrl+Enter) unless 실시간 is on.
const FONTS = [
  ['기본', ['Noto Sans KR', 'Nanum Gothic', 'Gothic A1', 'IBM Plex Sans KR', 'Sunflower', 'Gowun Dodum', 'Orbit']],
  ['굵은 제목', ['Black Han Sans', 'Do Hyeon', 'Jua', 'Bagel Fat One', 'Gugi', 'Black And White Picture']],
  ['손글씨 · 귀여움', ['Nanum Pen Script', 'Gaegu', 'Dongle', 'Hi Melody', 'Cute Font', 'Poor Story', 'Single Day', 'Gamja Flower', 'Kirang Haerang', 'Dokdo', 'East Sea Dokdo', 'Stylish']],
  ['명조 · 붓', ['Noto Serif KR', 'Nanum Myeongjo', 'Gowun Batang', 'Song Myung', 'Yeon Sung', 'Diphylleia', 'Moirai One']],
  ['Windows 글꼴', ['Malgun Gothic', 'Gulim', 'Batang', 'Segoe UI', 'Arial', 'Impact']],
];
const ALL_FONTS = FONTS.flatMap(([, l]) => l);
const ANCH = [['tl', '↖'], ['tc', '↑'], ['tr', '↗'], ['ml', '←'], ['mc', '•'], ['mr', '→'], ['bl', '↙'], ['bc', '↓'], ['br', '↘']];
const IN = [['none', '없음'], ['fade', '서서히'], ['slide-up', '아래에서 위로'], ['slide-down', '위에서 아래로'], ['slide-left', '오른쪽에서'], ['slide-right', '왼쪽에서'], ['pop', '톡 튀어나오기'], ['zoom', '줌 아웃'], ['blur', '흐림 → 선명'], ['typewriter', '타자기']];
const CHANGE = [['none', '바로 바뀜'], ['fade', '서서히'], ['pop', '톡'], ['slide-up', '아래에서 위로'], ['typewriter', '타자기']];
const LOOP = [['none', '없음'], ['float', '둥실둥실'], ['pulse', '두근두근'], ['shake', '덜덜 떨기'], ['wiggle', '흔들흔들'], ['glow', '빛나기'], ['rainbow', '무지개 (색 있는 글자)'], ['blink', '깜빡이기'], ['marquee', '흐르는 글자 (전광판)']];
// ready-made looks (style + animation); saved ones from the server come after these
const BUILTIN = [
  { name: '자막', style: { font: 'Noto Sans KR', size: 56, weight: 700, color: '#ffffff', gradient: false, outlineWidth: 3, outlineColor: '#000000', shadow: 6, shadowAlpha: 60, bgAlpha: 0, borderWidth: 0, anchor: 'bc', offsetX: 0, offsetY: 70, align: 'center' }, anim: { in: 'fade', loop: 'none', change: 'fade' } },
  { name: '공지 배너', style: { font: 'Do Hyeon', size: 48, weight: 400, color: '#ffffff', gradient: false, outlineWidth: 0, shadow: 0, bgColor: '#0d1416', bgAlpha: 85, padX: 28, padY: 12, radius: 14, borderWidth: 3, borderColor: '#2fd8c8', anchor: 'tc', offsetX: 0, offsetY: 40, align: 'center' }, anim: { in: 'slide-down', loop: 'none', change: 'pop' } },
  { name: '전광판', style: { font: 'Black Han Sans', size: 52, weight: 400, color: '#ffd34d', gradient: false, outlineWidth: 0, shadow: 10, shadowColor: '#ff8800', shadowAlpha: 80, bgColor: '#000000', bgAlpha: 70, padX: 0, padY: 10, radius: 0, borderWidth: 0, anchor: 'tc', offsetX: 0, offsetY: 0, maxWidth: 1920 }, anim: { in: 'fade', loop: 'marquee', change: 'fade' } },
  { name: '네온', style: { font: 'Orbit', size: 72, weight: 400, color: '#86efe3', gradient: false, outlineWidth: 0, shadow: 24, shadowColor: '#2fd8c8', shadowAlpha: 100, bgAlpha: 0, borderWidth: 0 }, anim: { in: 'blur', loop: 'glow', change: 'fade' } },
  { name: '손글씨 메모', style: { font: 'Nanum Pen Script', size: 64, weight: 400, color: '#3a2a12', gradient: false, outlineWidth: 0, shadow: 6, shadowAlpha: 35, bgColor: '#fff3a8', bgAlpha: 100, padX: 26, padY: 14, radius: 4, borderWidth: 0, align: 'left', anchor: 'tr', offsetX: 40, offsetY: 40, maxWidth: 520 }, anim: { in: 'pop', loop: 'wiggle', change: 'typewriter' } },
  { name: '그라데이션 제목', style: { font: 'Bagel Fat One', size: 96, weight: 400, color: '#ffe259', gradient: true, color2: '#ff7a59', outlineWidth: 4, outlineColor: '#2b1200', shadow: 12, shadowAlpha: 60, bgAlpha: 0, borderWidth: 0, anchor: 'mc', offsetX: 0, offsetY: 0 }, anim: { in: 'pop', loop: 'float', change: 'pop' } },
];

export function mount(el, x) {
  const { esc } = x;
  let sel = null;        // selected box id
  let boxes = [];
  let presets = [];
  let sendT = null, styleT = null;
  const pending = { style: {}, anim: {} };

  el.innerHTML = `
    <h1>🔤 텍스트 <span class="pill" id="tOv"></span></h1>
    <div class="row" id="tTabs" style="margin-bottom:12px"></div>
    <div class="grid2">
      <section class="card">
        <h2>글자</h2>
        <textarea id="tText" rows="4" class="in t-area" placeholder="방송 화면에 띄울 글자 (여러 줄 가능)"></textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn accent" id="tSend" title="Ctrl+Enter">보내기</button>
          <button class="btn" id="tToggle"></button>
          <button class="btn ghost" id="tClear" title="글자를 비워요 (상자는 그대로)">비우기</button>
          <label class="check" style="margin-left:auto" title="치는 대로 바로 방송에 나가요"><input type="checkbox" id="tLive"> 실시간</label>
        </div>
        <div class="hint" style="margin-top:6px">Ctrl+Enter = 보내기. 보낸 글자는 아래에 남아서 누르면 다시 띄울 수 있어요.</div>
        <div class="t-recent" id="tRecent"></div>
      </section>
      <section class="card">
        <h2>미리보기 <span class="muted small">방송 화면 1920×1080</span></h2>
        <div class="t-prev"><iframe id="tPrev" title="미리보기"></iframe></div>
        <div class="copy" style="margin-top:10px"><code id="tUrl"></code><button class="btn sm" id="tCopy">복사</button></div>
        <div class="hint" style="margin-top:6px">OBS → 소스 추가 → <b>브라우저</b> → 이 주소, 크기 <b>1920×1080</b>. 상자마다 주소가 달라요. 위치는 아래 <b>위치</b>에서 정해요 (OBS에서 소스를 옮기지 않아도 돼요).</div>
      </section>
    </div>
    <section class="card">
      <h2>스타일 모음</h2>
      <div class="row" id="tPresets"></div>
      <div class="row" style="margin-top:8px">
        <input class="in" id="tPName" placeholder="지금 스타일에 이름 붙여 저장" style="width:240px" maxlength="30">
        <button class="btn sm" id="tPSave">저장</button>
        <span class="hint">글자는 그대로, 모양과 애니메이션만 바뀌어요.</span>
      </div>
    </section>
    <div class="grid2">
      <section class="card">
        <h2>글꼴</h2>
        <label class="field">글꼴
          <select class="in" id="sFontSel">${FONTS.map(([g, l]) => `<optgroup label="${g}">${l.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</optgroup>`).join('')}<option value="__custom">직접 입력 (이 PC에 설치된 글꼴)…</option></select></label>
        <label class="field" id="sFontWrap" hidden>설치된 글꼴 이름<input class="in" id="sFontCustom" placeholder="예: 맑은 고딕, Pretendard" maxlength="60"></label>
        ${range('size', '크기', 8, 300, 1, 'px')}
        <div class="row">
          <label class="field" style="flex:1">굵기<select class="in" data-s="weight">${[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => `<option value="${w}">${w}${w === 400 ? ' 보통' : w === 700 ? ' 굵게' : ''}</option>`).join('')}</select></label>
          <label class="field">정렬<span class="seg" data-seg="align"><button data-v="left">왼쪽</button><button data-v="center">가운데</button><button data-v="right">오른쪽</button></span></label>
          <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" data-s="italic"> 기울임</label>
        </div>
        ${range('letterSpacing', '자간', -10, 40, 0.5, 'px')}
        ${range('lineHeight', '줄 간격', 0.7, 2.5, 0.05, '')}
        <div class="hint">글꼴 대부분은 Google Fonts에서 받아요 (OBS는 인터넷이 되니까 괜찮아요). 글꼴마다 쓸 수 있는 굵기가 달라요.</div>
      </section>
      <section class="card">
        <h2>색 · 테두리 · 그림자</h2>
        <div class="row">${color('color', '글자 색')}<label class="check"><input type="checkbox" data-s="gradient"> 그라데이션</label>${color('color2', '아래쪽 색')}</div>
        <div class="row">${color('outlineColor', '외곽선')}<div style="flex:1">${range('outlineWidth', '외곽선 두께', 0, 20, 0.5, 'px')}</div></div>
        <div class="row">${color('shadowColor', '그림자')}<div style="flex:1">${range('shadow', '그림자 크기', 0, 60, 1, 'px')}</div></div>
        ${range('shadowAlpha', '그림자 진하기', 0, 100, 1, '%')}
      </section>
      <section class="card">
        <h2>배경 상자</h2>
        <div class="row">${color('bgColor', '배경 색')}<div style="flex:1">${range('bgAlpha', '배경 진하기 (0 = 없음)', 0, 100, 1, '%')}</div></div>
        ${range('padX', '좌우 여백', 0, 200, 1, 'px')}
        ${range('padY', '위아래 여백', 0, 200, 1, 'px')}
        ${range('radius', '모서리 둥글기', 0, 120, 1, 'px')}
        <div class="row">${color('borderColor', '테두리')}<div style="flex:1">${range('borderWidth', '테두리 두께', 0, 20, 1, 'px')}</div></div>
      </section>
      <section class="card">
        <h2>위치</h2>
        <div class="row" style="align-items:flex-start;gap:16px">
          <div class="t-anchor" id="sAnchor">${ANCH.map(([k, l]) => `<button data-v="${k}" title="${k}">${l}</button>`).join('')}</div>
          <div style="flex:1;min-width:200px">
            ${range('offsetX', '가로 거리', -960, 960, 1, 'px')}
            ${range('offsetY', '세로 거리', -540, 540, 1, 'px')}
            ${range('maxWidth', '최대 너비 (넘으면 줄바꿈)', 100, 1920, 10, 'px')}
          </div>
        </div>
        <div class="hint">거리는 고른 가장자리에서 안쪽으로 (가운데면 가운데에서 옮긴 만큼).</div>
      </section>
      <section class="card">
        <h2>애니메이션</h2>
        <label class="field">나타날 때 (사라질 때는 거꾸로)<select class="in" data-a="in">${IN.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label class="field">글자가 바뀔 때<select class="in" data-a="change">${CHANGE.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label class="field">계속<select class="in" data-a="loop">${LOOP.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        ${range('speed', '빠르기', 0.25, 4, 0.05, '×', 'a')}
        <div class="row" style="margin-top:6px"><button class="btn sm" id="tReplay" title="나타나는 애니메이션을 다시 보여 줘요">▶ 다시 재생</button></div>
      </section>
      <section class="card">
        <h2>이 상자</h2>
        <label class="field">이름<input class="in" id="tName" maxlength="30"></label>
        <div class="row" style="margin-top:10px">
          <button class="btn sm" id="tDup">복제 (같은 스타일로 새 상자)</button>
          <button class="btn danger sm" id="tDel">상자 지우기</button>
        </div>
      </section>
    </div>`;

  function range(k, label, min, max, step, unit, kind = 's') {
    return `<label class="field t-range">${label}<span class="row" style="gap:8px;flex-wrap:nowrap"><input type="range" data-${kind}="${k}" min="${min}" max="${max}" step="${step}" style="flex:1"><input class="in t-num" type="number" data-${kind}n="${k}" min="${min}" max="${max}" step="${step}"><span class="muted small" style="width:18px">${unit}</span></span></label>`;
  }
  function color(k, label) {
    return `<label class="field t-color">${label}<input type="color" data-s="${k}"></label>`;
  }

  const $ = (id) => el.querySelector('#' + id);
  const box = () => boxes.find((b) => b.id === sel);

  // ---------- sending ----------
  function flushStyle() {
    clearTimeout(styleT);
    const patch = {};
    if (Object.keys(pending.style).length) patch.style = pending.style;
    if (Object.keys(pending.anim).length) patch.anim = pending.anim;
    pending.style = {}; pending.anim = {};
    if (!patch.style && !patch.anim) return;
    const b = box();
    if (b) { Object.assign(b.style, patch.style || {}); Object.assign(b.anim, patch.anim || {}); }
    x.post('/api/text/set', { id: sel, patch });
  }
  function setStyle(k, v, kind = 's') {
    (kind === 'a' ? pending.anim : pending.style)[k] = v;
    clearTimeout(styleT);
    styleT = setTimeout(flushStyle, 60); // live while dragging, without flooding
  }
  async function sendText(remember = true) {
    clearTimeout(sendT);
    const text = $('tText').value;
    const r = await x.post('/api/text/set', { id: sel, patch: { text, remember } });
    if (r.ok) { replace(r.box); renderRecent(); }
  }
  async function patchBox(patch) {
    const r = await x.post('/api/text/set', { id: sel, patch });
    if (r.ok) { replace(r.box); renderTop(); }
    return r;
  }
  const replace = (b) => { const i = boxes.findIndex((o) => o.id === b.id); if (i >= 0) boxes[i] = b; else boxes.push(b); };

  // ---------- form ----------
  function fill(b) {
    const s = b.style, a = b.anim;
    const custom = !ALL_FONTS.includes(s.font);
    $('sFontSel').value = custom ? '__custom' : s.font;
    $('sFontWrap').hidden = !custom;
    if (custom) $('sFontCustom').value = s.font;
    for (const i of el.querySelectorAll('[data-s]')) {
      if (i.type === 'checkbox') i.checked = !!s[i.dataset.s]; else i.value = s[i.dataset.s];
    }
    for (const i of el.querySelectorAll('[data-sn]')) i.value = s[i.dataset.sn];
    for (const i of el.querySelectorAll('[data-a]')) i.value = a[i.dataset.a];
    for (const i of el.querySelectorAll('[data-an]')) i.value = a[i.dataset.an];
    for (const g of el.querySelectorAll('[data-seg]')) for (const btn of g.children) btn.classList.toggle('on', btn.dataset.v === s[g.dataset.seg]);
    for (const btn of $('sAnchor').children) btn.classList.toggle('on', btn.dataset.v === s.anchor);
    $('tName').value = b.name;
  }

  function renderTop() {
    const b = box();
    if (!b) return;
    $('tTabs').innerHTML = boxes.map((o) => `<button class="btn sm ${o.id === sel ? 'accent' : ''}" data-box="${esc(o.id)}">${o.visible && o.text.trim() ? '● ' : ''}${esc(o.name)}</button>`).join('')
      + (boxes.length < 12 ? '<button class="btn ghost sm" data-box="__add">+ 상자 추가</button>' : '');
    $('tToggle').textContent = b.visible ? '숨기기' : '보이기';
    $('tToggle').classList.toggle('accent', !b.visible);
    $('tUrl').textContent = x.overlayUrl(`/text?id=${encodeURIComponent(b.id)}`);
    const want = `/text?id=${encodeURIComponent(b.id)}&preview=1`;
    if ($('tPrev').dataset.src !== want) { $('tPrev').dataset.src = want; $('tPrev').src = want; }
  }
  function renderRecent() {
    const b = box();
    $('tRecent').innerHTML = (b?.recent || []).map((t, i) => `<span class="t-chip${t === b.text ? ' on' : ''}" data-i="${i}" title="${esc(t)}"><span>${esc(t.length > 40 ? t.slice(0, 40) + '…' : t).replace(/\n/g, ' ⏎ ')}</span><button data-forget="${i}" title="목록에서 빼기">✕</button></span>`).join('');
  }
  function renderPresets() {
    const all = [...BUILTIN.map((p) => ({ ...p, builtin: true })), ...presets];
    $('tPresets').innerHTML = all.map((p, i) => `<span class="t-chip preset" data-p="${i}"><span>${esc(p.name)}</span>${p.builtin ? '' : `<button data-pdel="${esc(p.name)}" title="지우기">✕</button>`}</span>`).join('');
    $('tPresets')._all = all;
  }

  function select(id) {
    flushStyle();
    sel = id;
    const b = box();
    if (!b) return;
    $('tText').value = b.text;
    fill(b);
    renderTop();
    renderRecent();
  }

  // ---------- events ----------
  el.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.s && t.type !== 'checkbox') {
      const k = t.dataset.s;
      const v = t.type === 'range' ? Number(t.value) : t.value;
      const n = el.querySelector(`[data-sn="${k}"]`); if (n) n.value = t.value;
      setStyle(k, v);
    } else if (t.dataset.sn) {
      const k = t.dataset.sn; const r = el.querySelector(`[data-s="${k}"]`); if (r) r.value = t.value;
      if (t.value !== '') setStyle(k, Number(t.value));
    } else if (t.dataset.a && t.type === 'range') {
      const k = t.dataset.a; const n = el.querySelector(`[data-an="${k}"]`); if (n) n.value = t.value;
      setStyle(k, Number(t.value), 'a');
    } else if (t.dataset.an) {
      const k = t.dataset.an; const r = el.querySelector(`[data-a="${k}"]`); if (r) r.value = t.value;
      if (t.value !== '') setStyle(k, Number(t.value), 'a');
    } else if (t.id === 'tText' && $('tLive').checked) {
      clearTimeout(sendT);
      sendT = setTimeout(() => sendText(false), 150);
    } else if (t.id === 'sFontCustom') {
      if (t.value.trim()) setStyle('font', t.value.trim());
    }
  });
  el.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.s && t.type === 'checkbox') setStyle(t.dataset.s, t.checked);
    else if (t.dataset.s === 'weight') setStyle('weight', Number(t.value));
    else if (t.dataset.a && t.tagName === 'SELECT') setStyle(t.dataset.a, t.value, 'a');
    else if (t.id === 'sFontSel') {
      $('sFontWrap').hidden = t.value !== '__custom';
      if (t.value === '__custom') $('sFontCustom').focus(); else setStyle('font', t.value);
    } else if (t.id === 'tName') patchBox({ name: t.value });
    else if (t.id === 'tLive' && t.checked) sendText(false);
  });
  el.addEventListener('click', async (ev) => {
    const t = ev.target;
    const seg = t.closest('[data-seg] button');
    if (seg) { for (const b of seg.parentElement.children) b.classList.toggle('on', b === seg); setStyle(seg.parentElement.dataset.seg, seg.dataset.v); return; }
    const an = t.closest('#sAnchor button');
    if (an) { for (const b of $('sAnchor').children) b.classList.toggle('on', b === an); setStyle('anchor', an.dataset.v); return; }
    const tab = t.closest('[data-box]');
    if (tab) {
      if (tab.dataset.box === '__add') { const r = await x.post('/api/text/add', {}); if (r.ok) { replace(r.box); select(r.box.id); } }
      else select(tab.dataset.box);
      return;
    }
    const fg = t.closest('[data-forget]');
    if (fg) { ev.stopPropagation(); const b = box(); const r = await x.post('/api/text/forget', { id: sel, text: b.recent[Number(fg.dataset.forget)] }); if (r.ok) { replace(r.box); renderRecent(); } return; }
    const chip = t.closest('#tRecent [data-i]');
    if (chip) { $('tText').value = box().recent[Number(chip.dataset.i)]; sendText(true); return; }
    const pd = t.closest('[data-pdel]');
    if (pd) { ev.stopPropagation(); if (confirm(`"${pd.dataset.pdel}" 스타일을 지울까요?`)) { const r = await x.post('/api/text/preset-delete', { name: pd.dataset.pdel }); if (r.ok) { presets = r.presets; renderPresets(); } } return; }
    const pc = t.closest('[data-p]');
    if (pc) {
      const p = $('tPresets')._all[Number(pc.dataset.p)];
      flushStyle();
      const r = await patchBox({ style: p.style, anim: p.anim });
      if (r.ok) { fill(r.box); x.toast(`"${p.name}" 스타일`); }
      return;
    }
  });
  $('tSend').onclick = () => sendText(true);
  $('tText').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendText(true); } });
  $('tToggle').onclick = () => patchBox({ visible: !box().visible });
  $('tClear').onclick = () => { $('tText').value = ''; sendText(false); };
  $('tCopy').onclick = () => x.copy($('tUrl').textContent);
  $('tReplay').onclick = async () => { flushStyle(); await patchBox({ visible: false }); setTimeout(() => patchBox({ visible: true }), 500); };
  $('tPSave').onclick = async () => {
    flushStyle();
    const r = await x.post('/api/text/preset-save', { id: sel, name: $('tPName').value });
    if (r.ok) { presets = r.presets; renderPresets(); $('tPName').value = ''; x.toast('스타일을 저장했어요'); }
  };
  $('tDup').onclick = async () => { flushStyle(); const r = await x.post('/api/text/add', { copyFrom: sel }); if (r.ok) { replace(r.box); select(r.box.id); } };
  $('tDel').onclick = async () => {
    if (!confirm(`"${box().name}" 상자를 지울까요? OBS의 그 브라우저 소스는 빈 화면이 돼요.`)) return;
    const r = await x.post('/api/text/remove', { id: sel });
    if (r.ok) { boxes = boxes.filter((b) => b.id !== sel); select(boxes[0].id); }
  };

  // ---------- state from the server (polled by the page every 2 s) ----------
  let first = true;
  const off = x.onState((st) => {
    const t = st.text;
    if (!t) { el.innerHTML = '<div class="card">이 기능은 Allmind 0.38.0 이상이 필요해요 — 설정 창에서 업데이트해 주세요.</div>'; return; }
    const n = st.overlays?.text || 0;
    $('tOv').textContent = n ? `오버레이 ${n}개 연결됨` : '연결된 오버레이 없음';
    $('tOv').className = 'pill ' + (n ? 'ok' : '');
    presets = t.presets;
    if (first) {
      first = false;
      boxes = t.boxes;
      renderPresets();
      select((location.hash.split(':')[1] && boxes.some((b) => b.id === location.hash.split(':')[1])) ? location.hash.split(':')[1] : boxes[0].id);
      return;
    }
    // changes made elsewhere (another device): take them unless you're in the middle of editing here
    const editing = el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
    const busy = Object.keys(pending.style).length || Object.keys(pending.anim).length;
    const mine = box();
    boxes = t.boxes.map((b) => (b.id === sel && busy ? mine : b));
    if (!boxes.some((b) => b.id === sel)) { select(boxes[0].id); return; }
    renderTop();
    if (!editing && !busy) { fill(box()); renderRecent(); }
    renderPresets();
  });

  // the preview is the real overlay page at 1920×1080, scaled down to the card
  const ro = new ResizeObserver(() => { const w = $('tPrev').parentElement.clientWidth; $('tPrev').style.transform = `scale(${w / 1920})`; });
  ro.observe($('tPrev').parentElement);

  return () => { flushStyle(); off?.(); ro.disconnect(); };
}
