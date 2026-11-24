// Unit tests for the module contract (src/modules.js, M1 in docs/plans/modules.md). No mock needed:
//   node --test tools/dev/test-modules.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { API_LEVEL, discover, createRegistry } from '../../src/modules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tools/dev/fixtures/modules');

function fakePlatform() {
  const bus = new EventEmitter();
  const logs = [];
  return {
    bus,
    logs,
    platform: {
      config: { hello: { greeting: '안녕' }, secret: { token: 'x' } },
      dataDir: path.join(ROOT, '.dev', 'data'),
      events: { 'live-chat': (fn) => bus.on('live-chat', fn) },
      chatSend: async () => {},
      toast: () => {},
      log: (...a) => logs.push(a.join(' ')),
      services: {},
      reserved: (key) => key === 'POST /api/v1/scene' || key === 'GET /api/ping',
    },
  };
}

test('API level is 1', () => assert.equal(API_LEVEL, 1));

test('discover() reads module.json + index.js from each folder, sorted by id', async () => {
  const list = await discover(FIX);
  assert.deepEqual(list.map((m) => m.manifest.id), ['broken', 'future', 'greedy', 'hello']);
  assert.equal(typeof list[3].mod.register, 'function');
});

test('discover() of a missing folder is an empty list (the platform runs without modules)', async () => {
  assert.deepEqual(await discover(path.join(FIX, 'nope')), []);
});

test('an empty registry: no routes, no modules, nothing in the snapshot', async () => {
  const { platform } = fakePlatform();
  const reg = createRegistry(platform);
  await reg.load([]);
  assert.deepEqual(reg.info(), []);
  assert.equal(reg.route('GET', '/api/v1/m/hello/ping'), null);
  assert.deepEqual(reg.snapshot(), {});
});

test('good module loads; broken, future and greedy ones are skipped and logged, nothing of theirs stays', async () => {
  const { platform, bus, logs } = fakePlatform();
  const reg = createRegistry(platform);
  await reg.load(await discover(FIX));

  assert.deepEqual(reg.info().map((m) => m.id), ['hello']);
  const hello = reg.info()[0];
  assert.equal(hello.name, 'Hello (test)');
  assert.equal(hello.version, '1.0.0');
  assert.deepEqual(hello.commands, ['GET /api/v1/m/hello/ping']); // only its /api/v1/m/<id>/ routes are commands

  assert.deepEqual(reg.failed.map((f) => f.id).sort(), ['broken', 'future', 'greedy']);
  assert.match(reg.failed.find((f) => f.id === 'future').error, /API/);
  assert.match(reg.failed.find((f) => f.id === 'greedy').error, /\/api\/v1\/scene/);
  assert.equal(reg.route('GET', '/api/broken/half'), null, 'routes of a failed module are rolled back');
  assert.ok(logs.some((l) => l.includes('broken') && l.includes('boom')));

  // ctx.config is the module's own section only
  const r = reg.route('GET', '/api/v1/m/hello/ping');
  assert.equal(r.id, 'hello');
  assert.deepEqual(await r.handler({}), { pong: true, greeting: '안녕', seen: 0 });

  // events reach the module; snapshot reflects them
  bus.emit('live-chat', [{ text: 'a' }, { text: 'b' }]);
  assert.deepEqual(reg.snapshot(), { hello: { seen: 2 } });

  // pinFree and raw SSE routes
  assert.equal(reg.route('POST', '/api/hello/echo').pinFree, true);
  assert.equal(reg.route('GET', '/api/hello/events').raw, true);
  assert.deepEqual(reg.pinFreePaths(), ['/api/hello/echo']);
});

