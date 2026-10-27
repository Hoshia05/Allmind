// 공중전 panel on the Xylem page: overlay address builder, round controls, ace ranking.
export function mount(el, x) {
  const { esc } = x;
  el.innerHTML = `
    <h1>✈️ 공중전 <span class="pill" id="dfState"></span></h1>
    <div class="grid2">
      <section class="card">
        <h2>진행</h2>
        <div class="row">
          <button class="btn accent" id="dfStart" title="대기 중인 조종사가 있으면 바로 출격">지금 시작</button>
          <button class="btn" id="dfBoss" title="다음 라운드를 공중요새 BASTION 보스전으로">다음 판 보스전</button>
        </div>
        <div class="row">
          <input class="in" id="dfNick" placeholder="테스트 조종사 이름" value="테스트" style="width:160px">
          <button class="btn ghost sm" id="dfJoin">출격시키기</button>
          <button class="btn ghost sm" id="dfFire">미사일</button>
        </div>
        <div class="hint" style="margin-top:8px">버튼은 방송인이 채팅에 친 것처럼 오버레이로 보내져요 (채팅에는 안 나와요).</div>
      </section>
      <section class="card">
        <h2>OBS 오버레이 주소</h2>
        <div class="grid2" style="gap:8px">
          <label class="field">대기 시간 (초)<input class="in" id="oLobby" type="number" min="5" max="120" value="25"></label>
          <label class="field">최소 기체 수 (AI 포함)<input class="in" id="oFighters" type="number" min="2" max="12" value="4"></label>
          <label class="field">자동 보스전 (N판마다, 0=끔)<input class="in" id="oBoss" type="number" min="0" max="20" value="0"></label>
          <div class="field">표시<label class="check"><input type="checkbox" id="oBoard" checked> 랭킹</label><label class="check"><input type="checkbox" id="oHelp" checked> 명령어 목록</label><label class="check"><input type="checkbox" id="oWeather" checked> 구름·태양</label></div>
        </div>
        <div class="copy" style="margin-top:10px"><code id="dfUrl"></code><button class="btn sm" id="dfCopy">복사</button></div>
        <div class="hint" style="margin-top:6px">OBS → 브라우저 소스, 크기 <b>1920×1080</b> (배경 투명). 이미 추가했다면 주소만 바꾸면 돼요.</div>
      </section>
    </div>
    <div class="grid2">
      <section class="card">
        <h2>모드 <span class="muted small">다음 라운드부터 적용</span></h2>
        <div class="row">
          <label class="check"><input type="radio" name="dfMode" value="solo"> 개인전</label>
          <label class="check"><input type="radio" name="dfMode" value="team"> 팀전</label>
          <label class="field" style="margin-left:auto">팀 수 <select class="in" id="dfTeamN"><option>2</option><option>3</option><option>4</option></select></label>
        </div>
        <div id="dfTeams" style="display:grid;gap:6px;margin-top:8px"></div>
        <div class="row" style="margin-top:10px">
          <button class="btn accent" id="dfModeSave">저장</button>
          <span class="hint" id="dfModeDirty"></span>
        </div>
        <div class="hint" style="margin-top:6px">팀전: 시청자는 <b>!팀 1</b> · <b>!팀 2</b> … 또는 <b>!팀 이름</b>으로 팀을 골라요 (<b>!출격</b>은 사람이 적은 팀). 팀마다 기체 수가 같도록 AI가 채우고, 모두 같은 자동 조종을 써서 공평해요. 마지막까지 남은 팀이 이겨요 — 무언가를 정할 때 동전 던지기 대신 쓰세요.</div>
      </section>
      <section class="card">
        <h2>최근 팀전 결과</h2>
        <div id="dfTeamLog"></div>
      </section>
    </div>
    <section class="card">
      <h2>에이스 랭킹 <span class="muted small">상위 5명 · 승 · 격추</span></h2>
      <table><thead><tr><th>#</th><th>조종사</th><th>승</th><th>격추</th><th>출격</th></tr></thead><tbody id="dfBoard"></tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn danger sm" id="dfReset">랭킹 초기화</button></div>
    </section>
    <section class="card">
      <h2>채팅 명령어</h2>
      <div class="hint" style="line-height:1.9">
        <b>!출격</b> 참전 · <b>!미사일</b> 미사일 (7초) · <b>!플레어</b> 플레어 · <b>!회피</b> 코브라 기동 (보스 빔도 회피) · <b>!특수</b> 특수무기 (25초) · <b>!귀환</b> 나가기<br>
        자동 조종 성향 (명령 사이에 내 기체가 어떻게 날지): <b>!공격형</b> 미사일 자주·플레어 적게 · <b>!회피형</b> 쫓기면 구름이나 태양 쪽으로 · <b>!호위형</b> 팀원을 쫓는 적을 노림 (개인전: 나를 친 적에게 반격) · <b>!기본형</b><br>
        팀전: <b>!팀 1</b> · <b>!팀 이름</b> 팀 고르기/바꾸기 (대기 중에만, 싸우는 중이면 다음 판부터)<br>
        날씨: <b>구름</b> 속의 기체는 미사일이 못 쫓고, <b>태양</b> 쪽으로 도망치면 미사일이 놓칠 수 있어요. 라운드마다 바뀌어요.<br>
        방송인·매니저: <b>!시작</b> 바로 시작 · <b>!보스</b> 다음 판 보스전. 후원은 게임에 영향을 주지 않아요.
      </div>
    </section>`;
  const $ = (id) => el.querySelector('#' + id);
  const url = () => {
    const q = new URLSearchParams();
    if (Number($('oLobby').value) !== 25) q.set('lobby', $('oLobby').value);
    if (Number($('oFighters').value) !== 4) q.set('fighters', $('oFighters').value);
    if (Number($('oBoss').value) > 0) q.set('boss', $('oBoss').value);
    if (!$('oBoard').checked) q.set('board', '0');
    if (!$('oHelp').checked) q.set('help', '0');
    if (!$('oWeather').checked) q.set('weather', '0');
    const s = q.toString();
    return x.overlayUrl('/dogfight' + (s ? `?${s}` : ''));
  };
  const show = () => { $('dfUrl').textContent = url(); };
  for (const id of ['oLobby', 'oFighters', 'oBoss', 'oBoard', 'oHelp', 'oWeather']) $(id).addEventListener('input', show);

  // ---------- mode / teams ----------
  const COLORS = ['#ff5a5a', '#4f9dff', '#ffd34d', '#5be37d'];
  const NAMES = ['레드', '블루', '옐로', '그린'];
  let md = null, mdSaved = null, mdDirty = false;
  const modeDirty = (d) => { mdDirty = d; $('dfModeDirty').textContent = d ? '저장하지 않은 변경이 있어요' : ''; };
  function renderTeams() {
    $('dfTeams').innerHTML = md.teams.map((t, i) => `<div class="row" data-i="${i}" style="margin:0">
      <span class="muted small" style="width:44px">팀 ${i + 1}</span>
      <input class="in" data-k="name" value="${esc(t.name)}" maxlength="12" style="flex:1" placeholder="${NAMES[i]}">
      <input type="color" data-k="color" value="${esc(t.color)}" style="width:40px;height:28px;border:0;background:none;padding:0"></div>`).join('');
    for (const r of el.querySelectorAll('input[name=dfMode]')) r.checked = r.value === md.mode;
    $('dfTeamN').value = String(md.teams.length);
    $('dfTeams').style.opacity = md.mode === 'team' ? 1 : 0.5;
  }
  function fillMode(m) { md = JSON.parse(JSON.stringify({ mode: m.mode, teams: m.teams })); mdSaved = JSON.stringify(md); renderTeams(); modeDirty(false); }
  el.addEventListener('change', (ev) => { if (ev.target.name === 'dfMode') { md.mode = ev.target.value; renderTeams(); modeDirty(true); } });
  $('dfTeamN').onchange = () => {
    const n = Number($('dfTeamN').value);
    while (md.teams.length < n) md.teams.push({ name: NAMES[md.teams.length], color: COLORS[md.teams.length] });
    md.teams.length = n; renderTeams(); modeDirty(true);
  };
  $('dfTeams').oninput = (ev) => {
    const row = ev.target.closest('[data-i]'); if (!row) return;
    md.teams[Number(row.dataset.i)][ev.target.dataset.k] = ev.target.value; modeDirty(true);
  };
  $('dfModeSave').onclick = async () => {
    const r = await x.post('/api/dogfight/mode', md);
    if (r.ok) { fillMode(r.mode); x.toast(r.mode.mode === 'team' ? `팀전: ${r.mode.teams.map((t) => t.name).join(' vs ')}` : '개인전으로 바꿨어요'); }
  };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };
  let logHtml = '';
  show();
  $('dfCopy').onclick = () => x.copy(url());
  const cmd = (text, nick = 'Allmind', role = 'streamer') => x.post('/api/dogfight/cmd', { nick, text, role, uid: role === 'streamer' ? 'allmind:streamer' : undefined });
  $('dfStart').onclick = () => cmd('!시작').then((r) => r.ok && x.toast('시작 신호를 보냈어요'));
  $('dfBoss').onclick = () => cmd('!보스').then((r) => r.ok && x.toast('다음 판은 보스전이에요'));
  $('dfJoin').onclick = () => cmd('!출격', $('dfNick').value.trim() || '테스트', '');
  $('dfFire').onclick = () => cmd('!미사일', $('dfNick').value.trim() || '테스트', '');
  $('dfReset').onclick = () => { if (confirm('에이스 랭킹을 모두 지울까요? 되돌릴 수 없어요.')) x.post('/api/dogfight/reset').then(x.refresh); };

  let last = '';
  return x.onState((st) => {
    const d = st.dogfight;
    if (d) {
      if (!md || (!mdDirty && mdSaved !== JSON.stringify({ mode: d.mode, teams: d.teams }))) fillMode(d);
      const lh = (d.teamLog || []).slice(0, 8).map((r) => `<div class="row" style="margin:0 0 6px;gap:8px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${esc(r.color || '#888')}"></span><b>${esc(r.winner || '무승부')}</b> 승리 <span class="muted small">${esc(r.teams.map((t) => `${t.name} ${t.alive}/${t.jets}`).join(' · '))} · ${ago(r.at)}</span></div>`).join('') || '<div class="muted">아직 팀전 기록이 없어요</div>';
      if (lh !== logHtml) { $('dfTeamLog').innerHTML = lh; logHtml = lh; }
    }
    const n = st.overlays.dogfight;
    $('dfState').className = 'pill ' + (n ? 'ok' : 'warn');
    $('dfState').textContent = n ? `오버레이 ${n}개 연결됨` : '오버레이 연결 안 됨';
    $('dfStart').disabled = $('dfBoss').disabled = !n;
    const html = (st.board || []).map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.nick)}</td><td class="mono">${p.wins}</td><td class="mono">${p.kills}</td><td class="mono">${p.sorties}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">아직 기록이 없어요</td></tr>';
    if (html !== last) { $('dfBoard').innerHTML = html; last = html; }
  });
}
