// 화면 펫 (Screen Pets) — viewer-summoned roaming pets overlay (/pets, 1920x1080 transparent).
// Server only relays live chat events while an overlay is connected and enabled,
// manages settings (DATA_DIR/pets.json) and custom uploaded sprites (DATA_DIR/pet-sprites/).
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, DATA_DIR } from './host.js';

const BUILTIN = ['pet-wisp.png'];
const spritesDir = () => path.join(DATA_DIR, 'pet-sprites');
const MAX_SPRITES = 30;

export const DEFAULTS = {
  enabled: true,
  commandsEnabled: true,
  maxPets: 20,
  idleMinutes: 5,
  scale: 1,
  speed: 1,
  floorY: 16,
  showNames: true,
  showBubbles: true,
  bubbleSec: 5,
  disabledSprites: [],
};

const ACTION_CMDS = {
  '!점프': 'jump', '!jump': 'jump',
  '!대시': 'dash', '!dash': 'dash',
  '!춤': 'dance', '!dance': 'dance',
  '!자장': 'sleep', '!졸려': 'sleep', '!sleep': 'sleep',
};

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function cleanSettings(input, old = DEFAULTS) {
  const s = { ...old, ...(input || {}) };
  const disabled = Array.isArray(s.disabledSprites)
    ? [...new Set(s.disabledSprites.map((x) => path.basename(String(x || ''))).filter(Boolean))].slice(0, 50)
    : DEFAULTS.disabledSprites.slice();
  return {
    enabled: !!s.enabled,
    commandsEnabled: s.commandsEnabled !== false,
    maxPets: Math.round(num(s.maxPets, 1, 60, 20)),
    idleMinutes: Math.round(num(s.idleMinutes, 1, 60, 5)),
    scale: Math.round(num(s.scale, 0.4, 2.5, 1) * 100) / 100,
    speed: Math.round(num(s.speed, 0.4, 2.5, 1) * 100) / 100,
    floorY: Math.round(num(s.floorY, 0, 300, 16)),
    showNames: !!s.showNames,
    showBubbles: !!s.showBubbles,
    bubbleSec: Math.round(num(s.bubbleSec, 2, 15, 5)),
    disabledSprites: disabled,
  };
}

// Validates PNG, GIF, JPEG, or WebP and returns { type, w, h } (or null if unsupported).
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { type: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const mk = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { type: 'jpg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && buf.length > 30) return { type: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf.length > 25) {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    return { type: 'webp', w: 256, h: 256 };
  }
  return null;
}

export class ScreenPets {
  constructor(chzzk, pack) {
    this.pack = pack;
    const raw = loadState('pets', null);
    let st;
    try { st = cleanSettings(raw || DEFAULTS); } catch { st = cleanSettings(DEFAULTS); }
    this.s = st;
    this.choices = raw?.choices && typeof raw.choices === 'object' ? { ...raw.choices } : {};
    this.ch = pack.channel(() => [['settings', this.s], ['sprites', this.sprites()], ['choices', this.choices]]);

    chzzk.on('live-chat', (list) => {
      if (!this.ch.size || !this.s.enabled) return;
      for (const m of list) {
        if (m.hidden || m.kind !== 'chat') continue;
        this._handleChat({
          uid: String(m.uid || m.nick || ''),
          nick: String(m.nick || '시청자').slice(0, 24),
          role: m.role || '',
          text: String(m.text || '').slice(0, 120),
          sub: !!m.sub,
        });
      }
    });
  }

  _saveAll() {
    saveState('pets', { ...this.s, choices: this.choices });
  }

  _activeSprites() {
    const off = new Set(this.s.disabledSprites || []);
    const all = this.sprites();
    const active = all.filter((s) => !off.has(s.file));
    return active.length ? active : all;
  }

