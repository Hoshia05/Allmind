#!/usr/bin/env node
// Remote-access modes against the mock (docs/plans/remote-access.md). Starts the mock with ALLMIND_SELF_LOOPBACK_ONLY=1, so this
// PC's own LAN address acts as another LAN device, then checks lan / tailscale and the Tailscale Serve/Funnel guard.
//   node tools/dev/test-remote.mjs            starts and stops the mock itself
// Needs an IPv4 LAN address on this PC. `off` isn't switched live here (it rebinds to 127.0.0.1 = a restart); the unit tests
// cover it. Leaves the mode at `lan` (the default). Mock only: no real Tailscale involved.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify } from '../../src/netmode.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass = true, detail = '') => { results.push(pass); console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && classify(i.address) === 'private')?.address;
if (!lanIp) { console.error('no private IPv4 address on this PC — cannot test'); process.exit(2); }

function req(method, p, { host = '127.0.0.1', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host, port: 8080, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const setMode = async (mode) => (await req('POST', '/api/launcher/remote-mode', { body: { mode } })).json;

const env = { ...process.env, ALLMIND_SELF_LOOPBACK_ONLY: '1' };
if (spawnSync('sh', ['tools/dev/up.sh'], { cwd: ROOT, stdio: 'inherit', env }).status !== 0) process.exit(2);
try {
  for (let i = 0; i < 40 && (await req('GET', '/api/ping')).status !== 200; i++) await sleep(250);
  const token = (await req('POST', '/api/launcher/api-token', { body: { renew: true } })).json?.token;
  const bearer = { authorization: `Bearer ${token}` };
  console.log(`LAN address under test: ${lanIp} (acts as a LAN device)`);

  // ---- lan ----
  let m = await setMode('lan');
  ok('switch to lan (no restart)', m?.ok && m.mode === 'lan' && !m.restarting, JSON.stringify({ mode: m?.mode, restarting: m?.restarting }));
  ok('lan: LAN device opens the dashboard', (await req('GET', '/', { host: lanIp })).status === 200);
  ok('lan: LAN device reaches the API', (await req('GET', '/api/ping', { host: lanIp })).status === 200);
  const v1lan = await req('GET', '/api/v1/info', { host: lanIp, headers: bearer });
  ok('lan: LAN device with token reaches /api/v1', v1lan.status === 200, `status ${v1lan.status}`);
  const view = (await req('GET', '/api/launcher/access')).json || {};
  ok('views keep lanAccess (= mode is not off)', view.lanAccess === true && view.remoteAccess === 'lan', `lanAccess ${view.lanAccess}, remoteAccess ${view.remoteAccess}`);
  ok('card gets labeled addresses', Array.isArray(view.addresses) && view.addresses.some((a) => a.kind === 'lan' && a.url.includes(lanIp)));

  // an open connection from the LAN device, closed when the mode stops allowing it
  let closed = false;
  const live = http.get({ host: lanIp, port: 8080, path: '/api/events' }, (res) => { res.on('data', () => {}); res.on('close', () => { closed = true; }); });
  live.on('error', () => { closed = true; });
  await sleep(800);
  ok('lan: LAN device keeps a live dashboard stream open', !closed);

  // ---- tailscale ----
  m = await setMode('tailscale');
  ok('switch to tailscale (no restart)', m?.ok && m.mode === 'tailscale' && !m.restarting);
  await sleep(500);
  ok('tailscale: the LAN device\'s open connection was closed', closed);
  const dash = await req('GET', '/', { host: lanIp });
  ok('tailscale: LAN device refused (plain 403)', dash.status === 403 && !dash.json, `status ${dash.status}`);
  const v1ts = await req('GET', '/api/v1/info', { host: lanIp, headers: bearer });
  ok('tailscale: LAN device on /api/v1 → 403 lan-off', v1ts.status === 403 && v1ts.json?.code === 'lan-off', `${v1ts.status} ${v1ts.json?.code}`);
  ok('tailscale: the stream PC itself (loopback) still works', (await req('GET', '/')).status === 200 && (await req('GET', '/api/v1/info', { headers: bearer })).status === 200);
  const tsView = (await req('GET', '/api/launcher/access')).json || {};
  ok('tailscale: card warns when no Tailscale address is found', tsView.tailscale?.ips?.length > 0 || tsView.warnings?.includes('no-tailscale'), JSON.stringify(tsView.warnings));

  // ---- Serve/Funnel guard: loopback + Tailscale proxy headers, refused in every mode we can switch to live ----
  for (const mode of ['tailscale', 'lan']) {
    await setMode(mode);
    for (const [h, v] of [['Tailscale-User-Login', 'someone@example.com'], ['Tailscale-User-Name', 'Someone'], ['Tailscale-Headers-Info', 'https://tailscale.com/s/serve-headers'],
      ['Tailscale-Funnel-Request', '?1'], ['X-Forwarded-For', '203.0.113.9'], ['X-Forwarded-Host', 'stream-pc.tail1234.ts.net']]) {
      const r1 = await req('GET', '/api/launcher', { headers: { [h]: v, host: 'stream-pc.tail1234.ts.net' } });
      const r2 = await req('GET', '/api/ping', { headers: { [h]: v } });
      ok(`${mode}: loopback + ${h} refused`, r1.status === 403 && r2.status === 403, `${r1.status}/${r2.status}`);
    }
    const v1p = await req('GET', '/api/v1/info', { headers: { ...bearer, 'X-Forwarded-For': '203.0.113.9' } });
    ok(`${mode}: loopback + proxy header on /api/v1 → 403 lan-off`, v1p.status === 403 && v1p.json?.code === 'lan-off', `${v1p.status} ${v1p.json?.code}`);
  }
  ok('a foreign *.ts.net Host from loopback (no proxy headers) is still refused by the Host check', (await req('GET', '/api/ping', { headers: { host: 'other-pc.tail9999.ts.net' } })).status === 403);
  const bad = await setMode('everyone');
  ok('unknown mode rejected', bad?.ok === false);
} finally {
  await setMode('lan');
  spawnSync('sh', ['tools/dev/down.sh'], { cwd: ROOT, stdio: 'inherit' });
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `\nremote access: ${failed} failed` : `\nremote access: all ${results.length} checks passed (mock only)`);
process.exit(failed ? 1 : 0);
