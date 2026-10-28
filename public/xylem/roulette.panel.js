// 치즈 룰렛 panel on the Xylem page: live control (queue, results, ✓ 완료, tests), the donation roulettes
// (each with its own exact price), 무료 룰렛, the odds board / `!룰렛` answer, and the shared settings.
export function mount(el, x) {
  const { esc } = x;
  el.innerHTML = `
    <h1>🎡 치즈 룰렛 <span class="pill" id="rlState"></span></h1>
    <div class="grid2">
      <section class="card">
        <h2>지금</h2>
        <div class="row"><span id="rlQueue" class="muted"></span></div>
        <div class="row"><button class="btn ghost" id="rlSkip" title="대기 중인 회전을 화면에 보여주지 않고 넘겨요 (결과는 기록에 남아요)">대기 건너뛰기</button></div>
        <div class="hint" style="margin-top:8px">테스트 회전은 각 룰렛의 <b>테스트</b> 버튼으로 — 기록에 '테스트'로 표시돼요. 결과는 Allmind가 정하고, 오버레이는 그 결과로 돌아가는 모습만 보여줘요.</div>
      </section>
      <section class="card">
        <h2>OBS 오버레이</h2>
        <div class="hint" style="margin:0 0 4px"><b>룰렛</b> (돌아가는 화면) — 800×900 추천</div>
        <div class="copy"><code id="rlUrl"></code><button class="btn sm" data-copy="/roulette">복사</button></div>
        <div class="hint" style="margin:10px 0 4px"><b>룰렛 안내판</b> (가격·확률·등급) — 520×760 추천</div>
        <div class="copy"><code id="rbUrl"></code><button class="btn sm" data-copy="/roulette-board">복사</button></div>
        <div class="hint" style="margin-top:6px">OBS → 소스 추가 → <b>브라우저</b> → 주소 붙여 넣기 (배경 투명). 룰렛 효과음을 방송에 넣으려면 <b>"OBS를 통해 오디오 제어"</b>를 켜세요. 주소 끝에 <code>?demo=1</code>이면 위치 잡기용 미리보기, 안내판은 <code>?always=1</code>이면 항상 보여요.</div>
      </section>
    </div>

    <section class="card">
      <h2>💸 후원 룰렛 <span class="muted small">투네이션처럼 — 룰렛마다 가격이 달라요</span></h2>
      <div class="hint" style="margin:0 0 10px">시청자가 <b>정확히 그 가격</b>(또는 2배·3배…)으로 후원하면 그 룰렛이 그만큼 돌아가요. 다른 금액은 <b>일반 후원</b>이라 안 돌아가요. 일반 후원과 헷갈리지 않게 <b>1,004</b>·<b>3,333</b>처럼 눈에 띄는 가격을 추천해요 (한 가격이 다른 가격의 2배·3배…가 되지 않게).</div>
      <div id="rsList" style="display:grid;gap:12px"></div>
      <div id="rsOverlaps" class="hint" style="margin-top:8px;color:var(--warn)"></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="rsAddR">＋ 후원 룰렛 추가</button><span class="hint">8개까지</span></div>
    </section>

    <section class="card">
      <h2>🎲 무료 룰렛 <span class="muted small">후원 없이 방송인이 돌려요 — 다음 게임 정하기, 벌칙 정하기 등</span></h2>
      <div id="wlList" style="display:grid;gap:12px"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" id="wlAdd">＋ 무료 룰렛 추가</button>
        <span class="hint">같은 OBS 룰렛 오버레이에 나와요. 결과는 기록에 🎲로 남아요. 돌리기를 누르면 바뀐 설정이 자동으로 저장돼요.</span>
      </div>
    </section>

    <section class="card">
      <h2>📣 시청자에게 확률 보여주기</h2>
      <div class="grid2">
        <div>
          <h3 style="margin:0 0 6px;font-size:14px">룰렛 안내판 <span class="pill" id="rbState"></span></h3>
          <label class="field">언제 보여 줄까요<select class="in" id="rbMode"><option value="always">항상</option><option value="every">몇 분마다 잠깐</option><option value="off">자동으로는 안 보여 줌</option></select></label>
          <div class="grid2" style="margin-top:6px">
            <label class="field">몇 분마다<input id="rbEvery" type="number" min="1" max="120"></label>
            <label class="field">몇 초 동안<input id="rbShow" type="number" min="5" max="120"></label>
          </div>
          <div class="row"><label class="check"><input type="checkbox" id="rbCmd"> 채팅 명령어가 나오면 보여 주기</label></div>
          <div class="row"><label class="check"><input type="checkbox" id="rbBusy"> 룰렛이 돌아가는 동안엔 숨기기</label></div>
          <div class="row"><button class="btn sm" id="rbNow">지금 보여 주기</button></div>
        </div>
        <div>
          <h3 style="margin:0 0 6px;font-size:14px">채팅 명령어 <span class="pill" id="rcState"></span></h3>
          <div class="row" style="margin-top:0"><label class="check"><input type="checkbox" id="rcOn"> 시청자가 명령어를 치면 채팅으로 확률 알려 주기</label></div>
          <div class="grid2" style="margin-top:6px">
            <label class="field">명령어<input id="rcCmd" maxlength="20"></label>
            <label class="field">다시 답하기까지 (초)<input id="rcCool" type="number" min="5" max="600"></label>
          </div>
          <div class="hint" id="rcHint"></div>
          <div class="field" style="margin-top:6px">채팅에 이렇게 나가요 (저장된 설정 기준)<pre id="rcPreview" class="mono small" style="white-space:pre-wrap;margin:4px 0 0;padding:8px 10px;border-radius:8px;background:var(--panel-2);border:1px solid var(--line)"></pre></div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>기록 <span class="muted small" id="rlLogCount"></span></h2>
      <div style="max-height:360px; overflow:auto"><table><thead><tr><th>시간</th><th>후원자</th><th>치즈</th><th>결과</th><th>완료</th></tr></thead><tbody id="rlLog"></tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="rlClear">기록 지우기</button><span class="hint">아직 화면에 안 나온 회전은 지우지 않아요.</span></div>
    </section>

    <section class="card">
      <h2>공통 설정</h2>
      <div class="row"><label class="check"><input type="checkbox" id="rsOn"> 룰렛 켜기 (룰렛 가격으로 후원이 오면 자동으로 돌아가요)</label></div>
      <div class="grid2" style="margin-top:10px">
        <label class="field">후원 1번에 최대 횟수<input id="rsMax" type="number" min="1" max="50"></label>
        <div class="field">돌아가는 후원 종류
          <div class="row"><label class="check"><input type="checkbox" id="rsKChat"> 채팅 후원</label><label class="check"><input type="checkbox" id="rsKVideo"> 영상 후원</label><label class="check"><input type="checkbox" id="rsKMission"> 미션 후원</label></div>
        </div>
        <label class="field">회전 시간 (초)<input id="rsSpin" type="number" min="2" max="20" step="0.5"></label>
        <label class="field">결과 표시 시간 (초)<input id="rsHold" type="number" min="1" max="30" step="0.5"></label>
        <label class="field">빠르게 돌리기 — 후원 1번에 이 횟수 이상이면<input id="rsFast" type="number" min="0" max="50"></label>
        <div class="hint" style="align-self:end">빠르게 돌리기: 한 번에 여러 회면 짧게 연달아 돌리고 마지막에 <b>결과 요약</b>을 보여 줘요. 0 = 끔.</div>
      </div>
      <div class="hint" style="margin-top:8px">항목의 가중치는 비율이에요 (합이 100일 필요 없어요). 0이면 룰렛에서 빠져요. 등급 <b>자동</b>: 확률 5% 이하 = 전설, 15% 이하 = 희귀. 희귀는 금빛, 전설은 화면 번쩍 + 꽃가루로 축하하고, 안내판에도 등급이 표시돼요.</div>
    </section>
    <div class="row" id="rsBar" style="position:sticky;bottom:0;margin:0;padding:10px 0;background:var(--bg);z-index:2">
      <button class="btn accent" id="rsSave">저장</button>
      <button class="btn ghost" id="rsReset">되돌리기</button>
      <span class="hint" id="rsDirty"></span>
    </div>`;

  const $ = (id) => el.querySelector('#' + id);
  const fmtTime = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  let draft = null;   // settings being edited
  let saved = null;   // last settings from the server
  let dirty = false;

  $('rlUrl').textContent = x.overlayUrl('/roulette');
  $('rbUrl').textContent = x.overlayUrl('/roulette-board');
  el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => x.copy(x.overlayUrl(b.dataset.copy))));
  $('rlSkip').onclick = () => { if (confirm('대기 중인 회전을 모두 건너뛸까요?')) x.post('/api/roulette/skip').then(x.refresh); };
  $('rlClear').onclick = () => { if (confirm('룰렛 기록을 지울까요?')) x.post('/api/roulette/clear-log').then(x.refresh); };
  $('rbNow').onclick = async () => { const r = await x.post('/api/roulette/board-show'); if (r.ok) x.toast(r.boards ? '안내판을 보여 줬어요' : '연결된 안내판이 없어요 — OBS에 안내판 브라우저 소스를 넣어 주세요', !r.boards); };
  $('rlLog').onchange = (ev) => {
    const c = ev.target.closest('input[data-id]');
    if (c) x.post('/api/roulette/done', { id: c.dataset.id, done: c.checked });
  };

  // ---------- settings editor ----------
  const fields = () => ({
    enabled: $('rsOn').checked, maxSpins: Number($('rsMax').value),
    kinds: { CHAT: $('rsKChat').checked, VIDEO: $('rsKVideo').checked, MISSION: $('rsKMission').checked },
    spinSec: Number($('rsSpin').value), holdSec: Number($('rsHold').value), fastFrom: Number($('rsFast').value),
    board: { mode: $('rbMode').value, everyMin: Number($('rbEvery').value), showSec: Number($('rbShow').value), onCommand: $('rbCmd').checked, hideWhileSpinning: $('rbBusy').checked },
    chat: { enabled: $('rcOn').checked, command: $('rcCmd').value, cooldownSec: Number($('rcCool').value) },
  });
  function fill(s) {
    draft = JSON.parse(JSON.stringify(s));
    $('rsOn').checked = s.enabled; $('rsMax').value = s.maxSpins;
    $('rsKChat').checked = !!s.kinds.CHAT; $('rsKVideo').checked = !!s.kinds.VIDEO; $('rsKMission').checked = !!s.kinds.MISSION;
    $('rsSpin').value = s.spinSec; $('rsHold').value = s.holdSec; $('rsFast').value = s.fastFrom ?? 3;
    $('rbMode').value = s.board.mode; $('rbEvery').value = s.board.everyMin; $('rbShow').value = s.board.showSec;
    $('rbCmd').checked = s.board.onCommand; $('rbBusy').checked = s.board.hideWhileSpinning;
    $('rcOn').checked = s.chat.enabled; $('rcCmd').value = s.chat.command; $('rcCool').value = s.chat.cooldownSec;
    draft.wheels ||= [];
    renderRoulettes();
    renderWheels();
    setDirty(false);
  }
  function setDirty(d) {
    dirty = d;
    $('rsDirty').textContent = d ? '저장하지 않은 변경이 있어요' : '';
    $('rbEvery').disabled = $('rbMode').value !== 'every'; // 몇 초 동안 also counts for the command and 지금 보여 주기
  }
  const TIER_NAMES = { auto: '자동', normal: '일반', rare: '✦ 희귀', legend: '★ 전설' };
  const autoTier = (it, items) => {
    const total = items.reduce((a, x) => a + (Number(x.weight) > 0 ? Number(x.weight) : 0), 0) || 1;
    const p = (Number(it.weight) > 0 ? Number(it.weight) : 0) / total;
    return p <= 0.05 ? 'legend' : p <= 0.15 ? 'rare' : 'normal';
  };
  const pctOf = (it, total) => (total > 0 && it.weight > 0 ? ((it.weight / total) * 100).toFixed(it.weight / total < 0.1 ? 1 : 0) : '0');
  const totalOf = (items) => items.reduce((a, it) => a + (Number(it.weight) > 0 ? Number(it.weight) : 0), 0);
  const TABLE_HEAD = '<thead><tr><th style="width:36px"></th><th>이름</th><th style="width:100px">가중치</th><th style="width:64px">확률</th><th style="width:130px">등급</th><th style="width:52px">색</th><th style="width:90px"></th></tr></thead>';
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
  function renderRoulettes() {
    $('rsList').innerHTML = draft.roulettes.map((r, ri) => `<div class="card" style="margin:0;padding:12px;${r.enabled ? '' : 'opacity:.6'}" data-r="${ri}">
      <div class="row" style="margin:0 0 8px;flex-wrap:wrap">
        <label class="check" title="끄면 이 가격의 후원은 일반 후원이 돼요"><input type="checkbox" data-rk="enabled" ${r.enabled ? 'checked' : ''}> 켜기</label>
        <input class="in" data-rk="title" value="${esc(r.title)}" maxlength="30" style="flex:1;min-width:140px;font-weight:700" placeholder="예: 치즈 룰렛">
        <label class="check">가격 <input class="in mono" data-rk="price" type="number" min="100" step="1" value="${esc(r.price)}" style="width:110px"> 치즈</label>
        <button class="btn sm" data-ra="test1">테스트 1회</button>
        <button class="btn sm" data-ra="test3">3회</button>
        <button class="btn ghost sm" data-ra="del" title="이 후원 룰렛 삭제">삭제</button>
      </div>
      <div class="hint" style="margin:0 0 6px" data-rex>${example(r)}</div>
      <table>${TABLE_HEAD}<tbody data-list="r${ri}">${itemRows(r.items)}</tbody></table>
      <div class="row" style="margin-top:6px"><button class="btn sm" data-ra="add">＋ 항목</button><button class="btn ghost sm" data-ra="even">확률 똑같이</button></div>
    </div>`).join('');
    overlapHint();
  }
  const example = (r) => {
    const p = Number(r.price) || 0, m = Number($('rsMax').value) || 1;
    return p ? `${p.toLocaleString()} 치즈 = 1회 · ${(p * 2).toLocaleString()} 치즈 = 2회 … ${(p * m).toLocaleString()} 치즈 = ${m}회 (최대). ${(p + 500).toLocaleString()} 치즈 같은 금액은 일반 후원.` : '';
  };
  // the same rules as the server's overlaps(): a bigger price that is a multiple of a smaller one
  function overlapHint() {
    const on = draft.roulettes.filter((r) => r.enabled && Number(r.price) > 0);
    const m = Number($('rsMax').value) || 1;
    const out = [];
    for (const a of on) for (const b of on) {
      const pa = Number(a.price), pb = Number(b.price);
      if (pa === pb && a !== b && draft.roulettes.indexOf(a) < draft.roulettes.indexOf(b)) out.push(`"${a.title}"·"${b.title}" 가격이 같아요 — 저장할 수 없어요`);
      if (pb > pa && pb % pa === 0 && pb / pa <= m) out.push(`${pb.toLocaleString()} 치즈는 "${a.title}" ${pb / pa}회가 아니라 "${b.title}" 1회로 돌아가요`);
    }
    $('rsOverlaps').innerHTML = out.map((t) => `⚠ ${esc(t)}`).join('<br>');
  }
  function renderWheels() {
    $('wlList').innerHTML = draft.wheels.map((w, wi) => `<div class="card" style="margin:0;padding:12px" data-w="${wi}">
      <div class="row" style="margin:0 0 8px">
        <input class="in" data-wk="title" value="${esc(w.title)}" maxlength="30" style="flex:1;font-weight:700" placeholder="예: 다음 게임 정하기">
        <button class="btn accent sm" data-wa="spin1">돌리기</button>
        <button class="btn sm" data-wa="spin3">3회</button>
        <button class="btn ghost sm" data-wa="del" title="이 무료 룰렛 삭제">삭제</button>
      </div>
      <table>${TABLE_HEAD}<tbody data-list="w${wi}">${itemRows(w.items)}</tbody></table>
      <div class="row" style="margin-top:6px"><button class="btn sm" data-wa="add">＋ 항목</button><button class="btn ghost sm" data-wa="even">확률 똑같이</button></div>
    </div>`).join('') || '<div class="muted">아직 없어요. ＋ 무료 룰렛 추가로 만들어 보세요.</div>';
  }
  const listOf = (key) => (key[0] === 'r' ? draft.roulettes : draft.wheels)[Number(key.slice(1))].items;
  const rerender = (key) => (key[0] === 'r' ? renderRoulettes() : renderWheels());
  const PALETTE = ['#ff6b6b', '#ffd34d', '#5be37d', '#4fc3f7', '#b388ff', '#ff9f43', '#f06292', '#2fd8c8', '#9ccc65', '#ffb74d'];
  const newId = () => Math.random().toString(36).slice(2, 10);
  const newItem = (n) => ({ id: newId(), name: `항목 ${n + 1}`, weight: 10, color: PALETTE[n % PALETTE.length], tier: 'auto' });
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
  // one set of handlers for every roulette's and every wheel's table
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
    const rk = ev.target.dataset.rk;
    if (rk) {
      const box = ev.target.closest('[data-r]');
      const r = draft.roulettes[Number(box.dataset.r)];
      r[rk] = rk === 'enabled' ? ev.target.checked : rk === 'price' ? Number(ev.target.value) : ev.target.value;
      if (rk === 'enabled') box.style.opacity = r.enabled ? '' : '.6';
      box.querySelector('[data-rex]').textContent = example(r);
      overlapHint(); setDirty(true);
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
    const rb = ev.target.closest('button[data-ra]');
    if (rb) {
      const ri = Number(rb.closest('[data-r]').dataset.r);
      const r = draft.roulettes[ri];
      if (rb.dataset.ra === 'del') {
        if (draft.roulettes.length <= 1) return x.toast('후원 룰렛이 하나는 있어야 해요 — 안 쓰려면 "켜기"를 끄세요', true);
        if (!confirm(`"${r.title}" 후원 룰렛을 삭제할까요?`)) return;
        draft.roulettes.splice(ri, 1); renderRoulettes(); setDirty(true);
      }
      if (rb.dataset.ra === 'add') { if (r.items.length >= 24) return; r.items.push(newItem(r.items.length)); renderRoulettes(); setDirty(true); }
      if (rb.dataset.ra === 'even') { for (const it of r.items) it.weight = 1; renderRoulettes(); setDirty(true); }
      if (rb.dataset.ra === 'test1' || rb.dataset.ra === 'test3') {
        if (dirty && !(await save(true))) return;
        await x.post('/api/roulette/test', { spins: rb.dataset.ra === 'test3' ? 3 : 1, rid: saved.roulettes[ri]?.id });
        x.refresh();
      }
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
  $('rsAddR').onclick = () => {
    if (draft.roulettes.length >= 8) return x.toast('후원 룰렛은 8개까지예요', true);
    // a price that is no other roulette's multiple (and has none), so every amount means one roulette
    const m = Number($('rsMax').value) || 1;
    const clash = (p) => draft.roulettes.some((r) => { const q = Number(r.price) || 0; const [a, b] = p > q ? [q, p] : [p, q]; return a > 0 && b % a === 0 && b / a <= m; });
    let price = 3333; while (clash(price)) price += 1000;
    draft.roulettes.push({ id: newId(), title: `룰렛 ${draft.roulettes.length + 1}`, price, enabled: true, items: [0, 1, 2].map((n) => newItem(n)) });
    renderRoulettes(); setDirty(true);
  };
  $('wlAdd').onclick = () => {
    if (draft.wheels.length >= 8) return x.toast('무료 룰렛은 8개까지예요', true);
    draft.wheels.push({ id: newId(), title: `무료 룰렛 ${draft.wheels.length + 1}`, items: [0, 1, 2].map((n) => ({ ...newItem(n), name: `선택지 ${n + 1}`, weight: 1 })) });
    renderWheels(); setDirty(true);
  };
  for (const id of ['rsOn', 'rsMax', 'rsKChat', 'rsKVideo', 'rsKMission', 'rsSpin', 'rsHold', 'rsFast', 'rbMode', 'rbEvery', 'rbShow', 'rbCmd', 'rbBusy', 'rcOn', 'rcCmd', 'rcCool']) $(id).addEventListener('input', () => setDirty(true));
  $('rsMax').addEventListener('input', () => { el.querySelectorAll('[data-r]').forEach((box) => (box.querySelector('[data-rex]').textContent = example(draft.roulettes[Number(box.dataset.r)]))); overlapHint(); });
  $('rsReset').onclick = () => saved && fill(saved);
  async function save(quiet) {
    const r = await x.post('/api/roulette/settings', { settings: { ...fields(), roulettes: draft.roulettes, wheels: draft.wheels } });
    if (r.ok) { saved = r.settings; fill(saved); if (!quiet) x.toast('룰렛 설정을 저장했어요'); x.refresh(); }
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
    $('rbState').className = 'pill ' + (r.boards ? 'ok' : 'warn');
    $('rbState').textContent = r.boards ? `연결됨 ${r.boards}개` : 'OBS에 없음';
    $('rcState').className = 'pill ' + (!r.settings.chat.enabled ? '' : r.canChat ? 'ok' : 'warn');
    $('rcState').textContent = !r.settings.chat.enabled ? '꺼짐' : r.canChat ? '켜짐' : '채팅 못 보냄';
    $('rcHint').innerHTML = r.settings.chat.enabled && !r.canChat
      ? 'Allmind가 채팅을 보내려면 설정 창 <b>연동 → 치지직 연동</b>이 필요해요 (권한 <b>채팅 메시지 쓰기</b>). 그전까지는 명령어가 나오면 안내판만 보여 줘요.'
      : '아무나 칠 수 있어요. 도배를 막으려고 한 번 답하면 위 시간 동안은 다시 답하지 않아요.';
    $('rcPreview').textContent = r.chatLines.join('\n');
    if (!dirty) $('rsOverlaps').innerHTML = r.overlaps.map((t) => `⚠ ${esc(t)}`).join('<br>');
    $('rlQueue').innerHTML = r.pending ? `<b style="color:var(--accent-2)">${r.pending}회</b> 화면에 나오길 기다리는 중${st.overlays.roulette ? '' : ' — OBS 오버레이가 연결되면 돌아가요'}` : '대기 중인 회전 없음';
    const html = r.log.map((row) => `<tr class="${row.test ? 'dim' : ''}">
      <td class="mono">${fmtTime(row.time)}</td>
      <td>${row.wheel ? `🎲 ${esc(row.wheelTitle || row.nick)}` : esc(row.nick)}${row.of > 1 ? ` <span class="muted small">${row.idx}/${row.of}</span>` : ''}${row.test ? ' <span class="pill">테스트</span>' : ''}${row.shown ? '' : ' <span class="pill warn">대기</span>'}</td>
      <td class="mono">${row.wheel ? '무료' : row.idx === 1 ? Number(row.amount || 0).toLocaleString() : ''}</td>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${esc(row.color)};margin-right:6px"></span>${row.tier === 'legend' ? '★ ' : row.tier === 'rare' ? '✦ ' : ''}${esc(row.result)}${row.rtitle && !row.wheel ? ` <span class="muted small">${esc(row.rtitle)}</span>` : ''}</td>
      <td><input type="checkbox" data-id="${esc(row.id)}" ${row.done ? 'checked' : ''}></td></tr>`).join('') || '<tr><td colspan="5" class="muted">아직 기록이 없어요</td></tr>';
    if (html !== logHtml && !el.contains(document.activeElement?.closest?.('#rlLog') || null)) { $('rlLog').innerHTML = html; logHtml = html; }
    $('rlLogCount').textContent = r.log.length ? `${r.log.length}개` : '';
  });
  return () => off();
}
