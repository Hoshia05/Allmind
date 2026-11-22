#!/usr/bin/env node
// Standalone rule (docs/plans/modules.md): the platform never imports, names or waits for a module.
//   node tools/check-boundary.mjs           report only (exit 0) — the mode until M2 moves Xylem into modules/xylem/
//   node tools/check-boundary.mjs --strict  exit 1 on any violation (switch CI/the smoke routine to this after M2)
//   node tools/check-boundary.mjs --json    machine-readable report
// Violations:
//   src/ imports something under modules/, or one of Xylem's server files (dogfight, roulette, draw, textbox, vtsthrow, xylem)
//   src/ names a Xylem route or overlay page (/api/draw/…, /dogfight, …)
//   modules/<id>/ imports platform code (src/) or another module (modules reach the platform only through ctx)
// Mentions of "Xylem" elsewhere (dashboard, tray, build) are listed as info; M3 gates those.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const XYLEM_FILES = ['dogfight', 'roulette', 'draw', 'textbox', 'vtsthrow', 'xylem'];
const XYLEM_ROUTE = /(?:^|['"`\s])(\/api\/(draw|roulette|dogfight|text|xylem)\/|\/api\/vts\/(throw-settings|test-throw|items|items-remove|aim-start|aim-stop|item)['"`?]|\/(dogfight|roulette|roulette-board|draw|text|xylem)['"`?/])/;
const IMPORT = /(?:^|\s)(?:import\s[^'"`]*?from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"`]([^'"`]+)['"`]/g;

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
function files(dir, exts) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (exts.includes(path.extname(e.name))) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const lines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/);

const violations = [];
const info = [];
const add = (list, file, line, rule, text) => list.push({ file: rel(file), line, rule, text: text.trim().slice(0, 140) });

// 1 + 2: platform code
for (const f of files(path.join(ROOT, 'src'), ['.js', '.mjs', '.cjs'])) {
  if (XYLEM_FILES.includes(path.basename(f, '.js'))) { add(violations, f, 1, 'Xylem server file still in src/', path.basename(f)); continue; }
  lines(f).forEach((l, i) => {
    if (/^\s*\/\//.test(l)) return; // comments may explain the boundary
    for (const m of l.matchAll(IMPORT)) {
      const spec = m[1];
      if (/(^|\/)modules\//.test(spec)) add(violations, f, i + 1, 'src imports modules/', l);
      const base = path.basename(spec).replace(/\.m?js$/, '');
      if (spec.startsWith('.') && XYLEM_FILES.includes(base)) add(violations, f, i + 1, `src imports Xylem (${base})`, l);
    }
    if (XYLEM_ROUTE.test(l)) add(violations, f, i + 1, 'src names a Xylem route', l);
    else if (/xylem/i.test(l)) add(info, f, i + 1, 'mentions Xylem', l);
  });
}

// 3: modules reach the platform only through ctx
const MODS = path.join(ROOT, 'modules');
for (const f of files(MODS, ['.js', '.mjs', '.cjs'])) {
  const own = rel(f).split('/')[1];
  lines(f).forEach((l, i) => {
    for (const m of l.matchAll(IMPORT)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = rel(path.resolve(path.dirname(f), spec));
      if (target.startsWith('src/')) add(violations, f, i + 1, 'module imports platform code', l);
      else if (target.startsWith('modules/') && target.split('/')[1] !== own) add(violations, f, i + 1, 'module imports another module', l);
    }
  });
}

// info: other places that still assume Xylem exists (dashboard, settings window, build) — M3's list
for (const f of [...files(path.join(ROOT, 'public'), ['.js', '.html']).filter((p) => !rel(p).startsWith('public/xylem/')), path.join(ROOT, 'tools/build-exe.mjs')]) {
  if (!fs.existsSync(f)) continue;
  lines(f).forEach((l, i) => { if (/xylem/i.test(l)) add(info, f, i + 1, 'mentions Xylem', l); });
}

const strict = args.has('--strict');
if (args.has('--json')) {
  console.log(JSON.stringify({ strict, violations, info }, null, 2));
} else {
  const group = (list) => {
    const by = new Map();
    for (const v of list) { const k = `${v.file}: ${v.rule}`; if (!by.has(k)) by.set(k, []); by.get(k).push(v.line); }
    return by;
  };
  console.log(`boundary check (${strict ? 'strict' : 'report only until M2'})`);
  console.log(`\nviolations: ${violations.length}`);
  for (const [k, ls] of group(violations)) console.log(`  ${k}  ×${ls.length}  (lines ${ls.slice(0, 12).join(', ')}${ls.length > 12 ? ', …' : ''})`);
  console.log(`\ninfo — Xylem mentions outside the rules above (M3): ${info.length}`);
  for (const [k, ls] of group(info)) console.log(`  ${k}  ×${ls.length}`);
}
process.exit(strict && violations.length ? 1 : 0);
