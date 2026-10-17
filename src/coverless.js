// Cover art in music files reaches OBS as a one-frame video track. That shows
// the picture on screen and, worse, makes the Media Source's audio start late,
// so OBS keeps adding audio buffering (up to its 960 ms maximum).
//
// Before a song is loaded, this makes an audio-only copy of it in Stream
// Desk's data folder: the tag at the front is rewritten without the picture,
// and the audio after it is copied byte for byte (no re-encoding, no ffmpeg).
// The original file is never touched. Files without a picture, and formats we
// don't rewrite, are used as they are.
//   .mp3  — ID3v2 tag, APIC/PIC frames dropped
//   .flac — PICTURE metadata blocks dropped
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_CACHE_BYTES = 3 * 1024 ** 3; // keep at most ~3 GB of copies

export class Coverless {
  constructor(dir) {
    this.dir = dir;
    this.pending = new Map(); // src → promise, so two calls don't copy twice
  }

  // The file OBS should load for `src`: an art-free copy, or `src` itself.
  async fileFor(src) {
    const ext = path.extname(src).toLowerCase();
    if (ext !== '.mp3' && ext !== '.flac') return src;
    let st;
    try { st = await fsp.stat(src); } catch { return src; }
    const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    const out = path.join(this.dir, key + ext);
    try {
      const now = new Date();
      await fsp.utimes(out, now, now); // exists: mark as recently used
      return out;
    } catch {}
    if (this.pending.has(out)) return this.pending.get(out);
    const job = this._make(src, out, ext).finally(() => this.pending.delete(out));
    this.pending.set(out, job);
    return job;
  }

  async _make(src, out, ext) {
    let fh;
    try {
      fh = await fsp.open(src, 'r');
      const plan = ext === '.mp3' ? await planMp3(fh) : await planFlac(fh);
      if (!plan) return src; // no picture inside
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = out + '.tmp';
      await fsp.writeFile(tmp, plan.head);
      await new Promise((resolve, reject) => {
        const r = fs.createReadStream(src, { start: plan.copyFrom });
        const w = fs.createWriteStream(tmp, { flags: 'a' });
        r.on('error', reject); w.on('error', reject); w.on('finish', resolve);
        r.pipe(w);
      });
      await fsp.rename(tmp, out);
      console.log(`[bgm] removed cover art: ${path.basename(src)} (${plan.removed} picture${plan.removed > 1 ? 's' : ''})`);
      this._trim(out).catch(() => {});
      return out;
    } catch (e) {
      console.warn(`[bgm] couldn't make an art-free copy of ${path.basename(src)}: ${e.message} — playing the original`);
      return src;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  // Drop the least recently used copies once the cache is over its size cap.
  async _trim(keep) {
    const files = [];
    for (const f of await fsp.readdir(this.dir)) {
      const p = path.join(this.dir, f);
      if (f.endsWith('.tmp')) continue;
      try { const st = await fsp.stat(p); files.push({ p, size: st.size, used: st.mtimeMs }); } catch {}
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    files.sort((a, b) => a.used - b.used);
    for (const f of files) {
      if (total <= MAX_CACHE_BYTES) break;
      if (f.p === keep) continue;
      await fsp.rm(f.p, { force: true });
      total -= f.size;
    }
  }
}

async function read(fh, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}
const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
function toSynchsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

// ID3v2.2/2.3/2.4 at the start of an MP3. Returns { head, copyFrom, removed }
// or null when there's no picture (or a tag layout we'd rather not rewrite).
export async function planMp3(fh) {
  const h = await read(fh, 0, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
  const ver = h[3];
  const flags = h[5];
  if (ver < 2 || ver > 4) return null;
  if (flags & 0x80) return null; // whole-tag unsynchronisation: leave it alone
  const size = synchsafe(h, 6);
  const footer = ver === 4 && flags & 0x10 ? 10 : 0;
  const body = await read(fh, 10, size);
  if (body.length < size) return null;
  let p = 0;
  if (flags & 0x40) {
    // extended header: v2.3 size excludes its own 4 bytes, v2.4 is synchsafe and includes them
    p = ver === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
  }
  const ext = body.subarray(0, p);
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  const kept = [];
  let removed = 0;
  while (p + hdrLen <= body.length && body[p] !== 0) {
    const id = body.toString('latin1', p, p + idLen);
    const fsize = ver === 2 ? body.readUIntBE(p + 3, 3) : ver === 4 ? synchsafe(body, p + 4) : body.readUInt32BE(p + 4);
    const end = p + hdrLen + fsize;
    if (!/^[A-Z0-9]+$/.test(id) || end > body.length) break; // padding or junk: stop here
    if (id === 'APIC' || id === 'PIC') removed++;
    else kept.push(body.subarray(p, end));
    p = end;
  }
  if (!removed) return null;
  const frames = Buffer.concat([ext, ...kept]);
  const head = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, ver, h[4], flags & ~0x10]), toSynchsafe(frames.length), frames]);
  return { head, copyFrom: 10 + size + footer, removed };
}

// FLAC: "fLaC" then metadata blocks; type 6 is PICTURE.
export async function planFlac(fh) {
  const magic = await read(fh, 0, 4);
  if (magic.toString('latin1') !== 'fLaC') return null;
  let pos = 4;
  const kept = [];
  let removed = 0;
  for (;;) {
    const bh = await read(fh, pos, 4);
    if (bh.length < 4) return null;
    const last = !!(bh[0] & 0x80);
    const type = bh[0] & 0x7f;
    const len = bh.readUIntBE(1, 3);
    if (type === 6) removed++;
    else kept.push(Buffer.concat([bh, await read(fh, pos + 4, len)]));
    pos += 4 + len;
    if (last) break;
  }
  if (!removed) return null;
  kept.forEach((b, i) => { b[0] = (b[0] & 0x7f) | (i === kept.length - 1 ? 0x80 : 0); });
  return { head: Buffer.concat([magic, ...kept]), copyFrom: pos, removed };
}
