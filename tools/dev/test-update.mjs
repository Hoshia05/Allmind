import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Updater } from '../../src/update.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('Updater sends If-None-Match and reuses cached release on 304', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allmind-upd-'));
  const prevDir = process.env.ALLMIND_UPDATES_DIR;
  process.env.ALLMIND_UPDATES_DIR = tmp;
  let calls = 0;
  let sawIfNoneMatch = null;
  const { srv, url } = await startServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v0500"' });
      res.end(JSON.stringify({
        tag_name: 'v0.51.0',
        name: 'v0.51.0',
        body: 'notes',
        assets: [{ name: 'Allmind-0.51.0.exe', size: 1234, browser_download_url: `${url}/Allmind-0.51.0.exe` }],
      }));
      return;
    }
    sawIfNoneMatch = req.headers['if-none-match'];
    res.writeHead(304);
    res.end();
  });
  try {
    const u1 = new Updater({ config: { update: { repo: 'Hoshia05/Allmind', apiBase: url } }, version: '0.50.0', obs: null, isExe: false, launch: () => {} });
    const s1 = await u1.check();
    assert.equal(s1.available, true);
    assert.equal(s1.latest, '0.51.0');
    assert.equal(s1.error, null);

    // Fresh instance simulates app restart loading latest-cache.json
    const u2 = new Updater({ config: { update: { repo: 'Hoshia05/Allmind', apiBase: url } }, version: '0.50.0', obs: null, isExe: false, launch: () => {} });
    const s2 = await u2.check();
    assert.equal(sawIfNoneMatch, '"v0500"');
    assert.equal(s2.available, true);
    assert.equal(s2.latest, '0.51.0');
    assert.equal(s2.size, 1234);
    assert.equal(s2.error, null);
  } finally {
    srv.close();
    if (prevDir === undefined) delete process.env.ALLMIND_UPDATES_DIR; else process.env.ALLMIND_UPDATES_DIR = prevDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Updater falls back to github.com /releases/latest redirect on 403', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allmind-upd403-'));
  const prevDir = process.env.ALLMIND_UPDATES_DIR;
  process.env.ALLMIND_UPDATES_DIR = tmp;
  const { srv, url } = await startServer((req, res) => {
    if (req.url === '/repos/Hoshia05/Allmind/releases/latest') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
    } else if (req.url === '/Hoshia05/Allmind/releases/latest') {
      res.writeHead(302, { Location: `${url}/Hoshia05/Allmind/releases/tag/v0.51.0` });
      res.end();
    } else if (req.url === '/Hoshia05/Allmind/releases/tag/v0.51.0') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('ok');
    } else if (req.url === '/Hoshia05/Allmind/releases/download/v0.51.0/Allmind-0.51.0.exe') {
      res.writeHead(200, { 'Content-Length': '5678' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const u = new Updater({ config: { update: { repo: 'Hoshia05/Allmind', apiBase: url, webBase: url } }, version: '0.50.0', obs: null, isExe: false, launch: () => {} });
    const s = await u.check();
    assert.equal(s.available, true);
    assert.equal(s.latest, '0.51.0');
    assert.equal(s.size, 5678);
    assert.equal(s.error, null);
  } finally {
    srv.close();
    if (prevDir === undefined) delete process.env.ALLMIND_UPDATES_DIR; else process.env.ALLMIND_UPDATES_DIR = prevDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
