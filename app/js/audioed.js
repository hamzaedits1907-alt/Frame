// Frame Audio: a waveform audio editor with effects, noise reduction, AI voice and transcription.
import { h, iconBtn, toast, modal, pickFiles, debounce, uid, clamp, fmtTime } from './util.js';
import { icon } from './icons.js';
import { db } from './db.js';
import { showContextMenu, sliderRow } from './ui.js';
import { buildChain, VOICE_FX, detectBeats } from './audiofx.js';
import { audioBufferToWav } from './panels.js';

const SR_DEFAULT = 48000;
let actx = null;
const ac = () => { if (!actx) actx = new AudioContext(); if (actx.state === 'suspended') actx.resume(); return actx; };
const dB = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fromDB = (d) => Math.pow(10, d / 20);

// ---------- Buffer helpers ----------
function mkBuf(chs, sr) { const b = new AudioBuffer({ length: Math.max(1, chs[0].length), numberOfChannels: chs.length, sampleRate: sr }); chs.forEach((d, i) => b.copyToChannel(d, i)); return b; }
const chans = (b) => Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
function slice(b, a, z) { const s = Math.floor(a * b.sampleRate), e = Math.max(s + 1, Math.floor(z * b.sampleRate)); return mkBuf(chans(b).map((d) => d.slice(s, e)), b.sampleRate); }
function concat(list, sr, nch) {
  const len = list.reduce((s, b) => s + (b ? b.length : 0), 0), out = Array.from({ length: nch }, () => new Float32Array(Math.max(1, len)));
  let o = 0; for (const b of list) { if (!b) continue; for (let c = 0; c < nch; c++) out[c].set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), o); o += b.length; }
  return mkBuf(out, sr);
}
function conform(b, sr, nch) {
  // match channel count (sample rate handled by resample)
  if (b.numberOfChannels === nch) return b;
  return mkBuf(Array.from({ length: nch }, (_, c) => new Float32Array(b.getChannelData(Math.min(c, b.numberOfChannels - 1)))), b.sampleRate);
}
async function resample(b, sr) {
  if (b.sampleRate === sr) return b;
  const ctx = new OfflineAudioContext(b.numberOfChannels, Math.ceil(b.duration * sr), sr);
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
  return ctx.startRendering();
}
/** Run a WebAudio graph over a buffer offline. build(ctx, src) returns {output, start?, tail?} */
async function offline(b, build, { rate = 1, tail = 0 } = {}) {
  const len = Math.ceil((b.duration / rate + tail) * b.sampleRate);
  const ctx = new OfflineAudioContext(b.numberOfChannels, Math.max(1, len), b.sampleRate);
  const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
  const g = build(ctx, s); g.output.connect(ctx.destination); g.start?.(0); s.start();
  return ctx.startRendering();
}
const filt = (ctx, type, f, gain = 0, q = 0.7) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.gain.value = gain; x.Q.value = q; return x; };
function chainNodes(ctx, src, nodes) { let a = src; for (const n of nodes) { a.connect(n); a = n; } return { output: a }; }

