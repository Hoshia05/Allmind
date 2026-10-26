// Automatic Drive upload of each recording + its markers file (docs/plans/google-archive.md).
//
// - Named "{date} - {title}" (Chzzk title that was up the longest), only on Drive: the local OBS
//   file keeps its name and is never moved or deleted.
// - Resumable upload in 16 MB chunks; the session URL + offset are saved, so a restart or a
//   network drop continues where it stopped.
// - Never uploads while OBS streams or records (pauses between chunks, continues afterwards).
// - The markers file goes up after its video, with recording.file set to the Drive name so
//   SkyEye pairs them.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState } from './config.js';
import { fetchRetry } from './google.js';
import { fillTemplate } from './youtube.js';

const CHUNK = 16 * 1024 * 1024; // multiple of 256 KiB, as Drive requires
const FOLDER_NAME = 'Allmind 녹화';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.flv': 'video/x-flv', '.ts': 'video/mp2t', '.json': 'application/json' };

// Windows-safe file name (editors and SkyEye download these)
export function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 150)
    .trim();
}

export class DriveUploader extends EventEmitter {
  // busy(): true while OBS streams or records
  constructor(google, config, { busy }) {
    super();
    this.g = google;
    this.config = config;
    this.busy = busy;
    const st = loadState('uploads', {});
    this.folderId = st.folderId || null;
    this.items = (st.items || []).map((i) => (i.status === 'uploading' ? { ...i, status: 'waiting' } : i));
    this.running = false;
    this.speed = 0;
    this.error = null;
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref?.();
    setTimeout(() => this.kick(), 5000).unref?.();
  }

  get cfg() { return this.config.drive || {}; }
  enabled() { return this.cfg.enabled !== false && this.g.has('drive'); }

  _save() { saveState('uploads', { folderId: this.folderId, items: this.items.slice(-100) }); }
  _changed() { this._save(); this.emit('change'); }

  status() {
    const busy = this.busy();
    return {
      enabled: this.cfg.enabled !== false,
      folderUrl: this.folderId ? `https://drive.google.com/drive/folders/${this.folderId}` : null,
      paused: busy && this.items.some((i) => i.status === 'waiting' || i.status === 'uploading'),
      error: this.error,
      speed: this.speed,
      items: this.items.slice(-20).reverse().map((i) => ({
        id: i.id, name: i.name, kind: i.kind, status: i.status, size: i.size, offset: i.offset || 0, error: i.error || null,
        url: i.driveId ? `https://drive.google.com/file/d/${i.driveId}/view` : null, at: i.at,
      })),
    };
  }

  // Called when a recording has finished (markers.js 'finished').
  // name: a file name typed in 방송 준비 (without extension); otherwise the template with the title
  add({ video, markersFile, startedAt, title, name }) {
    if (!this.enabled() || !video) return;
    let size = 0;
    try { size = fs.statSync(video).size; } catch { console.log(`[drive] video not found: ${video}`); return; }
    if (this.items.some((i) => i.local === video && i.kind === 'video')) return;
    const date = startedAt ? new Date(startedAt) : new Date();
    const ext = path.extname(video).toLowerCase();
    const t = safeName(title) || '녹화';
    let base = safeName(name || '') || safeName(fillTemplate(this.cfg.nameTemplate || '{date} - {title}', { date, title: t })) || safeName(path.parse(video).name);
    // same name already used (two recordings with the same title on one day) → " (2)"
    const taken = new Set(this.items.map((i) => i.base));
    if (taken.has(base)) { let n = 2; while (taken.has(`${base} (${n})`)) n++; base = `${base} (${n})`; }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.items.push({ id, kind: 'video', local: video, base, name: base + ext, size, mime: MIME[ext] || 'video/mp4', status: 'waiting', at: Date.now() });
    if (markersFile) this.items.push({ id: id + 'm', kind: 'markers', local: markersFile, base, name: `${base}.markers.json`, videoName: base + ext, status: 'waiting', at: Date.now(), after: id });
    console.log(`[drive] queued ${base + ext}${markersFile ? ' + markers' : ''}`);
    this._changed();
    this.emit('toast', { text: `☁️ 녹화가 끝나면 드라이브에 올려요: ${base + ext}` });
    this.kick();
  }

  rename(id, name) {
    const i = this.items.find((x) => x.id === id && x.kind === 'video');
    if (!i) throw new Error('업로드 항목을 찾을 수 없어요');
    if (i.status !== 'waiting' || i.session) throw new Error('이미 올리기 시작해서 이름을 바꿀 수 없어요');
    const base = safeName(String(name).replace(/\.(mp4|mkv|mov|flv|ts)$/i, ''));
    if (!base) throw new Error('이름이 비어 있어요');
    i.base = base;
    i.name = base + path.extname(i.local).toLowerCase();
    const m = this.items.find((x) => x.after === id);
    if (m) { m.base = base; m.name = `${base}.markers.json`; m.videoName = i.name; }
    this._changed();
  }

  retry(id) {
    for (const i of this.items) if ((i.id === id || i.after === id) && i.status === 'error') { i.status = 'waiting'; i.error = null; }
    this._changed();
    this.kick();
  }

  remove(id) {
    this.items = this.items.filter((i) => !(i.id === id || i.after === id) || i.status === 'uploading');
    this._changed();
  }

  kick() {
    if (this.running || !this.enabled() || this.busy()) return;
    const next = this.items.find((i) => i.status === 'waiting' && (!i.after || this.items.find((v) => v.id === i.after)?.status === 'done' || !this.items.find((v) => v.id === i.after)));
    if (!next) return;
    this.running = true;
    this._upload(next)
      .catch((e) => {
        if (e.paused) return;
        next.status = 'error';
        next.error = e.message;
        console.log(`[drive] ${next.name} failed: ${e.message}`);
        this.emit('toast', { text: `☁️ 드라이브 업로드 실패: ${next.name} — ${e.message}`, bad: true });
      })
      .finally(() => {
        this.running = false;
        this.speed = 0;
        this._changed();
        setTimeout(() => this.kick(), 1000);
      });
  }

