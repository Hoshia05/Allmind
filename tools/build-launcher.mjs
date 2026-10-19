// Wraps dist/Arkbird.exe into a small self-unpacking dist/Arkbird-<ver>.exe
// (about a quarter of the size). Needs: zig (pip install ziglang), xz, and a
// checkout of xz-embedded (public domain) at $XZ_EMBEDDED.
//   node tools/build-launcher.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const XZE = process.env.XZ_EMBEDDED;
if (!XZE || !fs.existsSync(path.join(XZE, 'linux/lib/xz/xz_dec_lzma2.c'))) {
  console.error('Set XZ_EMBEDDED to a checkout of https://github.com/tukaani-project/xz-embedded');
  process.exit(1);
}
const app = path.join(DIST, 'Arkbird.exe');
const work = path.join(DIST, 'launcher-build');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// 1. compress the app (x86 filter + LZMA2 max; crc32 is what the decoder checks)
console.log('compressing app…');
const xz = path.join(work, 'payload.xz');
execFileSync('sh', ['-c', `xz --format=xz --check=crc32 --x86 --lzma2=preset=9e,dict=64MiB -T1 -c "${app}" > "${xz}"`], { stdio: 'inherit' });

// 2. compile the launcher for Windows (GUI app, no console)
console.log('compiling launcher…');
const lib = path.join(XZE, 'linux/lib/xz');
const exe = path.join(work, 'launcher.exe');
execFileSync('python3', [
  '-m', 'ziglang', 'cc', '-target', 'x86_64-windows-gnu', '-Os', '-s', '-municode', '-Wl,--subsystem,windows',
  `-DSD_VERSION=L"${pkg.version}"`, '-DXZ_DEC_X86',
  '-include', path.join(XZE, 'userspace/xz_config.h'),
  '-I', path.join(XZE, 'linux/include/linux'), '-I', lib, '-I', path.join(XZE, 'userspace'),
  path.join(ROOT, 'tools/launcher/launcher.c'),
  path.join(lib, 'xz_crc32.c'), path.join(lib, 'xz_dec_lzma2.c'), path.join(lib, 'xz_dec_stream.c'), path.join(lib, 'xz_dec_bcj.c'),
  '-lshell32', '-o', exe,
], { stdio: 'inherit' });

// 3. icon + version info on the launcher
const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(pe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.createEmpty();
vi.lang = 1033;
const [a, b, c] = pkg.version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Arkbird', ProductName: 'Arkbird', InternalName: 'Arkbird',
  OriginalFilename: `Arkbird-${pkg.version}.exe`, CompanyName: 'Hoshia', FileVersion: pkg.version, ProductVersion: pkg.version,
});
vi.outputToResourceEntries(res.entries);
res.outputResource(pe);
const head = Buffer.from(pe.generate());

// 4. launcher + payload + trailer
const payload = fs.readFileSync(xz);
const trailer = Buffer.alloc(16);
trailer.writeBigUInt64LE(BigInt(payload.length), 0);
trailer.write('SDPAYLD1', 8, 'latin1');
const out = path.join(DIST, `Arkbird-${pkg.version}.exe`);
fs.writeFileSync(out, Buffer.concat([head, payload, trailer]));
fs.rmSync(work, { recursive: true, force: true });
console.log(`built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB; launcher ${(head.length / 1024).toFixed(0)} KB)`);
