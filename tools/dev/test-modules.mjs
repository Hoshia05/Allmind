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
