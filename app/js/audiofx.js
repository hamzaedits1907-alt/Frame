// Voice / audio effects shared by preview (AudioContext) and export (OfflineAudioContext).
export const VOICE_FX = {
  none: 'None', enhance: 'Enhance voice', robot: 'Robot', echo: 'Echo', reverb: 'Big hall', cave: 'Cave',
  telephone: 'Telephone', megaphone: 'Megaphone', radio: 'Old radio', underwater: 'Underwater', deep: 'Deep bass', bright: 'Bright',
};

function impulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
  return b;
}
function shaper(ctx, amount) {
  const s = ctx.createWaveShaper(), n = 2048, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x)); }
  s.curve = curve; return s;
}
const filt = (ctx, type, f, q = 0.7, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };

/** Build an effect chain: returns {input, output, start(when)} nodes. */
export function buildChain(ctx, fx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const oscs = [];
  const series = (...nodes) => { let a = input; for (const n of nodes) { a.connect(n); a = n; } a.connect(output); };
  switch (fx) {
    case 'enhance': { const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2; series(filt(ctx, 'highpass', 85), filt(ctx, 'peaking', 3000, 1, 4), filt(ctx, 'lowshelf', 200, 0.7, -2), comp); output.gain.value = 1.3; break; }
    case 'robot': { const ring = ctx.createGain(); ring.gain.value = 0; const o = ctx.createOscillator(); o.frequency.value = 55; o.connect(ring.gain); oscs.push(o); input.connect(ring); const d = ctx.createDelay(); d.delayTime.value = 0.012; ring.connect(d); d.connect(output); ring.connect(output); break; }
    case 'echo': case 'cave': {
      const d = ctx.createDelay(2); d.delayTime.value = fx === 'cave' ? 0.18 : 0.3; const fb = ctx.createGain(); fb.gain.value = fx === 'cave' ? 0.5 : 0.4;
      input.connect(output); input.connect(d); d.connect(fb); fb.connect(d); d.connect(output);
      if (fx === 'cave') { const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 3.5, 2); const w = ctx.createGain(); w.gain.value = 0.6; input.connect(cv); cv.connect(w); w.connect(output); }
      break;
    }
    case 'reverb': { const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 2.5, 3); const w = ctx.createGain(); w.gain.value = 0.55; input.connect(output); input.connect(cv); cv.connect(w); w.connect(output); break; }
    case 'telephone': series(filt(ctx, 'highpass', 400), filt(ctx, 'lowpass', 3200), shaper(ctx, 8)); break;
    case 'megaphone': series(filt(ctx, 'highpass', 600), filt(ctx, 'lowpass', 4000), shaper(ctx, 40), filt(ctx, 'peaking', 1800, 1, 6)); output.gain.value = 0.8; break;
    case 'radio': series(filt(ctx, 'bandpass', 1400, 0.9), shaper(ctx, 15)); output.gain.value = 1.4; break;
    case 'underwater': series(filt(ctx, 'lowpass', 450, 2)); output.gain.value = 1.3; break;
    case 'deep': series(filt(ctx, 'lowshelf', 180, 0.7, 9), filt(ctx, 'highshelf', 3000, 0.7, -6)); break;
    case 'bright': series(filt(ctx, 'highshelf', 3500, 0.7, 7), filt(ctx, 'highpass', 120)); break;
    default: input.connect(output);
  }
  return { input, output, start: (when = 0) => oscs.forEach((o) => o.start(when)), stop: () => oscs.forEach((o) => { try { o.stop(); } catch {} }) };
}

/** Simple beat detection: returns beat times (seconds, source time) and BPM. */
export function detectBeats(ab) {
  const sr = ab.sampleRate, ch = ab.getChannelData(0), hop = 512, n = Math.floor(ch.length / hop);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0; for (let j = i * hop; j < (i + 1) * hop; j += 2) e += ch[j] * ch[j];
    e = Math.sqrt(e / (hop / 2));
    env[i] = Math.max(0, e - prev); prev = e;
  }
  const fps = sr / hop;
  // Tempo via autocorrelation between 70 and 180 BPM
  let best = 0, bestLag = Math.round(fps / 2);
  for (let bpm = 70; bpm <= 180; bpm++) {
    const lag = Math.round((60 / bpm) * fps); let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  // Phase: offset with the strongest sum of onsets
  let bestPh = 0, bestS = -1;
  for (let ph = 0; ph < bestLag; ph++) { let s = 0; for (let i = ph; i < n; i += bestLag) s += env[i]; if (s > bestS) { bestS = s; bestPh = ph; } }
  const beats = [];
  for (let i = bestPh; i < n; i += bestLag) beats.push(i / fps);
  return { bpm: Math.round((60 * fps) / bestLag), beats };
}
