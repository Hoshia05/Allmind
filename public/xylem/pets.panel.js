// 화면 펫 (Screen Pets) panel on the Xylem page.
export function mount(el, x) {
  const { esc } = x;
  const url = x.overlayUrl('/pets');
  const demoUrl = x.overlayUrl('/pets?demo=1');

  el.innerHTML = `
    <h1>🐾 화면 펫 <span class="pill" id="pState"></span></h1>

    <div class="grid2">
      <section class="card">
        <h2>OBS 오버레이</h2>
        <div class="row">
          <input class="in mono" id="pUrl" value="${esc(url)}" readonly style="flex:1;min-width:200px">
          <button class="btn sm" id="pCopy">복사</button>
          <a class="btn ghost sm" href="${esc(demoUrl)}" target="_blank">미리보기</a>
        </div>
        <div class="hint" style="margin-top:6px">OBS 브라우저 소스에 <b>1920 × 1080</b>으로 추가해 주세요. 시청자가 채팅을 치면 화면 아래에 펫이 소환돼요.</div>
        <div class="row" style="margin-top:12px">
          <label class="check"><input type="checkbox" id="pOn"> 화면 펫 켜기</label>
          <button class="btn ghost sm" id="pClear" style="margin-left:auto">모두 내보내기</button>
        </div>
      </section>

      <section class="card">
        <h2>테스트 소환 · 모두 함께</h2>
        <div class="row">
          <input class="in" id="pTestNick" value="테스트" placeholder="닉네임" style="width:120px">
          <input class="in" id="pTestText" value="안녕!" placeholder="채팅 내용" style="flex:1">
          <button class="btn accent sm" id="pTestSend">🧪 소환</button>
        </div>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
          <button class="btn ghost sm" data-grp="jump">모두 점프</button>
          <button class="btn ghost sm" data-grp="dance">모두 춤추기</button>
          <button class="btn ghost sm" data-grp="gather">가운데 모이기</button>
          <button class="btn ghost sm" data-grp="scatter">흩어지기</button>
        </div>
        <div class="hint" style="margin-top:8px">연결된 OBS 오버레이에 가짜 채팅을 보내거나 화면의 모든 펫을 한꺼번에 움직일 수 있어요.</div>
      </section>
    </div>

    <section class="card">
      <h2>동작 설정</h2>
      <div class="grid2">
        <label class="field">최대 펫 수 (1~60)<input class="in" id="pMax" type="number" min="1" max="60"></label>
        <label class="field">조용하면 자동 퇴장 (분)<input class="in" id="pIdle" type="number" min="1" max="60"></label>
        <label class="field">크기 <span class="muted small" id="pScaleV"></span><input id="pScale" type="range" min="0.4" max="2.5" step="0.05"></label>
        <label class="field">이동 속도 <span class="muted small" id="pSpeedV"></span><input id="pSpeed" type="range" min="0.4" max="2.5" step="0.05"></label>
        <label class="field">바닥 여백 (px)<input class="in" id="pFloor" type="number" min="0" max="300"></label>
        <label class="field">말풍선 유지 시간 (초)<input class="in" id="pBubbleSec" type="number" min="2" max="15"></label>
        <div class="field">표시·명령어
          <label class="check"><input type="checkbox" id="pNames"> 닉네임 표시</label>
          <label class="check"><input type="checkbox" id="pBubbles"> 채팅 말풍선 표시</label>
          <label class="check"><input type="checkbox" id="pCmds"> 채팅 명령어 켜기 <span class="muted small">(!점프 · !대시 · !춤 · !자장 · !안아 · !툭 · !캐릭터)</span></label>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn accent" id="pSave">저장</button>
        <span class="hint" id="pDirty"></span>
      </div>
    </section>

    <section class="card">
      <h2>캐릭터 이미지 <span class="muted small" id="pSpriteCount"></span></h2>
      <div id="pSprites" style="display:flex;flex-wrap:wrap;gap:10px"></div>
      <div class="row" style="margin-top:12px">
        <label class="btn sm" style="cursor:pointer">＋ 캐릭터 추가<input type="file" id="pFile" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></label>
        <span class="hint">PNG·JPG·GIF·WebP, 가로·세로 32~2048 픽셀, 5 MB 이하. 배경이 투명한 SD 캐릭터 이미지가 좋아요. 체크된 캐릭터들 중에서 랜덤으로 배정돼요.</span>
      </div>
    </section>`;

  const $ = (id) => el.querySelector('#' + id);
  let saved = null;
  let dirty = false;
  let disabledSet = new Set();

  const setDirty = (d) => {
    dirty = d;
    $('pDirty').textContent = d ? '저장하지 않은 변경이 있어요' : '';
  };

  $('pCopy').onclick = () => x.copy(url);

  function readForm() {
    return {
      enabled: $('pOn').checked,
      commandsEnabled: $('pCmds').checked,
      maxPets: Number($('pMax').value) || 20,
      idleMinutes: Number($('pIdle').value) || 5,
      scale: Number($('pScale').value) || 1,
      speed: Number($('pSpeed').value) || 1,
      floorY: Number($('pFloor').value) || 0,
      bubbleSec: Number($('pBubbleSec').value) || 5,
      showNames: $('pNames').checked,
      showBubbles: $('pBubbles').checked,
      disabledSprites: [...disabledSet],
    };
  }

  function fillForm(s) {
    saved = s;
    disabledSet = new Set(s.disabledSprites || []);
    $('pOn').checked = !!s.enabled;
    $('pCmds').checked = s.commandsEnabled !== false;
    $('pMax').value = s.maxPets;
    $('pIdle').value = s.idleMinutes;
    $('pScale').value = s.scale;
    $('pScaleV').textContent = `${Math.round(s.scale * 100)}%`;
    $('pSpeed').value = s.speed;
    $('pSpeedV').textContent = `${Math.round(s.speed * 100)}%`;
    $('pFloor').value = s.floorY;
    $('pBubbleSec').value = s.bubbleSec;
    $('pNames').checked = !!s.showNames;
    $('pBubbles').checked = !!s.showBubbles;
    setDirty(false);
  }

  for (const id of ['pMax', 'pIdle', 'pScale', 'pSpeed', 'pFloor', 'pBubbleSec', 'pNames', 'pBubbles', 'pCmds']) {
    $(id).addEventListener('input', () => {
      $('pScaleV').textContent = `${Math.round(Number($('pScale').value) * 100)}%`;
      $('pSpeedV').textContent = `${Math.round(Number($('pSpeed').value) * 100)}%`;
      setDirty(true);
    });
  }

  $('pOn').onchange = async () => {
    const r = await x.post('/api/pets/settings', { settings: readForm() });
    if (r.ok) { fillForm(r.settings); x.toast(r.settings.enabled ? '화면 펫을 켰어요' : '화면 펫을 껐어요'); }
  };

  $('pSave').onclick = async () => {
    const r = await x.post('/api/pets/settings', { settings: readForm() });
    if (r.ok) { fillForm(r.settings); x.toast('저장했어요'); x.refresh(); }
  };

  $('pClear').onclick = async () => {
    const r = await x.post('/api/pets/clear');
    if (r.ok) x.toast('화면의 펫을 모두 내보냈어요');
  };

  $('pTestSend').onclick = async () => {
    const r = await x.post('/api/pets/test-chat', {
      nick: $('pTestNick').value.trim() || '테스트',
      text: $('pTestText').value.trim() || '안녕!',
    });
    if (r.ok) x.toast('테스트 채팅을 보냈어요');
  };

  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-grp]');
    if (!b) return;
    await x.post('/api/pets/group', { action: b.dataset.grp });
  });

  function renderSprites(list) {
    $('pSpriteCount').textContent = `${list.length}개`;
    $('pSprites').innerHTML = list.map((it) => {
      const checked = !disabledSet.has(it.file);
      return `<div class="card" style="padding:8px 10px;margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:110px">
        <img src="${esc(it.url)}" alt="" style="width:64px;height:64px;object-fit:contain">
        <label class="check small" title="사용 여부"><input type="checkbox" data-toggle="${esc(it.file)}" ${checked ? 'checked' : ''}> ${esc(it.file.replace(/\.[^.]+$/, ''))}</label>
        ${it.builtin ? '<span class="muted small">기본</span>' : `<button class="btn ghost sm" data-del="${esc(it.file)}">삭제</button>`}
      </div>`;
    }).join('');
  }

  $('pSprites').addEventListener('change', async (ev) => {
    const cb = ev.target.closest('input[data-toggle]');
    if (!cb) return;
    const f = cb.dataset.toggle;
    if (cb.checked) disabledSet.delete(f);
    else disabledSet.add(f);
    const r = await x.post('/api/pets/settings', { settings: readForm() });
    if (r.ok) { fillForm(r.settings); x.refresh(); }
  });

  $('pSprites').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-del]');
    if (!btn) return;
    const f = btn.dataset.del;
    if (!confirm(`"${f}" 캐릭터를 지울까요?`)) return;
    const r = await x.post('/api/pets/sprites-remove', { file: f });
    if (r.ok) { x.toast('지웠어요'); x.refresh(); }
  });

  $('pFile').onchange = async (ev) => {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    for (const file of files) {
      const b64 = await new Promise((res) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result || '').split(',')[1] || '');
        rd.readAsDataURL(file);
      });
      const r = await x.post('/api/pets/sprites', { name: file.name, data: b64 });
      if (r.ok) x.toast(`${r.file} 추가했어요`);
    }
    x.refresh();
  };

  return x.onState((s) => {
    const p = s.pets;
    if (!p) return;
    const ov = s.overlays?.pets || 0;
    const pill = $('pState');
    pill.textContent = ov ? `오버레이 ${ov}개 연결됨` : '연결된 오버레이 없음';
    pill.className = 'pill ' + (ov ? 'ok' : '');
    if (!saved || !dirty) fillForm(p.settings);
    renderSprites(p.sprites || []);
  });
}