// ---------- FFT / STFT (noise reduction, spectrogram, pitch) ----------
function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k], br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi; re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const hann = (n) => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
function noiseProfile(data, N = 2048) {
  const win = hann(N), prof = new Float32Array(N / 2 + 1); let frames = 0;
  for (let s = 0; s + N <= data.length; s += N / 2) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = data[s + i] * win[i];
    fft(re, im); for (let k = 0; k <= N / 2; k++) prof[k] += Math.hypot(re[k], im[k]); frames++;
  }
  for (let k = 0; k <= N / 2; k++) prof[k] /= Math.max(1, frames);
  return prof;
}
function spectralDenoise(data, prof, strength = 1.5, floor = 0.08, N = 2048) {
  const hop = N / 4, win = hann(N), out = new Float32Array(data.length + N), norm = new Float32Array(data.length + N);
  for (let s = -N; s < data.length; s += hop) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) { const j = s + i; re[i] = j >= 0 && j < data.length ? data[j] * win[i] : 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) {
      // Bins below ~25 Hz are DC / rumble: always remove them.
      const mag = Math.hypot(re[k], im[k]), g = k * (44100 / N) < 25 ? 0 : Math.max(floor, (mag - prof[k] * strength) / (mag || 1));
      re[k] *= g; im[k] *= g; if (k && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { const j = s + i; if (j >= 0 && j < out.length) { out[j] += re[i] * win[i]; norm[j] += win[i] * win[i]; } }
  }
  const res = new Float32Array(data.length); for (let i = 0; i < data.length; i++) res[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
  return res;
}
/** WSOLA time-stretch: factor > 1 = longer (slower), pitch unchanged. */
function timeStretch(x, factor, sr) {
  const N = Math.round(sr * 0.04), Ha = Math.round(N / 2), Hs = Math.round(Ha * factor), win = hann(N), tol = Math.round(sr * 0.01);
  const outLen = Math.ceil(x.length * factor) + N, y = new Float32Array(outLen), wsum = new Float32Array(outLen);
  let prevEnd = 0;
  for (let k = 0, outPos = 0; outPos + N < outLen; k++, outPos += Ha) {
    const ideal = Math.round(outPos / factor);
    let best = ideal;
    if (k > 0) {
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 4) {
        const st = ideal + d; if (st < 0 || st + N >= x.length) continue;
        let c = 0; for (let i = 0; i < N / 2; i += 8) c += x[st + i] * x[prevEnd + i] || 0;
        if (c > bestC) { bestC = c; best = st; }
      }
    }
    if (best + N >= x.length) break;
    for (let i = 0; i < N; i++) { y[outPos + i] += x[best + i] * win[i]; wsum[outPos + i] += win[i]; }
    prevEnd = best + Ha;
  }
  const len = Math.round(x.length * factor), r = new Float32Array(len);
  for (let i = 0; i < len; i++) r[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
  return r;
}

// ---------- Effects ----------
const P = (key, label, min, max, def, step = 1) => [key, label, min, max, def, step];
export const AUDIO_FX = {
  // Volume
  amplify: { cat: 'Volume', name: 'Amplify', params: [P('gain', 'Gain (dB)', -30, 30, 6, 0.5)], run: async (b, p) => mapSamples(b, (v) => v * fromDB(p.gain)) },
  normalize: { cat: 'Volume', name: 'Normalize', params: [P('peak', 'Peak (dB)', -12, 0, -1, 0.1)], run: async (b, p) => { let m = 0; for (const d of chans(b)) for (const v of d) m = Math.max(m, Math.abs(v)); const g = m ? fromDB(p.peak) / m : 1; return mapSamples(b, (v) => v * g); } },
  fadeIn: { cat: 'Volume', name: 'Fade in', params: [P('curve', 'Curve (1=linear)', 0.3, 3, 1, 0.1)], run: async (b, p) => mapSamples(b, (v, i, n) => v * Math.pow(i / n, p.curve)) },
  fadeOut: { cat: 'Volume', name: 'Fade out', params: [P('curve', 'Curve (1=linear)', 0.3, 3, 1, 0.1)], run: async (b, p) => mapSamples(b, (v, i, n) => v * Math.pow(1 - i / n, p.curve)) },
  silence: { cat: 'Volume', name: 'Silence', params: [], run: async (b) => mapSamples(b, () => 0) },
  // Time & pitch
  reverse: { cat: 'Time & pitch', name: 'Reverse', params: [], run: async (b) => mkBuf(chans(b).map((d) => d.slice().reverse()), b.sampleRate) },
  speed: { cat: 'Time & pitch', name: 'Speed (changes pitch)', params: [P('rate', 'Speed ×', 0.25, 4, 1.25, 0.05)], run: async (b, p) => offline(b, (ctx, s) => ({ output: s }), { rate: p.rate }) },
  tempo: { cat: 'Time & pitch', name: 'Tempo (keep pitch)', params: [P('rate', 'Tempo ×', 0.5, 2, 1.2, 0.05)], run: async (b, p) => mkBuf(chans(b).map((d) => timeStretch(d, 1 / p.rate, b.sampleRate)), b.sampleRate) },
  pitch: { cat: 'Time & pitch', name: 'Pitch shift (keep length)', params: [P('semi', 'Semitones', -12, 12, 3, 0.5)], run: async (b, p) => {
    const r = Math.pow(2, p.semi / 12);
    const stretched = mkBuf(chans(b).map((d) => timeStretch(d, r, b.sampleRate)), b.sampleRate);
    const out = await offline(stretched, (ctx, s) => ({ output: s }), { rate: r });
    return mkBuf(chans(out).map((d) => { const o = new Float32Array(b.length); o.set(d.subarray(0, b.length)); return o; }), b.sampleRate);
  } },
  // EQ & filters
  eq: { cat: 'EQ & filters', name: '3-band EQ', params: [P('low', 'Bass (dB)', -15, 15, 3, 0.5), P('mid', 'Mids (dB)', -15, 15, 0, 0.5), P('high', 'Treble (dB)', -15, 15, 2, 0.5)], run: async (b, p) => offline(b, (ctx, s) => chainNodes(ctx, s, [filt(ctx, 'lowshelf', 150, p.low), filt(ctx, 'peaking', 1200, p.mid, 0.8), filt(ctx, 'highshelf', 5000, p.high)])) },
  bass: { cat: 'EQ & filters', name: 'Bass boost', params: [P('gain', 'Boost (dB)', 1, 18, 8, 0.5), P('freq', 'Frequency', 40, 250, 110)], run: async (b, p) => offline(b, (ctx, s) => chainNodes(ctx, s, [filt(ctx, 'lowshelf', p.freq, p.gain)])) },
  highpass: { cat: 'EQ & filters', name: 'High-pass (remove rumble)', params: [P('freq', 'Cutoff (Hz)', 20, 2000, 90)], run: async (b, p) => offline(b, (ctx, s) => chainNodes(ctx, s, [filt(ctx, 'highpass', p.freq), filt(ctx, 'highpass', p.freq)])) },
  lowpass: { cat: 'EQ & filters', name: 'Low-pass (muffle)', params: [P('freq', 'Cutoff (Hz)', 200, 18000, 3000)], run: async (b, p) => offline(b, (ctx, s) => chainNodes(ctx, s, [filt(ctx, 'lowpass', p.freq), filt(ctx, 'lowpass', p.freq)])) },
  // Dynamics
  compressor: { cat: 'Dynamics', name: 'Compressor', params: [P('threshold', 'Threshold (dB)', -60, 0, -22), P('ratio', 'Ratio', 1, 20, 4, 0.5), P('makeup', 'Makeup (dB)', 0, 24, 6, 0.5)], run: async (b, p) => offline(b, (ctx, s) => { const c = ctx.createDynamicsCompressor(); c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.attack.value = 0.005; c.release.value = 0.15; const g = ctx.createGain(); g.gain.value = fromDB(p.makeup); return chainNodes(ctx, s, [c, g]); }) },
  limiter: { cat: 'Dynamics', name: 'Limiter', params: [P('ceiling', 'Ceiling (dB)', -12, 0, -1, 0.1), P('drive', 'Input gain (dB)', 0, 18, 4, 0.5)], run: async (b, p) => { const pre = mapSamples(b, (v) => v * fromDB(p.drive)); return mapSamples(pre, (v) => { const c = fromDB(p.ceiling); return Math.tanh(v / c) * c; }); } },
  gate: { cat: 'Dynamics', name: 'Noise gate', params: [P('threshold', 'Threshold (dB)', -80, -10, -45), P('release', 'Release (ms)', 10, 500, 120)], run: async (b, p) => {
    const thr = fromDB(p.threshold), rel = Math.exp(-1 / ((p.release / 1000) * b.sampleRate)), att = Math.exp(-1 / (0.002 * b.sampleRate));
    const env0 = new Float32Array(b.length); for (const d of chans(b)) for (let i = 0; i < d.length; i++) env0[i] = Math.max(env0[i], Math.abs(d[i]));
    let e = 0, g = 0; const gain = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) { e = env0[i] > e ? env0[i] : e * 0.9995; const target = e > thr ? 1 : 0; g = target > g ? target + (g - target) * att : target + (g - target) * rel; gain[i] = g; }
    return mkBuf(chans(b).map((d) => d.map((v, i) => v * gain[i])), b.sampleRate);
  } },
  // Repair
  denoise: { cat: 'Repair', name: 'Noise reduction', params: [P('strength', 'Reduction', 0.5, 4, 1.6, 0.1), P('floor', 'Keep (floor)', 0.01, 0.5, 0.08, 0.01)], needsProfile: true,
    run: async (b, p, ed) => { const prof = ed.noiseProfile || noiseProfile(quietestPart(b)); return mkBuf(chans(b).map((d, i) => spectralDenoise(d, Array.isArray(prof) ? prof[Math.min(i, prof.length - 1)] : prof, p.strength, p.floor)), b.sampleRate); } },
  declick: { cat: 'Repair', name: 'Remove clicks', params: [P('sens', 'Sensitivity', 2, 20, 8)], run: async (b, p) => mkBuf(chans(b).map((d) => { const o = d.slice(); for (let i = 2; i < d.length - 2; i++) { const pred = (d[i - 1] + d[i + 1]) / 2, avg = (Math.abs(d[i - 2] - d[i - 1]) + Math.abs(d[i + 1] - d[i + 2])) / 2 + 1e-4; if (Math.abs(d[i] - pred) > avg * p.sens) o[i] = pred; } return o; }), b.sampleRate) },
  enhance: { cat: 'Repair', name: '✨ Enhance voice (one click)', params: [P('amount', 'Amount', 0.2, 1, 0.8, 0.05)], run: async (b, p, ed) => {
    let x = await AUDIO_FX.highpass.run(b, { freq: 80 });
    x = await AUDIO_FX.denoise.run(x, { strength: 1.2 * p.amount + 0.4, floor: 0.1 }, ed);
    x = await offline(x, (ctx, s) => { const c = ctx.createDynamicsCompressor(); c.threshold.value = -26; c.ratio.value = 3.5; c.attack.value = 0.004; c.release.value = 0.2; return chainNodes(ctx, s, [filt(ctx, 'peaking', 200, -2 * p.amount, 1), filt(ctx, 'peaking', 3500, 4 * p.amount, 1), filt(ctx, 'highshelf', 9000, 2 * p.amount), c]); });
    return AUDIO_FX.normalize.run(x, { peak: -1 });
  } },
  // Space
  echo: { cat: 'Space', name: 'Echo', params: [P('delay', 'Delay (ms)', 30, 1500, 320), P('feedback', 'Feedback %', 0, 90, 40), P('mix', 'Mix %', 0, 100, 40)], run: async (b, p) => offline(b, (ctx, s) => {
    const out = ctx.createGain(), d = ctx.createDelay(2), fb = ctx.createGain(), wet = ctx.createGain(); d.delayTime.value = p.delay / 1000; fb.gain.value = p.feedback / 100; wet.gain.value = p.mix / 100;
    s.connect(out); s.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(out); return { output: out };
  }, { tail: 2 }) },
  reverb: { cat: 'Space', name: 'Reverb', params: [P('size', 'Room size (s)', 0.3, 6, 2.2, 0.1), P('mix', 'Mix %', 0, 100, 35)], run: async (b, p) => offline(b, (ctx, s) => {
    const out = ctx.createGain(), cv = ctx.createConvolver(), wet = ctx.createGain(), len = Math.floor(ctx.sampleRate * p.size), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5); }
    cv.buffer = ir; wet.gain.value = p.mix / 100; s.connect(out); s.connect(cv); cv.connect(wet); wet.connect(out); return { output: out };
  }, { tail: 1 }) },
  // Stereo
  mono: { cat: 'Stereo', name: 'Make mono', params: [], run: async (b) => { const c = chans(b), m = new Float32Array(b.length); for (const d of c) for (let i = 0; i < d.length; i++) m[i] += d[i] / c.length; return mkBuf(c.map(() => m.slice()), b.sampleRate); } },
  swap: { cat: 'Stereo', name: 'Swap left/right', params: [], run: async (b) => (b.numberOfChannels < 2 ? b : mkBuf([b.getChannelData(1).slice(), b.getChannelData(0).slice()], b.sampleRate)) },
  pan: { cat: 'Stereo', name: 'Pan', params: [P('pan', 'Left ↔ Right', -100, 100, 0)], run: async (b, p) => { const c = chans(b); if (c.length < 2) return b; const l = Math.min(1, 1 - p.pan / 100), r = Math.min(1, 1 + p.pan / 100); return mkBuf([c[0].map((v) => v * l), c[1].map((v) => v * r)], b.sampleRate); } },
  widen: { cat: 'Stereo', name: 'Stereo widener', params: [P('width', 'Width %', 0, 300, 160)], run: async (b, p) => { const c = chans(b); if (c.length < 2) return b; const w = p.width / 100, L = new Float32Array(b.length), R = new Float32Array(b.length); for (let i = 0; i < b.length; i++) { const m = (c[0][i] + c[1][i]) / 2, s = ((c[0][i] - c[1][i]) / 2) * w; L[i] = m + s; R[i] = m - s; } return mkBuf([L, R], b.sampleRate); } },
};
for (const [k, name] of Object.entries(VOICE_FX)) if (k !== 'none' && k !== 'enhance') AUDIO_FX['vfx_' + k] = { cat: 'Voice effects', name, params: [], run: async (b) => offline(b, (ctx, s) => { const ch = buildChain(ctx, k); s.connect(ch.input); return { output: ch.output, start: ch.start }; }, { tail: ['echo', 'reverb', 'cave'].includes(k) ? 1.5 : 0 }) };

