# 할 일 — idea list for streams (0.39.0)

Owner (2026-11-02): keeps a big list of games/content ideas but forgets them the moment the stream starts.
Agreed shape: 창고 (ideas, quick capture) + 오늘 (picked for this stream); no every-stream routine; a panel under a tab
like the 사운드보드; ⭐ mark on check (owner unsure it's useful — kept, easy to remove).

- `src/todo.js` `TodoList`: items `{id,title,tag,note,status idea|tonight|done,done,doneAt,added,moved,marked}` in
  `DATA_DIR/todo.json`; tags 게임/콘텐츠/토크/공지/기타. `check()` → `markers.mark('할 일: …')` when recording (once per item).
  Stream start → `todo-start` SSE (reminder sheet: tonight list, or "창고에 N개"); stream end → report `plan {done,left}`
  (`summary()`), then `archive()` moves checked 오늘 items to 한 것 — unchecked ones stay in 오늘 (deviation from the first
  proposal of sending them back to 창고: keeps the plan in view, and survives the 10-min stream-restart case).
- Routes `POST /api/todo/add|update|remove|check`; full list as SSE `todo` on change and on connect (not in the snapshot).
- Dashboard: panel `#todoPanel` (tabs 오늘/창고/한 것, add input + tag, 창고 tag filter + oldest/newest sort, inline edit
  with note, two-press delete). Free layout: a tab next to 사운드보드 (`PANELS.todo.tabWith = 'sb'`, also merged into saved
  layouts; `window.dockShow(id)`); fixed layouts: folded until opened (`pref todoFolded`); phones: own bottom tab `mp-todo`.
