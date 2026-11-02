// 할 일 — the streamer's own idea list (docs/plans/todo.md).
//   창고 (status 'idea'):   everything thought of — games, content, talk topics — added anytime, from any device
//   오늘 (status 'tonight'): picked for this stream; shown as a checklist, and as a reminder when the stream starts
//   한 것 (status 'done'):   checked-off items move here when the stream ends (with the day they were done)
// Checking an item off during a recording also drops a ⭐ mark labelled with it (for the editors / SkyEye).
// Unchecked 오늘 items simply stay in 오늘 for the next stream. Saved to DATA_DIR/todo.json.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { loadState, saveState } from './config.js';

export const TAGS = ['게임', '콘텐츠', '토크', '공지', '기타'];
const MAX_ITEMS = 1000;
const MAX_DONE = 300;

const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const cleanNote = (t) => String(t ?? '').replace(/\r\n?/g, '\n').slice(0, 1000);
const cleanTag = (t) => (TAGS.includes(t) ? t : '');

export class TodoList extends EventEmitter {
  constructor(markers) {
    super();
    this.markers = markers;
    const st = loadState('todo', null) || {};
    this.items = (Array.isArray(st.items) ? st.items : []).map((x) => this._clean(x)).filter((x) => x.title);
    this.saveT = null;
  }

  _clean(x) {
    return {
      id: String(x.id || crypto.randomBytes(5).toString('hex')).replace(/[^\w-]/g, '').slice(0, 24),
      title: cleanTitle(x.title),
      tag: cleanTag(x.tag),
      note: cleanNote(x.note),
      status: ['idea', 'tonight', 'done'].includes(x.status) ? x.status : 'idea',
      done: !!x.done,
      added: Number(x.added) || Date.now(),
      moved: Number(x.moved) || Number(x.added) || Date.now(), // when it last changed list (sorting)
      doneAt: Number(x.doneAt) || null,
      marked: !!x.marked,
    };
  }

  view() { return { items: this.items, tags: TAGS }; }

  _changed() {
    this.emit('change', this.view());
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => saveState('todo', { items: this.items }), 500);
  }
  _get(id) {
    const it = this.items.find((x) => x.id === String(id));
    if (!it) throw new Error('그 항목이 없어요 (다른 기기에서 지웠을 수 있어요)');
    return it;
  }

  add({ title, tag, note, tonight } = {}) {
    const t = cleanTitle(title);
    if (!t) throw new Error('내용을 써 주세요');
    if (this.items.filter((x) => x.status !== 'done').length >= MAX_ITEMS) throw new Error(`항목은 ${MAX_ITEMS}개까지예요`);
    const it = this._clean({ title: t, tag: cleanTag(tag), note, status: tonight ? 'tonight' : 'idea' });
    this.items.push(it);
    this._changed();
    return { item: it };
  }

  update(id, patch = {}) {
    const it = this._get(id);
    if ('title' in patch) { const t = cleanTitle(patch.title); if (t) it.title = t; }
    if ('tag' in patch) it.tag = cleanTag(patch.tag);
    if ('note' in patch) it.note = cleanNote(patch.note);
    if ('status' in patch && ['idea', 'tonight', 'done'].includes(patch.status) && patch.status !== it.status) {
      it.status = patch.status;
      it.moved = Date.now();
      if (patch.status !== 'done') { it.done = false; it.doneAt = null; it.marked = false; } // back from 한 것: a fresh start
    }
    this._changed();
    return { item: it };
  }

  remove(id) {
    const it = this._get(id);
    this.items = this.items.filter((x) => x !== it);
    this._changed();
    return { removed: it.id };
  }

  // check / uncheck an item in 오늘; checking it during a recording leaves a ⭐ mark named after it
  async check(id, done) {
    const it = this._get(id);
    it.done = !!done;
    it.doneAt = it.done ? Date.now() : null;
    let mark = null;
    if (it.done && !it.marked && this.markers) {
      const r = await this.markers.mark(`할 일: ${it.title}`).catch((e) => ({ ok: false, reason: e.message }));
      if (r?.ok) { it.marked = true; mark = r; }
    }
    this._changed();
    return { item: it, marked: !!mark };
  }

  // for the stream report: what got done during it, and what was planned but is still open
  summary(from, to) {
    const done = this.items.filter((x) => x.done && x.doneAt >= from && x.doneAt <= to).map((x) => x.title);
    const left = this.items.filter((x) => x.status === 'tonight' && !x.done).map((x) => x.title);
    return { done, left };
  }

  // stream ended: checked-off 오늘 items go to 한 것 (unchecked ones stay for next time)
  archive() {
    let n = 0;
    for (const x of this.items) if (x.status === 'tonight' && x.done) { x.status = 'done'; x.moved = Date.now(); n++; }
    const done = this.items.filter((x) => x.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    if (done.length > MAX_DONE) { const drop = new Set(done.slice(MAX_DONE)); this.items = this.items.filter((x) => !drop.has(x)); }
    if (n) { console.log(`[todo] ${n} done item(s) moved to 한 것`); this._changed(); }
  }

  // stream started: what to show as the reminder
  reminder() {
    const tonight = this.items.filter((x) => x.status === 'tonight' && !x.done);
    const ideas = this.items.filter((x) => x.status === 'idea').length;
    return { tonight, ideas };
  }
}
