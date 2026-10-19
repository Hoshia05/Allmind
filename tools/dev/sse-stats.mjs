// What the dashboard receives: events per second and KB/s, for N seconds.
//   node tools/dev/sse-stats.mjs [seconds=10]
const secs = Number(process.argv[2] || 10);
const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), secs * 1000);
const stats = {}; let buf = '';
try {
  const r = await fetch('http://127.0.0.1:8080/api/events', { signal: ctrl.signal });
  for await (const c of r.body) {
    buf += new TextDecoder().decode(c); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const name = /event: (\S+)/.exec(ev)?.[1] || 'msg';
      const s = (stats[name] ||= { n: 0, bytes: 0 }); s.n++; s.bytes += ev.length;
    }
  }
} catch {}
for (const [k, s] of Object.entries(stats)) console.log(k.padEnd(18), `${(s.n / secs).toFixed(1)}/s`, `${(s.bytes / secs / 1024).toFixed(1)} KB/s`);
