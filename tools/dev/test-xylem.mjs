// Unit tests for modules/xylem pieces that need no mock server (docs/plans/m2-xylem.md):
//   node --test tools/dev/test-xylem.mjs
// The rule tested here (docs/contracts/xylem.md): an assistant command never makes Xylem speak in chat as the streamer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setHost } from '../../modules/xylem/host.js';
import { ViewerDraw } from '../../modules/xylem/draw.js';

function setup({ notice = true } = {}) {
  const store = new Map([['draw', { settings: { notice, mode: 'keyword', keyword: '!참여', winners: 1 } }]]);
  setHost({ state: { load: (n, fb) => (store.has(n) ? store.get(n) : fb), save: (n, v) => store.set(n, v) }, assets: { read: () => null }, services: { tts: null }, dataDir: '.' });
  const sent = [];
  const chat = Object.assign(new EventEmitter(), { chat: [], users: new Map(), addExternal() {}, chatState: 'connected' });
  const sender = { configured: () => true, loggedIn: () => true, sendChat: async (t) => { sent.push(t); } };
  const pack = { channel: () => ({ size: 0, send() {}, attach() {} }) };
  const tts = { synth: async () => ({ id: '0'.repeat(16), ms: 1 }), real: false };
  const draw = new ViewerDraw(chat, pack, sender, tts);
  const join = (nick) => chat.emit('live-chat', [{ kind: 'chat', uid: `u-${nick}`, nick, text: '!참여', role: '' }]);
  return { draw, sent, join };
}

test('dashboard path unchanged: open() and the winners post chat notices when notices are on', async () => {
  const { draw, sent, join } = setup();
  draw.open(0);
  join('가'); join('나');
  draw.draw();
  draw.shown(draw.cur.id); // the overlay acknowledges the staging → winners
  assert.equal(draw.phase, 'winners');
  assert.equal(sent.length, 2, `expected entry + winners notices, got ${JSON.stringify(sent)}`);
  draw.reset();
});

test('assistant path: open(sec, {quiet}) and draw({quiet}) post no chat at all', async () => {
  const { draw, sent, join } = setup();
  draw.open(0, { quiet: true });
  join('가'); join('나');
  draw.draw({ quiet: true });
  draw.shown(draw.cur.id);
  assert.equal(draw.phase, 'winners');
  assert.deepEqual(sent, []);
  draw.reset();
});

test('quiet is per action: a dashboard redraw after an assistant draw speaks again; reset clears it', async () => {
  const { draw, sent, join } = setup();
  draw.open(0, { quiet: true });
  join('가'); join('나'); join('다');
  draw.draw({ quiet: true });
  draw.shown(draw.cur.id);
  assert.deepEqual(sent, []);
  draw.redraw(draw.winners[0].uid); // from the dashboard
  if (draw.cur) draw.shown(draw.cur.id);
  assert.equal(sent.length, 1, `redraw from the dashboard posts its notice, got ${JSON.stringify(sent)}`);
  draw.reset();
  draw.open(0); // dashboard
  assert.equal(sent.length, 2);
  draw.reset();
});
