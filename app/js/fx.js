// Video effects (adjustment-layer style), masks, chroma key and AI background removal.

export const EFFECTS = {
  shake: { name: 'Shake', cat: 'Motion' },
  zoomPulse: { name: 'Zoom pulse', cat: 'Motion' },
  zoomIn: { name: 'Slow zoom', cat: 'Motion' },
  glitch: { name: 'Glitch', cat: 'Retro' },
  rgbSplit: { name: 'RGB split', cat: 'Retro' },
  vhs: { name: 'VHS', cat: 'Retro' },
  oldFilm: { name: 'Old film', cat: 'Retro' },
  grain: { name: 'Film grain', cat: 'Retro' },
  pixelate: { name: 'Pixelate', cat: 'Retro' },
  flash: { name: 'Flash', cat: 'Light' },
  strobe: { name: 'Strobe', cat: 'Light' },
  lightLeak: { name: 'Light leak', cat: 'Light' },
  spotlight: { name: 'Spotlight', cat: 'Light' },
  rainbow: { name: 'Rainbow', cat: 'Color' },
  invertFlash: { name: 'Invert flash', cat: 'Color' },
  bw: { name: 'Black & white', cat: 'Color' },
  blur: { name: 'Blur', cat: 'Lens' },
  letterbox: { name: 'Cinema bars', cat: 'Lens' },
  vignette: { name: 'Dark vignette', cat: 'Lens' },
  mirror: { name: 'Mirror', cat: 'Split' },
  kaleido: { name: 'Kaleidoscope', cat: 'Split' },
  split2: { name: 'Split 2', cat: 'Split' },
  split3: { name: 'Split 3', cat: 'Split' },
  split4: { name: 'Split 4', cat: 'Split' },
  snow: { name: 'Snow', cat: 'Party' },
  confetti: { name: 'Confetti', cat: 'Party' },
  hearts: { name: 'Hearts', cat: 'Party' },
  sparkle: { name: 'Sparkles', cat: 'Party' },
};

let copyCv = null, tmpCv = null, noiseCv = null;
function canvasLike(w, h, which) {
  let cv = which === 'copy' ? copyCv : tmpCv;
  if (!cv) { cv = document.createElement('canvas'); if (which === 'copy') copyCv = cv; else tmpCv = cv; }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const x = cv.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none'; x.clearRect(0, 0, w, h);
  return { cv, x };
}
function noise() {
  if (noiseCv) return noiseCv;
  noiseCv = document.createElement('canvas'); noiseCv.width = noiseCv.height = 256;
  const x = noiseCv.getContext('2d'), d = x.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  return noiseCv;
}
const rnd = (n) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };

function snapshot(ctx, W, H) { const c = canvasLike(W, H, 'copy'); c.x.drawImage(ctx.canvas, 0, 0, W, H); return c.cv; }

function rgbSplit(ctx, W, H, off) {
  const src = snapshot(ctx, W, H);
  const t = canvasLike(W, H, 'tmp');
  ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
  for (const [col, dx] of [['#ff0000', -off], ['#00ff00', 0], ['#0000ff', off]]) {
    t.x.globalCompositeOperation = 'source-over'; t.x.clearRect(0, 0, W, H); t.x.drawImage(src, 0, 0);
    t.x.globalCompositeOperation = 'multiply'; t.x.fillStyle = col; t.x.fillRect(0, 0, W, H);
    ctx.drawImage(t.cv, dx, 0);
  }
  ctx.restore();
}

