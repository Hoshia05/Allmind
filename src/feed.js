// A live picture of one OBS source, pushed to every open dashboard.
//
// Frames come from OBS screenshots, which show exactly what OBS renders,
// video included. To get a higher frame rate than one-request-at-a-time
// allows, several screenshot requests are kept in flight, staggered, and
// any frame that arrives out of order is dropped.
// While the picture isn't changing, it slows to a couple of checks a second.
// Nothing runs unless someone is watching.
import { EventEmitter } from 'node:events';

export class FrameFeed extends EventEmitter {
  constructor({ name, grab, fps = 20, idleFps = 2, parallel = 2 }) {
    super();
    this.name = name;
    this.grab = grab;
    this.fps = fps;       // target from the quality preset
    this.fpsCap = fps;    // lowered automatically if OBS starts skipping frames
    this.idleFps = idleFps;
    this.parallel = Math.max(1, Math.min(4, parallel));
    this.subs = new Set();
    this.latest = null; // { buf, type, at, via }
    this.running = false;
    this.gen = 0; // bumps on each start so old workers exit
    this.sentTimes = [];
    this.mode = 'idle';
    this.grabMs = 0; // rolling average screenshot time, for the log/badge
    this.errorUntil = 0;
  }

  subscribe(fn) {
    this.subs.add(fn);
    // Chrome only draws a frame of a live picture stream once the next one
    // starts arriving, so a new viewer gets the current frame twice.
    if (this.latest) {
      fn(this.latest);
      setTimeout(() => this.subs.has(fn) && this.latest && fn(this.latest), 100);
    }
    this._start();
    return () => {
      this.subs.delete(fn);
      if (!this.subs.size) this._stop();
    };
  }

  _emit(frame) {
    if (!this.loggedFirst) {
      this.loggedFirst = true;
      const head = frame.buf.subarray(0, 4).toString('hex');
      console.log(`[feed:${this.name}] first frame: ${frame.type}, ${frame.buf.length} bytes, starts ${head} (ffd8=JPEG, 89504e47=PNG), via ${frame.via}`);
    }
    this.latest = frame;
    this.lastEmitAt = Date.now();
    const now = Date.now();
    this.sentTimes.push(now);
    while (this.sentTimes.length && now - this.sentTimes[0] > 1000) this.sentTimes.shift();
    for (const fn of this.subs) fn(frame);
  }

  _start() {
    if (this.running) return;
    this.running = true;
    const gen = ++this.gen;
    this._schedule(gen);
  }

  _stop() {
    this.running = false;
    this.loggedFirst = false;
    this.mode = 'idle';
  }

  // One request every 1/fps seconds, with up to `parallel` waiting on OBS at
  // once. A fixed rhythm (rather than independent loops) keeps the requests
  // evenly spaced, so they land on different video frames.
  async _schedule(gen) {
    let inflight = 0;
    let lastStart = 0;
    let prev = null;
    let unchanged = 0;
    // Adaptive rate: count how many grabs per second brought a *new* picture.
    // A 30 fps video sampled at 60 gives half duplicates, so aim just above
    // the real change rate instead of the preset's maximum. Saves OBS work.
    let windowStart = Date.now();
    let grabsInWindow = 0;
    let changesInWindow = 0;
    this.adaptive = this.fps;
    let next = Date.now();
    while (this.running && this.gen === gen) {
      const idle = unchanged > 3;
      const limit = idle ? 1 : this.parallel;
      if (inflight >= limit) {
        await sleep(5);
        continue;
      }
      const started = Date.now();
      inflight++;
      this.grab()
        .then((frame) => {
          if (!this.running || this.gen !== gen) return;
          const took = Date.now() - started;
          this.grabMs = this.grabMs ? this.grabMs * 0.9 + took * 0.1 : took;
          if (started <= lastStart) return; // an older request finished late
          lastStart = started;
          if (prev && frame.buf.equals(prev)) {
            unchanged++;
            grabsInWindow++;
            // Picture isn't changing: still resend it about once a second, so
            // the dashboard shows it (and knows the feed is alive).
            if (Date.now() - (this.lastEmitAt || 0) > 900) this._emit({ ...frame, via: 'obs' });
          } else {
            unchanged = 0;
            grabsInWindow++;
            changesInWindow++;
            prev = frame.buf;
            this._emit({ ...frame, via: 'obs' });
          }
          this.mode = unchanged > 3 ? 'obs-idle' : 'obs';
        })
        .catch(() => { this.errorUntil = Date.now() + 1000; })
        .finally(() => { inflight--; });
      if (Date.now() - windowStart >= 1000) {
        const secs = (Date.now() - windowStart) / 1000;
        const changing = changesInWindow / secs;
        // Mostly-duplicate grabs → settle a bit above the real rate; if nearly
        // every grab is new, the source may be faster than we sample → go up.
        if (grabsInWindow > 5) {
          const dupShare = 1 - changesInWindow / grabsInWindow;
          this.adaptive = dupShare > 0.1 ? Math.max(15, Math.ceil(changing * 1.15) + 2) : Math.min(this.fps, this.adaptive + 10);
        }
        windowStart = Date.now();
        grabsInWindow = 0;
        changesInWindow = 0;
      }
      next += unchanged > 3 ? 1000 / this.idleFps : 1000 / Math.min(this.fps, this.fpsCap, this.adaptive || this.fps);
      if (this.errorUntil > Date.now()) next = Math.max(next, this.errorUntil);
      const now = Date.now();
      if (next < now - 200) next = now; // fell behind (slow OBS): don't burst to catch up
      if (next > now) await sleep(next - now);
    }
  }

  setTarget(fps, parallel) {
    this.fps = fps;
    this.fpsCap = fps;
    if (parallel) this.parallel = Math.max(1, Math.min(4, parallel));
  }

  stats() {
    const now = Date.now();
    return {
      fps: this.sentTimes.filter((t) => now - t <= 1000).length,
      mode: this.running ? this.mode : 'idle',
      viewers: this.subs.size,
      target: Math.min(this.fps, this.fpsCap, this.adaptive || this.fps),
      limited: this.fpsCap < this.fps,
      why: this.fpsCap < this.fps ? this.guardWhy || '' : '',
      grabMs: Math.round(this.grabMs),
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
