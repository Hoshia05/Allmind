// 던지기: chat (and optionally donations) throw things at the VTube Studio model (docs/plans/vts.md).
// An item flies in from a side edge, hits the head (injected head wobble, optional red flash, knock-back
// and hit hotkey), bounces off and is removed. The thrower's name is never shown (owner: no 네임드).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { loadState, saveState, readAsset, DATA_DIR } from './config.js';

const BUILTIN = ['cheese.png', 'heart.png', 'star.png'];
const ITEMS_DIR = path.join(DATA_DIR, 'vts-items');
const MAX_ITEMS = 30;
export const DEFAULTS = {
  enabled: true,
  commands: ['!던지기', '!던져'],
  cooldownSec: 20,       // per viewer (streamer/manager: none)
  maxInAir: 5,
  donation: { enabled: false, price: 1000, max: 10 },
  size: 0.14,            // VTS item size 0..1 (0.32 = VTS's default)
  shake: 60,             // head wobble 0..100
  flash: true,
  knockback: true,
  hitHotkey: '',         // VTS hotkey id fired on each hit ('' = none)
  aim: { dx: 0, dy: 0.25, set: false }, // head = model position + this
};

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function clean(input, old = DEFAULTS) {
  const s = { ...old, ...(input || {}) };
  const cmds = (Array.isArray(s.commands) ? s.commands : String(s.commands || '').split(/[,\s]+/))
    .map((c) => String(c).trim()).filter(Boolean).map((c) => (c.startsWith('!') ? c : `!${c}`)).slice(0, 8).map((c) => c.slice(0, 16));
  return {
    enabled: !!s.enabled,
    commands: cmds.length ? cmds : DEFAULTS.commands.slice(),
    cooldownSec: num(s.cooldownSec, 0, 600, 20),
    maxInAir: Math.round(num(s.maxInAir, 1, 15, 5)),
    donation: { enabled: !!s.donation?.enabled, price: Math.round(num(s.donation?.price, 100, 10_000_000, 1000)), max: Math.round(num(s.donation?.max, 1, 30, 10)) },
    size: num(s.size, 0.03, 0.6, 0.14),
    shake: num(s.shake, 0, 100, 60),
    flash: !!s.flash,
    knockback: !!s.knockback,
    hitHotkey: String(s.hitHotkey || '').slice(0, 64),
    aim: { dx: num(s.aim?.dx, -2, 2, 0), dy: num(s.aim?.dy, -2, 2, 0.25), set: !!s.aim?.set },
  };
}

// width/height of a PNG, GIF or JPEG (VTS wants 64–2048 px)
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
  return null;
}

const rnd = (a, b) => a + Math.random() * (b - a);

export class VTSThrow extends EventEmitter {
  constructor(vts, chzzk) {
    super();
    this.vts = vts;
    let st = loadState('vts-throw', null);
    try { st = clean(st || DEFAULTS); } catch { st = clean(DEFAULTS); }
    this.s = st;
    this.queue = [];
    this.inAir = 0;
    this.last = new Map();   // uid → time of their last throw
    this.timer = null;
    this.impulses = [];      // head wobbles being injected
    this.injectTimer = null;
    this.home = null;        // model position before a knock-back
    this.knockT = null;
    this.flashT = null;
    this.thrown = 0;
    this.error = null;
    this.aiming = null;      // { instanceID, timer }
    this.cache = new Map();  // file → { b64, name }
    vts.on('event', (type, data) => this._onEvent(type, data));
    vts.on('down', () => { this.inAir = 0; this.impulses = []; this.aiming = null; this.home = null; });
    chzzk.on('live-chat', (list) => {
      if (!this.s.enabled || !vts.ready) return;
      for (const m of list) {
        if (m.hidden) continue;
        if (m.kind === 'chat') {
          const t = String(m.text || '').trim().split(/\s+/)[0];
          if (this.s.commands.includes(t)) this.request({ uid: m.uid, role: m.role, source: 'chat' });
        } else if (m.kind === 'donation' && this.s.donation.enabled) {
          const n = Math.min(this.s.donation.max, Math.floor((Number(m.amount) || 0) / this.s.donation.price));
          for (let i = 0; i < n; i++) this.request({ source: 'donation', force: true });
        }
      }
    });
  }

