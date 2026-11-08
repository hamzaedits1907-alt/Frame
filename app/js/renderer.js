// Compositor: draws a project frame at time t onto a 2D canvas. Shared by preview and export.
import { clipsOn, clipEnd } from './store.js';
import { LOOKS, DEFAULT_ADJUST } from './presets.js';
import { mediaMap } from './media.js';
import { valAt, srcTime as mapTime } from './anim.js';
import { applyEffect, applyMask, applyChroma, personMask } from './fx.js';

const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeOutBounce = (x) => {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const srcTime = mapTime;
/** Animated transform at timeline time t (keyframes applied). */
export function transformAt(c, t) {
  const local = t - c.start, tr = c.transform;
  if (!c.kf) return tr;
  return { ...tr, x: valAt(c, 'x', local), y: valAt(c, 'y', local), scale: valAt(c, 'scale', local), rotation: valAt(c, 'rotation', local), opacity: valAt(c, 'opacity', local) };
}
export const scaleK = (W, H) => Math.min(W, H) / 1080;

/** All visual draw items at time t (bottom layer first). Includes outgoing clips during transitions. */
export function itemsAt(p, t) {
  const out = [];
  const tracks = p.tracks.filter((tr) => tr.kind === 'visual' && !tr.hidden).reverse();
  for (const tr of tracks) {
    const list = clipsOn(p, tr.id);
    const i = list.findIndex((c) => t >= c.start && t < clipEnd(c));
    if (i < 0) continue;
    const c = list[i];
    const tt = c.transition;
    if (c.type !== 'effect' && tt && tt.type !== 'none') {
      const prev = i > 0 && Math.abs(clipEnd(list[i - 1]) - c.start) < 0.02 ? list[i - 1] : null;
      const dur = Math.max(0.05, Math.min(tt.dur, c.duration, prev ? prev.duration + 10 : 99));
      if (t - c.start < dur) {
        const e = clamp01((t - c.start) / dur);
        if (prev) out.push({ clip: prev, t: srcTime(prev, t), trans: { role: 'out', type: tt.type, e } });
        out.push({ clip: c, t: srcTime(c, t), trans: { role: 'in', type: tt.type, e, hasPrev: !!prev } });
        continue;
      }
    }
    out.push({ clip: c, t: srcTime(c, t), trans: null });
  }
  return out;
}

// ---- Text layout ---------------------------------------------------------------------------
const measureCtx = document.createElement('canvas').getContext('2d');
export function textLayout(tx, k, ctx = measureCtx) {
  const size = Math.max(4, tx.size * k);
  const font = `${tx.italic ? 'italic ' : ''}${tx.bold ? '700 ' : '400 '}${size}px "${tx.font}", sans-serif`;
  ctx.save();
  ctx.font = font;
  try { ctx.letterSpacing = `${(tx.letterSpacing || 0) * k}px`; } catch {}
  const content = tx.uppercase ? String(tx.content).toUpperCase() : String(tx.content);
  const lines = content.split('\n');
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  ctx.restore();
  const lh = size * (tx.lineHeight || 1.15);
  const pad = tx.bg ? size * 0.35 : size * 0.1;
  const w = Math.max(...widths, size * 0.5) + pad * 2;
  const h = lines.length * lh + pad * 2;
  return { font, size, lines, widths, lh, pad, w, h };
}

/** Base (un-animated) size of a visual clip, before transform scale. */
export function baseSize(c, W, H) {
  const k = scaleK(W, H);
  if (c.type === 'video' || c.type === 'image') {
    const m = mediaMap.get(c.mediaId);
    const mw = (m?.width || 16) * (1 - c.crop.l - c.crop.r), mh = (m?.height || 9) * (1 - c.crop.t - c.crop.b);
    const s = Math.min(W / mw, H / mh);
    return { w: mw * s, h: mh * s };
  }
  if (c.type === 'text') { const L = textLayout(c.text, k); return { w: L.w, h: L.h }; }
  if (c.type === 'sticker') return { w: 300 * k, h: 300 * k };
  if (c.type === 'shape') {
    if (c.shape === 'line') return { w: 700 * k, h: 14 * k };
    if (c.shape === 'arrow') return { w: 500 * k, h: 160 * k };
    return { w: 400 * k * (c.shapeW || 1), h: 400 * k * (c.shapeH || 1) };
  }
  return { w: W, h: H }; // color, effect
}

/** Geometry of a clip on screen (for selection handles / hit testing). */
export function boxOf(c, W, H, t = null) {
  const b = baseSize(c, W, H);
  const tr = t == null ? c.transform : transformAt(c, t);
  return { cx: tr.x * W, cy: tr.y * H, w: b.w * tr.scale, h: b.h * tr.scale, rot: (tr.rotation * Math.PI) / 180 };
}

// ---- Effects --------------------------------------------------------------------------------
export function effectiveAdjust(c) {
  const a = { ...DEFAULT_ADJUST };
  const look = LOOKS[c.look]?.adj || {};
  for (const k in a) a[k] = (look[k] || 0) * (c.lookAmount ?? 1) + (c.adjust?.[k] || 0);
  return a;
}
function cssFilter(a, k, extraBlur = 0) {
  const f = [];
  if (a.brightness) f.push(`brightness(${1 + a.brightness / 100})`);
  if (a.contrast) f.push(`contrast(${Math.max(0, 1 + a.contrast / 100)})`);
  if (a.saturation) f.push(`saturate(${Math.max(0, 1 + a.saturation / 100)})`);
  if (a.hue) f.push(`hue-rotate(${a.hue}deg)`);
  if (a.grayscale) f.push(`grayscale(${Math.min(100, a.grayscale)}%)`);
  if (a.sepia) f.push(`sepia(${Math.min(100, a.sepia)}%)`);
  if (a.invert) f.push(`invert(${Math.min(100, a.invert)}%)`);
  const blur = (a.blur || 0) * 10 * k + extraBlur;
  if (blur > 0.05) f.push(`blur(${blur}px)`);
  return f.length ? f.join(' ') : 'none';
}

function computeFx(c, tGlobal, W, H, trans) {
  const fx = { dx: 0, dy: 0, sc: 1, rot: 0, alpha: 1, blur: 0, reveal: null, localReveal: null, chars: 1, flash: 0 };
  const k = scaleK(W, H);
  const a = c.anim || {};
  const local = tGlobal - c.start, remain = clipEnd(c) - tGlobal;
  // In animation
  if (a.in && a.in !== 'none' && local < a.inDur) {
    const raw = clamp01(local / Math.max(0.05, a.inDur)), p = easeOut(raw);
    switch (a.in) {
      case 'fade': fx.alpha *= p; break;
      case 'zoomIn': fx.sc *= 0.4 + 0.6 * p; fx.alpha *= p; break;
      case 'zoomOut': fx.sc *= 1.6 - 0.6 * p; fx.alpha *= p; break;
      case 'pop': fx.sc *= Math.max(0, easeOutBack(raw)); fx.alpha *= clamp01(raw * 3); break;
      case 'slideLeft': fx.dx += (1 - p) * W * 0.6; fx.alpha *= clamp01(raw * 2); break;
      case 'slideRight': fx.dx -= (1 - p) * W * 0.6; fx.alpha *= clamp01(raw * 2); break;
      case 'slideUp': fx.dy += (1 - p) * H * 0.35; fx.alpha *= clamp01(raw * 2); break;
      case 'slideDown': fx.dy -= (1 - p) * H * 0.35; fx.alpha *= clamp01(raw * 2); break;
      case 'spin': fx.rot -= (1 - p) * Math.PI * 2; fx.sc *= p; break;
      case 'blur': fx.blur += (1 - p) * 30 * k; fx.alpha *= p; break;
      case 'drop': fx.dy -= (1 - easeOutBounce(raw)) * H * 0.5; break;
      case 'typewriter': fx.chars = raw; break;
      case 'wipe': fx.localReveal = Math.min(fx.localReveal ?? 1, p); break;
    }
  }
  // Out animation
  if (a.out && a.out !== 'none' && remain < a.outDur) {
    const raw = clamp01(1 - remain / Math.max(0.05, a.outDur)), q = easeInOut(raw);
    switch (a.out) {
      case 'fade': fx.alpha *= 1 - q; break;
      case 'zoomIn': fx.sc *= 1 + q * 0.8; fx.alpha *= 1 - q; break;
      case 'zoomOut': case 'pop': fx.sc *= 1 - q; break;
      case 'slideLeft': fx.dx -= q * W * 0.6; fx.alpha *= 1 - q; break;
      case 'slideRight': fx.dx += q * W * 0.6; fx.alpha *= 1 - q; break;
      case 'slideUp': fx.dy -= q * H * 0.35; fx.alpha *= 1 - q; break;
      case 'slideDown': fx.dy += q * H * 0.35; fx.alpha *= 1 - q; break;
      case 'spin': fx.rot += q * Math.PI * 2; fx.sc *= 1 - q; break;
      case 'blur': fx.blur += q * 30 * k; fx.alpha *= 1 - q; break;
      case 'wipe': fx.localReveal = Math.min(fx.localReveal ?? 1, 1 - q); break;
    }
  }
  // Loop animation
  if (a.loop && a.loop !== 'none') {
    const lt = local * (a.loopSpeed || 1);
    switch (a.loop) {
      case 'kenburns': { const pr = clamp01(local / c.duration); fx.sc *= 1 + 0.18 * pr; fx.dx += (pr - 0.5) * W * 0.03; break; }
      case 'pulse': fx.sc *= 1 + 0.05 * Math.sin(lt * Math.PI * 2); break;
      case 'shake': fx.dx += Math.sin(lt * 53) * W * 0.006; fx.dy += Math.cos(lt * 41) * H * 0.006; break;
      case 'float': fx.dy += Math.sin(lt * 2) * H * 0.015; break;
      case 'swing': fx.rot += Math.sin(lt * 3) * 0.12; break;
      case 'heartbeat': fx.sc *= 1 + 0.12 * Math.pow(Math.max(0, Math.sin(lt * Math.PI * 2.4)), 10); break;
      case 'glitch': { const ph = (lt * 4) % 1; if (ph < 0.12) { const r = Math.sin(Math.floor(lt * 4) * 91.7); fx.dx += r * W * 0.02; fx.glitch = true; } break; }
    }
  }
  // Transition
  if (trans) {
    const e = easeInOut(trans.e), inn = trans.role === 'in';
    switch (trans.type) {
      case 'fade': if (inn) fx.alpha *= e; break;
      case 'black': fx.alpha *= inn ? clamp01(trans.e * 2 - 1) : clamp01(1 - trans.e * 2); if (inn && !trans.hasPrev) fx.alpha = e; break;
      case 'white': if (inn) { fx.alpha *= trans.e > 0.5 ? 1 : 0; fx.flash = 1 - Math.abs(trans.e * 2 - 1); } break;
      case 'slideLeft': if (inn) fx.dx += (1 - e) * W; break;
      case 'slideRight': if (inn) fx.dx -= (1 - e) * W; break;
      case 'slideUp': if (inn) fx.dy += (1 - e) * H; break;
      case 'push': fx.dx += inn ? (1 - e) * W : -e * W; break;
      case 'wipeLeft': if (inn) fx.reveal = { x: W * (1 - e), y: 0, w: W * e, h: H }; break;
      case 'wipeRight': if (inn) fx.reveal = { x: 0, y: 0, w: W * e, h: H }; break;
      case 'circle': if (inn) fx.circle = e * Math.hypot(W, H) / 2; break;
      case 'zoom': if (inn) { fx.sc *= 0.6 + 0.4 * e; fx.alpha *= e; } else { fx.sc *= 1 + e * 0.6; fx.alpha *= 1 - e; } break;
      case 'blur': if (inn) { fx.blur += (1 - e) * 25 * k; fx.alpha *= e; } else { fx.blur += e * 25 * k; } break;
      case 'spin': if (inn) { fx.rot -= (1 - e) * Math.PI; fx.sc *= Math.max(0.01, e); } break;
    }
  }
  return fx;
}

// ---- Layer canvas (for color overlays isolated to a clip) -------------------------------------
let layer = null;
function getLayer(w, h) {
  if (!layer) layer = document.createElement('canvas');
  if (layer.width < w || layer.height < h) { layer.width = Math.max(layer.width, w); layer.height = Math.max(layer.height, h); }
  const lc = layer.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, w, h);
  return { cv: layer, ctx: lc };
}

