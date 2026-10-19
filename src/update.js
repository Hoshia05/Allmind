// In-app updater: looks for a newer GitHub release, and on request downloads
// Arkbird-X.Y.Z.exe and starts it in place of the running copy.
// Never installs on its own, and never while OBS is streaming or recording.
// See docs/plans/updater.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ASSET_RE = /^Arkbird-(\d+\.\d+\.\d+)\.exe$/;
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// 1 if a > b, -1 if a < b, 0 if equal. Accepts "v1.2.3"; ignores anything after the third number.
export function cmpVersion(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

export function updatesDir() {
  if (process.env.ARKBIRD_UPDATES_DIR) return process.env.ARKBIRD_UPDATES_DIR;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.arkbird'), 'Arkbird', 'updates');
}

export class Updater {
  // launch(file): start the downloaded exe and exit this process (provided by server.js)
  constructor({ config, version, obs, isExe, launch }) {
    this.cfg = config.update || {};
    this.version = version;
    this.obs = obs;
    this.isExe = isExe;
    this.launch = launch;
    this.asset = null; // { url, size, digest }
    this.s = {
      current: version, latest: null, available: false, name: '', notes: '', size: 0,
      checkedAt: 0, checking: false, error: null,
      phase: 'idle', // idle | downloading | installing | dry-ready | error
      progress: 0, dryRun: false,
    };
  }

  state() {
    return { ...this.s, enabled: this.cfg.check !== false };
  }

  start() {
    this.prune();
    if (this.cfg.check === false) return;
    const first = setTimeout(() => this.check().catch(() => {}), FIRST_CHECK_MS);
    const every = setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS);
    first.unref();
    every.unref();
  }

  async check() {
    if (this.s.checking || this.s.phase === 'downloading' || this.s.phase === 'installing') return this.state();
    this.s.checking = true;
    try {
      const base = (this.cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '');
      const res = await fetch(`${base}/repos/${this.cfg.repo}/releases/latest`, {
        headers: { 'User-Agent': `Arkbird/${this.version}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) {
        // no release yet
        this.s.latest = null;
        this.s.available = false;
        this.s.error = null;
      } else if (!res.ok) {
        throw new Error(`GitHub 응답 ${res.status}`);
      } else {
        const j = await res.json();
        const tag = String(j.tag_name || '');
        const asset = (j.assets || []).find((a) => ASSET_RE.exec(a.name)?.[1] === tag.replace(/^v/i, ''));
        this.s.latest = tag.replace(/^v/i, '') || null;
        this.s.name = String(j.name || tag);
        this.s.notes = String(j.body || '').slice(0, 4000);
        this.asset = asset ? { url: asset.browser_download_url, size: Number(asset.size) || 0, digest: String(asset.digest || '') } : null;
        this.s.size = this.asset?.size || 0;
        this.s.available = !!(this.asset && this.s.latest && cmpVersion(this.s.latest, this.version) > 0);
        this.s.error = null;
      }
      this.s.checkedAt = Date.now();
      console.log(`[update] checked: latest ${this.s.latest || '-'}, current ${this.version}, ${this.s.available ? 'update available' : 'up to date'}`);
    } catch (e) {
      this.s.error = e.name === 'TimeoutError' ? '시간 초과' : e.message;
      console.log(`[update] check failed: ${this.s.error}`);
    } finally {
      this.s.checking = false;
    }
    return this.state();
  }

  // Throws if OBS is (or might be) streaming/recording. One request each, only on install.
  async assertIdle() {
    if (!this.obs?.connected) return; // no OBS connection → nothing of ours is live
    let st, rec;
    try {
      [st, rec] = await Promise.all([this.obs.call('GetStreamStatus'), this.obs.call('GetRecordStatus')]);
    } catch {
      throw new Error('방송·녹화 상태를 확인하지 못해서 업데이트를 미뤘어요. 잠시 뒤 다시 눌러 주세요');
    }
    if (st?.outputActive || rec?.outputActive) throw new Error('방송 중이거나 녹화 중에는 업데이트할 수 없어요. 끝난 뒤에 눌러 주세요');
  }

  async install() {
    if (this.s.phase === 'downloading' || this.s.phase === 'installing') throw new Error('이미 진행 중이에요');
    if (!this.s.available || !this.asset) throw new Error('설치할 새 버전이 없어요');
    await this.assertIdle();

    const dry = !this.isExe || process.env.ARKBIRD_UPDATE_DRY === '1';
    const version = this.s.latest;
    const dir = updatesDir();
    const file = path.join(dir, `Arkbird-${version}.exe`);
    const part = `${file}.part`;
    this.s.phase = 'downloading';
    this.s.progress = 0;
    this.s.error = null;
    this.s.dryRun = dry;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await this.download(this.asset, part);
      fs.renameSync(part, file);
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch {}
      this.s.phase = 'error';
      this.s.error = e.message;
      console.log(`[update] download failed: ${e.message}`);
      throw e;
    }
    console.log(`[update] downloaded ${file}${dry ? ' (dry run, not starting it)' : ''}`);
    if (dry) {
      this.s.phase = 'dry-ready';
      return { dryRun: true, file };
    }
    this.s.phase = 'installing';
    setTimeout(() => this.launch(file), 400); // let the HTTP response out first
    return { restarting: true };
  }

  async download(asset, dest) {
    const res = await fetch(asset.url, {
      headers: { 'User-Agent': `Arkbird/${this.version}` },
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest);
    let got = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (head.length < 2) head = Buffer.concat([head, chunk]).subarray(0, 2);
        got += chunk.length;
        this.s.progress = total ? Math.min(1, got / total) : 0;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (asset.size && got !== asset.size) throw new Error(`파일 크기가 달라요 (${got} / ${asset.size} 바이트) — 다시 시도해 주세요`);
    if (head.toString('latin1') !== 'MZ') throw new Error('받은 파일이 실행 파일이 아니에요');
    const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
    if (m && hash.digest('hex') !== m[1].toLowerCase()) throw new Error('파일 검증(SHA-256)에 실패했어요 — 다시 시도해 주세요');
  }

  // Housekeeping: leftovers of earlier updates.
  prune() {
    const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch {} };
    try {
      for (const f of fs.readdirSync(updatesDir())) {
        const m = ASSET_RE.exec(f);
        if (f.endsWith('.part') || (m && cmpVersion(m[1], this.version) <= 0)) rm(path.join(updatesDir(), f));
      }
    } catch {}
    // Older unpacked copies next to the running one (…\Arkbird\app); locked ones just stay for next time.
    if (this.isExe) {
      const dir = path.dirname(process.execPath);
      if (path.basename(dir).toLowerCase() === 'app' && path.basename(path.dirname(dir)).toLowerCase() === 'arkbird') {
        try {
          for (const f of fs.readdirSync(dir)) {
            if (ASSET_RE.test(f) && f !== path.basename(process.execPath)) rm(path.join(dir, f));
          }
        } catch {}
      }
    }
  }
}
