// Frame Photo: a layer-based image editor (Photoshop-style).
import { h, iconBtn, toast, modal, pickFiles, debounce, uid, clamp, promptDialog } from './util.js';
import { icon } from './icons.js';
import { db } from './db.js';
import { ADJUSTMENTS, FILTERS, applyOp, copyCanvas, floodMask, alphaBounds } from './imgops.js';
import { showContextMenu, sliderRow, toggle } from './ui.js';
import { personMask, loadSegmenter, bgState } from './fx.js';
import { nvChat, parseJSON } from './nv.js';
import { FONTS } from './presets.js';

const newCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const ctx2 = (c) => c.getContext('2d', { willReadFrequently: true });
const hexA = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const BLENDS = [['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'], ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];
const SIZES = [['Instagram post', 1080, 1080], ['Instagram story / TikTok', 1080, 1920], ['YouTube thumbnail', 1280, 720], ['Full HD', 1920, 1080], ['4K', 3840, 2160], ['A4 print (300dpi)', 2480, 3508], ['Twitter / X header', 1500, 500], ['Square small', 512, 512]];

const TOOLS = [
  ['move', 'move', 'Move (V)', 'v'], ['marquee', 'marquee', 'Rectangle select (M)', 'm'], ['ellipse', 'ellipseSel', 'Ellipse select', null], ['lasso', 'lasso', 'Lasso (L)', 'l'],
  ['wand', 'wand', 'Magic wand (W)', 'w'], ['crop', 'crop', 'Crop (C)', 'c'], ['-'], ['brush', 'brush', 'Brush (B)', 'b'], ['eraser', 'eraser', 'Eraser (E)', 'e'],
  ['clone', 'stamp', 'Clone stamp (S) - Alt+click to set source', 's'], ['blurb', 'droplet', 'Blur brush (R)', 'r'], ['dodge', 'sun', 'Dodge - lighten (O)', 'o'], ['burn', 'moon', 'Burn - darken', null],
  ['fill', 'bucket', 'Paint bucket (G)', 'g'], ['gradient', 'gradient', 'Gradient (N)', 'n'], ['-'], ['text', 'text', 'Text (T)', 't'], ['shape', 'shapes', 'Shapes (U)', 'u'],
  ['eyedropper', 'pipette', 'Eyedropper (I)', 'i'], ['hand', 'hand', 'Hand (H) - or hold Space', 'h'], ['zoom', 'zoomIn', 'Zoom (Z) - Alt to zoom out', 'z'],
];
const PAINT = new Set(['brush', 'eraser', 'clone', 'blurb', 'dodge', 'burn']);