function particles(ctx, W, H, t, kind, k) {
  const n = kind === 'snow' ? 90 : 60;
  ctx.save();
  for (let i = 0; i < n; i++) {
    const sp = 0.05 + rnd(i * 3.1) * 0.12, x0 = rnd(i) * W, size = (kind === 'snow' ? 3 + rnd(i * 7) * 5 : 8 + rnd(i * 7) * 10) * k;
    const y = ((rnd(i * 5.3) + t * sp) % 1.1) * H - 0.05 * H;
    const x = x0 + Math.sin(t * 1.5 + i) * 20 * k;
    if (kind === 'snow') { ctx.globalAlpha = 0.85; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, size, 0, 7); ctx.fill(); }
    else if (kind === 'confetti') { ctx.globalAlpha = 1; ctx.fillStyle = `hsl(${rnd(i * 9) * 360},90%,60%)`; ctx.save(); ctx.translate(x, y); ctx.rotate(t * 3 + i); ctx.fillRect(-size / 2, -size / 4, size, size / 2); ctx.restore(); }
    else if (kind === 'hearts' || kind === 'sparkle') {
      const yy = H - y; ctx.globalAlpha = 0.9; ctx.font = `${size * 2}px "Segoe UI Emoji",sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(kind === 'hearts' ? '❤️' : (i % 2 ? '✨' : '⭐'), x, yy);
    }
  }
  ctx.restore();
}

/** Apply an effect clip to everything drawn so far. local = seconds since effect start. */
export function applyEffect(ctx, W, H, c, local, k) {
  const I = Math.max(0, Math.min(2, c.intensity ?? 1));
  const tGlobal = c.start + local;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  switch (c.effect) {
    case 'shake': { const src = snapshot(ctx, W, H); const a = 0.015 * I; ctx.drawImage(src, (rnd(tGlobal * 30) - 0.5) * W * a * 2 - W * a, (rnd(tGlobal * 31 + 4) - 0.5) * H * a * 2 - H * a, W * (1 + 2 * a), H * (1 + 2 * a)); break; }
    case 'zoomPulse': { const src = snapshot(ctx, W, H); const s = 1 + 0.08 * I * Math.pow(Math.abs(Math.sin(local * Math.PI * 2)), 4); ctx.drawImage(src, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s); break; }
    case 'zoomIn': { const src = snapshot(ctx, W, H); const s = 1 + 0.25 * I * (local / Math.max(0.1, c.duration)); ctx.drawImage(src, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s); break; }
    case 'rgbSplit': rgbSplit(ctx, W, H, 8 * k * I); break;
    case 'glitch': {
      const on = rnd(Math.floor(tGlobal * 12)) < 0.55;
      if (on) {
        rgbSplit(ctx, W, H, (6 + rnd(tGlobal * 40) * 18) * k * I);
        const src = snapshot(ctx, W, H);
        for (let i = 0; i < 6; i++) { const y = rnd(tGlobal * 7 + i) * H, hh = (0.02 + rnd(i + tGlobal) * 0.08) * H, dx = (rnd(tGlobal * 13 + i) - 0.5) * 0.12 * W * I; ctx.drawImage(src, 0, y, W, hh, dx, y, W, hh); }
      }
      break;
    }
    case 'vhs': {
      rgbSplit(ctx, W, H, 4 * k * I);
      ctx.globalAlpha = 0.12 * I; ctx.fillStyle = '#000';
      for (let y = 0; y < H; y += Math.max(2, 4 * k)) ctx.fillRect(0, y, W, Math.max(1, 2 * k));
      ctx.globalAlpha = 0.08 * I; ctx.globalCompositeOperation = 'overlay';
      const n = noise(); ctx.drawImage(n, rnd(tGlobal) * 200, rnd(tGlobal + 1) * 200, 256, 256, 0, 0, W, H);
      const by = ((tGlobal * 0.3) % 1) * H; ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.1 * I; ctx.fillStyle = '#fff'; ctx.fillRect(0, by, W, 6 * k);
      break;
    }
    case 'grain': { ctx.globalAlpha = 0.18 * I; ctx.globalCompositeOperation = 'overlay'; const n = noise(); ctx.drawImage(n, rnd(tGlobal * 24) * 128, rnd(tGlobal * 24 + 2) * 128, 128, 128, 0, 0, W, H); break; }
    case 'oldFilm': {
      const src = snapshot(ctx, W, H);
      ctx.filter = `sepia(${70 * I}%) contrast(1.1) brightness(${0.92 + rnd(Math.floor(tGlobal * 16)) * 0.12})`; ctx.drawImage(src, 0, 0); ctx.filter = 'none';
      ctx.globalAlpha = 0.25 * I; ctx.globalCompositeOperation = 'overlay'; ctx.drawImage(noise(), rnd(tGlobal * 24) * 128, 0, 128, 128, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.5 * I; ctx.fillStyle = '#2a1f14';
      for (let i = 0; i < 2; i++) if (rnd(Math.floor(tGlobal * 8) + i) < 0.5) ctx.fillRect(rnd(Math.floor(tGlobal * 8) * 3 + i) * W, 0, 1.5 * k, H);
      vignette(ctx, W, H, 0.7 * I);
      break;
    }
    case 'pixelate': {
      const src = snapshot(ctx, W, H); const f = Math.max(4, 40 * I * Math.max(W, H) / 1920);
      const t = canvasLike(Math.ceil(W / f), Math.ceil(H / f), 'tmp'); t.x.drawImage(src, 0, 0, t.cv.width, t.cv.height);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(t.cv, 0, 0, W, H); ctx.imageSmoothingEnabled = true; break;
    }
    case 'flash': { const p = Math.max(0, 1 - local / Math.min(0.6, c.duration)); ctx.globalAlpha = p * I; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); break; }
    case 'strobe': { if (Math.floor(local * 8) % 2 === 0) { ctx.globalAlpha = 0.7 * Math.min(1, I); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); } break; }
    case 'lightLeak': {
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 2; i++) {
        const cx = W * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(local * 0.7 + i * 2))), cy = H * (0.3 + 0.4 * Math.cos(local * 0.5 + i));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.6);
        g.addColorStop(0, i ? `rgba(255,80,160,${0.55 * I})` : `rgba(255,170,60,${0.6 * I})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'spotlight': {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.18, W / 2, H / 2, Math.min(W, H) * 0.5);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.85 * Math.min(1, I)})`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
    }
    case 'rainbow': { const src = snapshot(ctx, W, H); ctx.filter = `hue-rotate(${(local * 180 * I) % 360}deg) saturate(1.4)`; ctx.drawImage(src, 0, 0); break; }
    case 'invertFlash': { if (Math.floor(local * 4) % 2 === 0) { const src = snapshot(ctx, W, H); ctx.filter = 'invert(1)'; ctx.drawImage(src, 0, 0); } break; }
    case 'bw': { const src = snapshot(ctx, W, H); ctx.filter = `grayscale(${Math.min(1, I)}) contrast(1.15)`; ctx.drawImage(src, 0, 0); break; }
    case 'blur': { const src = snapshot(ctx, W, H); ctx.filter = `blur(${12 * k * I}px)`; ctx.drawImage(src, 0, 0); break; }
    case 'letterbox': { const bar = H * 0.12 * Math.min(1.5, I) * Math.min(1, local / 0.4); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); break; }
    case 'vignette': vignette(ctx, W, H, Math.min(1, 0.9 * I)); break;
    case 'mirror': { const src = snapshot(ctx, W, H); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(src, 0, 0, W / 2, H, 0, 0, W / 2, H); break; }
    case 'kaleido': {
      const src = snapshot(ctx, W, H);
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(sx, sy); ctx.drawImage(src, W / 4, H / 4, W / 2, H / 2, 0, 0, W / 2, H / 2); ctx.restore(); }
      break;
    }
    case 'split2': case 'split3': case 'split4': {
      const src = snapshot(ctx, W, H);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (c.effect === 'split4') for (let i = 0; i < 4; i++) ctx.drawImage(src, (i % 2) * W / 2, Math.floor(i / 2) * H / 2, W / 2, H / 2);
      else {
        const n = c.effect === 'split2' ? 2 : 3, vertical = H > W;
        for (let i = 0; i < n; i++) {
          if (vertical) { const hh = H / n; ctx.drawImage(src, 0, (H - hh) / 2, W, hh, 0, i * hh, W, hh); }
          else { const ww = W / n; ctx.drawImage(src, (W - ww) / 2, 0, ww, H, i * ww, 0, ww, H); }
        }
      }
      break;
    }
    case 'snow': case 'confetti': case 'hearts': case 'sparkle': particles(ctx, W, H, local, c.effect, k * Math.max(0.5, I)); break;
  }
  ctx.restore();
}
function vignette(ctx, W, H, a) {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`);
  ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
}

