// Pixel operations for Frame Photo: adjustments, filters, flood fill. Work on ImageData in place.

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function lutApply(d, lr, lg = lr, lb = lr) { for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; } }
const makeLut = (f) => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = f(i); return l; };

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hue2rgb(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
function hsl2rgb(h, s, l) {
  if (!s) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/** Monotone curve through points [[x,y]...] -> LUT */
function curveLut(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0]);
  return makeLut((x) => {
    let i = 0; while (i < pts.length - 2 && x > pts[i + 1][0]) i++;
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const u = x1 === x0 ? 0 : (x - x0) / (x1 - x0), s = u * u * (3 - 2 * u);
    return y0 + (y1 - y0) * (0.5 * u + 0.5 * s);
  });
}

// ---- Adjustments (name -> {params, fn}) --------------------------------------------------------
export const ADJUSTMENTS = {
  brightnessContrast: { name: 'Brightness / Contrast', params: [['brightness', 'Brightness', -150, 150, 0], ['contrast', 'Contrast', -100, 100, 0]],
    fn: (d, p) => { const c = (100 + p.contrast) / 100; const k = c * c; lutApply(d, makeLut((v) => (v - 128) * k + 128 + p.brightness)); } },
  levels: { name: 'Levels', params: [['inBlack', 'Input black', 0, 254, 0], ['inWhite', 'Input white', 1, 255, 255], ['gamma', 'Midtones (gamma)', 0.1, 3, 1, 0.01], ['outBlack', 'Output black', 0, 255, 0], ['outWhite', 'Output white', 0, 255, 255]],
    fn: (d, p) => lutApply(d, makeLut((v) => { const n = Math.max(0, Math.min(1, (v - p.inBlack) / Math.max(1, p.inWhite - p.inBlack))); return p.outBlack + Math.pow(n, 1 / p.gamma) * (p.outWhite - p.outBlack); })) },
  curves: { name: 'Curves', params: [['shadows', 'Shadows', -64, 64, 0], ['midtones', 'Midtones', -64, 64, 0], ['highlights', 'Highlights', -64, 64, 0], ['blacks', 'Blacks', -64, 64, 0], ['whites', 'Whites', -64, 64, 0]],
    fn: (d, p) => lutApply(d, curveLut([[0, Math.max(0, p.blacks)], [64, 64 + p.shadows], [128, 128 + p.midtones], [192, 192 + p.highlights], [255, Math.min(255, 255 + p.whites)]])) },
  exposure: { name: 'Exposure', params: [['exposure', 'Exposure (EV)', -3, 3, 0, 0.05], ['offset', 'Offset', -60, 60, 0], ['gamma', 'Gamma', 0.2, 3, 1, 0.01]],
    fn: (d, p) => { const m = Math.pow(2, p.exposure); lutApply(d, makeLut((v) => 255 * Math.pow(Math.max(0, (v * m + p.offset) / 255), 1 / p.gamma))); } },
  hueSaturation: { name: 'Hue / Saturation', params: [['hue', 'Hue', -180, 180, 0], ['saturation', 'Saturation', -100, 100, 0], ['lightness', 'Lightness', -100, 100, 0]],
    fn: (d, p) => {
      const hs = p.hue / 360, ss = 1 + p.saturation / 100, ls = p.lightness / 100;
      for (let i = 0; i < d.length; i += 4) {
        let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
        h = (h + hs + 1) % 1; s = Math.min(1, s * ss); l = ls >= 0 ? l + (1 - l) * ls : l * (1 + ls);
        const [r, g, b] = hsl2rgb(h, s, l); d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    } },
  vibrance: { name: 'Vibrance', params: [['vibrance', 'Vibrance', -100, 100, 30], ['saturation', 'Saturation', -100, 100, 0]],
    fn: (d, p) => {
      const v = p.vibrance / 100, sat = 1 + p.saturation / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), avg = (r + g + b) / 3;
        const amt = (((Math.abs(mx - avg) * 2) / 255) * -1 + 1) * v * 1.5 + (sat - 1);
        d[i] = clamp8(r + (r - avg) * amt); d[i + 1] = clamp8(g + (g - avg) * amt); d[i + 2] = clamp8(b + (b - avg) * amt);
      }
    } },
  colorBalance: { name: 'Color balance', params: [['temperature', 'Temperature', -100, 100, 0], ['tint', 'Tint', -100, 100, 0], ['red', 'Cyan ↔ Red', -100, 100, 0], ['green', 'Magenta ↔ Green', -100, 100, 0], ['blue', 'Yellow ↔ Blue', -100, 100, 0]],
    fn: (d, p) => {
      const r = p.temperature * 0.5 + p.red * 0.6, g = -p.tint * 0.5 + p.green * 0.6, b = -p.temperature * 0.5 + p.blue * 0.6;
      lutApply(d, makeLut((v) => v + r * (1 - Math.abs(v - 128) / 160)), makeLut((v) => v + g * (1 - Math.abs(v - 128) / 160)), makeLut((v) => v + b * (1 - Math.abs(v - 128) / 160)));
    } },
  blackWhite: { name: 'Black & white', params: [['reds', 'Reds', -50, 150, 40], ['greens', 'Greens', -50, 150, 40], ['blues', 'Blues', -50, 150, 20], ['tint', 'Tint (sepia)', 0, 100, 0]],
    fn: (d, p) => {
      const s = p.reds + p.greens + p.blues || 1, wr = p.reds / s, wg = p.greens / s, wb = p.blues / s, t = p.tint / 100;
      for (let i = 0; i < d.length; i += 4) { const y = clamp8(d[i] * wr + d[i + 1] * wg + d[i + 2] * wb); d[i] = clamp8(y + 40 * t); d[i + 1] = clamp8(y + 15 * t); d[i + 2] = clamp8(y - 25 * t); }
    } },
  invert: { name: 'Invert', params: [], fn: (d) => lutApply(d, makeLut((v) => 255 - v)) },
  posterize: { name: 'Posterize', params: [['levels', 'Levels', 2, 32, 6]], fn: (d, p) => { const n = Math.round(p.levels) - 1; lutApply(d, makeLut((v) => Math.round((v / 255) * n) * (255 / n))); } },
  threshold: { name: 'Threshold', params: [['level', 'Level', 1, 254, 128]], fn: (d, p) => { for (let i = 0; i < d.length; i += 4) { const y = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; d[i] = d[i + 1] = d[i + 2] = y >= p.level ? 255 : 0; } } },
  autoTone: { name: 'Auto tone', params: [],
    fn: (d) => {
      const lo = [], hi = [];
      for (let c = 0; c < 3; c++) {
        const hist = new Uint32Array(256); let n = 0;
        for (let i = c; i < d.length; i += 4) if (d[i - c + 3]) { hist[d[i]]++; n++; }
        let acc = 0, a = 0, b = 255; const cut = n * 0.005;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { a = v; break; } }
        acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { b = v; break; } }
        lo.push(a); hi.push(Math.max(a + 1, b));
      }
      lutApply(d, ...[0, 1, 2].map((c) => makeLut((v) => ((v - lo[c]) * 255) / (hi[c] - lo[c]))));
    } },
};