  async _folder() {
    if (this.folderId) {
      try {
        const f = await this.g.api('GET', `/drive/v3/files/${this.folderId}`, { query: { fields: 'id,trashed' } });
        if (f.id && !f.trashed) return this.folderId;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const f = await this.g.api('POST', '/drive/v3/files', { query: { fields: 'id' }, body: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' } });
    this.folderId = f.id;
    console.log(`[drive] created folder "${FOLDER_NAME}" ${f.id}`);
    this._save();
    return f.id;
  }

  get uploadBase() { return (this.g.cfg.uploadBase || `${this.g.apiBase}/upload`).replace(/\/+$/, ''); }

  async _upload(i) {
    i.status = 'uploading';
    i.error = null;
    this._changed();
    const folder = await this._folder();
    let body = null; // markers: small, uploaded from memory with the Drive video name filled in
    if (i.kind === 'markers') {
      const j = JSON.parse(fs.readFileSync(i.local, 'utf8'));
      if (j.recording) j.recording.file = i.videoName;
      body = Buffer.from(JSON.stringify(j, null, 2));
      i.size = body.length;
      i.mime = 'application/json';
    } else {
      const now = fs.statSync(i.local).size;
      if (now !== i.size) { i.size = now; i.session = null; i.offset = 0; }
    }
    if (!i.session) {
      const res = await fetchRetry(`${this.uploadBase}/drive/v3/files?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.g.token('drive')}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': i.mime,
          'X-Upload-Content-Length': String(i.size),
        },
        body: JSON.stringify({ name: i.name, parents: [folder] }),
      });
      if (!res.ok) throw new Error(`업로드 시작 실패 (${res.status}) ${await res.text().catch(() => '')}`.trim().slice(0, 200));
      i.session = res.headers.get('location');
      i.offset = 0;
      this._save();
    } else {
      i.offset = await this._resumeOffset(i);
      if (i.offset >= i.size) return this._done(i);
    }
    const fd = body ? null : fs.openSync(i.local, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, i.size)));
      for (;;) {
        if (this.busy()) {
          i.status = 'waiting';
          throw Object.assign(new Error('paused'), { paused: true });
        }
        const len = Math.min(CHUNK, i.size - i.offset);
        let chunk;
        if (body) chunk = body.subarray(i.offset, i.offset + len);
        else { const n = fs.readSync(fd, buf, 0, len, i.offset); chunk = buf.subarray(0, n); }
        const started = Date.now();
        const res = await this._put(i, chunk);
        const took = Math.max(1, Date.now() - started);
        this.speed = Math.round((chunk.length * 8) / took / 1000); // Mbps
        await this._throttle(chunk.length, took);
        if (res.status === 200 || res.status === 201) {
          const j = await res.json().catch(() => ({}));
          if (j.id) i.driveId = j.id;
          return this._done(i);
        }
        if (res.status === 308) {
          const range = res.headers.get('range');
          i.offset = range ? Number(/-(\d+)/.exec(range)[1]) + 1 : 0;
          this._save();
          this.emit('change');
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          // session expired (they live about a week): start over
          i.session = null;
          i.offset = 0;
          throw new Error('업로드 세션이 만료돼서 처음부터 다시 올려야 해요 — 다시 시도를 눌러 주세요');
        }
        throw new Error(`업로드 오류 (${res.status})`);
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  _done(i) {
    i.status = 'done';
    i.offset = i.size;
    i.session = null;
    console.log(`[drive] uploaded ${i.name}`);
    if (i.kind === 'video') this.emit('toast', { text: `☁️ 드라이브에 올렸어요: ${i.name}` });
  }

  async _put(i, chunk) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(i.session, {
          method: 'PUT',
          redirect: 'manual',
          headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${i.offset}-${i.offset + chunk.length - 1}/${i.size}` },
          body: chunk,
          signal: AbortSignal.timeout(10 * 60 * 1000),
        });
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        if (attempt === 4) throw new Error(`네트워크 오류: ${e.message}`);
        await sleep(2000 * 2 ** attempt);
        // The server may have kept part (or all) of it: ask, and let the caller continue from there.
        const off = await this._resumeOffset(i);
        if (off >= i.size) return { status: 200, json: async () => ({}) };
        return { status: 308, headers: new Headers(off ? { range: `bytes=0-${off - 1}` } : {}) };
      }
    }
    throw new Error('업로드 실패');
  }

  async _resumeOffset(i) {
    const res = await fetchRetry(i.session, { method: 'PUT', redirect: 'manual', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${i.size}` } });
    if (res.status === 308) {
      const range = res.headers.get('range');
      return range ? Number(/-(\d+)/.exec(range)[1]) + 1 : 0;
    }
    if (res.status === 200 || res.status === 201) {
      // it had already finished (e.g. Allmind closed right after the last chunk)
      const j = await res.json().catch(() => ({}));
      if (j.id) i.driveId = j.id;
      return i.size;
    }
    if (res.status === 404 || res.status === 410) { i.session = null; throw new Error('업로드 세션이 만료됐어요 — 다시 시도를 누르면 처음부터 올려요'); }
    throw new Error(`업로드 상태 확인 실패 (${res.status})`);
  }

  async _throttle(bytes, took) {
    const mbps = Number(this.cfg.maxMbps) || 0;
    if (!mbps) return;
    const minMs = (bytes * 8) / (mbps * 1000);
    if (took < minMs) await sleep(minMs - took);
  }
}