test('ctx refuses: platform paths, other modules\' /api/v1/m/ space, unknown events, duplicate snapshot keys', async () => {
  const { platform } = fakePlatform();
  const reg = createRegistry(platform);
  const tryReg = async (id, fn) => {
    await reg.load([{ manifest: { id, name: id, version: '1.0.0', minApi: 1 }, mod: { register: fn } }]);
    return reg.failed.find((f) => f.id === id)?.error || null;
  };
  assert.match(await tryReg('a', (ctx) => ctx.route('GET', '/api/ping', () => ({}))), /platform/);
  assert.match(await tryReg('b', (ctx) => ctx.route('GET', '/api/v1/m/other/x', () => ({}))), /\/api\/v1\/m\/b\//);
  assert.match(await tryReg('c', (ctx) => ctx.route('GET', '/api/v1/info2', () => ({}))), /\/api\/v1\/m\/c\//);
  assert.match(await tryReg('d', (ctx) => ctx.events.on('settings', () => {})), /event/);
  assert.match(await tryReg('e', (ctx) => ctx.route('PUT', '/api/e/x', () => ({}))), /method/);
  assert.equal(await tryReg('f', (ctx) => ctx.route('GET', '/api/f/x', () => ({}))), null);
  assert.match(await tryReg('g', (ctx) => ctx.route('GET', '/api/f/x', () => ({}))), /taken/);
  assert.match(await tryReg('f', () => {}), /already/); // same id twice
  assert.match(await tryReg('Bad Id', () => {}), /id/);
});

// ---------- M2 additions: what Xylem needs from ctx ----------
test('M2 ctx: state, assets, dataDir, version, stream event, report sections', async () => {
  const { platform, bus } = fakePlatform();
  const store = new Map([['roulette', { kept: true }]]);
  const sections = new Map();
  Object.assign(platform, {
    version: '9.9.9',
    state: { load: (n, fb) => (store.has(n) ? store.get(n) : fb), save: (n, v) => store.set(n, v) },
    assets: { read: (rel) => (rel === 'public/xylem/manifest.json' ? Buffer.from('{"version":"1.0.0"}') : null) },
    reportSection: (key, def) => sections.set(key, def),
  });
  platform.events.stream = (fn) => bus.on('stream', fn);
  const reg = createRegistry(platform);
  let seen = null;
  let streams = [];
  await reg.load([{ manifest: { id: 'x', name: 'x', version: '1', minApi: 1 }, mod: { register(ctx) {
    seen = {
      version: ctx.version,
      dataDir: ctx.dataDir,
      loaded: ctx.state.load('roulette', null),
      missing: ctx.state.load('nope', 'fb'),
      asset: ctx.assets.read('public/xylem/manifest.json')?.toString(),
    };
    ctx.state.save('dogfight', { a: 1 });
    ctx.events.on('stream', (active) => streams.push(active));
    ctx.reportSection('roulette', { build: () => ({ spins: 1 }), refresh: (s) => s });
  } } }]);
  assert.deepEqual(reg.failed, []);
  assert.deepEqual(seen, { version: '9.9.9', dataDir: platform.dataDir, loaded: { kept: true }, missing: 'fb', asset: '{"version":"1.0.0"}' });
  assert.deepEqual(store.get('dogfight'), { a: 1 }, 'saved under the same name as before the move');
  bus.emit('stream', true);
  assert.deepEqual(streams, [true]);
  assert.deepEqual([...sections.keys()], ['roulette']);
});

test('M2 ctx: prefix routes, pinPage, pinFree prefixes; exact routes win over prefixes', async () => {
  const { platform } = fakePlatform();
  const reg = createRegistry(platform);
  await reg.load([{ manifest: { id: 'x', name: 'x', version: '1', minApi: 1 }, mod: { register(ctx) {
    ctx.route('GET', '/xylem/', () => 'prefix', { prefix: true, raw: true });
    ctx.route('GET', '/xylem/index.html', () => 'exact', { pinPage: true, raw: true });
    ctx.route('GET', '/xylem', () => 'page', { pinPage: true, raw: true });
    ctx.route('GET', '/api/draw/tts/', () => 'wav', { prefix: true, raw: true, pinFree: true });
  } } }]);
  assert.deepEqual(reg.failed, []);
  assert.equal(reg.route('GET', '/xylem/roulette.panel.js').handler(), 'prefix');
  assert.equal(reg.route('GET', '/xylem/index.html').handler(), 'exact');
  assert.equal(reg.route('GET', '/xylem').handler(), 'page');
  assert.equal(reg.route('GET', '/xylemish'), null, 'a prefix ending in / never matches a sibling name');
  assert.equal(reg.route('GET', '/xylem/x').raw, true);
  assert.equal(reg.route('GET', '/api/draw/tts/0123456789abcdef.wav').handler(), 'wav');
  assert.deepEqual(reg.pinFreePrefixes(), ['/api/draw/tts/']);
  assert.deepEqual(reg.pinPagePaths().sort(), ['/xylem', '/xylem/index.html']);
  // a prefix may not cover platform space
  const reg2 = createRegistry(platform);
  await reg2.load([{ manifest: { id: 'y', name: 'y', version: '1', minApi: 1 }, mod: { register: (ctx) => ctx.route('GET', '/api/', () => '', { prefix: true, raw: true }) } }]);
  assert.match(reg2.failed[0].error, /prefix/);
});
