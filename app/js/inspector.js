// Right-hand inspector: properties of the selected clip, or project settings.
import { store, clipById, projectDuration, trackById, clipEnd } from './store.js';
import { mediaMap } from './media.js';
import { engine } from './engine.js';
import { h, iconBtn, fmtTime, fmtDur, toast } from './util.js';
import { icon } from './icons.js';
import { sliderRow, seg, toggle, colorRow, card } from './ui.js';
import { ASPECTS, LOOKS, ANIM_IN, ANIM_OUT, ANIM_LOOP, TRANSITIONS, FONTS, SPEEDS, DEFAULT_ADJUST, TEXT_STYLES, DEFAULT_TEXT } from './presets.js';
import * as A from './actions.js';
import { valAt, setAnimated, toggleKey, keyAt, hasKeys, keyTimes, CURVES } from './anim.js';
import { MASKS, DEFAULT_MASK, EFFECTS, bgState, loadSegmenter } from './fx.js';
import { VOICE_FX } from './audiofx.js';
import * as S from './smart.js';

const TABS_FOR = {
  video: ['basic', 'cutout', 'mask', 'adjust', 'animation', 'speed', 'audio'],
  image: ['basic', 'cutout', 'mask', 'adjust', 'animation'],
  text: ['text', 'basic', 'animation'],
  sticker: ['basic', 'animation'],
  shape: ['basic', 'mask', 'adjust', 'animation'],
  effect: ['effect'],
  color: ['basic', 'adjust', 'animation'],
  audio: ['audio', 'speed'],
};
const TAB_LABEL = { cutout: 'Cutout', mask: 'Mask', effect: 'Effect', basic: 'Basic', adjust: 'Adjust', animation: 'Animation', speed: 'Speed', audio: 'Audio', text: 'Text' };