function mapSamples(b, f) { return mkBuf(chans(b).map((d) => { const n = d.length, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = f(d[i], i, n); return o; }), b.sampleRate); }
function quietestPart(b) {
  const d = b.getChannelData(0), win = Math.floor(b.sampleRate * 0.4); let best = 0, bestE = Infinity;
  for (let s = 0; s + win < d.length; s += win / 2) { let e = 0; for (let i = s; i < s + win; i += 4) e += d[i] * d[i]; if (e < bestE) { bestE = e; best = s; } }
  return d.subarray(best, best + win);
}

// ======================================================================================
export async function openAudioEditor(app, { id = null, file = null, onExit, onSendToVideo } = {}) {
  const S = { id: id || uid('au_'), name: 'Untitled audio', buf: null, sel: null, cursor: 0, start: 0, pps: 100, undo: [], redo: [], clip: null, dirty: false, loop: false, view: 'wave', noiseProfile: null, transcript: null };

  // ---------- History ----------
  function commit(label, nb, sel = S.sel) {
    S.undo.push({ label, buf: S.buf, sel: S.sel }); if (S.undo.length > 25) S.undo.shift(); S.redo = [];
    S.buf = nb; S.sel = sel && nb ? { a: clamp(sel.a, 0, nb.duration), b: clamp(sel.b, 0, nb.duration) } : null;
    S.cursor = Math.min(S.cursor, nb.duration); changed();
  }
  function undo() { const u = S.undo.pop(); if (!u) return; S.redo.push({ label: u.label, buf: S.buf, sel: S.sel }); S.buf = u.buf; S.sel = u.sel; changed(); toast('Undo: ' + u.label); }
  function redo() { const r = S.redo.pop(); if (!r) return; S.undo.push({ label: r.label, buf: S.buf, sel: S.sel }); S.buf = r.buf; S.sel = r.sel; changed(); toast('Redo: ' + r.label); }
  const range = () => (S.sel && S.sel.b - S.sel.a > 0.001 ? [S.sel.a, S.sel.b] : [0, S.buf.duration]);

  /** Replace [a,b] with fn(slice) */
  async function processRange(label, fn) {
    if (!S.buf) return toast('Open or record audio first');
    const [a, b] = range(), sr = S.buf.sampleRate, nch = S.buf.numberOfChannels;
    busy(true, label + '…');
    try {
      let mid = await fn(slice(S.buf, a, b));
      mid = conform(await resample(mid, sr), sr, nch);
      const whole = a <= 0.0001 && b >= S.buf.duration - 0.0001;
      const nb = whole ? mid : concat([a > 0 ? slice(S.buf, 0, a) : null, mid, b < S.buf.duration ? slice(S.buf, b, S.buf.duration) : null], sr, nch);
      commit(label, nb, whole ? S.sel : { a, b: a + mid.duration });
    } catch (e) { console.error(e); toast(label + ' failed: ' + e.message, 'error'); }
    busy(false);
  }

  // ---------- Edit ops ----------
  const ED = {
    cut() { if (!S.sel) return toast('Select a part first'); ED.copy(); ED.del(); },
    copy() { if (!S.sel) return toast('Select a part first'); S.clip = slice(S.buf, S.sel.a, S.sel.b); toast('Copied ' + fmtD(S.sel.b - S.sel.a)); },
    del() {
      if (!S.sel) return toast('Select a part first'); const { a, b } = S.sel, sr = S.buf.sampleRate, nch = S.buf.numberOfChannels;
      if (b - a >= S.buf.duration - 0.001) return toast("Can't delete everything");
      commit('Delete', concat([a > 0 ? slice(S.buf, 0, a) : null, b < S.buf.duration ? slice(S.buf, b, S.buf.duration) : null], sr, nch), null); S.cursor = a;
    },
    async paste(src = S.clip, label = 'Paste') {
      if (!src) return toast('Nothing to paste');
      if (!S.buf) { S.buf = src; S.sel = null; changed(); fitView(); return; }
      const sr = S.buf.sampleRate, nch = S.buf.numberOfChannels; src = conform(await resample(src, sr), sr, nch);
      const at = S.sel ? S.sel.a : S.cursor, end = S.sel ? S.sel.b : S.cursor;
      commit(label, concat([at > 0 ? slice(S.buf, 0, at) : null, src, end < S.buf.duration ? slice(S.buf, end, S.buf.duration) : null], sr, nch), { a: at, b: at + src.duration });
    },
    trim() { if (!S.sel) return toast('Select the part to keep'); commit('Trim', slice(S.buf, S.sel.a, S.sel.b), null); S.cursor = 0; S.start = 0; fitView(); },
    duplicate() { if (!S.sel) return toast('Select a part first'); const c = slice(S.buf, S.sel.a, S.sel.b), at = S.sel.b; S.sel = null; S.cursor = at; ED.paste(c, 'Duplicate'); },
    selectAll() { if (S.buf) { S.sel = { a: 0, b: S.buf.duration }; draw(); } },
    insertSilence: async () => { const v = prompt('Seconds of silence to insert', '1'); const s = parseFloat(v); if (!(s > 0)) return; const sr = S.buf?.sampleRate || SR_DEFAULT; ED.paste(mkBuf(Array.from({ length: S.buf?.numberOfChannels || 2 }, () => new Float32Array(Math.round(s * sr))), sr), 'Insert silence'); },
    async removeSilence() {
      const thr = fromDB(-42), sr = S.buf.sampleRate, d = S.buf.getChannelData(0), win = Math.round(sr * 0.02), keep = [];
      let start = null, quiet = 0;
      for (let i = 0; i < d.length; i += win) {
        let e = 0; for (let j = i; j < Math.min(d.length, i + win); j += 2) e = Math.max(e, Math.abs(d[j]));
        const t = i / sr;
        if (e > thr) { if (start == null) start = Math.max(0, t - 0.12); quiet = 0; } else if (start != null) { quiet += 0.02; if (quiet > 0.5) { keep.push([start, t - quiet + 0.15]); start = null; quiet = 0; } }
      }
      if (start != null) keep.push([start, S.buf.duration]);
      if (!keep.length) return toast('Nothing but silence here');
      const nb = concat(keep.map(([a, b]) => slice(S.buf, a, Math.min(b, S.buf.duration))), sr, S.buf.numberOfChannels);
      const saved = S.buf.duration - nb.duration; commit('Remove silence', nb, null); toast(`Removed ${saved.toFixed(1)}s of silence`, 'ok');
    },
  };
  const fmtD = (s) => (s < 60 ? `${s.toFixed(2)}s` : fmtTime(s));

  // ---------- Generate / record / AI voice ----------
  async function generate(kind) {
    const sr = S.buf?.sampleRate || SR_DEFAULT, nch = S.buf?.numberOfChannels || 2;
    const p = { seconds: 1, freq: 440, wave: 0, volume: -12 };
    const body = h('div', sliderRow('Seconds', 1, { min: 0.1, max: 30, step: 0.1, def: 1, onInput: (v) => { p.seconds = v; } }),
      kind === 'tone' ? sliderRow('Frequency', 440, { min: 20, max: 8000, def: 440, onInput: (v) => { p.freq = v; } }) : null,
      kind === 'tone' ? sliderRow('Wave (0 sine,1 square,2 saw)', 0, { min: 0, max: 2, def: 0, onInput: (v) => { p.wave = v; } }) : null,
      kind !== 'silence' ? sliderRow('Volume (dB)', -12, { min: -40, max: 0, def: -12, onInput: (v) => { p.volume = v; } }) : null);
    modal({ title: { tone: 'Generate tone', noise: 'Generate noise', silence: 'Insert silence' }[kind], width: 400, body, actions: [{ label: 'Cancel' }, { label: 'Insert', primary: true, onClick: () => {
      const n = Math.round(p.seconds * sr), a = fromDB(p.volume), ch = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, ph = (t * p.freq) % 1;
        if (kind === 'tone') ch[i] = a * (p.wave < 0.5 ? Math.sin(2 * Math.PI * ph) : p.wave < 1.5 ? (ph < 0.5 ? 1 : -1) : 2 * ph - 1);
        else if (kind === 'noise') { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; ch[i] = a * 0.25 * (b0 + b1 + b2 + w * 0.1848); }
      }
      ED.paste(mkBuf(Array.from({ length: nch }, () => ch.slice()), sr), 'Generate ' + kind);
    } }] });
  }
  let rec = null;
  async function record() {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const chunks = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); rec = null; renderTools(); const b = await ac().decodeAudioData(await new Blob(chunks).arrayBuffer()); await ED.paste(b, 'Record'); if (!S.undo.length) fitView(); };
      rec.start(); renderTools(); toast('Recording… press the record button again to stop');
    } catch (e) { toast('Microphone not available: ' + e.message, 'error'); rec = null; }
  }
  async function aiVoice() {
    const { VOICES, STYLES } = await import('./gemini.js'); const { settings } = await import('./settings.js'); const s = settings.get();
    const ta = h('textarea.input', { rows: 5, placeholder: 'Hello everyone, today…' });
    const voice = h('select.select', VOICES.map(([v, d]) => h('option', { value: v, selected: v === s.voice }, `${v} - ${d}`)));
    const style = h('select.select', Object.entries(STYLES).map(([k, d]) => h('option', { value: k, selected: k === s.voiceStyle }, d)));
    modal({ title: 'AI voice (Gemini)', width: 520, body: h('div', h('div.field', ta), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, h('div.field', h('label', 'Voice'), voice), h('div.field', h('label', 'Style'), style))),
      actions: [{ label: 'Cancel' }, { label: 'Generate & insert', primary: true, onClick: async () => {
        if (!ta.value.trim()) return false;
        busy(true, 'Generating voice…');
        try { const { speak } = await import('./gemini.js'); const r = await speak(ta.value.trim(), { voice: voice.value, style: style.value }); const b = await ac().decodeAudioData(await r.blob.arrayBuffer()); await ED.paste(b, 'AI voice'); if (S.undo.length <= 1) fitView(); }
        catch (e) { toast(e.message, 'error', 6000); }
        busy(false);
      } }] });
  }
  async function transcribeAll() {
    if (!S.buf) return;
    busy(true, 'Listening…');
    try {
      const g = await import('./gemini.js');
      const segs = g.speechSegments(S.buf, 0, S.buf.duration);
      S.transcript = await g.transcribe(S.buf, segs, { onProgress: (f, t) => busy(true, t) });
      side = 'transcript'; renderSide();
    } catch (e) { toast('Transcription failed: ' + e.message, 'error', 6000); }
    busy(false);
  }

  // ---------- Effect dialog with preview ----------
  function fxDialog(key) {
    const fx = AUDIO_FX[key]; if (!S.buf) return toast('Open or record audio first');
    const p = {}; for (const [k, , , , def] of fx.params) p[k] = def;
    const [a, b] = range();
    const body = h('div', fx.params.map(([k, label, min, max, def, step]) => sliderRow(label, def, { min, max, step, def, onInput: (v) => { p[k] = v; } })),
      h('p.small.muted', `Applies to ${S.sel ? 'the selection' : 'the whole file'} (${fmtD(b - a)}).`),
      fx.needsProfile ? h('p.small.muted', S.noiseProfile ? '✓ Using your learned noise profile.' : 'Tip: select a part with only background noise and click “Learn noise” first for the best result.') : null);
    let previewSrc = null;
    const stopPrev = () => { try { previewSrc?.stop(); } catch {} previewSrc = null; };
    modal({ title: fx.name, width: 440, body, onClose: stopPrev, actions: [
      { label: 'Preview', onClick: async () => { stopPrev(); const seg = slice(S.buf, a, Math.min(b, a + 8)); const out = await fx.run(seg, p, S); previewSrc = ac().createBufferSource(); previewSrc.buffer = out; previewSrc.connect(ac().destination); previewSrc.start(); return false; } },
      { label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => { stopPrev(); processRange(fx.name, (seg) => fx.run(seg, p, S)); } }] });
  }

  // ---------- Playback ----------
  let src = null, playStart = 0, playOffset = 0, analyser = null;
  function play() {
    if (!S.buf) return; stop(true);
    const ctx = ac(); src = ctx.createBufferSource(); src.buffer = S.buf;
    analyser = analyser || ctx.createAnalyser(); analyser.fftSize = 1024;
    src.connect(analyser); analyser.connect(ctx.destination);
    let from = S.cursor, dur;
    if (S.sel && S.sel.b - S.sel.a > 0.01) { from = S.cursor >= S.sel.a && S.cursor < S.sel.b ? S.cursor : S.sel.a; if (S.loop) { src.loop = true; src.loopStart = S.sel.a; src.loopEnd = S.sel.b; } else dur = S.sel.b - from; }
    else if (from >= S.buf.duration - 0.01) from = 0;
    src.start(0, from, dur); playStart = ctx.currentTime; playOffset = from;
    src.onended = () => { if (src && !src.loop) stop(false); };
    playing = true; renderTransport(); tick();
  }
  let playing = false;
  function stop(silent) { if (src) { src.onended = null; try { src.stop(); } catch {} src = null; } if (playing && !silent) { playing = false; renderTransport(); draw(); } playing = silent ? playing : false; }
  function pos() {
    if (!playing) return S.cursor;
    let t = playOffset + (ac().currentTime - playStart);
    if (src?.loop && S.sel) { const L = S.sel.b - S.sel.a; if (t > S.sel.b) t = S.sel.a + ((t - S.sel.a) % L); }
    return t;
  }
  function tick() {
    if (!playing) return;
    const t = pos(); timeEl.textContent = fmtT(t);
    const vw = S.pps * (main.clientWidth || 1) / S.pps; // width in px
    if ((t - S.start) * S.pps > main.clientWidth - 40) S.start = t - 40 / S.pps;
    draw(t); meter();
    requestAnimationFrame(tick); void vw;
  }
  const levelEl = h('div.au-level', h('i'), h('i'));
  function meter() {
    if (!analyser) return; const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
    let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); const pct = clamp((dB(pk) + 60) / 60, 0, 1) * 100;
    levelEl.children[0].style.width = pct + '%'; levelEl.children[1].style.width = pct + '%';
  }
  const fmtT = (t) => { const m = Math.floor(t / 60), s = t % 60; return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };

  // ---------- Drawing ----------
  const overview = h('canvas.au-overview'), main = h('canvas.au-main');
  const RULER = 22;
  function fitView() { if (!S.buf) return; S.start = 0; S.pps = Math.max(1, (main.clientWidth - 20) / S.buf.duration); draw(); }
  const toT = (x) => S.start + x / S.pps;
  const toX = (t) => (t - S.start) * S.pps;
  function draw(playT = playing ? pos() : null) {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [overview, main]) { const w = c.clientWidth, hh = c.clientHeight; if (c.width !== w * dpr || c.height !== hh * dpr) { c.width = w * dpr; c.height = hh * dpr; } }
    const W = main.clientWidth, H = main.clientHeight, x = main.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.fillStyle = '#0d0e12'; x.fillRect(0, 0, W, H);
    if (!S.buf) { x.fillStyle = '#6c7182'; x.font = '14px Inter'; x.textAlign = 'center'; x.fillText('Open an audio or video file, record, or generate an AI voice to start', W / 2, H / 2); drawOverview(); return; }
    const dur = S.buf.duration, sr = S.buf.sampleRate, nch = S.buf.numberOfChannels;
    S.pps = Math.max((W - 20) / dur / 1, Math.min(S.pps, sr)); S.start = clamp(S.start, 0, Math.max(0, dur - W / S.pps));
    // ruler
    x.fillStyle = '#121318'; x.fillRect(0, 0, W, RULER);
    const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const major = steps.find((s) => s * S.pps >= 80) || 600;
    x.fillStyle = '#7d8294'; x.strokeStyle = '#2d313b'; x.font = '10px Inter'; x.textAlign = 'left';
    for (let t = Math.floor(S.start / major) * major; t < toT(W); t += major) { const px = Math.round(toX(t)) + 0.5; x.beginPath(); x.moveTo(px, 12); x.lineTo(px, H); x.stroke(); x.fillText(major < 1 ? t.toFixed(major < 0.01 ? 3 : 2) + 's' : fmtTime(t), px + 3, 10); }
    const laneH = (H - RULER) / nch;
    // selection
    if (S.sel) { x.fillStyle = 'rgba(139,92,246,.22)'; x.fillRect(toX(S.sel.a), RULER, (S.sel.b - S.sel.a) * S.pps, H - RULER); }
    if (S.view === 'spectrum') drawSpectrum(x, W, H, laneH);
    else for (let c = 0; c < nch; c++) {
      const d = S.buf.getChannelData(c), mid = RULER + laneH * c + laneH / 2, amp = laneH / 2 - 4;
      x.strokeStyle = '#22252f'; x.beginPath(); x.moveTo(0, mid); x.lineTo(W, mid); x.stroke();
      const spp = sr / S.pps;
      if (spp < 2) { // sample view
        x.strokeStyle = '#4ade80'; x.beginPath();
        for (let px = 0; px < W; px++) { const i = Math.floor(toT(px) * sr); if (i >= d.length) break; const y = mid - d[i] * amp; px ? x.lineTo(px, y) : x.moveTo(px, y); }
        x.stroke();
      } else {
        const grad = x.createLinearGradient(0, mid - amp, 0, mid + amp); grad.addColorStop(0, '#5eead4'); grad.addColorStop(0.5, '#4ade80'); grad.addColorStop(1, '#5eead4');
        x.fillStyle = grad;
        for (let px = 0; px < W; px++) {
          const i0 = Math.floor(toT(px) * sr); if (i0 >= d.length) break; const i1 = Math.min(d.length, Math.floor(toT(px + 1) * sr));
          let mn = 1, mx = -1, rms = 0; const step = Math.max(1, Math.floor((i1 - i0) / 400));
          for (let i = i0; i < i1; i += step) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; rms += v * v; }
          if (mx < mn) { mn = mx = d[i0] || 0; }
          x.globalAlpha = 0.55; x.fillRect(px, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
          const r = Math.sqrt(rms / Math.max(1, (i1 - i0) / step)); x.globalAlpha = 1; x.fillRect(px, mid - r * amp, 1, Math.max(1, 2 * r * amp));
        }
        x.globalAlpha = 1;
      }
      if (nch > 1) { x.fillStyle = '#6c7182'; x.font = '10px Inter'; x.fillText(c ? 'R' : 'L', 6, RULER + laneH * c + 14); }
    }
    // beats
    if (S.beats) { x.strokeStyle = 'rgba(45,212,240,.45)'; for (const bt of S.beats) { const px = toX(bt); if (px < 0 || px > W) continue; x.beginPath(); x.moveTo(px, RULER); x.lineTo(px, RULER + 8); x.stroke(); } }
    // cursor & playhead
    x.fillStyle = '#facc15'; x.fillRect(Math.round(toX(S.cursor)), RULER, 1, H - RULER);
    if (playT != null) { x.fillStyle = '#fff'; x.fillRect(Math.round(toX(playT)), 0, 2, H); }
    drawOverview(playT);
    selInfo();
  }
  let specCache = null;
  function drawSpectrum(x, W, H, laneH) {
    const N = 1024, sr = S.buf.sampleRate, win = hann(N), key = `${S.start}|${S.pps}|${W}|${H}|${S.buf.length}`;
    if (specCache?.key !== key) {
      const img = x.createImageData(W, Math.round(H - RULER)), hgt = img.height, d = S.buf.getChannelData(0);
      for (let px = 0; px < W; px++) {
        const c0 = Math.floor(toT(px) * sr) - N / 2; if (c0 > d.length) break;
        const re = new Float32Array(N), im = new Float32Array(N);
        for (let i = 0; i < N; i++) { const j = c0 + i; re[i] = j >= 0 && j < d.length ? d[j] * win[i] : 0; }
        fft(re, im);
        for (let y = 0; y < hgt; y++) {
          const fr = Math.pow(1 - y / hgt, 2.2), k = Math.max(1, Math.floor(fr * (N / 2))), m = Math.hypot(re[k], im[k]);
          const v = clamp((dB(m) + 80) / 80, 0, 1), o = (y * W + px) * 4;
          img.data[o] = 255 * Math.min(1, v * 2); img.data[o + 1] = 255 * Math.max(0, v * 2 - 1) * 0.9 + 40 * v; img.data[o + 2] = 120 * (1 - v) + 80 * v; img.data[o + 3] = 255;
        }
      }
      specCache = { key, img };
    }
    x.putImageData(specCache.img, 0, RULER * (window.devicePixelRatio || 1));
    void laneH;
  }
  function drawOverview(playT) {
    const dpr = window.devicePixelRatio || 1, W = overview.clientWidth, H = overview.clientHeight, x = overview.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.fillStyle = '#121318'; x.fillRect(0, 0, W, H);
    if (!S.buf) return;
    const d = S.buf.getChannelData(0), per = d.length / W;
    x.fillStyle = '#3b8f6b';
    for (let px = 0; px < W; px++) { let m = 0; const i0 = Math.floor(px * per), i1 = Math.floor((px + 1) * per); for (let i = i0; i < i1; i += Math.max(1, Math.floor(per / 100))) m = Math.max(m, Math.abs(d[i])); x.fillRect(px, H / 2 - (m * H) / 2, 1, Math.max(1, m * H)); }
    const vx = (S.start / S.buf.duration) * W, vw = (main.clientWidth / S.pps / S.buf.duration) * W;
    x.strokeStyle = '#a78bfa'; x.lineWidth = 1.5; x.fillStyle = 'rgba(139,92,246,.15)'; x.fillRect(vx, 0, vw, H); x.strokeRect(vx + 0.5, 0.5, Math.max(2, vw - 1), H - 1);
    if (playT != null) { x.fillStyle = '#fff'; x.fillRect((playT / S.buf.duration) * W, 0, 1, H); }
  }

  // ---------- Interaction ----------
  main.addEventListener('pointerdown', (e) => {
    if (!S.buf) return; main.setPointerCapture(e.pointerId);
    const r = main.getBoundingClientRect(), t = clamp(toT(e.clientX - r.left), 0, S.buf.duration);
    if (e.shiftKey && (S.sel || S.cursor != null)) { const anchor = S.sel ? (Math.abs(t - S.sel.a) < Math.abs(t - S.sel.b) ? S.sel.b : S.sel.a) : S.cursor; S.sel = { a: Math.min(anchor, t), b: Math.max(anchor, t) }; draw(); return; }
    // drag selection edges
    const edge = S.sel && (Math.abs(toX(S.sel.a) - (e.clientX - r.left)) < 6 ? 'a' : Math.abs(toX(S.sel.b) - (e.clientX - r.left)) < 6 ? 'b' : null);
    const anchor = edge ? (edge === 'a' ? S.sel.b : S.sel.a) : t;
    if (!edge) { S.cursor = t; S.sel = null; }
    const was = playing; if (was) stop(false);
    const mv = (ev) => { const tt = clamp(toT(ev.clientX - r.left), 0, S.buf.duration); S.sel = { a: Math.min(anchor, tt), b: Math.max(anchor, tt) }; if (S.sel.b - S.sel.a < 0.002) S.sel = null; draw(); };
    const up = () => { main.removeEventListener('pointermove', mv); main.removeEventListener('pointerup', up); if (S.sel) S.cursor = S.sel.a; draw(); renderTransport(); if (was) play(); };
    main.addEventListener('pointermove', mv); main.addEventListener('pointerup', up);
  });
  main.addEventListener('mousemove', (e) => { if (!S.sel) { main.style.cursor = 'text'; return; } const r = main.getBoundingClientRect(), px = e.clientX - r.left; main.style.cursor = Math.abs(toX(S.sel.a) - px) < 6 || Math.abs(toX(S.sel.b) - px) < 6 ? 'ew-resize' : 'text'; });
  main.addEventListener('dblclick', () => ED.selectAll());
  main.addEventListener('wheel', (e) => {
    if (!S.buf) return; e.preventDefault(); const r = main.getBoundingClientRect(), px = e.clientX - r.left;
    if (e.ctrlKey || e.metaKey || !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.altKey && true) {
      if (e.ctrlKey || e.metaKey) { const t = toT(px); S.pps = clamp(S.pps * (e.deltaY < 0 ? 1.25 : 0.8), 1, S.buf.sampleRate); S.start = t - px / S.pps; }
      else S.start += (e.deltaY / S.pps);
    } else S.start += ((e.deltaX || e.deltaY) / S.pps);
    draw();
  }, { passive: false });
  overview.addEventListener('pointerdown', (e) => {
    if (!S.buf) return; overview.setPointerCapture(e.pointerId); const r = overview.getBoundingClientRect();
    const mv = (ev) => { const f = (ev.clientX - r.left) / r.width; S.start = f * S.buf.duration - main.clientWidth / S.pps / 2; draw(); };
    mv(e); overview.addEventListener('pointermove', mv); overview.addEventListener('pointerup', () => overview.removeEventListener('pointermove', mv), { once: true });
  });
  const zoom = (f) => { if (!S.buf) return; const c = S.start + main.clientWidth / S.pps / 2; S.pps = clamp(S.pps * f, 1, S.buf.sampleRate); S.start = c - main.clientWidth / S.pps / 2; draw(); };

  // ---------- Load / save / export ----------
  async function loadFile(f) {
    busy(true, 'Decoding…');
    try { const b = await ac().decodeAudioData(await f.arrayBuffer()); if (S.buf) await ED.paste(b, 'Import'); else { S.buf = b; S.name = f.name.replace(/\.[^.]+$/, ''); nameInput.value = S.name; S.undo = []; S.redo = []; S.sel = null; S.cursor = 0; changed(); fitView(); } }
    catch (e) { toast(`Could not read ${f.name}: ${e.message}`, 'error'); }
    busy(false);
  }
  async function save() {
    if (!S.dirty || !S.buf) return; S.dirty = false;
    const blob = audioBufferToWav(S.buf);
    const d = S.buf.getChannelData(0), peaks = []; const per = Math.max(1, Math.floor(d.length / 120)); for (let i = 0; i < 120; i++) { let m = 0; for (let j = i * per; j < Math.min(d.length, (i + 1) * per); j += 16) m = Math.max(m, Math.abs(d[j])); peaks.push(Math.round(m * 100) / 100); }
    await db.put('audios', { id: S.id, name: S.name, updated: Date.now(), duration: S.buf.duration, peaks, blob });
    savedEl.textContent = 'Saved';
  }
  const saveSoon = debounce(() => save().catch((e) => toast('Save failed: ' + e.message, 'error')), 2500);
  async function exportAs(fmt) {
    if (!S.buf) return;
    const [a, b] = S.sel && confirmExportSel ? [S.sel.a, S.sel.b] : [0, S.buf.duration];
    const wav = audioBufferToWav(a === 0 && b === S.buf.duration ? S.buf : slice(S.buf, a, b));
    if (fmt === 'wav') { h('a', { href: URL.createObjectURL(wav), download: `${S.name}.wav` }).click(); toast('Saved WAV', 'ok'); return; }
    busy(true, 'Encoding MP3…');
    try {
      const id = uid('a'), post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'X-Frame-Client': '1' }, body }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
      await post(`/api/export/upload?id=${id}&kind=audio`, wav);
      const d = await post(`/api/export/finish?id=${id}&fps=30&format=mp3&name=${encodeURIComponent(S.name)}`, '');
      h('a', { href: `/api/export/file?name=${encodeURIComponent(d.file)}`, download: d.file }).click(); toast('Saved MP3 to exports folder', 'ok');
    } catch (e) { toast('MP3 export failed: ' + e.message, 'error'); }
    busy(false);
  }
  let confirmExportSel = false;
  async function sendToVideo() { if (!S.buf) return; await save(); onSendToVideo?.(new File([audioBufferToWav(S.buf)], `${S.name}.wav`, { type: 'audio/wav' })); }

  // ---------- UI ----------
  const savedEl = h('span.saved'), nameInput = h('input.name', { value: S.name, onchange: () => { S.name = nameInput.value || 'Untitled audio'; changed(); } });
  const busyEl = h('div.au-busy.hidden');
  function busy(on, text) { busyEl.classList.toggle('hidden', !on); busyEl.innerHTML = on ? `<span class="spinner"></span> ${text || 'Working…'}` : ''; }
  const menu = (label, items) => h('button.menu-btn', { onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showContextMenu(r.left, r.bottom + 4, items()); } }, label);
  const fxByCat = () => { const cats = {}; for (const [k, f] of Object.entries(AUDIO_FX)) (cats[f.cat] = cats[f.cat] || []).push([k, f]); return cats; };
  const top = h('header.topbar',
    iconBtn('home', 'Back to home', async () => { stop(false); await save(); cleanup(); onExit?.(); }),
    h('div.brand', { style: { fontSize: '14px' } }, h('div.logo', { style: { width: '24px', height: '24px', borderRadius: '7px', background: 'linear-gradient(135deg,#22c55e,#06b6d4)' }, html: icon('wave', 12) }), 'Audio'),
    h('div.menubar',
      menu('File', () => [{ label: 'Open audio / video…', icon: 'folder', fn: async () => { const f = await pickFiles('audio/*,video/*', false); if (f[0]) { if (S.buf) { await save(); S.id = uid('au_'); S.buf = null; } loadFile(f[0]); } } },
        { label: 'Import & insert at cursor…', icon: 'upload', fn: async () => { const f = await pickFiles('audio/*,video/*', false); if (f[0]) loadFile(f[0]); } }, '-',
        { label: 'Export WAV', icon: 'download', fn: () => exportAs('wav') }, { label: 'Export MP3', icon: 'download', fn: () => exportAs('mp3') }, { label: 'Send to video editor', icon: 'film', fn: sendToVideo }]),
      menu('Edit', () => [{ label: 'Undo', icon: 'undo', key: 'Ctrl+Z', fn: undo }, { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', fn: redo }, '-',
        { label: 'Cut', icon: 'scissors', key: 'Ctrl+X', fn: ED.cut }, { label: 'Copy', icon: 'copy', key: 'Ctrl+C', fn: ED.copy }, { label: 'Paste', icon: 'copy', key: 'Ctrl+V', fn: () => ED.paste() }, { label: 'Delete', icon: 'trash', key: 'Del', fn: ED.del }, '-',
        { label: 'Trim to selection', icon: 'crop', key: 'Ctrl+T', fn: ED.trim }, { label: 'Duplicate selection', icon: 'copy', key: 'Ctrl+D', fn: ED.duplicate }, { label: 'Select all', icon: 'marquee', key: 'Ctrl+A', fn: ED.selectAll }, '-',
        { label: 'Remove silence (whole file)', icon: 'scissors', fn: ED.removeSilence }]),
      menu('Effects', () => Object.entries(fxByCat()).flatMap(([cat, list], i) => [...(i ? ['-'] : []), ...list.map(([k, f]) => ({ label: `${cat}: ${f.name}`, icon: 'wave', fn: () => fxDialog(k) }))])),
      menu('Generate', () => [{ label: 'AI voice (text to speech)…', icon: 'sparkles', fn: aiVoice }, { label: 'Record microphone', icon: 'mic', fn: record }, '-',
        { label: 'Tone…', icon: 'wave', fn: () => generate('tone') }, { label: 'Noise…', icon: 'wave', fn: () => generate('noise') }, { label: 'Silence…', icon: 'wave', fn: () => generate('silence') }]),
      menu('AI', () => [{ label: 'Enhance voice', icon: 'wand', fn: () => fxDialog('enhance') }, { label: 'Transcribe (Gemini)', icon: 'captions', fn: transcribeAll }, { label: 'Detect beats', icon: 'music', fn: () => { const r = detectBeats(S.buf); S.beats = r.beats; draw(); toast(`${r.bpm} BPM`, 'ok'); } }, { label: 'AI voice…', icon: 'mic', fn: aiVoice }])),
    nameInput, savedEl, h('div.spacer'), busyEl,
    iconBtn('undo', 'Undo', undo), iconBtn('redo', 'Redo', redo), h('div.vsep'),
    h('button.btn', { onclick: sendToVideo, html: icon('film', 15) + ' To video' }),
    h('button.btn.primary', { onclick: () => exportAs('mp3'), html: icon('download', 15) + ' Export MP3' }));

  const timeEl = h('div.au-time', '00:00.000');
  const selEl = h('div.au-sel');
  const transport = h('div.au-transport');
  function renderTransport() {
    transport.innerHTML = '';
    transport.append(
      iconBtn('skipBack', 'Start (Home)', () => { S.cursor = 0; S.start = 0; draw(); }),
      h('button.play-btn', { title: 'Play / pause (Space)', html: icon(playing ? 'pause' : 'play', 16), onclick: () => (playing ? stop(false) : play()) }),
      iconBtn('stop', 'Stop', () => { stop(false); }),
      h('button.icon-btn' + (S.loop ? '.on' : ''), { title: 'Loop selection (L)', html: icon('reset', 16), onclick: () => { S.loop = !S.loop; renderTransport(); } }),
      h('button.icon-btn' + (rec ? '.on' : ''), { title: 'Record (R)', html: icon('record', 16), style: { color: rec ? '#f43f5e' : '' }, onclick: record }),
      timeEl, selEl, h('div', { style: { flex: 1 } }), levelEl,
      h('div.seg', h('button' + (S.view === 'wave' ? '.on' : ''), { onclick: () => { S.view = 'wave'; renderTransport(); draw(); } }, 'Waveform'), h('button' + (S.view === 'spectrum' ? '.on' : ''), { onclick: () => { S.view = 'spectrum'; renderTransport(); draw(); } }, 'Spectrogram')),
      iconBtn('zoomOut', 'Zoom out (-)', () => zoom(0.66)), iconBtn('zoomIn', 'Zoom in (+)', () => zoom(1.5)), iconBtn('fit', 'Fit (Ctrl+0)', fitView), iconBtn('zoomIn', 'Zoom to selection', () => { if (S.sel) { S.pps = main.clientWidth / (S.sel.b - S.sel.a) * 0.95; S.start = S.sel.a - (S.sel.b - S.sel.a) * 0.025; draw(); } }));
    timeEl.textContent = fmtT(S.cursor);
  }
  function selInfo() {
    if (!S.buf) { selEl.textContent = ''; return; }
    if (!S.sel) { selEl.textContent = `Length ${fmtD(S.buf.duration)} · ${S.buf.sampleRate / 1000} kHz · ${S.buf.numberOfChannels === 1 ? 'mono' : 'stereo'}`; return; }
    selEl.textContent = `Selection ${fmtT(S.sel.a)} → ${fmtT(S.sel.b)} (${fmtD(S.sel.b - S.sel.a)})`;
  }

  // Side panel
  const sideEl = h('aside.au-side');
  let side = 'fx';
  function renderSide() {
    sideEl.innerHTML = '';
    const tabs = h('div.insp-tabs', [['fx', 'Effects'], ['tools', 'Tools'], ['transcript', 'Transcript'], ['info', 'Info']].map(([k, l]) => h('button' + (side === k ? '.on' : ''), { onclick: () => { side = k; renderSide(); } }, l)));
    const body = h('div.insp-body');
    if (side === 'fx') {
      body.append(h('button.btn.primary.block', { onclick: () => fxDialog('enhance'), html: icon('wand', 15) + ' Enhance voice (one click)' }),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '8px' } },
          h('button.btn.sm', { onclick: () => { if (!S.sel) return toast('Select a part with only noise first'); S.noiseProfile = chans(slice(S.buf, S.sel.a, S.sel.b)).map((d) => noiseProfile(d)); toast('Noise profile learned', 'ok'); } }, 'Learn noise'),
          h('button.btn.sm', { onclick: () => fxDialog('denoise') }, 'Reduce noise')));
      for (const [cat, list] of Object.entries(fxByCat())) body.append(h('div.sub', cat), h('div.ph-grid', list.map(([k, f]) => h('button.ph-gbtn', { onclick: () => fxDialog(k) }, f.name))));
    } else if (side === 'tools') {
      body.append(h('div.sub', { style: { marginTop: 0 } }, 'Create'),
        h('div', { style: { display: 'grid', gap: '8px' } },
          h('button.btn.block', { onclick: aiVoice, html: icon('sparkles', 15) + ' AI voice (text to speech)' }),
          h('button.btn.block' + (rec ? '.danger' : ''), { onclick: record, html: icon(rec ? 'stop' : 'mic', 15) + (rec ? ' Stop recording' : ' Record microphone') }),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' } }, h('button.btn.sm', { onclick: () => generate('tone') }, 'Tone'), h('button.btn.sm', { onclick: () => generate('noise') }, 'Noise'), h('button.btn.sm', { onclick: () => generate('silence') }, 'Silence'))),
        h('div.sub', 'Edit'),
        h('div.ph-grid', [['Cut', ED.cut], ['Copy', ED.copy], ['Paste', () => ED.paste()], ['Delete', ED.del], ['Trim to selection', ED.trim], ['Duplicate', ED.duplicate], ['Select all', ED.selectAll], ['Remove silence', ED.removeSilence]].map(([l, fn]) => h('button.ph-gbtn', { onclick: fn }, l))),
        h('div.sub', 'Analyze'),
        h('div', { style: { display: 'grid', gap: '8px' } },
          h('button.btn.block', { onclick: () => { const r = detectBeats(S.buf); S.beats = r.beats; draw(); toast(`${r.bpm} BPM - beats marked`, 'ok'); }, html: icon('music', 15) + ' Detect beats / BPM' }),
          h('button.btn.block', { onclick: transcribeAll, html: icon('captions', 15) + ' Transcribe speech (Gemini)' })));
    } else if (side === 'transcript') {
      if (!S.transcript) body.append(h('p.muted.small', 'Turn speech into text with timestamps. Click a line to select that part - then delete it, mute it or apply effects.'), h('button.btn.primary.block', { onclick: transcribeAll, html: icon('captions', 15) + ' Transcribe' }));
      else if (!S.transcript.length) body.append(h('p.muted', 'No speech found.'));
      else body.append(h('div.cap-list', S.transcript.map((t) => h('div.cap-row', { style: { cursor: 'pointer' }, onclick: () => { S.sel = { a: t.start, b: t.end }; S.cursor = t.start; if (toX(t.start) < 0 || toX(t.end) > main.clientWidth) S.start = t.start - 1; draw(); } },
        h('button.cap-time', fmtD(t.start)), h('div.small', t.text)))),
        h('button.btn.sm', { style: { marginTop: '10px' }, onclick: () => { const txt = S.transcript.map((t) => t.text).join('\n'); navigator.clipboard?.writeText(txt); toast('Transcript copied', 'ok'); } }, 'Copy text'));
    } else {
      if (!S.buf) body.append(h('p.muted', 'No audio loaded.'));
      else {
        const [a, b] = range(), seg = slice(S.buf, a, b); let pk = 0, rms = 0, n = 0;
        for (const d of chans(seg)) for (let i = 0; i < d.length; i += 2) { pk = Math.max(pk, Math.abs(d[i])); rms += d[i] * d[i]; n++; }
        const row = (k, v) => h('div.row', h('label', k), h('b', v));
        body.append(h('div.card', h('h4', S.sel ? 'Selection' : 'Whole file'), row('Length', fmtD(b - a)), row('Peak', `${dB(pk).toFixed(1)} dB`), row('Loudness (RMS)', `${dB(Math.sqrt(rms / Math.max(1, n))).toFixed(1)} dB`), row('Sample rate', `${S.buf.sampleRate} Hz`), row('Channels', S.buf.numberOfChannels === 1 ? 'Mono' : 'Stereo')));
      }
    }
    sideEl.append(tabs, body);
  }

  const onKey = (e) => {
    if (document.querySelector('.modal-wrap')) return;
    const tag = e.target.tagName; if ((tag === 'INPUT' && e.target.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, run = (fn) => { e.preventDefault(); fn(); };
    if (e.key === ' ') return run(() => (playing ? stop(false) : play()));
    if (ctrl && k === 'z') return run(e.shiftKey ? redo : undo);
    if (ctrl && k === 'y') return run(redo);
    if (ctrl && k === 'x') return run(ED.cut);
    if (ctrl && k === 'c') return run(ED.copy);
    if (ctrl && k === 'v') return run(() => ED.paste());
    if (ctrl && k === 'a') return run(ED.selectAll);
    if (ctrl && k === 't') return run(ED.trim);
    if (ctrl && k === 'd') return run(ED.duplicate);
    if (ctrl && k === '0') return run(fitView);
    if (ctrl && k === 's') return run(() => { S.dirty = true; save(); });
    if (ctrl) return;
    if (e.key === 'Delete' || e.key === 'Backspace') return run(ED.del);
    if (e.key === 'Home') return run(() => { S.cursor = 0; S.start = 0; draw(); });
    if (e.key === 'End') return run(() => { S.cursor = S.buf?.duration || 0; draw(); });
    if (k === '+' || k === '=') return run(() => zoom(1.5));
    if (k === '-') return run(() => zoom(0.66));
    if (k === 'l') return run(() => { S.loop = !S.loop; renderTransport(); });
    if (k === 'r') return run(record);
    if (e.key === 'Escape') return run(() => { S.sel = null; draw(); });
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => draw());
  function cleanup() { document.removeEventListener('keydown', onKey); ro.disconnect(); stop(false); }
  function changed() { S.dirty = true; savedEl.textContent = 'Saving…'; saveSoon(); specCache = null; renderTransport(); if (side === 'info') renderSide(); draw(); }

  app.innerHTML = '';
  const root = h('div.audio-app', top, transport, h('div.au-main', h('div.au-wave', overview, main), sideEl));
  root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
  root.addEventListener('drop', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); e.stopPropagation(); loadFile(e.dataTransfer.files[0]); });
  app.append(root);
  ro.observe(main);
  renderTransport(); renderSide();

  if (id) { const r = await db.get('audios', id); if (r) { S.name = r.name; nameInput.value = r.name; S.buf = await ac().decodeAudioData(await r.blob.arrayBuffer()); } }
  if (!S.buf && file) await loadFile(file);
  document.title = `${S.name} - Frame Audio`;
  setTimeout(() => { fitView(); draw(); }, 30);
  window.frameAudio = { S, ED, AUDIO_FX, processRange, fxDialog, draw, play, stop, save, loadFile };
  return { save, cleanup };
}
export { fft, noiseProfile, spectralDenoise, timeStretch, hann };
