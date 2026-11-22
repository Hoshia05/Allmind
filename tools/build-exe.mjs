// Builds dist/Allmind.exe: one file, no Node.js install needed.
//  1. bundle src/ into one CommonJS file (esbuild)
//  2. pack it + the web page into a Node "single executable application" blob
//  3. copy a Windows node.exe, give it our icon/name, inject the blob
//  4. flip the exe to the Windows GUI subsystem so no console window appears
//
// Usage: node tools/build-exe.mjs <path-to-windows-node.exe> [--linux] [--modules <dir> | --no-modules]
// The node.exe must be the SAME Node version as the one running this script.
// Modules (docs/plans/modules.md): every modules/<id>/ (module.json + index.js) is bundled through a static list that
// replaces src/modules-list.js, because a SEA can't import module files from disk. --modules <dir> bundles another
// folder (the SEA test uses tools/dev/fixtures/modules), --no-modules builds the platform alone.
// --runtime-modules (SEA test only) keeps the list null, i.e. the exe tries import() from disk like a source run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);
const nodeBin = argv[0];
const linux = argv.includes('--linux'); // test build for this machine
const mi = argv.indexOf('--modules');
const modulesDir = argv.includes('--no-modules') ? null : path.resolve(ROOT, mi >= 0 ? argv[mi + 1] || 'modules' : 'modules');
const runtimeModules = argv.includes('--runtime-modules');
if (!nodeBin || !fs.existsSync(nodeBin)) {
  console.error('Usage: node tools/build-exe.mjs <node.exe> [--linux] [--modules <dir> | --no-modules]');
  process.exit(1);
}
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 0. the build-time module list: modules/<id>/ folders with module.json + index.js, sorted by id
const moduleDirs = !modulesDir || !fs.existsSync(modulesDir) ? [] : fs.readdirSync(modulesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(modulesDir, e.name, 'module.json')) && fs.existsSync(path.join(modulesDir, e.name, 'index.js')))
  .map((e) => path.join(modulesDir, e.name))
  .sort();
const fwd = (p) => p.split(path.sep).join('/');
const moduleListSource = runtimeModules ? 'export default null;\n' : [
  ...moduleDirs.map((d, i) => `import * as m${i} from ${JSON.stringify(fwd(path.join(d, 'index.js')))};\nimport j${i} from ${JSON.stringify(fwd(path.join(d, 'module.json')))};`),
  `export default [${moduleDirs.map((_, i) => `{ manifest: j${i}, mod: m${i} }`).join(', ')}];`,
].join('\n') + '\n';
const moduleList = {
  name: 'allmind-module-list',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]modules-list\.js$/ }, () => ({ contents: moduleListSource, loader: 'js', resolveDir: ROOT }));
  },
};
console.log(`modules in the exe: ${runtimeModules ? '(runtime discovery — SEA test only)' : moduleDirs.map((d) => path.basename(d)).join(', ') || 'none'}`);

// 1. bundle
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(DIST, 'allmind.cjs'),
  // ws (VTube Studio client) tries these optional native speedups and falls back without them
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [moduleList],
  logLevel: 'warning',
});

// 2. SEA blob with the web page as assets
const assets = { 'config.example.json': path.join(ROOT, 'config.example.json') };
// every file under public/, subfolders included (public/xylem/ = the built-in Xylem pack)
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(r);
    else assets[r] = path.join(ROOT, r);
  }
};
walk('public');
const seaConfig = {
  main: path.join(DIST, 'allmind.cjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false, // code cache is platform-specific; we build Windows from elsewhere
  useSnapshot: false,
  assets,
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' });

const outExe = path.join(DIST, linux ? 'allmind-linux' : 'Allmind.exe');

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
      FileDescription: 'Allmind',
      ProductName: 'Allmind',
      InternalName: 'Allmind',
      OriginalFilename: 'Allmind.exe',
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

for (const f of ['allmind.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, f));
const mb = (fs.statSync(outExe).size / 1048576).toFixed(1);
console.log(`built ${path.relative(ROOT, outExe)} (${mb} MB)`);
