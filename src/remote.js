// Presses buttons on Chzzk's own 리모컨 page (studio.chzzk.naver.com/<id>/remotecontrol).
//
// 넘기기 / 알림 정지 are server-side commands that only the logged-in 리모컨
// can send. So the 리모컨 runs as an OBS custom browser dock (logged in once,
// OBS remembers it), and Stream Desk clicks its buttons through the same
// DevTools link it uses for the 영도. The labels we show are read live from
// the 리모컨 itself, so they always match its real state.
import { EventEmitter } from 'node:events';

// Button text patterns (Korean UI). Kept loose on purpose; see `buttons` in
// status() for what was actually found if Chzzk renames them.
const SKIP = /넘기기|건너뛰기|스킵/;
const PAUSE = /알림\s*(정지|재개|시작|켜기|끄기)/;

// The playing 영도 in the list has a round green button with a stop square
// (others have purple play buttons). It has no text, so look for a stop-ish
// label first, then for "the green button".
function stopScript(click) {
  return `(() => {
    const CLICK = ${click ? 'true' : 'false'};
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    const isAlertBtn = (e) => /알림|넘기기/.test(norm(e.innerText));
    const isGreen = (el) => [el, ...el.querySelectorAll('*')].slice(0, 6).some((x) => {
      const cs = getComputedStyle(x);
      for (const c of [cs.backgroundColor, cs.fill, cs.color]) {
        const m = (c || '').match(/[\\d.]+/g);
        if (!m || m.length < 3) continue;
        const [r, g, b, a = 1] = m.map(Number);
        if (a > 0.5 && g > 140 && g > r + 50 && g > b + 20) return true;
      }
      return false;
    });
    const labelled = btns.find((e) => !isAlertBtn(e) && /정지|중지|멈춤|stop/i.test([e.getAttribute('aria-label'), e.title, norm(e.innerText)].join(' ')));
    const green = labelled ? null : btns.find((e) => !isAlertBtn(e) && isGreen(e));
    const btn = labelled || green;
    if (!btn) return null;
    const item = btn.closest('li, article, [class*="item"], [class*="Item"]');
    const info = item ? norm(item.innerText).slice(0, 90) : '';
    if (CLICK) btn.click();
    return { via: labelled ? 'label' : 'green', info };
  })()`;
}

const READ_SCRIPT = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const els = [...document.querySelectorAll('button, [role="button"]')];
  const buttons = els.map((b) => norm(b.innerText || b.getAttribute('aria-label'))).filter(Boolean);
  const text = norm(document.body ? document.body.innerText : '');
  return { buttons: [...new Set(buttons)].slice(0, 60), needsLogin: /로그인이 필요|로그인 하세요|로그인해 주세요/.test(text), title: document.title };
})()`;

function clickScript(pattern) {
  return `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const re = new RegExp(${JSON.stringify(pattern.source)});
    const els = [...document.querySelectorAll('button, [role="button"]')];
    const b = els.find((e) => re.test(norm(e.innerText || e.getAttribute('aria-label'))) && !e.disabled);
    if (!b) return null;
    b.click();
    return norm(b.innerText || b.getAttribute('aria-label'));
  })()`;
}

export class ChzzkRemote extends EventEmitter {
  constructor(config) {
    super();
    this.port = config.interact.debugPort;
    this.ws = null;
    this.connected = false;
    this.error = null;
    this.state = { buttons: [], needsLogin: false };
    this.nextId = 1;
    this.pending = new Map();
    this._loop();
  }

  async _loop() {
    while (true) {
      if (!this.connected) {
        try {
          await this._connect();
        } catch (e) {
          this._set({ error: e.message });
        }
      } else {
        await this._read();
      }
      await new Promise((r) => setTimeout(r, this.connected ? 2000 : 5000));
    }
  }

  _set(patch) {
    const before = JSON.stringify(this.status());
    Object.assign(this, patch);
    if (JSON.stringify(this.status()) !== before) this.emit('change');
  }

  async _connect() {
    let list;
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
      list = await res.json();
    } catch {
      throw new Error('OBS를 Stream Desk에서 시작해야 해요 (클릭 전달과 같은 조건)');
    }
    const t = list.find((x) => x.type === 'page' && /studio\.chzzk\.naver\.com\/.+\/remotecontrol/.test(x.url));
    if (!t) throw new Error('OBS에 치지직 리모컨 독이 없어요');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        reject(new Error('리모컨 독에 연결하지 못했어요'));
        if (this.ws !== ws) return;
        this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error('closed'));
        this.pending.clear();
        this._set({ connected: false, error: '리모컨 독 연결이 끊김 — 다시 연결 중…' });
      };
      ws.addEventListener('open', () => {
        this.ws = ws;
        this._set({ connected: true, error: null });
        console.log('[remote] connected to', t.url);
        resolve();
      });
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        const p = msg.id && this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      });
      ws.addEventListener('error', end);
      ws.addEventListener('close', end);
    });
    await this._read();
  }

  _eval(expression) {
    if (!this.ws) return Promise.reject(new Error('리모컨 독에 연결되어 있지 않아요'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('리모컨이 응답하지 않아요')); }, 3000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r?.result?.value); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  }

  async _read() {
    try {
      const st = await this._eval(READ_SCRIPT);
      const playing = await this._eval(stopScript(false)).catch(() => null);
      if (st) this._set({ state: { ...st, video: playing } });
    } catch {
      /* connection handler deals with drops */
    }
  }

  async _press(pattern, what) {
    const label = await this._eval(clickScript(pattern));
    if (!label) {
      const found = this.state.buttons.join(', ') || '(없음)';
      console.log(`[remote] no ${what} button; buttons on the page: ${found}`);
      throw new Error(`리모컨에서 "${what}" 버튼을 찾지 못했어요`);
    }
    console.log(`[remote] pressed "${label}"`);
    setTimeout(() => this._read(), 400); // label may change (알림 정지 → 알림 재개)
    return { pressed: label };
  }

  skip() {
    return this._press(SKIP, '넘기기');
  }

  togglePause() {
    return this._press(PAUSE, '알림 정지');
  }

  // Stops the 영도 that's playing right now (the 리모컨's green ■ button).
  async stopVideo() {
    const r = await this._eval(stopScript(true));
    if (!r) throw new Error('지금 재생 중인 영도가 없어요 (리모컨에 정지 버튼이 없음)');
    console.log(`[remote] stopped 영도 (${r.via}): ${r.info}`);
    setTimeout(() => this._read(), 400);
    return { pressed: '영도 정지', info: r.info };
  }

  status() {
    const buttons = this.state?.buttons || [];
    return {
      connected: this.connected,
      error: this.connected ? null : this.error,
      needsLogin: !!this.state?.needsLogin,
      skipLabel: buttons.find((b) => SKIP.test(b)) || null,
      videoPlaying: !!this.state?.video,
      videoInfo: this.state?.video?.info || null,
      pauseLabel: buttons.find((b) => PAUSE.test(b)) || null,
      buttons,
    };
  }
}
