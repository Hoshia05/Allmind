// Optional modules (docs/plans/modules.md, M1): the contract (`ctx`) and the registry.
// The platform never imports, names or waits for a module. A module is a folder modules/<id>/ with module.json
// ({ id, name, version, minApi }) and index.js exporting register(ctx); it reaches the platform only through ctx.
// A missing, failing or too-new module is logged and skipped; the platform keeps running.
//
// Loading: from source, discover() imports modules/*/index.js at start. In the exe, tools/build-exe.mjs replaces
// ./modules-list.js with a static list, so esbuild bundles the modules into the one file (a SEA can't import
// files from disk). Both paths end in the same createRegistry().load(list).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const API_LEVEL = 1;
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const METHODS = new Set(['GET', 'POST']);

// Source runs: one entry per modules/<id>/ folder with a module.json, sorted by id.
export async function discover(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const folder = path.join(dir, name);
    const mf = path.join(folder, 'module.json');
    if (!fs.existsSync(mf)) continue;
    let manifest;
    let mod;
    try {
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
      mod = await import(pathToFileURL(path.join(folder, 'index.js')).href);
    } catch (e) {
      out.push({ manifest: { id: manifest?.id || name }, error: e.message });
      continue;
    }
    out.push({ manifest, mod });
  }
  return out.sort((a, b) => String(a.manifest.id).localeCompare(String(b.manifest.id)));
}

