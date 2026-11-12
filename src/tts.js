// Text-to-speech for the 시청자 추첨 (docs/plans/draw.md). OBS's browser source (CEF) has no dependable
// speechSynthesis, so the stream PC renders the speech: Windows' built-in Korean voice through PowerShell
// (System.Speech) → a small WAV file → the draw overlay plays it with <audio>, so OBS mixes it like any other
// browser source. One line is synthesised at a time, at most MAX_QUEUE wait. Files live in DATA_DIR/tts/ under
// a random id (the overlay fetches them without the PIN) and are deleted after KEEP_MS.
// Off Windows (the mock, development) it writes a silent WAV of roughly the right length instead.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'tts');
const KEEP_MS = 10 * 60 * 1000;
const MAX_QUEUE = 5;
const TIMEOUT_MS = 25000;
const isWin = process.platform === 'win32';

// the Korean voices Windows ships are picked in this order: the one the owner chose, Heami, any Korean voice
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $vs = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  if ($env:ALLMIND_TTS_MODE -eq 'list') {
    $out = @($vs | ForEach-Object { [pscustomobject]@{ name = $_.Name; culture = $_.Culture.Name } })
    [Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress))
    exit 0
  }
  $pick = $null
  if ($env:ALLMIND_TTS_VOICE) { $pick = $vs | Where-Object { $_.Name -eq $env:ALLMIND_TTS_VOICE } | Select-Object -First 1 }
  if (-not $pick) { $pick = $vs | Where-Object { $_.Culture.Name -like 'ko*' -and $_.Name -like '*Heami*' } | Select-Object -First 1 }
  if (-not $pick) { $pick = $vs | Where-Object { $_.Culture.Name -like 'ko*' } | Select-Object -First 1 }
  if (-not $pick) { [Console]::Error.Write('NOVOICE'); exit 3 }
  $s.SelectVoice($pick.Name)
  $s.SetOutputToWaveFile($env:ALLMIND_TTS_OUT)
  $s.Speak($env:ALLMIND_TTS_TEXT)
} finally { $s.Dispose() }
`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

function ps(env, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], {
      windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill(); reject(new Error('음성을 만드는 데 너무 오래 걸렸어요')); }, timeout);
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`PowerShell을 실행하지 못했어요 (${e.message})`)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve(out);
      if (/NOVOICE/.test(err) || code === 3) return reject(new Error('한국어 음성이 설치돼 있지 않아요 — Windows 설정 → 시간 및 언어 → 음성에서 한국어를 추가해 주세요'));
      reject(new Error(`음성을 만들지 못했어요 (${(err || out).trim().split(/\r?\n/)[0].slice(0, 120) || code})`));
    });
  });
}

// WAV header of a PCM file → length in ms (0 when it isn't a plain PCM WAV)
export function wavMs(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
    const byteRate = buf.readUInt32LE(28);
    // find the "data" chunk (a synthesiser may add extra chunks before it)
    let o = 12;
    while (o + 8 <= buf.length) {
      const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
      if (id === 'data') return byteRate ? Math.round((Math.min(size, buf.length - o - 8) / byteRate) * 1000) : 0;
      o += 8 + size + (size % 2);
    }
  } catch {}
  return 0;
}

// silent 16 kHz mono WAV, about as long as the line would take to say
export function silentWav(text) {
  const ms = Math.min(12000, Math.max(600, 350 + [...String(text)].length * 120));
  const rate = 16000, n = Math.round((rate * ms) / 1000), bytes = n * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

// What is worth reading aloud: no links, no {:emoticon:} tokens, no emoji, short.
export function speakable(text, maxLen = 60) {
  let t = String(text ?? '')
    .replace(/\{:[^:{}]+:\}/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, ' ')
    .replace(/[~*_`<>|\\^]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const max = Math.max(10, Math.min(200, Number(maxLen) || 60));
  const chars = [...t];
  if (chars.length > max) t = chars.slice(0, max).join('').trim() + '…';
  // nothing but punctuation / "ㅋㅋㅋㅋ" is noise, not speech
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

export class Tts {
  constructor() {
    this.queue = []; // { text, voice, resolve, reject }
    this.busy = false;
    this.files = new Map(); // id → { file, at, ms }
    this.voiceList = null;
    this.sweepT = null;
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} // leftovers of an earlier run
  }

  get real() { return isWin; }
  get waiting() { return this.queue.length + (this.busy ? 1 : 0); }

  // → { id, url, ms }; lines wait their turn (first in, first spoken)
  synth(text, voice = '') {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE) return reject(new Error('읽을 글이 너무 밀려 있어요'));
      this.queue.push({ text, voice, resolve, reject });
      this._next();
    });
  }

  async _next() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try { job.resolve(await this._render(job.text, job.voice)); } catch (e) { job.reject(e); }
    this.busy = false;
    this._next();
  }

  async _render(text, voice) {
    fs.mkdirSync(DIR, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const file = path.join(DIR, `${id}.wav`);
    if (isWin) {
      const t0 = Date.now();
      await ps({ ALLMIND_TTS_MODE: 'speak', ALLMIND_TTS_TEXT: text, ALLMIND_TTS_OUT: file, ALLMIND_TTS_VOICE: voice || '' });
      if (!fs.existsSync(file)) throw new Error('음성 파일이 만들어지지 않았어요');
      console.log(`[tts] "${text.slice(0, 30)}" → ${Date.now() - t0} ms`);
    } else {
      fs.writeFileSync(file, silentWav(text));
      console.log(`[tts] (Windows가 아니라 무음) "${text.slice(0, 30)}"`);
    }
    const ms = wavMs(fs.readFileSync(file));
    this.files.set(id, { file, at: Date.now(), ms });
    this._sweepLater();
    return { id, url: `/api/draw/tts/${id}.wav`, ms };
  }

  // the bytes for GET /api/draw/tts/<id>.wav (only ids we made; random 16 hex)
  read(id) {
    const f = /^[0-9a-f]{16}$/.test(String(id)) ? this.files.get(String(id)) : null;
    if (!f) return null;
    try { return fs.readFileSync(f.file); } catch { return null; }
  }

  async voices() {
    if (this.voiceList) return this.voiceList;
    if (!isWin) return (this.voiceList = []);
    try {
      const raw = (await ps({ ALLMIND_TTS_MODE: 'list' }, 15000)).trim();
      const arr = raw ? JSON.parse(raw) : [];
      this.voiceList = (Array.isArray(arr) ? arr : [arr]).filter((v) => v?.name);
    } catch { this.voiceList = []; }
    return this.voiceList;
  }

  // a timer exists only while there are files to clean up (nothing runs while no draw has spoken)
  _sweepLater() {
    if (this.sweepT || !this.files.size) return;
    this.sweepT = setTimeout(() => { this.sweepT = null; this._sweep(); this._sweepLater(); }, 60000);
    this.sweepT.unref?.();
  }
  _sweep() {
    const now = Date.now();
    for (const [id, f] of this.files) {
      if (now - f.at > KEEP_MS) { try { fs.unlinkSync(f.file); } catch {} this.files.delete(id); }
    }
  }
}
