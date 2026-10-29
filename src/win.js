// Windows integration: finding and starting OBS, opening app windows,
// the tray icon, a native folder picker and "start with Windows".
// Everything is done through tools every Windows PC already has
// (PowerShell, reg, tasklist, Edge), so the exe needs no extra installs.
// On other platforms these are harmless no-ops (used for testing).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { cmpVersion } from './update.js';

export const isWin = process.platform === 'win32';
const OBS_DEBUG_ARGS = ['--remote-debugging-port=9222', '--remote-allow-origins=*'];

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err }),
    );
  });
}

// PowerShell via -EncodedCommand so Korean text survives intact.
function psArgs(script, sta = false) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...(sta ? ['-STA'] : []), '-WindowStyle', 'Hidden', '-EncodedCommand', enc];
}
function powershell(script, opts = {}) {
  return run('powershell.exe', psArgs(script, opts.sta), opts);
}

// ---------------- OBS ----------------
export async function findObs(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (isWin) {
    for (const key of ['HKLM\\SOFTWARE\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio']) {
      const r = await run('reg.exe', ['query', key, '/ve']);
      const m = /REG_SZ\s+(.+)/.exec(r.stdout);
      if (m) candidates.push(path.join(m[1].trim(), 'bin', '64bit', 'obs64.exe'));
    }
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (base) candidates.push(path.join(base, 'obs-studio', 'bin', '64bit', 'obs64.exe'));
    }
    candidates.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\OBS Studio\\bin\\64bit\\obs64.exe');
  }
  for (const c of candidates) {
    let p = c;
    // Accept the install folder too, not just the exe.
    try {
      if (fs.statSync(p).isDirectory()) p = path.join(p, 'bin', '64bit', 'obs64.exe');
    } catch {}
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// when the running OBS was started (Date ms), or null
export async function obsStartTime() {
  if (!isWin) return process.env.MOCK_OBS_UPTIME_H ? Date.now() - Number(process.env.MOCK_OBS_UPTIME_H) * 3600000 : null;
  const r = await powershell("$p = Get-Process obs64 -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { [Console]::Out.Write(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()) }", { timeout: 8000 });
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function isObsRunning() {
  if (!isWin) return false;
  const r = await run('tasklist.exe', ['/FI', 'IMAGENAME eq obs64.exe', '/NH']);
  return /obs64\.exe/i.test(r.stdout);
}

// Starts OBS from its own folder (or it can't find its files) with the
// browser-debugging flags. Goes through Start-Process (the same path as a
// double-click), so an OBS set to "Run as administrator" shows the normal
// Windows admin prompt instead of failing silently.
export async function launchObs(exe) {
  if (!isWin) throw new Error('OBS can only be started on Windows');
  const dir = path.dirname(exe);
  console.log(`[obs] launching ${exe}`);
  const r = await powershell(
    `$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath $env:SD_OBS -WorkingDirectory $env:SD_DIR -WindowStyle Normal -ArgumentList @('--remote-debugging-port=9222', '--remote-allow-origins=*')
  [Console]::Out.Write('ok')
} catch {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write('ERR:' + $_.Exception.Message)
}`,
    { timeout: 120000, env: { ...process.env, SD_OBS: exe, SD_DIR: dir } },
  );
  const out = (r.stdout || '').trim();
  console.log(`[obs] Start-Process -> ${out || '(no output)'} ${r.stderr ? 'stderr: ' + r.stderr.trim() : ''}`);
  if (out === 'ok') return;
  // Rare: PowerShell itself unavailable. Fall back to a direct launch.
  if (!out.startsWith('ERR:')) {
    await new Promise((resolve, reject) => {
      const child = spawn(exe, OBS_DEBUG_ARGS, { cwd: dir, detached: true, stdio: 'ignore' });
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('error', (e) => reject(new Error(e.code === 'UNKNOWN' || e.errno === -4094 ? '관리자 권한이 필요해요' : e.message)));
    });
    return;
  }
  const msg = out.slice(4);
  // "The operation was canceled by the user" = the admin prompt was declined.
  if (/cancel|취소/i.test(msg)) throw new Error('관리자 권한 요청이 취소됐어요');
  throw new Error(msg);
}

// ---------------- windows & browser ----------------
function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ];
  for (const r of rel) for (const base of pf) {
    const p = path.join(base, ...r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Opens a page as its own app-style window (no tabs or address bar).
export function openAppWindow(url, { width = 480, height = 760 } = {}) {
  if (!isWin) {
    console.log(`[window] would open ${url}`);
    return;
  }
  const browser = findBrowser();
  if (browser) {
    const c = spawn(browser, [`--app=${url}`, `--window-size=${width},${height}`], { detached: true, stdio: 'ignore' });
    c.on('error', () => openInDefaultBrowser(url));
    c.unref();
    stampAppWindows(); // make the taskbar show it as Allmind, not Edge
  } else {
    openInDefaultBrowser(url);
  }
}

// ---------------- taskbar identity ----------------
// The Allmind window is Edge (or Chrome) in app mode, so the taskbar would call it "Microsoft Edge"
// and pinning it would pin Edge. Windows lets a window carry its own taskbar identity (AppUserModelID +
// "relaunch" command/name/icon); we set those on our app windows so they group as "Allmind" and
// "Pin to taskbar" creates an Allmind shortcut that starts the exe. The exe it points at must keep
// working across updates, so each start keeps a copy of the launcher at a fixed path.
export function stableLauncherPath() {
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Allmind', 'Allmind.exe') : null;
}
export function ensureStableLauncher(version) {
  const from = process.env.ALLMIND_LAUNCHER; // set by the launcher exe that started us
  const to = stableLauncherPath();
  if (!isWin || !from || !to) return;
  try {
    const verFile = path.join(path.dirname(to), 'launcher.version');
    if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return; // we were started from it
    const have = fs.existsSync(to) && fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf8').trim() : '';
    if (have && cmpVersion(have, version) >= 0) return; // same or newer is already there
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to + '.tmp');
    fs.renameSync(to + '.tmp', to);
    fs.writeFileSync(verFile, version);
    console.log(`[window] launcher copy for the taskbar: ${to}`);
  } catch (e) {
    console.log(`[window] couldn't keep a launcher copy: ${e.message}`);
  }
}

// The exe the owner double-clicks (a download, a desktop shortcut…) is a self-contained snapshot of ONE
// version, so after an in-app update it would still start the old one — and ask for the update again.
// The launcher passes on which file the chain started from (ALLMIND_ORIGIN, kept across updates) and
// which exe started this process (ALLMIND_LAUNCHER). When those differ — we were started by an update —
// the original file is overwritten with the new launcher, in place and under the same name, so
// shortcuts to it keep working. Never replaces a file that is newer than ours (mtime), never fails loudly.
export function replaceLauncher(origin, from, log = console.log) {
  try {
    if (!origin || !from) return 'none';
    const o = path.resolve(origin);
    const f = path.resolve(from);
    if (o.toLowerCase() === f.toLowerCase()) return 'same';
    if (!fs.existsSync(o) || !fs.existsSync(f)) return 'missing';
    const so = fs.statSync(o);
    const sf = fs.statSync(f);
    if (so.size === sf.size) {
      const h = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (h(o) === h(f)) return 'synced';
    }
    if (so.mtimeMs > sf.mtimeMs) return 'newer'; // someone put a newer exe there
    const tmp = `${o}.new`;
    fs.copyFileSync(f, tmp);
    try { fs.utimesSync(tmp, sf.atime, sf.mtime); } catch {} // keep "same as the source" for the check above
    try {
      fs.renameSync(tmp, o); // replaces the old file when nothing holds it open
    } catch {
      // held open (virus scanner, still running): a running exe can be renamed, just not replaced
      const old = `${o}.old`;
      try {
        fs.rmSync(old, { force: true });
        fs.renameSync(o, old);
        fs.renameSync(tmp, o);
        try { fs.rmSync(old, { force: true }); } catch {}
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        try { if (!fs.existsSync(o) && fs.existsSync(old)) fs.renameSync(old, o); } catch {}
        throw e;
      }
    }
    log(`[update] replaced ${o} with the new version`);
    return 'replaced';
  } catch (e) {
    log(`[update] couldn't update ${origin}: ${e.message}`);
    return 'failed';
  }
}
export function syncOriginLauncher() {
  return isWin ? replaceLauncher(process.env.ALLMIND_ORIGIN, process.env.ALLMIND_LAUNCHER) : 'none';
}

const STAMP_SCRIPT = `
$ErrorActionPreference = 'Stop'
if (-not ('AllmindWin' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AllmindWin {
  [StructLayout(LayoutKind.Sequential)] public struct PKEY { public Guid fmt; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PKEY k);
    [PreserveSig] int GetValue(ref PKEY k, out PV v);
    [PreserveSig] int SetValue(ref PKEY k, ref PV v);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static void SetStr(IPropertyStore ps, uint pid, string s) {
    PKEY k = new PKEY(); k.fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = pid;
    PV v = new PV(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(s);
    ps.SetValue(ref k, ref v);
  }
  static string GetStr(IPropertyStore ps, uint pid) {
    PKEY k = new PKEY(); k.fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = pid;
    PV v;
    if (ps.GetValue(ref k, out v) != 0 || v.vt != 31 || v.p == IntPtr.Zero) return "";
    return Marshal.PtrToStringUni(v.p) ?? "";
  }
  // Allmind's own app windows: titled exactly "Allmind" (settings, dashboard) or "Xylem", owned by Edge/Chrome
  // (a normal browser tab's window would be "Allmind - Microsoft Edge").
  // Only (re)stamps a window whose identity isn't ours yet — Edge may reset it after we set it.
  public static int Stamp(string id, string cmd, string name, string icon, string titles) {
    string[] want = titles.Split('|');
    int n = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      string title = sb.ToString();
      if (Array.FindIndex(want, t => t.Equals(title, StringComparison.OrdinalIgnoreCase)) < 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string pn = ""; try { pn = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch {}
      if (pn != "msedge" && pn != "chrome") return true;
      Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
      IPropertyStore ps;
      if (SHGetPropertyStoreForWindow(h, ref iid, out ps) != 0 || ps == null) return true;
      if (GetStr(ps, 5) == id) return true;
      SetStr(ps, 5, id); SetStr(ps, 2, cmd); SetStr(ps, 4, name); SetStr(ps, 3, icon);
      ps.Commit(); n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
}
$exe = $env:SD_EXE
$total = 0
for ($i = 0; $i -lt 30; $i++) {
  $total += [AllmindWin]::Stamp('Hoshia.Allmind', ('"' + $exe + '"'), 'Allmind', ($exe + ',0'), 'Allmind|Xylem')
  Start-Sleep -Milliseconds 500
}
[Console]::Out.Write("stamped $total")
`;
let stamping = false;
let lastStamp = 0;
// also called by the settings page when it loads or gets focus (POST /api/launcher/taskbar): the window may
// appear later than the 15 s after we open it (slow Edge start, Edge restoring it) or Edge may reset it
export function stampAppWindows() {
  const exe = stableLauncherPath();
  if (!isWin || !exe || !fs.existsSync(exe) || stamping || Date.now() - lastStamp < 5000) return;
  stamping = true;
  lastStamp = Date.now();
  powershell(STAMP_SCRIPT, { timeout: 40000, env: { ...process.env, SD_EXE: exe } }).then((r) => {
    stamping = false;
    const out = r.ok ? r.stdout.trim() : `failed — ${(r.stderr || r.err?.message || '').trim().slice(0, 300)}`;
    if (out !== 'stamped 0') console.log(`[window] taskbar identity: ${out}`);
  });
}

export function openInDefaultBrowser(url) {
  if (!isWin) return console.log(`[browser] would open ${url}`);
  // Not `cmd /c start`: cmd treats every & in the address as "next command", so a login URL such as
  // …?clientId=…&redirectUri=…&state=… arrived cut off after the first parameter (치지직: "state 존재하지 않습니다").
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// The real Desktop folder (it can be moved into OneDrive, so ask Windows).
export async function desktopDir() {
  if (isWin) {
    const r = await powershell("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write([Environment]::GetFolderPath('Desktop'))");
    const d = r.stdout.trim();
    if (d && fs.existsSync(d)) return d;
  }
  return path.join(os.homedir(), 'Desktop');
}
export function showInFolder(file) {
  if (isWin) spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
  else console.log(`[window] would show ${file}`);
}

export function openFolder(dir) {
  if (isWin) spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
}

// A plain Windows message box (used when there's no window to show errors in).
export async function alertBox(text, title = 'Allmind') {
  if (!isWin) return console.error(`[alert] ${text}`);
  await powershell(
    `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:SD_TEXT, $env:SD_TITLE)`,
    { timeout: 10 * 60 * 1000, env: { ...process.env, SD_TEXT: text, SD_TITLE: title } },
  );
}

// ---------------- native folder picker ----------------
export async function pickFolder(start) {
  if (!isWin) return null;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'BGM 음악 폴더를 선택하세요'
$d.ShowNewFolderButton = $false
$start = $env:SD_START
if ($start -and (Test-Path -LiteralPath $start)) { $d.SelectedPath = $start }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`;
  const r = await powershell(script, { sta: true, timeout: 10 * 60 * 1000, env: { ...process.env, SD_START: start || '' } });
  const out = r.stdout.trim();
  return out || null;
}

// ---------------- firewall ----------------
// Without an inbound rule the main PC's connection just times out.
// Reading rules needs no admin; adding one shows the Windows admin prompt.
const FW_NAME = 'Allmind';
const FW_NAMES_OLD = ['Arkbird', 'Stream Desk']; // rule names before the renames; still honoured, replaced on next "방화벽 허용"
const FW_ALL = [FW_NAME, ...FW_NAMES_OLD].map((n) => `'${n}'`).join(',');
export async function firewallStatus(port) {
  if (!isWin) return { ok: true, checked: false };
  const r = await powershell(`
$r = Get-NetFirewallRule -DisplayName ${FW_ALL} -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
$ports = @($r | Get-NetFirewallPortFilter | ForEach-Object { $_.LocalPort })
[Console]::Out.Write(($ports -join ','))`);
  const ports = r.stdout.trim().split(',').filter(Boolean);
  return { ok: ports.includes(String(port)) || ports.includes('Any'), checked: true };
}
export async function allowFirewall(port) {
  if (!isWin) return;
  const inner = `Remove-NetFirewallRule -DisplayName ${FW_ALL} -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName '${FW_NAME}' -Direction Inbound -Protocol TCP -LocalPort ${Number(port)} -Action Allow -Profile Any | Out-Null`;
  const enc = Buffer.from(inner, 'utf16le').toString('base64');
  const r = await powershell(
    `$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${enc}')
  [Console]::Out.Write('ok')
} catch {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write('ERR:' + $_.Exception.Message)
}`,
    { timeout: 120000 },
  );
  const out = r.stdout.trim();
  console.log(`[firewall] add rule -> ${out}`);
  if (out.startsWith('ERR:')) throw new Error(/cancel|취소/i.test(out) ? '관리자 권한 요청이 취소됐어요' : out.slice(4));
}

// ---------------- start with Windows ----------------
function startupDir() {
  return path.join(process.env.APPDATA || os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function startupShortcut() {
  return path.join(startupDir(), 'Allmind.lnk');
}
export function runAtLoginEnabled() {
  return isWin && fs.existsSync(startupShortcut());
}
export async function setRunAtLogin(on, exe) {
  if (!isWin) return;
  const lnk = startupShortcut();
  if (!on) {
    try { fs.unlinkSync(lnk); } catch {}
    return;
  }
  await powershell(`
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SD_LNK)
$s.TargetPath = $env:SD_EXE
$s.WorkingDirectory = Split-Path -Parent $env:SD_EXE
$s.Arguments = '--minimized'
$s.Save()
`, { env: { ...process.env, SD_LNK: lnk, SD_EXE: exe } });
}

// ---------------- tray icon ----------------
// A tiny PowerShell process owns the tray icon and prints the menu choice
// on stdout. It exits on its own if Allmind goes away.
export function startTray({ exe, onOpen, onDashboard, onXylem, onQuit, labels }) {
  if (!isWin) return null;
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$ni = New-Object System.Windows.Forms.NotifyIcon
try { $ni.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:SD_EXE) } catch { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'Allmind'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Say($w) { [Console]::Out.WriteLine($w); [Console]::Out.Flush() }
$a = $menu.Items.Add($env:SD_L_OPEN); $a.add_Click({ Say 'open' })
$b = $menu.Items.Add($env:SD_L_DASH); $b.add_Click({ Say 'dashboard' })
if ($env:SD_L_XYLEM) { $x = $menu.Items.Add($env:SD_L_XYLEM); $x.add_Click({ Say 'xylem' }) }
[void]$menu.Items.Add('-')
$c = $menu.Items.Add($env:SD_L_QUIT); $c.add_Click({ Say 'quit'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Say 'open' } })
$ni.Visible = $true
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 2000
$t.add_Tick({ if (-not (Get-Process -Id ([int]$env:SD_PID) -ErrorAction SilentlyContinue)) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$t.Start()
[System.Windows.Forms.Application]::Run()
`;
  const child = spawn('powershell.exe', psArgs(script, true), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, SD_EXE: exe, SD_PID: String(process.pid), SD_L_OPEN: labels.open, SD_L_DASH: labels.dashboard, SD_L_XYLEM: labels.xylem || '', SD_L_QUIT: labels.quit },
  });
  child.on('error', () => {});
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (cmd === 'open') onOpen();
      if (cmd === 'dashboard') onDashboard();
      if (cmd === 'xylem') onXylem?.();
      if (cmd === 'quit') onQuit();
    }
  });
  const kill = () => { try { child.kill(); } catch {} };
  process.on('exit', kill);
  return { stop: kill };
}
