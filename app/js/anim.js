// Keyframes and time mapping (reverse, speed curves).

export const KF_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];
const EPS = 1 / 60;

export function baseVal(c, prop) { return prop === 'volume' ? (c.volume ?? 1) : c.transform[prop]; }

const ease = {
  linear: (u) => u,
  ease: (u) => u * u * (3 - 2 * u),
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
  hold: () => 0,
};

/** Animated value of a property at clip-local time. */
export function valAt(c, prop, local) {
  const ks = c.kf?.[prop];
  if (!ks || !ks.length) return baseVal(c, prop);
  if (local <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (local >= a.t && local < b.t) {
      const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
      return a.v + (b.v - a.v) * (ease[a.e || 'ease'] || ease.ease)(u);
    }
  }
  return last.v;
}

export const hasKeys = (c, prop) => !!c.kf?.[prop]?.length;
export const keyAt = (c, prop, local) => c.kf?.[prop]?.find((k) => Math.abs(k.t - local) < EPS);

/** Set a property: if it is animated, add/update a keyframe at local time; else change the base value. */
export function setAnimated(c, prop, v, local) {
  if (hasKeys(c, prop)) {
    local = Math.max(0, Math.min(c.duration, local));
    const k = keyAt(c, prop, local);
    if (k) k.v = v; else { c.kf[prop].push({ t: local, v, e: 'ease' }); c.kf[prop].sort((a, b) => a.t - b.t); }
  } else if (prop === 'volume') c.volume = v;
  else c.transform[prop] = v;
}

/** Toggle a keyframe at local time (adds with the current animated value). */
export function toggleKey(c, prop, local) {
  local = Math.max(0, Math.min(c.duration, local));
  c.kf = c.kf || {};
  const ks = c.kf[prop] || (c.kf[prop] = []);
  const k = keyAt(c, prop, local);
  if (k) { ks.splice(ks.indexOf(k), 1); if (!ks.length) { if (prop === 'volume') c.volume = k.v; else c.transform[prop] = k.v; delete c.kf[prop]; } return false; }
  ks.push({ t: local, v: valAt(c, prop, local), e: 'ease' });
  ks.sort((a, b) => a.t - b.t);
  return true;
}

export function keyTimes(c) {
  const s = new Set();
  for (const p of KF_PROPS) for (const k of c.kf?.[p] || []) s.add(Math.round(k.t * 1000) / 1000);
  return [...s].sort((a, b) => a - b);
}

/** Shift/trim keyframes when a clip is split: keep those in [from, to) re-based to from. */
export function sliceKeys(c, from, to) {
  if (!c.kf) return;
  for (const p of Object.keys(c.kf)) {
    const ks = c.kf[p];
    const vFrom = valAt(c, p, from), vTo = valAt(c, p, to);
    const inside = ks.filter((k) => k.t > from + EPS && k.t < to - EPS).map((k) => ({ ...k, t: k.t - from }));
    c.kf[p] = [{ t: 0, v: vFrom, e: 'ease' }, ...inside, { t: to - from, v: vTo, e: 'ease' }];
  }
}

// ---- Speed curves -----------------------------------------------------------------------------
export const CURVES = {
  montage: { name: 'Montage', pts: [1, 1, 3, 3, 0.5, 0.5, 3, 3, 1, 1] },
  hero: { name: 'Hero moment', pts: [2, 2, 0.25, 0.25, 0.25, 2, 2] },
  bullet: { name: 'Bullet time', pts: [3, 3, 0.15, 0.15, 3, 3] },
  jumpcut: { name: 'Jump cut', pts: [1, 4, 4, 1, 1, 4, 4, 1] },
  flashIn: { name: 'Flash in', pts: [4, 3, 1, 1, 1, 1] },
  flashOut: { name: 'Flash out', pts: [1, 1, 1, 1, 3, 4] },
  rampUp: { name: 'Ramp up', pts: [0.5, 1, 2, 3] },
  rampDown: { name: 'Ramp down', pts: [3, 2, 1, 0.5] },
  smoothSlow: { name: 'Smooth slow-mo', pts: [1, 0.35, 0.35, 1] },
};
const curveCache = new Map();
function curveTable(name) {
  if (curveCache.has(name)) return curveCache.get(name);
  const pts = CURVES[name]?.pts; if (!pts) return null;
  const N = 400, sp = new Float64Array(N + 1), cum = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * (pts.length - 1), j = Math.min(pts.length - 2, Math.floor(x)), f = x - j;
    sp[i] = pts[j] + (pts[j + 1] - pts[j]) * (f * f * (3 - 2 * f));
  }
  for (let i = 1; i <= N; i++) cum[i] = cum[i - 1] + (sp[i] + sp[i - 1]) / 2;
  const total = cum[N];
  const tb = { N, sp, cum, total, avg: total / N };
  curveCache.set(name, tb);
  return tb;
}
function curveF(name, u) {
  const tb = curveTable(name); if (!tb) return u;
  const x = Math.max(0, Math.min(1, u)) * tb.N, i = Math.min(tb.N - 1, Math.floor(x)), f = x - i;
  return (tb.cum[i] + (tb.cum[i + 1] - tb.cum[i]) * f) / tb.total;
}

/** Source media time for timeline time t. */
export function srcTime(c, t) {
  let local = t - c.start;
  if (!c.reverse && !c.curve) return c.in + local * c.speed;
  local = Math.max(0, Math.min(c.duration, local));
  let u = local / c.duration;
  if (c.curve) u = curveF(c.curve, u);
  if (c.reverse) u = 1 - u;
  return c.in + Math.max(0, Math.min(c.duration * c.speed - 0.001, u * c.duration * c.speed));
}

/** Instantaneous playback rate (for preview playback). Negative = reverse. */
export function instSpeed(c, t) {
  let s = c.speed;
  if (c.curve) {
    const tb = curveTable(c.curve);
    if (tb) { const u = Math.max(0, Math.min(1, (t - c.start) / c.duration)); s *= tb.sp[Math.round(u * tb.N)] / tb.avg; }
  }
  return c.reverse ? -s : s;
}
