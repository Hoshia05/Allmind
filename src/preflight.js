// 방송 전 점검: one list of everything that has gone wrong on a stream before, checked in a second.
// Runs when a dashboard opens the 점검 sheet, once after OBS connects, and every 10 min while a
// dashboard is open and OBS isn't live. Costs a handful of OBS requests (no screenshots).
import fs from 'node:fs';

// status: ok | warn | bad | info (just so you know) | off (feature not used)
const item = (id, group, label, status, detail, fix) => ({ id, group, label, status, detail: detail || '', fix: fix || '' });

export async function runPreflight(c) {
  const out = [];
  const { obs, config } = c;
  const live = c.obsStreaming();

  // ---------- OBS ----------
  const info = await c.obsInfo().catch(() => ({}));
  if (!obs.connected) {
    out.push(item('obs', 'OBS', 'OBS 연결', info.running ? 'bad' : 'warn', info.running ? (obs.lastError || '연결 안 됨') : 'OBS가 꺼져 있어요', info.running ? '설정 창 → OBS 연결 (WebSocket 서버·비밀번호)' : '설정 창의 OBS 시작'));
  } else {
    out.push(item('obs', 'OBS', 'OBS 연결', 'ok', '연결됨'));
    out.push(item('debug', 'OBS', '영도 클릭 전달', info.debugOn ? 'ok' : 'warn', info.debugOn ? 'Allmind가 켠 OBS' : 'OBS가 Allmind 밖에서 켜져서 클릭 전달·광고 스킵이 꺼져 있어요', info.debugOn ? '' : '방송 전이면 OBS를 닫고 설정 창의 OBS 시작'));
  }
  const started = await c.obsStartedAt().catch(() => null);
  if (started) {
    const h = (Date.now() - started) / 3600000;
    out.push(item('uptime', 'OBS', 'OBS 켜진 시간', h >= 20 ? 'warn' : 'ok', h < 1 ? `${Math.round(h * 60)}분` : `${h.toFixed(1)}시간`, h >= 20 ? '오래 켜 둔 OBS는 프레임이 밀려요 — 방송 전에 OBS를 다시 켜 주세요' : ''));
  }
  if (obs.connected) {
    // recording: Hybrid MP4 (record chapters) and the 5 split audio tracks
    try {
      const mode = (await obs.call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })).parameterValue || 'Simple';
      const cat = mode === 'Advanced' ? 'AdvOut' : 'SimpleOutput';
      const fmt = (await obs.call('GetProfileParameter', { parameterCategory: cat, parameterName: 'RecFormat2' })).parameterValue
        || (await obs.call('GetProfileParameter', { parameterCategory: cat, parameterName: 'RecFormat' })).parameterValue || '';
      if (fmt) out.push(item('recfmt', 'OBS', '녹화 형식', fmt === 'hybrid_mp4' ? 'ok' : 'warn', fmt.replace('hybrid_mp4', 'Hybrid MP4').replace('_', ' '), fmt === 'hybrid_mp4' ? '' : 'Hybrid MP4로 하면 ⭐ 마크가 영상 안에도 챕터로 들어가요 (OBS → 설정 → 출력 → 녹화)'));
      const tr = Number((await obs.call('GetProfileParameter', { parameterCategory: cat, parameterName: 'RecTracks' })).parameterValue);
      if (Number.isFinite(tr) && tr > 0) {
        const n = [...Array(6).keys()].filter((i) => tr & (1 << i)).length;
        const want = Number(config.preflight?.recTracks) || 5;
        out.push(item('rectracks', 'OBS', '녹화 오디오 트랙', n >= want ? 'ok' : 'warn', `${n}개${n < want ? ` (보통 ${want}개)` : ''}`, n >= want ? '' : 'OBS → 설정 → 출력 → 녹화의 오디오 트랙을 확인해 주세요'));
      }
    } catch {}
    // free disk space where OBS records
    try {
      const dir = (await obs.call('GetRecordDirectory')).recordDirectory;
      const s = await fs.promises.statfs(dir);
      const gb = (s.bavail * s.bsize) / 1e9;
      out.push(item('disk', 'OBS', '녹화 디스크 남은 공간', gb < 20 ? 'bad' : gb < 60 ? 'warn' : 'ok', `${gb.toFixed(0)} GB`, gb < 60 ? '긴 방송이면 모자랄 수 있어요 — 지난 녹화를 옮기거나 지워 주세요' : ''));
    } catch {}
  }

  // ---------- 화면 · 소리 ----------
  if (obs.connected) {
    const b = c.bgm.snapshot();
    if (!b.tracks.length) out.push(item('bgm', '화면 · 소리', 'BGM', 'warn', b.folderError || '음악 폴더에 곡이 없어요', '설정 창 → BGM · 사운드보드'));
    else if (!b.sourceOk) out.push(item('bgm', '화면 · 소리', 'BGM 소스', 'bad', b.sourceError || `"${b.sourceName}" 소스가 없어요`, '대시보드 BGM 칸의 현재 장면에 만들기'));
    else if (b.sourceActive === false) out.push(item('bgm', '화면 · 소리', 'BGM 소스', 'bad', '지금 장면에서 숨겨져 있어서 소리가 안 나가요', 'OBS에서 BGM 소스를 보이게 (안 보이게 하려면 그룹 크기를 0으로)'));
    else out.push(item('bgm', '화면 · 소리', 'BGM', 'ok', `${b.tracks.length}곡 · ${b.sourceName}`));
    const sb = c.soundboard.status();
    if (sb.folder) out.push(item('sb', '화면 · 소리', '사운드보드', sb.sourceOk ? 'ok' : 'warn', sb.sourceOk ? `${sb.sounds.length}개` : `"${sb.sourceName}" 소스가 없어요`, sb.sourceOk ? '' : '대시보드 사운드보드 칸의 만들기'));
    const d = c.viewer.status();
    out.push(item('donation', '화면 · 소리', '영도 소스', d.sourceOk ? 'ok' : 'warn', d.sourceOk ? d.sourceName : d.error || `"${d.sourceName}" 소스가 없어요`, d.sourceOk ? '' : '설정 창 → 화면 소스'));
    const ch = c.chatViewer.status();
    if (ch.sourceName) out.push(item('chatsrc', '화면 · 소리', '위플챗 소스', ch.sourceOk ? 'ok' : 'warn', ch.sourceOk ? ch.sourceName : ch.error || `"${ch.sourceName}" 소스가 없어요`, ch.sourceOk ? '' : '설정 창 → 화면 소스'));
    const st = c.studio.status();
    if (st.mic?.name) out.push(item('mic', '화면 · 소리', '마이크', st.mic.muted ? 'warn' : 'ok', st.mic.muted ? `${st.mic.name} — 음소거 중` : st.mic.name, st.mic.muted ? '대시보드에서 마이크 음소거 풀기' : ''));
  }

  // ---------- 치지직 ----------
  const cz = c.chzzk.status();
  if (!cz.channelId) out.push(item('channel', '치지직', '치지직 채널', 'bad', '채널이 설정되지 않았어요', '설정 창 → 치지직 채널'));
  else if (cz.error) out.push(item('channel', '치지직', '치지직', 'warn', cz.error));
  else out.push(item('channel', '치지직', '치지직', 'ok', cz.live?.isLive ? `방송 중 · 시청자 ${cz.live.viewers}` : `${cz.live?.channelName || '채널'} · 오프라인`));
  const co = c.chzzkOpen.status();
  if (co.configured) out.push(item('chzzkopen', '치지직', '치지직 연동 (방송 준비 · 채팅 보내기)', co.loggedIn ? (co.expiresSoon ? 'warn' : 'ok') : 'warn', co.loggedIn ? (co.expiresSoon ? '로그인이 곧 만료돼요' : co.account || '로그인됨') : co.error || '로그인 필요', co.loggedIn && !co.expiresSoon ? '' : '설정 창 → 치지직 연동 → 다시 로그인'));
  const rc = c.remote.status();
  out.push(item('remote', '치지직', '치지직 리모컨 (넘기기·알림 정지)', rc.connected ? (rc.needsLogin ? 'warn' : 'ok') : 'info', rc.connected ? (rc.needsLogin ? 'OBS 독에서 네이버 로그인이 필요해요' : '연결됨') : '안 씀 (OBS 독이 없어요)', rc.connected && rc.needsLogin ? 'OBS의 치지직 리모컨 독에서 로그인' : ''));

  // ---------- 유튜브 · 드라이브 ----------
  const g = c.google.status();
  const y = c.youtube.status();
  if (y.enabled && g.configured) {
    if (!g.youtube) out.push(item('youtube', '유튜브 · 드라이브', '유튜브 아카이브', 'bad', 'Google 로그인이 필요해요', '설정 창 → Google 계정'));
    else if (!y.hasKey) out.push(item('youtube', '유튜브 · 드라이브', '유튜브 아카이브', 'bad', '스트림 키가 없어요', '설정 창 → 유튜브 아카이브 → 스트림 키 만들기'));
    else if (y.error) out.push(item('youtube', '유튜브 · 드라이브', '유튜브 아카이브', 'bad', y.error, '설정 창 → 유튜브 아카이브'));
    else if (y.broadcast) {
      const priv = y.broadcast.privacy === 'private';
      const ready = ['ready', 'created', 'live', 'liveStarting', 'testing'].includes(y.broadcast.life);
      out.push(item('youtube', '유튜브 · 드라이브', '유튜브 아카이브', priv && ready ? 'ok' : 'warn', `${priv ? '🔒 비공개' : `⚠ ${y.broadcast.privacy}`} · ${y.broadcast.title}`, priv ? '' : 'Allmind가 방송 중에 비공개로 되돌리지만, 미리 확인해 주세요'));
    } else out.push(item('youtube', '유튜브 · 드라이브', '유튜브 아카이브', 'warn', '방송을 준비하는 중이에요 — 잠시 뒤 다시 점검', ''));
  } else out.push(item('youtube', '유튜브 · 드라이브', '유튜브 아카이브', 'off', '안 씀'));
  const dr = c.drive.status();
  if (dr.enabled && g.configured) {
    const err = dr.items.find((i) => i.status === 'error');
    const waiting = dr.items.filter((i) => (i.status === 'waiting' || i.status === 'uploading') && i.kind === 'video').length;
    if (!g.drive) out.push(item('drive', '유튜브 · 드라이브', '드라이브 업로드', 'warn', 'Google 로그인(드라이브)이 필요해요', '설정 창 → Google 계정'));
    else if (dr.needsReauth) out.push(item('drive', '유튜브 · 드라이브', '드라이브 업로드', 'warn', '올릴 폴더 권한 때문에 로그인을 한 번 더 해야 해요', '설정 창 → Google 계정 → 다시 로그인'));
    else if (err) out.push(item('drive', '유튜브 · 드라이브', '드라이브 업로드', 'warn', `실패한 업로드: ${err.name}`, '방송 준비 창의 업로드 목록에서 다시 시도'));
    else out.push(item('drive', '유튜브 · 드라이브', '드라이브 업로드', 'ok', waiting ? `지난 녹화 ${waiting}개 올리는 중 (방송이 시작되면 멈춰요)` : dr.custom ? dr.folderName || '내 폴더' : 'Allmind 녹화 폴더'));
  } else out.push(item('drive', '유튜브 · 드라이브', '드라이브 업로드', 'off', '안 씀'));

  // ---------- 기타 ----------
  const v = c.vts.status();
  if (v.enabled) out.push(item('vts', '기타', 'VTube Studio', v.state === 'ready' ? (v.customItems ? 'ok' : 'warn') : 'warn', v.state === 'ready' ? `연결됨 · ${v.model || '모델 없음'}` : v.error || '연결 안 됨', v.state === 'ready' ? '' : '메인 PC의 VTube Studio와 API가 켜져 있는지 확인'));
  const u = c.update();
  if (u?.available) out.push(item('update', '기타', 'Allmind 업데이트', 'info', `새 버전 ${u.latest}`, live ? '방송이 끝난 뒤 설정 창에서 업데이트' : '방송 전이면 설정 창 → 업데이트'));

  const counts = { bad: out.filter((x) => x.status === 'bad').length, warn: out.filter((x) => x.status === 'warn').length };
  return { at: Date.now(), live, items: out, ...counts };
}