export function createInspector(root) {
  const tabsEl = h('div.insp-tabs');
  const body = h('div.insp-body');
  root.append(tabsEl, body);
  let suppress = false;
  let lastSel = null;

  const edit = (label, fn, key) => {
    const id = store.selected?.id; if (!id) return;
    suppress = true;
    try { store.edit(label, (p) => fn(clipById(p, id), p), key ? key + id : null); } finally { suppress = false; }
  };
  const editP = (label, fn, key) => { suppress = true; try { store.edit(label, fn, key); } finally { suppress = false; } };

  function render() {
    const c = store.selected;
    tabsEl.innerHTML = ''; body.innerHTML = '';
    if (store.selection.length > 1) { tabsEl.append(h('button.on', `${store.selection.length} clips`)); body.append(multi()); return; }
    if (!c) { tabsEl.append(h('button.on', 'Project')); body.append(projectTab()); return; }
    const tabs = TABS_FOR[c.type] || ['basic'];
    if (lastSel !== c.id) { lastSel = c.id; if (!tabs.includes(store.ui.inspectorTab)) store.ui.inspectorTab = tabs[0]; }
    if (!tabs.includes(store.ui.inspectorTab)) store.ui.inspectorTab = tabs[0];
    for (const t of tabs) tabsEl.append(h('button' + (t === store.ui.inspectorTab ? '.on' : ''), { onclick: () => { store.ui.inspectorTab = t; render(); } }, TAB_LABEL[t]));
    const fn = { basic, adjust, animation, speed, audio, text, mask, cutout, effect }[store.ui.inspectorTab];
    body.append(fn(c));
  }

  // ---------- Project ----------
  function projectTab() {
    const p = store.project;
    return h('div',
      card('Project',
        h('div.row', h('label', 'Name'), h('input.input.grow', { value: p.name, onchange: (e) => editP('Rename', (pp) => { pp.name = e.target.value || 'Untitled'; }) })),
        h('div.row', h('label', 'Frame rate'), h('select.select.grow', { onchange: (e) => editP('FPS', (pp) => { pp.fps = +e.target.value; }) },
          [24, 25, 30, 50, 60].map((f) => h('option', { value: f, selected: p.fps === f }, `${f} fps`)))),
        h('div.small.muted', `Length ${fmtTime(projectDuration(p))} · ${p.clips.length} clips · ${p.width}×${p.height}`)),
      card('Canvas ratio',
        h('div.tile-grid.three', Object.entries(ASPECTS).map(([k, a]) => {
          const s = 30 / Math.max(a.w, a.h);
          return h('div.tile' + (p.aspect === k ? '.on' : ''), { onclick: () => A.setAspect(k) },
            h('div', { style: { width: a.w * s + 'px', height: a.h * s + 'px', border: '2px solid currentColor', borderRadius: '3px', opacity: 0.8 } }), h('span.label', k), h('span.small.muted', a.label));
        }))),
      card('Background',
        h('div.row', h('label', 'Fill'), seg([['color', 'Color'], ['blur', 'Blur']], p.background.mode, (v) => editP('Background', (pp) => { pp.background.mode = v; }))),
        colorRow('Color', p.background.color, (v) => editP('Background color', (pp) => { pp.background.color = v; }, 'bgc')),
        h('p.small.muted', { style: { margin: 0 } }, 'Blur fills empty space behind your video with a blurred copy - great for vertical videos.')),
      card('Shortcuts', h('div.small.muted', 'Space play · S split · Del delete · Ctrl+Z undo · Ctrl+D duplicate · ←/→ frame step · +/- zoom · ? all shortcuts')));
  }

  function multi() {
    const ids = [...store.selection];
    return h('div',
      card('Selection', h('p.small.muted', `${ids.length} clips selected.`),
        h('div', { style: { display: 'grid', gap: '8px' } },
          h('button.btn.block', { onclick: () => A.deleteSelected(false), html: icon('trash', 15) + ' Delete' }),
          h('button.btn.block', { onclick: () => A.duplicateSelected(), html: icon('copy', 15) + ' Duplicate' }),
          h('button.btn.block', { onclick: () => A.removeSilence(ids), html: icon('scissors', 15) + ' Remove silence' }))),
      card('Filter for all selected', h('select.select', { onchange: (e) => editP('Filter', (p) => ids.forEach((id) => { const c = clipById(p, id); if (c && c.type !== 'audio') c.look = e.target.value; })) },
        Object.entries(LOOKS).map(([k, l]) => h('option', { value: k }, l.name)))),
      card('Volume for all selected', sliderRow('Volume', 100, { min: 0, max: 200, def: 100, unit: '%', onInput: (v) => editP('Volume', (p) => ids.forEach((id) => { const c = clipById(p, id); if (c) c.volume = v / 100; }), 'mvol') })));
  }

  // ---------- Basic ----------
  function basic(c) {
    const local = Math.max(0, Math.min(c.duration, store.playhead - c.start));
    const tr = { ...c.transform, x: valAt(c, 'x', local), y: valAt(c, 'y', local), scale: valAt(c, 'scale', local), rotation: valAt(c, 'rotation', local), opacity: valAt(c, 'opacity', local) };
    const T = (label, key, val, opts, map) => {
      const row = sliderRow(label, val, { ...opts, onInput: (v) => { edit(label, (x) => setAnimated(x, key, map ? map(v) : v, store.playhead - x.start), 'tr' + key); } });
      row.classList.add('kf'); row.append(kfBtn(c, key)); return row;
    };
    const kids = [];
    const times = keyTimes(c);
    if (c.type !== 'color') {
      kids.push(card(h('span', 'Position & size', times.length ? h('span.kf-nav',
          iconBtn('skipBack', 'Previous keyframe', () => { const t = [...times].reverse().find((k) => c.start + k < store.playhead - 0.01); if (t != null) engine.seek(c.start + t); }),
          h('span.small', `${times.length} keyframe${times.length > 1 ? 's' : ''}`),
          iconBtn('skipFwd', 'Next keyframe', () => { const t = times.find((k) => c.start + k > store.playhead + 0.01); if (t != null) engine.seek(c.start + t); })) : null),
        h('p.small.muted.kf-hint', '◆ = keyframe. Add one, move the playhead, change a value - it animates.'),
        T('Position X', 'x', Math.round((tr.x - 0.5) * 200), { min: -150, max: 150, def: 0, unit: '%' }, (v) => 0.5 + v / 200),
        T('Position Y', 'y', Math.round((tr.y - 0.5) * 200), { min: -150, max: 150, def: 0, unit: '%' }, (v) => 0.5 + v / 200),
        T('Scale', 'scale', Math.round(tr.scale * 100), { min: 1, max: 500, def: 100, unit: '%' }, (v) => v / 100),
        T('Rotation', 'rotation', tr.rotation, { min: -180, max: 180, def: 0, unit: '°' }),
        T('Opacity', 'opacity', Math.round(tr.opacity * 100), { min: 0, max: 100, def: 100, unit: '%' }, (v) => v / 100),
        h('div.chips', { style: { marginTop: '6px' } },
          c.type === 'video' || c.type === 'image' ? h('button.chip', { onclick: () => fitFill(c, false) }, 'Fit') : null,
          c.type === 'video' || c.type === 'image' ? h('button.chip', { onclick: () => fitFill(c, true) }, 'Fill') : null,
          h('button.chip', { onclick: () => edit('Center', (x) => { x.transform.x = 0.5; x.transform.y = 0.5; }) }, 'Center'),
          h('button.chip', { onclick: () => edit('Flip', (x) => { x.transform.flipH = !x.transform.flipH; }), html: icon('flipH', 13) + ' Flip' }),
          h('button.chip', { onclick: () => edit('Flip', (x) => { x.transform.flipV = !x.transform.flipV; }), html: icon('flipV', 13) + ' Flip' }),
          h('button.chip', { onclick: () => edit('Rotate', (x) => { x.transform.rotation = ((Math.round(x.transform.rotation / 90) * 90 + 90 + 180) % 360) - 180; }), html: icon('reset', 13) + ' 90°' }),
          h('button.chip', { onclick: () => edit('Reset transform', (x) => { x.transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false }; delete x.kf; }) }, 'Reset')),
        c.type === 'video' || c.type === 'image' ? h('div.chips', { style: { marginTop: '8px' } }, h('span.small.muted', { style: { alignSelf: 'center' } }, 'Picture-in-picture:'),
          [['↖', 0.2, 0.2], ['↗', 0.8, 0.2], ['↙', 0.2, 0.8], ['↘', 0.8, 0.8], ['Left half', 0.25, 0.5], ['Right half', 0.75, 0.5]].map(([l, x, y]) => h('button.chip', { onclick: () => edit('Layout', (cc) => { cc.transform.x = x; cc.transform.y = y; cc.transform.scale = l.includes('half') ? 0.5 : 0.35; delete cc.kf; }) }, l))) : null,
        c.type === 'video' || c.type === 'image' ? h('div.chips', { style: { marginTop: '8px' } }, h('span.small.muted', { style: { alignSelf: 'center' } }, 'Motion:'),
          [['Zoom in', 'scale', 1, 1.3], ['Zoom out', 'scale', 1.3, 1], ['Pan →', 'x', 0.45, 0.55], ['Pan ←', 'x', 0.55, 0.45]].map(([l, prop, a, b]) => h('button.chip', { onclick: () => edit('Motion', (cc) => {
            cc.kf = cc.kf || {}; const base = prop === 'scale' ? 1 : 1; cc.kf[prop] = [{ t: 0, v: a, e: 'ease' }, { t: cc.duration, v: b, e: 'ease' }];
            if (prop === 'x' && !cc.kf.scale) cc.kf.scale = [{ t: 0, v: 1.15 * base, e: 'ease' }, { t: cc.duration, v: 1.15, e: 'ease' }];
          }) }, l)), h('button.chip', { onclick: () => edit('Remove motion', (cc) => { delete cc.kf; }) }, 'None')) : null,
        c.type === 'text' || c.type === 'sticker' || c.type === 'shape' ? h('div.chips', { style: { marginTop: '8px' } }, h('span.small.muted', { style: { alignSelf: 'center' } }, 'Place:'),
          [['Top', 0.15], ['Middle', 0.5], ['Bottom', 0.85]].map(([l, y]) => h('button.chip', { onclick: () => edit('Place', (x) => { x.transform.y = y; x.transform.x = 0.5; }) }, l))) : null));
    }
    if (c.type === 'video' || c.type === 'image') {
      const C = (label, key) => sliderRow(label, Math.round(c.crop[key] * 100), { min: 0, max: 45, def: 0, unit: '%', onInput: (v) => edit('Crop', (x) => { x.crop[key] = v / 100; }, 'crop' + key) });
      kids.push(card('Crop & mask', C('Left', 'l'), C('Right', 'r'), C('Top', 't'), C('Bottom', 'b'),
        sliderRow('Round corners', c.radius, { min: 0, max: 100, def: 0, unit: '%', onInput: (v) => edit('Corners', (x) => { x.radius = v; }, 'rad') })));
    }
    if (c.type === 'shape') kids.push(card('Shape', colorRow('Color', c.fill.color, (v) => edit('Shape color', (x) => { x.fill.color = v; }, 'fill'))));
    if (c.type === 'color') kids.push(card('Background',
      colorRow(c.fill.gradient ? 'Color 1' : 'Color', c.fill.gradient ? c.fill.gradient[0] : c.fill.color, (v) => edit('Color', (x) => { if (x.fill.gradient) x.fill.gradient[0] = v; else x.fill.color = v; }, 'fill1')),
      c.fill.gradient ? colorRow('Color 2', c.fill.gradient[1], (v) => edit('Color', (x) => { x.fill.gradient[1] = v; }, 'fill2')) : null,
      h('div.row', h('label', 'Gradient'), toggle(!!c.fill.gradient, (on) => edit('Gradient', (x) => { x.fill.gradient = on ? [x.fill.color || '#7f00ff', '#22d3ee'] : null; if (!on) x.fill.color = x.fill.color || '#000000'; render(); })))));
    if (c.type === 'sticker') kids.push(card('Sticker', h('input.input', { value: c.sticker, maxLength: 8, onchange: (e) => edit('Sticker', (x) => { x.sticker = e.target.value || '⭐'; }) }), h('p.small.muted', 'Type or paste any emoji.')));
    if (c.type !== 'audio') kids.push(card('Blend',
      h('select.select', { onchange: (e) => edit('Blend', (x) => { x.blend = e.target.value; }) },
        [['source-over', 'Normal'], ['screen', 'Screen'], ['multiply', 'Multiply'], ['overlay', 'Overlay'], ['lighten', 'Lighten'], ['darken', 'Darken'], ['color-dodge', 'Color dodge'], ['difference', 'Difference'], ['soft-light', 'Soft light'], ['hard-light', 'Hard light']]
          .map(([v, l]) => h('option', { value: v, selected: c.blend === v }, l)))));
    kids.push(clipInfo(c));
    return h('div', kids);
  }

  function fitFill(c, fill) {
    const m = mediaMap.get(c.mediaId); if (!m) return;
    const p = store.project;
    const mw = m.width * (1 - c.crop.l - c.crop.r), mh = m.height * (1 - c.crop.t - c.crop.b);
    const contain = Math.min(p.width / mw, p.height / mh), cover = Math.max(p.width / mw, p.height / mh);
    edit(fill ? 'Fill' : 'Fit', (x) => { x.transform.scale = fill ? cover / contain : 1; x.transform.x = 0.5; x.transform.y = 0.5; x.transform.rotation = 0; });
  }

  function clipInfo(c) {
    const m = c.mediaId ? mediaMap.get(c.mediaId) : null;
    const fixedLen = c.type === 'image' || c.type === 'text' || c.type === 'sticker' || c.type === 'shape' || c.type === 'color';
    return card('Clip',
      h('div.small.muted', `${m ? m.name + ' · ' : ''}starts ${fmtTime(c.start, store.project.fps, true)} · ${fmtDur(c.duration)}`),
      fixedLen ? h('div.row', { style: { marginTop: '8px' } }, h('label', 'Duration (s)'), h('input.input.grow', { type: 'number', min: 0.1, step: 0.1, value: Math.round(c.duration * 100) / 100, onchange: (e) => edit('Duration', (x) => { x.duration = Math.max(0.1, +e.target.value || 1); }) })) : null,
      h('div.chips', { style: { marginTop: '8px' } },
        h('button.chip', { onclick: () => A.splitAt(), html: icon('split', 13) + ' Split' }),
        h('button.chip', { onclick: () => A.duplicateSelected(), html: icon('copy', 13) + ' Duplicate' }),
        h('button.chip', { onclick: () => A.deleteSelected(), html: icon('trash', 13) + ' Delete' })));
  }

  // ---------- Adjust ----------
  function adjust(c) {
    const a = c.adjust;
    const S = (label, key, min, max, step = 1) => sliderRow(label, a[key], { min, max, step, def: 0, onInput: (v) => edit('Adjust ' + label, (x) => { x.adjust[key] = v; }, 'adj' + key) });
    return h('div',
      card('Filter',
        h('select.select', { onchange: (e) => edit('Filter', (x) => { x.look = e.target.value; render(); }) }, Object.entries(LOOKS).map(([k, l]) => h('option', { value: k, selected: c.look === k }, l.name))),
        c.look !== 'none' ? h('div', { style: { marginTop: '10px' } }, sliderRow('Strength', Math.round((c.lookAmount ?? 1) * 100), { min: 0, max: 100, def: 100, unit: '%', onInput: (v) => edit('Filter strength', (x) => { x.lookAmount = v / 100; }, 'lookamt') })) : null),
      card('Light', S('Brightness', 'brightness', -100, 100), S('Contrast', 'contrast', -100, 100)),
      card('Color', S('Saturation', 'saturation', -100, 100), S('Temperature', 'temperature', -100, 100), S('Tint', 'tint', -100, 100), S('Hue', 'hue', -180, 180)),
      card('Effects', S('Blur', 'blur', 0, 10, 0.1), S('Vignette', 'vignette', 0, 100), S('Grayscale', 'grayscale', 0, 100), S('Sepia', 'sepia', 0, 100), S('Invert', 'invert', 0, 100)),
      h('button.btn.block', { onclick: () => edit('Reset adjustments', (x) => { x.adjust = { ...DEFAULT_ADJUST }; x.look = 'none'; render(); }), html: icon('reset', 15) + ' Reset all' }));
  }

  // ---------- Animation ----------
  function animation(c) {
    const chips = (map, cur, fn) => h('div.chips', Object.entries(map).map(([k, l]) => h('button.chip' + (cur === k ? '.on' : ''), { onclick: () => { fn(k); render(); preview(c, k); } }, l)));
    const preview = (cc, k) => { if (k !== 'none') engine.seek(Math.max(cc.start, store.playhead > cc.start && store.playhead < clipEnd(cc) ? cc.start : cc.start)); };
    const inMap = c.type === 'text' ? ANIM_IN : Object.fromEntries(Object.entries(ANIM_IN).filter(([k]) => k !== 'typewriter'));
    return h('div',
      card('In', chips(inMap, c.anim.in, (k) => edit('Animation in', (x) => { x.anim.in = k; })),
        c.anim.in !== 'none' ? h('div', { style: { marginTop: '10px' } }, sliderRow('Duration', c.anim.inDur, { min: 0.1, max: Math.min(5, c.duration), step: 0.1, def: 0.5, unit: 's', onInput: (v) => edit('Anim duration', (x) => { x.anim.inDur = v; }, 'ain') })) : null),
      card('Out', chips(ANIM_OUT, c.anim.out, (k) => edit('Animation out', (x) => { x.anim.out = k; })),
        c.anim.out !== 'none' ? h('div', { style: { marginTop: '10px' } }, sliderRow('Duration', c.anim.outDur, { min: 0.1, max: Math.min(5, c.duration), step: 0.1, def: 0.5, unit: 's', onInput: (v) => edit('Anim duration', (x) => { x.anim.outDur = v; }, 'aout') })) : null),
      card('Loop', chips(ANIM_LOOP, c.anim.loop, (k) => edit('Loop animation', (x) => { x.anim.loop = k; })),
        c.anim.loop !== 'none' ? h('div', { style: { marginTop: '10px' } }, sliderRow('Speed', c.anim.loopSpeed, { min: 0.2, max: 4, step: 0.1, def: 1, unit: 'x', onInput: (v) => edit('Loop speed', (x) => { x.anim.loopSpeed = v; }, 'aloop') })) : null),
      card('Transition into this clip', h('select.select', { onchange: (e) => edit('Transition', (x) => { x.transition.type = e.target.value; render(); }) },
        Object.entries(TRANSITIONS).map(([k, l]) => h('option', { value: k, selected: c.transition.type === k }, l))),
        c.transition.type !== 'none' ? h('div', { style: { marginTop: '10px' } }, sliderRow('Duration', c.transition.dur, { min: 0.1, max: 3, step: 0.1, def: 0.5, unit: 's', onInput: (v) => edit('Transition length', (x) => { x.transition.dur = v; }, 'trd') })) : null));
  }

  // ---------- Keyframe button ----------
  function kfBtn(c, prop) {
    const local = store.playhead - c.start;
    const on = !!keyAt(c, prop, local), has = hasKeys(c, prop);
    return h('button.kf-btn' + (on ? '.on' : '') + (has ? '.has' : ''), { title: on ? 'Remove keyframe' : 'Add keyframe at playhead', html: '◆', onclick: () => {
      if (store.playhead < c.start || store.playhead > clipEnd(c)) { toast('Move the playhead over this clip first'); return; }
      edit('Keyframe', (x) => toggleKey(x, prop, store.playhead - x.start)); render();
    } });
  }

  // ---------- Mask ----------
  function mask(c) {
    const m = { ...DEFAULT_MASK, ...(c.mask || {}) };
    const M = (label, key, val, opts, map) => sliderRow(label, val, { ...opts, onInput: (v) => edit('Mask', (x) => { x.mask = { ...DEFAULT_MASK, ...(x.mask || {}) }; x.mask[key] = map ? map(v) : v; }, 'mask' + key) });
    const shapes = { none: '⦸', linear: '◧', mirror: '▤', circle: '◯', rect: '▢', heart: '♡', star: '☆' };
    return h('div',
      card('Mask shape', h('div.tile-grid.four', Object.entries(MASKS).map(([k, l]) => h('div.tile' + (m.type === k ? '.on' : ''), { onclick: () => { edit('Mask', (x) => { x.mask = { ...DEFAULT_MASK, ...(x.mask || {}), type: k }; }); render(); } }, h('span.mask-ic', shapes[k]), h('span.label', l))))),
      m.type !== 'none' ? card('Adjust mask',
        M('Position X', 'x', Math.round(m.x * 100), { min: -100, max: 100, def: 0, unit: '%' }, (v) => v / 100),
        M('Position Y', 'y', Math.round(m.y * 100), { min: -100, max: 100, def: 0, unit: '%' }, (v) => v / 100),
        m.type !== 'linear' ? M(m.type === 'mirror' ? 'Band size' : 'Width', m.type === 'mirror' ? 'h' : 'w', Math.round((m.type === 'mirror' ? m.h : m.w) * 100), { min: 2, max: 200, def: 60, unit: '%' }, (v) => v / 100) : null,
        m.type === 'circle' || m.type === 'rect' ? M('Height', 'h', Math.round(m.h * 100), { min: 2, max: 200, def: 60, unit: '%' }, (v) => v / 100) : null,
        M('Rotation', 'rot', m.rot, { min: -180, max: 180, def: 0, unit: '°' }),
        M('Feather', 'feather', Math.round(m.feather * 100), { min: 0, max: 100, def: 10, unit: '%' }, (v) => v / 100),
        m.type === 'rect' ? M('Round', 'round', Math.round((m.round || 0) * 100), { min: 0, max: 100, def: 0, unit: '%' }, (v) => v / 100) : null,
        h('div.row', h('label', 'Invert'), toggle(m.invert, (on) => edit('Mask invert', (x) => { x.mask.invert = on; })))) : null);
  }

  // ---------- Cutout: AI background removal + chroma key ----------
  function cutout(c) {
    const ck = { on: false, color: '#00ff00', tol: 30, soft: 15, spill: 50, ...(c.chroma || {}) };
    const C = (label, key, val) => sliderRow(label, val, { min: 0, max: 100, def: { tol: 30, soft: 15, spill: 50 }[key], onInput: (v) => edit('Chroma', (x) => { x.chroma = { ...ck, ...(x.chroma || {}), [key]: v }; }, 'ck' + key) });
    const bgStatus = h('div.small.muted', bgState.loading ? 'Loading the AI model (first time only)…' : bgState.error ? '✗ ' + bgState.error : bgState.ready ? '✓ AI model ready' : 'Runs on your computer - nothing is uploaded.');
    bgState.onReady = () => { engine.requestDraw(); if (store.selected?.id === c.id) render(); };
    return h('div',
      card('Remove background (AI)',
        h('div.row', h('label', 'Auto cutout'), toggle(!!c.bgRemove, (on) => { edit('Remove background', (x) => { x.bgRemove = on; }); if (on) { loadSegmenter(); setTimeout(render, 50); } })),
        h('p.small.muted', { style: { margin: '0 0 6px' } }, 'Removes the background behind people, like a green screen without the green.'),
        bgStatus),
      card('Chroma key (green screen)',
        h('div.row', h('label', 'Enable'), toggle(ck.on, (on) => { edit('Chroma key', (x) => { x.chroma = { ...ck, on }; }); render(); })),
        ck.on ? h('div',
          h('div.row', h('label', 'Key color'), h('input', { type: 'color', value: ck.color, oninput: (e) => edit('Chroma color', (x) => { x.chroma.color = e.target.value; }, 'ckc') }),
            window.EyeDropper ? h('button.btn.sm', { html: icon('eye', 13) + ' Pick', onclick: async () => { try { const r = await new window.EyeDropper().open(); edit('Chroma color', (x) => { x.chroma.color = r.sRGBHex; }); render(); } catch {} } }) : null,
            h('div.swatches', ['#00ff00', '#00b140', '#0047bb', '#ffffff'].map((col) => h('div.swatch', { style: { background: col }, title: col, onclick: () => { edit('Chroma color', (x) => { x.chroma.color = col; }); render(); } })))),
          C('Strength', 'tol', ck.tol), C('Softness', 'soft', ck.soft), C('Spill fix', 'spill', ck.spill)) : null));
  }

  // ---------- Effect clip ----------
  function effect(c) {
    return h('div',
      card('Effect', h('div.tile-grid.three', Object.entries(EFFECTS).map(([k, e]) => h('div.tile' + (c.effect === k ? '.on' : ''), { onclick: () => { edit('Effect', (x) => { x.effect = k; x.name = k; }); render(); } }, h('span.label', e.name))))),
      card('Settings', sliderRow('Intensity', Math.round((c.intensity ?? 1) * 100), { min: 0, max: 200, def: 100, unit: '%', onInput: (v) => edit('Intensity', (x) => { x.intensity = v / 100; }, 'int') })),
      clipInfo(c));
  }

  // ---------- Speed ----------
  function speed(c) {
    return h('div',
      card('Speed',
        h('div.chips', SPEEDS.map((s) => h('button.chip' + (Math.abs(c.speed - s) < 0.001 ? '.on' : ''), { onclick: () => { suppress = true; A.setClipSpeed(c.id, s); suppress = false; render(); } }, s + 'x'))),
        h('div', { style: { marginTop: '12px' } }, sliderRow('Custom', c.speed, { min: 0.1, max: 10, step: 0.05, def: 1, unit: 'x', onInput: (v) => { suppress = true; A.setClipSpeed(c.id, v); suppress = false; } })),
        h('p.small.muted', `Source ${fmtDur(c.duration * c.speed)} → plays in ${fmtDur(c.duration)}.`)),
      card('Speed curve', h('div.tile-grid.three', [['none', 'None'], ...Object.entries(CURVES).map(([k, v]) => [k, v.name])].map(([k, l]) =>
        h('div.tile' + ((c.curve || 'none') === k ? '.on' : ''), { onclick: () => { edit('Speed curve', (x) => { x.curve = k === 'none' ? null : k; }); render(); } }, h('span.label', l)))),
        h('p.small.muted', 'Speed ramps: slow-motion and fast-forward within one clip.')),
      card('Reverse', h('div.row', h('label', 'Play backwards'), toggle(!!c.reverse, (on) => edit('Reverse', (x) => { x.reverse = on; })))));
  }

  // ---------- Audio ----------
  function audio(c) {
    const m = mediaMap.get(c.mediaId);
    if (c.type === 'video' && m?.hasAudio === false) return h('div', card('Audio', h('p.small.muted', 'This video has no sound track.')));
    let thr = -38;
    return h('div',
      card('Volume',
        (() => { const row = sliderRow('Volume', Math.round(valAt(c, 'volume', store.playhead - c.start) * 100), { min: 0, max: 200, def: 100, unit: '%', onInput: (v) => edit('Volume', (x) => setAnimated(x, 'volume', v / 100, store.playhead - x.start), 'vol') }); row.classList.add('kf'); row.append(kfBtn(c, 'volume')); return row; })(),
        h('div.row', h('label', 'Mute clip'), toggle(c.muted, (on) => edit('Mute', (x) => { x.muted = on; })))),
      card('Voice effects', h('div.chips', Object.entries(VOICE_FX).map(([k, l]) => h('button.chip' + ((c.voiceFx || 'none') === k ? '.on' : ''), { onclick: () => { edit('Voice effect', (x) => { x.voiceFx = k; }); render(); } }, l)))),
      card('AI audio',
        h('div', { style: { display: 'grid', gap: '8px' } },
          h('button.btn.block', { onclick: () => S.autoCaptions([c.id]), html: icon('captions', 15) + ' Auto captions for this clip' }),
          c.type === 'audio' ? h('button.btn.block', { onclick: () => S.markBeats(c.id), html: icon('music', 15) + ' Detect beats' }) : null,
          h('button.btn.block', { onclick: () => S.autoDuck(), html: icon('volume', 15) + ' Auto-duck music under speech' }))),
      card('Fades',
        sliderRow('Fade in', c.fadeIn, { min: 0, max: Math.min(10, c.duration), step: 0.1, def: 0, unit: 's', onInput: (v) => edit('Fade in', (x) => { x.fadeIn = v; }, 'fin') }),
        sliderRow('Fade out', c.fadeOut, { min: 0, max: Math.min(10, c.duration), step: 0.1, def: 0, unit: 's', onInput: (v) => edit('Fade out', (x) => { x.fadeOut = v; }, 'fout') })),
      card('Smart tools',
        sliderRow('Silence level', thr, { min: -60, max: -20, def: -38, unit: 'dB', onInput: (v) => { thr = v; } }),
        h('button.btn.block', { onclick: () => A.removeSilence([c.id], { thresholdDb: thr }), html: icon('scissors', 15) + ' Remove silent parts' }),
        c.type === 'video' ? h('button.btn.block', { style: { marginTop: '8px' }, onclick: () => A.detachAudio(c.id), html: icon('audioDetach', 15) + ' Extract audio' }) : null));
  }

  // ---------- Text ----------
  function text(c) {
    const t = c.text;
    const E = (label, fn, key) => edit(label, (x) => { fn(x.text); if (label === 'Text') x.name = x.text.content.slice(0, 30); }, key);
    const ta = h('textarea.input', { value: t.content, rows: 3, oninput: () => E('Text', (x) => { x.content = ta.value; }, 'txt') });
    const fontSel = h('select.select.grow', { onchange: () => E('Font', (x) => { x.font = fontSel.value; }) },
      FONTS.map((f) => h('option', { value: f, selected: t.font === f, style: { fontFamily: `"${f}"` } }, f)));
    return h('div',
      card(null, ta, h('div.chips', { style: { marginTop: '8px' } }, TEXT_STYLES.slice(0, 8).map((st) => h('button.chip', { onclick: () => { E('Text style', (x) => Object.assign(x, { ...DEFAULT_TEXT, ...st.t, content: x.content })); render(); } }, st.name))),
        h('button.btn.block', { style: { marginTop: '10px' }, onclick: () => S.voiceoverDialog(c.text.content), html: icon('mic', 15) + ' Read aloud with AI voice' })),
      card('Font',
        h('div.row', fontSel),
        sliderRow('Size', t.size, { min: 10, max: 400, def: 96, onInput: (v) => E('Size', (x) => { x.size = v; }, 'size') }),
        colorRow('Color', t.color, (v) => E('Color', (x) => { x.color = v; }, 'tcol')),
        h('div.row', h('label', 'Style'),
          seg([['b', '<b>B</b>'], ['n', 'Regular']], t.bold ? 'b' : 'n', (v) => E('Bold', (x) => { x.bold = v === 'b'; })),
          h('button.chip' + (t.italic ? '.on' : ''), { onclick: (e) => { E('Italic', (x) => { x.italic = !x.italic; }); e.target.classList.toggle('on'); } }, h('i', 'Italic')),
          h('button.chip' + (t.uppercase ? '.on' : ''), { onclick: (e) => { E('Caps', (x) => { x.uppercase = !x.uppercase; }); e.target.classList.toggle('on'); } }, 'AA')),
        h('div.row', h('label', 'Align'), seg([['left', 'Left'], ['center', 'Center'], ['right', 'Right']], t.align, (v) => E('Align', (x) => { x.align = v; }))),
        sliderRow('Spacing', t.letterSpacing, { min: -10, max: 40, def: 0, onInput: (v) => E('Spacing', (x) => { x.letterSpacing = v; }, 'ls') }),
        sliderRow('Line height', t.lineHeight, { min: 0.7, max: 2.5, step: 0.05, def: 1.15, onInput: (v) => E('Line height', (x) => { x.lineHeight = v; }, 'lh') })),
      card('Outline & glow',
        sliderRow('Outline', t.strokeWidth, { min: 0, max: 30, def: 0, onInput: (v) => E('Outline', (x) => { x.strokeWidth = v; }, 'sw') }),
        colorRow('Outline color', t.strokeColor, (v) => E('Outline color', (x) => { x.strokeColor = v; }, 'sc')),
        sliderRow('Shadow', Math.round(t.shadow * 100), { min: 0, max: 100, def: 35, unit: '%', onInput: (v) => E('Shadow', (x) => { x.shadow = v / 100; }, 'sh') }),
        sliderRow('Glow', Math.round(t.glow * 100), { min: 0, max: 200, def: 0, unit: '%', onInput: (v) => E('Glow', (x) => { x.glow = v / 100; }, 'gl') })),
      card('Background box',
        h('div.row', h('label', 'Show box'), toggle(t.bg, (on) => { E('Text box', (x) => { x.bg = on; }); })),
        colorRow('Box color', t.bgColor, (v) => E('Box color', (x) => { x.bgColor = v; }, 'bgc')),
        sliderRow('Box opacity', Math.round(t.bgOpacity * 100), { min: 0, max: 100, def: 60, unit: '%', onInput: (v) => E('Box opacity', (x) => { x.bgOpacity = v / 100; }, 'bgo') })),
      clipInfo(c));
  }

  store.on('focusText', () => { store.ui.inspectorTab = 'text'; render(); const ta = body.querySelector('textarea'); if (ta) { ta.focus(); ta.select(); } });
  store.on('time', (d) => { if (!d?.playing && store.selected?.kf && ['basic', 'audio'].includes(store.ui.inspectorTab) && !document.activeElement?.closest?.('.inspector')) render(); });
  store.on('select', render);
  store.on('project', () => { if (!suppress) render(); });
  store.on('transform', () => { if (store.ui.inspectorTab === 'basic' && !document.activeElement?.closest?.('.inspector')) render(); });
  render();
  return { render };
}
