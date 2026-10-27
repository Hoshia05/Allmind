// Builds the Allmind Stream Deck plugin: streamdeck/src/plugin.js → bundled bin/plugin.js (with `ws`),
// then packs streamdeck/com.hoshia.allmind.sdPlugin with Elgato's CLI (validates the manifest) into
// public/streamdeck/Allmind.streamDeckPlugin — which the exe carries and the settings window installs.
//
//   node tools/build-streamdeck.mjs            (version from the manifest)
//   node tools/build-streamdeck.mjs --bump     (raise the patch number first)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN = path.join(ROOT, 'streamdeck', 'com.hoshia.allmind.sdPlugin');
const OUT = path.join(ROOT, 'public', 'streamdeck');
const manifestPath = path.join(PLUGIN, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (process.argv.includes('--bump')) {
  const v = manifest.Version.split('.').map(Number);
  v[2] += 1;
  manifest.Version = v.join('.');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

await esbuild.build({
  entryPoints: [path.join(ROOT, 'streamdeck', 'src', 'plugin.js')],
  outfile: path.join(PLUGIN, 'bin', 'plugin.js'),
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', minify: false, legalComments: 'none',
  // ws's optional native speedups
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

fs.writeFileSync(path.join(PLUGIN, 'bin', 'LICENSE-ws.txt'), fs.readFileSync(path.join(ROOT, 'node_modules', 'ws', 'LICENSE')));
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(ROOT, '.build-sd-'));
try {
  const cli = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'streamdeck.cmd' : 'streamdeck');
  execFileSync(cli, ['pack', PLUGIN, '-o', tmp, '-f', '--no-update-check'], { stdio: 'inherit' });
  const file = fs.readdirSync(tmp).find((f) => f.endsWith('.streamDeckPlugin'));
  if (!file) throw new Error('streamdeck pack made no file');
  fs.copyFileSync(path.join(tmp, file), path.join(OUT, 'Allmind.streamDeckPlugin'));
  fs.writeFileSync(path.join(OUT, 'version.txt'), manifest.Version + '\n');
  console.log(`Stream Deck plugin ${manifest.Version} → public/streamdeck/Allmind.streamDeckPlugin (${fs.statSync(path.join(OUT, 'Allmind.streamDeckPlugin')).size} bytes)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
