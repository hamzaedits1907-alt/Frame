// Project model, editing operations and undo/redo store.
import { uid, deepClone, clamp, round } from './util.js';
import { ASPECTS, DEFAULT_ADJUST, DEFAULT_TEXT } from './presets.js';
import { sliceKeys } from './anim.js';

export const MIN_DUR = 0.1;

export function newProject(name = 'Untitled project', aspect = '16:9') {
  const a = ASPECTS[aspect] || ASPECTS['16:9'];
  return {
    id: uid('p_'), name, created: Date.now(), updated: Date.now(),
    aspect, width: a.w, height: a.h, fps: 30,
    background: { mode: 'color', color: '#000000' },
    tracks: [{ id: uid('t_'), kind: 'visual', main: true, name: 'Main', muted: false, hidden: false, locked: false }],
    clips: [], markers: [], media: [], thumb: null,
  };
}

export function newClip(type, extra = {}) {
  const c = {
    id: uid('c_'), trackId: null, type, name: extra.name || type,
    start: 0, duration: 5, in: 0, speed: 1,
    volume: 1, fadeIn: 0, fadeOut: 0, muted: false,
    transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false },
    crop: { l: 0, r: 0, t: 0, b: 0 }, radius: 0, blend: 'source-over',
    look: 'none', lookAmount: 1, adjust: { ...DEFAULT_ADJUST },
    anim: { in: 'none', inDur: 0.5, out: 'none', outDur: 0.5, loop: 'none', loopSpeed: 1 },
    transition: { type: 'none', dur: 0.5 },
  };
  if (type === 'text') c.text = { ...DEFAULT_TEXT };
  if (type === 'text' || type === 'sticker' || type === 'shape') c.transform.y = 0.5;
  return Object.assign(c, extra, { transform: { ...c.transform, ...(extra.transform || {}) } });
}

export const clipEnd = (c) => c.start + c.duration;
export const isVisual = (c) => c.type !== 'audio';
export const hasOwnAudio = (c, media) => (c.type === 'video' && media?.hasAudio !== false) || c.type === 'audio';

export function projectDuration(p) {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, clipEnd(c));
  return d;
}
export const trackById = (p, id) => p.tracks.find((t) => t.id === id);
export const clipById = (p, id) => p.clips.find((c) => c.id === id);
export const mainTrack = (p) => p.tracks.find((t) => t.main);
export const clipsOn = (p, trackId) => p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);

export function isFree(p, trackId, start, end, ignore = []) {
  return !p.clips.some((c) => c.trackId === trackId && !ignore.includes(c.id) && c.start < end - 1e-4 && clipEnd(c) > start + 1e-4);
}

export function addTrack(p, kind, index) {
  const t = { id: uid('t_'), kind, main: false, name: kind === 'audio' ? 'Audio' : 'Overlay', muted: false, hidden: false, locked: false };
  if (index == null) index = kind === 'audio' ? p.tracks.length : 0;
  p.tracks.splice(index, 0, t);
  return t;
}

/** Place a clip on a sensible track. opts: { trackId, main, start } */
export function placeClip(p, clip, opts = {}) {
  const kind = clip.type === 'audio' ? 'audio' : 'visual';
  if (opts.start != null) clip.start = Math.max(0, opts.start);
  const end = clip.start + clip.duration;
  let track = opts.trackId && trackById(p, opts.trackId);
  if (track && track.kind !== kind) track = null;
  if (!track && opts.main && kind === 'visual') track = mainTrack(p);
  if (track && !track.main && !isFree(p, track.id, clip.start, end, [clip.id])) track = null;
  if (track?.main && track.locked) track = null;
  if (!track) {
    const candidates = p.tracks.filter((t) => t.kind === kind && !t.main && !t.locked && !!t.fx === (clip.type === 'effect'));
    // Visual overlays: prefer the lowest free overlay (closest to main); audio: first free.
    const order = kind === 'visual' ? candidates.reverse() : candidates;
    track = order.find((t) => isFree(p, t.id, clip.start, end, [clip.id]));
  }
  if (!track) {
    const mainIdx = p.tracks.findIndex((t) => t.main);
    track = addTrack(p, kind, kind === 'visual' ? mainIdx : p.tracks.length);
  }
  if (track.main && opts.main && opts.start == null) {
    clip.start = projectEndOf(p, track.id);
  } else if (track.main) {
    // Insert at a boundary: if dropped inside a clip, go after it.
    const hit = clipsOn(p, track.id).find((c) => c.id !== clip.id && clip.start > c.start && clip.start < clipEnd(c));
    if (hit) clip.start = clip.start - hit.start < hit.duration / 2 ? hit.start - 0.0001 : clipEnd(hit);
  }
  clip.trackId = track.id;
  if (!p.clips.includes(clip)) p.clips.push(clip);
  return clip;
}

