// ⭐ Mark moment: marks funny moments in the OBS recording for VOD Scout.
//
// On each press: GetRecordStatus → t = outputDuration (OBS's own clock, so
// pauses are already excluded) → CreateRecordChapter (lands inside the file
// with Hybrid MP4 on OBS 30.2+; silently skipped otherwise) → append to the
// markers file and save at once.
//
// The markers file (format "vodscout-markers" v1) lives in the OBS recording
// folder as vodscout-markers-<start>.json while recording, and is renamed to
// "<video name>.markers.json" next to the video when the recording stops.
// A recording with no marks never gets a file.
//
// Light by design: everything is driven by OBS's RecordStateChanged events;
// the only OBS requests are one GetRecordStatus per press (plus one on connect).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.flv', '.ts', '.m3u8', '.fmp4']);
const TMP_RE = /^vodscout-markers-\d{8}-\d{6}\.json$/;

export class Markers extends EventEmitter {
  constructor(obs, { fallbackDir } = {}) {
    super();
    this.obs = obs;
    this.fallbackDir = fallbackDir; // used only if the recording folder can't be written
    this.cur = null; // the recording in progress, or the last finished one (for notes)

    obs.on('RecordStateChanged', (e) => this._onState(e).catch((err) => this._log('state', err)));
    obs.on('connected', () => this._sync().catch((err) => this._log('sync', err)));
    obs.on('disconnected', () => {
      if (this.cur && !this.cur.done) this.cur.lostAt = Date.now();
    });
    if (obs.connected) this._sync().catch(() => {});
  }

  // ---------- recording lifecycle ----------

  async _onState({ outputState, outputPath }) {
    const s = String(outputState || '').replace('OBS_WEBSOCKET_OUTPUT_', '');
    const r = this.cur && !this.cur.done ? this.cur : null;
    if (s === 'STARTED') {
      if (r) this._finish(r, null); // missed a stop somehow: close that one first
      await this._begin({ outputPath, durationMs: 0 });
    } else if (s === 'PAUSED' && r && !r.paused) {
      r.activeMs = this._elapsed(r);
      r.paused = true;
      this.emit('change');
    } else if (s === 'RESUMED' && r && r.paused) {
      r.paused = false;
      r.runSince = Date.now();
      this.emit('change');
    } else if (s === 'STOPPING' && r && !r.paused) {
      // freeze the length here: STOPPED can come seconds later, after OBS
      // has finished writing the file
      r.activeMs = this._elapsed(r);
      r.paused = true;
    } else if (s === 'STOPPED' && r) {
      this._finish(r, outputPath || r.outputPath);
    }
  }

  // On (re)connect, catch up with what OBS is doing.
  async _sync() {
    const st = await this.obs.call('GetRecordStatus');
    const r = this.cur && !this.cur.done ? this.cur : null;
    if (st.outputActive) {
      if (r) {
        // same recording if OBS's clock is where ours could be
        const known = r.lastObsMs ?? 0;
        if (st.outputDuration + 2000 >= known && st.outputDuration <= this._elapsed(r) + 5000) {
          this._resync(r, st);
          r.lostAt = null;
          this.emit('change');
          return;
        }
        this._finish(r, null); // it stopped while we were away; a new one runs now
      }
      await this._begin({ durationMs: st.outputDuration, paused: st.outputPaused, recover: true });
    } else if (r) {
      this._finish(r, null); // stopped while we were disconnected
    }
  }

  async _begin({ outputPath = null, durationMs = 0, paused = false, recover = false }) {
    const now = Date.now();
    const r = {
      startedAt: new Date(now - durationMs),
      activeMs: durationMs,
      runSince: now,
      paused: !!paused,
      outputPath: outputPath || null,
      dir: outputPath ? path.dirname(outputPath) : null,
      tmpFile: null,
      file: null, // final markers file once stopped
      chapters: null,
      marks: [],
      done: false,
      lastObsMs: durationMs,
    };
    this.cur = r;
    this.emit('change');
    if (!r.dir) {
      try { r.dir = (await this.obs.call('GetRecordDirectory')).recordDirectory || null; } catch {}
    }
    if (recover) this._recover(r); // Stream Desk restarted mid-recording: pick up its file
    if (!r.tmpFile) r.tmpFile = `vodscout-markers-${stamp(r.startedAt)}.json`;
    this.emit('change');
  }

