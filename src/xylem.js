// Xylem pack manager (docs/plans/xylem.md): the overlay + settings-page files under public/xylem/
// can be swapped for a newer version downloaded from GitHub WITHOUT restarting Allmind — so games and
// the roulette can be patched mid-stream. The server parts (roulette.js, dogfight.js) stay in Allmind.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readAsset, loadState, saveState, DATA_DIR } from './config.js';
import { cmpVersion } from './update.js';

const KEEP = 3; // downloaded versions kept for rollback
const SAFE = /^[a-z0-9][a-z0-9._-]*$/i; // pack files are flat, simple names

// Server-sent events for overlays and Xylem pages. 'hello' carries the pack version; on a pack switch
// every client gets 'reload' (and a reconnect with a different version reloads too).
export class Channel {
  constructor(getHello) {
    this.getHello = getHello; // () => [[event, data], …]
    this.clients = new Set();
  }
  get size() { return this.clients.size; }
  attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    for (const [ev, data] of this.getHello()) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }
  send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }
}

export class XylemPack extends EventEmitter {
  constructor(config, appVersion) {
    super();
    this.config = config;
    this.appVersion = appVersion;
    this.dir = path.join(DATA_DIR, 'xylem-pack');
    this.builtin = JSON.parse(readAsset('public/xylem/manifest.json')?.toString('utf8') || '{"version":"0.0.0","modules":[]}');
    this.st = loadState('xylem', { active: null }); // active: downloaded version in use, or null = built-in
    this.remote = null; // last fetched manifest
    this.checking = false;
    this.applying = false;
    this.error = null;
    this.checkedAt = 0;
    this.channels = new Set(); // every Channel that must reload on a switch
    this._fixActive();
  }

  get cfg() { return this.config.xylem || {}; }
  get packUrl() { return (process.env.XYLEM_PACK_URL || this.cfg.packUrl || 'https://raw.githubusercontent.com/Hoshia05/Allmind/main/public/xylem/').replace(/\/?$/, '/'); }

  // A downloaded pack only wins while it is newer than the one built into this exe.
  _fixActive() {
    const v = this.st.active;
    if (v && (cmpVersion(v, this.builtin.version) <= 0 || !fs.existsSync(path.join(this.dir, v, 'manifest.json')))) {
      this.st.active = null;
      saveState('xylem', this.st);
    }
  }

  manifest() {
    if (this.st.active) {
      try { return JSON.parse(fs.readFileSync(path.join(this.dir, this.st.active, 'manifest.json'), 'utf8')); } catch {}
    }
    return this.builtin;
  }
  version() { return this.manifest().version; }

  // A pack file (overlay / page / panel script), from the active pack, else the built-in one.
  file(name) {
    if (!SAFE.test(name)) return null;
    if (this.st.active) {
      try { return fs.readFileSync(path.join(this.dir, this.st.active, name)); } catch {}
    }
    return readAsset(`public/xylem/${name}`);
  }

  downloaded() {
    try {
      return fs.readdirSync(this.dir).filter((v) => fs.existsSync(path.join(this.dir, v, 'manifest.json'))).sort(cmpVersion).reverse();
    } catch { return []; }
  }

  status() {
    const r = this.remote;
    const newer = r && cmpVersion(r.version, this.version()) > 0;
    return {
      version: this.version(),
      builtin: this.builtin.version,
      active: this.st.active,
      modules: this.manifest().modules || [],
      remote: r ? { version: r.version, minAllmind: r.minAllmind || null, notes: r.notes || '' } : null,
      available: !!(newer && (!r.minAllmind || cmpVersion(this.appVersion, r.minAllmind) >= 0)),
      needsAllmind: !!(newer && r.minAllmind && cmpVersion(this.appVersion, r.minAllmind) < 0) ? r.minAllmind : null,
      rollback: this.downloaded().filter((v) => v !== this.st.active && cmpVersion(v, this.builtin.version) > 0),
      checking: this.checking, applying: this.applying, error: this.error, checkedAt: this.checkedAt,
    };
  }

  async _get(rel, as = 'json') {
    const res = await fetch(this.packUrl + rel + (as === 'json' ? `?t=${Date.now()}` : ''), {
      headers: { 'User-Agent': `Allmind/${this.appVersion}`, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
  }

  async check() {
    if (this.checking) return this.status();
    this.checking = true;
    try {
      const m = await this._get('manifest.json');
      if (!m?.version || !m.files || typeof m.files !== 'object') throw new Error('팩 정보가 올바르지 않아요');
      this.remote = m;
      this.error = null;
      this.checkedAt = Date.now();
    } catch (e) {
      this.error = `팩 확인 실패: ${e.name === 'TimeoutError' ? '시간 초과' : e.message}`;
    } finally {
      this.checking = false;
      this.emit('change');
    }
    return this.status();
  }

  // Download the newest pack, verify every file, switch to it. No restart.
  async apply() {
    if (this.applying) throw new Error('이미 적용 중이에요');
    await this.check();
    const s = this.status();
    if (s.needsAllmind) throw new Error(`이 팩은 Allmind ${s.needsAllmind} 이상이 필요해요 — 방송이 끝난 뒤 Allmind를 업데이트해 주세요`);
    if (!s.available) throw new Error('새 팩이 없어요');
    const m = this.remote;
    this.applying = true;
    this.emit('change');
    const tmp = path.join(this.dir, `.${m.version}.tmp`);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      for (const [name, sha] of Object.entries(m.files)) {
        if (!SAFE.test(name) || name === 'manifest.json') continue;
        const buf = await this._get(name, 'buf');
        if (crypto.createHash('sha256').update(buf).digest('hex') !== String(sha).toLowerCase()) throw new Error(`${name} 파일 검증 실패 — 다시 시도해 주세요`);
        fs.writeFileSync(path.join(tmp, name), buf);
      }
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(m, null, 2));
      const dest = path.join(this.dir, m.version);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      this._activate(m.version);
      this._prune();
      console.log(`[xylem] pack ${m.version} applied`);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      this.error = e.message;
      throw e;
    } finally {
      this.applying = false;
      this.emit('change');
    }
    return this.status();
  }

  // Back to a downloaded version, or null = the built-in pack.
  use(version) {
    if (version && !this.downloaded().includes(version)) throw new Error('그 버전이 없어요');
    this._activate(version || null);
    console.log(`[xylem] using pack ${version || `built-in ${this.builtin.version}`}`);
    return this.status();
  }

  _activate(v) {
    this.st.active = v;
    saveState('xylem', this.st);
    for (const ch of this.channels) ch.send('reload', { version: this.version() });
    this.emit('change');
  }

  _prune() {
    const keep = new Set(this.downloaded().slice(0, KEEP));
    if (this.st.active) keep.add(this.st.active);
    for (const v of this.downloaded()) if (!keep.has(v)) fs.rmSync(path.join(this.dir, v), { recursive: true, force: true });
  }

  channel(getHello = () => []) {
    const ch = new Channel(() => [['hello', { pack: this.version() }], ...getHello()]);
    this.channels.add(ch);
    return ch;
  }
}