export function projectEndOf(p, trackId) {
  return clipsOn(p, trackId).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

/** Keeps the project consistent after any edit. */
export function normalize(p, { magnet = true } = {}) {
  if (!mainTrack(p)) p.tracks.push({ id: uid('t_'), kind: 'visual', main: true, name: 'Main', muted: false, hidden: false, locked: false });
  const ids = new Set(p.tracks.map((t) => t.id));
  p.clips = p.clips.filter((c) => ids.has(c.trackId));
  // Drop empty non-main tracks.
  p.tracks = p.tracks.filter((t) => t.main || p.clips.some((c) => c.trackId === t.id));
  // Order: overlays, main, audio
  const vis = p.tracks.filter((t) => t.kind === 'visual' && !t.main);
  const aud = p.tracks.filter((t) => t.kind === 'audio');
  p.tracks = [...vis, mainTrack(p), ...aud];
  for (const c of p.clips) {
    c.duration = Math.max(MIN_DUR, round(c.duration, 4));
    c.start = Math.max(0, round(c.start, 4));
  }
  if (magnet) {
    let t = 0;
    for (const c of clipsOn(p, mainTrack(p).id)) { c.start = round(t, 4); t += c.duration; }
  }
  // Remove overlaps on non-main tracks by nudging later clips onto new tracks.
  for (const tr of [...p.tracks]) {
    if (tr.main && magnet) continue;
    const list = clipsOn(p, tr.id);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < clipEnd(list[i - 1]) - 1e-3) {
        const c = list[i];
        c.trackId = null;
        const nt = p.tracks.find((t) => t.kind === tr.kind && t.id !== tr.id && !t.main && isFree(p, t.id, c.start, clipEnd(c), [c.id]))
          || addTrack(p, tr.kind, tr.kind === 'visual' ? p.tracks.indexOf(tr) : p.tracks.length);
        c.trackId = nt.id;
        list.splice(i, 1); i--;
      }
    }
  }
  p.updated = Date.now();
  return p;
}

export function splitClip(p, id, t) {
  const a = clipById(p, id);
  if (!a || t <= a.start + MIN_DUR / 2 || t >= clipEnd(a) - MIN_DUR / 2) return null;
  const b = deepClone(a);
  b.id = uid('c_');
  const leftDur = t - a.start, total = a.duration;
  b.start = t; b.duration = clipEnd(a) - t;
  if (a.reverse) { b.in = a.in; a.in = a.in + (total - leftDur) * a.speed; }
  else b.in = a.in + leftDur * a.speed;
  if (a.curve) { a.curve = null; b.curve = null; }
  if (a.kf) { sliceKeys(a, 0, leftDur); sliceKeys(b, leftDur, total); }
  a.duration = leftDur;
  a.fadeOut = 0; b.fadeIn = 0;
  a.anim = { ...a.anim, out: 'none' }; b.anim = { ...b.anim, in: 'none' };
  b.transition = { type: 'none', dur: 0.5 };
  if (a.type === 'text' && a.anim.in === 'typewriter') b.anim.in = 'none';
  p.clips.push(b);
  return b;
}

export function deleteClips(p, ids, ripple = false) {
  for (const id of ids) {
    const c = clipById(p, id);
    if (!c) continue;
    p.clips = p.clips.filter((x) => x.id !== id);
    if (ripple) for (const o of p.clips) if (o.trackId === c.trackId && o.start >= clipEnd(c) - 1e-4) o.start -= c.duration;
  }
}

export function duplicateClip(p, id) {
  const c = clipById(p, id);
  if (!c) return null;
  const d = deepClone(c);
  d.id = uid('c_');
  d.start = clipEnd(c);
  p.clips.push(d);
  if (!isFree(p, c.trackId, d.start, clipEnd(d), [d.id])) {
    const tr = trackById(p, c.trackId);
    if (!tr.main) { d.trackId = null; placeClip(p, d, { start: d.start }); }
    else for (const o of p.clips) if (o.id !== d.id && o.trackId === c.trackId && o.start >= d.start - 1e-4) o.start += d.duration;
  }
  return d;
}