// platform = what the server hands to modules:
//   config (whole config; a module sees only config[id]), dataDir (the platform data folder, shared — M2: existing files stay put),
//   events {name: subscribe(fn)}, chatSend(text), toast(t), log(...), services {obs, vts, tts, chat, chatSender…},
//   state {load(name, fallback), save(name, value)} (the platform's JSON store, same file names), assets {read(rel)} (files shipped in
//   the exe), version, reportSection(key, def), reserved('METHOD /path') → true if the platform owns it,
//   reservedUnder('/prefix/') → true if a platform route lives under that prefix.
// Route options: { pinFree } (no PIN, for OBS overlays), { pinPage } (a page that asks other devices for the PIN, like the dashboard),
// { prefix } (path ends in '/', matches everything below it; exact routes win), { raw } (handler(req, res, url) writes the response).
const BROAD_PREFIXES = new Set(['/', '/api/', '/api/v1/', '/api/v1/m/']);
export function createRegistry(platform) {
  const loaded = []; // { manifest, routes: [key] }
  const failed = []; // { id, error }
  const routes = new Map(); // 'GET /path' → { id, handler, raw, pinFree, pinPage }
  const prefixes = []; // { method, prefix, entry }, longest prefix first
  const snaps = new Map(); // key → { id, fn }

  function makeCtx(manifest, pending) {
    const id = manifest.id;
    const own = `/api/v1/m/${id}/`;
    const addRoute = (method, p, handler, { pinFree = false, pinPage = false, prefix = false, raw: rawOpt = false } = {}, raw = false) => {
      raw = raw || !!rawOpt;
      method = String(method || '').toUpperCase();
      if (!METHODS.has(method)) throw new Error(`${id}: method ${method} not allowed (GET or POST)`);
      if (typeof p !== 'string' || !p.startsWith('/') || p.includes('..')) throw new Error(`${id}: bad path ${p}`);
      if (typeof handler !== 'function') throw new Error(`${id}: handler for ${p} is not a function`);
      if (p.startsWith('/api/v1/') && !p.startsWith(own)) throw new Error(`${id}: /api/v1 routes must be under ${own} (got ${p})`);
      const key = `${method} ${p}`;
      if (platform.reserved?.(key)) throw new Error(`${id}: ${key} belongs to the platform`);
      if (prefix) {
        if (!p.endsWith('/') || BROAD_PREFIXES.has(p) || p.startsWith('/deck/') || p.startsWith('/api/launcher/') || platform.reservedUnder?.(p)) {
          throw new Error(`${id}: prefix route ${p} not allowed (must end in /, be specific and not cover platform routes)`);
        }
        if (prefixes.some((x) => x.key === key) || pending.routes.some((r) => r.prefix && r.key === key)) throw new Error(`${id}: ${key} is already taken`);
        pending.routes.push({ key, prefix: true, method, p, entry: { id, handler, raw, pinFree: !!pinFree, pinPage: !!pinPage } });
        return;
      }
      if (routes.has(key) || pending.routes.some((r) => !r.prefix && r.key === key)) throw new Error(`${id}: ${key} is already taken`);
      pending.routes.push({ key, entry: { id, handler, raw, pinFree: !!pinFree, pinPage: !!pinPage } });
    };
    return Object.freeze({
      id,
      apiLevel: API_LEVEL,
      config: Object.freeze({ ...(platform.config?.[id] || {}) }),
      dataDir: platform.dataDir || '.',
      version: platform.version || '',
      state: Object.freeze({
        load: (name, fallback) => platform.state?.load(String(name), fallback) ?? fallback,
        save: (name, value) => platform.state?.save(String(name), value),
      }),
      assets: Object.freeze({ read: (rel) => (platform.assets?.read ? platform.assets.read(String(rel)) : null) }),
      // the stream report (report.js) asks each section to build its part when a stream ends, and to refresh it when shown
      reportSection(key, def) {
        if (typeof def?.build !== 'function') throw new Error(`${id}: reportSection ${key} needs build()`);
        pending.reports.push({ key, def });
      },
      events: Object.freeze({
        on(name, fn) {
          const sub = platform.events?.[name];
          if (!sub) throw new Error(`${id}: unknown event "${name}" (known: ${Object.keys(platform.events || {}).join(', ')})`);
          pending.subs.push(() => sub(fn));
        },
      }),
      chat: Object.freeze({ send: (text) => platform.chatSend(text) }),
      // handler(body, { req, url }) → object, answered as JSON { ok: true, ...result } (errors → 400), like the platform's routes
      route: (method, p, handler, opts) => addRoute(method, p, handler, opts, false),
      // handler(req, res, url): raw response (SSE channels, files)
      sse: (p, handler, opts) => addRoute('GET', p, handler, opts, true),
      snapshot(key, fn) {
        if (typeof fn !== 'function') throw new Error(`${id}: snapshot ${key} needs a function`);
        if (snaps.has(key) || pending.snaps.some((s) => s.key === key)) throw new Error(`${id}: snapshot key ${key} is already taken`);
        pending.snaps.push({ key, fn });
      },
      toast: (t) => platform.toast?.(t),
      log: (...a) => platform.log?.(`[${id}]`, ...a),
      services: platform.services || {},
    });
  }

  async function loadOne({ manifest, mod, error }) {
    const id = manifest?.id;
    if (error) throw new Error(error);
    if (!ID_RE.test(String(id || ''))) throw new Error(`bad module id "${id}" (lowercase letters, digits, -)`);
    if (loaded.some((m) => m.manifest.id === id)) throw new Error(`module ${id} is already loaded`);
    if (Number(manifest.minApi || 1) > API_LEVEL) throw new Error(`needs API level ${manifest.minApi}, this Allmind has ${API_LEVEL}`);
    if (typeof mod?.register !== 'function') throw new Error('index.js has no register(ctx)');
    // everything a module registers is collected first and only kept if register() succeeds
    const pending = { routes: [], snaps: [], subs: [], reports: [] };
    await mod.register(makeCtx(manifest, pending));
    for (const r of pending.routes) {
      if (r.prefix) prefixes.push({ key: r.key, method: r.method, prefix: r.p, entry: r.entry });
      else routes.set(r.key, r.entry);
    }
    prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
    for (const r of pending.reports) platform.reportSection?.(r.key, r.def);
    for (const s of pending.snaps) snaps.set(s.key, { id, fn: s.fn });
    for (const sub of pending.subs) sub();
    loaded.push({ manifest, routes: pending.routes.map((r) => r.key) });
  }

  return {
    failed,
    async load(list) {
      for (const item of list || []) {
        const id = item?.manifest?.id || '?';
        try {
          await loadOne(item);
          platform.log?.(`[modules] loaded ${id} ${item.manifest.version || ''}`.trim());
        } catch (e) {
          failed.push({ id, error: e.message });
          platform.log?.(`[modules] skipped ${id}: ${e.message}`);
        }
      }
    },
    route(method, p) {
      const exact = routes.get(`${method} ${p}`);
      if (exact) return exact;
      const hit = prefixes.find((x) => x.method === method && p.startsWith(x.prefix));
      return hit ? hit.entry : null;
    },
    pinFreePaths() {
      return [...new Set([...routes].filter(([, r]) => r.pinFree).map(([k]) => k.slice(k.indexOf(' ') + 1)))];
    },
    pinFreePrefixes() {
      return [...new Set(prefixes.filter((x) => x.entry.pinFree).map((x) => x.prefix))];
    },
    pinPagePaths() {
      return [...new Set([...routes].filter(([, r]) => r.pinPage).map(([k]) => k.slice(k.indexOf(' ') + 1)))];
    },
    // the modules' part of the dashboard snapshot; a module whose status throws is left out (logged once per key)
    snapshot() {
      const out = {};
      for (const [key, { id, fn }] of snaps) {
        try { out[key] = fn(); } catch (e) {
          if (!this._snapErr?.has(key)) { (this._snapErr ||= new Set()).add(key); platform.log?.(`[modules] ${id} snapshot ${key}: ${e.message}`); }
        }
      }
      return out;
    },
    // for GET /api/v1/info: commands = the module's own /api/v1/m/<id>/ routes
    info() {
      return loaded.map(({ manifest, routes: keys }) => ({
        id: manifest.id,
        name: manifest.name || manifest.id,
        version: manifest.version || '',
        commands: keys.filter((k) => k.includes(` /api/v1/m/${manifest.id}/`)),
      }));
    },
  };
}