function drawShapePath(ctx, shape, w, h) {
  ctx.beginPath();
  if (shape === 'circle') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (shape === 'round') ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.18);
  else if (shape === 'line') ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
  else if (shape === 'arrow') {
    const hw = h * 0.5, sh = h * 0.18;
    ctx.moveTo(-w / 2, -sh); ctx.lineTo(w / 2 - hw, -sh); ctx.lineTo(w / 2 - hw, -h / 2); ctx.lineTo(w / 2, 0);
    ctx.lineTo(w / 2 - hw, h / 2); ctx.lineTo(w / 2 - hw, sh); ctx.lineTo(-w / 2, sh); ctx.closePath();
  } else if (shape === 'star') {
    for (let i = 0; i < 10; i++) {
      const r = (i % 2 ? 0.4 : 1) * w / 2, a = (i * Math.PI) / 5 - Math.PI / 2;
      i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
  } else ctx.rect(-w / 2, -h / 2, w, h);
}

function drawText(ctx, c, k, chars) {
  const tx = c.text;
  const L = textLayout(tx, k, ctx);
  ctx.font = L.font;
  try { ctx.letterSpacing = `${(tx.letterSpacing || 0) * k}px`; } catch {}
  ctx.textBaseline = 'middle';
  ctx.textAlign = tx.align;
  if (tx.bg) {
    ctx.save();
    ctx.globalAlpha *= tx.bgOpacity ?? 0.6;
    ctx.fillStyle = tx.bgColor;
    ctx.beginPath(); ctx.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, L.size * 0.2); ctx.fill();
    ctx.restore();
  }
  let total = L.lines.reduce((s, l) => s + l.length, 0);
  let budget = chars >= 1 ? Infinity : Math.floor(total * chars);
  const x = tx.align === 'left' ? -L.w / 2 + L.pad : tx.align === 'right' ? L.w / 2 - L.pad : 0;
  L.lines.forEach((line, i) => {
    if (budget <= 0) return;
    const s = budget === Infinity ? line : line.slice(0, budget);
    budget -= line.length;
    const y = -L.h / 2 + L.pad + L.lh * (i + 0.5);
    if (tx.glow > 0) {
      ctx.save(); ctx.shadowColor = tx.color; ctx.shadowBlur = L.size * 0.5 * tx.glow; ctx.fillStyle = tx.color;
      ctx.fillText(s, x, y); ctx.fillText(s, x, y); ctx.restore();
    }
    if (tx.shadow > 0) {
      ctx.save(); ctx.shadowColor = hexA(tx.shadowColor, Math.min(1, tx.shadow * 1.5)); ctx.shadowBlur = L.size * 0.15;
      ctx.shadowOffsetY = L.size * 0.05 * tx.shadow * 2; ctx.fillStyle = tx.color; ctx.fillText(s, x, y); ctx.restore();
    }
    if (tx.strokeWidth > 0) {
      ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = tx.strokeWidth * k * 2; ctx.strokeStyle = tx.strokeColor;
      ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = tx.color;
    ctx.fillText(s, x, y);
  });
}
function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Draws the raw visual of a clip centered at 0,0 with size w×h. */
function drawContent(ctx, c, src, w, h, k, fx) {
  if (c.type === 'video' || c.type === 'image') {
    if (!src) return;
    const sw0 = src.videoWidth || src.naturalWidth || src.width, sh0 = src.videoHeight || src.naturalHeight || src.height;
    if (!sw0 || !sh0) return;
    const sx = c.crop.l * sw0, sy = c.crop.t * sh0, sw = sw0 * (1 - c.crop.l - c.crop.r), sh = sh0 * (1 - c.crop.t - c.crop.b);
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(src, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  } else if (c.type === 'text') {
    drawText(ctx, c, k, fx.chars);
  } else if (c.type === 'sticker') {
    ctx.font = `${h * 0.85}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.sticker || '⭐', 0, h * 0.04);
  } else if (c.type === 'shape') {
    drawShapePath(ctx, c.shape, w, h);
    ctx.fillStyle = c.fill?.color || '#ffffff';
    ctx.fill();
  } else if (c.type === 'color') {
    const f = c.fill || { color: '#000' };
    if (f.gradient) {
      const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      g.addColorStop(0, f.gradient[0]); g.addColorStop(1, f.gradient[1]);
      ctx.fillStyle = g;
    } else ctx.fillStyle = f.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
}

function drawClip(ctx, item, src, W, H, tGlobal) {
  const c = item.clip;
  const k = scaleK(W, H);
  const fx = computeFx(c, tGlobal, W, H, item.trans);
  const tr = transformAt(c, tGlobal);
  const alpha = tr.opacity * fx.alpha;
  if (alpha <= 0.001 || fx.sc <= 0.0001) return fx;
  const { w, h } = baseSize(c, W, H);
  const adj = effectiveAdjust(c);
  const filter = cssFilter(adj, k, fx.blur);
  const media = c.type === 'video' || c.type === 'image';
  const hasMask = c.mask && c.mask.type !== 'none';
  const hasChroma = media && c.chroma?.on;
  const hasCut = media && c.bgRemove;
  const needsLayer = adj.temperature || adj.tint || adj.vignette > 0 || fx.glitch || hasMask || hasChroma || hasCut;

  ctx.save();
  if (fx.reveal) { ctx.beginPath(); ctx.rect(fx.reveal.x, fx.reveal.y, fx.reveal.w, fx.reveal.h); ctx.clip(); }
  if (fx.circle != null) { ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.max(0.1, fx.circle), 0, Math.PI * 2); ctx.clip(); }
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = c.blend || 'source-over';
  ctx.translate(tr.x * W + fx.dx, tr.y * H + fx.dy);
  ctx.rotate((tr.rotation * Math.PI) / 180 + fx.rot);
  const s = tr.scale * fx.sc;
  ctx.scale(s * (tr.flipH ? -1 : 1), s * (tr.flipV ? -1 : 1));
  if (fx.localReveal != null) { ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w * fx.localReveal, h); ctx.clip(); }
  if (c.radius > 0) {
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, (Math.min(w, h) / 2) * Math.min(1, c.radius / 100)); ctx.clip();
  }

  if (!needsLayer) {
    ctx.filter = filter;
    drawContent(ctx, c, src, w, h, k, fx);
  } else {
    // Render into an isolated layer at device resolution, then composite.
    const m = ctx.getTransform();
    const devScale = Math.hypot(m.a, m.b) || 1;
    const lw = Math.ceil(Math.min(w * devScale, 4096)), lh = Math.ceil(Math.min(h * devScale, 4096));
    if (lw > 0 && lh > 0) {
      const L = getLayer(lw, lh);
      const lc = L.ctx;
      lc.save(); lc.translate(lw / 2, lh / 2); lc.scale(lw / w, lh / h);
      lc.filter = filter;
      drawContent(lc, c, src, w, h, k, fx);
      lc.restore();
      if (adj.temperature || adj.tint || adj.vignette > 0 || fx.glitch) {
        lc.save();
        if (adj.temperature) { lc.fillStyle = adj.temperature > 0 ? `rgba(255,140,30,${Math.min(0.5, adj.temperature / 220)})` : `rgba(30,120,255,${Math.min(0.5, -adj.temperature / 220)})`; lc.globalCompositeOperation = 'overlay'; lc.fillRect(0, 0, lw, lh); }
        if (adj.tint) { lc.fillStyle = adj.tint > 0 ? `rgba(255,0,180,${Math.min(0.4, adj.tint / 250)})` : `rgba(0,255,90,${Math.min(0.4, -adj.tint / 250)})`; lc.globalCompositeOperation = 'overlay'; lc.fillRect(0, 0, lw, lh); }
        if (adj.vignette > 0) {
          const g = lc.createRadialGradient(lw / 2, lh / 2, Math.min(lw, lh) * 0.25, lw / 2, lh / 2, Math.hypot(lw, lh) / 2);
          g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${Math.min(0.95, adj.vignette / 100)})`);
          lc.globalCompositeOperation = 'source-over'; lc.fillStyle = g; lc.fillRect(0, 0, lw, lh);
        }
        if (fx.glitch) { lc.globalCompositeOperation = 'screen'; lc.globalAlpha = 0.5; lc.drawImage(L.cv, 0, 0, lw, lh, lw * 0.012, 0, lw, lh); lc.globalAlpha = 1; }
        // Restore the clip's own alpha mask
        lc.globalCompositeOperation = 'destination-in';
        lc.translate(lw / 2, lh / 2); lc.scale(lw / w, lh / h); lc.filter = 'none';
        drawContent(lc, c, src, w, h, k, fx);
        lc.restore();
      }
      if (hasChroma) applyChroma(lc, lw, lh, c.chroma);
      if (hasCut && src) {
        const mk = personMask(src, `${c.id}:${item.t.toFixed(3)}:${src.currentSrc || src.src}`);
        if (mk) {
          const mw = mk.width, mh = mk.height;
          lc.save(); lc.globalCompositeOperation = 'destination-in'; lc.filter = `blur(${Math.max(0.5, lw / 600)}px)`;
          lc.drawImage(mk, c.crop.l * mw, c.crop.t * mh, mw * (1 - c.crop.l - c.crop.r), mh * (1 - c.crop.t - c.crop.b), 0, 0, lw, lh);
          lc.restore();
        }
      }
      if (hasMask) applyMask(lc, lw, lh, c.mask);
      ctx.drawImage(L.cv, 0, 0, lw, lh, -w / 2, -h / 2, w, h);
    }
  }
  ctx.restore();
  return fx;
}

