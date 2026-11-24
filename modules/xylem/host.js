// What Xylem's files used to import from the platform (src/config.js, src/update.js, src/tts.js), now filled from ctx by
// index.js before anything is built. Keeps the moved files' code unchanged apart from their import lines.
// Xylem never imports platform code (tools/check-boundary.mjs enforces it); everything arrives through ctx.
const host = { state: null, assets: null, tts: null };

// the platform's data folder (shared); live binding, set in setHost() before any Xylem object exists
export let DATA_DIR = '.';

export function setHost(ctx) {
  host.state = ctx.state;
  host.assets = ctx.assets;
  host.tts = ctx.services.tts || null;
  DATA_DIR = ctx.dataDir;
}

// same file names as before the move (DATA_DIR/<name>.json), so existing settings, logs and the scoreboard stay
export const loadState = (name, fallback) => host.state.load(name, fallback);
export const saveState = (name, value) => host.state.save(name, value);
// files shipped with Allmind (public/xylem/ = the built-in pack, public/vts-items/)
export const readAsset = (rel) => host.assets.read(rel);
// text the Windows voice can read (the platform's TTS service owns the rules)
export const speakable = (text, maxLen) => (host.tts?.speakable ? host.tts.speakable(text, maxLen) : String(text || ''));

// 1 if a > b, -1 if a < b, 0 if equal ("v1.2.3" accepted) — same as the platform's updater
export function cmpVersion(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}
