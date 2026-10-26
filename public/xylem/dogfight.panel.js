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
          <div class="field">표시<label class="check"><input type="checkbox" id="oBoard" checked> 랭킹</label><label class="check"><input type="checkbox" id="oHelp" checked> 명령어 목록</label></div>
        </div>
        <div class="copy" style="margin-top:10px"><code id="dfUrl"></code><button class="btn sm" id="dfCopy">복사</button></div>
        <div class="hint" style="margin-top:6px">OBS → 브라우저 소스, 크기 <b>1920×1080</b> (배경 투명). 이미 추가했다면 주소만 바꾸면 돼요.</div>
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
    const s = q.toString();
    return x.overlayUrl('/dogfight' + (s ? `?${s}` : ''));
  };
  const show = () => { $('dfUrl').textContent = url(); };
  for (const id of ['oLobby', 'oFighters', 'oBoss', 'oBoard', 'oHelp']) $(id).addEventListener('input', show);
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
    const n = st.overlays.dogfight;
    $('dfState').className = 'pill ' + (n ? 'ok' : 'warn');
    $('dfState').textContent = n ? `오버레이 ${n}개 연결됨` : '오버레이 연결 안 됨';
    $('dfStart').disabled = $('dfBoss').disabled = !n;
    const html = (st.board || []).map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.nick)}</td><td class="mono">${p.wins}</td><td class="mono">${p.kills}</td><td class="mono">${p.sorties}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">아직 기록이 없어요</td></tr>';
    if (html !== last) { $('dfBoard').innerHTML = html; last = html; }
  });
}
