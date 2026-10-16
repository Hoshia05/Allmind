// Builds dist/StreamDesk.exe: one file, no Node.js install needed.
//  1. bundle src/ into one CommonJS file (esbuild)
//  2. pack it + the web page into a Node "single executable application" blob
//  3. copy a Windows node.exe, give it our icon/name, inject the blob
//  4. flip the exe to the Windows GUI subsystem so no console window appears
//
// Usage: node tools/build-exe.mjs <path-to-windows-node.exe> [--target linux <node-binary>]
// The node.exe must be the SAME Node version as the one running this script.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nodeBin = process.argv[2];
const linux = process.argv[3] === '--linux'; // test build for this machine
if (!nodeBin || !fs.existsSync(nodeBin)) {
  console.error('Usage: node tools/build-exe.mjs <node.exe> [--linux]');
  process.exit(1);
}
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. bundle
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(DIST, 'stream-desk.cjs'),
  logLevel: 'warning',
});

// 2. SEA blob with the web page as assets
const assets = { 'config.example.json': path.join(ROOT, 'config.example.json') };
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) assets[`public/${f}`] = path.join(ROOT, 'public', f);
const seaConfig = {
  main: path.join(DIST, 'stream-desk.cjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false, // code cache is platform-specific; we build Windows from elsewhere
  useSnapshot: false,
  assets,
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' });

const outExe = path.join(DIST, linux ? 'stream-desk-linux' : 'StreamDesk.exe');

// 3a. inject the app into a copy of node
fs.copyFileSync(nodeBin, outExe);
execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  outExe, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

if (linux) {
  fs.chmodSync(outExe, 0o755);
} else {
  // 3b. icon + version info. Done after injection (as pkg does) so the
  // injector parses the original node.exe; resedit keeps the injected blob.
  // This also drops node.exe's signature, which injection already broke.
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(outExe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  for (const lang of vi.getAllLanguagesForStringValues()) {
    vi.setStringValues(lang, {
      FileDescription: 'Stream Desk',
      ProductName: 'Stream Desk',
      InternalName: 'StreamDesk',
      OriginalFilename: 'StreamDesk.exe',
      CompanyName: 'Hoshia',
      LegalCopyright: '',
      FileVersion: pkg.version,
      ProductVersion: pkg.version,
    });
  }
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  const buf = Buffer.from(exe.generate());

  // 4. Windows GUI subsystem (2) instead of console (3): no black window.
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  buf.writeUInt16LE(2, pe + 24 + 68);
  fs.writeFileSync(outExe, buf);
}

for (const f of ['stream-desk.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, f));
const mb = (fs.statSync(outExe).size / 1048576).toFixed(1);
console.log(`built ${path.relative(ROOT, outExe)} (${mb} MB)`);
