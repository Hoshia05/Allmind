// Free layout, OBS-style: on wide landscape screens every panel lives in a
// column. Drag a panel by the ⠿ grip in its header (or an empty part of the
// header) to another spot:
//   • over the top/bottom half of a panel → above/below it, same column
//   • over a panel's left/right edge      → a new column on that side
// Drag the gaps between columns/panels to resize. The layout is saved in
// this browser only, so the PC, iPad and phone can each have their own.
// Narrow/portrait screens keep the fixed layouts (phone tabs etc.).
(() => {
  const layoutEl = document.getElementById('layout');
  const PANELS = {
    viewer: { el: document.querySelector('.viewer-panel'), title: '방송 화면 · 영도', minH: 200 },
    chat: { el: document.getElementById('chatPanel'), title: '채팅', minH: 150 },
    music: { el: document.querySelector('.panel.music'), title: '음악', minH: 160 },
    sb: { el: document.getElementById('sbPanel'), title: '사운드보드', minH: 90 },
    alert: { el: document.querySelector('.alert-panel'), title: '알림 화면', minH: 100 },
  };
  const DEFAULT = () => ({
    cols: [
      { w: null, panels: [{ id: 'viewer', h: 1 }] },
      { w: 340, panels: [{ id: 'chat', h: 1 }] },
      { w: 340, panels: [{ id: 'music', h: 0.9 }, { id: 'sb', h: 0.85 }, { id: 'alert', h: 1 }] },
    ],
  });
  const KEY = 'sd.dock';
  const wide = matchMedia('(min-width: 1100px) and (min-height: 560px) and (orientation: landscape)');

  // where each panel sits in the fixed layout, to put it back when leaving
  const home = Object.fromEntries(Object.entries(PANELS).map(([id, p]) => [id, { parent: p.el.parentNode, next: p.el.nextElementSibling }]));
  const homeOrder = Object.keys(PANELS);

  let model = load();
  let colEls = [];
  let docked = false;

  function load() {
    try {
      const m = JSON.parse(localStorage.getItem(KEY));
      if (valid(m)) return m;
    } catch {}
    return DEFAULT();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(model)); } catch {}
  }
  // every panel exactly once, no empty columns
  function valid(m) {
    if (!m || !Array.isArray(m.cols) || !m.cols.length) return false;
    const seen = m.cols.flatMap((c) => (c.panels || []).map((p) => p.id));
    return seen.length === homeOrder.length && homeOrder.every((id) => seen.includes(id));
  }
  function normalize() {
    // panels added in a later version go to the last column
    const seen = new Set(model.cols.flatMap((c) => c.panels.map((p) => p.id)));
    for (const id of homeOrder) if (!seen.has(id)) model.cols.at(-1).panels.push({ id, h: 1 });
    for (const c of model.cols) c.panels = c.panels.filter((p) => PANELS[p.id]);
    model.cols = model.cols.filter((c) => c.panels.length);
    // exactly one column fills the leftover width: the viewer's, else the first
    const fill = model.cols.find((c) => c.w == null) || model.cols.find((c) => c.panels.some((p) => p.id === 'viewer')) || model.cols[0];
    for (const c of model.cols) if (c !== fill && c.w == null) c.w = 340;
    fill.w = null;
  }

  const shownPanel = (id) => getComputedStyle(PANELS[id].el).display !== 'none';

  function render() {
    normalize();
    layoutEl.classList.add('docked');
    const side = layoutEl.querySelector(':scope > .side');
    layoutEl.querySelectorAll(':scope > .dock-split').forEach((s) => s.remove());
    model.cols.forEach((c, ci) => {
      let col = colEls[ci];
      if (!col) { col = document.createElement('div'); col.className = 'dock-col'; colEls[ci] = col; }
      // columns in order, before the (hidden) fixed-layout side column
      const want = ci === 0 ? layoutEl.firstElementChild : colEls[ci - 1].nextElementSibling;
      if (col !== want) layoutEl.insertBefore(col, want);
      // panels in order; only move a node when it's out of place (moving an
      // iframe reloads it — the 위플챗 page would lose its chat)
      col.querySelectorAll(':scope > .dock-split').forEach((s) => s.remove());
      let prev = null;
      for (const p of c.panels) {
        const el = PANELS[p.id].el;
        const ref = prev ? prev.nextElementSibling : col.firstElementChild;
        if (ref !== el) col.insertBefore(el, ref);
        el.style.setProperty('--dh', p.h);
        el.style.minHeight = PANELS[p.id].minH + 'px';
        prev = el;
      }
      col.classList.toggle('fill', c.w == null);
      col.style.flex = c.w == null ? '1 1 0' : `0 0 ${c.w}px`;
    });
    for (const extra of colEls.splice(model.cols.length)) extra.remove();
    if (side) layoutEl.appendChild(side);
    // gaps: between visible panels in a column, between visible columns
    let lastCol = null;
    model.cols.forEach((c, ci) => {
      const col = colEls[ci];
      const vis = c.panels.filter((p) => shownPanel(p.id));
      col.style.display = vis.length ? '' : 'none';
      let last = null;
      for (const p of c.panels) {
        if (!shownPanel(p.id)) continue;
        if (last) col.insertBefore(splitter('h', ci, last, p.id), PANELS[p.id].el);
        last = p.id;
      }
      if (!vis.length) return;
      if (lastCol != null) layoutEl.insertBefore(splitter('v', lastCol, ci), col);
      lastCol = ci;
    });
    window.dispatchEvent(new Event('resize')); // let pictures re-fit
  }

  function undock() {
    layoutEl.classList.remove('docked');
    layoutEl.querySelectorAll(':scope > .dock-split').forEach((s) => s.remove());
    // put panels back where the fixed layout expects them
    for (const id of [...homeOrder].reverse()) {
      const { parent, next } = home[id];
      const el = PANELS[id].el;
      el.style.removeProperty('--dh');
      el.style.minHeight = '';
      const ref = next && next.parentNode === parent ? next : null;
      if (el.parentNode !== parent || el.nextElementSibling !== ref) parent.insertBefore(el, ref);
    }
    for (const c of colEls) c.remove();
    colEls = [];
    window.dispatchEvent(new Event('resize'));
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
    s.addEventListener('pointerdown', (ev) => (kind === 'v' ? dragCols(ev, s, a, b) : dragRows(ev, s, a, b, c)));
    s.addEventListener('dblclick', () => {
      if (kind === 'h') { for (const p of model.cols[a].panels) p.h = 1; }
      else { for (const c2 of [model.cols[a], model.cols[b]]) if (c2.w != null) c2.w = 340; }
      render(); save();
    });
    return s;
  }
  function dragCols(ev, s, ai, bi) {
    ev.preventDefault();
    s.setPointerCapture(ev.pointerId);
    s.classList.add('dragging');
    const A = model.cols[ai], B = model.cols[bi];
    const aEl = colEls[ai], bEl = colEls[bi];
    const a0 = aEl.getBoundingClientRect().width, b0 = bEl.getBoundingClientRect().width;
    const x0 = ev.clientX;
    const min = 220;
    const move = (e) => {
      const dx = Math.max(min - a0, Math.min(b0 - min, e.clientX - x0));
      if (A.w != null) A.w = Math.round(a0 + dx);
      if (B.w != null) B.w = Math.round(b0 - dx);
      aEl.style.flex = A.w == null ? '1 1 0' : `0 0 ${A.w}px`;
      bEl.style.flex = B.w == null ? '1 1 0' : `0 0 ${B.w}px`;
    };
    const up = () => { s.classList.remove('dragging'); s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); save(); window.dispatchEvent(new Event('resize')); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  }
  function dragRows(ev, s, ci, aId, bId) {
    ev.preventDefault();
    s.setPointerCapture(ev.pointerId);
    s.classList.add('dragging');
    const col = model.cols[ci];
    const A = col.panels.find((p) => p.id === aId), B = col.panels.find((p) => p.id === bId);
    const aEl = PANELS[aId].el, bEl = PANELS[bId].el;
    const a0 = aEl.getBoundingClientRect().height, b0 = bEl.getBoundingClientRect().height;
    const sum = A.h + B.h;
    const y0 = ev.clientY;
    const move = (e) => {
      const dy = Math.max(PANELS[aId].minH - a0, Math.min(b0 - PANELS[bId].minH, e.clientY - y0));
      const ah = a0 + dy, bh = b0 - dy;
      A.h = +(sum * ah / (ah + bh)).toFixed(4);
      B.h = +(sum - A.h).toFixed(4);
      aEl.style.setProperty('--dh', A.h);
      bEl.style.setProperty('--dh', B.h);
    };
    const up = () => { s.classList.remove('dragging'); s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); save(); window.dispatchEvent(new Event('resize')); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  }

  // ---------- moving panels ----------
  const INTERACTIVE = 'button, input, select, label, a, textarea, .seg, .switch, [contenteditable]';
  for (const [id, p] of Object.entries(PANELS)) {
    const head = p.el.querySelector('.panel-head');
    head.addEventListener('pointerdown', (ev) => {
      if (!docked || ev.button > 0) return;
      const onGrip = ev.target.closest('.dock-grip');
      if (!onGrip && ev.target.closest(INTERACTIVE)) return;
      startMove(ev, id);
    });
  }

  function startMove(ev, id) {
    const x0 = ev.clientX, y0 = ev.clientY;
    let started = false, ghost = null, drop = null, target = null;
    const el = PANELS[id].el;
    const begin = () => {
      started = true;
      document.body.classList.add('docking');
      el.classList.add('dock-dragging');
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
      if (!target) { drop.hidden = true; return; }
      const r = target.rect;
      drop.hidden = false;
      Object.assign(drop.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (!started) return;
      document.body.classList.remove('docking');
      el.classList.remove('dock-dragging');
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
    for (const [ci, c] of model.cols.entries()) {
      for (const p of c.panels) {
        if (p.id === dragId || !shownPanel(p.id)) continue;
        const r = PANELS[p.id].el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
        const rect = (l, t, w, h) => ({ left: l, top: t, width: w, height: h });
        if (fx < 0.22) return { kind: 'col', col: ci, side: 'left', rect: rect(r.left, r.top, r.width * 0.3, r.height) };
        if (fx > 0.78) return { kind: 'col', col: ci, side: 'right', rect: rect(r.right - r.width * 0.3, r.top, r.width * 0.3, r.height) };
        if (fy < 0.5) return { kind: 'row', col: ci, at: p.id, side: 'above', rect: rect(r.left, r.top, r.width, r.height * 0.45) };
        return { kind: 'row', col: ci, at: p.id, side: 'below', rect: rect(r.left, r.bottom - r.height * 0.45, r.width, r.height * 0.45) };
      }
    }
    return null;
  }

  function applyMove(id, t) {
    const targetCol = model.cols[t.col];
    // take it out of where it was
    let entry = null;
    for (const c of model.cols) {
      const i = c.panels.findIndex((p) => p.id === id);
      if (i >= 0) { entry = c.panels.splice(i, 1)[0]; break; }
    }
    if (t.kind === 'row') {
      const i = targetCol.panels.findIndex((p) => p.id === t.at);
      // share the space of the panel it lands next to
      const other = targetCol.panels[i];
      entry.h = other.h / 2;
      other.h = other.h / 2;
      targetCol.panels.splice(t.side === 'above' ? i : i + 1, 0, entry);
    } else {
      entry.h = 1;
      const fresh = { w: 320, panels: [entry] };
      const i = model.cols.indexOf(targetCol);
      model.cols.splice(t.side === 'left' ? i : i + 1, 0, fresh);
      // the viewer's column should be the one that stretches
      if (id === 'viewer') { for (const c of model.cols) if (c.w == null) c.w = 340; fresh.w = null; }
    }
    model.cols = model.cols.filter((c) => c.panels.length);
    if (!model.cols.some((c) => c.w == null)) {
      (model.cols.find((c) => c.panels.some((p) => p.id === 'viewer')) || model.cols[0]).w = null;
    }
  }

  document.getElementById('dockReset')?.addEventListener('click', () => {
    model = DEFAULT();
    save();
    if (docked) render();
    document.getElementById('devMenu').hidden = true;
  });

  // re-place gaps when a panel is shown/hidden (e.g. 채팅 숨기기)
  window.dockRefresh = () => { if (docked) render(); };
  wide.addEventListener('change', sync);
  sync();
})();
