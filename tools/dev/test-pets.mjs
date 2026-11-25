import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setHost } from '../../modules/xylem/host.js';
import { ScreenPets, cleanSettings, imageInfo, DEFAULTS } from '../../modules/xylem/pets.js';

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allmind-pets-test-'));
  const store = {};
  const chzzk = new EventEmitter();
  setHost({
    dataDir: dir,
    services: { tts: {}, vts: {}, chat: chzzk },
    state: {
      load: (k, def) => (k in store ? store[k] : def),
      save: (k, v) => { store[k] = v; },
    },
  });
  const sent = [];
  const channel = {
    size: 0,
    send: (ev, data) => sent.push({ ev, data }),
    attach: () => {},
  };
  const pack = {
    channel: () => channel,
    file: (name) => (name === 'pet-wisp.png' ? Buffer.from('PNG') : null),
  };
  return { dir, store, chzzk, sent, channel, pack };
}

test('cleanSettings clamps values and preserves defaults', () => {
  const s = cleanSettings({ maxPets: 999, idleMinutes: 0, scale: 10, speed: 0.1, floorY: -5, bubbleSec: 99, enabled: false, showNames: false });
  assert.equal(s.enabled, false);
  assert.equal(s.maxPets, 60);
  assert.equal(s.idleMinutes, 1);
  assert.equal(s.scale, 2.5);
  assert.equal(s.speed, 0.4);
  assert.equal(s.floorY, 0);
  assert.equal(s.bubbleSec, 15);
  assert.equal(s.showNames, false);
  assert.deepEqual(cleanSettings(), DEFAULTS);
});

test('imageInfo parses PNG header', () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(128, 16);
  png.writeUInt32BE(128, 20);
  assert.deepEqual(imageInfo(png), { type: 'png', w: 128, h: 128 });
  assert.equal(imageInfo(Buffer.from('not an image')), null);
});

test('ScreenPets relays chat only when overlay connected and enabled, and manages sprites', () => {
  const { dir, chzzk, sent, channel, pack } = makeEnv();
  try {
    const pets = new ScreenPets(chzzk, pack);
    // No overlay connected -> nothing sent
    chzzk.emit('live-chat', [{ kind: 'chat', uid: 'u1', nick: '뷰어', text: '안녕' }]);
    assert.equal(sent.length, 0);

    // Overlay connected -> chat relayed, hidden ignored, donation/sub celebrated
    channel.size = 1;
    chzzk.emit('live-chat', [
      { kind: 'chat', uid: 'u1', nick: '뷰어', text: '안녕' },
      { kind: 'chat', uid: 'u2', nick: '숨김', text: 'x', hidden: true },
      { kind: 'donation', uid: 'u3', nick: '후원', amount: 1000 },
      { kind: 'subscription', uid: 'u4', nick: '구독자', sub: { months: 3, tier: 1 } },
    ]);
    assert.equal(sent.length, 3);
    assert.equal(sent[0].ev, 'chat');
    assert.equal(sent[0].data.nick, '뷰어');
    assert.equal(sent[1].ev, 'celebrate');
    assert.equal(sent[1].data.kind, 'donation');
    assert.equal(sent[2].ev, 'celebrate');
    assert.equal(sent[2].data.kind, 'subscription');

    // Group action
    pets.groupAction('gather');
    assert.equal(sent.at(-1).ev, 'group');
    assert.equal(sent.at(-1).data.action, 'gather');

    // Add + remove custom sprite
    const png = Buffer.alloc(32);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(64, 20);
    const added = pets.addSprite('fan.png', png.toString('base64'));
    assert.equal(added.file, 'fan.png');
    assert.ok(pets.sprites().some((s) => s.file === 'fan.png' && !s.builtin));
    assert.ok(pets.spriteFile('fan.png'));

    // Action commands + avatar selection
    sent.length = 0;
    chzzk.emit('live-chat', [
      { kind: 'chat', uid: 'u1', nick: '뷰어', text: '!점프' },
      { kind: 'chat', uid: 'u1', nick: '뷰어', text: '!캐릭터 fan' },
    ]);
    assert.equal(sent[0].ev, 'chat');
    assert.equal(sent[0].data.action, 'jump');
    assert.equal(sent[0].data.text, '');
    const choiceEv = sent.find((x) => x.ev === 'choice');
    assert.deepEqual(choiceEv?.data, { uid: 'u1', file: 'fan.png' });
    assert.equal(pets.choices.u1, 'fan.png');

    // Disabling commands passes text as normal chat without action
    pets.setSettings({ commandsEnabled: false });
    sent.length = 0;
    chzzk.emit('live-chat', [{ kind: 'chat', uid: 'u1', nick: '뷰어', text: '!춤' }]);
    assert.equal(sent[0].data.action, undefined);
    assert.equal(sent[0].data.text, '!춤');

    pets.removeSprite('fan.png');
    assert.ok(!pets.sprites().some((s) => s.file === 'fan.png'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