// ---- Masks ------------------------------------------------------------------------------------
export const MASKS = { none: 'None', linear: 'Linear', mirror: 'Mirror', circle: 'Circle', rect: 'Rectangle', heart: 'Heart', star: 'Star' };
export const DEFAULT_MASK = { type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rot: 0, feather: 0.1, round: 0, invert: false };

let maskCv = null;
/** Apply mask to a layer canvas (lw×lh representing clip size w×h). */
export function applyMask(lc, lw, lh, m) {
  if (!maskCv) maskCv = document.createElement('canvas');
  maskCv.width = lw; maskCv.height = lh;
  const x = maskCv.getContext('2d');
  const cx = lw / 2 + m.x * lw, cy = lh / 2 + m.y * lh, mw = m.w * lw, mh = m.h * lh;
  const fb = m.feather * Math.min(lw, lh) * 0.25;
  if (fb > 0.5) x.filter = `blur(${fb}px)`;
  x.fillStyle = '#fff';
  x.translate(cx, cy); x.rotate((m.rot * Math.PI) / 180);
  x.beginPath();
  const big = Math.hypot(lw, lh) * 2;
  switch (m.type) {
    case 'linear': x.rect(-big, 0, big * 2, big); break;
    case 'mirror': x.rect(-big, -mh / 2, big * 2, mh); break;
    case 'circle': x.ellipse(0, 0, mw / 2, mh / 2, 0, 0, Math.PI * 2); break;
    case 'rect': x.roundRect(-mw / 2, -mh / 2, mw, mh, Math.min(mw, mh) / 2 * (m.round || 0)); break;
    case 'heart': {
      const s = Math.min(mw, mh) / 2;
      x.moveTo(0, s * 0.9);
      x.bezierCurveTo(-s * 1.6, -s * 0.1, -s * 0.6, -s * 1.3, 0, -s * 0.45);
      x.bezierCurveTo(s * 0.6, -s * 1.3, s * 1.6, -s * 0.1, 0, s * 0.9); break;
    }
    case 'star': for (let i = 0; i < 10; i++) { const r = (i % 2 ? 0.42 : 1) * Math.min(mw, mh) / 2, a = (i * Math.PI) / 5 - Math.PI / 2; i ? x.lineTo(Math.cos(a) * r, Math.sin(a) * r) : x.moveTo(Math.cos(a) * r, Math.sin(a) * r); } x.closePath(); break;
  }
  x.fill();
  lc.save(); lc.setTransform(1, 0, 0, 1, 0, 0); lc.filter = 'none';
  lc.globalCompositeOperation = m.invert ? 'destination-out' : 'destination-in';
  lc.drawImage(maskCv, 0, 0);
  lc.restore();
}