  settings() { return this.s; }
  setSettings(input) {
    this.s = clean(input, this.s);
    saveState('vts-throw', this.s);
    this.emit('change');
    return this.s;
  }

  status() {
    return { settings: this.s, inAir: this.inAir, queued: this.queue.length, thrown: this.thrown, error: this.error, aiming: !!this.aiming, items: this.items().map(({ file, builtin, size }) => ({ file, builtin, size })) };
  }

  // ---------- items ----------
  items() {
    let own = [];
    try { own = fs.readdirSync(ITEMS_DIR).filter((f) => /\.(png|jpe?g|gif)$/i.test(f)).sort(); } catch {}
    if (own.length) return own.map((f) => ({ file: f, builtin: false, size: fs.statSync(path.join(ITEMS_DIR, f)).size }));
    return BUILTIN.map((f) => ({ file: f, builtin: true, size: readAsset(`public/vts-items/${f}`)?.length || 0 }));
  }
  itemData(name, builtin) {
    const key = `${builtin ? 'b' : 'u'}:${name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const buf = builtin ? readAsset(`public/vts-items/${name}`) : fs.readFileSync(path.join(ITEMS_DIR, name));
    if (!buf) throw new Error(`물건 파일이 없어요: ${name}`);
    // VTS remembers approved images by hash; the file name is only a label
    const v = { b64: buf.toString('base64'), name: `allmind_${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10)}${path.extname(name).toLowerCase() || '.png'}` };
    this.cache.set(key, v);
    return v;
  }
  // POST /api/vts/items {name, data: base64}
  addItem(name, b64) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new Error('5 MB보다 작은 이미지만 돼요');
    const info = imageInfo(buf);
    if (!info) throw new Error('PNG, JPG, GIF 이미지만 돼요');
    if (info.w < 64 || info.h < 64 || info.w > 2048 || info.h > 2048) throw new Error(`가로·세로 64~2048 픽셀이어야 해요 (이 이미지: ${info.w}×${info.h})`);
    fs.mkdirSync(ITEMS_DIR, { recursive: true });
    if (fs.readdirSync(ITEMS_DIR).length >= MAX_ITEMS) throw new Error(`물건은 ${MAX_ITEMS}개까지예요`);
    const base = String(name || 'item').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 40) || 'item';
    let file = `${base}.${info.type}`;
    for (let i = 2; fs.existsSync(path.join(ITEMS_DIR, file)); i++) file = `${base} ${i}.${info.type}`;
    fs.writeFileSync(path.join(ITEMS_DIR, file), buf);
    this.emit('change');
    return { file };
  }
  removeItem(file) {
    const f = path.basename(String(file || ''));
    try { fs.unlinkSync(path.join(ITEMS_DIR, f)); } catch { throw new Error('그 물건이 없어요'); }
    this.cache.delete(`u:${f}`);
    this.emit('change');
  }
  // GET /api/vts/item?file=… (thumbnails on the Xylem page)
  itemFile(file) {
    const f = path.basename(String(file || ''));
    const own = path.join(ITEMS_DIR, f);
    if (fs.existsSync(own)) return fs.readFileSync(own);
    return BUILTIN.includes(f) ? readAsset(`public/vts-items/${f}`) : null;
  }

  // ---------- queue ----------
  request({ uid = '', role = '', source = 'test', force = false, side } = {}) {
    if (!this.vts.ready) return { ok: false, reason: 'VTube Studio에 연결되어 있지 않아요' };
    if (!force && uid && role !== 'streamer' && role !== 'manager') {
      const t = this.last.get(uid) || 0;
      if (Date.now() - t < this.s.cooldownSec * 1000) return { ok: false, reason: 'cooldown' };
      this.last.set(uid, Date.now());
      if (this.last.size > 5000) this.last.clear();
    }
    if (this.queue.length >= 30) return { ok: false, reason: 'queue full' };
    this.queue.push({ source, side });
    this._drain();
    return { ok: true };
  }
  _drain() {
    if (this.timer) return;
    const step = () => {
      this.timer = null;
      if (!this.queue.length || !this.vts.ready) { this.queue.length = this.vts.ready ? this.queue.length : 0; return; }
      if (this.inAir < this.s.maxInAir) {
        const job = this.queue.shift();
        this.throwOne(job).catch((e) => { this.error = e.message; console.warn('[vts] throw failed:', e.message); this.emit('change'); });
      }
      if (this.queue.length) this.timer = setTimeout(step, 350);
    };
    this.timer = setTimeout(step, 0);
  }

  head(model) {
    const p = model?.position || { positionX: 0, positionY: 0 };
    return { x: p.positionX + this.s.aim.dx, y: p.positionY + this.s.aim.dy };
  }

  async throwOne({ side } = {}) {
    const vts = this.vts;
    const model = await vts.refreshModel();
    if (!model) throw new Error('VTube Studio에 모델이 없어요');
    if (!vts.canCustomItems) throw new Error('VTube Studio에서 이미지 불러오기 권한을 허용해 주세요');
    const list = this.items();
    const it = list[Math.floor(Math.random() * list.length)];
    const data = this.itemData(it.file, it.builtin);
    side = side === -1 || side === 1 ? side : Math.random() < 0.5 ? -1 : 1;
    const h = this.head(model);
    const tx = h.x + rnd(-0.04, 0.04), ty = h.y + rnd(-0.04, 0.04);
    const sx = side * 1.25, sy = Math.max(-0.7, Math.min(0.95, ty + rnd(-0.35, 0.45)));
    const r0 = rnd(-60, 60);
    this.inAir++;
    let id = null;
    try {
      const spots = (await vts.call('ItemList', { includeAvailableSpots: true, includeItemInstancesInScene: false, includeAvailableItemFiles: false })).availableSpots || [];
      const front = spots.filter((o) => o > 0);
      const order = front.length ? Math.max(...front) : spots.length ? Math.max(...spots) : undefined;
      const r = await vts.call('ItemLoad', {
        fileName: data.name, positionX: sx, positionY: sy, size: this.s.size, rotation: r0, fadeTime: 0,
        ...(order !== undefined ? { order } : {}), failIfOrderTaken: false, smoothing: 0, censored: false, flipped: false, locked: true,
        unloadWhenPluginDisconnects: true, customDataBase64: data.b64, customDataAskUserFirst: true, customDataSkipAskingUserIfWhitelisted: true, customDataAskTimer: -1,
      }, 60000); // the first time an image is used, VTS asks the owner (once)
      id = r.instanceID;
      const flight = 0.45;
      const r1 = r0 + side * 300;
      await vts.call('ItemMove', { itemsToMove: [{ itemInstanceID: id, timeInSeconds: flight, fadeMode: 'easeIn', positionX: tx, positionY: ty, rotation: r1, userCanStop: false }] });
      await sleep(flight * 1000);
      this.hit(side, model);
      await vts.call('ItemMove', { itemsToMove: [{ itemInstanceID: id, timeInSeconds: 0.8, fadeMode: 'easeIn', positionX: tx + side * rnd(0.35, 0.6), positionY: -1.4, rotation: Math.max(-360, Math.min(360, r1 + side * 120)), userCanStop: false }] });
      await sleep(850);
      this.thrown++;
      this.error = null;
    } finally {
      if (id) await vts.call('ItemUnload', { unloadAllInScene: false, unloadAllLoadedByThisPlugin: false, allowUnloadingItemsLoadedByUserOrOtherPlugins: false, instanceIDs: [id], fileNames: [] }).catch(() => {});
      this.inAir = Math.max(0, this.inAir - 1);
      this.emit('change');
    }
  }

  // ---------- the hit ----------
  hit(side, model) {
    const vts = this.vts;
    const A = (this.s.shake / 100) * 28; // degrees
    if (A > 0) { this.impulses.push({ t0: Date.now(), side, A }); this._inject(); }
    if (this.s.flash) {
      vts.call('ColorTint', { colorTint: { colorR: 255, colorG: 150, colorB: 150, colorA: 255, mixWithSceneLightingColor: 1 }, artMeshMatcher: { tintAll: true } }).catch(() => {});
      clearTimeout(this.flashT);
      this.flashT = setTimeout(() => vts.call('ColorTint', { colorTint: { colorR: 255, colorG: 255, colorB: 255, colorA: 255, mixWithSceneLightingColor: 1 }, artMeshMatcher: { tintAll: true } }).catch(() => {}), 160);
    }
    if (this.s.knockback && model?.position) {
      if (!this.home) this.home = { positionX: model.position.positionX, positionY: model.position.positionY };
      const home = this.home;
      vts.call('MoveModel', { timeInSeconds: 0.06, valuesAreRelativeToModel: false, positionX: home.positionX - side * 0.035, positionY: home.positionY + 0.01 }).catch(() => {});
      clearTimeout(this.knockT);
      this.knockT = setTimeout(() => {
        vts.call('MoveModel', { timeInSeconds: 0.35, valuesAreRelativeToModel: false, positionX: home.positionX, positionY: home.positionY }).catch(() => {});
        setTimeout(() => { if (this.home === home) this.home = null; }, 400);
      }, 90);
    }
    if (this.s.hitHotkey) vts.triggerHotkey(this.s.hitHotkey).catch(() => {});
  }

  // damped head wobble, summed over overlapping hits, sent at 30 Hz (VTS needs a value at least every second)
  _inject() {
    if (this.injectTimer) return;
    const tick = () => {
      const now = Date.now();
      this.impulses = this.impulses.filter((p) => now - p.t0 < 1000);
      let x = 0, y = 0, z = 0;
      for (const p of this.impulses) {
        const t = (now - p.t0) / 1000;
        const k = p.A * Math.exp(-t * 4.5) * Math.cos(t * 15);
        x += -p.side * k; z += p.side * k * 0.7; y += k * 0.35;
      }
      this.vts.call('InjectParameterData', { mode: 'add', parameterValues: [{ id: 'FaceAngleX', value: x }, { id: 'FaceAngleY', value: y }, { id: 'FaceAngleZ', value: z }] }).catch(() => {});
      if (this.impulses.length) this.injectTimer = setTimeout(tick, 33);
      else this.injectTimer = null;
    };
    tick();
  }

  // ---------- aim: the owner drags a marker onto the head in VTS ----------
  async startAim() {
    const vts = this.vts;
    if (this.aiming) return { already: true };
    const model = await vts.refreshModel();
    if (!model) throw new Error('VTube Studio에 모델이 없어요');
    if (!vts.canCustomItems) throw new Error('VTube Studio에서 이미지 불러오기 권한을 허용해 주세요');
    const buf = readAsset('public/vts-items/aim.png');
    const h = this.head(model);
    const r = await vts.call('ItemLoad', {
      fileName: 'allmind_aim.png', positionX: h.x, positionY: h.y, size: 0.12, rotation: 0, fadeTime: 0.2, failIfOrderTaken: false, locked: false,
      unloadWhenPluginDisconnects: true, customDataBase64: buf.toString('base64'), customDataAskUserFirst: true, customDataSkipAskingUserIfWhitelisted: true, customDataAskTimer: -1,
    }, 60000);
    const id = r.instanceID;
    await vts.call('EventSubscription', { eventName: 'ItemEvent', subscribe: true, config: { itemInstanceIDs: [id] } }).catch(() => {});
    this.aiming = { id, model, timer: setTimeout(() => this.stopAim(), 5 * 60000) };
    this.emit('change');
    return { started: true };
  }
  async stopAim() {
    const a = this.aiming;
    if (!a) return;
    this.aiming = null;
    clearTimeout(a.timer);
    await this.vts.call('ItemUnload', { unloadAllInScene: false, unloadAllLoadedByThisPlugin: false, allowUnloadingItemsLoadedByUserOrOtherPlugins: false, instanceIDs: [a.id], fileNames: [] }).catch(() => {});
    await this.vts.call('EventSubscription', { eventName: 'ItemEvent', subscribe: false, config: {} }).catch(() => {});
    this.emit('change');
  }
  async _onEvent(type, d) {
    if (type !== 'ItemEvent' || !this.aiming || d.itemInstanceID !== this.aiming.id) return;
    if (d.itemEventType !== 'DroppedUnpinned' && d.itemEventType !== 'DroppedPinned') return;
    const model = (await this.vts.refreshModel().catch(() => null)) || this.aiming.model;
    const p = model.position || { positionX: 0, positionY: 0 };
    this.s = clean({ ...this.s, aim: { dx: d.itemPosition.x - p.positionX, dy: d.itemPosition.y - p.positionY, set: true } }, this.s);
    saveState('vts-throw', this.s);
    console.log(`[vts] aim set: ${this.s.aim.dx.toFixed(3)}, ${this.s.aim.dy.toFixed(3)}`);
    await this.stopAim();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
