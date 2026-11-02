# 텍스트 — on-screen text boxes (0.38.0, Xylem pack 1.4.0)

Owner (2026-11-02): OBS's text source is tedious to edit mid-stream; wants a text overlay like the roulette's,
with text + all properties (font, size, colours, background …) changed live from Allmind/Xylem, plus simple animations.

- Server `src/textbox.js` `TextBoxes`: up to 12 boxes `{id,name,text,visible,style,anim,recent,rev}` + named `presets`,
  saved to `DATA_DIR/textbox.json` (debounced). Everything is validated (`cleanStyle`/`cleanAnim`; font names reduced to
  letters/digits/space/._- because they go into CSS). Two channels: `ch` (OBS overlays, counted) and `pv` (previews).
  Every change sends the whole box (`box` event); `rev` increases only when the text changes (→ change animation).
- Routes: `POST /api/text/set {id, patch:{text?,remember?,visible?,name?,style?,anim?}}`, `/add {copyFrom?}`,
  `/remove`, `/forget`, `/preset-save {id,name}`, `/preset-delete`; `GET /api/text/events[?preview=1]`; overlay `/text?id=N`.
  Xylem state carries `text: {boxes, presets, overlays}` and `overlays.text`.
- Overlay `public/xylem/text.html` (1920×1080, transparent): 3×3 anchor + offset, `#anim` (in/out/change keyframes;
  out = in reversed), `#loop` (float/pulse/shake/wiggle/glow/rainbow/blink; marquee scrolls `#stack` inside a fixed-width
  box), typewriter by grapheme. Outline is a separate layer under the text (`#outline`, stroke ×2) so a gradient fill
  (background-clip:text) isn't covered. Google Fonts loaded on demand from a fixed list; other names = installed fonts.
- Panel `public/xylem/text.panel.js`: text sent on 보내기/Ctrl+Enter (or live), style changes debounced 60 ms,
  built-in looks (`BUILTIN`), preview = the real overlay in an iframe scaled from 1920×1080.
- Mock-tested in Chromium (no Google Fonts here — fallback font). Real OBS CEF untested.
