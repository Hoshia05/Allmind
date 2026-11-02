// 텍스트 — on-screen text boxes controlled from the Xylem page (docs/plans/textbox.md).
// Each box is one OBS browser source: http://localhost:<port>/text?id=<id> (1920×1080, transparent).
// The text, every style property and the animations live here; overlays get the whole box on every change
// over SSE, so typing / dragging a slider shows on stream at once. Saved to DATA_DIR/textbox.json.
import { loadState, saveState } from './config.js';

export const MAX_BOXES = 12;
const RECENT = 12;

export const DEF_STYLE = {
  font: 'Noto Sans KR', size: 64, weight: 700, italic: false,
  color: '#ffffff', gradient: false, color2: '#2fd8c8',
  outlineWidth: 0, outlineColor: '#000000',
  shadow: 8, shadowColor: '#000000', shadowAlpha: 70,
  bgColor: '#000000', bgAlpha: 0, padX: 24, padY: 12, radius: 12,
  borderWidth: 0, borderColor: '#ffffff',
  align: 'center', letterSpacing: 0, lineHeight: 1.25, maxWidth: 1600,
  anchor: 'bc', offsetX: 0, offsetY: 80,
};
export const DEF_ANIM = { in: 'fade', loop: 'none', change: 'fade', speed: 1 };

const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const IN = ['none', 'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'pop', 'zoom', 'blur', 'typewriter'];
const LOOP = ['none', 'float', 'pulse', 'shake', 'wiggle', 'glow', 'rainbow', 'blink', 'marquee'];
const CHANGE = ['none', 'fade', 'pop', 'typewriter', 'slide-up'];

const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const color = (v, def) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : def);
const pick = (v, list, def) => (list.includes(v) ? v : def);
// a font family name goes into CSS: letters, digits, spaces, a few punctuation marks only
const font = (v, def) => { const s = String(v ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 60); return s || def; };

export function cleanStyle(s = {}, base = DEF_STYLE) {
  const b = { ...DEF_STYLE, ...base };
  const g = (k) => (k in s ? s[k] : b[k]);
  return {
    font: font(g('font'), DEF_STYLE.font),
    size: Math.round(num(g('size'), 8, 400, b.size)),
    weight: Math.round(num(g('weight'), 100, 900, b.weight) / 100) * 100,
    italic: !!g('italic'),
    color: color(g('color'), b.color),
    gradient: !!g('gradient'),
    color2: color(g('color2'), b.color2),
    outlineWidth: num(g('outlineWidth'), 0, 30, b.outlineWidth),
    outlineColor: color(g('outlineColor'), b.outlineColor),
    shadow: num(g('shadow'), 0, 60, b.shadow),
    shadowColor: color(g('shadowColor'), b.shadowColor),
    shadowAlpha: num(g('shadowAlpha'), 0, 100, b.shadowAlpha),
    bgColor: color(g('bgColor'), b.bgColor),
    bgAlpha: num(g('bgAlpha'), 0, 100, b.bgAlpha),
    padX: num(g('padX'), 0, 200, b.padX),
    padY: num(g('padY'), 0, 200, b.padY),
    radius: num(g('radius'), 0, 200, b.radius),
    borderWidth: num(g('borderWidth'), 0, 30, b.borderWidth),
    borderColor: color(g('borderColor'), b.borderColor),
    align: pick(g('align'), ['left', 'center', 'right'], 'center'),
    letterSpacing: num(g('letterSpacing'), -10, 60, b.letterSpacing),
    lineHeight: num(g('lineHeight'), 0.7, 3, b.lineHeight),
    maxWidth: Math.round(num(g('maxWidth'), 100, 1920, b.maxWidth)),
    anchor: pick(g('anchor'), ANCHORS, 'bc'),
    offsetX: Math.round(num(g('offsetX'), -1920, 1920, b.offsetX)),
    offsetY: Math.round(num(g('offsetY'), -1080, 1080, b.offsetY)),
  };
}
export function cleanAnim(a = {}, base = DEF_ANIM) {
  const b = { ...DEF_ANIM, ...base };
  const g = (k) => (k in a ? a[k] : b[k]);
  return { in: pick(g('in'), IN, 'fade'), loop: pick(g('loop'), LOOP, 'none'), change: pick(g('change'), CHANGE, 'fade'), speed: num(g('speed'), 0.25, 4, 1) };
}
const cleanText = (t) => String(t ?? '').replace(/\r\n?/g, '\n').slice(0, 2000);

