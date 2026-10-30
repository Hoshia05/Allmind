// Reads what OBS writes to its own log while it runs, for things obs-websocket doesn't tell us.
// For now: audio buffering. When a source stalls (an NDI source over a shaky network, cover art in a
// media file…), OBS adds audio buffering to keep in sync — and never gives it back until OBS restarts,
// so everything on stream sounds that much late (studio 2026-10-30: 960 ms after a network drop).
// Cheap: one fs.stat every 10 s while OBS is connected, reading only what was appended.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WARN_MS = 300; // below this nobody notices
export const obsLogDir = () => process.env.ALLMIND_OBS_LOG_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'obs-studio', 'logs');

export class ObsLogWatch extends EventEmitter {
  constructor(obs) {
    super();
    this.file = null;
    this.pos = 0;
    this.state = { ms: 0, source: '', max: false, warn: false };
    obs.on('connected', () => this._pickFile(true));
    setInterval(() => { if (obs.connected) this._read(); }, 10000).unref?.();
  }

  status() { return this.state; }

  // the newest log file is the running OBS's
  _pickFile(reset) {
    try {
      const dir = obsLogDir();
      const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f || null;
      if (newest !== this.file || reset) {
        if (newest !== this.file) { this.file = newest; this.pos = 0; }
        if (reset && this.state.ms) this._set({ ms: 0, source: '', max: false }); // a new OBS starts from zero
      }
    } catch { this.file = null; }
  }

  _read() {
    this._pickFile(false);
    if (!this.file) return;
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.pos) this.pos = 0;
    if (size === this.pos) return;
    let text = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      const len = Math.min(size - this.pos, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { return; }
    this.pos = size;
    let ms = this.state.ms, source = this.state.source, max = this.state.max;
    for (const m of text.matchAll(/total audio buffering is now (\d+) milliseconds(?: \(source: ([^)\r\n]*)\))?/g)) { ms = Number(m[1]); source = m[2] || source; }
    if (/Max audio buffering reached/.test(text)) max = true;
    if (ms !== this.state.ms || max !== this.state.max) this._set({ ms, source, max });
  }

  _set({ ms, source, max }) {
    const warn = ms >= WARN_MS;
    if (warn && !this.state.warn) console.log(`[obs] audio buffering is now ${ms} ms (source: ${source || '?'})${max ? ' — OBS maximum reached' : ''}: stream audio is that late until OBS restarts`);
    this.state = { ms, source, max, warn };
    this.emit('change', this.state);
  }
}
