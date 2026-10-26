// 공중전 (dogfight) overlay — the server half.
// The game itself runs in the OBS browser source (public/dogfight.html).
// This only relays chat commands (!출격, !미사일 …) and donations to it, and
// keeps the pilot scoreboard (wins/kills) across streams in DATA_DIR/dogfight.json.
// Costs nothing while no overlay is connected.
import { loadState, saveState } from './config.js';

const MAX_PILOTS = 2000;

export class Dogfight {
  constructor(chzzk) {
    this.clients = new Set();
    const saved = loadState('dogfight', {});
    this.pilots = saved.pilots && typeof saved.pilots === 'object' ? saved.pilots : {};
    chzzk.on('live-chat', (list) => {
      if (!this.clients.size) return;
      for (const m of list) {
        if (m.hidden) continue;
        if (m.kind === 'chat' && /^\s*!/.test(m.text || '')) {
          this.send('cmd', { uid: m.uid, nick: m.nick, role: m.role, text: m.text.trim().slice(0, 40) });
        } else if (m.kind === 'donation' && m.uid) {
          this.send('donation', { uid: m.uid, nick: m.nick, amount: m.amount || 0 });
        }
      }
    });
  }

  send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  // GET /api/dogfight/events
  attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: board\ndata: ${JSON.stringify(this.board())}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  // Test / manual input: POST /api/dogfight/cmd {nick, text}
  inject({ nick, text, uid, role }) {
    const n = String(nick || '테스트').slice(0, 20);
    this.send('cmd', { uid: String(uid || `test:${n}`), nick: n, role: role || '', text: String(text || '!출격').slice(0, 40) });
  }

  // POST /api/dogfight/result {winner:uid|null, pilots:[{uid,nick,kills}]}
  result(b) {
    const list = Array.isArray(b?.pilots) ? b.pilots.slice(0, 50) : [];
    const now = Date.now();
    for (const p of list) {
      const uid = String(p?.uid || '');
      if (!uid || uid.startsWith('bot:')) continue;
      const rec = (this.pilots[uid] ||= { nick: '', wins: 0, kills: 0, sorties: 0 });
      rec.nick = String(p.nick || rec.nick).slice(0, 20);
      rec.kills += Math.max(0, Math.min(50, Number(p.kills) || 0));
      rec.sorties += 1;
      rec.last = now;
      if (b.winner === uid) rec.wins += 1;
    }
    const ids = Object.keys(this.pilots);
    if (ids.length > MAX_PILOTS) {
      ids.sort((a, b2) => (this.pilots[a].last || 0) - (this.pilots[b2].last || 0));
      for (const id of ids.slice(0, ids.length - MAX_PILOTS)) delete this.pilots[id];
    }
    saveState('dogfight', { pilots: this.pilots });
    const board = this.board();
    this.send('board', board);
    return { board };
  }

  board() {
    return Object.entries(this.pilots)
      .map(([uid, p]) => ({ uid, nick: p.nick, wins: p.wins, kills: p.kills, sorties: p.sorties }))
      .sort((a, b) => b.wins - a.wins || b.kills - a.kills || b.sorties - a.sorties)
      .slice(0, 5);
  }

  reset() {
    this.pilots = {};
    saveState('dogfight', { pilots: {} });
    this.send('board', []);
  }
}
