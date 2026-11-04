// BGM 무한 루프 (docs/plans/bgm-loop.md): game tracks that loop like in the game.
// Per track: find the loop (worker thread), let the owner check the seam by ear, then render two files once —
//   A = intro + the loop repeated (≥ 20 min), ending exactly at a loop end
//   B = the loop repeated (≥ 60 min), starting at the loop start (OBS plays it with looping on)
// so OBS only ever plays ordinary files and the joins inside them are sample-exact (30 ms crossfade).
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, DATA_DIR } from './config.js';
import { findLoop } from './bgmloop-worker.js';

const SR = 48000;
const XF = Math.round(0.03 * SR);            // crossfade at every seam
const A_MIN_S = 20 * 60, B_MIN_S = 60 * 60;   // file lengths
const CACHE_MAX = 4 * 1024 ** 3;
const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const isWin = process.platform === 'win32';

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

export class BgmLoops extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.dir = path.join(DATA_DIR, 'bgm-loops');
    this.toolsDir = path.join(DATA_DIR, 'tools');
    this.st = loadState('bgm-loops', {}); // id → settings
    this.jobs = new Map(); // id → { kind, progress }
    this.pcmCache = null; // { id, mtime, pcm } — the track being edited (previews)
    this.ffmpegPath = null;
    this.ffmpegState = { state: 'unknown', error: null, progress: null }; // unknown|ok|missing|downloading|error
    for (const v of Object.values(this.st)) if (v.state === 'building') { v.state = v.files ? 'ready' : 'idle'; } // interrupted
  }

  get cfg() { return this.config.bgm || {}; }
  _save() { saveState('bgm-loops', this.st); }
  _changed() { this.emit('change'); }
  _src(id) { return path.join(this.cfg.folder, id); }

  // ---------- what the dashboard sees ----------
  view(id) {
    const s = this.st[id];
    const job = this.jobs.get(id);
    if (!s && !job) return null;
    return {
      enabled: !!s?.enabled, start: s?.start ?? null, end: s?.end ?? null, score: s?.score ?? null, source: s?.source || null,
      state: job ? job.kind : s?.state || 'idle', progress: job?.progress ?? null, error: s?.error || null,
      ready: this.ready(id),
    };
  }
  summary() {
    const out = {};
    for (const id of new Set([...Object.keys(this.st), ...this.jobs.keys()])) { const v = this.view(id); if (v && (v.enabled || v.state !== 'idle' || v.start != null)) out[id] = { enabled: v.enabled, state: v.state, progress: v.progress, ready: v.ready }; }
    return out;
  }
  status() { return { ffmpeg: this.ffmpegState }; }

  // loop files for a track, if they are built for the current settings and the file hasn't changed
  ready(id) {
    const s = this.st[id];
    if (!s?.enabled || !s.files || s.state === 'building') return null;
    try {
      const st = fs.statSync(this._src(id));
      if (st.mtimeMs !== s.mtime || st.size !== s.size) return null;
      if (!fs.existsSync(s.files.a) || !fs.existsSync(s.files.b)) return null;
    } catch { return null; }
    return { a: s.files.a, b: s.files.b, start: s.start, end: s.end, len: s.end - s.start };
  }
  touch(id) { if (this.st[id]) { this.st[id].used = Date.now(); this._save(); } }

  // ---------- ffmpeg (not bundled: one-time download on Windows, or any installed copy) ----------
  async ffmpeg() {
    if (this.ffmpegPath && fs.existsSync(this.ffmpegPath)) return this.ffmpegPath;
    const exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const cands = [this.cfg.ffmpeg, path.join(this.toolsDir, exe)];
    if (isWin && process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    for (const c of cands.filter(Boolean)) if (fs.existsSync(c)) return this._ok(c);
    const r = await run(isWin ? 'where.exe' : 'which', ['ffmpeg']);
    const found = r.stdout.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    if (found && fs.existsSync(found)) return this._ok(found);
    this.ffmpegState = { state: this.ffmpegState.state === 'downloading' ? 'downloading' : 'missing', error: null, progress: this.ffmpegState.progress };
    this._changed();
    return null;
  }
  _ok(p) { this.ffmpegPath = p; if (this.ffmpegState.state !== 'ok') { this.ffmpegState = { state: 'ok', error: null, progress: null, path: p }; this._changed(); } return p; }

  // Windows: the "release essentials" build from gyan.dev (the one ffmpeg.org links to), checked against its SHA-256
  async downloadFfmpeg() {
    if (await this.ffmpeg()) return { path: this.ffmpegPath };
    if (!isWin) throw new Error('이 PC에서는 ffmpeg를 직접 설치해 주세요');
    if (this.ffmpegState.state === 'downloading') return { downloading: true };
    this.ffmpegState = { state: 'downloading', error: null, progress: 0 };
    this._changed();
    const tmp = path.join(os.tmpdir(), `allmind-ffmpeg-${Date.now()}`);
    try {
      fs.mkdirSync(tmp, { recursive: true });
      const want = (await (await fetch(FFMPEG_ZIP + '.sha256')).text()).trim().split(/\s+/)[0].toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('ffmpeg 확인값(SHA-256)을 받지 못했어요');
      const res = await fetch(FFMPEG_ZIP);
      if (!res.ok) throw new Error(`ffmpeg를 받지 못했어요 (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const zip = path.join(tmp, 'ffmpeg.zip');
      const out = fs.createWriteStream(zip);
      const hash = crypto.createHash('sha256');
      let got = 0, lastEmit = 0;
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        if (total && Date.now() - lastEmit > 1000) { lastEmit = Date.now(); this.ffmpegState.progress = Math.floor((got / total) * 100); this._changed(); }
      }
      await new Promise((r) => out.end(r));
      if (hash.digest('hex') !== want) throw new Error('받은 ffmpeg 파일이 확인값과 달라요 — 다시 시도해 주세요');
      const ex = path.join(tmp, 'x');
      const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${ex.replace(/'/g, "''")}' -Force`], { timeout: 180000 });
      if (ps.err) throw new Error(`압축을 풀지 못했어요 (${ps.stderr.slice(0, 200)})`);
      const find = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name.toLowerCase() === 'ffmpeg.exe') return p; } return null; };
      const exe = find(ex);
      if (!exe) throw new Error('받은 파일에 ffmpeg.exe가 없어요');
      fs.mkdirSync(this.toolsDir, { recursive: true });
      fs.copyFileSync(exe, path.join(this.toolsDir, 'ffmpeg.exe'));
      console.log('[loop] ffmpeg installed to', this.toolsDir);
      this.ffmpegPath = null;
      await this.ffmpeg();
      return { path: this.ffmpegPath };
    } catch (e) {
      console.log('[loop] ffmpeg download failed:', e.message);
      this.ffmpegState = { state: 'error', error: e.message, progress: null };
      this._changed();
      throw e;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async _needFfmpeg() {
    const f = await this.ffmpeg();
    if (!f) { const e = new Error('ffmpeg가 필요해요 — 루프 창의 "ffmpeg 받기"를 눌러 주세요'); e.code = 'NO_FFMPEG'; throw e; }
    return f;
  }

  // ---------- audio ----------
  // the whole track as 48 kHz stereo 16-bit (kept for the track being edited, for quick previews)
  async _pcm(id) {
    const file = this._src(id);
    const st = fs.statSync(file);
    if (this.pcmCache?.id === id && this.pcmCache.mtime === st.mtimeMs) return this.pcmCache.pcm;
    const ff = await this._needFfmpeg();
    const pcm = await new Promise((resolve, reject) => {
      const p = spawn(ff, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', '2', '-ar', String(SR), '-'], { windowsHide: true });
      const parts = []; let err = '';
      p.stdout.on('data', (c) => parts.push(c));
      p.stderr.on('data', (c) => { err += c; });
      p.on('error', reject);
      p.on('close', (code) => {
        const buf = Buffer.concat(parts);
        if (code !== 0 || buf.length < SR * 4) return reject(new Error(`이 파일을 읽지 못했어요 (${err.trim().slice(0, 160) || code})`));
        resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
      });
    });
    this.pcmCache = { id, mtime: st.mtimeMs, pcm };
    return pcm;
  }

  // loop points written into the file by game rips (LOOPSTART / LOOPLENGTH or LOOPEND, in samples of the file's rate)
  async _tags(id) {
    const ff = await this._needFfmpeg();
    const r = await run(ff, ['-hide_banner', '-i', this._src(id), '-f', 'ffmetadata', '-'], { timeout: 20000 });
    const tags = {};
    for (const line of r.stdout.split(/\r?\n/)) { const m = /^([A-Za-z_]+)=(\d+)$/.exec(line.trim()); if (m) tags[m[1].toUpperCase()] = Number(m[2]); }
    const rate = Number(/,\s*(\d+)\s*Hz/.exec(r.stderr)?.[1]) || 0;
    if (!rate || !('LOOPSTART' in tags) || !(('LOOPLENGTH' in tags) || ('LOOPEND' in tags))) return null;
    const start = tags.LOOPSTART / rate;
    const end = 'LOOPLENGTH' in tags ? (tags.LOOPSTART + tags.LOOPLENGTH) / rate : tags.LOOPEND / rate;
    return end - start > 5 ? { start, end } : null;
  }

  // find the loop (tags first, then the analysis in a worker thread)
  async detect(id) {
    if (this.jobs.has(id)) throw new Error('이 곡은 이미 작업 중이에요');
    this.jobs.set(id, { kind: 'analyzing', progress: null });
    this._changed();
    const t0 = Date.now();
    try {
      const tag = await this._tags(id).catch(() => null);
      let r;
      if (tag) r = { found: true, start: tag.start, end: tag.end, loopLen: tag.end - tag.start, score: 100, source: 'tag' };
      else {
        const pcm = await this._pcm(id);
        r = await new Promise((resolve, reject) => {
          const w = new Worker(`const { parentPort } = require('node:worker_threads'); const findLoop = ${findLoop.toString()};
            parentPort.once('message', (m) => { try { parentPort.postMessage({ ok: findLoop(m) }); } catch (e) { parentPort.postMessage({ err: String(e && e.stack || e) }); } });`, { eval: true });
          w.once('message', (m) => { w.terminate(); m.err ? reject(new Error(m.err)) : resolve(m.ok); });
          w.once('error', reject);
          w.postMessage({ pcm: pcm.slice(), sr: SR });
        });
        r.source = 'auto';
      }
      console.log(`[loop] ${id}: ${r.found ? `loop ${r.start.toFixed(3)} → ${r.end.toFixed(3)} s (${r.loopLen.toFixed(3)} s, ${r.score} %, ${r.source})` : `no loop (${r.reason})`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return r;
    } finally {
      this.jobs.delete(id);
      this._changed();
    }
  }

  // a few seconds before the seam, then on from the loop start — what the loop will sound like, as MP3 for a browser
  async preview(id, start, end) {
    start = Number(start); end = Number(end);
    if (!(end - start > 1)) throw new Error('루프 끝은 시작보다 뒤여야 해요');
    const pcm = await this._pcm(id);
    const S = Math.round(start * SR), E = Math.round(end * SR), n = pcm.length / 2;
    if (E > n || S < XF) throw new Error('루프 지점이 곡 밖에 있어요');
    const pre = Math.min(6 * SR, E - XF), post = Math.min(6 * SR, n - S);
    const out = new Int16Array((pre + post) * 2);
    out.set(pcm.subarray((E - XF - pre) * 2, (E - XF) * 2), 0);
    this._blend(pcm, E - XF, S - XF, out, pre);                  // 30 ms crossfade
    out.set(pcm.subarray(S * 2, (S + post - XF) * 2), (pre + XF) * 2);
    return this._encode(out, ['-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', '-']);
  }

  // Waveform around the seam for the editor (min/max peaks, not audio). Time axis −span…+span s around the jump:
  //   heard: what plays — the last `span` s before the loop end, then `span` s from the loop start
  //   ghost: the other side of the loop at the same moments — before the loop start, and after the loop end in the
  //          original track. A good seam makes the two lines match on both sides.
  // → { span, bins, heard:[min,max,…], ghost:[min,max,… | null where the track has no audio] } in −127…127,
  //   both scaled by the same factor (loudest of the two)
  async peaks(id, start, end, span = 2, bins = 600) {
    start = Number(start); end = Number(end);
    span = Math.min(4, Math.max(0.05, Number(span) || 2));
    bins = Math.min(1200, Math.max(50, Math.round(Number(bins) || 600)));
    if (!(end - start > 1)) throw new Error('루프 끝은 시작보다 뒤여야 해요');
    const pcm = await this._pcm(id);
    const n = pcm.length / 2, S = Math.round(start * SR), E = Math.round(end * SR), W = Math.round(span * SR);
    if (E > n || S < 0) throw new Error('루프 지점이 곡 밖에 있어요');
    const per = (2 * W) / bins;
    // sample index in the track for window position k (0…2W): left half counts back from one point, right half on from another
    const read = (leftFrom, rightFrom) => {
      const out = new Float32Array(bins * 2);
      let peak = 0;
      for (let b = 0; b < bins; b++) {
        let lo = Infinity, hi = -Infinity;
        const k0 = Math.floor(b * per), k1 = Math.max(k0 + 1, Math.floor((b + 1) * per));
        for (let k = k0; k < k1; k++) {
          const i = k < W ? leftFrom - W + k : rightFrom + (k - W);
          if (i < 0 || i >= n) continue;
          const v = (pcm[i * 2] + pcm[i * 2 + 1]) / 2;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo === Infinity) { out[b * 2] = NaN; out[b * 2 + 1] = NaN; continue; }
        out[b * 2] = lo; out[b * 2 + 1] = hi;
        peak = Math.max(peak, -lo, hi);
      }
      return { out, peak };
    };
    const heard = read(E, S), ghost = read(S, E);
    const scale = 127 / Math.max(1, heard.peak, ghost.peak);
    const pack = (a) => Array.from(a, (v) => (Number.isNaN(v) ? null : Math.round(v * scale)));
    return { span, bins, heard: pack(heard.out), ghost: pack(ghost.out) };
  }

  // the last XF samples before `fromEnd` faded out while the XF samples before `toStart` fade in → out[at…]
  _blend(pcm, fromEnd, toStart, out, at) {
    for (let i = 0; i < XF; i++) {
      const k = (i / XF) * (Math.PI / 2), fo = Math.cos(k), fi = Math.sin(k);
      for (let c = 0; c < 2; c++) {
        const v = pcm[(fromEnd + i) * 2 + c] * fo + pcm[(toStart + i) * 2 + c] * fi;
        out[(at + i) * 2 + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
      }
    }
  }

  async _encode(int16, args) {
    const ff = await this._needFfmpeg();
    return new Promise((resolve, reject) => {
      const p = spawn(ff, ['-v', 'error', '-f', 's16le', '-ac', '2', '-ar', String(SR), '-i', '-', ...args], { windowsHide: true });
      const parts = []; let err = '';
      p.stdout.on('data', (c) => parts.push(c));
      p.stderr.on('data', (c) => { err += c; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(err.trim().slice(0, 200) || `ffmpeg ${code}`))));
      p.stdin.on('error', () => {});
      p.stdin.end(Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength));
    });
  }

  // ---------- settings + building ----------
  async save(id, { start, end, enabled = true, source = 'manual', score = null }) {
    start = Number(start); end = Number(end);
    if (!(end - start > 5)) throw new Error('루프 길이는 5초보다 길어야 해요');
    const st = fs.statSync(this._src(id));
    const prev = this.st[id] || {};
    const same = prev.files && Math.abs(prev.start - start) < 1e-6 && Math.abs(prev.end - end) < 1e-6 && prev.mtime === st.mtimeMs;
    this.st[id] = { ...prev, enabled, start, end, source, score, mtime: st.mtimeMs, size: st.size, error: null, state: same ? 'ready' : 'idle', used: Date.now() };
    if (!same) { this._dropFiles(prev); this.st[id].files = null; }
    this._save();
    this._changed();
    if (enabled && !same) this.build(id).catch(() => {});
    return this.view(id);
  }

  setEnabled(id, on) {
    if (!this.st[id]) throw new Error('먼저 루프 지점을 정해 주세요');
    this.st[id].enabled = !!on;
    this._save();
    this._changed();
    if (on && !this.ready(id) && !this.jobs.has(id)) this.build(id).catch(() => {});
    return this.view(id);
  }

  remove(id) {
    this._dropFiles(this.st[id]);
    delete this.st[id];
    this._save();
    this._changed();
    return { removed: id };
  }

  _dropFiles(s) {
    for (const f of Object.values(s?.files || {})) fs.rm(f, { force: true }, () => {});
  }

  async build(id) {
    const s = this.st[id];
    if (!s) throw new Error('루프 설정이 없어요');
    if (this.jobs.has(id)) return;
    const job = { kind: 'building', progress: 0 };
    this.jobs.set(id, job);
    s.state = 'building'; s.error = null;
    this._changed();
    const t0 = Date.now();
    try {
      const pcm = await this._pcm(id);
      const n = pcm.length / 2;
      const S = Math.round(s.start * SR), E = Math.round(s.end * SR), L = E - S;
      if (E > n || S < XF) throw new Error('루프 지점이 곡 밖에 있어요');
      fs.mkdirSync(this.dir, { recursive: true });
      const key = crypto.createHash('sha1').update(`${id}|${S}|${E}|${s.mtime}`).digest('hex').slice(0, 16);
      const files = { a: path.join(this.dir, `${key}-a.opus`), b: path.join(this.dir, `${key}-b.opus`) };
      const passesA = Math.max(1, Math.ceil((A_MIN_S * SR - E) / L));
      const passesB = Math.max(2, Math.ceil((B_MIN_S * SR) / L));
      const totalSamples = E + passesA * L + passesB * L;
      let done = 0;
      const tick = (k) => { done += k; const p = Math.floor((done / totalSamples) * 100); if (p !== job.progress) { job.progress = p; if (p % 2 === 0) this._changed(); } };
      // A: [0, E) then passes of [S, E), each join crossfaded
      await this._render(files.a + '.part', function* () {
        yield pcm.subarray(0, (E - XF) * 2); tick(E - XF);
        for (let i = 0; i < passesA; i++) { yield 'XF'; yield pcm.subarray(S * 2, (E - XF) * 2); tick(L); }
        yield pcm.subarray((E - XF) * 2, E * 2); // ends exactly at a loop end (B goes on from the loop start)
      }, pcm, S, E);
      // B: passes of [S, E) — starts at the loop start, ends at a loop end (OBS loops the file)
      await this._render(files.b + '.part', function* () {
        yield pcm.subarray(S * 2, (E - XF) * 2); tick(L);
        for (let i = 1; i < passesB; i++) { yield 'XF'; yield pcm.subarray(S * 2, (E - XF) * 2); tick(L); }
        yield pcm.subarray((E - XF) * 2, E * 2);
      }, pcm, S, E);
      fs.renameSync(files.a + '.part', files.a);
      fs.renameSync(files.b + '.part', files.b);
      s.files = files; s.state = 'ready'; s.error = null;
      console.log(`[loop] built ${id}: A ${(fs.statSync(files.a).size / 1e6).toFixed(0)} MB, B ${(fs.statSync(files.b).size / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      this._trim();
    } catch (e) {
      s.state = 'error'; s.error = e.message;
      console.log(`[loop] build failed for ${id}: ${e.message}`);
    } finally {
      this.jobs.delete(id);
      this._save();
      this._changed();
    }
  }

  // stream the pieces into one ffmpeg (Opus 192 kb/s), low priority, one thread
  async _render(out, pieces, pcm, S, E) {
    const ff = await this._needFfmpeg();
    const blend = new Int16Array(XF * 2);
    this._blend(pcm, E - XF, S - XF, blend, 0);
    await new Promise((resolve, reject) => {
      const p = spawn(ff, ['-v', 'error', '-y', '-f', 's16le', '-ac', '2', '-ar', String(SR), '-i', '-', '-threads', '1', '-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', '-f', 'ogg', out], { windowsHide: true });
      try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(0, 200) || `ffmpeg ${code}`))));
      p.stdin.on('error', () => {});
      (async () => {
        for (const piece of pieces()) {
          const arr = piece === 'XF' ? blend : piece;
          // write in ~1 MB chunks, waiting when ffmpeg is behind (keeps memory flat)
          for (let o = 0; o < arr.length; o += 512 * 1024) {
            const sub = arr.subarray(o, Math.min(arr.length, o + 512 * 1024));
            if (!p.stdin.write(Buffer.from(sub.buffer, sub.byteOffset, sub.byteLength))) await new Promise((r) => p.stdin.once('drain', r));
          }
        }
        p.stdin.end();
      })().catch(reject);
    });
  }

  // keep the rendered files under CACHE_MAX: the least recently used loops lose their files (rebuilt when needed)
  _trim() {
    const list = Object.entries(this.st).filter(([, s]) => s.files).map(([id, s]) => {
      let size = 0; for (const f of Object.values(s.files)) { try { size += fs.statSync(f).size; } catch {} }
      return { id, s, size };
    }).sort((a, b) => (a.s.used || 0) - (b.s.used || 0));
    let total = list.reduce((a, x) => a + x.size, 0);
    for (const x of list) {
      if (total <= CACHE_MAX) break;
      this._dropFiles(x.s); x.s.files = null; x.s.state = 'idle'; total -= x.size;
      console.log(`[loop] dropped the rendered files of ${x.id} (cache over ${CACHE_MAX / 1024 ** 3} GB)`);
    }
    // files nobody refers to any more
    const keep = new Set(Object.values(this.st).flatMap((s) => Object.values(s.files || {})).map((f) => path.basename(f)));
    try { for (const f of fs.readdirSync(this.dir)) if (!keep.has(f)) fs.rm(path.join(this.dir, f), { force: true }, () => {}); } catch {}
  }
}