export async function openPhotoEditor(app, { id = null, file = null, onExit, onSendToVideo } = {}) {
  // ---------------- State ----------------
  const S = {
    id: id || uid('ph_'), name: 'Untitled image', w: 1080, h: 1080, layers: [], active: null,
    zoom: 1, panX: 0, panY: 0, tool: 'brush', fg: '#ffffff', bg: '#000000',
    o: { size: 40, hardness: 0.7, opacity: 1, flow: 1, strength: 0.5, tolerance: 32, contiguous: true, sampleAll: true, selMode: 'new', feather: 0, gradType: 'linear', gradTransparent: false, shape: 'rect', shapeFill: true, strokeW: 6, font: 'Montserrat', fontSize: 120, autoSelect: true, cropRatio: 0, selModeBase: 'new' },
    sel: null, undo: [], redo: [], dirty: false, cloneSrc: null,
  };
  const comp = newCanvas(1, 1);

  // ---------------- Layers ----------------
  function makeLayer(name, w = S.w, h = S.h, extra = {}) {
    return { id: uid('l_'), name, type: 'raster', canvas: newCanvas(w, h), x: 0, y: 0, opacity: 1, blend: 'source-over', visible: true, locked: false, fx: {}, ...extra };
  }
  const active = () => S.layers.find((l) => l.id === S.active);
  function addLayer(l, above = active()) {
    const i = above ? S.layers.indexOf(above) + 1 : S.layers.length;
    S.layers.splice(i, 0, l); S.active = l.id; return l;
  }
  function renderText(l) {
    const t = l.text, x0 = ctx2(newCanvas(1, 1));
    const font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${t.size}px "${t.font}", sans-serif`;
    x0.font = font; try { x0.letterSpacing = `${t.letterSpacing || 0}px`; } catch {}
    const lines = String(t.content).split('\n'), lh = t.size * (t.lineHeight || 1.2), pad = Math.ceil(t.size * 0.25 + (t.strokeWidth || 0));
    const w = Math.max(...lines.map((s) => x0.measureText(s || ' ').width)) + pad * 2, hh = lines.length * lh + pad * 2;
    const c = newCanvas(w, hh), x = c.getContext('2d');
    x.font = font; try { x.letterSpacing = `${t.letterSpacing || 0}px`; } catch {}
    x.textBaseline = 'middle'; x.textAlign = t.align || 'left'; x.lineJoin = 'round';
    const tx = t.align === 'center' ? w / 2 : t.align === 'right' ? w - pad : pad;
    lines.forEach((s, i) => {
      const y = pad + lh * (i + 0.5);
      if (t.strokeWidth > 0) { x.lineWidth = t.strokeWidth * 2; x.strokeStyle = t.strokeColor; x.strokeText(s, tx, y); }
      x.fillStyle = t.color; x.fillText(s, tx, y);
    });
    l.canvas = c;
  }

  // ---------------- History ----------------
  const meta = (l) => ({ id: l.id, name: l.name, type: l.type, x: l.x, y: l.y, opacity: l.opacity, blend: l.blend, visible: l.visible, locked: l.locked, fx: { ...l.fx }, text: l.text ? { ...l.text } : undefined });
  const snapshot = () => ({ w: S.w, h: S.h, active: S.active, layers: S.layers.map((l) => ({ ...meta(l), canvas: copyCanvas(l.canvas) })) });
  function restore(s) { S.w = s.w; S.h = s.h; S.active = s.active; S.layers = s.layers.map((l) => ({ ...l, fx: { ...l.fx }, canvas: copyCanvas(l.canvas) })); S.sel = null; S.xf = null; S.crop = null; updateSelOverlay(); }
  function push(label) {
    S.undo.push({ label, s: snapshot() }); S.redo = [];
    let bytes = 0; for (const u of S.undo) for (const l of u.s.layers) bytes += l.canvas.width * l.canvas.height * 4;
    while (S.undo.length > 2 && (S.undo.length > 40 || bytes > 700e6)) { const u = S.undo.shift(); for (const l of u.s.layers) bytes -= l.canvas.width * l.canvas.height * 4; }
    changed();
  }
  function undo() { const u = S.undo.pop(); if (!u) return; S.redo.push({ label: u.label, s: snapshot() }); restore(u.s); changed(true); toast('Undo: ' + u.label); }
  function redo() { const r = S.redo.pop(); if (!r) return; S.undo.push({ label: r.label, s: snapshot() }); restore(r.s); changed(true); toast('Redo: ' + r.label); }

  // ---------------- Selection ----------------
  let selOverlay = null;
  function setSelection(maskCanvas, outline = null) {
    const m = S.o.selMode, cur = S.sel;
    if (cur && (m === 'add' || m === 'sub')) {
      const x = cur.mask.getContext('2d'); x.globalCompositeOperation = m === 'add' ? 'source-over' : 'destination-out';
      x.drawImage(maskCanvas, 0, 0); x.globalCompositeOperation = 'source-over';
      S.sel = { mask: cur.mask, outline: null };
    } else S.sel = { mask: maskCanvas, outline };
    if (S.o.feather > 0) featherSel(S.o.feather, false);
    updateSelOverlay();
  }
  function shapeMask(drawPath) { const c = newCanvas(S.w, S.h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.beginPath(); drawPath(x); x.fill(); return c; }
  function featherSel(r, notify = true) {
    if (!S.sel) return; const c = newCanvas(S.w, S.h), x = c.getContext('2d'); x.filter = `blur(${r}px)`; x.drawImage(S.sel.mask, 0, 0);
    S.sel = { mask: c, outline: S.sel.outline }; if (notify) updateSelOverlay();
  }
  function updateSelOverlay() {
    if (!S.sel) { selOverlay = null; requestRender(); return; }
    selOverlay = newCanvas(S.w, S.h); const x = selOverlay.getContext('2d');
    x.fillStyle = 'rgba(10,10,20,0.5)'; x.fillRect(0, 0, S.w, S.h); x.globalCompositeOperation = 'destination-out'; x.drawImage(S.sel.mask, 0, 0);
    requestRender();
  }
  const deselect = () => { S.sel = null; updateSelOverlay(); };
  function selectAll() { S.o.selMode = 'new'; setSelection(shapeMask((x) => x.rect(0, 0, S.w, S.h)), new Path2D(`M0 0H${S.w}V${S.h}H0Z`)); }
  function invertSel() { if (!S.sel) return selectAll(); const c = newCanvas(S.w, S.h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, S.w, S.h); x.globalCompositeOperation = 'destination-out'; x.drawImage(S.sel.mask, 0, 0); S.sel = { mask: c, outline: null }; updateSelOverlay(); }
  /** Clip a layer-space canvas to the selection. */
  function clipToSel(c, l) { if (!S.sel) return; const x = c.getContext('2d'); x.save(); x.globalCompositeOperation = 'destination-in'; x.drawImage(S.sel.mask, -l.x, -l.y); x.restore(); }
  /** Apply fn to the active layer canvas, limited to the selection. */
  function modifyLayer(label, fn, l = active()) {
    if (!l) return toast('Select a layer first');
    if (l.locked) return toast('Layer is locked');
    if (l.type === 'text') rasterize(l, false);
    push(label);
    if (!S.sel) { fn(l.canvas); }
    else {
      const work = copyCanvas(l.canvas); fn(work); clipToSel(work, l);
      const x = l.canvas.getContext('2d'); x.save(); x.globalCompositeOperation = 'destination-out'; x.drawImage(S.sel.mask, -l.x, -l.y); x.restore();
      x.drawImage(work, 0, 0);
    }
    changed(true);
  }
  function rasterize(l, withHistory = true) { if (l.type !== 'text') return; if (withHistory) push('Rasterize'); l.type = 'raster'; delete l.text; changed(true); }

  // ---------------- Compositing ----------------
  let strokeBuf = null, strokeMode = null;
  function drawLayer(x, l, src = l.canvas) {
    const fx = l.fx || {};
    x.save(); x.globalAlpha = l.opacity; x.globalCompositeOperation = l.blend;
    const OFF = 20000;
    if (fx.stroke) {
      const sil = copyCanvas(src), sx = sil.getContext('2d'); sx.globalCompositeOperation = 'source-in'; sx.fillStyle = fx.strokeColor || '#000'; sx.fillRect(0, 0, sil.width, sil.height);
      const r = fx.strokeSize || 4; for (let a = 0; a < 16; a++) x.drawImage(sil, l.x + Math.cos((a / 16) * Math.PI * 2) * r, l.y + Math.sin((a / 16) * Math.PI * 2) * r);
    }
    if (fx.shadow) {
      const ang = ((fx.shadowAngle ?? 135) * Math.PI) / 180, dist = fx.shadowDist ?? 12;
      x.shadowColor = hexA(fx.shadowColor || '#000000', fx.shadowOpacity ?? 0.6); x.shadowBlur = fx.shadowBlur ?? 16;
      x.shadowOffsetX = OFF + Math.cos(ang) * dist; x.shadowOffsetY = Math.sin(ang) * dist;
      x.drawImage(src, l.x - OFF, l.y);
    }
    if (fx.glow) { x.shadowColor = hexA(fx.glowColor || '#ffffff', 0.9); x.shadowBlur = fx.glowSize ?? 24; x.shadowOffsetX = OFF; x.shadowOffsetY = 0; x.drawImage(src, l.x - OFF, l.y); x.drawImage(src, l.x - OFF, l.y); }
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetX = 0; x.shadowOffsetY = 0;
    x.drawImage(src, l.x, l.y);
    x.restore();
  }
  function composite(target = comp, { hideFx = false } = {}) {
    if (target.width !== S.w || target.height !== S.h) { target.width = S.w; target.height = S.h; }
    const x = target.getContext('2d'); x.clearRect(0, 0, S.w, S.h);
    for (const l of S.layers) {
      if (!l.visible) continue;
      let src = l.canvas;
      if (l.id === S.active && S.preview) src = S.preview;
      if (l.id === S.active && strokeBuf) {
        src = copyCanvas(l.canvas); const sx = src.getContext('2d');
        sx.globalAlpha = S.o.opacity; sx.globalCompositeOperation = strokeMode === 'eraser' ? 'destination-out' : 'source-over';
        sx.drawImage(strokeBuf, -l.x, -l.y);
      }
      if (S.xf && S.xf.id === l.id) { x.save(); x.globalAlpha = l.opacity; x.globalCompositeOperation = l.blend; const t = S.xf; x.translate(t.cx, t.cy); x.rotate(t.rot); x.scale(t.sx, t.sy); x.drawImage(l.canvas, -l.canvas.width / 2, -l.canvas.height / 2); x.restore(); continue; }
      drawLayer(x, l, src);
    }
    return target;
  }

  // ---------------- View ----------------
  const view = h('canvas.ph-view');
  const stageEl = h('div.ph-stage', view);
  let pending = false, dashOffset = 0;
  function requestRender() {
    if (pending) return; pending = true;
    const f = () => { if (!pending) return; pending = false; draw(); };
    requestAnimationFrame(f); setTimeout(f, 60);
  }
  let checker = null;
  function draw() {
    const dpr = window.devicePixelRatio || 1, W = stageEl.clientWidth, H = stageEl.clientHeight;
    if (!W || !H) return;
    if (view.width !== W * dpr || view.height !== H * dpr) { view.width = W * dpr; view.height = H * dpr; view.style.width = W + 'px'; view.style.height = H + 'px'; }
    composite();
    const x = view.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.fillStyle = '#121318'; x.fillRect(0, 0, W, H);
    if (!checker) { const c = newCanvas(16, 16), cx = c.getContext('2d'); cx.fillStyle = '#2a2c33'; cx.fillRect(0, 0, 16, 16); cx.fillStyle = '#3a3d46'; cx.fillRect(0, 0, 8, 8); cx.fillRect(8, 8, 8, 8); checker = x.createPattern(c, 'repeat'); }
    x.save(); x.translate(S.panX, S.panY);
    x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 30; x.fillStyle = checker; x.fillRect(0, 0, S.w * S.zoom, S.h * S.zoom); x.shadowBlur = 0;
    x.imageSmoothingEnabled = S.zoom < 2; x.scale(S.zoom, S.zoom); x.drawImage(comp, 0, 0);
    x.imageSmoothingEnabled = true;
    const lw = 1 / S.zoom;
    if (selOverlay) x.drawImage(selOverlay, 0, 0);
    if (S.sel?.outline) { x.lineWidth = lw; x.setLineDash([4 * lw, 4 * lw]); x.strokeStyle = '#fff'; x.lineDashOffset = -dashOffset * lw; x.stroke(S.sel.outline); x.strokeStyle = '#000'; x.lineDashOffset = -dashOffset * lw + 4 * lw; x.stroke(S.sel.outline); x.setLineDash([]); }
    // in-progress overlays
    const D = S.drag;
    if (D?.kind === 'marquee' || D?.kind === 'ellipse') { x.lineWidth = lw; x.setLineDash([4 * lw, 4 * lw]); x.strokeStyle = '#fff'; x.beginPath(); const r = normRect(D.a, D.b); if (D.kind === 'marquee') x.rect(r.x, r.y, r.w, r.h); else x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, 7); x.stroke(); x.setLineDash([]); }
    if (D?.kind === 'lasso' && D.pts.length > 1) { x.lineWidth = lw; x.strokeStyle = '#fff'; x.beginPath(); D.pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.stroke(); }
    if (D?.kind === 'gradient' || (D?.kind === 'shape' && S.o.shape === 'line')) { x.lineWidth = 2 * lw; x.strokeStyle = '#fff'; x.beginPath(); x.moveTo(D.a[0], D.a[1]); x.lineTo(D.b[0], D.b[1]); x.stroke(); }
    if (D?.kind === 'shape' && S.o.shape !== 'line') { const r = normRect(D.a, D.b); x.lineWidth = lw; x.strokeStyle = '#fff'; x.setLineDash([4 * lw, 3 * lw]); x.beginPath(); shapePath(x, r); x.stroke(); x.setLineDash([]); }
    if (S.crop) {
      const r = S.crop; x.fillStyle = 'rgba(0,0,0,.55)';
      x.fillRect(0, 0, S.w, r.y); x.fillRect(0, r.y + r.h, S.w, S.h - r.y - r.h); x.fillRect(0, r.y, r.x, r.h); x.fillRect(r.x + r.w, r.y, S.w - r.x - r.w, r.h);
      x.strokeStyle = '#fff'; x.lineWidth = 1.5 * lw; x.strokeRect(r.x, r.y, r.w, r.h);
      x.lineWidth = lw; x.strokeStyle = 'rgba(255,255,255,.4)'; for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(r.x + (r.w * i) / 3, r.y); x.lineTo(r.x + (r.w * i) / 3, r.y + r.h); x.moveTo(r.x, r.y + (r.h * i) / 3); x.lineTo(r.x + r.w, r.y + (r.h * i) / 3); x.stroke(); }
    }
    if (S.xf) {
      const t = S.xf, l = S.layers.find((q) => q.id === t.id), w2 = (l.canvas.width * t.sx) / 2, h2 = (l.canvas.height * t.sy) / 2;
      x.save(); x.translate(t.cx, t.cy); x.rotate(t.rot); x.strokeStyle = '#2dd4f0'; x.lineWidth = 1.5 * lw; x.strokeRect(-w2, -h2, w2 * 2, h2 * 2);
      for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { x.fillStyle = '#fff'; x.fillRect(hx * w2 - 5 * lw, hy * h2 - 5 * lw, 10 * lw, 10 * lw); x.strokeRect(hx * w2 - 5 * lw, hy * h2 - 5 * lw, 10 * lw, 10 * lw); }
      x.beginPath(); x.moveTo(0, -h2); x.lineTo(0, -h2 - 30 * lw); x.stroke(); x.beginPath(); x.arc(0, -h2 - 30 * lw, 6 * lw, 0, 7); x.fillStyle = '#2dd4f0'; x.fill();
      x.restore();
    }
    if (S.cloneSrc && S.tool === 'clone') { x.strokeStyle = '#fff'; x.lineWidth = lw; x.beginPath(); x.arc(S.cloneSrc[0], S.cloneSrc[1], 6 * lw, 0, 7); x.moveTo(S.cloneSrc[0] - 10 * lw, S.cloneSrc[1]); x.lineTo(S.cloneSrc[0] + 10 * lw, S.cloneSrc[1]); x.moveTo(S.cloneSrc[0], S.cloneSrc[1] - 10 * lw); x.lineTo(S.cloneSrc[0], S.cloneSrc[1] + 10 * lw); x.stroke(); }
    if (S.cursor && PAINT.has(S.tool)) { x.lineWidth = lw; x.strokeStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(S.cursor[0], S.cursor[1], S.o.size / 2, 0, 7); x.stroke(); x.strokeStyle = 'rgba(0,0,0,.6)'; x.beginPath(); x.arc(S.cursor[0], S.cursor[1], S.o.size / 2 + lw, 0, 7); x.stroke(); }
    x.restore();
    zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
  }
  setInterval(() => { if (S.sel?.outline) { dashOffset = (dashOffset + 1) % 8; requestRender(); } }, 120);
  const normRect = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });
  function shapePath(x, r) {
    if (S.o.shape === 'ellipse') x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else if (S.o.shape === 'round') x.roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.2);
    else if (S.o.shape === 'star') { const cx = r.x + r.w / 2, cy = r.y + r.h / 2; for (let i = 0; i < 10; i++) { const rr = i % 2 ? 0.42 : 1, a = (i * Math.PI) / 5 - Math.PI / 2; const px = cx + (Math.cos(a) * rr * r.w) / 2, py = cy + (Math.sin(a) * rr * r.h) / 2; i ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); }
    else x.rect(r.x, r.y, r.w, r.h);
  }
  function fit() {
    const W = stageEl.clientWidth, H = stageEl.clientHeight; if (!W) return;
    S.zoom = Math.min((W - 60) / S.w, (H - 60) / S.h, 4); S.panX = (W - S.w * S.zoom) / 2; S.panY = (H - S.h * S.zoom) / 2; requestRender();
  }
  function zoomAt(f, sx, sy) {
    const nz = clamp(S.zoom * f, 0.02, 32); const dx = (sx - S.panX) / S.zoom, dy = (sy - S.panY) / S.zoom;
    S.zoom = nz; S.panX = sx - dx * nz; S.panY = sy - dy * nz; requestRender();
  }
  const toDoc = (e) => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left - S.panX) / S.zoom, (e.clientY - r.top - S.panY) / S.zoom]; };

  // ---------------- Painting ----------------
  let tip = null;
  function makeTip(color) {
    const d = Math.max(1, Math.round(S.o.size)), c = newCanvas(d, d), x = c.getContext('2d'), r = d / 2;
    const g = x.createRadialGradient(r, r, 0, r, r, r), hd = clamp(S.o.hardness, 0, 0.99);
    g.addColorStop(0, hexA(color, S.o.flow)); g.addColorStop(hd, hexA(color, S.o.flow)); g.addColorStop(1, hexA(color, 0));
    x.fillStyle = g; x.fillRect(0, 0, d, d); return c;
  }
  let sourceCv = null;
  function beginPaint(p, e) {
    const l = active(); if (!l) return toast('Add a layer first');
    if (l.locked) return toast('Layer is locked');
    if (l.type === 'text') rasterize(l, false);
    if (S.tool === 'clone' && e.altKey) { S.cloneSrc = p; toast('Clone source set'); requestRender(); return; }
    if (S.tool === 'clone' && !S.cloneSrc) return toast('Alt+click to set a clone source first');
    strokeBuf = newCanvas(S.w, S.h); strokeMode = S.tool === 'eraser' ? 'eraser' : 'paint';
    tip = makeTip(S.tool === 'eraser' ? '#000000' : S.fg);
    sourceCv = null;
    if (['clone', 'blurb', 'dodge', 'burn'].includes(S.tool)) {
      sourceCv = newCanvas(S.w, S.h); const sx = sourceCv.getContext('2d'); sx.drawImage(l.canvas, l.x, l.y);
      if (S.tool === 'blurb') { const t = copyCanvas(sourceCv); sx.clearRect(0, 0, S.w, S.h); sx.filter = `blur(${2 + S.o.strength * 10}px)`; sx.drawImage(t, 0, 0); }
      if (S.tool === 'dodge' || S.tool === 'burn') applyOp(sourceCv, ADJUSTMENTS.exposure, { exposure: (S.tool === 'dodge' ? 1 : -1) * S.o.strength * 1.5, offset: 0, gamma: 1 });
    }
    S.paint = { last: p, cloneOff: S.cloneSrc ? [S.cloneSrc[0] - p[0], S.cloneSrc[1] - p[1]] : [0, 0] };
    stamp(p);
  }
  let mask = null;
  function stamp(p) {
    const x = strokeBuf.getContext('2d'), d = tip.width, r = d / 2;
    if (!sourceCv) { x.drawImage(tip, p[0] - r, p[1] - r); return; }
    if (!mask || mask.width !== d) mask = newCanvas(d, d);
    const mx = mask.getContext('2d'); mx.globalCompositeOperation = 'source-over'; mx.clearRect(0, 0, d, d);
    const off = S.tool === 'clone' ? S.paint.cloneOff : [0, 0];
    mx.drawImage(sourceCv, p[0] + off[0] - r, p[1] + off[1] - r, d, d, 0, 0, d, d);
    mx.globalCompositeOperation = 'destination-in'; mx.drawImage(tip, 0, 0);
    x.drawImage(mask, p[0] - r, p[1] - r);
  }
  function movePaint(p) {
    const a = S.paint.last, dist = Math.hypot(p[0] - a[0], p[1] - a[1]), step = Math.max(1, S.o.size * 0.12);
    for (let t = step; t <= dist; t += step) stamp([a[0] + ((p[0] - a[0]) * t) / dist, a[1] + ((p[1] - a[1]) * t) / dist]);
    if (dist >= step) S.paint.last = p;
    requestRender();
  }
  function endPaint() {
    const l = active(); if (!strokeBuf || !l) { strokeBuf = null; return; }
    if (S.sel) { const x = strokeBuf.getContext('2d'); x.globalCompositeOperation = 'destination-in'; x.drawImage(S.sel.mask, 0, 0); }
    push({ brush: 'Brush', eraser: 'Eraser', clone: 'Clone stamp', blurb: 'Blur brush', dodge: 'Dodge', burn: 'Burn' }[S.tool]);
    const x = l.canvas.getContext('2d'); x.save(); x.globalAlpha = S.o.opacity; x.globalCompositeOperation = strokeMode === 'eraser' ? 'destination-out' : 'source-over';
    x.drawImage(strokeBuf, -l.x, -l.y); x.restore();
    strokeBuf = null; S.paint = null; changed(true);
  }

  // ---------------- Tools: fill, wand, gradient, shapes, text ----------------
  function bucketFill(p) {
    const l = active(); if (!l) return;
    modifyLayer('Paint bucket', (c) => {
      const x = ctx2(c), img = x.getImageData(0, 0, c.width, c.height);
      const m = floodMask(img, Math.floor(p[0] - l.x), Math.floor(p[1] - l.y), S.o.tolerance, S.o.contiguous);
      const n = parseInt(S.fg.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, a = S.o.opacity;
      const d = img.data;
      for (let i = 0; i < m.length; i++) if (m[i]) { const o = i * 4; d[o] = d[o] * (1 - a) + r * a; d[o + 1] = d[o + 1] * (1 - a) + g * a; d[o + 2] = d[o + 2] * (1 - a) + b * a; d[o + 3] = Math.max(d[o + 3], 255 * a); }
      x.putImageData(img, 0, 0);
    });
  }
  function wand(p) {
    let src; const l = active();
    if (S.o.sampleAll) src = composite(newCanvas(S.w, S.h));
    else { src = newCanvas(S.w, S.h); if (l) src.getContext('2d').drawImage(l.canvas, l.x, l.y); }
    const img = ctx2(src).getImageData(0, 0, S.w, S.h), m = floodMask(img, Math.floor(p[0]), Math.floor(p[1]), S.o.tolerance, S.o.contiguous);
    const c = newCanvas(S.w, S.h), x = c.getContext('2d'), out = x.createImageData(S.w, S.h);
    for (let i = 0; i < m.length; i++) if (m[i]) { out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = out.data[i * 4 + 3] = 255; }
    x.putImageData(out, 0, 0); setSelection(c, null);
  }
  function gradientFill(a, b) {
    modifyLayer('Gradient', (c) => {
      const l = active(), x = c.getContext('2d');
      const ax = a[0] - l.x, ay = a[1] - l.y, bx = b[0] - l.x, by = b[1] - l.y;
      const g = S.o.gradType === 'radial' ? x.createRadialGradient(ax, ay, 0, ax, ay, Math.hypot(bx - ax, by - ay)) : x.createLinearGradient(ax, ay, bx, by);
      g.addColorStop(0, S.fg); g.addColorStop(1, S.o.gradTransparent ? hexA(S.fg, 0) : S.bg);
      x.save(); x.globalAlpha = S.o.opacity; x.fillStyle = g; x.fillRect(0, 0, c.width, c.height); x.restore();
    });
  }
  function drawShape(a, b, shift) {
    let r = normRect(a, b); if (shift && S.o.shape !== 'line') { const s = Math.max(r.w, r.h); r = { x: a[0] < b[0] ? a[0] : a[0] - s, y: a[1] < b[1] ? a[1] : a[1] - s, w: s, h: s }; }
    if (r.w < 2 && r.h < 2 && S.o.shape !== 'line') return;
    push('Shape');
    const l = addLayer(makeLayer(`Shape ${S.layers.length}`)), x = l.canvas.getContext('2d');
    x.lineWidth = S.o.strokeW; x.lineCap = 'round'; x.lineJoin = 'round'; x.fillStyle = S.fg; x.strokeStyle = S.o.shapeFill ? S.bg : S.fg;
    x.beginPath();
    if (S.o.shape === 'line') { x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.strokeStyle = S.fg; x.stroke(); }
    else { shapePath(x, r); if (S.o.shapeFill) x.fill(); if (!S.o.shapeFill || S.o.strokeW > 0 && !S.o.shapeFill) x.stroke(); }
    trimLayer(l); changed(true);
  }
  function trimLayer(l) { const b = alphaBounds(l.canvas); if (!b) return; const c = newCanvas(b.w, b.h); c.getContext('2d').drawImage(l.canvas, -b.x, -b.y); l.canvas = c; l.x += b.x; l.y += b.y; }
  function addText(p) {
    push('Text');
    const l = addLayer(makeLayer('Text', 1, 1, { type: 'text', x: Math.round(p[0]), y: Math.round(p[1] - S.o.fontSize * 0.6), text: { content: 'Your text', font: S.o.font, size: S.o.fontSize, color: S.fg, bold: true, italic: false, align: 'left', lineHeight: 1.2, letterSpacing: 0, strokeWidth: 0, strokeColor: '#000000' } }));
    renderText(l); changed(true); setRightTab('props');
    setTimeout(() => { const ta = right.querySelector('textarea.ph-text'); ta?.focus(); ta?.select(); }, 50);
  }
  function pickLayerAt(p) {
    for (let i = S.layers.length - 1; i >= 0; i--) {
      const l = S.layers[i]; if (!l.visible) continue;
      const lx = Math.floor(p[0] - l.x), ly = Math.floor(p[1] - l.y);
      if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
      if (ctx2(l.canvas).getImageData(lx, ly, 1, 1).data[3] > 10) return l;
    }
    return null;
  }

  // ---------------- Free transform & crop ----------------
  function startTransform() {
    const l = active(); if (!l) return; if (l.locked) return toast('Layer is locked');
    S.xf = { id: l.id, cx: l.x + l.canvas.width / 2, cy: l.y + l.canvas.height / 2, sx: 1, sy: 1, rot: 0 };
    setTool('move'); toast('Drag corners to resize, top handle to rotate. Enter = apply, Esc = cancel'); requestRender();
  }
  function applyTransform() {
    const t = S.xf; if (!t) return; const l = S.layers.find((q) => q.id === t.id);
    push('Free transform');
    const w = l.canvas.width * Math.abs(t.sx), hh = l.canvas.height * Math.abs(t.sy), cos = Math.abs(Math.cos(t.rot)), sin = Math.abs(Math.sin(t.rot));
    const bw = w * cos + hh * sin, bh = w * sin + hh * cos, c = newCanvas(bw, bh), x = c.getContext('2d');
    x.translate(bw / 2, bh / 2); x.rotate(t.rot); x.scale(t.sx, t.sy); x.drawImage(l.canvas, -l.canvas.width / 2, -l.canvas.height / 2);
    if (l.type === 'text') { l.type = 'raster'; delete l.text; }
    l.canvas = c; l.x = Math.round(t.cx - bw / 2); l.y = Math.round(t.cy - bh / 2);
    S.xf = null; changed(true);
  }
  function xfHit(p) {
    const t = S.xf, l = S.layers.find((q) => q.id === t.id), w2 = (l.canvas.width * t.sx) / 2, h2 = (l.canvas.height * t.sy) / 2;
    const dx = p[0] - t.cx, dy = p[1] - t.cy, lx = dx * Math.cos(-t.rot) - dy * Math.sin(-t.rot), ly = dx * Math.sin(-t.rot) + dy * Math.cos(-t.rot);
    const tol = 10 / S.zoom;
    if (Math.hypot(lx, ly + h2 + 30 / S.zoom) < tol * 1.5) return 'rot';
    for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) if (Math.abs(lx - hx * w2) < tol && Math.abs(ly - hy * h2) < tol) return 'scale';
    if (Math.abs(lx) <= Math.abs(w2) && Math.abs(ly) <= Math.abs(h2)) return 'move';
    return null;
  }
  function applyCrop() {
    const r = S.crop; if (!r || r.w < 2 || r.h < 2) { S.crop = null; return; }
    push('Crop');
    S.w = Math.round(r.w); S.h = Math.round(r.h);
    for (const l of S.layers) { l.x -= Math.round(r.x); l.y -= Math.round(r.y); }
    S.crop = null; deselect(); changed(true); fit();
  }

  // ---------------- Pointer ----------------
  let spaceDown = false;
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    const p = toDoc(e);
    if (e.button === 1 || spaceDown || S.tool === 'hand') { S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY }; return; }
    if (e.button !== 0) return;
    const r = view.getBoundingClientRect();
    if (S.tool === 'zoom') { zoomAt(e.altKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top); return; }
    if (S.xf) {
      const hit = xfHit(p);
      if (!hit) { applyTransform(); return; }
      S.drag = { kind: 'xf-' + hit, a: p, t0: { ...S.xf } }; return;
    }
    S.o.selMode = e.shiftKey ? 'add' : e.altKey ? 'sub' : S.o.selModeBase || 'new';
    switch (S.tool) {
      case 'move': {
        if (S.o.autoSelect && !e.ctrlKey) { const hit = pickLayerAt(p); if (hit) { S.active = hit.id; renderPanels(); } }
        const l = active(); if (!l || l.locked) return;
        S.drag = { kind: 'move', a: p, x0: l.x, y0: l.y, moved: false }; return;
      }
      case 'marquee': case 'ellipse': S.drag = { kind: S.tool, a: p, b: p }; return;
      case 'lasso': S.drag = { kind: 'lasso', pts: [p] }; return;
      case 'wand': wand(p); return;
      case 'crop': {
        if (S.crop && p[0] > S.crop.x && p[0] < S.crop.x + S.crop.w && p[1] > S.crop.y && p[1] < S.crop.y + S.crop.h) { S.drag = { kind: 'cropmove', a: p, r0: { ...S.crop } }; return; }
        S.drag = { kind: 'crop', a: p }; S.crop = { x: p[0], y: p[1], w: 0, h: 0 }; return;
      }
      case 'fill': bucketFill(p); return;
      case 'gradient': S.drag = { kind: 'gradient', a: p, b: p }; return;
      case 'shape': S.drag = { kind: 'shape', a: p, b: p }; return;
      case 'text': { const hit = pickLayerAt(p); if (hit?.type === 'text') { S.active = hit.id; renderPanels(); setRightTab('props'); } else addText(p); return; }
      case 'eyedropper': { const c = composite(newCanvas(S.w, S.h)), d = ctx2(c).getImageData(clamp(Math.floor(p[0]), 0, S.w - 1), clamp(Math.floor(p[1]), 0, S.h - 1), 1, 1).data; const hex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''); if (e.altKey) S.bg = hex; else S.fg = hex; renderColors(); return; }
      default: if (PAINT.has(S.tool)) { beginPaint(p, e); if (strokeBuf) S.drag = { kind: 'paint' }; }
    }
  });
  view.addEventListener('pointermove', (e) => {
    const p = toDoc(e); S.cursor = p;
    const D = S.drag;
    if (!D) { if (PAINT.has(S.tool)) requestRender(); return; }
    if (D.kind === 'pan') { S.panX = D.px + e.clientX - D.sx; S.panY = D.py + e.clientY - D.sy; requestRender(); return; }
    if (D.kind === 'paint') return movePaint(p);
    if (D.kind === 'move') { const l = active(); l.x = Math.round(D.x0 + p[0] - D.a[0]); l.y = Math.round(D.y0 + p[1] - D.a[1]); D.moved = true; requestRender(); return; }
    if (D.kind === 'marquee' || D.kind === 'ellipse' || D.kind === 'gradient' || D.kind === 'shape') { D.b = p; requestRender(); return; }
    if (D.kind === 'lasso') { D.pts.push(p); requestRender(); return; }
    if (D.kind === 'crop') {
      let w = p[0] - D.a[0], hh = p[1] - D.a[1];
      if (S.o.cropRatio) hh = Math.sign(hh || 1) * Math.abs(w) / S.o.cropRatio;
      S.crop = normRect(D.a, [D.a[0] + w, D.a[1] + hh]);
      S.crop.x = clamp(S.crop.x, 0, S.w); S.crop.y = clamp(S.crop.y, 0, S.h); S.crop.w = Math.min(S.crop.w, S.w - S.crop.x); S.crop.h = Math.min(S.crop.h, S.h - S.crop.y);
      requestRender(); return;
    }
    if (D.kind === 'cropmove') { S.crop.x = clamp(D.r0.x + p[0] - D.a[0], 0, S.w - S.crop.w); S.crop.y = clamp(D.r0.y + p[1] - D.a[1], 0, S.h - S.crop.h); requestRender(); return; }
    if (D.kind.startsWith('xf-')) {
      const t = S.xf, t0 = D.t0;
      if (D.kind === 'xf-move') { t.cx = t0.cx + p[0] - D.a[0]; t.cy = t0.cy + p[1] - D.a[1]; }
      else if (D.kind === 'xf-rot') { let a = Math.atan2(p[1] - t.cy, p[0] - t.cx) + Math.PI / 2; if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); t.rot = a; }
      else {
        const d0 = Math.hypot(D.a[0] - t0.cx, D.a[1] - t0.cy) || 1, d1 = Math.hypot(p[0] - t0.cx, p[1] - t0.cy), f = d1 / d0;
        if (e.shiftKey) { const dx = Math.abs(p[0] - t0.cx) / Math.max(1, Math.abs(D.a[0] - t0.cx)), dy = Math.abs(p[1] - t0.cy) / Math.max(1, Math.abs(D.a[1] - t0.cy)); t.sx = t0.sx * dx; t.sy = t0.sy * dy; }
        else { t.sx = t0.sx * f; t.sy = t0.sy * f; }
      }
      requestRender();
    }
  });
  view.addEventListener('pointerup', (e) => {
    const D = S.drag; S.drag = null; if (!D) return;
    const p = toDoc(e);
    if (D.kind === 'paint') endPaint();
    else if (D.kind === 'move' && D.moved) { const l = active(); const nx = l.x, ny = l.y; l.x = D.x0; l.y = D.y0; push('Move'); l.x = nx; l.y = ny; changed(true); }
    else if (D.kind === 'marquee' || D.kind === 'ellipse') {
      const r = normRect(D.a, p);
      if (r.w < 2 && r.h < 2) { if (S.o.selMode === 'new') deselect(); }
      else {
        const path = new Path2D(); if (D.kind === 'marquee') path.rect(r.x, r.y, r.w, r.h); else path.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        setSelection(shapeMask((x) => (D.kind === 'marquee' ? x.rect(r.x, r.y, r.w, r.h) : x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2))), path);
      }
    } else if (D.kind === 'lasso' && D.pts.length > 2) {
      const path = new Path2D(); D.pts.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); path.closePath();
      setSelection(shapeMask((x) => D.pts.forEach((q, i) => (i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])))), path);
    } else if (D.kind === 'gradient' && Math.hypot(p[0] - D.a[0], p[1] - D.a[1]) > 2) gradientFill(D.a, p);
    else if (D.kind === 'shape') drawShape(D.a, p, e.shiftKey);
    requestRender();
  });
  view.addEventListener('pointerleave', () => { S.cursor = null; requestRender(); });
  view.addEventListener('wheel', (e) => {
    e.preventDefault(); const r = view.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || e.altKey) zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    else { S.panX -= e.deltaX; S.panY -= e.deltaY; requestRender(); }
  }, { passive: false });
  view.addEventListener('dblclick', () => { if (S.tool === 'hand') fit(); });

  // ---------------- Layer operations ----------------
  const L = {
    newLayer() { push('New layer'); addLayer(makeLayer(`Layer ${S.layers.length + 1}`)); changed(true); },
    duplicate() { const l = active(); if (!l) return; push('Duplicate layer'); const d = { ...l, ...meta(l), id: uid('l_'), name: l.name + ' copy', canvas: copyCanvas(l.canvas), fx: { ...l.fx } }; addLayer(d, l); changed(true); },
    remove() { const l = active(); if (!l) return; if (S.layers.length === 1) return toast('An image needs at least one layer'); push('Delete layer'); const i = S.layers.indexOf(l); S.layers.splice(i, 1); S.active = S.layers[Math.max(0, i - 1)].id; changed(true); },
    mergeDown() {
      const l = active(), i = S.layers.indexOf(l); if (i <= 0) return toast('No layer below to merge into');
      push('Merge down'); const below = S.layers[i - 1];
      const c = newCanvas(S.w, S.h), x = c.getContext('2d'); drawLayer(x, { ...below, opacity: 1, blend: 'source-over' }); x.globalAlpha = 1; drawLayer(x, l);
      const nb = { ...below, type: 'raster', text: undefined, canvas: c, x: 0, y: 0, fx: {} }; delete nb.text;
      S.layers.splice(i - 1, 2, nb); S.active = nb.id; changed(true);
    },
    flatten() { push('Flatten'); const c = composite(newCanvas(S.w, S.h)); const l = makeLayer('Background'); l.canvas = c; S.layers = [l]; S.active = l.id; changed(true); },
    move(dir) { const l = active(), i = S.layers.indexOf(l), j = dir === 'top' ? S.layers.length - 1 : dir === 'bottom' ? 0 : i + dir; if (j < 0 || j >= S.layers.length || j === i) return; push('Arrange'); S.layers.splice(i, 1); S.layers.splice(j, 0, l); changed(true); },
    fromSelection(cut = false) {
      const l = active(); if (!l || !S.sel) return toast('Make a selection first');
      push(cut ? 'Cut to new layer' : 'Copy to new layer');
      const c = newCanvas(S.w, S.h), x = c.getContext('2d'); x.drawImage(l.canvas, l.x, l.y); x.globalCompositeOperation = 'destination-in'; x.drawImage(S.sel.mask, 0, 0);
      if (cut) { const lx = l.canvas.getContext('2d'); lx.save(); lx.globalCompositeOperation = 'destination-out'; lx.drawImage(S.sel.mask, -l.x, -l.y); lx.restore(); }
      const n = addLayer(makeLayer(cut ? 'Cut layer' : 'Copied layer')); n.canvas = c; trimLayer(n); deselect(); changed(true);
    },
  };
  let clipboard = null;
  const E = {
    copy() { const l = active(); if (!l) return; const c = newCanvas(S.w, S.h), x = c.getContext('2d'); x.drawImage(l.canvas, l.x, l.y); if (S.sel) { x.globalCompositeOperation = 'destination-in'; x.drawImage(S.sel.mask, 0, 0); } const b = alphaBounds(c); if (!b) return; clipboard = newCanvas(b.w, b.h); clipboard.getContext('2d').drawImage(c, -b.x, -b.y); clipboard.px = b.x; clipboard.py = b.y; toast('Copied'); },
    cut() { E.copy(); E.clear(); },
    paste() { if (!clipboard) return; push('Paste'); const l = addLayer(makeLayer('Pasted')); l.canvas = copyCanvas(clipboard); l.x = clipboard.px; l.y = clipboard.py; changed(true); },
    clear() { const l = active(); if (!l) return; if (!S.sel) return toast('Select an area to delete'); modifyLayer('Delete', (c) => { const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height); }); },
    fill() { modifyLayer('Fill', (c) => { const x = c.getContext('2d'); x.fillStyle = S.fg; x.fillRect(0, 0, c.width, c.height); }); },
  };

  // ---------------- Image ops ----------------
  const I = {
    rotate(deg) {
      push(`Rotate ${deg}°`); const rad = (deg * Math.PI) / 180, nw = Math.abs(deg) === 90 ? S.h : S.w, nh = Math.abs(deg) === 90 ? S.w : S.h;
      for (const l of S.layers) {
        const full = newCanvas(S.w, S.h); full.getContext('2d').drawImage(l.canvas, l.x, l.y);
        const c = newCanvas(nw, nh), x = c.getContext('2d'); x.translate(nw / 2, nh / 2); x.rotate(rad); x.drawImage(full, -S.w / 2, -S.h / 2);
        l.canvas = c; l.x = 0; l.y = 0; if (l.type === 'text') { l.type = 'raster'; delete l.text; }
      }
      S.w = nw; S.h = nh; deselect(); changed(true); fit();
    },
    flip(horizontal, layerOnly = false) {
      push(horizontal ? 'Flip horizontal' : 'Flip vertical');
      for (const l of layerOnly ? [active()] : S.layers) {
        const c = newCanvas(l.canvas.width, l.canvas.height), x = c.getContext('2d');
        x.translate(horizontal ? c.width : 0, horizontal ? 0 : c.height); x.scale(horizontal ? -1 : 1, horizontal ? 1 : -1); x.drawImage(l.canvas, 0, 0);
        l.canvas = c; if (!layerOnly) { if (horizontal) l.x = S.w - l.x - c.width; else l.y = S.h - l.y - c.height; }
        if (l.type === 'text') { l.type = 'raster'; delete l.text; }
      }
      changed(true);
    },
    imageSize() {
      const wI = h('input.input', { type: 'number', value: S.w }), hI = h('input.input', { type: 'number', value: S.h }), lock = h('input', { type: 'checkbox', checked: true });
      wI.oninput = () => { if (lock.checked) hI.value = Math.round((+wI.value * S.h) / S.w); };
      hI.oninput = () => { if (lock.checked) wI.value = Math.round((+hI.value * S.w) / S.h); };
      modal({ title: 'Image size (resample)', width: 380, body: h('div', h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, h('div.field', h('label', 'Width'), wI), h('div.field', h('label', 'Height'), hI)), h('label.check', lock, ' Keep proportions')),
        actions: [{ label: 'Cancel' }, { label: 'Resize', primary: true, onClick: () => {
          const nw = clamp(+wI.value | 0, 1, 12000), nh = clamp(+hI.value | 0, 1, 12000), fx = nw / S.w, fy = nh / S.h; push('Image size');
          for (const l of S.layers) { const c = newCanvas(l.canvas.width * fx, l.canvas.height * fy), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(l.canvas, 0, 0, c.width, c.height); l.canvas = c; l.x = Math.round(l.x * fx); l.y = Math.round(l.y * fy); if (l.text) { l.text.size *= fy; renderText(l); } }
          S.w = nw; S.h = nh; deselect(); changed(true); fit();
        } }] });
    },
    canvasSize() {
      const wI = h('input.input', { type: 'number', value: S.w }), hI = h('input.input', { type: 'number', value: S.h });
      const anchor = h('select.select', ['center', 'top-left', 'top', 'left'].map((a) => h('option', { value: a }, a)));
      modal({ title: 'Canvas size', width: 380, body: h('div', h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, h('div.field', h('label', 'Width'), wI), h('div.field', h('label', 'Height'), hI)), h('div.field', h('label', 'Anchor'), anchor)),
        actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => {
          const nw = clamp(+wI.value | 0, 1, 12000), nh = clamp(+hI.value | 0, 1, 12000); push('Canvas size');
          const dx = anchor.value === 'center' || anchor.value === 'top' ? (nw - S.w) / 2 : 0, dy = anchor.value === 'center' || anchor.value === 'left' ? (nh - S.h) / 2 : 0;
          for (const l of S.layers) { l.x += Math.round(dx); l.y += Math.round(dy); }
          S.w = nw; S.h = nh; deselect(); changed(true); fit();
        } }] });
    },
    cropToSelection() { if (!S.sel) return toast('Make a selection first'); const b = alphaBounds(S.sel.mask); if (!b) return; S.crop = b; applyCrop(); },
    trim() { const b = alphaBounds(composite(newCanvas(S.w, S.h))); if (!b) return; S.crop = b; applyCrop(); },
  };

  // ---------------- Adjustment / filter dialog with live preview ----------------
  function opDialog(op, title) {
    const l = active(); if (!l) return toast('Select a layer');
    if (l.locked) return toast('Layer is locked');
    if (l.type === 'text') rasterize(l);
    const params = {}; for (const [k, , , , def] of op.params) params[k] = def;
    let timer = 0;
    const run = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const work = copyCanvas(l.canvas); applyOp(work, op, params);
        if (S.sel) { clipToSel(work, l); const base = copyCanvas(l.canvas), bx = base.getContext('2d'); bx.globalCompositeOperation = 'destination-out'; bx.drawImage(S.sel.mask, -l.x, -l.y); bx.globalCompositeOperation = 'source-over'; bx.drawImage(work, 0, 0); S.preview = base; }
        else S.preview = work;
        requestRender();
      }, 40);
    };
    const prev = h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) run(); else { S.preview = null; requestRender(); } } });
    const body = h('div', op.params.map(([k, label, min, max, def, step]) => sliderRow(label, def, { min, max, step: step || 1, def, onInput: (v) => { params[k] = v; if (prev.checked) run(); } })),
      h('label.check', prev, ' Preview'), op.params.length ? null : h('p.small.muted', 'No settings - click Apply.'));
    run();
    modal({ title: title || op.name, width: 420, body, onClose: () => { S.preview = null; requestRender(); },
      actions: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: () => { S.preview = null; modifyLayer(op.name, (c) => applyOp(c, op, params), l); } }] });
  }

  // ---------------- AI ----------------
  async function aiRemoveBg(asSelection = false) {
    const l = active(); if (!l) return;
    toast(bgState.ready ? 'Finding the subject…' : 'Loading the AI model (first time only)…');
    await loadSegmenter(); if (!bgState.ready) return toast('AI model failed to load: ' + (bgState.error || ''), 'error');
    const full = newCanvas(S.w, S.h); full.getContext('2d').drawImage(asSelection ? composite(newCanvas(S.w, S.h)) : l.canvas, asSelection ? 0 : l.x, asSelection ? 0 : l.y);
    const m = personMask(full, uid());
    if (!m) return toast('Could not find a subject', 'error');
    const mk = newCanvas(S.w, S.h), mx = mk.getContext('2d'); mx.filter = 'blur(1.5px)'; mx.drawImage(m, 0, 0, S.w, S.h);
    if (asSelection) { S.o.selMode = 'new'; setSelection(mk, null); toast('Subject selected', 'ok'); return; }
    modifyLayer('Remove background', (c) => { const x = c.getContext('2d'); x.globalCompositeOperation = 'destination-in'; x.drawImage(mk, -l.x, -l.y); x.globalCompositeOperation = 'source-over'; });
    toast('Background removed', 'ok');
  }
  function autoEnhance() {
    const l = active(); if (!l) return;
    modifyLayer('Auto enhance', (c) => { applyOp(c, ADJUSTMENTS.autoTone, {}); applyOp(c, ADJUSTMENTS.vibrance, { vibrance: 25, saturation: 0 }); applyOp(c, FILTERS.sharpen, { amount: 0.25 }); });
    toast('Auto enhanced', 'ok');
  }
  async function aiEdit(prompt, log) {
    const small = newCanvas(Math.min(768, S.w), Math.min(768, S.w) * (S.h / S.w)); small.getContext('2d').drawImage(composite(newCanvas(S.w, S.h)), 0, 0, small.width, small.height);
    const sys = `You are the AI of a photo editor. Look at the image and the user's request. Reply ONLY with JSON:
{"message":"short reply","steps":[ ... ]}
Steps (applied in order to the selected layer):
{"op":"adjust","name":"<${Object.keys(ADJUSTMENTS).join('|')}>","params":{...}}  params per adjustment: ${Object.entries(ADJUSTMENTS).map(([k, a]) => `${k}(${a.params.map((p) => `${p[0]} ${p[2]}..${p[3]}`).join(', ')})`).join('; ')}
{"op":"filter","name":"<${Object.keys(FILTERS).join('|')}>","params":{...}}  ${Object.entries(FILTERS).map(([k, a]) => `${k}(${a.params.map((p) => `${p[0]} ${p[2]}..${p[3]}`).join(', ')})`).join('; ')}
{"op":"removeBackground"}  {"op":"autoEnhance"}
{"op":"text","content":"...","position":"top|center|bottom","color":"#fff","size":120,"font":"${FONTS.slice(0, 8).join('|')}","shadow":true}
{"op":"crop","ratio":"1:1|4:5|16:9|9:16"}
Use subtle, professional values unless asked otherwise.`;
    const txt = await nvChat([{ role: 'system', content: sys }, { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: small.toDataURL('image/jpeg', 0.8) } }] }], { vision: true, maxTokens: 1500 });
    const j = parseJSON(txt) || { message: txt, steps: [] };
    const before = S.undo.length;
    for (const st of j.steps || []) {
      try {
        if (st.op === 'adjust' && ADJUSTMENTS[st.name]) { const op = ADJUSTMENTS[st.name], p = {}; for (const [k, , mn, mx, def] of op.params) p[k] = clamp(+(st.params?.[k] ?? def), mn, mx); modifyLayer(op.name, (c) => applyOp(c, op, p)); }
        else if (st.op === 'filter' && FILTERS[st.name]) { const op = FILTERS[st.name], p = {}; for (const [k, , mn, mx, def] of op.params) p[k] = clamp(+(st.params?.[k] ?? def), mn, mx); modifyLayer(op.name, (c) => applyOp(c, op, p)); }
        else if (st.op === 'removeBackground') await aiRemoveBg();
        else if (st.op === 'autoEnhance') autoEnhance();
        else if (st.op === 'text') {
          push('AI text');
          const size = clamp(+st.size || Math.round(S.h / 9), 10, 1000);
          const l = addLayer(makeLayer('Text', 1, 1, { type: 'text', text: { content: String(st.content || 'Text'), font: FONTS.includes(st.font) ? st.font : 'Montserrat', size, color: st.color || '#ffffff', bold: true, italic: false, align: 'center', lineHeight: 1.15, letterSpacing: 0, strokeWidth: 0, strokeColor: '#000' }, fx: st.shadow !== false ? { shadow: true, shadowBlur: 20, shadowDist: 6, shadowOpacity: 0.6 } : {} }));
          renderText(l); l.x = Math.round((S.w - l.canvas.width) / 2); l.y = Math.round(st.position === 'top' ? S.h * 0.06 : st.position === 'bottom' ? S.h * 0.94 - l.canvas.height : (S.h - l.canvas.height) / 2);
        } else if (st.op === 'crop') { const [a, b] = String(st.ratio).split(':').map(Number); if (a && b) { const r = a / b; let w = S.w, hh = w / r; if (hh > S.h) { hh = S.h; w = hh * r; } S.crop = { x: (S.w - w) / 2, y: (S.h - hh) / 2, w, h: hh }; applyCrop(); } }
      } catch (e) { log?.(`✗ ${st.op}: ${e.message}`); }
    }
    if (S.undo.length > before + 1) { const first = S.undo[before]; S.undo.splice(before); S.undo.push({ ...first, label: 'AI edit' }); }
    changed(true);
    return j.message || 'Done.';
  }

  // ---------------- Persistence ----------------
  async function save() {
    if (!S.dirty) return; S.dirty = false;
    const t = newCanvas(320, (320 * S.h) / S.w); t.getContext('2d').drawImage(composite(newCanvas(S.w, S.h)), 0, 0, t.width, t.height);
    const layers = [];
    for (const l of S.layers) layers.push({ ...meta(l), blob: await new Promise((r) => l.canvas.toBlob(r, 'image/png')) });
    await db.put('photos', { id: S.id, name: S.name, w: S.w, h: S.h, active: S.active, updated: Date.now(), thumb: t.toDataURL('image/jpeg', 0.7), layers });
    savedEl.textContent = 'Saved';
  }
  const saveSoon = debounce(() => save().catch((e) => toast('Save failed: ' + e.message, 'error')), 1500);
  async function load(rec) {
    S.id = rec.id; S.name = rec.name; S.w = rec.w; S.h = rec.h; S.layers = [];
    for (const m of rec.layers) {
      const img = await createImageBitmap(m.blob); const c = newCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
      const l = { ...m, canvas: c }; delete l.blob; S.layers.push(l);
    }
    S.active = rec.active && S.layers.some((l) => l.id === rec.active) ? rec.active : S.layers[S.layers.length - 1]?.id;
  }
  async function imageToCanvas(f) { const img = await createImageBitmap(f); const c = newCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0); return c; }
  async function placeFiles(files, asNew = false) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { toast(`${f.name} is not an image`, 'error'); continue; }
      const c = await imageToCanvas(f);
      if (asNew || !S.layers.length) { S.w = c.width; S.h = c.height; S.layers = []; S.name = f.name.replace(/\.[^.]+$/, ''); const l = makeLayer('Background'); l.canvas = c; S.layers.push(l); S.active = l.id; S.undo = []; S.redo = []; changed(true); fit(); asNew = false; continue; }
      push('Place image'); const l = addLayer(makeLayer(f.name.replace(/\.[^.]+$/, '')));
      const s = Math.min(1, (S.w * 0.9) / c.width, (S.h * 0.9) / c.height);
      if (s < 1) { const r = newCanvas(c.width * s, c.height * s); r.getContext('2d').drawImage(c, 0, 0, r.width, r.height); l.canvas = r; } else l.canvas = c;
      l.x = Math.round((S.w - l.canvas.width) / 2); l.y = Math.round((S.h - l.canvas.height) / 2); changed(true);
    }
  }

  // ---------------- Export ----------------
  function exportDialog() {
    const fmt = h('select.select', [['png', 'PNG (transparent)'], ['jpeg', 'JPG'], ['webp', 'WebP']].map(([v, l]) => h('option', { value: v }, l)));
    const q = h('input.input', { type: 'number', value: 92, min: 10, max: 100 }), sc = h('input.input', { type: 'number', value: 100, min: 5, max: 400 });
    const name = h('input.input', { value: S.name });
    modal({ title: 'Export image', width: 440, body: h('div', h('div.field', h('label', 'File name'), name),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: '10px' } }, h('div.field', h('label', 'Format'), fmt), h('div.field', h('label', 'Quality %'), q), h('div.field', h('label', 'Scale %'), sc)),
      h('p.small.muted', `${S.w}×${S.h} px`)),
    actions: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: async () => {
      const s = clamp(+sc.value || 100, 5, 400) / 100, src = composite(newCanvas(S.w, S.h)), c = newCanvas(S.w * s, S.h * s), x = c.getContext('2d');
      if (fmt.value === 'jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
      x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/' + fmt.value, clamp(+q.value, 10, 100) / 100));
      h('a', { href: URL.createObjectURL(blob), download: `${name.value || 'image'}.${fmt.value === 'jpeg' ? 'jpg' : fmt.value}` }).click();
      toast('Image exported', 'ok');
    } }] });
  }
  async function sendToVideo() {
    const blob = await new Promise((r) => composite(newCanvas(S.w, S.h)).toBlob(r, 'image/png'));
    await save(); onSendToVideo?.(new File([blob], `${S.name}.png`, { type: 'image/png' }));
  }

  // ---------------- UI ----------------
  const savedEl = h('span.saved');
  const zoomLabel = h('button.btn.ghost.sm', { title: 'Fit to screen', onclick: () => fit() }, '100%');
  const nameInput = h('input.name', { value: S.name, onchange: () => { S.name = nameInput.value || 'Untitled image'; changed(); } });
  const menu = (label, items) => h('button.menu-btn', { onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showContextMenu(r.left, r.bottom + 4, items()); } }, label);
  const adjItems = () => Object.entries(ADJUSTMENTS).map(([, op]) => ({ label: op.name, icon: 'filter', fn: () => opDialog(op) }));
  const top = h('header.topbar.ph-top',
    iconBtn('home', 'Back to home', async () => { await save(); cleanup(); onExit?.(); }),
    h('div.brand', { style: { fontSize: '14px' } }, h('div.logo', { style: { width: '24px', height: '24px', borderRadius: '7px', background: 'linear-gradient(135deg,#06b6d4,#8b5cf6)' }, html: icon('photo', 12) }), 'Photo'),
    h('div.menubar',
      menu('File', () => [
        { label: 'New image…', icon: 'plus', fn: newDialog }, { label: 'Open image…', icon: 'folder', fn: async () => { await save(); const f = await pickFiles('image/*', false); if (f.length) { S.id = uid('ph_'); await placeFiles(f, true); } } },
        { label: 'Place image as layer…', icon: 'image', fn: async () => placeFiles(await pickFiles('image/*')) }, '-',
        { label: 'Export…', icon: 'download', key: 'Ctrl+Shift+E', fn: exportDialog }, { label: 'Send to video editor', icon: 'film', fn: sendToVideo }, '-',
        { label: 'Close', icon: 'home', fn: async () => { await save(); cleanup(); onExit?.(); } }]),
      menu('Edit', () => [
        { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', fn: undo, disabled: !S.undo.length }, { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', fn: redo, disabled: !S.redo.length }, '-',
        { label: 'Cut', icon: 'scissors', key: 'Ctrl+X', fn: E.cut }, { label: 'Copy', icon: 'copy', key: 'Ctrl+C', fn: E.copy }, { label: 'Paste', icon: 'copy', key: 'Ctrl+V', fn: E.paste }, { label: 'Delete selection', icon: 'trash', key: 'Del', fn: E.clear }, '-',
        { label: 'Fill with foreground', icon: 'bucket', key: 'Alt+Del', fn: E.fill }, { label: 'Free transform', icon: 'move', key: 'Ctrl+T', fn: startTransform }]),
      menu('Image', () => [...adjItems(), '-',
        { label: 'Image size…', icon: 'aspect', fn: I.imageSize }, { label: 'Canvas size…', icon: 'fit', fn: I.canvasSize }, '-',
        { label: 'Rotate 90° clockwise', icon: 'redo', fn: () => I.rotate(90) }, { label: 'Rotate 90° counter-clockwise', icon: 'undo', fn: () => I.rotate(-90) }, { label: 'Rotate 180°', icon: 'reset', fn: () => I.rotate(180) },
        { label: 'Flip horizontal', icon: 'flipH', fn: () => I.flip(true) }, { label: 'Flip vertical', icon: 'flipV', fn: () => I.flip(false) }, '-',
        { label: 'Crop to selection', icon: 'crop', fn: I.cropToSelection }, { label: 'Trim transparent edges', icon: 'crop', fn: I.trim }]),
      menu('Layer', () => [
        { label: 'New layer', icon: 'plus', key: 'Ctrl+Shift+N', fn: L.newLayer }, { label: 'Duplicate layer', icon: 'copy', key: 'Ctrl+J', fn: L.duplicate }, { label: 'Delete layer', icon: 'trash', fn: L.remove }, '-',
        { label: 'Layer via copy', icon: 'layers', fn: () => L.fromSelection(false) }, { label: 'Layer via cut', icon: 'scissors', fn: () => L.fromSelection(true) }, '-',
        { label: 'Merge down', icon: 'layers', key: 'Ctrl+E', fn: L.mergeDown }, { label: 'Flatten image', icon: 'layers', fn: L.flatten }, { label: 'Rasterize text', icon: 'text', fn: () => active() && rasterize(active()) }, '-',
        { label: 'Bring to front', icon: 'chevronDown', fn: () => L.move('top') }, { label: 'Send to back', icon: 'chevronDown', fn: () => L.move('bottom') },
        { label: 'Flip layer horizontal', icon: 'flipH', fn: () => I.flip(true, true) }, { label: 'Flip layer vertical', icon: 'flipV', fn: () => I.flip(false, true) }]),
      menu('Select', () => [
        { label: 'All', icon: 'marquee', key: 'Ctrl+A', fn: selectAll }, { label: 'Deselect', icon: 'x', key: 'Ctrl+D', fn: deselect }, { label: 'Inverse', icon: 'reset', key: 'Ctrl+Shift+I', fn: invertSel }, '-',
        { label: 'Feather…', icon: 'droplet', fn: async () => { const v = await promptDialog('Feather radius (px)', '8'); if (v) featherSel(+v || 0); } },
        { label: 'Select subject (AI)', icon: 'sparkles', fn: () => aiRemoveBg(true) }]),
      menu('Filter', () => Object.entries(FILTERS).map(([, op]) => ({ label: op.name, icon: 'filter', fn: () => opDialog(op) }))),
      menu('AI', () => [{ label: 'Remove background', icon: 'eyeOff', fn: () => aiRemoveBg() }, { label: 'Select subject', icon: 'marquee', fn: () => aiRemoveBg(true) }, { label: 'Auto enhance', icon: 'wand', fn: autoEnhance }, { label: 'Edit with a prompt…', icon: 'sparkles', fn: () => setRightTab('ai') }])),
    nameInput, savedEl, h('div.spacer'),
    iconBtn('undo', 'Undo (Ctrl+Z)', undo), iconBtn('redo', 'Redo (Ctrl+Y)', redo),
    iconBtn('zoomOut', 'Zoom out', () => zoomAt(1 / 1.25, stageEl.clientWidth / 2, stageEl.clientHeight / 2)), zoomLabel, iconBtn('zoomIn', 'Zoom in', () => zoomAt(1.25, stageEl.clientWidth / 2, stageEl.clientHeight / 2)),
    h('div.vsep'),
    h('button.btn', { onclick: sendToVideo, html: icon('film', 15) + ' To video' }),
    h('button.btn.primary', { onclick: exportDialog, html: icon('download', 15) + ' Export' }));

  // Tool bar
  const toolsEl = h('nav.ph-tools');
  const fgSw = h('button.swatch-big.fg', { title: 'Foreground color', onclick: () => pickColor('fg') }), bgSw = h('button.swatch-big.bg', { title: 'Background color', onclick: () => pickColor('bg') });
  function pickColor(which) { const inp = h('input', { type: 'color', value: S[which] }); inp.oninput = () => { S[which] = inp.value; renderColors(); }; inp.click(); }
  function renderColors() { fgSw.style.background = S.fg; bgSw.style.background = S.bg; }
  for (const t of TOOLS) {
    if (t[0] === '-') { toolsEl.append(h('div.ph-sep')); continue; }
    toolsEl.append(h('button.ph-tool', { 'data-tool': t[0], title: t[2], html: icon(t[1], 18), onclick: () => setTool(t[0]) }));
  }
  toolsEl.append(h('div.ph-colors', fgSw, bgSw, h('button.icon-btn.ph-swap', { title: 'Swap colors (X)', html: icon('swap', 13), onclick: () => { [S.fg, S.bg] = [S.bg, S.fg]; renderColors(); } })));
  renderColors();

  // Options bar
  const optsEl = h('div.ph-opts');
  const num = (label, key, min, max, step = 1, fmt = (v) => v) => h('label.opt', label, h('input', { type: 'range', min, max, step, value: S.o[key], oninput: (e) => { S.o[key] = +e.target.value; e.target.nextSibling.textContent = fmt(S.o[key]); if (key === 'size') requestRender(); } }), h('span.opt-v', fmt(S.o[key])));
  const chk = (label, key) => h('label.opt', h('input', { type: 'checkbox', checked: S.o[key], onchange: (e) => { S.o[key] = e.target.checked; } }), label);
  const segO = (key, opts) => h('div.seg', opts.map(([v, l]) => h('button' + (S.o[key] === v ? '.on' : ''), { onclick: (e) => { S.o[key] = v; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); }, html: l })));
  function renderOpts() {
    optsEl.innerHTML = '';
    const t = S.tool, name = TOOLS.find((x) => x[0] === t)?.[2]?.split(' (')[0];
    optsEl.append(h('b.opt-name', name));
    if (PAINT.has(t)) {
      optsEl.append(num('Size', 'size', 1, 500), num('Hardness', 'hardness', 0, 1, 0.05, (v) => Math.round(v * 100) + '%'), num('Opacity', 'opacity', 0.05, 1, 0.05, (v) => Math.round(v * 100) + '%'), num('Flow', 'flow', 0.05, 1, 0.05, (v) => Math.round(v * 100) + '%'));
      if (['blurb', 'dodge', 'burn'].includes(t)) optsEl.append(num('Strength', 'strength', 0.05, 1, 0.05, (v) => Math.round(v * 100) + '%'));
      if (t === 'clone') optsEl.append(h('span.small.muted', 'Alt+click sets the source'));
    } else if (['marquee', 'ellipse', 'lasso', 'wand'].includes(t)) {
      optsEl.append(segO('selModeBase', [['new', 'New'], ['add', 'Add'], ['sub', 'Subtract']]), num('Feather', 'feather', 0, 100));
      if (t === 'wand') optsEl.append(num('Tolerance', 'tolerance', 0, 255), chk('Contiguous', 'contiguous'), chk('Sample all layers', 'sampleAll'));
      optsEl.append(h('button.btn.sm', { onclick: () => aiRemoveBg(true), html: icon('sparkles', 13) + ' Select subject' }));
    } else if (t === 'fill') optsEl.append(num('Tolerance', 'tolerance', 0, 255), chk('Contiguous', 'contiguous'), num('Opacity', 'opacity', 0.05, 1, 0.05, (v) => Math.round(v * 100) + '%'));
    else if (t === 'gradient') optsEl.append(segO('gradType', [['linear', 'Linear'], ['radial', 'Radial']]), chk('Fade to transparent', 'gradTransparent'), num('Opacity', 'opacity', 0.05, 1, 0.05, (v) => Math.round(v * 100) + '%'));
    else if (t === 'shape') optsEl.append(segO('shape', [['rect', '▭'], ['round', '▢'], ['ellipse', '◯'], ['star', '☆'], ['line', '╱']]), chk('Filled', 'shapeFill'), num('Line width', 'strokeW', 1, 80));
    else if (t === 'text') optsEl.append(h('label.opt', 'Font', h('select.select', { style: { width: '150px', height: '26px' }, onchange: (e) => { S.o.font = e.target.value; } }, FONTS.map((f) => h('option', { selected: f === S.o.font }, f)))), num('Size', 'fontSize', 8, 600));
    else if (t === 'crop') optsEl.append(segO('cropRatio', [[0, 'Free'], [1, '1:1'], [4 / 5, '4:5'], [16 / 9, '16:9'], [9 / 16, '9:16']]), h('button.btn.sm.primary', { onclick: applyCrop }, 'Apply crop (Enter)'), h('button.btn.sm', { onclick: () => { S.crop = null; requestRender(); } }, 'Cancel'));
    else if (t === 'move') optsEl.append(chk('Auto-select layer', 'autoSelect'), h('button.btn.sm', { onclick: startTransform, html: icon('move', 13) + ' Free transform (Ctrl+T)' }), S.xf ? h('button.btn.sm.primary', { onclick: applyTransform }, 'Apply') : null);
    else if (t === 'eyedropper') optsEl.append(h('span.small.muted', 'Click: foreground · Alt+click: background'));
    else if (t === 'zoom') optsEl.append(h('button.btn.sm', { onclick: fit }, 'Fit'), h('button.btn.sm', { onclick: () => { S.zoom = 1; requestRender(); } }, '100%'));
  }
  function setTool(t) {
    if (S.xf && t !== 'move') applyTransform();
    S.tool = t; toolsEl.querySelectorAll('.ph-tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    view.style.cursor = { hand: 'grab', zoom: 'zoom-in', move: 'move', text: 'text', eyedropper: 'crosshair' }[t] || (PAINT.has(t) ? 'none' : 'crosshair');
    renderOpts(); requestRender();
  }

  // Right panel
  const right = h('aside.ph-right');
  const rTabs = h('div.insp-tabs'), rBody = h('div.ph-rbody'), layersEl = h('div.ph-layers');
  let rightTab = 'props';
  function setRightTab(t) { rightTab = t; renderPanels(); }
  right.append(rTabs, rBody, h('div.ph-layers-head', h('b', 'Layers'), h('div',
    iconBtn('plus', 'New layer', L.newLayer), iconBtn('copy', 'Duplicate', L.duplicate), iconBtn('layers', 'Merge down', L.mergeDown), iconBtn('trash', 'Delete layer', L.remove))), layersEl);

  function renderPanels() {
    rTabs.innerHTML = '';
    for (const [k, l] of [['props', 'Properties'], ['adjust', 'Adjust'], ['ai', 'AI'], ['history', 'History']]) rTabs.append(h('button' + (rightTab === k ? '.on' : ''), { onclick: () => setRightTab(k) }, l));
    rBody.innerHTML = '';
    const l = active();
    if (rightTab === 'props') rBody.append(propsPanel(l));
    else if (rightTab === 'adjust') rBody.append(h('div',
      h('div.sub', { style: { marginTop: 0 } }, 'Adjustments'), h('div.ph-grid', Object.values(ADJUSTMENTS).map((op) => h('button.ph-gbtn', { onclick: () => opDialog(op) }, op.name))),
      h('div.sub', 'Filters'), h('div.ph-grid', Object.values(FILTERS).map((op) => h('button.ph-gbtn', { onclick: () => opDialog(op) }, op.name))),
      h('p.small.muted', S.sel ? 'Only the selected area will change.' : 'Applies to the selected layer.')));
    else if (rightTab === 'ai') rBody.append(aiPanel());
    else rBody.append(h('div.ph-history', S.undo.map((u, i) => h('button.ph-hrow', { onclick: () => { while (S.undo.length > i) undo(); } }, h('span', { html: icon('history', 13) }), u.label)), h('div.ph-hrow.on', h('span', { html: icon('check', 13) }), 'Current'),
      [...S.redo].reverse().map((r) => h('div.ph-hrow.future', r.label))));
    renderLayers();
  }
  function propsPanel(l) {
    if (!l) return h('p.muted', 'No layer selected.');
    const set = (label, fn, merge) => { if (!merge || mergeKey !== merge) { push(label); mergeKey = merge; } fn(); changed(true, true); };
    let mergeKey = null;
    const fx = l.fx || (l.fx = {});
    const kids = [
      h('div.card', h('h4', 'Layer'),
        h('div.row', h('label', 'Name'), h('input.input.grow', { value: l.name, onchange: (e) => { l.name = e.target.value || 'Layer'; renderLayers(); changed(); } })),
        sliderRow('Opacity', Math.round(l.opacity * 100), { min: 0, max: 100, def: 100, unit: '%', onInput: (v) => set('Opacity', () => { l.opacity = v / 100; }, 'op' + l.id) }),
        h('div.row', h('label', 'Blend'), h('select.select.grow', { onchange: (e) => set('Blend mode', () => { l.blend = e.target.value; }) }, BLENDS.map(([v, n]) => h('option', { value: v, selected: l.blend === v }, n)))),
        h('div.small.muted', `${l.canvas.width}×${l.canvas.height} at ${l.x}, ${l.y}`)),
    ];
    if (l.type === 'text') {
      const t = l.text, re = (label, fn, merge) => set(label, () => { fn(); renderText(l); }, merge);
      kids.push(h('div.card', h('h4', 'Text'),
        h('textarea.input.ph-text', { rows: 3, value: t.content, oninput: (e) => re('Edit text', () => { t.content = e.target.value; }, 'txt' + l.id) }),
        h('div.row', { style: { marginTop: '8px' } }, h('select.select.grow', { onchange: (e) => re('Font', () => { t.font = e.target.value; }) }, FONTS.map((f) => h('option', { selected: f === t.font, style: { fontFamily: `"${f}"` } }, f)))),
        sliderRow('Size', Math.round(t.size), { min: 6, max: 800, def: 120, onInput: (v) => re('Text size', () => { t.size = v; }, 'ts' + l.id) }),
        h('div.row', h('label', 'Color'), h('input', { type: 'color', value: t.color, oninput: (e) => re('Text color', () => { t.color = e.target.value; }, 'tc' + l.id) }),
          h('button.chip' + (t.bold ? '.on' : ''), { onclick: () => { re('Bold', () => { t.bold = !t.bold; }); renderPanels(); } }, h('b', 'B')),
          h('button.chip' + (t.italic ? '.on' : ''), { onclick: () => { re('Italic', () => { t.italic = !t.italic; }); renderPanels(); } }, h('i', 'I')),
          h('select.select', { style: { width: '90px' }, onchange: (e) => re('Align', () => { t.align = e.target.value; }) }, ['left', 'center', 'right'].map((a) => h('option', { selected: a === t.align }, a)))),
        sliderRow('Spacing', t.letterSpacing || 0, { min: -20, max: 80, def: 0, onInput: (v) => re('Spacing', () => { t.letterSpacing = v; }, 'tsp' + l.id) }),
        sliderRow('Outline', t.strokeWidth || 0, { min: 0, max: 40, def: 0, onInput: (v) => re('Outline', () => { t.strokeWidth = v; }, 'tsw' + l.id) }),
        h('div.row', h('label', 'Outline color'), h('input', { type: 'color', value: t.strokeColor, oninput: (e) => re('Outline color', () => { t.strokeColor = e.target.value; }, 'tsc' + l.id) })),
        h('button.btn.sm', { onclick: () => rasterize(l) }, 'Rasterize text')));
    }
    const fxRow = (label, key, extra) => h('div', h('div.row', h('label', label), toggle(!!fx[key], (on) => { set(label, () => { fx[key] = on; }); renderPanels(); })), fx[key] ? extra() : null);
    kids.push(h('div.card', h('h4', 'Layer style'),
      fxRow('Drop shadow', 'shadow', () => h('div',
        h('div.row', h('label', 'Color'), h('input', { type: 'color', value: fx.shadowColor || '#000000', oninput: (e) => set('Shadow', () => { fx.shadowColor = e.target.value; }, 'shc') })),
        sliderRow('Opacity', Math.round((fx.shadowOpacity ?? 0.6) * 100), { min: 0, max: 100, def: 60, unit: '%', onInput: (v) => set('Shadow', () => { fx.shadowOpacity = v / 100; }, 'sho') }),
        sliderRow('Distance', fx.shadowDist ?? 12, { min: 0, max: 200, def: 12, onInput: (v) => set('Shadow', () => { fx.shadowDist = v; }, 'shd') }),
        sliderRow('Angle', fx.shadowAngle ?? 135, { min: 0, max: 360, def: 135, unit: '°', onInput: (v) => set('Shadow', () => { fx.shadowAngle = v; }, 'sha') }),
        sliderRow('Blur', fx.shadowBlur ?? 16, { min: 0, max: 150, def: 16, onInput: (v) => set('Shadow', () => { fx.shadowBlur = v; }, 'shb') }))),
      fxRow('Outer glow', 'glow', () => h('div',
        h('div.row', h('label', 'Color'), h('input', { type: 'color', value: fx.glowColor || '#ffffff', oninput: (e) => set('Glow', () => { fx.glowColor = e.target.value; }, 'glc') })),
        sliderRow('Size', fx.glowSize ?? 24, { min: 1, max: 200, def: 24, onInput: (v) => set('Glow', () => { fx.glowSize = v; }, 'gls') }))),
      fxRow('Stroke', 'stroke', () => h('div',
        h('div.row', h('label', 'Color'), h('input', { type: 'color', value: fx.strokeColor || '#000000', oninput: (e) => set('Stroke', () => { fx.strokeColor = e.target.value; }, 'stc') })),
        sliderRow('Size', fx.strokeSize ?? 4, { min: 1, max: 60, def: 4, onInput: (v) => set('Stroke', () => { fx.strokeSize = v; }, 'sts') })))));
    kids.push(h('div.card', h('h4', 'Quick actions'), h('div.ph-grid',
      h('button.ph-gbtn', { onclick: autoEnhance }, '✨ Auto enhance'), h('button.ph-gbtn', { onclick: () => aiRemoveBg() }, '✂ Remove background'),
      h('button.ph-gbtn', { onclick: startTransform }, '⤡ Free transform'), h('button.ph-gbtn', { onclick: () => I.flip(true, true) }, '⇋ Flip layer'),
      h('button.ph-gbtn', { onclick: () => opDialog(ADJUSTMENTS.hueSaturation) }, '🎨 Hue / Sat'), h('button.ph-gbtn', { onclick: () => opDialog(FILTERS.gaussian) }, '◌ Blur'))));
    return h('div', kids);
  }
  function aiPanel() {
    const log = h('div.ph-ailog');
    const ta = h('textarea.input', { rows: 3, placeholder: 'e.g. “Make it warmer and more cinematic”, “Remove the background and add the title SUMMER at the top”' });
    const go = async (text) => {
      text = (text || ta.value).trim(); if (!text) return;
      log.append(h('div.msg.user', text)); ta.value = '';
      const wait = h('div.msg.ai', h('span.spinner'), ' Looking at your image…'); log.append(wait);
      try { const m = await aiEdit(text, (t) => log.append(h('div.small.muted', t))); wait.replaceWith(h('div.msg.ai', m)); }
      catch (e) { wait.replaceWith(h('div.msg.ai.err', '⚠ ' + e.message)); }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
    return h('div',
      h('p.small.muted', { style: { marginTop: 0 } }, 'Frame AI looks at your image and edits it. Undo reverts the whole AI edit.'),
      h('div.chips', ['Auto enhance like a pro', 'Make it cinematic', 'Vintage film look', 'Black and white, dramatic', 'Make colors pop', 'Remove the background'].map((s) => h('button.chip', { onclick: () => go(s) }, s))),
      h('div', { style: { marginTop: '10px' } }, ta), h('button.btn.primary.block', { style: { marginTop: '8px' }, onclick: () => go(), html: icon('sparkles', 15) + ' Apply' }), log);
  }
  let dragLayer = null;
  function renderLayers() {
    layersEl.innerHTML = '';
    for (const l of [...S.layers].reverse()) {
      const th = newCanvas(40, 30), tx = th.getContext('2d'), s = Math.min(40 / S.w, 30 / S.h);
      tx.fillStyle = '#2a2c33'; tx.fillRect(0, 0, 40, 30); tx.drawImage(l.canvas, (40 - S.w * s) / 2 + l.x * s, (30 - S.h * s) / 2 + l.y * s, l.canvas.width * s, l.canvas.height * s);
      const row = h('div.ph-layer' + (l.id === S.active ? '.on' : ''), { draggable: true, onclick: () => { S.active = l.id; renderPanels(); } },
        h('button.icon-btn', { title: l.visible ? 'Hide' : 'Show', html: icon(l.visible ? 'eye' : 'eyeOff', 14), onclick: (e) => { e.stopPropagation(); push('Visibility'); l.visible = !l.visible; changed(true); } }),
        th, h('span.ph-lname', l.type === 'text' ? 'T  ' + l.name : l.name),
        Object.values(l.fx || {}).some((v) => v === true) ? h('span.ph-fx', 'fx') : null,
        h('button.icon-btn', { title: l.locked ? 'Unlock' : 'Lock', html: icon(l.locked ? 'lock' : 'unlock', 13), onclick: (e) => { e.stopPropagation(); l.locked = !l.locked; renderLayers(); } }));
      row.addEventListener('dblclick', async () => { const n = await promptDialog('Layer name', l.name); if (n) { l.name = n; renderPanels(); changed(); } });
      row.addEventListener('dragstart', () => { dragLayer = l; });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => { e.preventDefault(); if (!dragLayer || dragLayer === l) return; push('Reorder layers'); S.layers.splice(S.layers.indexOf(dragLayer), 1); S.layers.splice(S.layers.indexOf(l) + 1, 0, dragLayer); changed(true); });
      layersEl.append(row);
    }
  }

  function changed(rerender = false, skipPanels = false) {
    S.dirty = true; savedEl.textContent = 'Saving…'; saveSoon();
    if (rerender && !skipPanels) renderPanels();
    requestRender();
  }

  function newDialog() {
    const wI = h('input.input', { type: 'number', value: 1080 }), hI = h('input.input', { type: 'number', value: 1080 });
    const bgSel = h('select.select', [['#ffffff', 'White'], ['transparent', 'Transparent'], ['#000000', 'Black'], ['fg', 'Foreground color']].map(([v, l]) => h('option', { value: v }, l)));
    modal({ title: 'New image', width: 460, body: h('div',
      h('div.ph-presets', SIZES.map(([n, w, hh]) => h('button.chip', { onclick: () => { wI.value = w; hI.value = hh; } }, `${n} · ${w}×${hh}`))),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginTop: '12px' } }, h('div.field', h('label', 'Width'), wI), h('div.field', h('label', 'Height'), hI), h('div.field', h('label', 'Background'), bgSel))),
    actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: async () => {
      await save();
      S.id = uid('ph_'); S.name = 'Untitled image'; nameInput.value = S.name; S.w = clamp(+wI.value | 0, 1, 12000); S.h = clamp(+hI.value | 0, 1, 12000);
      const l = makeLayer('Background'); const col = bgSel.value === 'fg' ? S.fg : bgSel.value;
      if (col !== 'transparent') { const x = l.canvas.getContext('2d'); x.fillStyle = col; x.fillRect(0, 0, S.w, S.h); }
      S.layers = [l]; S.active = l.id; S.undo = []; S.redo = []; deselect(); changed(true); fit();
    } }] });
  }

  // Keyboard
  const onKey = (e) => {
    if (document.querySelector('.modal-wrap')) return;
    const tag = e.target.tagName; if ((tag === 'INPUT' && !['range', 'checkbox'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    const run = (fn) => { e.preventDefault(); fn(); };
    if (e.key === ' ' && !spaceDown) { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
    if (ctrl && k === 'z') return run(e.shiftKey ? redo : undo);
    if (ctrl && k === 'y') return run(redo);
    if (ctrl && k === 'c') return run(E.copy);
    if (ctrl && k === 'x') return run(E.cut);
    if (ctrl && k === 'v') return; // handled by paste event (system clipboard) with internal fallback
    if (ctrl && k === 'a') return run(selectAll);
    if (ctrl && k === 'd') return run(deselect);
    if (ctrl && e.shiftKey && k === 'i') return run(invertSel);
    if (ctrl && k === 't') return run(startTransform);
    if (ctrl && k === 'j') return run(L.duplicate);
    if (ctrl && e.shiftKey && k === 'n') return run(L.newLayer);
    if (ctrl && e.shiftKey && k === 'e') return run(exportDialog);
    if (ctrl && k === 'e') return run(L.mergeDown);
    if (ctrl && k === 's') return run(() => { S.dirty = true; save(); });
    if (ctrl && (k === '=' || k === '+')) return run(() => zoomAt(1.25, stageEl.clientWidth / 2, stageEl.clientHeight / 2));
    if (ctrl && k === '-') return run(() => zoomAt(0.8, stageEl.clientWidth / 2, stageEl.clientHeight / 2));
    if (ctrl && k === '0') return run(fit);
    if (ctrl) return;
    if (e.key === 'Enter') { if (S.xf) return run(applyTransform); if (S.crop) return run(applyCrop); }
    if (e.key === 'Escape') { if (S.xf) { S.xf = null; requestRender(); return; } if (S.crop) { S.crop = null; requestRender(); return; } return run(deselect); }
    if (e.key === 'Delete' || e.key === 'Backspace') return run(e.altKey ? E.fill : E.clear);
    if (k === 'x') return run(() => { [S.fg, S.bg] = [S.bg, S.fg]; renderColors(); });
    if (k === 'd') return run(() => { S.fg = '#000000'; S.bg = '#ffffff'; renderColors(); });
    if (k === '[') return run(() => { S.o.size = Math.max(1, Math.round(S.o.size * 0.8)); renderOpts(); requestRender(); });
    if (k === ']') return run(() => { S.o.size = Math.min(500, Math.round(S.o.size * 1.25) + 1); renderOpts(); requestRender(); });
    const t = TOOLS.find((x) => x[3] === k); if (t) return run(() => setTool(t[0]));
  };
  const onKeyUp = (e) => { if (e.key === ' ') { spaceDown = false; setTool(S.tool); } };
  const onPaste = async (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); await placeFiles([item.getAsFile()]); } else E.paste();
  };
  const onDrop = async (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); e.stopPropagation(); await placeFiles([...e.dataTransfer.files]); };
  const onDragOver = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } };
  document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKeyUp); document.addEventListener('paste', onPaste);
  const ro = new ResizeObserver(() => requestRender());
  function cleanup() { document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); document.removeEventListener('paste', onPaste); ro.disconnect(); }

  // ---------------- Mount ----------------
  app.innerHTML = '';
  const root = h('div.photo-app', top, optsEl, h('div.ph-main', toolsEl, stageEl, right));
  root.addEventListener('drop', onDrop); root.addEventListener('dragover', onDragOver);
  app.append(root);
  ro.observe(stageEl);

  if (id) { const rec = await db.get('photos', id); if (rec) await load(rec); }
  if (!S.layers.length && file) await placeFiles([file], true);
  if (!S.layers.length) { const l = makeLayer('Background'); const x = l.canvas.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, S.w, S.h); S.layers = [l]; S.active = l.id; S.dirty = true; }
  nameInput.value = S.name;
  setTool('brush'); renderPanels();
  setTimeout(fit, 30);
  document.title = `${S.name} - Frame Photo`;
  // debug hook
  window.framePhoto = { S, L, E, I, placeFiles, setSelection, shapeMask, selectAll, startTransform, applyTransform, aiRemoveBg, undo, redo, renderPanels, opDialog, aiEdit, autoEnhance, applyCrop, composite, setTool, save, ADJUSTMENTS, FILTERS, modifyLayer, wand, bucketFill, drawShape, addText, beginPaint, movePaint, endPaint };
  return { save, cleanup };
}
