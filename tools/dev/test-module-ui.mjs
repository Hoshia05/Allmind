// Unit tests for M3's desktop gating (src/module-ui.js, docs/plans/modules.md M3). No mock needed:
//   node --test tools/dev/test-module-ui.mjs
// These test the DECISIONS only (which tray item, which window titles, which preflight hint). The tray icon and the
// taskbar tagging they feed (src/win.js, PowerShell) are untested on real Windows by this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleWindows, trayPlan, stampTitles, settingsPlace, vtsFixHint } from '../../src/module-ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const xylemManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/xylem/module.json'), 'utf8'));

test('standalone (no modules): no module tray item, taskbar tags only "Allmind", hint names no module page', () => {
  const windows = moduleWindows([]);
  assert.deepEqual(windows, []);
  assert.deepEqual(trayPlan({ desktop: true, windows }), { module: null });
  assert.equal(stampTitles({ desktop: true, windows }), 'Allmind');
  assert.equal(settingsPlace(windows, 'vts'), '');
  for (const remote of [true, false]) {
    const hint = vtsFixHint({ ready: false, remote, place: settingsPlace(windows, 'vts') });
    assert.ok(hint.length > 0);
    assert.doesNotMatch(hint, /Xylem|→/);
  }
});

test('with the real Xylem module.json: same tray item, window size, tag and preflight text as before M3', () => {
  const windows = moduleWindows([xylemManifest]);
  assert.equal(windows.length, 1);
  assert.deepEqual(trayPlan({ desktop: true, windows }), { module: { label: 'Xylem 열기 (룰렛·게임)', path: '/xylem', width: 1200, height: 900 } });
  assert.equal(stampTitles({ desktop: true, windows }), 'Allmind|Xylem'); // the string win.js hard-coded before M3
  const place = settingsPlace(windows, 'vts');
  assert.equal(place, 'Xylem → VTube Studio');
  // byte-identical to the pre-M3 strings in src/preflight.js
  assert.equal(vtsFixHint({ ready: false, remote: true, place }), 'VTube Studio가 켜져 있고 API가 켜져 있는지 확인 — VTube Studio가 이 PC에 있으면 주소를 127.0.0.1:8001로 (Xylem → VTube Studio), 안 쓰면 거기서 끄기');
  assert.equal(vtsFixHint({ ready: false, remote: false, place }), 'VTube Studio와 API가 켜져 있는지 확인 — 안 쓰면 Xylem → VTube Studio에서 끄기');
  assert.equal(vtsFixHint({ ready: true, remote: false, place }), '');
});

test('dev harness (ALLMIND_DEV=1) / not Windows: no tray and no taskbar tagging at all, with or without modules', () => {
  for (const windows of [[], moduleWindows([xylemManifest])]) {
    assert.equal(trayPlan({ desktop: false, windows }), null);
    assert.equal(stampTitles({ desktop: false, windows }), null);
  }
});

test('a module window must stay under its own path and have a sane title (no taking over Allmind\'s identity)', () => {
  const bad = [
    { id: 'evil', window: { path: '/', title: 'Evil' } }, // not its own path
    { id: 'evil', window: { path: '/xylem', title: 'Evil' } }, // another module's path
    { id: 'evil', window: { path: '/evilx', title: 'Evil' } }, // prefix trick
    { id: 'evil', window: { path: '/evil', title: 'Allmind' } }, // Allmind's own title
    { id: 'evil', window: { path: '/evil', title: 'A|B' } }, // the separator
    { id: 'evil', window: { path: '/evil', title: "x'; Remove-Item" } }, // quotes (PowerShell)
    { id: 'evil', window: { path: '/evil', title: '' } },
    { id: 'evil', window: 'nope' },
    { id: 'evil' },
  ];
  assert.deepEqual(moduleWindows(bad), []);
  const ok = moduleWindows([{ id: 'quiz', window: { path: '/quiz/play', title: 'Quiz', width: 99999 } }]);
  assert.deepEqual(ok, [{ id: 'quiz', path: '/quiz/play', title: 'Quiz', tray: '', width: 1200, height: 900, settings: [] }]);
  assert.deepEqual(trayPlan({ desktop: true, windows: ok }), { module: null }, 'no tray label → no tray item');
  assert.equal(stampTitles({ desktop: true, windows: ok }), 'Allmind|Quiz');
});