/**
 * Render one frame. getSource(clip, item) returns a drawable (video/img) for media clips.
 */
export function renderFrame(ctx, p, t, W, H, getSource) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.fillStyle = p.background?.color || '#000';
  ctx.fillRect(0, 0, W, H);
  const items = itemsAt(p, t);
  // Blurred background fill (CapCut-style) from the bottom-most media clip.
  if (p.background?.mode === 'blur') {
    const base = items.find((it) => it.clip.type === 'video' || it.clip.type === 'image');
    const src = base && getSource(base.clip, base);
    if (src) {
      const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight;
      if (sw && sh) {
        const s = Math.max(W / sw, H / sh) * 1.1;
        ctx.filter = `blur(${Math.round(40 * scaleK(W, H))}px) brightness(0.75)`;
        ctx.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
        ctx.filter = 'none';
      }
    }
  }
  let flash = 0;
  const k = scaleK(W, H);
  for (const it of items) {
    if (it.clip.type === 'effect') {
      if (flash > 0) { ctx.save(); ctx.globalAlpha = flash; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore(); flash = 0; }
      applyEffect(ctx, W, H, it.clip, t - it.clip.start, k);
      continue;
    }
    const src = it.clip.type === 'video' || it.clip.type === 'image' ? getSource(it.clip, it) : null;
    const fx = drawClip(ctx, it, src, W, H, t);
    if (fx?.flash) flash = Math.max(flash, fx.flash);
  }
  if (flash > 0) { ctx.globalAlpha = flash; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
  return items;
}
