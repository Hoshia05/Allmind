// Unit tests for the remote-access modes (src/netmode.js, docs/plans/remote-access.md). No mock needed:
//   node --test tools/dev/test-netmode.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, classify, allowed, modeOf, hostFor, proxyHeader, parseDnsName } from '../../src/netmode.js';

test('modes', () => assert.deepEqual(MODES, ['off', 'lan', 'tailscale']));

test('classify: loopback', () => {
  for (const a of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) assert.equal(classify(a), 'loopback', a);
});

test('classify: tailnet (100.64.0.0/10 and fd7a:115c:a1e0::/48)', () => {
  for (const a of ['100.64.0.1', '100.100.100.100', '100.127.255.254', '::ffff:100.101.2.3', 'fd7a:115c:a1e0::1',
    'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', 'FD7A:115C:A1E0:0:0:0:0:5']) assert.equal(classify(a), 'tailnet', a);
});

test('classify: private LAN (RFC 1918, link-local, IPv6 ULA and link-local)', () => {
  for (const a of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.31.113', '::ffff:192.168.0.10', '169.254.10.20',
    'fd00::1', 'fc12:3456::9', 'fe80::1', 'fe80::1%12', 'fd7a:115c:a1e1::1']) assert.equal(classify(a), 'private', a);
});

test('classify: public', () => {
  for (const a of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '1.1.1.1',
    '2001:4860:4860::8888', '::ffff:203.0.113.9']) assert.equal(classify(a), 'public', a);
});

test('classify: garbage is public (refused unless lan/tailscale rules say otherwise — they do not)', () => {
  for (const a of ['', undefined, null, 'abc', '999.1.1.1']) assert.equal(classify(a), 'public', String(a));
});

test('allowed: the stream PC itself always, in every mode', () => {
  for (const m of MODES) for (const c of ['loopback', 'tailnet', 'private', 'public']) assert.equal(allowed(m, c, true), true, `${m}/${c}`);
});

test('allowed: the mode table for other devices', () => {
  const table = {
    off: { loopback: true, tailnet: false, private: false, public: false },
    lan: { loopback: true, tailnet: true, private: true, public: false },
    tailscale: { loopback: true, tailnet: true, private: false, public: false },
  };
  for (const [m, row] of Object.entries(table)) for (const [c, want] of Object.entries(row)) assert.equal(allowed(m, c, false), want, `${m}/${c}`);
  assert.equal(allowed('bogus', 'private', false), false, 'unknown mode allows nothing but self');
});

test('modeOf: explicit setting wins, else migrated from host (today\'s behavior)', () => {
  assert.equal(modeOf({ host: '0.0.0.0' }), 'lan');
  assert.equal(modeOf({}), 'lan');
  assert.equal(modeOf(undefined), 'lan');
  assert.equal(modeOf({ host: '127.0.0.1' }), 'off');
  assert.equal(modeOf({ host: 'localhost' }), 'off');
  assert.equal(modeOf({ host: '::1' }), 'off');
  assert.equal(modeOf({ host: '0.0.0.0', remoteAccess: 'tailscale' }), 'tailscale');
  assert.equal(modeOf({ host: '127.0.0.1', remoteAccess: 'lan' }), 'lan');
  assert.equal(modeOf({ host: '127.0.0.1', remoteAccess: 'nonsense' }), 'off');
});

test('hostFor: bind address per mode', () => {
  assert.equal(hostFor('off'), '127.0.0.1');
  assert.equal(hostFor('lan'), '0.0.0.0');
  assert.equal(hostFor('tailscale'), '0.0.0.0');
});

test('proxyHeader: Tailscale Serve/Funnel markers (Node lower-cases header names)', () => {
  assert.equal(proxyHeader({ host: '127.0.0.1:8080', accept: '*/*' }), null);
  for (const h of ['tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info', 'tailscale-funnel-request', 'x-forwarded-for', 'x-forwarded-host']) {
    assert.equal(proxyHeader({ host: 'x', [h]: 'v' }), h, h);
  }
  assert.equal(proxyHeader({ 'tailscale-user-login': '' }), 'tailscale-user-login', 'present but empty still counts');
});

test('parseDnsName: Self.DNSName without the trailing dot, only *.ts.net-style FQDNs of this PC', () => {
  assert.deepEqual(parseDnsName(JSON.stringify({ Self: { DNSName: 'stream-pc.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] } })),
    { name: 'stream-pc.tail1234.ts.net', ips: ['100.101.102.103', 'fd7a:115c:a1e0::1'] });
  assert.deepEqual(parseDnsName(JSON.stringify({ Self: { DNSName: '', TailscaleIPs: [] } })), { name: null, ips: [] });
  assert.deepEqual(parseDnsName('not json'), { name: null, ips: [] });
  assert.deepEqual(parseDnsName(JSON.stringify({ Self: { DNSName: '*.ts.net.' } })), { name: null, ips: [] }, 'never a wildcard');
  assert.deepEqual(parseDnsName(JSON.stringify({ Self: { DNSName: 'Bad Name!.ts.net.' } })), { name: null, ips: [] });
  assert.deepEqual(parseDnsName(JSON.stringify({ Self: { DNSName: 'pc.x.ts.net.', TailscaleIPs: ['8.8.8.8', '100.70.0.1'] } })),
    { name: 'pc.x.ts.net', ips: ['100.70.0.1'] }, 'only tailnet IPs kept');
});
