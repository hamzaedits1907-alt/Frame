// Preview stage: canvas, direct manipulation (move / scale / rotate) and transport controls.
import { store, projectDuration, clipEnd, trackById } from './store.js';
import { engine, getAnalyser } from './engine.js';
import { boxOf, transformAt } from './renderer.js';
import { setAnimated } from './anim.js';
import { h, iconBtn, fmtTime } from './util.js';
import { icon } from './icons.js';
import { ASPECTS } from './presets.js';
import * as A from './actions.js';

export function createPreview(root) {
  const canvas = h('canvas');
  const overlay = h('div.overlay');
  const emptyMsg = h('div.stage-empty', h('div', h('div', { html: icon('media', 40), style: { display: 'grid', placeItems: 'center', marginBottom: '10px', opacity: 0.6 } }), h('div', { style: { fontSize: '15px', fontWeight: 600, color: '#c7cad4' } }, 'Drop videos, photos or music anywhere'), h('div.small', { style: { marginTop: '4px' } }, 'or use the Import button on the left')));
  const stage = h('div.stage', canvas, overlay, emptyMsg);
  const timeEl = h('div.time');
  const playBtn = h('button.play-btn', { title: 'Play / Pause (Space)', onclick: () => engine.toggle() });
  const loopBtn = iconBtn('reset', 'Loop playback (L)', () => store.setUI({ loop: !store.ui.loop }));
  const meterL = h('i');
  const aspectSel = h('select.select', { style: { width: '150px', height: '30px' }, title: 'Canvas ratio', onchange: () => A.setAspect(aspectSel.value) },
    Object.entries(ASPECTS).map(([k, a]) => h('option', { value: k }, `${k}  ${a.label}`)));
  const fps = () => store.project.fps;
  const transport = h('div.transport',
    timeEl,
    h('div.center-controls',
      iconBtn('skipBack', 'Go to start (Home)', () => engine.seek(0)),
      iconBtn('undo', 'Previous frame (←)', () => engine.seek(store.playhead - 1 / fps()), { attrs: {} }),
      playBtn,
      iconBtn('redo', 'Next frame (→)', () => engine.seek(store.playhead + 1 / fps())),
      iconBtn('skipFwd', 'Go to end (End)', () => engine.seek(projectDuration(store.project))),
    ),
    loopBtn,
    h('div.meter', { title: 'Audio level' }, meterL),
    aspectSel,
    iconBtn('fullscreen', 'Fullscreen preview (F)', () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen())),
  );
  root.append(stage, transport);
  engine.attach(canvas);

  const ro = new ResizeObserver(() => layout());
  ro.observe(stage);
  function layout() { engine.resize(stage.clientWidth - 32, stage.clientHeight - 32); updateBox(); }

  function updateTime() {
    const d = projectDuration(store.project);
    timeEl.innerHTML = `${fmtTime(store.playhead, fps(), true)} <span>/ ${fmtTime(d, fps(), true)}</span>`;
  }
  function updatePlay() { playBtn.innerHTML = icon(store.playing ? 'pause' : 'play', 16); }

  // ---------- Selection box ----------
  let box = null, guides = [];
  function canvasOffset() {
    const sr = stage.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    return { x: cr.left - sr.left, y: cr.top - sr.top, w: cr.width, h: cr.height };
  }
  function selectedVisual() {
    const c = store.selected;
    if (!c || c.type === 'audio' || c.type === 'color' || c.type === 'effect') return null;
    if (store.playhead < c.start || store.playhead >= clipEnd(c)) return null;
    if (trackById(store.project, c.trackId)?.hidden) return null;
    return c;
  }
  function updateBox() {
    const c = selectedVisual();
    if (!c || store.playing) { box?.remove(); box = null; return; }
    const o = canvasOffset();
    const b = boxOf(c, o.w, o.h, store.playhead);
    if (!box) {
      box = h('div.sel-box', h('div.hd.nw'), h('div.hd.ne'), h('div.hd.sw'), h('div.hd.se'), h('div.hd.rot'));
      box.addEventListener('pointerdown', onBoxDown);
      box.addEventListener('dblclick', () => { if (store.selected?.type === 'text') store.emit('focusText'); });
      overlay.append(box);
    }
    Object.assign(box.style, { left: o.x + b.cx - b.w / 2 + 'px', top: o.y + b.cy - b.h / 2 + 'px', width: b.w + 'px', height: b.h + 'px', transform: `rotate(${b.rot}rad)` });
  }
  function showGuides(v, hz) {
    guides.forEach((g) => g.remove()); guides = [];
    const o = canvasOffset();
    if (v) { const g = h('div.guide.v', { style: { left: o.x + o.w / 2 + 'px' } }); overlay.append(g); guides.push(g); }
    if (hz) { const g = h('div.guide.h', { style: { top: o.y + o.h / 2 + 'px' } }); overlay.append(g); guides.push(g); }
  }

  function onBoxDown(e) {
    e.preventDefault(); e.stopPropagation();
    const c = store.selected; if (!c) return;
    const hd = e.target.closest('.hd');
    const mode = !hd ? 'move' : hd.classList.contains('rot') ? 'rotate' : 'scale';
    drag(e, c, mode);
  }

  function drag(e, c, mode) {
    const o = canvasOffset();
    const sr = stage.getBoundingClientRect();
    const t0 = { ...transformAt(c, store.playhead) };
    const local = store.playhead - c.start;
    const set = (k, v) => setAnimated(c, k, v, local);
    const cx = sr.left + o.x + t0.x * o.w, cy = sr.top + o.y + t0.y * o.h;
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    let started = false;
    const move = (ev) => {
      if (!started) { if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 2) return; started = true; store.checkpoint(mode === 'move' ? 'Move' : mode === 'scale' ? 'Scale' : 'Rotate'); }
      if (mode === 'move') {
        let x = t0.x + (ev.clientX - e.clientX) / o.w, y = t0.y + (ev.clientY - e.clientY) / o.h;
        const sv = Math.abs(x - 0.5) * o.w < 6, sh = Math.abs(y - 0.5) * o.h < 6;
        if (sv && !ev.altKey) x = 0.5; if (sh && !ev.altKey) y = 0.5;
        showGuides(sv && !ev.altKey, sh && !ev.altKey);
        set('x', x); set('y', y);
      } else if (mode === 'scale') {
        const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
        set('scale', Math.max(0.02, Math.min(20, t0.scale * (d / d0))));
      } else {
        let a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
        if (a > 180) a -= 360;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        else for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(a - snap) < 3) a = snap;
        set('rotation', Math.round(a * 10) / 10);
      }
      engine.requestDraw(); updateBox();
      store.emit('transform');
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      showGuides(false, false);
      if (started) store.finish();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // Click on canvas to select the top-most clip under the cursor.
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sel-box') || store.playing) return;
    const o = canvasOffset();
    const sr = stage.getBoundingClientRect();
    const px = e.clientX - sr.left - o.x, py = e.clientY - sr.top - o.y;
    const items = [...engine.lastItems].reverse();
    for (const it of items) {
      const c = it.clip;
      if ((c.type === 'color' && items.length > 1) || c.type === 'effect') continue;
      if (trackById(store.project, c.trackId)?.locked) continue;
      const b = boxOf(c, o.w, o.h, store.playhead);
      const dx = px - b.cx, dy = py - b.cy;
      const lx = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), ly = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) {
        store.select(c.id);
        if (c.type !== 'color') drag(e, c, 'move');
        return;
      }
    }
    store.select([]);
  });
  stage.addEventListener('dblclick', () => { if (store.selected?.type === 'text') store.emit('focusText'); });

  // Audio meter
  let level = 0;
  (function meter() {
    const an = getAnalyser();
    if (an && store.playing) {
      const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
      level = Math.max(pk, level * 0.9);
    } else level *= 0.85;
    meterL.style.height = Math.min(100, level * 100) + '%';
    requestAnimationFrame(meter);
  })();

  store.on('project', () => { updateTime(); updateBox(); aspectSel.value = store.project.aspect; emptyMsg.classList.toggle('hidden', store.project.clips.length > 0); });
  store.on('resize', layout);
  store.on('select', updateBox);
  store.on('time', () => { updateTime(); updateBox(); });
  store.on('play', () => { updatePlay(); updateBox(); });
  store.on('ui', () => loopBtn.classList.toggle('on', store.ui.loop));
  updatePlay();
  return { layout };
}