// ---- Chroma key -------------------------------------------------------------------------------
export function applyChroma(lc, lw, lh, ck) {
  const n = parseInt(ck.color.slice(1), 16), kr = (n >> 16) & 255, kg = (n >> 8) & 255, kb = n & 255;
  const kcb = -0.1687 * kr - 0.3313 * kg + 0.5 * kb, kcr = 0.5 * kr - 0.4187 * kg - 0.0813 * kb;
  const tol = (ck.tol ?? 30) * 1.6, soft = Math.max(1, (ck.soft ?? 15) * 1.6);
  const img = lc.getImageData(0, 0, lw, lh), d = img.data;
  const spill = (ck.spill ?? 50) / 100;
  const gDom = kg >= kr && kg >= kb, bDom = kb > kg && kb >= kr;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const cb = -0.1687 * r - 0.3313 * g + 0.5 * b, cr = 0.5 * r - 0.4187 * g - 0.0813 * b;
    const dist = Math.hypot(cb - kcb, cr - kcr);
    if (dist < tol) d[i + 3] = 0;
    else if (dist < tol + soft) {
      d[i + 3] = d[i + 3] * ((dist - tol) / soft);
      if (gDom && spill) d[i + 1] = Math.min(g, (r + b) / 2 + (g - (r + b) / 2) * (1 - spill));
      if (bDom && spill) d[i + 2] = Math.min(b, (r + g) / 2 + (b - (r + g) / 2) * (1 - spill));
    }
  }
  lc.putImageData(img, 0, 0);
}

// ---- AI background removal (MediaPipe selfie segmentation, loaded on demand) -------------------
let seg = null, loading = null, lastTs = 0;
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
export const bgState = { ready: false, error: null, loading: false, onReady: null };
export function loadSegmenter() {
  if (loading) return loading;
  bgState.loading = true;
  loading = (async () => {
    const vision = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
    try { seg = await vision.ImageSegmenter.createFromOptions(fileset, opts('GPU')); }
    catch { seg = await vision.ImageSegmenter.createFromOptions(fileset, opts('CPU')); }
    bgState.ready = true; bgState.loading = false; bgState.onReady?.();
  })().catch((e) => { bgState.error = e.message || String(e); bgState.loading = false; loading = null; console.error(e); });
  return loading;
}
let mCv = null, mCache = { key: null };
/** Returns a canvas whose alpha is the person mask for this source frame (or null while loading). */
export function personMask(src, key) {
  if (!seg) { loadSegmenter(); return null; }
  if (key && mCache.key === key) return mCv;
  lastTs = Math.max(lastTs + 1, performance.now());
  let r;
  try { r = seg.segmentForVideo(src, lastTs); } catch (e) { console.warn(e); return null; }
  const m = r.confidenceMasks?.[0];
  if (!m) { r.close?.(); return null; }
  const w = m.width, hh = m.height, f = m.getAsFloat32Array();
  if (!mCv) mCv = document.createElement('canvas');
  if (mCv.width !== w || mCv.height !== hh) { mCv.width = w; mCv.height = hh; }
  const x = mCv.getContext('2d'), img = x.createImageData(w, hh);
  for (let i = 0; i < f.length; i++) { const a = Math.max(0, Math.min(1, (f[i] - 0.35) / 0.3)); img.data[i * 4 + 3] = a * 255; }
  x.putImageData(img, 0, 0);
  r.close?.();
  mCache.key = key;
  return mCv;
}
