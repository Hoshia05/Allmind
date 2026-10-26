// Refreshes public/xylem/manifest.json "files" (sha256 of every pack file) — run after editing the pack.
//   node tools/xylem-pack.mjs           update hashes
//   node tools/xylem-pack.mjs --bump    also raise the pack version (x.y.z → x.y.z+1): needed for a live patch
// Then push main. Allmind (Xylem page → 팩 확인 / 지금 적용) downloads it without restarting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'xylem');
const file = path.join(DIR, 'manifest.json');
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv.includes('--bump')) {
  const [a, b, c] = m.version.split('.').map(Number);
  m.version = `${a}.${b}.${c + 1}`;
}
m.files = {};
for (const f of fs.readdirSync(DIR).sort()) {
  if (f === 'manifest.json' || !fs.statSync(path.join(DIR, f)).isFile()) continue;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(f)) throw new Error(`pack file names must be simple: ${f}`);
  m.files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex');
}
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
console.log(`pack ${m.version}: ${Object.keys(m.files).length} files`);