// ---- Filters --------------------------------------------------------------------------------------
function convolve(img, k, divisor = 1, bias = 0) {
  const { width: w, height: h, data: s } = img, out = new Uint8ClampedArray(s.length), n = Math.sqrt(k.length) | 0, half = n >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let ky = 0; ky < n; ky++) for (let kx = 0; kx < n; kx++) {
      const sx = Math.min(w - 1, Math.max(0, x + kx - half)), sy = Math.min(h - 1, Math.max(0, y + ky - half)), o = (sy * w + sx) * 4, kv = k[ky * n + kx];
      r += s[o] * kv; g += s[o + 1] * kv; b += s[o + 2] * kv;
    }
    const o = (y * w + x) * 4;
    out[o] = r / divisor + bias; out[o + 1] = g / divisor + bias; out[o + 2] = b / divisor + bias; out[o + 3] = s[o + 3];
  }
  s.set(out);
}

/** Filters that work on a canvas (some use the GPU via canvas filters). */
export const FILTERS = {
  gaussian: { name: 'Gaussian blur', params: [['radius', 'Radius (px)', 0.5, 80, 6, 0.5]], canvas: (cv, p) => blurCanvas(cv, p.radius) },
  motion: { name: 'Motion blur', params: [['distance', 'Distance', 2, 120, 30], ['angle', 'Angle', -180, 180, 0]],
    canvas: (cv, p) => {
      const src = copyCanvas(cv), x = cv.getContext('2d'), n = Math.max(6, Math.round(p.distance / 2)), a = (p.angle * Math.PI) / 180;
      x.clearRect(0, 0, cv.width, cv.height);
      for (let i = 0; i < n; i++) { const t = (i / (n - 1) - 0.5) * p.distance; x.globalAlpha = 1 / (i + 1); x.drawImage(src, Math.cos(a) * t, Math.sin(a) * t); }
      x.globalAlpha = 1;
    } },
  sharpen: { name: 'Sharpen', params: [['amount', 'Amount', 0.1, 3, 0.8, 0.05]], data: (img, p) => { const a = p.amount; convolve(img, [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]); } },
  unsharp: { name: 'Unsharp mask', params: [['amount', 'Amount %', 10, 300, 120], ['radius', 'Radius', 0.5, 20, 2, 0.5]],
    canvas: (cv, p) => {
      const blurred = copyCanvas(cv); blurCanvas(blurred, p.radius);
      const x = cv.getContext('2d'), a = x.getImageData(0, 0, cv.width, cv.height), b = blurred.getContext('2d').getImageData(0, 0, cv.width, cv.height), k = p.amount / 100;
      for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) a.data[i + c] = clamp8(a.data[i + c] + (a.data[i + c] - b.data[i + c]) * k);
      x.putImageData(a, 0, 0);
    } },
  noise: { name: 'Add noise', params: [['amount', 'Amount', 1, 100, 20], ['mono', 'Monochrome (0/1)', 0, 1, 1]],
    data: (img, p) => { const d = img.data, a = p.amount * 2.55; for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * a; d[i] = clamp8(d[i] + n); d[i + 1] = clamp8(d[i + 1] + (p.mono >= 0.5 ? n : (Math.random() - 0.5) * a)); d[i + 2] = clamp8(d[i + 2] + (p.mono >= 0.5 ? n : (Math.random() - 0.5) * a)); } } },
  denoise: { name: 'Reduce noise', params: [['strength', 'Strength', 1, 3, 1, 1]], data: (img, p) => { for (let i = 0; i < p.strength; i++) convolve(img, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16); } },
  pixelate: { name: 'Pixelate', params: [['size', 'Cell size', 2, 100, 12]],
    canvas: (cv, p) => { const s = Math.max(1, Math.round(p.size)), t = document.createElement('canvas'); t.width = Math.ceil(cv.width / s); t.height = Math.ceil(cv.height / s); t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height); const x = cv.getContext('2d'); x.clearRect(0, 0, cv.width, cv.height); x.imageSmoothingEnabled = false; x.drawImage(t, 0, 0, cv.width, cv.height); x.imageSmoothingEnabled = true; } },
  emboss: { name: 'Emboss', params: [], data: (img) => convolve(img, [-2, -1, 0, -1, 1, 1, 0, 1, 2]) },
  edges: { name: 'Find edges', params: [],
    data: (img) => {
      const { width: w, height: h, data: s } = img, g = new Float32Array(w * h), out = new Uint8ClampedArray(s.length);
      for (let i = 0; i < w * h; i++) g[i] = s[i * 4] * 0.3 + s[i * 4 + 1] * 0.59 + s[i * 4 + 2] * 0.11;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
        const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
        const v = 255 - Math.min(255, Math.hypot(gx, gy));
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = s[i * 4 + 3];
      }
      s.set(out);
    } },
  vignette: { name: 'Vignette', params: [['amount', 'Amount', 0, 100, 60], ['size', 'Size', 10, 100, 60]],
    canvas: (cv, p) => { const x = cv.getContext('2d'), w = cv.width, h = cv.height, g = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * (p.size / 200), w / 2, h / 2, Math.hypot(w, h) / 2); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${p.amount / 100})`); x.globalCompositeOperation = 'source-atop'; x.fillStyle = g; x.fillRect(0, 0, w, h); x.globalCompositeOperation = 'source-over'; } },
  glow: { name: 'Soft glow (bloom)', params: [['radius', 'Radius', 2, 60, 18], ['strength', 'Strength %', 0, 100, 50]],
    canvas: (cv, p) => { const b = copyCanvas(cv); blurCanvas(b, p.radius); const x = cv.getContext('2d'); x.globalAlpha = p.strength / 100; x.globalCompositeOperation = 'screen'; x.drawImage(b, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; } },
  oil: { name: 'Painted look', params: [['radius', 'Brush', 1, 6, 3, 1]],
    data: (img, p) => {
      const { width: w, height: h, data: s } = img, out = new Uint8ClampedArray(s), r = Math.round(p.radius), L = 20;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cnt = new Uint16Array(L), sr = new Uint32Array(L), sg = new Uint32Array(L), sb = new Uint32Array(L);
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy)), o = (yy * w + xx) * 4;
          const lv = Math.min(L - 1, (((s[o] + s[o + 1] + s[o + 2]) / 3) * L) / 256 | 0);
          cnt[lv]++; sr[lv] += s[o]; sg[lv] += s[o + 1]; sb[lv] += s[o + 2];
        }
        let best = 0; for (let i = 1; i < L; i++) if (cnt[i] > cnt[best]) best = i;
        const o = (y * w + x) * 4; out[o] = sr[best] / cnt[best]; out[o + 1] = sg[best] / cnt[best]; out[o + 2] = sb[best] / cnt[best];
      }
      s.set(out);
    } },
};

export function copyCanvas(cv) { const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; c.getContext('2d').drawImage(cv, 0, 0); return c; }
export function blurCanvas(cv, r) {
  const src = copyCanvas(cv), x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height); x.filter = `blur(${r}px)`; x.drawImage(src, 0, 0); x.filter = 'none';
}

/** Run an adjustment or filter on a canvas in place. */
export function applyOp(cv, op, params) {
  if (!cv.width || !cv.height) return;
  if (op.canvas) { op.canvas(cv, params); return; }
  const x = cv.getContext('2d', { willReadFrequently: true });
  const img = x.getImageData(0, 0, cv.width, cv.height);
  if (op.fn) op.fn(img.data, params, img); else op.data(img, params);
  x.putImageData(img, 0, 0);
}

/** Flood fill mask from a seed. Returns Uint8Array (1 = selected). */
export function floodMask(img, sx, sy, tol, contiguous = true) {
  const { width: w, height: h, data: d } = img, out = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const o = (sy * w + sx) * 4, r0 = d[o], g0 = d[o + 1], b0 = d[o + 2], a0 = d[o + 3];
  const match = (i) => { const j = i * 4; return Math.max(Math.abs(d[j] - r0), Math.abs(d[j + 1] - g0), Math.abs(d[j + 2] - b0), Math.abs(d[j + 3] - a0)) <= tol; };
  if (!contiguous) { for (let i = 0; i < w * h; i++) if (match(i)) out[i] = 1; return out; }
  const stack = [sy * w + sx];
  while (stack.length) {
    const i = stack.pop(); if (out[i] || !match(i)) continue;
    // scanline fill
    let x = i % w, y = (i / w) | 0, l = x, r = x;
    while (l > 0 && !out[y * w + l - 1] && match(y * w + l - 1)) l--;
    while (r < w - 1 && !out[y * w + r + 1] && match(y * w + r + 1)) r++;
    for (let k = l; k <= r; k++) {
      out[y * w + k] = 1;
      if (y > 0 && !out[(y - 1) * w + k]) stack.push((y - 1) * w + k);
      if (y < h - 1 && !out[(y + 1) * w + k]) stack.push((y + 1) * w + k);
    }
  }
  return out;
}

/** Bounding box of non-transparent pixels. */
export function alphaBounds(cv) {
  const x = cv.getContext('2d', { willReadFrequently: true }), { data: d } = x.getImageData(0, 0, cv.width, cv.height);
  let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++) for (let xx = 0; xx < cv.width; xx++) if (d[(y * cv.width + xx) * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
