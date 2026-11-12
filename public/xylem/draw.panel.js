// 시청자 추첨 panel on the Xylem page (docs/plans/draw.md): open / close the entry (with a countdown), watch the entrants,
// draw, 다시 뽑기 for a winner who doesn't answer, read the winners' chat, and set everything (filters, voice, style).
// Allmind picks the winners (a fair server-side draw); the /draw overlay in OBS only stages the result.
export function mount(el, x) {
  const { esc } = x;
  el.innerHTML = `
    <h1>🎟 시청자 추첨 <span class="pill" id="dwState"></span></h1>
    <div class="grid2">
      <section class="card">
        <h2>진행 <span class="muted small" id="dwPhase"></span></h2>
        <div id="dwCtl"></div>
        <div class="hint" id="dwWarn" style="margin-top:8px"></div>
      </section>
      <section class="card">
        <h2>OBS 오버레이</h2>
        <div class="hint" style="margin:0 0 4px"><b>추첨 화면</b> — 1920×1080, 배경 투명</div>
        <div class="copy"><code id="dwUrl"></code><button class="btn sm" data-copy="/draw">복사</button></div>
        <div class="hint" style="margin-top:6px">OBS → 소스 추가 → <b>브라우저</b> → 주소 붙여 넣기 → 크기 1920×1080. 당첨자 목소리를 방송에 넣으려면 <b>"OBS를 통해 오디오 제어"</b>를 켜세요 (이 소스만 따로 볼륨·트랙을 정할 수 있어요).</div>
        <div class="row" style="margin-top:8px">
          <a class="btn ghost sm" id="dwDemoS" target="_blank" rel="noopener">미리보기 · 공중전</a>
          <a class="btn ghost sm" id="dwDemoR" target="_blank" rel="noopener">미리보기 · 룰렛</a>
        </div>
        <div class="hint">미리보기는 채팅 없이 가짜 닉네임으로 보여요 (주소 뒤에 <code>&amp;n=40&amp;w=2&amp;seed=7</code>로 인원·당첨 수·모양을 바꿔요).</div>
      </section>
    </div>

    <section class="card" id="dwWinBox" hidden>
      <h2>🏆 당첨자 <span class="muted small" id="dwChatLeft"></span></h2>
      <div id="dwWinners" style="display:grid;gap:8px"></div>
      <h3 style="margin:14px 0 6px;font-size:14px">📻 당첨자 채팅 <span class="muted small">(오버레이에 교신으로 나오고, 음성으로 읽어요)</span></h3>
      <div id="dwFeed" style="display:grid;gap:4px;max-height:220px;overflow:auto"></div>
      <div class="row" style="margin-top:8px"><input class="in" id="dwTestText" placeholder="테스트: 첫 번째 당첨자가 친 것처럼" style="flex:1;min-width:160px"><button class="btn ghost sm" id="dwTestChat">보내 보기</button></div>
    </section>

    <section class="card">
      <h2>참가자 <span class="muted small" id="dwEntCount"></span></h2>
      <div id="dwEnts" style="display:flex;flex-wrap:wrap;gap:6px;max-height:240px;overflow:auto"></div>
      <div class="hint" id="dwRej" style="margin-top:6px"></div>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" data-fill="10">테스트 참가자 +10</button><button class="btn ghost sm" data-fill="50">+50</button><button class="btn ghost sm" data-fill="150">+150</button><span class="hint">참여를 연 뒤에 쓸 수 있어요. 연출·화면을 미리 볼 때 써 보세요.</span></div>
    </section>

    <section class="card">
      <h2>설정 <span class="muted small" id="dwSaved"></span></h2>
      <div class="grid2">
        <div>
          <label class="field">추첨 모양<select class="in" id="dStyle"><option value="sortie">✈ 공중전 출격 (진 사람은 격추돼요, 30~45초)</option><option value="roulette">🎰 룰렛 (이름이 돌다가 멈춰요)</option></select></label>
          <label class="field" style="margin-top:8px">참가 방식<select class="in" id="dMode"><option value="keyword">채팅 명령어를 친 사람</option><option value="recent">최근 N분 안에 채팅한 사람 (참여를 안 열어도 돼요)</option></select></label>
          <div class="grid2" style="margin-top:8px">
            <label class="field">명령어<input class="in" id="dKeyword" maxlength="20"></label>
            <label class="field">최근 몇 분<input class="in" id="dRecent" type="number" min="1" max="120"></label>
          </div>
          <div class="grid2" style="margin-top:8px">
            <label class="field">참여 받는 시간 (초, 0=제한 없음)<input class="in" id="dEntry" type="number" min="0" max="3600"></label>
            <label class="field">당첨자 수<input class="in" id="dWinners" type="number" min="1" max="10"></label>
          </div>
          <label class="field" style="margin-top:8px">당첨자 채팅 읽는 시간 (초, 0=끝내기를 누를 때까지)<input class="in" id="dChatSec" type="number" min="0" max="1800"></label>
        </div>
        <div>
          <div class="field">거르기 <span class="muted small">(모두 같은 확률이에요 — 후원·구독은 확률에 영향이 없어요)</span></div>
          <div class="row"><label class="check"><input type="checkbox" id="dSubs"> 구독자만</label></div>
          <label class="field" style="margin-top:6px">지난 당첨자<select class="in" id="dSkip"><option value="none">다시 뽑힐 수 있어요</option><option value="stream">이번 방송에서 당첨된 사람은 제외</option><option value="always">한 번이라도 당첨됐으면 제외</option></select></label>
          <div class="hint">방송인·매니저, 유튜브 채팅(시청자 정보가 없어요)은 언제나 빠져요.</div>
          <div class="row" style="margin-top:12px"><label class="check"><input type="checkbox" id="dNotice"> 채팅에도 알리기 ("추첨 참여: 채팅에 …", 당첨자)</label></div>
          <div class="hint" id="dNoticeHint"></div>
        </div>
      </div>
      <h3 style="margin:16px 0 6px;font-size:14px">🔊 음성 (TTS)</h3>
      <div class="grid2">
        <div>
          <div class="row" style="margin-top:0"><label class="check"><input type="checkbox" id="dTts"> 당첨자 채팅을 소리 내서 읽기</label></div>
          <div class="row"><label class="check"><input type="checkbox" id="dAnn"> 먼저 "○○님 당첨!"이라고 알리기</label></div>
          <div class="grid2" style="margin-top:6px">
            <label class="field">볼륨 <span class="muted small" id="dVolTxt"></span><input class="in" id="dVol" type="range" min="0" max="100"></label>
            <label class="field">한 줄 최대 글자<input class="in" id="dMax" type="number" min="10" max="200"></label>
          </div>
          <label class="field" style="margin-top:6px" id="dVoiceBox">목소리<select class="in" id="dVoice"><option value="">자동 (한국어 · Heami)</option></select></label>
        </div>
        <div>
          <label class="field">테스트 문장<input class="in" id="dTtsText" placeholder="비워 두면 기본 인사말" maxlength="120"></label>
          <div class="row"><button class="btn" id="dTtsTest">🔊 목소리 테스트</button><span class="muted small" id="dTtsInfo"></span></div>
          <div class="hint" id="dTtsHint"></div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>지난 당첨자 <span class="muted small" id="dwPastCount"></span></h2>
      <div id="dwPast" class="small" style="display:flex;flex-wrap:wrap;gap:6px"></div>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="dwClearPast">목록 지우기</button><span class="hint">지우면 "지난 당첨자 제외"에서도 다시 뽑힐 수 있어요.</span></div>
    </section>`;

  const $ = (id) => el.querySelector('#' + id);
  const fmtLeft = (sec) => { sec = Math.max(0, Math.ceil(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const durText = (s) => (s ? (s >= 60 && s % 60 === 0 ? `${s / 60}분` : `${s}초`) : '제한 없음');
  let D = null;        // latest status
  let skew = 0;        // server clock − this clock
  let saved = null;    // settings as last seen on the server
  let pending = null;  // a save in flight
  let dirty = false;   // an edit that isn't on the server yet (a state update must not overwrite it)
  let ctlHtml = '', entHtml = '', winHtml = '', feedHtml = '', pastHtml = '';

  $('dwUrl').textContent = x.overlayUrl('/draw');
  el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => x.copy(x.overlayUrl(b.dataset.copy))));
  $('dwDemoS').href = '/draw?demo=1&n=40&w=2&seed=7';
  $('dwDemoR').href = '/draw?demo=1&style=roulette&n=40&w=3&seed=3';

  // ---------- settings ----------
  const fields = () => ({
    style: $('dStyle').value, mode: $('dMode').value, keyword: $('dKeyword').value.trim(), recentMin: Number($('dRecent').value) || 10,
    entrySec: Math.max(0, Number($('dEntry').value) || 0), winners: Number($('dWinners').value) || 1, chatSec: Math.max(0, Number($('dChatSec').value) || 0),
    subsOnly: $('dSubs').checked, skipPast: $('dSkip').value, notice: $('dNotice').checked,
    tts: { on: $('dTts').checked, announce: $('dAnn').checked, volume: Number($('dVol').value), maxLen: Number($('dMax').value) || 60, voice: $('dVoice').value },
  });
  function fill(s) {
    $('dStyle').value = s.style; $('dMode').value = s.mode; $('dKeyword').value = s.keyword; $('dRecent').value = s.recentMin;
    $('dEntry').value = s.entrySec; $('dWinners').value = s.winners; $('dChatSec').value = s.chatSec;
    $('dSubs').checked = s.subsOnly; $('dSkip').value = s.skipPast; $('dNotice').checked = s.notice;
    $('dTts').checked = s.tts.on; $('dAnn').checked = s.tts.announce; $('dVol').value = s.tts.volume; $('dMax').value = s.tts.maxLen;
    if ([...$('dVoice').options].some((o) => o.value === s.tts.voice)) $('dVoice').value = s.tts.voice;
    $('dVolTxt').textContent = `${s.tts.volume}%`;
  }
  let saveT = null;
  function changed() {
    $('dVolTxt').textContent = `${$('dVol').value}%`;
    $('dwSaved').textContent = '저장 중…';
    dirty = true;
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      pending = x.post('/api/draw/settings', { settings: fields() });
      const r = await pending; pending = null; dirty = false;
      if (r.ok) { saved = r.settings; $('dwSaved').textContent = '✓ 저장됨'; x.refresh(); } else $('dwSaved').textContent = '저장 안 됨';
    }, 450);
  }
  for (const id of ['dStyle', 'dMode', 'dKeyword', 'dRecent', 'dEntry', 'dWinners', 'dChatSec', 'dSubs', 'dSkip', 'dNotice', 'dTts', 'dAnn', 'dVol', 'dMax', 'dVoice']) $(id).addEventListener('input', changed);

  // the Windows voices (only there; elsewhere there is nothing to pick)
  fetch('/api/draw/voices', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (!j.ok) return;
    $('dVoiceBox').hidden = !j.real;
    const cur = saved?.tts.voice || '';
    $('dVoice').innerHTML = `<option value="">자동 (한국어 · Heami)</option>` + j.voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.culture)})</option>`).join('');
    $('dVoice').value = cur;
    if (j.real && !j.voices.some((v) => /^ko/i.test(v.culture))) $('dTtsHint').innerHTML = '⚠ 이 PC에는 <b>한국어 음성</b>이 없어요 — Windows 설정 → 시간 및 언어 → 음성(또는 언어 및 지역)에서 한국어를 추가해야 해요.';
  }).catch(() => {});

  $('dTtsTest').onclick = async () => {
    $('dTtsTest').disabled = true; $('dTtsInfo').textContent = '만드는 중…';
    if (pending) await pending;
    const r = await x.post('/api/draw/tts-test', { text: $('dTtsText').value });
    $('dTtsTest').disabled = false;
    if (!r.ok) { $('dTtsInfo').textContent = ''; return; }
    const t = r.tts;
    if (t.overlay) $('dTtsInfo').textContent = 'OBS 오버레이로 보냈어요 — 방송 소리로 나와요';
    else {
      $('dTtsInfo').textContent = t.real ? '오버레이가 없어서 이 화면에서 들려줘요' : 'Windows가 아니라 소리 없는 파일이에요 (만들어지는지만 확인)';
      const a = new Audio(t.url); a.volume = Math.min(1, t.volume / 100); a.play().catch(() => x.toast('소리를 재생하지 못했어요', true));
    }
  };
  $('dwTestChat').onclick = async () => { const r = await x.post('/api/draw/test-chat', { text: $('dwTestText').value }); if (r.ok) $('dwTestText').value = ''; x.refresh(); };
  $('dwClearPast').onclick = async () => { if (!confirm('지난 당첨자 목록을 지울까요?')) return; await x.post('/api/draw/clear-past'); x.refresh(); };

  // ---------- actions ----------
  async function act(a, body = {}) {
    const r = await x.post(`/api/draw/${a}`, body);
    x.refresh();
    return r;
  }
  el.addEventListener('click', async (ev) => {
    const f = ev.target.closest('[data-fill]');
    if (f) { await act('test-fill', { n: Number(f.dataset.fill) }); return; }
    const rm = ev.target.closest('[data-rm]');
    if (rm) { await act('remove', { uid: rm.dataset.rm }); return; }
    const b = ev.target.closest('button[data-a]');
    if (!b) return;
    b.disabled = true;
    const a = b.dataset.a;
    if (a === 'open') await act('open', { sec: Number(b.dataset.sec) });
    else if (a === 'open-custom') { const v = Number(el.querySelector('#dwSec')?.value); if (!(v >= 5)) { x.toast('초 단위로 5초 이상 적어 주세요', true); } else await act('open', { sec: v }); }
    else if (a === 'draw') {
      if (D?.phase === 'entry') await act('close');
      await act('draw');
    }
    else if (a === 'redraw') { if (confirm(`"${b.dataset.nick}"님 대신 한 명을 다시 뽑을까요?`)) await act('redraw', { uid: b.dataset.uid }); }
    else if (a === 'reset') { if (confirm('지금 진행 중인 추첨을 취소하고 처음으로 돌아갈까요?')) await act('reset'); }
    else await act(a, b.dataset.sec ? { sec: Number(b.dataset.sec) } : {});
    b.disabled = false;
  });

  // ---------- drawing the screen from the state ----------
  const leftOf = (t) => (t ? (t - (Date.now() + skew)) / 1000 : null);
  function controls(d) {
    const s = d.settings;
    const left = leftOf(d.endsAt);
    const cnt = `참가 <b>${d.count}명</b>${d.eligible !== d.count ? ` · 뽑힐 수 있는 사람 <b>${d.eligible}명</b>` : ''}`;
    if (d.phase === 'idle') {
      if (s.mode === 'recent') return `<div>최근 <b>${s.recentMin}분</b> 안에 채팅한 사람 <b>${d.eligible}명</b>이 대상이에요.</div>
        <div class="row"><button class="btn accent" data-a="draw" ${d.eligible ? '' : 'disabled'}>🎟 뽑기 (${s.winners}명)</button></div>`;
      return `<div class="row" style="margin-top:0">참여 열기:
          ${[30, 60, 180].map((sec) => `<button class="btn" data-a="open" data-sec="${sec}">${durText(sec)}</button>`).join('')}
          <button class="btn" data-a="open" data-sec="0">제한 없음</button></div>
        <div class="row"><input class="in" id="dwSec" type="number" min="5" max="3600" placeholder="직접 (초)" style="width:120px"><button class="btn sm" data-a="open-custom">이 시간으로 열기</button>
          <button class="btn ghost sm" data-a="open" data-sec="${s.entrySec}">기본 (${durText(s.entrySec)})</button></div>
        <div class="hint">시청자는 채팅에 <b>${esc(s.keyword)}</b>를 치면 참여해요. 열면 오버레이에 카운트다운이 떠요.</div>`;
    }
    if (d.phase === 'entry') return `<div style="font-size:15px">🟢 참여 받는 중 — ${left === null ? '<b>마감을 누를 때까지</b>' : `<b class="mono" data-left="entry" style="font-size:22px">${fmtLeft(left)}</b> 남음`}</div>
      <div style="margin-top:4px">${cnt}</div>
      <div class="row"><button class="btn" data-a="close">마감</button><button class="btn ghost" data-a="extend" data-sec="30">+30초</button><button class="btn accent" data-a="draw" ${d.eligible ? '' : 'disabled'}>🎟 마감하고 뽑기 (${s.winners}명)</button><button class="btn ghost danger sm" data-a="reset">취소</button></div>`;
    if (d.phase === 'ready') return `<div style="font-size:15px">⏸ 참여 마감</div><div style="margin-top:4px">${cnt}</div>
      <div class="row"><button class="btn accent" data-a="draw" ${d.eligible ? '' : 'disabled'}>🎟 뽑기 (${s.winners}명)</button><button class="btn" data-a="open" data-sec="${s.entrySec}">다시 열기 (${durText(s.entrySec)})</button><button class="btn ghost danger sm" data-a="reset">취소</button></div>`;
    if (d.phase === 'drawing') return `<div style="font-size:15px">🎬 추첨 연출 중…</div><div class="hint">${d.overlays ? '오버레이가 끝나면 당첨자가 나와요.' : '오버레이가 없어서 바로 결과가 나와요.'}</div>
      <div class="row"><button class="btn ghost" data-a="skip">연출 건너뛰기</button><button class="btn ghost danger sm" data-a="reset">취소</button></div>`;
    const cl = leftOf(d.chatEndsAt);
    return `<div style="font-size:15px">🏆 당첨 — 당첨자의 채팅을 ${cl === null ? '<b>끝내기를 누를 때까지</b>' : `<b class="mono" data-left="chat">${fmtLeft(cl)}</b> 동안`} 읽어요</div>
      <div class="row"><button class="btn accent" data-a="end">끝내기</button></div>`;
  }
  function winnersHtml(d) {
    return d.winnerList.map((w) => `<div class="row" style="margin:0;justify-content:space-between;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:6px 10px">
      <span><b style="font-size:16px">${esc(w.nick)}</b></span>
      <button class="btn ghost sm" data-a="redraw" data-uid="${esc(w.uid)}" data-nick="${esc(w.nick)}" title="이 당첨자가 대답이 없을 때 — 남은 사람 중 한 명을 다시 뽑아요">다시 뽑기</button></div>`).join('') || '<span class="muted">—</span>';
  }

  const off = x.onState((st) => {
    const d = st.draw;
    if (!d) return;
    D = d; skew = d.now - Date.now();
    // settings changed on another device show up here, unless this one is being edited
    if (!saved || (!dirty && !pending && JSON.stringify(saved) !== JSON.stringify(d.settings) && !el.contains(document.activeElement))) { saved = d.settings; fill(saved); }
    const on = st.overlays.draw;
    const live = d.phase !== 'idle';
    $('dwState').className = 'pill ' + (on ? 'ok' : 'warn');
    $('dwState').textContent = on ? `오버레이 ${on}개 연결됨` : '오버레이 연결 안 됨';
    $('dwPhase').textContent = { idle: '대기', entry: '참여 받는 중', ready: '참여 마감', drawing: '추첨 연출', winners: '당첨자 발표' }[d.phase];
    $('dwWarn').innerHTML = !on ? '⚠ OBS에 <b>추첨 화면</b> 소스가 없어요 — 없으면 연출·음성 없이 결과만 나와요.' : '';
    $('dNoticeHint').innerHTML = d.settings.notice && !d.canChat ? '⚠ 채팅을 보내려면 설정 창 <b>연동 → 치지직 연동</b>(권한 채팅 메시지 쓰기)이 필요해요.' : '';
    if (!d.tts.real && !$('dTtsHint').innerHTML) $('dTtsHint').textContent = '지금은 Windows가 아니라서 소리 없는 파일이 만들어져요 (방송 PC에서는 한국어 음성으로 읽어요).';

    const c = controls(d);
    if (c !== ctlHtml && !el.contains(document.activeElement?.closest?.('#dwCtl') || null)) { $('dwCtl').innerHTML = c; ctlHtml = c; }
    $('dwWinBox').hidden = d.phase !== 'winners';
    const w = winnersHtml(d);
    if (w !== winHtml) { $('dwWinners').innerHTML = w; winHtml = w; }
    const feed = d.chatLines.map((l) => `<div class="small"><b style="color:var(--accent-2)">${esc(l.nick)}</b> ${esc(String(l.text).replace(/\{:[^:{}]+:\}/g, '').trim() || '…')}</div>`).join('') || '<span class="muted small">당첨자가 채팅을 치면 여기에 나와요</span>';
    if (feed !== feedHtml) { $('dwFeed').innerHTML = feed; feedHtml = feed; }

    $('dwEntCount').textContent = d.entrants.length ? `${d.count}명${d.eligible !== d.entrants.length && live ? ` (뽑힐 수 있는 사람 ${d.eligible}명)` : ''}` : '';
    const ents = d.entrants.map((e) => `<span class="t-chip" style="${e.out ? 'opacity:.45' : ''}" title="${e.out ? { subs: '구독자가 아니라서 빠져요', past: '지난 당첨자라서 빠져요', staff: '방송인·매니저라서 빠져요' }[e.out] : ''}"><span>${e.sub ? '⭐ ' : ''}${esc(e.nick)}${e.test ? ' (테스트)' : ''}</span>${d.phase === 'entry' || d.phase === 'ready' ? `<button data-rm="${esc(e.uid)}" title="참가자에서 빼기">✕</button>` : ''}</span>`).join('') || '<span class="muted small">참여를 열고 채팅에 명령어를 치면 여기에 나와요</span>';
    if (ents !== entHtml) { $('dwEnts').innerHTML = ents; entHtml = ents; }
    const rj = d.rejected;
    $('dwRej').textContent = rj.subs + rj.past + rj.staff ? `참여 못 한 사람: ${[rj.subs && `구독자 아님 ${rj.subs}명`, rj.past && `지난 당첨자 ${rj.past}명`, rj.staff && `방송인·매니저 ${rj.staff}명`].filter(Boolean).join(' · ')}` : '';

    $('dwPastCount').textContent = d.pastCount ? `${d.pastCount}명 기록` : '';
    const past = d.past.map((p) => `<span class="t-chip preset"><span>${esc(p.nick)}</span></span>`).join('') || '<span class="muted">아직 없어요</span>';
    if (past !== pastHtml) { $('dwPast').innerHTML = past; pastHtml = past; }
  });

  // countdowns tick on their own between state updates
  const tick = setInterval(() => {
    if (!D) return;
    for (const n of el.querySelectorAll('[data-left]')) {
      const l = leftOf(n.dataset.left === 'entry' ? D.endsAt : D.chatEndsAt);
      if (l !== null) n.textContent = fmtLeft(l);
    }
  }, 500);
  return () => { off(); clearInterval(tick); };
}
