// "로그 보내기": one zip with Allmind's log, OBS's newest logs and a short info.txt, so the owner
// can send everything needed for debugging in one file. Never includes passwords or tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CAP = 5 * 1024 * 1024; // keep the last 5 MB of each file

// Minimal zip writer (deflate, UTF-8 names). Entries: [{ name, data: Buffer, mtime: Date }]
export function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = zlib.crc32(raw) >>> 0;
    const d = e.mtime || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function tail(file) {
  const st = fs.statSync(file);
  if (st.size <= CAP) return { data: fs.readFileSync(file), mtime: st.mtime };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CAP);
    fs.readSync(fd, buf, 0, CAP, st.size - CAP);
    return { data: Buffer.concat([Buffer.from(`(… only the last 5 MB of ${st.size} bytes …)\n`), buf]), mtime: st.mtime };
  } finally {
    fs.closeSync(fd);
  }
}

function newest(dir, n, re = /\.txt$/i) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, n)
      .map((x) => x.f);
  } catch {
    return [];
  }
}

// Strip anything secret from the settings before they go into info.txt.
const SECRET_KEY = /pass|secret|token|key|auth|cookie/i;
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      o[k] = SECRET_KEY.test(k) && x ? '(숨김)' : redact(x);
    }
    return o;
  }
  return v;
}

// Returns the path of the written zip.
export function writeLogBundle({ dataDir, outDir, info, obsDir }) {
  const entries = [];
  const add = (name, file) => {
    try { entries.push({ name, ...tail(file) }); } catch {}
  };
  add('allmind.log', path.join(dataDir, 'allmind.log'));
  add('allmind.log.old', path.join(dataDir, 'allmind.log.old'));
  for (const f of newest(path.join(obsDir, 'logs'), 3)) add(`obs-logs/${path.basename(f)}`, f);
  for (const f of newest(path.join(obsDir, 'crashes'), 1)) add(`obs-crashes/${path.basename(f)}`, f);
  entries.push({ name: 'info.txt', data: Buffer.from(info, 'utf8'), mtime: new Date() });

  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const name = `Allmind-로그-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.zip`;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, makeZip(entries));
  return { file, count: entries.length };
}

export function obsConfigDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'obs-studio');
}
