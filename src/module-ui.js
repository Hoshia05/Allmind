// M3 (docs/plans/modules.md): which desktop UI the platform shows for loaded modules. Pure functions, no I/O, so the
// decisions are unit-tested (tools/dev/test-module-ui.mjs); what they feed (tray icon, taskbar tagging) is untested on real
// Windows by these tests. The platform never names a module: a module that wants its own app window declares it in its
// module.json (`window`), and a module whose window holds the settings of a platform service lists it (`settings`).
//   "window": { "path": "/<id>", "title": "Xylem", "tray": "Xylem 열기 (룰렛·게임)", "width": 1200, "height": 900 }
//   "settings": ["vts"]
const TITLE_RE = /^[^|"'`$\\\r\n]{1,32}$/; // a window title (also the taskbar-tag match); no | (the list separator) or quotes
const LABEL_RE = /^[^\r\n]{1,48}$/;

// manifests: [{ id, window?, settings? }] (loaded modules only) → [{ id, path, title, tray, width, height, settings }]
export function moduleWindows(manifests = []) {
  const out = [];
  for (const m of manifests) {
    const w = m && m.window;
    if (!w || typeof w !== 'object') continue;
    const id = String(m.id || '');
    if (typeof w.path !== 'string' || !(w.path === `/${id}` || w.path.startsWith(`/${id}/`) || w.path.startsWith(`/${id}?`))) continue;
    if (typeof w.title !== 'string' || !TITLE_RE.test(w.title) || w.title.toLowerCase() === 'allmind') continue;
    const tray = typeof w.tray === 'string' && LABEL_RE.test(w.tray) ? w.tray : '';
    const size = (v, d) => (Number.isInteger(v) && v >= 320 && v <= 4000 ? v : d);
    const settings = Array.isArray(m.settings) ? m.settings.filter((s) => typeof s === 'string') : [];
    out.push({ id, path: w.path, title: w.title, tray, width: size(w.width, 1200), height: size(w.height, 900), settings });
  }
  return out;
}

// Tray: none at all off the desktop (ALLMIND_DEV=1, or not Windows). One module slot (the first window with a tray label).
export function trayPlan({ desktop, windows = [] }) {
  if (!desktop) return null;
  const w = windows.find((x) => x.tray);
  return { module: w ? { label: w.tray, path: w.path, width: w.width, height: w.height } : null };
}

// Taskbar tagging: which window titles get Allmind's identity ('Allmind|<module titles>'); null = don't tag (dev / not Windows).
export function stampTitles({ desktop, windows = [] }) {
  if (!desktop) return null;
  return ['Allmind', ...windows.map((w) => w.title)].join('|');
}

// Where the owner turns a platform service off (preflight hint): '<module title> → VTube Studio', or '' when no loaded module
// has those settings (then the hint doesn't point at a page that isn't there).
export function settingsPlace(windows = [], service) {
  const w = windows.find((x) => x.settings.includes(service));
  if (!w) return '';
  return service === 'vts' ? `${w.title} → VTube Studio` : w.title;
}

// Preflight: the fix line for a VTube Studio that isn't ready.
export function vtsFixHint({ ready, remote, place }) {
  if (ready) return '';
  if (remote) {
    return place
      ? `VTube Studio가 켜져 있고 API가 켜져 있는지 확인 — VTube Studio가 이 PC에 있으면 주소를 127.0.0.1:8001로 (${place}), 안 쓰면 거기서 끄기`
      : 'VTube Studio가 켜져 있고 API가 켜져 있는지 확인 — VTube Studio가 이 PC에 있으면 주소를 127.0.0.1:8001로';
  }
  return place ? `VTube Studio와 API가 켜져 있는지 확인 — 안 쓰면 ${place}에서 끄기` : 'VTube Studio와 API가 켜져 있는지 확인';
}