/** Trim a clip edge to timeline time t, respecting source media length. */
export function trimClip(p, c, edge, t, mediaDur = Infinity) {
  if (edge === 'start') {
    const end = clipEnd(c);
    let ns = Math.min(t, end - MIN_DUR);
    const srcShift = (ns - c.start) * c.speed;
    if (c.in + srcShift < 0) ns = c.start - c.in / c.speed;
    ns = Math.max(0, ns);
    const delta = ns - c.start;
    if (!c.reverse) c.in = Math.max(0, c.in + delta * c.speed);
    if (c.kf) for (const ks of Object.values(c.kf)) for (const k of ks) k.t -= delta;
    c.duration = end - ns; c.start = ns;
  } else {
    let nd = Math.max(MIN_DUR, t - c.start);
    if (c.reverse) {
      nd = Math.min(nd, (c.in + c.duration * c.speed) / c.speed);
      c.in = Math.max(0, c.in + (c.duration - nd) * c.speed);
    } else if (isFinite(mediaDur)) nd = Math.min(nd, (mediaDur - c.in) / c.speed);
    c.duration = nd;
  }
}

export function setSpeed(c, speed, mediaDur = Infinity) {
  speed = clamp(speed, 0.1, 10);
  const srcLen = c.duration * c.speed;
  c.speed = speed;
  c.duration = Math.max(MIN_DUR, srcLen / speed);
  if (isFinite(mediaDur)) c.duration = Math.min(c.duration, (mediaDur - c.in) / speed);
}

// ---- Store ------------------------------------------------------------------------------------
const listeners = new Map();
export const store = {
  project: null,
  selection: [],
  playhead: 0,
  playing: false,
  ui: { zoom: 80, snap: true, magnet: true, leftTab: 'media', inspectorTab: null, loop: false },
  undoStack: [], redoStack: [], _lastMerge: null, _lastTime: 0,
  onSave: null,

  on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); },
  clearListeners() { listeners.clear(); },
  emit(evt, data) { listeners.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },

  load(project) {
    this.project = project;
    this.selection = []; this.playhead = 0; this.undoStack = []; this.redoStack = [];
    normalize(project, { magnet: this.ui.magnet });
    this.emit('project'); this.emit('select'); this.emit('time');
  },

  /** Mutate the project with undo support. mergeKey merges rapid edits (sliders) into one step. */
  edit(label, fn, mergeKey = null) {
    const now = performance.now();
    const merge = mergeKey && mergeKey === this._lastMerge && now - this._lastTime < 1500;
    if (!merge) {
      this.undoStack.push({ label, snap: JSON.stringify(this.project) });
      if (this.undoStack.length > 150) this.undoStack.shift();
      this.redoStack = [];
    }
    this._lastMerge = mergeKey; this._lastTime = now;
    const r = fn(this.project);
    normalize(this.project, { magnet: this.ui.magnet });
    this.selection = this.selection.filter((id) => clipById(this.project, id));
    this.emit('project');
    this.onSave?.();
    return r;
  },
  /** Snapshot for undo without changing anything (call before a drag, then finish()). */
  checkpoint(label) {
    this.undoStack.push({ label, snap: JSON.stringify(this.project) });
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.redoStack = []; this._lastMerge = null;
  },
  finish() {
    normalize(this.project, { magnet: this.ui.magnet });
    this.emit('project'); this.onSave?.();
  },

  undo() {
    const s = this.undoStack.pop(); if (!s) return false;
    this.redoStack.push({ label: s.label, snap: JSON.stringify(this.project) });
    this.project = JSON.parse(s.snap); this._lastMerge = null;
    this.selection = this.selection.filter((id) => clipById(this.project, id));
    this.emit('project'); this.emit('select'); this.onSave?.();
    return s.label;
  },
  redo() {
    const s = this.redoStack.pop(); if (!s) return false;
    this.undoStack.push({ label: s.label, snap: JSON.stringify(this.project) });
    this.project = JSON.parse(s.snap); this._lastMerge = null;
    this.selection = this.selection.filter((id) => clipById(this.project, id));
    this.emit('project'); this.emit('select'); this.onSave?.();
    return s.label;
  },

  select(ids, additive = false) {
    ids = Array.isArray(ids) ? ids : ids ? [ids] : [];
    this.selection = additive ? [...new Set([...this.selection, ...ids])] : ids;
    this.emit('select');
  },
  get selected() { return this.selection.length === 1 ? clipById(this.project, this.selection[0]) : null; },

  setTime(t) {
    const max = Math.max(projectDuration(this.project), 0);
    this.playhead = clamp(t, 0, max);
    this.emit('time');
  },
  setUI(patch) { Object.assign(this.ui, patch); this.emit('ui'); },
};
