// Timeline UI: tracks, clips, ruler, playhead, drag/trim/snap, drop from media bin.
import { store, clipEnd, clipsOn, clipById, trackById, projectDuration, trimClip, addTrack, isFree } from './store.js';
import { mediaMap } from './media.js';
import { engine } from './engine.js';
import { h, iconBtn, clamp, fmtTime, esc } from './util.js';
import { icon } from './icons.js';
import * as A from './actions.js';
import { showContextMenu } from './ui.js';
import { keyTimes } from './anim.js';
import { EFFECTS } from './fx.js';

const RULER_H = 26;
const trackH = (t) => (t.main ? 66 : t.kind === 'audio' ? 50 : 46);
const CLIP_LABEL = { effect: 'bolt', video: 'film', image: 'image', audio: 'music', text: 'text', sticker: 'sticker', color: 'shapes', shape: 'shapes' };

export function createTimeline(root) {
  const zoomInput = h('input.zoom', { type: 'range', min: 0, max: 100, step: 1, title: 'Zoom (Ctrl + mouse wheel)' });
  const tbtn = (name, title, fn, cls = '') => { const b = iconBtn(name, title, fn); if (cls) b.classList.add(cls); return b; };
  const snapBtn = tbtn('snap', 'Snapping (N)', () => store.setUI({ snap: !store.ui.snap }));
  const magBtn = tbtn('magnet', 'Magnetic main track - keeps main clips together', () => { store.setUI({ magnet: !store.ui.magnet }); store.finish(); });
  const undoB = tbtn('undo', 'Undo (Ctrl+Z)', () => store.undo());
  const redoB = tbtn('redo', 'Redo (Ctrl+Y)', () => store.redo());
  const sel = (fn) => () => fn();
  const tools = h('div.tl-tools',
    undoB, redoB, h('div.vsep'),
    tbtn('split', 'Split at playhead (S)', sel(() => A.splitAt())),
    tbtn('trash', 'Delete (Del)', sel(() => A.deleteSelected(false))),
    tbtn('copy', 'Duplicate (Ctrl+D)', sel(() => A.duplicateSelected())),
    tbtn('snowflake', 'Freeze frame', sel(() => A.freezeFrame())),
    tbtn('audioDetach', 'Extract audio', sel(() => A.detachAudio())),
    tbtn('scissors', 'Remove silence from selected clip(s)', sel(() => A.removeSilence(store.selection))),
    h('div', { style: { flex: 1 } }),
    snapBtn, magBtn, h('div.vsep'),
    tbtn('zoomOut', 'Zoom out (-)', () => setZoom(store.ui.zoom / 1.4)),
    zoomInput,
    tbtn('zoomIn', 'Zoom in (+)', () => setZoom(store.ui.zoom * 1.4)),
    tbtn('fit', 'Fit timeline (Shift+Z)', () => fit()),
  );

  const headsInner = h('div.inner');
  const heads = h('div.tl-heads', h('div.ruler-pad'), headsInner);
  const rulerCanvas = h('canvas');
  const ruler = h('div.ruler', rulerCanvas);
  const tracksEl = h('div.tracks');
  const playhead = h('div.playhead', h('div.knob'));
  const snapLine = h('div.snap-line.hidden');
  const content = h('div.tl-content', ruler, tracksEl, playhead, snapLine);
  const scroller = h('div.tl-scroll', content);
  const empty = h('div.tl-empty', 'Drag media here, or press + on any item in the Media panel');
  const main = h('div.tl-main', heads, scroller, empty);
  root.append(tools, main);

  const pps = () => store.ui.zoom;
  const xOf = (t) => t * pps();
  const tOf = (x) => x / pps();
  const ZMIN = 4, ZMAX = 600;
  const zToSlider = (z) => (Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN)) * 100;
  const sliderToZ = (s) => ZMIN * Math.pow(ZMAX / ZMIN, s / 100);
  zoomInput.oninput = () => setZoom(sliderToZ(+zoomInput.value));

  function setZoom(z, anchorX = null) {
    z = clamp(z, ZMIN, ZMAX);
    const ax = anchorX ?? (xOf(store.playhead) - scroller.scrollLeft);
    const tAnchor = (scroller.scrollLeft + ax) / pps();
    store.ui.zoom = z;
    render();
    scroller.scrollLeft = tAnchor * z - ax;
    drawRuler();
  }
  function fit() {
    const d = Math.max(projectDuration(store.project), 5);
    setZoom((scroller.clientWidth - 80) / d);
    scroller.scrollLeft = 0;
  }

  // ---------- Ruler ----------
  function drawRuler() {
    const w = scroller.clientWidth, dpr = window.devicePixelRatio || 1;
    rulerCanvas.width = w * dpr; rulerCanvas.height = RULER_H * dpr;
    rulerCanvas.style.width = w + 'px'; rulerCanvas.style.height = RULER_H + 'px';
    rulerCanvas.style.left = scroller.scrollLeft + 'px';
    const g = rulerCanvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, RULER_H);
    const steps = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * pps() >= 90) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    const t0 = tOf(scroller.scrollLeft), t1 = tOf(scroller.scrollLeft + w);
    g.font = '10.5px Inter, sans-serif'; g.textBaseline = 'top';
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(xOf(t) - scroller.scrollLeft) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.strokeStyle = isMajor ? '#555b6b' : '#33373f';
      g.beginPath(); g.moveTo(x, isMajor ? 12 : 18); g.lineTo(x, RULER_H); g.stroke();
      if (isMajor) {
        g.fillStyle = '#8a8fa0';
        const label = major < 1 ? `${fmtTime(t)}:${String(Math.round((t % 1) * store.project.fps)).padStart(2, '0')}` : fmtTime(t);
        g.fillText(label, x + 4, 2);
      }
    }
    for (const m of store.project.markers || []) {
      const x = xOf(m.t) - scroller.scrollLeft;
      g.fillStyle = m.color || '#facc15';
      if (m.kind === 'beat') { g.fillRect(x - 1, 17, 2, 9); continue; }
      g.beginPath(); g.moveTo(x - 5, 14); g.lineTo(x + 5, 14); g.lineTo(x, 22); g.fill();
    }
  }

  // ---------- Render tracks/clips ----------
  let rowTops = [];
  function render() {
    const p = store.project; if (!p) return;
    const dur = projectDuration(p);
    const width = Math.max(xOf(dur + 30), scroller.clientWidth + 200);
    content.style.width = width + 'px';
    tracksEl.innerHTML = ''; headsInner.innerHTML = '';
    rowTops = [];
    let y = 8;
    for (const t of p.tracks) {
      const th = trackH(t);
      rowTops.push({ track: t, top: y, h: th });
      const row = h(`div.track${t.main ? '.main' : ''}${t.locked ? '.locked' : ''}${t.hidden ? '.hiddenT' : ''}`, { style: { height: th + 'px' }, 'data-id': t.id });
      for (const c of clipsOn(p, t.id)) row.append(clipEl(c, th));
      tracksEl.append(row);
      headsInner.append(headEl(t, th));
      y += th + 4;
    }
    const ntz = h('div.new-track-zone'); tracksEl.append(ntz);
    rowTops.push({ track: null, top: y, h: 34 });
    headsInner.style.top = (RULER_H + 8 - scroller.scrollTop) + 'px';
    empty.classList.toggle('hidden', p.clips.length > 0);
    snapBtn.classList.toggle('on', store.ui.snap);
    magBtn.classList.toggle('on', store.ui.magnet);
    undoB.disabled = !store.undoStack.length; redoB.disabled = !store.redoStack.length;
    zoomInput.value = zToSlider(store.ui.zoom);
    zoomInput.style.setProperty('--fill', zoomInput.value + '%');
    updatePlayhead();
    drawRuler();
  }

  function headEl(t, th) {
    const tog = (name, offName, on, title, fn) => { const b = iconBtn(on ? offName : name, title, fn); if (on) b.classList.add('on'); return b; };
    const mut = (fn) => () => store.edit('Track', (p) => fn(trackById(p, t.id)));
    return h('div.th', { style: { height: th + 'px', marginBottom: '4px' } },
      h('span', { html: icon(t.kind === 'audio' ? 'music' : t.main ? 'film' : 'layers', 13), style: { marginRight: '6px', opacity: 0.8 } }),
      h('span.tname', t.main ? 'Main' : t.kind === 'audio' ? 'Audio' : 'Overlay'),
      t.kind === 'visual' ? tog('eye', 'eyeOff', t.hidden, t.hidden ? 'Show track' : 'Hide track', mut((x) => { x.hidden = !x.hidden; })) : null,
      t.kind === 'audio' || t.main ? tog('volume', 'mute', t.muted, t.muted ? 'Unmute track' : 'Mute track', mut((x) => { x.muted = !x.muted; })) : null,
      tog('unlock', 'lock', t.locked, t.locked ? 'Unlock track' : 'Lock track', mut((x) => { x.locked = !x.locked; })),
    );
  }

  function clipEl(c, th) {
    const p = store.project;
    const m = c.mediaId ? mediaMap.get(c.mediaId) : null;
    const w = Math.max(2, xOf(c.duration));
    const el = h(`div.clip.${c.type}${store.selection.includes(c.id) ? '.sel' : ''}`, { 'data-id': c.id, style: { left: xOf(c.start) + 'px', width: w + 'px' } });
    // Thumbnails
    if ((c.type === 'video' || c.type === 'image') && m?.thumbs?.length) {
      const strip = h('div.thumbs');
      const tileW = Math.max(20, ((m.width || 16) / (m.height || 9)) * th);
      const n = Math.min(120, Math.ceil(w / tileW));
      for (let i = 0; i < n; i++) {
        let idx = 0;
        if (c.type === 'video') {
          const st = c.in + ((i * tileW) / pps()) * c.speed;
          idx = clamp(Math.floor((st / m.duration) * m.thumbs.length), 0, m.thumbs.length - 1);
        }
        strip.append(h('img', { src: m.thumbs[idx], style: { width: tileW + 'px' }, draggable: false }));
      }
      el.append(strip);
    }
    // Waveform
    if (m?.peaks && (c.type === 'audio' || (c.type === 'video' && th > 50))) {
      const wh = c.type === 'audio' ? th - 16 : 16;
      const cw = Math.min(w, 8000);
      const cv = h('canvas.wave', { width: Math.ceil(cw), height: wh, style: { width: cw + 'px', height: wh + 'px' } });
      const g = cv.getContext('2d');
      g.fillStyle = c.type === 'audio' ? (c.muted ? '#4b5563' : '#4ade80') : 'rgba(255,255,255,.55)';
      if (c.type === 'video') { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, cw, wh); g.fillStyle = c.muted ? '#666' : 'rgba(134,239,172,.9)'; }
      const vol = Math.min(2, c.volume ?? 1);
      for (let x = 0; x < cw; x += 2) {
        const st = c.in + (x / pps()) * c.speed;
        const v = m.peaks[Math.floor(st * m.peaksPerSec)] || 0;
        const bh = Math.max(1, Math.min(1, v * vol) * wh);
        g.fillRect(x, wh - bh, 1.5, bh);
      }
      el.append(cv);
    }
    // Label
    let label = c.name;
    if (c.type === 'text') label = c.text.content.replace(/\n/g, ' ');
    if (c.type === 'sticker') label = c.sticker + '  Sticker';
    if (c.type === 'effect') label = (EFFECTS[c.effect]?.name || c.effect) + ' effect';
    const tags = [];
    if (c.speed !== 1) tags.push(`${c.speed}x`);
    if (c.reverse) tags.push('◀ reverse');
    if (c.curve) tags.push('curve');
    if (c.voiceFx && c.voiceFx !== 'none') tags.push(c.voiceFx);
    if (c.bgRemove || c.chroma?.on) tags.push('cutout');
    if (c.mask && c.mask.type !== 'none') tags.push('mask');
    if (c.muted && c.type !== 'text') tags.push('muted');
    el.append(h('div.label', { html: icon(CLIP_LABEL[c.type] || 'film', 12) }, esc(label), ...tags.map((t) => h('span.tag', t))));
    const hasFx = c.look !== 'none' || c.anim.in !== 'none' || c.anim.out !== 'none' || c.anim.loop !== 'none';
    if (hasFx && w > 50) el.append(h('div.fx-dot', '✦'));
    if (c.fadeIn > 0) el.append(h('div.fade.in', { style: { width: xOf(c.fadeIn) + 'px' } }));
    if (c.fadeOut > 0) el.append(h('div.fade.out', { style: { width: xOf(c.fadeOut) + 'px' } }));
    if (c.transition?.type && c.transition.type !== 'none') el.append(h('div.trans-badge', { title: 'Transition', html: icon('transition', 11) }));
    if (store.selection.includes(c.id)) for (const kt of keyTimes(c)) el.append(h('div.kf-dot', { style: { left: xOf(kt) + 'px' }, title: 'Keyframe' }));
    el.append(h('div.handle.l'), h('div.handle.r'));
    return el;
  }

  function updatePlayhead() {
    playhead.style.left = xOf(store.playhead) + 'px';
  }

  // ---------- Interaction ----------
  function snapPoints(excludeIds) {
    const pts = [0, store.playhead];
    for (const c of store.project.clips) { if (excludeIds.includes(c.id)) continue; pts.push(c.start, clipEnd(c)); }
    for (const m of store.project.markers || []) pts.push(m.t);
    return pts;
  }
  function snap(t, pts, extraEdges = [0]) {
    if (!store.ui.snap) return { t, line: null };
    const thr = 8 / pps();
    let best = null;
    for (const off of extraEdges) for (const s of pts) {
      const d = s - (t + off);
      if (Math.abs(d) < thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: s };
    }
    return best ? { t: t + best.d, line: best.line } : { t, line: null };
  }
  function showSnap(t) {
    if (t == null) return snapLine.classList.add('hidden');
    snapLine.classList.remove('hidden'); snapLine.style.left = xOf(t) + 'px';
  }
  function rowAt(clientY) {
    const r = tracksEl.getBoundingClientRect();
    const y = clientY - r.top;
    if (y < 4) return { track: 'newTop' };
    for (const row of rowTops) if (y >= row.top - 2 && y < row.top + row.h + 2) return row.track ? { track: row.track } : { track: 'newBottom' };
    return { track: 'newBottom' };
  }
  const timeAtClientX = (cx) => tOf(cx - content.getBoundingClientRect().left);

  tracksEl.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const clipNode = e.target.closest('.clip');
    if (!clipNode) {
      if (!e.ctrlKey && !e.shiftKey) store.select([]);
      engine.seek(timeAtClientX(e.clientX));
      startScrub(e);
      return;
    }
    const id = clipNode.dataset.id;
    const p = store.project; const c = clipById(p, id);
    if (!c || trackById(p, c.trackId)?.locked) return;
    if (e.ctrlKey || e.shiftKey) { store.select(store.selection.includes(id) ? store.selection.filter((x) => x !== id) : [...store.selection, id]); return; }
    if (!store.selection.includes(id)) store.select(id);
    const handle = e.target.closest('.handle');
    if (handle) startTrim(e, c, handle.classList.contains('l') ? 'start' : 'end', clipNode);
    else startMove(e, c, clipNode);
  });

  tracksEl.addEventListener('dblclick', (e) => {
    const clipNode = e.target.closest('.clip');
    if (clipNode) { const c = clipById(store.project, clipNode.dataset.id); if (c) engine.seek(Math.max(c.start, Math.min(timeAtClientX(e.clientX), clipEnd(c) - 0.01))); }
  });

  tracksEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const clipNode = e.target.closest('.clip');
    if (clipNode && !store.selection.includes(clipNode.dataset.id)) store.select(clipNode.dataset.id);
    const c = store.selected;
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Split at playhead', icon: 'split', key: 'S', fn: () => A.splitAt() },
      { label: 'Duplicate', icon: 'copy', key: 'Ctrl+D', fn: () => A.duplicateSelected(), disabled: !store.selection.length },
      { label: 'Copy', icon: 'copy', key: 'Ctrl+C', fn: () => A.copySelected(), disabled: !store.selection.length },
      { label: 'Paste at playhead', icon: 'copy', key: 'Ctrl+V', fn: () => A.paste() },
      '-',
      c?.type === 'video' ? { label: 'Extract audio', icon: 'audioDetach', fn: () => A.detachAudio() } : null,
      c?.type === 'video' ? { label: 'Freeze frame (3s)', icon: 'snowflake', fn: () => A.freezeFrame() } : null,
      c && (c.type === 'video' || c.type === 'audio') ? { label: 'Remove silence', icon: 'scissors', fn: () => A.removeSilence([c.id]) } : null,
      '-',
      { label: 'Delete', icon: 'trash', key: 'Del', fn: () => A.deleteSelected(false), disabled: !store.selection.length },
      { label: 'Ripple delete (close gap)', icon: 'trash', key: 'Shift+Del', fn: () => A.deleteSelected(true), disabled: !store.selection.length },
    ].filter(Boolean));
  });

  function startScrub(e) {
    const move = (ev) => engine.seek(Math.max(0, timeAtClientX(ev.clientX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  ruler.addEventListener('pointerdown', (e) => { engine.seek(Math.max(0, timeAtClientX(e.clientX))); startScrub(e); });
  playhead.querySelector('.knob').addEventListener('pointerdown', (e) => { e.stopPropagation(); startScrub(e); });

  function startMove(e, c, node) {
    const p = store.project;
    const ids = store.selection.length ? [...store.selection] : [c.id];
    const origin = ids.map((id) => { const x = clipById(p, id); return { id, start: x.start, trackId: x.trackId }; });
    const x0 = e.clientX, y0 = e.clientY;
    const pts = snapPoints(ids);
    const minStart = Math.min(...origin.map((o) => o.start));
    let started = false, target = null;
    const nodes = ids.map((id) => tracksEl.querySelector(`.clip[data-id="${id}"]`)).filter(Boolean);
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!started) { if (Math.hypot(dx, dy) < 4) return; started = true; store.checkpoint('Move'); nodes.forEach((n) => n.classList.add('dragging')); }
      let delta = tOf(dx);
      if (minStart + delta < 0) delta = -minStart;
      const self = origin.find((o) => o.id === c.id);
      const sn = snap(self.start + delta, pts, [0, c.duration]);
      delta = sn.t - self.start; if (minStart + delta < 0) delta = -minStart;
      showSnap(sn.line);
      for (const o of origin) { const n = tracksEl.querySelector(`.clip[data-id="${o.id}"]`); if (n) n.style.left = xOf(o.start + delta) + 'px'; }
      // Vertical: only for single clip
      tracksEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      target = null;
      if (ids.length === 1 && Math.abs(dy) > 12) {
        const r = rowAt(ev.clientY);
        const kind = c.type === 'audio' ? 'audio' : 'visual';
        if (r.track && typeof r.track === 'object' && r.track.kind === kind && r.track.id !== c.trackId && !r.track.locked) target = r.track.id;
        else if (typeof r.track === 'string') target = r.track === 'newTop' && kind === 'visual' ? 'newTop' : 'newBottom';
        const rowNode = typeof target === 'string' && target.startsWith('t_') ? tracksEl.querySelector(`.track[data-id="${target}"]`) : target === 'newBottom' ? tracksEl.querySelector('.new-track-zone') : null;
        rowNode?.classList.add('drop-target');
        node.style.transform = `translateY(${dy}px)`;
      } else node.style.transform = '';
      move.delta = delta;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      showSnap(null);
      if (!started) return;
      const delta = move.delta || 0;
      const p = store.project;
      for (const o of origin) { const x = clipById(p, o.id); x.start = o.start + delta; }
      if (target) {
        const x = clipById(p, c.id);
        const kind = x.type === 'audio' ? 'audio' : 'visual';
        if (target === 'newTop' || target === 'newBottom') {
          const idx = kind === 'visual' ? (target === 'newTop' ? 0 : p.tracks.findIndex((t) => t.main)) : p.tracks.length;
          x.trackId = addTrack(p, kind, idx).id;
        } else if (isFree(p, target, x.start, clipEnd(x), [x.id]) || trackById(p, target)?.main) x.trackId = target;
      } else if (ids.length === 1) {
        // Same-track move: if it would overlap on an overlay track, push to a free track.
        const x = clipById(p, c.id);
        const tr = trackById(p, x.trackId);
        if (!tr.main && !isFree(p, x.trackId, x.start, clipEnd(x), [x.id])) {
          const alt = p.tracks.find((t) => t.kind === tr.kind && !t.main && t.id !== tr.id && isFree(p, t.id, x.start, clipEnd(x), [x.id]));
          x.trackId = alt ? alt.id : addTrack(p, tr.kind, tr.kind === 'visual' ? p.tracks.indexOf(tr) : p.tracks.length).id;
        }
        if (tr.main && store.ui.magnet) {
          // Reorder: place before whichever clip's midpoint we passed.
          const others = clipsOn(p, tr.id).filter((o) => o.id !== x.id);
          const before = others.find((o) => x.start < o.start + o.duration / 2);
          x.start = before ? before.start - 0.0001 : 1e6;
        }
      }
      store.finish();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  function startTrim(e, c, edge, node) {
    e.stopPropagation();
    const x0 = e.clientX;
    const orig = { start: c.start, duration: c.duration, in: c.in };
    const pts = snapPoints([c.id]);
    const md = A.mediaDur(c);
    let started = false;
    const move = (ev) => {
      if (!started) { if (Math.abs(ev.clientX - x0) < 2) return; started = true; store.checkpoint('Trim'); }
      Object.assign(c, orig);
      const base = edge === 'start' ? orig.start : orig.start + orig.duration;
      const sn = snap(base + tOf(ev.clientX - x0), pts);
      showSnap(sn.line);
      trimClip(store.project, c, edge, sn.t, md);
      node.style.left = xOf(c.start) + 'px'; node.style.width = xOf(c.duration) + 'px';
      engine.requestDraw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      showSnap(null);
      if (started) store.finish();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // Drop from media bin
  scroller.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/x-frame-media')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    tracksEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    const r = rowAt(e.clientY);
    const node = r.track && typeof r.track === 'object' ? tracksEl.querySelector(`.track[data-id="${r.track.id}"]`) : tracksEl.querySelector('.new-track-zone');
    node?.classList.add('drop-target');
  });
  scroller.addEventListener('dragleave', () => tracksEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target')));
  scroller.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('text/x-frame-media');
    if (!id) return;
    e.preventDefault();
    tracksEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    const t = Math.max(0, timeAtClientX(e.clientX));
    const r = rowAt(e.clientY);
    const m = mediaMap.get(id);
    if (!m) return;
    const tr = r.track && typeof r.track === 'object' ? r.track : null;
    if (tr?.main || (!tr && m.type !== 'audio' && !store.project.clips.length)) A.addMediaClip(id, { start: t });
    else if (tr && tr.kind === (m.type === 'audio' ? 'audio' : 'visual')) A.addMediaClip(id, { start: t, trackId: tr.id });
    else A.addMediaClip(id, { start: t, overlay: m.type !== 'audio' });
  });

  // Wheel zoom / scroll sync
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const ax = e.clientX - scroller.getBoundingClientRect().left;
      setZoom(store.ui.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), ax);
    }
  }, { passive: false });
  scroller.addEventListener('scroll', () => { headsInner.style.top = (RULER_H + 8 - scroller.scrollTop) + 'px'; drawRuler(); });
  new ResizeObserver(() => drawRuler()).observe(scroller);

  store.on('project', (d) => { if (!d?.live) render(); });
  store.on('select', render);
  store.on('ui', render);
  store.on('time', (d) => {
    updatePlayhead();
    if (d?.playing) {
      const x = xOf(store.playhead);
      if (x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = x - 80;
      else if (x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 80);
    }
  });
  return { render, fit, setZoom };
}
