// Windows integration: finding and starting OBS, opening app windows,
// the tray icon, a native folder picker and "start with Windows".
// Everything is done through tools every Windows PC already has
// (PowerShell, reg, tasklist, Edge), so the exe needs no extra installs.
// On other platforms these are harmless no-ops (used for testing).
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  } else {
    openInDefaultBrowser(url);
  }
}

export function openInDefaultBrowser(url) {
  if (!isWin) return console.log(`[browser] would open ${url}`);
  spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function openFolder(dir) {
  if (isWin) spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
}

// A plain Windows message box (used when there's no window to show errors in).
export async function alertBox(text, title = 'Arkbird') {
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
const FW_NAME = 'Arkbird';
const FW_NAME_OLD = 'Stream Desk'; // rule name before the rename; still honoured, replaced on next "방화벽 허용"
export async function firewallStatus(port) {
  if (!isWin) return { ok: true, checked: false };
  const r = await powershell(`
$r = Get-NetFirewallRule -DisplayName '${FW_NAME}','${FW_NAME_OLD}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
$ports = @($r | Get-NetFirewallPortFilter | ForEach-Object { $_.LocalPort })
[Console]::Out.Write(($ports -join ','))`);
  const ports = r.stdout.trim().split(',').filter(Boolean);
  return { ok: ports.includes(String(port)) || ports.includes('Any'), checked: true };
}
export async function allowFirewall(port) {
  if (!isWin) return;
  const inner = `Remove-NetFirewallRule -DisplayName '${FW_NAME}','${FW_NAME_OLD}' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName '${FW_NAME}' -Direction Inbound -Protocol TCP -LocalPort ${Number(port)} -Action Allow -Profile Any | Out-Null`;
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
  return path.join(startupDir(), 'Arkbird.lnk');
}
const startupShortcutOld = () => path.join(startupDir(), 'Stream Desk.lnk'); // before the rename
export function runAtLoginEnabled() {
  return isWin && (fs.existsSync(startupShortcut()) || fs.existsSync(startupShortcutOld()));
}
export async function setRunAtLogin(on, exe) {
  if (!isWin) return;
  const lnk = startupShortcut();
  try { fs.unlinkSync(startupShortcutOld()); } catch {}
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
// on stdout. It exits on its own if Arkbird goes away.
export function startTray({ exe, onOpen, onDashboard, onQuit, labels }) {
  if (!isWin) return null;
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$ni = New-Object System.Windows.Forms.NotifyIcon
try { $ni.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:SD_EXE) } catch { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'Arkbird'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Say($w) { [Console]::Out.WriteLine($w); [Console]::Out.Flush() }
$a = $menu.Items.Add($env:SD_L_OPEN); $a.add_Click({ Say 'open' })
$b = $menu.Items.Add($env:SD_L_DASH); $b.add_Click({ Say 'dashboard' })
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
    env: { ...process.env, SD_EXE: exe, SD_PID: String(process.pid), SD_L_OPEN: labels.open, SD_L_DASH: labels.dashboard, SD_L_QUIT: labels.quit },
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
      if (cmd === 'quit') onQuit();
    }
  });
  const kill = () => { try { child.kill(); } catch {} };
  process.on('exit', kill);
  return { stop: kill };
}
