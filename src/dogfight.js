// 공중전 (dogfight) overlay — the server half.
// The game itself runs in the OBS browser source (public/xylem/dogfight.html, part of the Xylem pack).
// This only relays chat commands (!출격, !미사일 …) to it, and
// keeps the pilot scoreboard (wins/kills) across streams in DATA_DIR/dogfight.json, plus the
// game mode (개인전 / 팀전 with 2–4 owner-named teams) and the last team results.
// Costs nothing while no overlay is connected.
import { loadState, saveState } from './config.js';

const MAX_PILOTS = 2000;
export const TEAM_COLORS = ['#ff5a5a', '#4f9dff', '#ffd34d', '#5be37d'];
const DEFAULT_TEAMS = [{ name: '레드', color: TEAM_COLORS[0] }, { name: '블루', color: TEAM_COLORS[1] }, { name: '옐로', color: TEAM_COLORS[2] }, { name: '그린', color: TEAM_COLORS[3] }];

// mode: 'solo' | 'team'; teams: 2–4 of { name, color }
export function cleanMode(input, old = { mode: 'solo', teams: DEFAULT_TEAMS.slice(0, 2) }) {
  const s = { ...old, ...(input || {}) };
  const raw = Array.isArray(s.teams) ? s.teams.slice(0, 4) : old.teams;
  const teams = raw.map((t, i) => ({
    name: String(t?.name || '').replace(/\s+/g, ' ').trim().slice(0, 12) || DEFAULT_TEAMS[i].name,
    color: /^#[0-9a-f]{6}$/i.test(t?.color || '') ? t.color : TEAM_COLORS[i],
  }));
  while (teams.length < 2) teams.push({ ...DEFAULT_TEAMS[teams.length] });
  const names = new Set();
  for (const [i, t] of teams.entries()) { if (names.has(t.name)) t.name = `${t.name}${i + 1}`; names.add(t.name); }
  return { mode: s.mode === 'team' ? 'team' : 'solo', teams };
}

export class Dogfight {
  constructor(chzzk, pack) {
    const saved = loadState('dogfight', {});
    this.pilots = saved.pilots && typeof saved.pilots === 'object' ? saved.pilots : {};
    this.cfg = cleanMode(saved.cfg);
    this.teamLog = Array.isArray(saved.teamLog) ? saved.teamLog.slice(-20) : []; // { at, winner, color, teams:[{name, alive, jets}] }
    this.ch = pack.channel(() => [['board', this.board()], ['mode', this.cfg]]);
    chzzk.on('live-chat', (list) => {
      if (!this.ch.size) return;
      for (const m of list) {
        if (m.hidden) continue;
        if (m.kind === 'chat' && /^\s*!/.test(m.text || '')) {
          this.send('cmd', { uid: m.uid, nick: m.nick, role: m.role, text: m.text.trim().slice(0, 40) });
        } // donations change nothing in the game (owner: no pay-to-win)
      }
    });
  }

  get overlays() { return this.ch.size; }
  send(event, data) { this.ch.send(event, data); }
  // GET /api/dogfight/events
  attach(req, res) { this.ch.attach(req, res); }

  // Test / manual input: POST /api/dogfight/cmd {nick, text}
  inject({ nick, text, uid, role }) {
    const n = String(nick || '테스트').slice(0, 20);
    this.send('cmd', { uid: String(uid || `test:${n}`), nick: n, role: role || '', text: String(text || '!출격').slice(0, 40) });
  }

  _save() { saveState('dogfight', { pilots: this.pilots, cfg: this.cfg, teamLog: this.teamLog }); }

  // POST /api/dogfight/mode {mode, teams}
  setMode(input) {
    this.cfg = cleanMode(input, this.cfg);
    this._save();
    this.send('mode', this.cfg);
    return this.cfg;
  }
  status() { return { ...this.cfg, teamLog: this.teamLog.slice().reverse() }; }

  // POST /api/dogfight/result {winner:uid|null, pilots:[{uid,nick,kills}], team?:{winner, color, teams}}
  result(b) {
    if (b?.team && typeof b.team === 'object') {
      const t = b.team;
      this.teamLog.push({
        at: Date.now(), winner: String(t.winner || '').slice(0, 12) || null, color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : null,
        teams: (Array.isArray(t.teams) ? t.teams.slice(0, 4) : []).map((x) => ({ name: String(x?.name || '').slice(0, 12), alive: Math.max(0, Math.min(50, Number(x?.alive) || 0)), jets: Math.max(0, Math.min(50, Number(x?.jets) || 0)), humans: Math.max(0, Math.min(50, Number(x?.humans) || 0)) })),
      });
      if (this.teamLog.length > 20) this.teamLog.splice(0, this.teamLog.length - 20);
      console.log(`[dogfight] 팀전 결과: ${this.teamLog.at(-1).winner || '무승부'}`);
    }
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
    this._save();
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
    this._save();
    this.send('board', []);
  }
}