export class TextBoxes {
  constructor(pack) {
    const st = loadState('textbox', null) || {};
    this.boxes = (Array.isArray(st.boxes) ? st.boxes : []).slice(0, MAX_BOXES).map((b, i) => this._clean(b, String(i + 1)));
    if (!this.boxes.length) this.boxes.push(this._clean({ id: '1', name: '텍스트 1', text: '', visible: true }));
    this.presets = (Array.isArray(st.presets) ? st.presets : []).slice(0, 30)
      .map((p) => ({ name: String(p.name || '').slice(0, 30), style: cleanStyle(p.style), anim: cleanAnim(p.anim) })).filter((p) => p.name);
    this.ch = pack.channel(() => [['boxes', this.boxes]]); // OBS overlays
    this.pv = pack.channel(() => [['boxes', this.boxes]]); // previews on the Xylem page (not counted as overlays)
    this.saveT = null;
  }

  _clean(b, id) {
    return {
      id: String(b.id || id).replace(/[^\w-]/g, '').slice(0, 16) || id,
      name: String(b.name || `텍스트 ${id}`).slice(0, 30),
      text: cleanText(b.text),
      visible: b.visible !== false,
      style: cleanStyle(b.style),
      anim: cleanAnim(b.anim),
      recent: (Array.isArray(b.recent) ? b.recent : []).map(cleanText).filter(Boolean).slice(0, RECENT),
      rev: Number(b.rev) || 0,
    };
  }

  _save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => saveState('textbox', { boxes: this.boxes, presets: this.presets }), 800);
  }
  _push(box) {
    for (const c of [this.ch, this.pv]) c.send('box', box);
    this._save();
  }
  _get(id) {
    const b = this.boxes.find((x) => x.id === String(id));
    if (!b) throw new Error('그 텍스트 상자가 없어요');
    return b;
  }

  status() { return { boxes: this.boxes, presets: this.presets, overlays: this.ch.size }; }

  // patch: { text?, visible?, name?, style?: {…partial}, anim?: {…partial}, remember? }
  set(id, patch = {}) {
    const b = this._get(id);
    if ('text' in patch) {
      const t = cleanText(patch.text);
      if (t !== b.text) { b.text = t; b.rev++; }
      if (patch.remember && t.trim()) b.recent = [t, ...b.recent.filter((r) => r !== t)].slice(0, RECENT);
    }
    if ('visible' in patch) b.visible = !!patch.visible;
    if ('name' in patch) b.name = String(patch.name || b.name).slice(0, 30);
    if (patch.style) b.style = cleanStyle(patch.style, b.style);
    if (patch.anim) b.anim = cleanAnim(patch.anim, b.anim);
    this._push(b);
    return b;
  }

  forget(id, text) {
    const b = this._get(id);
    b.recent = b.recent.filter((r) => r !== text);
    this._save();
    return b;
  }

  add(copyFrom) {
    if (this.boxes.length >= MAX_BOXES) throw new Error(`텍스트 상자는 ${MAX_BOXES}개까지예요`);
    let n = 1;
    while (this.boxes.some((x) => x.id === String(n))) n++;
    const src = copyFrom ? this.boxes.find((x) => x.id === String(copyFrom)) : null;
    const b = this._clean({ id: String(n), name: `텍스트 ${n}`, text: '', visible: true, style: src?.style, anim: src?.anim });
    this.boxes.push(b);
    this._push(b);
    return b;
  }

  remove(id) {
    if (this.boxes.length <= 1) throw new Error('마지막 상자는 지울 수 없어요');
    const b = this._get(id);
    this.boxes = this.boxes.filter((x) => x !== b);
    for (const c of [this.ch, this.pv]) c.send('removed', { id: b.id });
    this._save();
    return { removed: b.id };
  }

  savePreset(name, id) {
    name = String(name || '').trim().slice(0, 30);
    if (!name) throw new Error('스타일 이름을 써 주세요');
    const b = this._get(id);
    this.presets = [{ name, style: { ...b.style }, anim: { ...b.anim } }, ...this.presets.filter((p) => p.name !== name)].slice(0, 30);
    this._save();
    return { presets: this.presets };
  }
  deletePreset(name) {
    this.presets = this.presets.filter((p) => p.name !== String(name));
    this._save();
    return { presets: this.presets };
  }

  attach(req, res, preview) { (preview ? this.pv : this.ch).attach(req, res); }
}