  // Find the in-progress markers file of this recording (started within 30 s
  // of our estimate; the estimate is off by any paused time, hence the slack).
  _recover(r) {
    if (!r.dir) return;
    let best = null;
    try {
      for (const f of fs.readdirSync(r.dir)) {
        if (!TMP_RE.test(f)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(r.dir, f), 'utf8'));
          const t = Date.parse(j.recording?.started_at);
          const diff = Math.abs(t - r.startedAt.getTime());
          if (j.format === 'vodscout-markers' && diff < 30 * 60000 && t <= r.startedAt.getTime() + 30000 && (!best || diff < best.diff)) {
            best = { f, j, t, diff };
          }
        } catch {}
      }
    } catch { return; }
    if (!best) return;
    r.tmpFile = best.f;
    r.startedAt = new Date(best.t);
    r.marks = Array.isArray(best.j.markers) ? best.j.markers : [];
    r.chapters = best.j.recording?.obs_chapters ?? null;
    this._log('recovered', `${r.marks.length} marks from ${best.f}`);
  }

  _finish(r, outputPath) {
    r.activeMs = r.lostAt ? r.activeMs + (r.paused ? 0 : r.lostAt - r.runSince) : this._elapsed(r);
    r.paused = false;
    r.done = true;
    r.outputPath = outputPath || r.outputPath || this._guessVideo(r);
    if (!r.marks.length) { this.emit('change'); return; }
    const tmp = r.dir && path.join(r.dir, r.tmpFile);
    if (r.outputPath) {
      const p = path.parse(r.outputPath);
      r.file = path.join(p.dir, `${p.name}.markers.json`);
    } else {
      r.file = r.savedAt || tmp; // video unknown: keep the in-progress name (VOD Scout matches by length)
    }
    if (this._write(r, r.file)) {
      if (r.savedAt && r.savedAt !== r.file) fs.rm(r.savedAt, { force: true }, () => {});
      r.savedAt = r.file;
    } else {
      r.file = r.savedAt; // the backup copy is still there
    }
    this.emit('saved', { count: r.marks.length, file: r.file ? path.basename(r.file) : '' });
    this.emit('change');
  }

  // When the stop happened while OBS was disconnected there's no outputPath:
  // take the video in the recording folder that was created closest to the start.
  _guessVideo(r) {
    if (!r.dir) return null;
    let best = null;
    try {
      for (const f of fs.readdirSync(r.dir)) {
        if (!VIDEO_EXT.has(path.extname(f).toLowerCase())) continue;
        const st = fs.statSync(path.join(r.dir, f));
        const born = st.birthtimeMs || st.ctimeMs;
        const diff = Math.abs(born - r.startedAt.getTime());
        if (diff < 120000 && (!best || diff < best.diff)) best = { f, diff };
      }
    } catch {}
    return best ? path.join(r.dir, best.f) : null;
  }

  // ---------- marks ----------

  async mark(label = '') {
    label = String(label || '').trim().slice(0, 200);
    if (!this.obs.connected) return { ok: false, reason: 'OBS not connected' };
    let st;
    try {
      st = await this.obs.call('GetRecordStatus');
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (!st.outputActive) return { ok: false, reason: 'not recording' };
    let r = this.cur && !this.cur.done ? this.cur : null;
    if (!r) {
      await this._begin({ durationMs: st.outputDuration, paused: st.outputPaused, recover: true });
      r = this.cur;
    }
    this._resync(r, st);
    const m = { t: Math.round(st.outputDuration) / 1000, label, created_at: iso(new Date(), false) };
    r.marks.push(m);
    this._save(r);
    this.emit('change');
    // into the video file too (Hybrid MP4, OBS 30.2+); failure is fine
    this.obs.call('CreateRecordChapter', label ? { chapterName: label } : {}).then(
      () => { if (r.chapters !== true) { r.chapters = true; this._save(r); } },
      () => { if (r.chapters == null) { r.chapters = false; this._save(r); } },
    );
    return { ok: true, t: m.t, count: r.marks.length };
  }

  setLabel(index, label) {
    const r = this.cur;
    const m = r?.marks[index];
    if (!m) throw new Error('마크를 찾을 수 없어요');
    m.label = String(label || '').trim().slice(0, 200);
    this._save(r);
    this.emit('change');
  }

  // ---------- file ----------

  _json(r) {
    return {
      format: 'vodscout-markers',
      version: 1,
      recording: {
        file: r.outputPath ? path.basename(r.outputPath) : null,
        started_at: iso(r.startedAt, true),
        duration: Math.round(this._elapsed(r) / 100) / 10,
        obs_chapters: r.chapters === true,
      },
      markers: r.marks,
    };
  }

  _save(r) {
    if (!r.marks.length) return;
    const target = r.done ? r.file : r.savedAt || (r.dir ? path.join(r.dir, r.tmpFile) : null);
    if (target && this._write(r, target)) { r.savedAt = target; return; }
    // recording folder unknown or not writable: keep a copy in Stream Desk's data folder
    if (this.fallbackDir) {
      const fb = path.join(this.fallbackDir, r.tmpFile || `vodscout-markers-${stamp(r.startedAt)}.json`);
      if (this._write(r, fb)) { r.savedAt = fb; if (r.done) r.file = fb; }
    }
  }

  _write(r, file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._json(r), null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      this._log('write', `${file}: ${e.message}`);
      return false;
    }
  }

  // ---------- helpers ----------

  _elapsed(r) {
    if (r.done || r.paused) return r.activeMs;
    return r.activeMs + (Date.now() - r.runSince);
  }

  _resync(r, st) {
    r.activeMs = st.outputDuration;
    r.runSince = Date.now();
    r.paused = !!st.outputPaused;
    r.lastObsMs = st.outputDuration;
  }

  _log(what, msg) {
    console.log(`[markers] ${what}:`, msg?.message || msg);
  }

  status() {
    const r = this.cur;
    if (!r) return { obs: this.obs.connected, recording: false, count: 0, marks: [] };
    return {
      obs: this.obs.connected,
      recording: !r.done,
      paused: r.paused,
      elapsedMs: Math.round(this._elapsed(r)),
      count: r.marks.length,
      marks: r.marks,
      chapters: r.chapters,
      file: r.done && r.file ? path.basename(r.file) : null,
    };
  }
}

const p2 = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
// local time with offset, e.g. 2026-10-16T20:00:03.120+09:00
function iso(d, ms) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
    (ms ? '.' + String(d.getMilliseconds()).padStart(3, '0') : '') + `${off >= 0 ? '+' : '-'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}
