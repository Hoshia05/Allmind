// VTube Studio panel on the Xylem page: connection, 던지기 (throwing) settings + items + aim, and the
// expression list that viewer-triggered model changes will use later (docs/plans/vts.md).
export function mount(el, x) {
  const { esc } = x;
  el.innerHTML = `
    <h1>🎭 VTube Studio <span class="pill" id="vState"></span></h1>
    <div class="grid2">
      <section class="card">
        <h2>연결</h2>
        <div class="row"><label class="check"><input type="checkbox" id="vOn"> VTube Studio와 연결하기</label></div>
        <label class="field" style="margin-top:8px">VTube Studio 주소 (메인 PC)<input class="in" id="vHost" placeholder="예: 192.168.0.5:8001" spellcheck="false"></label>
        <div class="row" style="margin-top:10px">
          <button class="btn accent" id="vSave">저장하고 연결</button>
          <button class="btn ghost sm" id="vRetry">다시 연결</button>
          <button class="btn ghost sm" id="vForget" title="VTube Studio에서 허용을 다시 받아요">허용 다시 받기</button>
        </div>
        <div class="hint" id="vMsg" style="margin-top:8px"></div>
      </section>
      <section class="card">
        <h2>처음 한 번 <span class="muted small">메인 PC에서</span></h2>
        <ol class="hint" style="line-height:1.8;padding-left:18px;margin:0">
          <li>VTube Studio <b>설정</b>에서 <b>API (플러그인) 켜기</b>를 켜요. 포트는 보통 <b>8001</b>.</li>
          <li>메인 PC의 IP 주소를 확인해요 (Windows 설정 → 네트워크 → 속성의 <b>IPv4 주소</b>, 예: 192.168.0.5) → 왼쪽 칸에 <code>IP:8001</code>.</li>
          <li><b>저장하고 연결</b> → 메인 PC의 VTube Studio에 뜨는 창에서 <b>허용</b> (2번: Allmind 플러그인, 이미지 불러오기). 처음 던지는 물건마다 한 번씩 더 물어볼 수 있어요.</li>
          <li>연결이 안 되면 메인 PC의 Windows 방화벽에서 VTube Studio를 허용해 주세요.</li>
        </ol>
      </section>
    </div>

    <section class="card">
      <h2>🧀 던지기 <span class="muted small" id="tStat"></span></h2>
      <div class="row"><label class="check"><input type="checkbox" id="tOn"> 켜기 — 채팅으로 모델에게 물건을 던져요 (던진 사람 이름은 안 나와요)</label></div>
      <div class="grid2" style="margin-top:10px">
        <label class="field">채팅 명령어 <span class="muted small">쉼표로 여러 개</span><input class="in" id="tCmds"></label>
        <label class="field">시청자당 쿨다운 (초) <span class="muted small">방송인·매니저는 없음</span><input class="in" id="tCd" type="number" min="0" max="600"></label>
        <label class="field">동시에 날아다니는 최대 개수<input class="in" id="tMax" type="number" min="1" max="15"></label>
        <label class="field">물건 크기 <span class="muted small" id="tSizeV"></span><input id="tSize" type="range" min="0.05" max="0.4" step="0.01"></label>
        <label class="field">맞으면 고개 흔들림 <span class="muted small" id="tShakeV"></span><input id="tShake" type="range" min="0" max="100" step="5"></label>
        <div class="field">맞으면
          <label class="check"><input type="checkbox" id="tFlash"> 빨갛게 번쩍</label>
          <label class="check"><input type="checkbox" id="tKnock"> 살짝 밀려나기</label>
        </div>
        <label class="field">맞을 때 누를 VTS 단축키 <span class="muted small">선택 — 아픈 표정 애니메이션 등</span><select class="in" id="tHotkey"><option value="">없음</option></select></label>
        <div class="field">후원으로도 던지기
          <label class="check"><input type="checkbox" id="tDon"> 켜기</label>
          <div class="row" style="margin:4px 0 0"><input class="in" id="tPrice" type="number" min="100" step="100" style="width:110px"> 치즈마다 1개, 최대 <input class="in" id="tDonMax" type="number" min="1" max="30" style="width:70px"> 개</div>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn accent" id="tSave">저장</button>
        <span class="hint" id="tDirty"></span>
      </div>

      <h2 style="margin-top:18px">테스트</h2>
      <div class="row">
        <button class="btn" data-throw="-1">← 왼쪽에서</button>
        <button class="btn" data-throw="1">오른쪽에서 →</button>
        <button class="btn" data-throw="0" data-n="5">5개 연속</button>
      </div>

      <h2 style="margin-top:18px">맞는 위치 (머리) <span class="pill" id="aState"></span></h2>
      <div class="row">
        <button class="btn" id="aStart">조준점 꺼내기</button>
        <button class="btn ghost sm" id="aStop" hidden>그만두기</button>
      </div>
      <div class="hint" id="aHint" style="margin-top:6px">조준점을 꺼내면 VTube Studio에 빨간 과녁이 나와요. 마우스로 <b>머리 위치에 끌어다 놓으면</b> 그 자리가 저장되고 과녁은 사라져요. 모델을 옮겨도 따라가요 (크기를 많이 바꿨다면 다시 맞춰 주세요).</div>

      <h2 style="margin-top:18px">던질 물건 <span class="muted small" id="iCount"></span></h2>
      <div id="iList" style="display:flex;flex-wrap:wrap;gap:10px"></div>
      <div class="row" style="margin-top:10px">
        <label class="btn sm" style="cursor:pointer">＋ 이미지 올리기<input type="file" id="iFile" accept="image/png,image/jpeg,image/gif" multiple hidden></label>
        <span class="hint">PNG·JPG·GIF, 가로·세로 64~2048 픽셀, 5 MB 이하. 배경이 투명한 PNG가 좋아요. 올린 게 없으면 기본 물건(치즈·하트·별)을 던져요.</span>
      </div>
    </section>

    <section class="card">
      <h2>🎨 표정 (모델 바꾸기) <span class="pill">준비 중</span></h2>
      <div class="hint" style="margin-bottom:8px">나중에 시청자가 채팅이나 후원으로 머리·옷 등을 바꿀 수 있게 할 거예요. 그때 아래 VTube Studio 표정을 고르게 돼요. 지금은 켜고 끄는 시험만 할 수 있어요.</div>
      <div class="row"><button class="btn sm" id="eLoad">표정 목록 불러오기</button></div>
      <div id="eList" style="display:grid;gap:6px;margin-top:8px"></div>
    </section>`;

  const $ = (id) => el.querySelector('#' + id);
  let saved = null, dirty = false, hostTyped = false;
  const setDirty = (d) => { dirty = d; $('tDirty').textContent = d ? '저장하지 않은 변경이 있어요' : ''; };

  // ---------- connection ----------
  $('vHost').addEventListener('input', () => { hostTyped = true; });
  $('vSave').onclick = async () => {
    const r = await x.post('/api/vts/connect', { enabled: $('vOn').checked, host: $('vHost').value.trim() });
    if (r.ok) { hostTyped = false; x.toast($('vOn').checked ? '연결하는 중… 메인 PC의 VTube Studio를 확인해 주세요' : 'VTube Studio 연결을 껐어요'); x.refresh(); }
  };
  $('vOn').onchange = () => { hostTyped = true; };
  $('vRetry').onclick = () => x.post('/api/vts/reconnect').then(x.refresh);
  $('vForget').onclick = () => { if (confirm('VTube Studio에서 Allmind 허용을 다시 받을까요? 메인 PC에 허용 창이 다시 떠요.')) x.post('/api/vts/forget').then(x.refresh); };

  // ---------- throw settings ----------
  const ids = ['tOn', 'tCmds', 'tCd', 'tMax', 'tSize', 'tShake', 'tFlash', 'tKnock', 'tHotkey', 'tDon', 'tPrice', 'tDonMax'];
  for (const id of ids) $(id).addEventListener('input', () => { setDirty(true); labels(); });
  const labels = () => { $('tSizeV').textContent = Number($('tSize').value).toFixed(2); $('tShakeV').textContent = $('tShake').value; };
  function fill(s) {
    saved = s;
    $('tOn').checked = s.enabled; $('tCmds').value = s.commands.join(', '); $('tCd').value = s.cooldownSec; $('tMax').value = s.maxInAir;
    $('tSize').value = s.size; $('tShake').value = s.shake; $('tFlash').checked = s.flash; $('tKnock').checked = s.knockback;
    $('tDon').checked = s.donation.enabled; $('tPrice').value = s.donation.price; $('tDonMax').value = s.donation.max;
    setHotkey(s.hitHotkey);
    labels(); setDirty(false);
  }
  function setHotkey(v) {
    const sel = $('tHotkey');
    if (v && !sel.querySelector(`option[value="${CSS.escape(v)}"]`)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(v)}</option>`);
    sel.value = v || '';
  }
  let hotkeysLoaded = false;
  async function loadHotkeys() {
    const r = await fetch('/api/vts/hotkeys').then((r) => r.json()).catch(() => ({}));
    if (!r.ok) return;
    hotkeysLoaded = true;
    const cur = $('tHotkey').value;
    $('tHotkey').innerHTML = '<option value="">없음</option>' + r.hotkeys.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}${h.type === 'ToggleExpression' ? ' (표정 — 켜진 채로 남아요)' : ''}</option>`).join('');
    setHotkey(cur || saved?.hitHotkey || '');
  }
  $('tSave').onclick = async () => {
    const r = await x.post('/api/vts/throw-settings', { settings: {
      enabled: $('tOn').checked, commands: $('tCmds').value, cooldownSec: Number($('tCd').value), maxInAir: Number($('tMax').value),
      size: Number($('tSize').value), shake: Number($('tShake').value), flash: $('tFlash').checked, knockback: $('tKnock').checked, hitHotkey: $('tHotkey').value,
      donation: { enabled: $('tDon').checked, price: Number($('tPrice').value), max: Number($('tDonMax').value) }, aim: saved.aim,
    } });
    if (r.ok) { fill(r.settings); x.toast('던지기 설정을 저장했어요'); }
  };
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-throw]');
    if (!b) return;
    const r = await x.post('/api/vts/test-throw', { side: Number(b.dataset.throw), count: Number(b.dataset.n) || 1 });
    if (r.ok) x.refresh();
  });

  // ---------- aim ----------
  $('aStart').onclick = async () => { const r = await x.post('/api/vts/aim-start'); if (r.ok) x.toast('VTube Studio에서 빨간 과녁을 머리 위치로 끌어다 놓으세요'); x.refresh(); };
  $('aStop').onclick = () => x.post('/api/vts/aim-stop').then(x.refresh);

  // ---------- items ----------
  $('iFile').onchange = async () => {
    for (const f of [...$('iFile').files]) {
      if (f.size > 5 * 1024 * 1024) { x.toast(`${f.name}: 5 MB보다 커요`, true); continue; }
      const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
      const r = await x.post('/api/vts/items', { name: f.name, data });
      if (r.ok) x.toast(`올렸어요: ${r.file}`);
    }
    $('iFile').value = '';
    x.refresh();
  };
  $('iList').onclick = async (ev) => {
    const b = ev.target.closest('button[data-del]');
    if (!b) return;
    if (!confirm(`${b.dataset.del} 를 지울까요?`)) return;
    await x.post('/api/vts/items-remove', { file: b.dataset.del });
    x.refresh();
  };

  // ---------- expressions (groundwork) ----------
  async function loadExpr() {
    const r = await fetch('/api/vts/expressions').then((r) => r.json()).catch(() => ({}));
    if (!r.ok) { $('eList').innerHTML = `<div class="muted">${esc(r.error || '불러오지 못했어요')}</div>`; return; }
    renderExpr(r.expressions);
  }
  function renderExpr(list) {
    $('eList').innerHTML = list.map((e) => `<div class="row" style="margin:0;gap:10px">
      <span class="pill ${e.active ? 'ok' : ''}" style="min-width:42px;text-align:center">${e.active ? '켜짐' : '꺼짐'}</span>
      <b style="flex:1">${esc(e.name)}</b><span class="muted small mono">${esc(e.file)}</span>
      <button class="btn ghost sm" data-exp="${esc(e.file)}" data-on="${e.active ? 0 : 1}">${e.active ? '끄기' : '켜기'}</button></div>`).join('') || '<div class="muted">이 모델에는 표정이 없어요</div>';
  }
  $('eLoad').onclick = loadExpr;
  $('eList').onclick = async (ev) => {
    const b = ev.target.closest('button[data-exp]');
    if (!b) return;
    const r = await x.post('/api/vts/expression', { file: b.dataset.exp, active: b.dataset.on === '1' });
    if (r.ok) renderExpr(r.expressions);
  };

  // ---------- live ----------
  const STATE = { off: ['', '꺼짐'], connecting: ['warn', '연결하는 중'], auth: ['warn', '허용 기다리는 중'], ready: ['ok', '연결됨'], error: ['bad', '연결 안 됨'] };
  let itemsHtml = '';
  return x.onState((st) => {
    const v = st.vts;
    if (!v) return;
    const [cls, txt] = STATE[v.state] || ['', v.state];
    $('vState').className = `pill ${cls}`;
    $('vState').textContent = v.state === 'ready' && v.model ? `연결됨 · ${v.model}` : txt;
    if (!hostTyped) { $('vOn').checked = v.enabled; if (document.activeElement !== $('vHost')) $('vHost').value = v.host ?? (v.url || '').replace('ws://', ''); }
    $('vMsg').textContent = v.error || (v.state === 'ready' ? `VTube Studio ${v.version || ''} · 모델: ${v.model || '없음'}` : v.enabled ? '' : '꺼져 있어요');
    $('vMsg').style.color = v.state === 'error' || v.state === 'auth' ? 'var(--warn)' : '';
    if (v.state === 'ready' && !hotkeysLoaded) loadHotkeys();
    const t = v.throw;
    if (!saved || (!dirty && JSON.stringify(saved) !== JSON.stringify(t.settings))) fill(t.settings);
    $('tStat').textContent = `${t.settings.enabled ? '켜짐' : '꺼짐'} · 지금까지 ${t.thrown}개${t.inAir ? ` · 날아가는 중 ${t.inAir}` : ''}${t.queued ? ` · 대기 ${t.queued}` : ''}${t.error ? ` · 마지막 오류: ${t.error}` : ''}`;
    $('aState').className = `pill ${t.aiming ? 'warn' : t.settings.aim.set ? 'ok' : ''}`;
    $('aState').textContent = t.aiming ? 'VTS에서 끌어다 놓는 중' : t.settings.aim.set ? '맞춰 둠' : '기본 위치';
    $('aStop').style.display = t.aiming ? '' : 'none';
    $('aStart').disabled = !!t.aiming || v.state !== 'ready';
    for (const b of el.querySelectorAll('button[data-throw]')) b.disabled = v.state !== 'ready';
    const ih = t.items.map((it) => `<div style="width:96px;text-align:center"><div style="width:96px;height:96px;border-radius:10px;background:var(--panel-2,#131d20) url('/api/vts/item?file=${encodeURIComponent(it.file)}') center/contain no-repeat;border:1px solid var(--line,#20333a)"></div>
      <div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.file)}</div>${it.builtin ? '<span class="pill">기본</span>' : `<button class="btn ghost sm" data-del="${esc(it.file)}">지우기</button>`}</div>`).join('');
    if (ih !== itemsHtml) { $('iList').innerHTML = ih; itemsHtml = ih; }
    $('iCount').textContent = t.items[0]?.builtin ? '기본 물건' : `${t.items.length}개`;
  });
}
