// Remote-access modes (docs/plans/remote-access.md): who may connect besides the stream PC itself.
//   off       — only this PC (Allmind binds 127.0.0.1)
//   lan       — this PC, private home-network addresses and the tailnet; public source addresses are refused
//   tailscale — this PC and the tailnet only (100.64.0.0/10, fd7a:115c:a1e0::/48 — Tailscale kb/1015, kb/1033)
// Pure functions, no I/O: unit-tested in tools/dev/test-netmode.mjs.
import net from 'node:net';

export const MODES = ['off', 'lan', 'tailscale'];

const TAILNET = new net.BlockList();
TAILNET.addSubnet('100.64.0.0', 10, 'ipv4');
TAILNET.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // unique local (the tailnet's IPv6 range is inside; checked first)
PRIVATE.addSubnet('fe80::', 10, 'ipv6'); // link-local

const clean = (a) => String(a ?? '').trim().replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').toLowerCase();

// → 'loopback' | 'tailnet' | 'private' | 'public' (anything unparseable counts as public, i.e. refused by every mode)
export function classify(addr) {
  const a = clean(addr);
  const v = net.isIP(a);
  if (!v) return 'public';
  const type = v === 4 ? 'ipv4' : 'ipv6';
  if (v === 4 ? a.startsWith('127.') : a === '::1') return 'loopback';
  if (TAILNET.check(a, type)) return 'tailnet';
  if (PRIVATE.check(a, type)) return 'private';
  return 'public';
}

// self = the request comes from the stream PC itself (access.js isSelf): always allowed, so OBS sources, the settings
// window and a local assistant never lock out.
export function allowed(mode, cls, self) {
  if (self || cls === 'loopback') return true;
  if (mode === 'lan') return cls === 'private' || cls === 'tailnet';
  if (mode === 'tailscale') return cls === 'tailnet';
  return false; // off, or anything unknown
}

// The setting, migrated on read: an explicit valid server.remoteAccess wins; otherwise today's host decides
// (127.0.0.1 = 다른 기기에서 열기 off → 'off', anything else → 'lan'), so nothing changes until the owner picks a mode.
export function modeOf(server) {
  const s = server || {};
  if (MODES.includes(s.remoteAccess)) return s.remoteAccess;
  return ['127.0.0.1', 'localhost', '::1'].includes(String(s.host || '0.0.0.0')) ? 'off' : 'lan';
}
export const hostFor = (mode) => (mode === 'off' ? '127.0.0.1' : '0.0.0.0');

// Headers Tailscale Serve/Funnel add when proxying to a local backend (ipn/ipnlocal/serve.go, kb/1312). A request from
// loopback carrying one of them came through Serve/Funnel, not from the stream PC: refused in every mode.
const PROXY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info', 'tailscale-funnel-request', 'x-forwarded-for', 'x-forwarded-host'];
export function proxyHeader(headers) {
  for (const h of PROXY_HEADERS) if (headers?.[h] !== undefined) return h;
  return null;
}

// `tailscale status --json` → this PC's own MagicDNS name (Self.DNSName, FQDN with a trailing dot) and tailnet IPs.
// Only a plain DNS name is accepted (never a wildcard); IPs outside the tailnet ranges are dropped.
export function parseDnsName(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { name: null, ips: [] }; }
  const raw = String(j?.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  const name = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null;
  const ips = name ? (Array.isArray(j?.Self?.TailscaleIPs) ? j.Self.TailscaleIPs : []).map(String).filter((ip) => classify(ip) === 'tailnet') : [];
  return { name, ips };
}
