// Settings export / import ("설정 내보내기 / 가져오기"), to set Allmind up on another PC.
//
// The file holds config.json + the small state files in data\ (logins included), encrypted with a
// passphrase the owner types: scrypt (N=2^16, r=8, p=1) → 256-bit key → AES-256-GCM. Without the
// passphrase the file is unreadable — there is deliberately no key built into Allmind (anyone could
// pull that out of the exe). GCM also detects a wrong passphrase or a damaged file.
//
// File (UTF-8 JSON, extension .allmind):
//   { format: 'allmind-settings', v: 1, app, created, kdf: { name: 'scrypt', N, r, p, salt },
//     cipher: 'aes-256-gcm', iv, tag, data }      (salt/iv/tag/data base64; data = gzip(JSON payload))
// payload: { config: <config.json as saved>, state: { <name>: <data\name.json> }, from: { app, version, host, created } }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const FORMAT = 'allmind-settings';
const KDF = { N: 2 ** 16, r: 8, p: 1 };
// Local-only state that would be wrong on another PC.
const SKIP_STATE = new Set(['uploads']); // Drive queue: paths to recordings on this PC

function key(passphrase, salt, k = KDF) {
  return crypto.scryptSync(String(passphrase).normalize('NFC'), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 });
}

export function checkPassphrase(p) {
  if (String(p || '').length < 8) throw new Error('비밀번호는 8자 이상으로 해 주세요');
}

// What goes into the file.
export function collect({ configPath, dataDir, version }) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  const state = {};
  let names = [];
  try { names = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of names) {
    const name = f.slice(0, -5);
    if (SKIP_STATE.has(name)) continue;
    try { state[name] = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch {}
  }
  return { config, state, from: { app: 'Allmind', version, host: os.hostname(), created: new Date().toISOString() } };
}

export function encrypt(payload, passphrase) {
  checkPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const data = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(payload)))), c.final()]);
  return JSON.stringify({
    format: FORMAT, v: 1, app: payload.from?.app, version: payload.from?.version, created: payload.from?.created,
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  });
}

export function decrypt(text, passphrase) {
  let f;
  try { f = JSON.parse(String(text)); } catch { throw new Error('Allmind 설정 파일이 아니에요'); }
  if (f?.format !== FORMAT) throw new Error('Allmind 설정 파일이 아니에요');
  if (f.v !== 1 || f.cipher !== 'aes-256-gcm' || f.kdf?.name !== 'scrypt') throw new Error('더 새로운 Allmind에서 만든 파일이에요 — Allmind를 업데이트해 주세요');
  const k = { N: Number(f.kdf.N), r: Number(f.kdf.r), p: Number(f.kdf.p) };
  if (!(k.N >= 2 ** 14 && k.N <= 2 ** 20 && k.r >= 1 && k.r <= 32 && k.p >= 1 && k.p <= 4)) throw new Error('파일이 손상됐어요');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(f.kdf.salt, 'base64'), k), Buffer.from(f.iv, 'base64'));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]);
    return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  } catch {
    throw new Error('비밀번호가 틀렸거나 파일이 손상됐어요');
  }
}

// A short, secret-free description for the confirm step.
export function summary(payload) {
  const c = payload.config || {};
  const s = payload.state || {};
  return {
    from: payload.from || {},
    obs: !!c.obs?.password,
    channel: c.chzzk?.channelId || '',
    bgmFolder: c.bgm?.folder || '',
    sbFolder: c.soundboard?.folder || '',
    google: !!s['google-auth'],
    chzzkLogin: !!s['chzzk-auth'],
    youtubeKey: !!s.youtube?.streamId,
    items: Object.keys(s).sort(),
  };
}

// Replace this PC's settings with the backup. The current ones are copied aside first.
export function apply(payload, { configPath, dataDir, configDir }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const aside = path.join(configDir, `가져오기 전 백업 ${stamp}`);
  fs.mkdirSync(path.join(aside, 'data'), { recursive: true });
  try { fs.copyFileSync(configPath, path.join(aside, 'config.json')); } catch {}
  try { for (const f of fs.readdirSync(dataDir)) if (f.endsWith('.json')) fs.copyFileSync(path.join(dataDir, f), path.join(aside, 'data', f)); } catch {}

  const write = (file, obj) => { fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2)); fs.renameSync(file + '.tmp', file); };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  write(configPath, payload.config || {});
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, value] of Object.entries(payload.state || {})) {
    if (!/^[\w.-]+$/.test(name) || SKIP_STATE.has(name)) continue; // never write outside data\
    write(path.join(dataDir, `${name}.json`), value);
  }
  return { aside };
}
