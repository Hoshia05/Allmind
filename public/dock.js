// Free layout, OBS-style: on wide landscape screens every panel lives in a
// column, in a "slot". Drag a panel by the ⠿ grip in its header (or an empty
// part of the header), or drag a tab:
//   • a panel's top/bottom edge   → above/below it, same column
//   • a panel's left/right edge   → a new column on that side
//   • the middle of a panel       → join it as a tab
// Drag the gaps between columns/slots to resize. The layout is saved in this
// browser only, so the PC and the iPad can each have their own. Narrow and
// portrait screens keep the fixed layouts (phone tabs etc.).
(() => {
  const layoutEl = document.getElementById('layout');
  const PANELS = {
    viewer: { el: document.querySelector('.viewer-panel'), title: '방송 화면', minH: 200 },
    chat: { el: document.getElementById('chatPanel'), title: '채팅', minH: 150 },
    music: { el: document.querySelector('.panel.music'), title: '음악', minH: 160 },
    sb: { el: document.getElementById('sbPanel'), title: '사운드보드', minH: 90 },
    alert: { el: document.querySelector('.alert-panel'), title: '알림 화면', minH: 100 },
  };
  const slot = (ids, h = 1) => ({ ids, active: ids[0], h });
  const DEFAULT = () => ({
    cols: [
      { w: null, slots: [slot(['viewer'])] },
      { w: 340, slots: [slot(['chat'])] },
      { w: 340, slots: [slot(['music'], 0.9), slot(['sb'], 0.85), slot(['alert'])] },
    ],
  });
  const KEY = 'sd.dock';
  const wide = matchMedia('(min-width: 1100px) and (min-height: 560px) and (orientation: landscape)');

  // where each panel sits in the fixed layout, to put it back when leaving
  const homeOrder = Object.keys(PANELS);
  const home = Object.fromEntries(homeOrder.map((id) => [id, { parent: PANELS[id].el.parentNode, next: PANELS[id].el.nextElementSibling }]));

  let model = load();
  let colEls = [];
  const slotEls = new Map(); // slot object → element
  let docked = false;

  function load() {
    try {
      const m = JSON.parse(localStorage.getItem(KEY));
      if (m?.cols?.length) {
        // layouts saved before tabs existed: one panel per slot
        for (const c of m.cols) if (!c.slots && c.panels) c.slots = c.panels.map((p) => slot([p.id], p.h));
        if (m.cols.every((c) => Array.isArray(c.slots))) return m;
      }
    } catch {}
    return DEFAULT();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ cols: model.cols.map((c) => ({ w: c.w, slots: c.slots.map((s) => ({ ids: s.ids, active: s.active, h: s.h })) })) })); } catch {}
  }
  // every panel exactly once, no empty slots or columns, one stretching column
  function normalize() {
    const seen = new Set();
    for (const c of model.cols) {
      for (const s of c.slots) {
        s.ids = s.ids.filter((id) => PANELS[id] && !seen.has(id) && seen.add(id));
        if (!s.ids.includes(s.active)) s.active = s.ids[0];
      }
      c.slots = c.slots.filter((s) => s.ids.length);
    }
    model.cols = model.cols.filter((c) => c.slots.length);
    if (!model.cols.length) { model = DEFAULT(); return normalize(); }
    for (const id of homeOrder) if (!seen.has(id)) model.cols.at(-1).slots.push(slot([id]));
    const fill = model.cols.find((c) => c.w == null) || model.cols.find((c) => c.slots.some((s) => s.ids.includes('viewer'))) || model.cols[0];
    for (const c of model.cols) if (c !== fill && c.w == null) c.w = 340;
    fill.w = null;
    // heights are shares of the column: keep them adding up to one per slot, so
    // a panel left alone in a column (flex-grow < 1 would only fill part of it)
    // always gets the full height
    for (const c of model.cols) {
      let sum = 0;
      for (const s of c.slots) { if (!(s.h > 0)) s.h = 1; sum += s.h; }
      for (const s of c.slots) s.h = +(s.h * c.slots.length / sum).toFixed(4);
    }
  }

  // hidden by the app itself (채팅 숨기기), not by the layout
  const appHidden = (id) => id === 'chat' && layoutEl.classList.contains('no-chat');
  const visibleIds = (s) => s.ids.filter((id) => !appHidden(id));

  function render() {
    normalize();
    layoutEl.classList.add('docked');
    const side = layoutEl.querySelector(':scope > .side');
    layoutEl.querySelectorAll(':scope > .dock-split').forEach((x) => x.remove());
    const used = new Set();
    model.cols.forEach((c, ci) => {
      let col = colEls[ci];
      if (!col) { col = document.createElement('div'); col.className = 'dock-col'; colEls[ci] = col; }
      const want = ci === 0 ? layoutEl.firstElementChild : colEls[ci - 1].nextElementSibling;
      if (col !== want) layoutEl.insertBefore(col, want);
      col.querySelectorAll(':scope > .dock-split').forEach((x) => x.remove());
      let prev = null;
      for (const s of c.slots) {
        const el = slotEl(s);
        used.add(el);
        const ref = prev ? prev.nextElementSibling : col.firstElementChild;
        if (ref !== el) col.insertBefore(el, ref);
        prev = el;
        fillSlot(s, el);
      }
      col.style.flex = c.w == null ? '1 1 0' : `0 0 ${c.w}px`;
    });
    for (const extra of colEls.splice(model.cols.length)) extra.remove();
    for (const [s, el] of slotEls) if (!used.has(el)) { el.remove(); slotEls.delete(s); }
    if (side) layoutEl.appendChild(side);
    // gaps between visible slots and between visible columns
    let lastCol = null;
    model.cols.forEach((c, ci) => {
      const col = colEls[ci];
      const vis = c.slots.filter((s) => visibleIds(s).length);
      col.style.display = vis.length ? '' : 'none';
      let last = null;
      for (const s of c.slots) {
        const el = slotEls.get(s);
        el.style.display = visibleIds(s).length ? '' : 'none';
        if (!visibleIds(s).length) continue;
        if (last) col.insertBefore(splitter('h', ci, last, s), el);
        last = s;
      }
      if (!vis.length) return;
      // shares among the slots actually showing (채팅 숨기기 hides one)
      const k = vis.length / vis.reduce((a, s) => a + s.h, 0);
      for (const s of vis) { const el = slotEls.get(s); el._k = k; el.style.setProperty('--dh', s.h * k); }
      if (lastCol != null) layoutEl.insertBefore(splitter('v', lastCol, ci), col);
      lastCol = ci;
    });
    afterChange();
  }

  function slotEl(s) {
    let el = slotEls.get(s);
    if (!el) {
      el = document.createElement('div');
      el.className = 'dock-slot';
      el.innerHTML = '<div class="dock-tabs"></div>';
      slotEls.set(s, el);
    }
    return el;
  }

  // Tabs on top (only when the slot holds more than one panel), then the
  // panels; only the active one is shown. Switching tabs never moves a node.
  function fillSlot(s, el) {
    const vis = visibleIds(s);
    if (!vis.includes(s.active)) s.active = vis[0] || s.ids[0];
    const tabs = el.firstElementChild;
    tabs.hidden = vis.length < 2;
    el.classList.toggle('tabbed', vis.length > 1);
    tabs.textContent = '';
    for (const id of vis) {
      const t = document.createElement('button');
      t.className = 'dock-tab' + (id === s.active ? ' on' : '');
      t.textContent = PANELS[id].title;
      t.dataset.id = id;
      t.title = '클릭: 이 탭 보기 · 끌기: 다른 곳으로 옮기기';
      tabs.appendChild(t);
    }
    let prev = tabs;
    for (const id of s.ids) {
      const p = PANELS[id].el;
      if (prev.nextElementSibling !== p) el.insertBefore(p, prev.nextElementSibling);
      p.classList.toggle('dock-off', id !== s.active);
      prev = p;
    }
    el.style.setProperty('--dh', s.h);
    el.style.minHeight = (vis.length ? PANELS[s.active].minH + (vis.length > 1 ? 34 : 0) : 0) + 'px';
  }

  function afterChange() {
    window.dispatchEvent(new Event('resize')); // let pictures re-fit
    window.syncMirrors?.(); // panels behind a tab stop their OBS pictures
  }

  function undock() {
    layoutEl.classList.remove('docked');
    layoutEl.querySelectorAll(':scope > .dock-split').forEach((x) => x.remove());
    for (const id of [...homeOrder].reverse()) {
      const { parent, next } = home[id];
      const el = PANELS[id].el;
      el.classList.remove('dock-off');
      const ref = next && next.parentNode === parent ? next : null;
      if (el.parentNode !== parent || el.nextElementSibling !== ref) parent.insertBefore(el, ref);
    }
    for (const c of colEls) c.remove();
    colEls = [];
    slotEls.clear();
    afterChange();
  }

  function sync() {
    if (wide.matches) { docked = true; render(); }
    else if (docked) { docked = false; undock(); }
  }

  // ---------- resizing ----------
  function splitter(kind, a, b, c) {
    const s = document.createElement('div');
    s.className = `dock-split ${kind}`;
    s.title = '드래그해서 크기 조절 · 더블클릭으로 균등하게';
    s.addEventListener('pointerdown', (ev) => (kind === 'v' ? dragCols(ev, s, a, b) : dragRows(ev, s, b, c)));
    s.addEventListener('dblclick', () => {
      if (kind === 'h') { for (const x of model.cols[a].slots) x.h = 1; }
      else { for (const x of [model.cols[a], model.cols[b]]) if (x.w != null) x.w = 340; }
      render(); save();
    });
    return s;
  }
  function track(s, move) {
    const up = () => { s.classList.remove('dragging'); s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); save(); afterChange(); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  }
  function dragCols(ev, s, ai, bi) {
    ev.preventDefault();
    s.setPointerCapture(ev.pointerId);
    s.classList.add('dragging');
    const A = model.cols[ai], B = model.cols[bi];
    const aEl = colEls[ai], bEl = colEls[bi];
    const a0 = aEl.getBoundingClientRect().width, b0 = bEl.getBoundingClientRect().width;
    const x0 = ev.clientX;
    track(s, (e) => {
      const dx = Math.max(220 - a0, Math.min(b0 - 220, e.clientX - x0));
      if (A.w != null) A.w = Math.round(a0 + dx);
      if (B.w != null) B.w = Math.round(b0 - dx);
      aEl.style.flex = A.w == null ? '1 1 0' : `0 0 ${A.w}px`;
      bEl.style.flex = B.w == null ? '1 1 0' : `0 0 ${B.w}px`;
    });
  }
  function dragRows(ev, s, A, B) {
    ev.preventDefault();
    s.setPointerCapture(ev.pointerId);
    s.classList.add('dragging');
    const aEl = slotEls.get(A), bEl = slotEls.get(B);
    const a0 = aEl.getBoundingClientRect().height, b0 = bEl.getBoundingClientRect().height;
    const aMin = parseFloat(aEl.style.minHeight) || 90, bMin = parseFloat(bEl.style.minHeight) || 90;
    const sum = A.h + B.h;
    const y0 = ev.clientY;
    track(s, (e) => {
      const dy = Math.max(aMin - a0, Math.min(b0 - bMin, e.clientY - y0));
      const ah = a0 + dy, bh = b0 - dy;
      A.h = +(sum * ah / (ah + bh)).toFixed(4);
      B.h = +(sum - A.h).toFixed(4);
      aEl.style.setProperty('--dh', A.h * (aEl._k || 1));
      bEl.style.setProperty('--dh', B.h * (bEl._k || 1));
    });
  }

  // ---------- moving panels and tabs ----------
  const INTERACTIVE = 'button, input, select, label, a, textarea, .seg, .switch, [contenteditable]';
  for (const [id, p] of Object.entries(PANELS)) {
    p.el.querySelector('.panel-head').addEventListener('pointerdown', (ev) => {
      if (!docked || ev.button > 0) return;
      if (!ev.target.closest('.dock-grip') && ev.target.closest(INTERACTIVE)) return;
      startMove(ev, id);
    });
  }
  layoutEl.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('.dock-tab');
    if (!t || !docked || ev.button > 0) return;
    startMove(ev, t.dataset.id, () => activate(t.dataset.id)); // a plain click just switches tabs
  });

  function findSlot(id) {
    for (const c of model.cols) for (const s of c.slots) if (s.ids.includes(id)) return { col: c, slot: s };
    return null;
  }
  function activate(id) {
    const f = findSlot(id);
    if (!f || f.slot.active === id) return;
    f.slot.active = id;
    fillSlot(f.slot, slotEls.get(f.slot));
    save();
    afterChange();
  }

  function startMove(ev, id, onClick) {
    ev.preventDefault();
    const x0 = ev.clientX, y0 = ev.clientY;
    let started = false, ghost = null, drop = null, target = null;
    const begin = () => {
      started = true;
      document.body.classList.add('docking');
      ghost = Object.assign(document.createElement('div'), { className: 'dock-ghost', textContent: PANELS[id].title });
      drop = Object.assign(document.createElement('div'), { className: 'dock-drop' });
      drop.hidden = true;
      document.body.append(ghost, drop);
    };
    const move = (e) => {
      if (!started) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
        begin();
      }
      ghost.style.left = e.clientX + 14 + 'px';
      ghost.style.top = e.clientY + 10 + 'px';
      target = findTarget(e.clientX, e.clientY, id);
      drop.hidden = !target;
      drop.classList.toggle('tab', target?.kind === 'tab');
      if (target) Object.assign(drop.style, { left: target.rect.left + 'px', top: target.rect.top + 'px', width: target.rect.width + 'px', height: target.rect.height + 'px' });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (!started) { onClick?.(); return; }
      document.body.classList.remove('docking');
      ghost.remove();
      drop.remove();
      if (target) { applyMove(id, target); render(); save(); }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  // Which drop zone is under the pointer, and the rectangle to highlight.
  function findTarget(x, y, dragId) {
    const from = findSlot(dragId)?.slot;
    for (const [ci, c] of model.cols.entries()) {
      for (const s of c.slots) {
        const el = slotEls.get(s);
        if (!el || !visibleIds(s).length) continue;
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        if (s === from && s.ids.length === 1) return null; // a lone panel onto itself
        const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
        const rect = (l, t, w, h) => ({ left: l, top: t, width: w, height: h });
        if (fx < 0.2) return { kind: 'col', col: ci, side: 'left', rect: rect(r.left, r.top, r.width * 0.3, r.height) };
        if (fx > 0.8) return { kind: 'col', col: ci, side: 'right', rect: rect(r.right - r.width * 0.3, r.top, r.width * 0.3, r.height) };
        if (fy < 0.25) return { kind: 'row', col: ci, slot: s, side: 'above', rect: rect(r.left, r.top, r.width, r.height * 0.35) };
        if (fy > 0.75) return { kind: 'row', col: ci, slot: s, side: 'below', rect: rect(r.left, r.bottom - r.height * 0.35, r.width, r.height * 0.35) };
        if (s === from) return null; // already a tab here
        return { kind: 'tab', col: ci, slot: s, rect: rect(r.left + 6, r.top + 6, r.width - 12, r.height - 12) };
      }
    }
    return null;
  }

  function applyMove(id, t) {
    const f = findSlot(id);
    const wasAlone = f.slot.ids.length === 1;
    f.slot.ids = f.slot.ids.filter((x) => x !== id);
    if (f.slot.active === id) f.slot.active = f.slot.ids[0];
    if (t.kind === 'tab') {
      t.slot.ids.push(id);
      t.slot.active = id;
      if (wasAlone && f.col === model.cols[t.col]) t.slot.h += f.slot.h; // keep the column's space
    } else if (t.kind === 'row') {
      const col = model.cols[t.col];
      const i = col.slots.indexOf(t.slot);
      const n = slot([id], t.slot.h / 2);
      t.slot.h /= 2;
      col.slots.splice(t.side === 'above' ? i : i + 1, 0, n);
    } else {
      const fresh = { w: 320, slots: [slot([id])] };
      model.cols.splice(t.side === 'left' ? t.col : t.col + 1, 0, fresh);
      if (id === 'viewer') { for (const c of model.cols) if (c.w == null) c.w = 340; fresh.w = null; }
    }
    for (const c of model.cols) c.slots = c.slots.filter((s) => s.ids.length);
    model.cols = model.cols.filter((c) => c.slots.length);
    // the viewer's column should be the one that stretches
    if (!model.cols.some((c) => c.w == null)) (model.cols.find((c) => c.slots.some((s) => s.ids.includes('viewer'))) || model.cols[0]).w = null;
  }

  document.getElementById('dockReset')?.addEventListener('click', () => {
    model = DEFAULT();
    save();
    if (docked) render();
    document.getElementById('devMenu').hidden = true;
  });

  // re-place gaps when a panel is shown/hidden by the app (채팅 숨기기)
  window.dockRefresh = () => { if (docked) render(); };
  wide.addEventListener('change', sync);
  sync();
})();
