// Config + small persistent state.
// When running as Arkbird.exe, config.json and data/ live next to the exe
// and the web page / example config are read from inside the exe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sea from 'node:sea';

export const IS_EXE = (() => {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
})();

const here = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return typeof __dirname !== 'undefined' ? __dirname : process.cwd(); // bundled (CommonJS) build
  }
})();

export const ROOT = IS_EXE ? path.dirname(process.execPath) : path.resolve(here, '..');
// The exe keeps settings in one fixed place (%APPDATA%\Arkbird), so every
// new version uses them no matter which folder it was unzipped into.
// Running from source keeps them next to the code.
export const CONFIG_DIR = process.env.ARKBIRD_HOME
  || (IS_EXE && process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'Arkbird') : ROOT);
const CONFIG_PATH = process.env.ARKBIRD_CONFIG || path.join(CONFIG_DIR, 'config.json');
export const DATA_DIR = process.env.ARKBIRD_DATA || path.join(CONFIG_DIR, 'data');

// ---------- carry settings over from an older version ----------
// Old versions kept config.json (and data\) next to the exe, e.g.
//   Downloads\StreamDesk-0.3.3\StreamDesk\config.json   (the program was called Stream Desk before Arkbird)
// On first start, take the newest one found next to this copy.
function looksLikeOurConfig(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && (j.obs || j.sources || j.bgm);
  } catch {
    return false;
  }
}
function findOlderInstall() {
  const seen = new Set();
  const found = [];
  const consider = (dir) => {
    const file = path.join(dir, 'config.json');
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key) || path.resolve(file) === path.resolve(CONFIG_PATH)) return;
    seen.add(key);
    try {
      if (fs.statSync(file).isFile() && looksLikeOurConfig(file)) found.push({ dir, mtime: fs.statSync(file).mtimeMs });
    } catch {}
  };
  consider(ROOT); // config.json right next to this exe
  // Before the rename (Stream Desk -> Arkbird) the exe kept its settings in %APPDATA%\StreamDesk
  if (process.env.APPDATA) consider(path.join(process.env.APPDATA, 'StreamDesk'));
  // Sibling folders: ..\* and ..\..\*\Arkbird (each zip unzips to its own folder)
  for (const base of [path.resolve(ROOT, '..'), path.resolve(ROOT, '..', '..')]) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }).slice(0, 500); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/(arkbird|stream.?desk)/i.test(e.name)) continue;
      const d = path.join(base, e.name);
      consider(d);
      for (const sub of ['Arkbird', 'arkbird', 'StreamDesk', 'stream-desk']) consider(path.join(d, sub));
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.dir || null;
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}
export let IMPORTED_FROM = null;
export function migrateFromOlderVersion() {
  if (fs.existsSync(CONFIG_PATH) || process.env.ARKBIRD_CONFIG) return null;
  const dir = findOlderInstall();
  if (!dir) return null;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.copyFileSync(path.join(dir, 'config.json'), CONFIG_PATH);
    if (fs.existsSync(path.join(dir, 'data'))) copyDir(path.join(dir, 'data'), DATA_DIR);
    IMPORTED_FROM = dir;
    return dir;
  } catch (e) {
    console.error(`[config] couldn't import settings from ${dir}: ${e.message}`);
    return null;
  }
}

// Files that ship with the app (web page, example config).
export function readAsset(rel) {
  if (IS_EXE) {
    try {
      return Buffer.from(sea.getAsset(rel.replace(/\\/g, '/')));
    } catch {
      return null;
    }
  }
  const file = path.join(ROOT, rel);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function defaults() {
  return JSON.parse(readAsset('config.example.json').toString('utf8'));
}

export function configPath() {
  return CONFIG_PATH;
}

export function loadConfig() {
  migrateFromOlderVersion();
  const base = defaults();
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`[config] Could not read ${CONFIG_PATH}: ${err.message} — using defaults`);
    }
  }
  // Early versions copied every default into config.json; drop the old
  // defaults that later versions changed, so the new ones apply.
  if (!user.configVersion && user.viewer?.fps === 10) delete user.viewer.fps;
  const cfg = merge(base, user);
  cfg._firstRun = !fs.existsSync(CONFIG_PATH);
  cfg._importedFrom = IMPORTED_FROM;
  return cfg;
}

// Writes only the user-editable parts (keeps anything else already in the file).
export function saveConfig(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  if (!current.configVersion && current.viewer?.fps === 10) delete current.viewer.fps;
  const next = merge(current, { ...patch, configVersion: 3 });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
  return next;
}

// Small JSON store for things that should survive a restart (setlist order, volume…).
export function loadState(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}
const saveTimers = {};
export function saveState(name, value) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `${name}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  }, 250);
}
