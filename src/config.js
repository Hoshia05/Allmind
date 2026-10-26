// Config + small persistent state.
// When running as Allmind.exe, config.json and data/ live next to the exe
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
// The exe keeps settings in one fixed place (%APPDATA%\Allmind), so every
// new version uses them no matter which folder it was unzipped into.
// Running from source keeps them next to the code.
export const CONFIG_DIR = process.env.ALLMIND_HOME
  || (IS_EXE && process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'Allmind') : ROOT);
const CONFIG_PATH = process.env.ALLMIND_CONFIG || path.join(CONFIG_DIR, 'config.json');
export const DATA_DIR = process.env.ALLMIND_DATA || path.join(CONFIG_DIR, 'data');

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
  const base = defaults();
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`[config] Could not read ${CONFIG_PATH}: ${err.message} — using defaults`);
    }
  }
  const cfg = merge(base, user);
  cfg._firstRun = !fs.existsSync(CONFIG_PATH);
  return cfg;
}

// Writes only the user-editable parts (keeps anything else already in the file).
export function saveConfig(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
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
let frozen = false;
// After a settings import: stop writing state so nothing running overwrites the imported files before the restart.
export function freezeState() {
  frozen = true;
  for (const t of Object.values(saveTimers)) clearTimeout(t);
}
export function saveState(name, value) {
  if (frozen) return;
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `${name}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  }, 250);
}
