// Loop finder for game music (docs/plans/bgm-loop.md). Runs inside a worker thread (see bgmloop.js) — kept as
// plain CommonJS-free code in one function so it can be started with `eval` from the single-file exe.
//   input : { pcm: Int16Array (48 kHz stereo interleaved), sr }
//   output: { found, start, end, loopLen, score, matchSec, fadeAt } — times in seconds
export function findLoop({ pcm, sr }) {
  const n = pcm.length / 2;
  // mono at sr/2 for the coarse search
  const half = Math.floor(n / 2);
  const mono = new Float32Array(half);
  for (let i = 0; i < half; i++) mono[i] = (pcm[4 * i] + pcm[4 * i + 1] + pcm[4 * i + 2] + pcm[4 * i + 3]) / (4 * 32768);
  const SR2 = sr / 2;

  // ---- features: 48 log bands per frame ----
  const NFFT = 4096, HOP = 2048, NB = 48;
  const nfr = Math.max(0, Math.floor((half - NFFT) / HOP));
  const fps = SR2 / HOP;
  if (nfr < fps * 40) return { found: false, reason: 'short' };
  const win = new Float32Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1));
  // FFT tables
  const rev = new Uint32Array(NFFT);
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float32Array(NFFT / 2), sinT = new Float32Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / NFFT); sinT[i] = -Math.sin((2 * Math.PI * i) / NFFT); }
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  // band edges (bins), 60 Hz … 8 kHz
  const edges = [];
  for (let b = 0; b <= NB; b++) edges.push(Math.min(NFFT / 2, Math.round((60 * Math.pow(8000 / 60, b / NB) * NFFT) / SR2)));
  const F = new Float32Array(nfr * NB);
  for (let f = 0; f < nfr; f++) {
    const o = f * HOP;
    for (let i = 0; i < NFFT; i++) { re[rev[i]] = mono[o + i] * win[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= NFFT; size <<= 1) {
      const h = size >> 1, step = NFFT / size;
      for (let s = 0; s < NFFT; s += size) {
        for (let k = 0; k < h; k++) {
          const c = cosT[k * step], si = sinT[k * step];
          const a = s + k, b = a + h;
          const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    let mean = 0;
    for (let b = 0; b < NB; b++) {
      let sum = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) sum += Math.hypot(re[k], im[k]);
      const v = Math.log1p(sum * 10);
      F[f * NB + b] = v; mean += v;
    }
    mean /= NB;
    let norm = 0;
    for (let b = 0; b < NB; b++) { const v = F[f * NB + b] - mean; F[f * NB + b] = v; norm += v * v; }
    norm = Math.sqrt(norm) + 1e-9;
    for (let b = 0; b < NB; b++) F[f * NB + b] /= norm;
  }

  // ---- loop length: the lag where the music matches itself for the longest stretch ----
  const W = Math.round(8 * fps);
  let best = null;
  const sim = new Float32Array(nfr);
  for (let T = Math.round(20 * fps); T < nfr - W; T++) {
    const m = nfr - T;
    for (let t = 0; t < m; t++) {
      let d = 0;
      const a = t * NB, b = (t + T) * NB;
      for (let k = 0; k < NB; k++) d += F[a + k] * F[b + k];
      sim[t] = d;
    }
    // moving average over W frames, longest run above 0.9
    let acc = 0, run = 0, longest = 0, at = 0, peak = 0;
    for (let t = 0; t < m; t++) {
      acc += sim[t];
      if (t >= W) acc -= sim[t - W];
      if (t < W - 1) continue;
      const c = acc / W;
      if (c > peak) peak = c;
      if (c > 0.9) { run++; if (run > longest) { longest = run; at = t - W + 1 - run + 1; } } else run = 0;
    }
    if (!best || longest > best.longest) best = { T, longest, at, peak };
  }
  if (!best || best.longest < 8 * fps) return { found: false, reason: 'no-repeat', matchSec: best ? best.longest / fps : 0 };
  const coarseLen = (best.T * HOP * 2); // in full-rate samples
  const repeatAt = best.at * HOP * 2;
  const matchSamples = (best.longest + W) * HOP * 2;

  // ---- exact loop length: cross-correlation (6 kHz, then full rate) at several points of the repeat ----
  const D = 8, SR8 = sr / D;
  const n8 = Math.floor(n / D);
  const m8 = new Float32Array(n8);
  for (let i = 0; i < n8; i++) { let s = 0; for (let j = 0; j < D; j++) s += pcm[2 * (i * D + j)] + pcm[2 * (i * D + j) + 1]; m8[i] = s / (2 * D * 32768); }
  const monoAt = (i) => (pcm[2 * i] + pcm[2 * i + 1]) / 65536;
  const corr8 = (t, L) => {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < SR8; i++) { const x = m8[t + i], y = m8[t + L + i]; ab += x * y; aa += x * x; bb += y * y; }
    return ab / (Math.sqrt(aa * bb) + 1e-12);
  };
  const corrFull = (t, L, len) => {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < len; i++) { const x = monoAt(t + i), y = monoAt(t + L + i); ab += x * y; aa += x * x; bb += y * y; }
    return ab / (Math.sqrt(aa * bb) + 1e-12);
  };
  const votes = new Map();
  const span = matchSamples - sr;
  for (let p = 0; p < 7; p++) {
    const t = repeatAt + Math.round((span * (p + 0.5)) / 7);
    if (t + coarseLen + sr * 2 > n) continue;
    const t8 = Math.floor(t / D), L8 = Math.round(coarseLen / D);
    let b8 = null;
    for (let d = -Math.round(0.08 * SR8); d <= Math.round(0.08 * SR8); d++) {
      const c = corr8(t8, L8 + d);
      if (!b8 || c > b8.c) b8 = { c, L: (L8 + d) * D };
    }
    if (b8.c < 0.8) continue;
    let bf = null;
    for (let d = -2 * D; d <= 2 * D; d++) {
      const c = corrFull(t, b8.L + d, Math.round(sr / 2));
      if (!bf || c > bf.c) bf = { c, L: b8.L + d };
    }
    votes.set(bf.L, (votes.get(bf.L) || 0) + bf.c);
  }
  if (!votes.size) return { found: false, reason: 'no-exact', matchSec: best.longest / fps };
  const L = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // ---- where the track fades out (last second still at full volume) ----
  const secs = Math.floor(n / sr);
  const rms = new Float32Array(secs);
  for (let s = 0; s < secs; s++) {
    let e = 0;
    for (let i = s * sr; i < (s + 1) * sr; i += 4) { const v = monoAt(i); e += v * v; }
    rms[s] = Math.sqrt(e / (sr / 4));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let fadeAt = secs;
  for (let s = secs - 1; s > 0; s--) if (rms[s] > 0.7 * median) { fadeAt = s; break; }

  // ---- seam: where pass 1 and pass 2 sound most alike (0.5 s window, stereo), after the intro, before the fade ----
  const Wn = Math.round(sr / 2), stepN = Math.round(sr / 20);
  const from = Math.max(Wn, repeatAt - 20 * sr), to = Math.min((fadeAt - 2) * sr - L, n - L - Wn);
  let seam = null;
  for (let t = from; t < to; t += stepN) {
    let e = 0, d = 0;
    for (let i = t - Wn / 2; i < t + Wn / 2; i += 2) {
      for (let c = 0; c < 2; c++) {
        const a = pcm[2 * i + c] / 32768, b = pcm[2 * (i + L) + c] / 32768;
        e += a * a; d += (a - b) * (a - b);
      }
    }
    if (e / Wn < 0.0004) continue; // too quiet to judge (and quiet seams can hide clicks less well)
    const rel = Math.sqrt(d / e);
    if (!seam || rel < seam.rel) seam = { rel, t };
  }
  if (!seam) return { found: false, reason: 'no-seam', matchSec: best.longest / fps };
  return {
    found: seam.rel < 0.45,
    reason: seam.rel < 0.45 ? null : 'weak',
    start: seam.t / sr,
    end: (seam.t + L) / sr,
    loopLen: L / sr,
    score: Math.max(0, Math.round((1 - seam.rel) * 100)),
    matchSec: Math.round((best.longest / fps) * 10) / 10,
    fadeAt,
  };
}
