// 치즈 룰렛 panel on the Xylem page: live control (queue, results, ✓ 완료, test) + settings editor.
export function mount(el, x) {
  const { esc } = x;
  el.innerHTML = `
    <h1>🎡 치즈 룰렛 <span class="pill" id="rlState"></span></h1>
    <div class="grid2">
      <section class="card">
        <h2>지금</h2>
        <div class="row"><span id="rlQueue" class="muted"></span></div>
        <div class="row">
          <button class="btn" id="rlTest1">테스트 1회</button>
          <button class="btn" id="rlTest3">테스트 3회</button>
          <button class="btn ghost" id="rlSkip" title="대기 중인 회전을 화면에 보여주지 않고 넘겨요 (결과는 기록에 남아요)">대기 건너뛰기</button>
        </div>
        <div class="hint" style="margin-top:8px">테스트 회전은 기록에 '테스트'로 표시돼요. 결과는 Allmind가 정하고, 오버레이는 그 결과로 돌아가는 모습만 보여줘요.</div>
      </section>
      <section class="card">
        <h2>OBS 오버레이</h2>
        <div class="copy"><code id="rlUrl"></code><button class="btn sm" id="rlCopy">복사</button></div>
        <div class="hint" style="margin-top:6px">OBS → 소스 추가 → <b>브라우저</b> → 위 주소, 크기 <b>800×900</b> 추천 (배경 투명). 효과음을 방송에 넣으려면 브라우저 소스의 <b>"OBS를 통해 오디오 제어"</b>를 켜세요. 주소 끝에 <code>?sound=0</code>이면 효과음 없음, <code>?demo=1</code>이면 위치 잡기용 미리보기.</div>
      </section>
    </div>

    <section class="card">
      <h2>🎲 무료 룰렛 <span class="muted small">후원 없이 방송인이 돌려요 — 다음 게임 정하기, 벌칙 정하기 등</span></h2>
      <div id="wlList" style="display:grid;gap:12px"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" id="wlAdd">＋ 무료 룰렛 추가</button>
        <span class="hint">같은 OBS 룰렛 오버레이에 나와요. 결과는 기록에 🎲로 남아요. 바꾼 뒤에는 아래 <b>저장</b>을 눌러 주세요 (돌리기를 누르면 자동으로 저장돼요).</span>
      </div>
    </section>

    <section class="card">
      <h2>기록 <span class="muted small" id="rlLogCount"></span></h2>
      <div style="max-height:360px; overflow:auto"><table><thead><tr><th>시간</th><th>후원자</th><th>치즈</th><th>결과</th><th>완료</th></tr></thead><tbody id="rlLog"></tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="rlClear">기록 지우기</button><span class="hint">아직 화면에 안 나온 회전은 지우지 않아요.</span></div>
    </section>

    <section class="card">
      <h2>설정</h2>
      <div class="row"><label class="check"><input type="checkbox" id="rsOn"> 룰렛 켜기 (후원이 오면 자동으로 돌아가요)</label></div>
      <div class="grid2" style="margin-top:10px">
        <label class="field">룰렛 이름<input id="rsTitle" maxlength="30"></label>
        <label class="field">1회 가격 (치즈)<input id="rsPrice" type="number" min="100" step="100"></label>
        <label class="field">후원 1번에 최대 횟수<input id="rsMax" type="number" min="1" max="50"></label>
        <div class="field">돌아가는 후원 종류
          <div class="row"><label class="check"><input type="checkbox" id="rsKChat"> 채팅 후원</label><label class="check"><input type="checkbox" id="rsKVideo"> 영상 후원</label><label class="check"><input type="checkbox" id="rsKMission"> 미션 후원</label></div>
        </div>
        <label class="field">회전 시간 (초)<input id="rsSpin" type="number" min="2" max="20" step="0.5"></label>
        <label class="field">결과 표시 시간 (초)<input id="rsHold" type="number" min="1" max="30" step="0.5"></label>
        <label class="field">빠르게 돌리기 — 후원 1번에 이 횟수 이상이면<input id="rsFast" type="number" min="0" max="50"></label>
        <div class="hint" style="align-self:end">빠르게 돌리기: 한 번에 여러 회면 짧게 연달아 돌리고 마지막에 <b>결과 요약</b>을 보여 줘요. 0 = 끔.</div>
      </div>
      <div class="hint" id="rsExample" style="margin-top:6px"></div>

      <h2 style="margin-top:16px">항목 <span class="muted small" id="rsTotal"></span></h2>
      <table><thead><tr><th style="width:36px"></th><th>이름</th><th style="width:100px">가중치</th><th style="width:64px">확률</th><th style="width:130px">등급</th><th style="width:52px">색</th><th style="width:90px"></th></tr></thead><tbody id="rsItems" data-list="main"></tbody></table>
      <div class="row" style="margin-top:8px">
        <button class="btn sm" id="rsAdd">＋ 항목 추가</button>
        <button class="btn ghost sm" id="rsEven" title="모든 항목을 같은 확률로">확률 똑같이</button>
        <span class="hint">가중치는 비율이에요 (합이 100일 필요 없어요). 0이면 룰렛에서 빠져요. 등급 <b>자동</b>: 확률 5% 이하 = 전설, 15% 이하 = 희귀. 희귀는 금빛, 전설은 화면 번쩍 + 꽃가루로 축하해요.</span>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn accent" id="rsSave">저장</button>
        <button class="btn ghost" id="rsReset">되돌리기</button>
        <span class="hint" id="rsDirty"></span>
      </div>
    </section>`;

  const $ = (id) => el.querySelector('#' + id);
  const fmtTime = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  let draft = null;   // settings being edited
  let saved = null;   // last settings from the server
  let dirty = false;

  $('rlUrl').textContent = x.overlayUrl('/roulette');
  $('rlCopy').onclick = () => x.copy(x.overlayUrl('/roulette'));
  $('rlTest1').onclick = () => x.post('/api/roulette/test', { spins: 1 }).then(x.refresh);
  $('rlTest3').onclick = () => x.post('/api/roulette/test', { spins: 3 }).then(x.refresh);
  $('rlSkip').onclick = () => { if (confirm('대기 중인 회전을 모두 건너뛸까요?')) x.post('/api/roulette/skip').then(x.refresh); };
  $('rlClear').onclick = () => { if (confirm('룰렛 기록을 지울까요?')) x.post('/api/roulette/clear-log').then(x.refresh); };
  $('rlLog').onchange = (ev) => {
    const c = ev.target.closest('input[data-id]');
    if (c) x.post('/api/roulette/done', { id: c.dataset.id, done: c.checked });
  };

  // ---------- settings editor ----------
  const fields = () => ({
    enabled: $('rsOn').checked, title: $('rsTitle').value, price: Number($('rsPrice').value), maxSpins: Number($('rsMax').value),
    kinds: { CHAT: $('rsKChat').checked, VIDEO: $('rsKVideo').checked, MISSION: $('rsKMission').checked },
    spinSec: Number($('rsSpin').value), holdSec: Number($('rsHold').value), fastFrom: Number($('rsFast').value),
  });
  function fill(s) {
    draft = JSON.parse(JSON.stringify(s));
    $('rsOn').checked = s.enabled; $('rsTitle').value = s.title; $('rsPrice').value = s.price; $('rsMax').value = s.maxSpins;
    $('rsKChat').checked = !!s.kinds.CHAT; $('rsKVideo').checked = !!s.kinds.VIDEO; $('rsKMission').checked = !!s.kinds.MISSION;
    $('rsSpin').value = s.spinSec; $('rsHold').value = s.holdSec; $('rsFast').value = s.fastFrom ?? 3;
    draft.wheels ||= [];
    renderItems();
    renderWheels();
    setDirty(false);
  }
  function setDirty(d) {
    dirty = d;
    $('rsDirty').textContent = d ? '저장하지 않은 변경이 있어요' : '';
    const p = Number($('rsPrice').value) || 0, m = Number($('rsMax').value) || 0;
    $('rsExample').textContent = p ? `예: ${(p * 3).toLocaleString()} 치즈 후원 → 3회, ${(p * 1.5).toLocaleString()} 치즈 → 1회 (남는 치즈는 그냥 후원). 한 번에 최대 ${m}회.` : '';
  }
  const TIER_NAMES = { auto: '자동', normal: '일반', rare: '✦ 희귀', legend: '★ 전설' };
  const autoTier = (it, items) => {
    const total = items.reduce((a, x) => a + (Number(x.weight) > 0 ? Number(x.weight) : 0), 0) || 1;
    const p = (Number(it.weight) > 0 ? Number(it.weight) : 0) / total;
    return p <= 0.05 ? 'legend' : p <= 0.15 ? 'rare' : 'normal';
  };
  const pctOf = (it, total) => (total > 0 && it.weight > 0 ? ((it.weight / total) * 100).toFixed(it.weight / total < 0.1 ? 1 : 0) : '0');
  const totalOf = (items) => items.reduce((a, it) => a + (Number(it.weight) > 0 ? Number(it.weight) : 0), 0);
  function itemRows(items) {
    const total = totalOf(items);
    return items.map((it, i) => {
      const t = it.tier || 'auto';
      const opts = Object.entries(TIER_NAMES).map(([k, v]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${k === 'auto' ? `자동 (${TIER_NAMES[autoTier(it, items)].replace(/^[✦★] /, '')})` : v}</option>`).join('');
      return `<tr data-i="${i}">
        <td><span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${esc(it.color)}"></span></td>
        <td><input class="in" data-k="name" value="${esc(it.name)}" maxlength="30" style="width:100%"></td>
        <td><input class="in" data-k="weight" type="number" min="0" step="any" value="${esc(it.weight)}" style="width:100%"></td>
        <td class="mono">${pctOf(it, total)}%</td>
        <td><select class="in" data-k="tier" style="width:100%">${opts}</select></td>
        <td><input data-k="color" type="color" value="${esc(it.color)}" style="width:40px;height:28px;border:0;background:none;padding:0"></td>
        <td><button class="btn ghost sm" data-a="up" title="위로">↑</button><button class="btn ghost sm" data-a="del" title="삭제">✕</button></td>
      </tr>`;
    }).join('');
  }
  function renderItems() {
    $('rsTotal').textContent = `${draft.items.length}개`;
    $('rsItems').innerHTML = itemRows(draft.items);
  }
  const TABLE_HEAD = '<thead><tr><th style="width:36px"></th><th>이름</th><th style="width:100px">가중치</th><th style="width:64px">확률</th><th style="width:130px">등급</th><th style="width:52px">색</th><th style="width:90px"></th></tr></thead>';
  function renderWheels() {
    $('wlList').innerHTML = draft.wheels.map((w, wi) => `<div class="card" style="margin:0;padding:12px" data-w="${wi}">
      <div class="row" style="margin:0 0 8px">
        <input class="in" data-wk="title" value="${esc(w.title)}" maxlength="30" style="flex:1;font-weight:700" placeholder="예: 다음 게임 정하기">
        <button class="btn accent sm" data-wa="spin1">돌리기</button>
        <button class="btn sm" data-wa="spin3">3회</button>
        <button class="btn ghost sm" data-wa="del" title="이 무료 룰렛 삭제">삭제</button>
      </div>
      <table>${TABLE_HEAD}<tbody data-list="${wi}">${itemRows(w.items)}</tbody></table>
      <div class="row" style="margin-top:6px"><button class="btn sm" data-wa="add">＋ 항목</button><button class="btn ghost sm" data-wa="even">확률 똑같이</button></div>
    </div>`).join('') || '<div class="muted">아직 없어요. ＋ 무료 룰렛 추가로 만들어 보세요.</div>';
  }
  const listOf = (key) => (key === 'main' ? draft.items : draft.wheels[Number(key)].items);
  const rerender = (key) => (key === 'main' ? renderItems() : renderWheels());
  const PALETTE = ['#ff6b6b', '#ffd34d', '#5be37d', '#4fc3f7', '#b388ff', '#ff9f43', '#f06292', '#2fd8c8', '#9ccc65', '#ffb74d'];
  const newItem = (n) => ({ id: Math.random().toString(36).slice(2, 10), name: `항목 ${n + 1}`, weight: 10, color: PALETTE[n % PALETTE.length], tier: 'auto' });
  // keep focus while typing a weight: only refresh the % column and the 자동 labels
  function refreshMeta(tb) {
    const items = listOf(tb.dataset.list);
    const total = totalOf(items);
    tb.querySelectorAll('tr[data-i]').forEach((tr, i) => {
      const it = items[i];
      tr.children[3].textContent = `${pctOf(it, total)}%`;
      const o = tr.querySelector('select[data-k=tier] option[value=auto]');
      if (o) o.textContent = `자동 (${TIER_NAMES[autoTier(it, items)].replace(/^[✦★] /, '')})`;
    });
  }
  // one set of handlers for the main table and every wheel's table
  el.addEventListener('input', (ev) => {
    const tb = ev.target.closest('tbody[data-list]');
    const k = ev.target.dataset.k;
    if (tb && k) {
      const tr = ev.target.closest('tr[data-i]');
      const it = listOf(tb.dataset.list)[Number(tr.dataset.i)];
      it[k] = k === 'weight' ? Number(ev.target.value) : ev.target.value;
      if (k === 'weight') refreshMeta(tb);
      else if (k === 'color') tr.children[0].firstElementChild.style.background = ev.target.value;
      setDirty(true);
      return;
    }
    const wk = ev.target.dataset.wk;
    if (wk) { draft.wheels[Number(ev.target.closest('[data-w]').dataset.w)][wk] = ev.target.value; setDirty(true); }
  });
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-a]');
    if (b) {
      const tb = b.closest('tbody[data-list]');
      if (!tb) return;
      const items = listOf(tb.dataset.list);
      const i = Number(b.closest('tr').dataset.i);
      if (b.dataset.a === 'del') { if (items.length <= 2) return x.toast('항목은 2개 이상 있어야 해요', true); items.splice(i, 1); }
      if (b.dataset.a === 'up' && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
      rerender(tb.dataset.list); setDirty(true);
      return;
    }
    const wb = ev.target.closest('button[data-wa]');
    if (!wb) return;
    const wi = Number(wb.closest('[data-w]').dataset.w);
    const w = draft.wheels[wi];
    if (wb.dataset.wa === 'del') { if (!confirm(`"${w.title}" 무료 룰렛을 삭제할까요?`)) return; draft.wheels.splice(wi, 1); renderWheels(); setDirty(true); }
    if (wb.dataset.wa === 'add') { if (w.items.length >= 24) return; w.items.push(newItem(w.items.length)); renderWheels(); setDirty(true); }
    if (wb.dataset.wa === 'even') { for (const it of w.items) it.weight = 1; renderWheels(); setDirty(true); }
    if (wb.dataset.wa === 'spin1' || wb.dataset.wa === 'spin3') {
      if (dirty && !(await save(true))) return;
      const id = saved.wheels[wi]?.id;
      wb.disabled = true;
      const r = await x.post('/api/roulette/wheel-spin', { id, spins: wb.dataset.wa === 'spin3' ? 3 : 1 });
      wb.disabled = false;
      if (r.ok) { x.toast(`🎲 ${w.title}: ${r.spins.map((sp) => sp.result).join(', ')}`); x.refresh(); }
    }
  });
  $('wlAdd').onclick = () => {
    if (draft.wheels.length >= 8) return x.toast('무료 룰렛은 8개까지예요', true);
    draft.wheels.push({ id: Math.random().toString(36).slice(2, 10), title: `무료 룰렛 ${draft.wheels.length + 1}`, items: [0, 1, 2].map((n) => ({ ...newItem(n), name: `선택지 ${n + 1}`, weight: 1 })) });
    renderWheels(); setDirty(true);
  };
  $('rsAdd').onclick = () => { if (draft.items.length >= 24) return; draft.items.push(newItem(draft.items.length)); renderItems(); setDirty(true); };
  $('rsEven').onclick = () => { for (const it of draft.items) it.weight = 1; renderItems(); setDirty(true); };
  for (const id of ['rsOn', 'rsTitle', 'rsPrice', 'rsMax', 'rsKChat', 'rsKVideo', 'rsKMission', 'rsSpin', 'rsHold', 'rsFast']) $(id).addEventListener('input', () => setDirty(true));
  $('rsReset').onclick = () => saved && fill(saved);
  async function save(quiet) {
    const r = await x.post('/api/roulette/settings', { settings: { ...fields(), items: draft.items, wheels: draft.wheels } });
    if (r.ok) { saved = r.settings; fill(saved); if (!quiet) x.toast('룰렛 설정을 저장했어요'); }
    return r.ok;
  }
  $('rsSave').onclick = () => save();

  // ---------- live ----------
  let logHtml = '';
  const off = x.onState((st) => {
    const r = st.roulette;
    if (!saved) { saved = r.settings; fill(saved); }
    else if (!dirty && JSON.stringify(saved) !== JSON.stringify(r.settings)) { saved = r.settings; fill(saved); } // changed on another device
    $('rlState').className = 'pill ' + (r.settings.enabled ? (st.overlays.roulette ? 'ok' : 'warn') : '');
    $('rlState').textContent = !r.settings.enabled ? '꺼짐' : st.overlays.roulette ? `켜짐 · 오버레이 ${st.overlays.roulette}개` : '켜짐 · 오버레이 연결 안 됨';
    $('rlQueue').innerHTML = r.pending ? `<b style="color:var(--accent-2)">${r.pending}회</b> 화면에 나오길 기다리는 중${st.overlays.roulette ? '' : ' — OBS 오버레이가 연결되면 돌아가요'}` : '대기 중인 회전 없음';
    const html = r.log.map((row) => `<tr class="${row.test ? 'dim' : ''}">
      <td class="mono">${fmtTime(row.time)}</td>
      <td>${row.wheel ? `🎲 ${esc(row.wheelTitle || row.nick)}` : esc(row.nick)}${row.of > 1 ? ` <span class="muted small">${row.idx}/${row.of}</span>` : ''}${row.test ? ' <span class="pill">테스트</span>' : ''}${row.shown ? '' : ' <span class="pill warn">대기</span>'}</td>
      <td class="mono">${row.wheel ? '무료' : row.idx === 1 ? Number(row.amount || 0).toLocaleString() : ''}</td>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${esc(row.color)};margin-right:6px"></span>${row.tier === 'legend' ? '★ ' : row.tier === 'rare' ? '✦ ' : ''}${esc(row.result)}</td>
      <td><input type="checkbox" data-id="${esc(row.id)}" ${row.done ? 'checked' : ''}></td></tr>`).join('') || '<tr><td colspan="5" class="muted">아직 기록이 없어요</td></tr>';
    if (html !== logHtml && !el.contains(document.activeElement?.closest?.('#rlLog') || null)) { $('rlLog').innerHTML = html; logHtml = html; }
    $('rlLogCount').textContent = r.log.length ? `${r.log.length}개` : '';
  });
  return () => off();
}