  _pickSpriteByQuery(q) {
    const list = this._activeSprites();
    if (!list.length) return null;
    const raw = String(q || '').trim().toLowerCase();
    if (!raw) return null;
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) return list[idx - 1].file;
    return list.find((s) => s.file.replace(/\.[^.]+$/, '').toLowerCase() === raw)?.file
      || list.find((s) => s.file.toLowerCase().includes(raw))?.file
      || null;
  }

  _handleChat({ uid, nick, role, text, sub }) {
    const trimmed = String(text || '').trim();
    let action = null;
    let hideBubble = false;

    if (this.s.commandsEnabled && trimmed.startsWith('!')) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      const low = cmd.toLowerCase();
      if (ACTION_CMDS[low]) {
        action = ACTION_CMDS[low];
        hideBubble = rest.length === 0;
      } else if ((low === '!캐릭터' || low === '!아바타') && rest.length) {
        const picked = this._pickSpriteByQuery(rest.join(' '));
        if (picked && uid) {
          this.choices[uid] = picked;
          // cap stored choices to prevent unbounded growth
          const keys = Object.keys(this.choices);
          if (keys.length > 2000) delete this.choices[keys[0]];
          this._saveAll();
          this.ch.send('choice', { uid, file: picked });
        }
        hideBubble = true;
      }
    }

    this.ch.send('chat', {
      uid, nick, role, sub,
      text: hideBubble ? '' : text,
      ...(action ? { action } : {}),
    });
  }

  get overlays() { return this.ch.size; }
  attach(req, res) { this.ch.attach(req, res); }

  status() {
    return {
      settings: this.s,
      sprites: this.sprites(),
      overlays: this.ch.size,
    };
  }

  setSettings(input) {
    this.s = cleanSettings(input, this.s);
    this._saveAll();
    this.ch.send('settings', this.s);
    return this.s;
  }

  clear() {
    this.ch.send('clear', { at: Date.now() });
  }

  testChat({ nick, text } = {}) {
    const n = String(nick || '테스트').trim().slice(0, 24) || '테스트';
    const t = String(text || '안녕!').trim().slice(0, 120) || '안녕!';
    this._handleChat({ uid: `test:${n}`, nick: n, role: '', text: t, sub: false });
  }

  sprites() {
    let own = [];
    try {
      own = fs.readdirSync(spritesDir()).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort();
    } catch {}
    const list = own.map((f) => ({
      file: f,
      builtin: false,
      size: fs.statSync(path.join(spritesDir(), f)).size,
      url: `/api/pets/sprite?file=${encodeURIComponent(f)}`,
    }));
    for (const f of BUILTIN) {
      list.push({
        file: f,
        builtin: true,
        size: this.pack.file(f)?.length || 0,
        url: `/api/pets/sprite?file=${encodeURIComponent(f)}`,
      });
    }
    return list;
  }

  addSprite(name, b64) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new Error('5 MB보다 작은 이미지만 돼요');
    const info = imageInfo(buf);
    if (!info) throw new Error('PNG, JPG, GIF, WebP 이미지만 돼요');
    if (info.w < 32 || info.h < 32 || info.w > 2048 || info.h > 2048) {
      throw new Error(`가로·세로 32~2048 픽셀이어야 해요 (이 이미지: ${info.w}×${info.h})`);
    }
    fs.mkdirSync(spritesDir(), { recursive: true });
    if (fs.readdirSync(spritesDir()).length >= MAX_SPRITES) throw new Error(`캐릭터는 ${MAX_SPRITES}개까지 올릴 수 있어요`);
    const base = String(name || 'pet').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 40) || 'pet';
    let file = `${base}.${info.type}`;
    for (let i = 2; fs.existsSync(path.join(spritesDir(), file)); i++) file = `${base} ${i}.${info.type}`;
    fs.writeFileSync(path.join(spritesDir(), file), buf);
    this.ch.send('sprites', this.sprites());
    return { file };
  }

  removeSprite(file) {
    const f = path.basename(String(file || ''));
    if (BUILTIN.includes(f)) throw new Error('기본 캐릭터는 지울 수 없어요');
    try { fs.unlinkSync(path.join(spritesDir(), f)); } catch { throw new Error('그 캐릭터가 없어요'); }
    if (this.s.disabledSprites.includes(f)) {
      this.s.disabledSprites = this.s.disabledSprites.filter((x) => x !== f);
      this._saveAll();
      this.ch.send('settings', this.s);
    }
    this.ch.send('sprites', this.sprites());
  }

  spriteFile(file) {
    const f = path.basename(String(file || ''));
    const own = path.join(spritesDir(), f);
    if (fs.existsSync(own)) return { buf: fs.readFileSync(own), ext: path.extname(f).toLowerCase() };
    if (BUILTIN.includes(f)) {
      const buf = this.pack.file(f);
      if (buf) return { buf, ext: path.extname(f).toLowerCase() };
    }
    return null;
  }
}
