#!/usr/bin/env node
// M5 exit test (docs/plans/modules.md): a client on 127.0.0.1 with the API token, like the assistant, against the mock.
// It must receive `chat`, `mark` and `deck-signal` (from the real Stream Deck plugin driven by a fake Stream Deck app),
// a call without the token must be refused, and the dashboard client count must stay 0 the whole time.
//
//   node tools/dev/v1-client.mjs            starts the mock (tools/dev/up.sh), runs, stops it
//   node tools/dev/v1-client.mjs --running  use a mock that is already up (leaves it running)
// Makes a NEW API token (like 새로 만들기), so a client configured with the old one must be updated afterwards. Mock only.
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_BIN = path.join(ROOT, 'streamdeck/com.hoshia.allmind.sdPlugin/bin/plugin.js');
const running = process.argv.includes('--running');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass = true, detail = '') => { results.push(pass); console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

function req(method, p, { body, headers = {}, port = 8080 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

if (!running && spawnSync('sh', ['tools/dev/up.sh'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) process.exit(2);
let child = null;
let wss = null;
let events = null;
try {
  for (let i = 0; i < 40 && (await req('GET', '/api/ping').catch(() => ({}))).status !== 200; i++) await sleep(250);
  await sleep(1500);
  const token = (await req('POST', '/api/launcher/api-token', { body: { renew: true } })).json?.token;
  if (!token) throw new Error('no API token from the settings route');
  const auth = { authorization: `Bearer ${token}`, 'x-allmind-client': 'v1-client-test/1' };
  const dashboards = async () => (await req('GET', '/api/launcher/api-token')).json?.dashboards;

  // refused without the token (also on loopback), on a command and on the event stream
  ok('no token → refused', (await req('POST', '/api/v1/mark', { body: {} })).status === 401 && (await req('GET', '/api/v1/events')).status === 401);

  // the event stream
  const got = [];
  const waitFor = (pred, ms = 6000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const hit = got.find(pred); if (hit) return resolve(hit); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 50); };
    tick();
  });
  events = http.get({ host: '127.0.0.1', port: 8080, path: '/api/v1/events', headers: auth }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, i); buf = buf.slice(i + 2);
        const e = (blk.match(/^event: (.*)$/m) || [])[1];
        const d = (blk.match(/^data: (.*)$/m) || [])[1];
        if (e) got.push({ e, d: JSON.parse(d) });
      }
    });
  });
  await waitFor((x) => x.e === 'hello').then(() => ok('hello'), () => ok('hello', false, `got: ${got.map((x) => x.e).join(',') || 'nothing'}`));
  ok('dashboard clients stay 0 with the stream open', (await dashboards()) === 0);

  // chat from the mock Chzzk
  const tag = `client-${Date.now()}`;
  await req('POST', '/mock/chat', { body: { nick: '테스트시청자', text: tag }, port: 9333 });
  await waitFor((x) => x.e === 'chat' && x.d.text === tag).then((x) => ok('chat', x.d.platform === 'chzzk', `platform ${x.d.platform}`), () => ok('chat', false));

  // mark (needs a recording on the mock OBS)
  spawnSync(process.execPath, [path.join(ROOT, 'tools/dev/obs.mjs'), 'StartRecord'], { cwd: ROOT });
  let m = null;
  for (let i = 0; i < 20 && m?.status !== 200; i++) { await sleep(250); m = await req('POST', '/api/v1/mark', { body: { label: 'client' }, headers: auth }); }
  await waitFor((x) => x.e === 'mark' && x.d.label === 'client').then((x) => ok('mark', x.d.part === 1 && typeof x.d.t === 'number', `part ${x.d.part}, t ${x.d.t}`), () => ok('mark', false));
  spawnSync(process.execPath, [path.join(ROOT, 'tools/dev/obs.mjs'), 'StopRecord'], { cwd: ROOT });

  // deck-signal: the real plugin (bundled like tools/build-streamdeck.mjs, without packing) under a fake Stream Deck app
  await esbuild.build({ entryPoints: [path.join(ROOT, 'streamdeck/src/plugin.js')], outfile: PLUGIN_BIN, bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['bufferutil', 'utf-8-validate'], logLevel: 'warning' });
  wss = new WebSocketServer({ port: 0 });
  const CTX = 'ctx-signal';
  const sd = new Promise((resolve) => wss.on('connection', resolve));
  child = spawn(process.execPath, [PLUGIN_BIN, '-port', String(wss.address().port), '-pluginUUID', 'test', '-registerEvent', 'registerPlugin', '-info', '{}'], { stdio: 'ignore' });
  const ws = await sd;
  const fromPlugin = [];
  ws.on('message', (raw) => {
    const x = JSON.parse(raw);
    fromPlugin.push(x.event);
    if (x.event === 'getGlobalSettings') ws.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: { host: '127.0.0.1:8080', key: '' } } }));
  });
  const key = (event, op) => ws.send(JSON.stringify({ event, action: 'com.hoshia.allmind.signal', context: CTX, payload: { settings: { op } } }));
  await sleep(400);
  key('willAppear', 'ptt');
  await sleep(1500);
  key('keyDown', 'ptt');
  await sleep(500);
  key('keyUp', 'ptt');
  const down = await waitFor((x) => x.e === 'deck-signal' && x.d.name === 'ptt' && x.d.state === 'down').catch(() => null);
  const up = await waitFor((x) => x.e === 'deck-signal' && x.d.name === 'ptt' && x.d.state === 'up').catch(() => null);
  ok('deck-signal ptt down/up from the plugin', !!(down && up), down && up ? `held ${up.d.at - down.d.at} ms` : '');
  ok('plugin showed no alert', !fromPlugin.includes('showAlert'));
  ok('dashboard clients still 0', (await dashboards()) === 0);
} catch (e) {
  ok('run', false, e.message);
} finally {
  try { child?.kill(); } catch {}
  try { wss?.close(); } catch {}
  try { events?.destroy(); } catch {}
  if (!running) spawnSync('sh', ['tools/dev/down.sh'], { cwd: ROOT, stdio: 'inherit' });
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\nv1 client: ${failed} failed` : `\nv1 client: all ${results.length} checks passed (mock only)`);
process.exit(failed ? 1 : 0);
