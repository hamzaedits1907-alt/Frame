// High-level editing actions shared by toolbar, shortcuts, menus and the AI assistant.
import {
  store, newClip, placeClip, splitClip, deleteClips, duplicateClip, clipById, clipEnd, trackById, isFree,
  projectDuration, setSpeed, mainTrack, clipsOn,
} from './store.js';
import { mediaMap, importCanvas, getAudioBuffer } from './media.js';
import { engine } from './engine.js';
import { TEXT_STYLES, DEFAULT_TEXT, ASPECTS } from './presets.js';
import { toast, deepClone, uid } from './util.js';

const P = () => store.project;
export const mediaDur = (c) => {
  const m = mediaMap.get(c.mediaId);
  return m && (m.type === 'video' || m.type === 'audio') ? m.duration : Infinity;
};

export function addMediaClip(mediaId, opts = {}) {
  const m = mediaMap.get(mediaId);
  if (!m) throw new Error('Unknown media ' + mediaId);
  const dur = m.type === 'image' ? 5 : m.duration;
  const clip = newClip(m.type, { mediaId, name: m.name, duration: opts.duration || dur });
  if (opts.in) { clip.in = opts.in; clip.duration = Math.min(clip.duration, dur - opts.in); }
  store.edit('Add media', (p) => {
    if (!p.media.includes(mediaId)) p.media.push(mediaId);
    const start = opts.start ?? store.playhead;
    if (m.type === 'audio') placeClip(p, clip, { start, trackId: opts.trackId });
    else {
      const main = opts.overlay ? false : !opts.trackId;
      const mt = mainTrack(p);
      const mainEmpty = !p.clips.some((c) => c.trackId === mt.id);
      if (opts.overlay) clip.transform.scale = 0.5;
      placeClip(p, clip, { start: main && mainEmpty ? 0 : start, main, trackId: opts.trackId });
    }
  });
  store.select(clip.id);
  return clip;
}

export function addText(styleIndex = 0, opts = {}) {
  const st = TEXT_STYLES[styleIndex] || TEXT_STYLES[0];
  const clip = newClip('text', { name: 'Text', duration: opts.duration || 3, text: { ...DEFAULT_TEXT, ...st.t, ...(opts.text || {}) } });
  if (opts.y != null) clip.transform.y = opts.y;
  if (opts.x != null) clip.transform.x = opts.x;
  if (opts.anim) clip.anim = { ...clip.anim, ...opts.anim };
  clip.name = (clip.text.content || 'Text').slice(0, 30);
  store.edit('Add text', (p) => placeClip(p, clip, { start: opts.start ?? store.playhead, trackId: opts.trackId }));
  store.select(clip.id);
  return clip;
}

export function addSticker(emoji, opts = {}) {
  const clip = newClip('sticker', { name: emoji, sticker: emoji, duration: opts.duration || 3 });
  clip.transform.scale = opts.scale || 0.6;
  if (opts.x != null) clip.transform.x = opts.x;
  if (opts.y != null) clip.transform.y = opts.y;
  clip.anim.in = 'pop'; clip.anim.inDur = 0.4;
  store.edit('Add sticker', (p) => placeClip(p, clip, { start: opts.start ?? store.playhead }));
  store.select(clip.id);
  return clip;
}

export function addShape(shape, color = '#ffffff', opts = {}) {
  const clip = newClip('shape', { name: shape, shape, fill: { color }, duration: opts.duration || 3 });
  clip.transform.scale = 0.5;
  store.edit('Add shape', (p) => placeClip(p, clip, { start: opts.start ?? store.playhead }));
  store.select(clip.id);
  return clip;
}

export function addColor(fill, opts = {}) {
  const clip = newClip('color', { name: fill.name || 'Background', fill: { color: fill.color, gradient: fill.gradient }, duration: opts.duration || 5 });
  store.edit('Add background', (p) => {
    const main = opts.main ?? true;
    const mt = mainTrack(p);
    const mainEmpty = !p.clips.some((c) => c.trackId === mt.id);
    placeClip(p, clip, { start: main && mainEmpty ? 0 : (opts.start ?? store.playhead), main });
  });
  store.select(clip.id);
  return clip;
}

/** Split selected clips (or every clip under the playhead if nothing selected). */
export function splitAt(t = store.playhead, ids = null) {
  const p = P();
  let targets = ids || (store.selection.length ? store.selection : p.clips.filter((c) => t > c.start && t < clipEnd(c) && !trackById(p, c.trackId)?.locked).map((c) => c.id));
  targets = targets.filter((id) => { const c = clipById(p, id); return c && t > c.start + 0.05 && t < clipEnd(c) - 0.05; });
  if (!targets.length) { toast('Move the playhead over a clip to split it'); return []; }
  const created = [];
  store.edit('Split', (p) => { for (const id of targets) { const b = splitClip(p, id, t); if (b) created.push(b.id); } });
  return created;
}

export function deleteSelected(ripple = false) {
  if (!store.selection.length) return;
  const ids = [...store.selection];
  store.edit(ripple ? 'Ripple delete' : 'Delete', (p) => deleteClips(p, ids, ripple));
  store.select([]);
}

export function duplicateSelected() {
  if (!store.selection.length) return;
  const out = [];
  store.edit('Duplicate', (p) => { for (const id of store.selection) { const d = duplicateClip(p, id); if (d) out.push(d.id); } });
  store.select(out);
}

let clipboard = [];
export function copySelected() {
  const p = P();
  clipboard = store.selection.map((id) => deepClone(clipById(p, id))).filter(Boolean);
  if (clipboard.length) toast(`Copied ${clipboard.length} clip${clipboard.length > 1 ? 's' : ''}`);
}
export function paste() {
  if (!clipboard.length) return;
  const base = Math.min(...clipboard.map((c) => c.start));
  const ids = [];
  store.edit('Paste', (p) => {
    for (const src of clipboard) {
      const c = deepClone(src); c.id = uid('c_');
      const tr = trackById(p, c.trackId);
      const start = store.playhead + (c.start - base);
      c.trackId = null;
      placeClip(p, c, { start, main: !!tr?.main, trackId: tr && !tr.main ? tr.id : null });
      ids.push(c.id);
    }
  });
  store.select(ids);
}

export function selectAll() { store.select(P().clips.map((c) => c.id)); }

export function detachAudio(id = store.selection[0]) {
  const p = P(); const c = clipById(p, id);
  if (!c || c.type !== 'video') { toast('Select a video clip first'); return; }
  const m = mediaMap.get(c.mediaId);
  if (m && m.hasAudio === false) { toast('This video has no audio'); return; }
  const a = newClip('audio', { mediaId: c.mediaId, name: (m?.name || 'Audio') + ' (audio)', start: c.start, duration: c.duration, in: c.in, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  store.edit('Extract audio', (p) => { clipById(p, id).muted = true; placeClip(p, a, { start: c.start }); });
  toast('Audio extracted to its own track', 'ok');
}

export async function freezeFrame(id = store.selection[0], seconds = 3) {
  const p = P(); const c = clipById(p, id);
  const t = store.playhead;
  if (!c || c.type !== 'video' || t < c.start || t >= clipEnd(c)) { toast('Put the playhead over a video clip'); return; }
  const e = engine.pool.get(c);
  const v = e?.el; if (!v || !v.videoWidth) { toast('Frame not ready yet - try again'); return; }
  const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight;
  cv.getContext('2d').drawImage(v, 0, 0);
  const m = await importCanvas(cv, `Freeze ${Math.round(t * 10) / 10}s.png`);
  const img = newClip('image', { mediaId: m.id, name: 'Freeze frame', duration: seconds });
  img.transform = deepClone(c.transform); img.crop = deepClone(c.crop); img.look = c.look; img.adjust = deepClone(c.adjust);
  store.edit('Freeze frame', (p) => {
    p.media.push(m.id);
    const cc = clipById(p, id);
    const b = t > cc.start + 0.05 && t < clipEnd(cc) - 0.05 ? splitClip(p, id, t) : null;
    const tr = trackById(p, cc.trackId);
    if (!(tr.main && store.ui.magnet)) for (const o of p.clips) if (o.trackId === cc.trackId && o.start >= t - 1e-4) o.start += seconds;
    img.start = t - 0.0001; img.trackId = cc.trackId; p.clips.push(img);
    if (b && tr.main && store.ui.magnet) b.start = t + 0.0001;
  });
  store.select(img.id);
}

export function setClipSpeed(id, speed) {
  store.edit('Speed', (p) => { const c = clipById(p, id); if (c) setSpeed(c, speed, mediaDur(c)); }, 'speed' + id);
}

export function setAspect(key) {
  const a = ASPECTS[key]; if (!a) return;
  store.edit('Aspect ratio', (p) => { p.aspect = key; p.width = a.w; p.height = a.h; });
  store.emit('resize');
}

// ---- Silence removal ---------------------------------------------------------------------
/** Finds quiet parts of a clip and cuts them out. Returns seconds removed. */
export async function removeSilence(ids, { thresholdDb = -38, minSilence = 0.45, pad = 0.12 } = {}) {
  const p = P();
  const targets = (ids && ids.length ? ids : p.clips.filter((c) => c.type === 'video' || c.type === 'audio').map((c) => c.id))
    .map((id) => clipById(p, id)).filter((c) => c && (c.type === 'video' || c.type === 'audio'));
  if (!targets.length) { toast('Add a video or audio clip first'); return 0; }
  const plans = [];
  for (const c of targets) {
    const ab = await getAudioBuffer(c.mediaId);
    if (!ab) continue;
    const sr = ab.sampleRate, ch = ab.getChannelData(0);
    const win = Math.round(sr * 0.02);
    const thr = Math.pow(10, thresholdDb / 20);
    const s0 = c.in, s1 = c.in + c.duration * c.speed;
    const loud = [];
    for (let t = s0; t < s1; t += 0.02) {
      const i0 = Math.floor(t * sr); let sum = 0, n = 0;
      for (let i = i0; i < Math.min(ch.length, i0 + win); i += 2) { sum += ch[i] * ch[i]; n++; }
      loud.push(Math.sqrt(sum / Math.max(1, n)) > thr);
    }
    // Build keep ranges in source time
    const keep = []; let segStart = null, quietRun = 0;
    loud.forEach((l, i) => {
      const t = s0 + i * 0.02;
      if (l) { if (segStart == null) segStart = t; quietRun = 0; }
      else if (segStart != null) { quietRun += 0.02; if (quietRun >= minSilence) { keep.push([segStart, t - quietRun + 0.02]); segStart = null; quietRun = 0; } }
    });
    if (segStart != null) keep.push([segStart, s1]);
    const padded = keep.map(([a, b]) => [Math.max(s0, a - pad), Math.min(s1, b + pad)])
      .reduce((acc, r) => { const last = acc[acc.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else acc.push(r); return acc; }, []);
    plans.push({ id: c.id, keep: padded });
  }
  let removed = 0;
  store.edit('Remove silence', (p) => {
    for (const plan of plans) {
      const c = clipById(p, plan.id); if (!c) continue;
      const origDur = c.duration;
      const tr = trackById(p, c.trackId);
      if (!plan.keep.length) continue;
      const pieces = plan.keep.map(([a, b]) => ({ ...deepClone(c), id: uid('c_'), in: a, duration: (b - a) / c.speed }));
      let t = c.start;
      for (const pc of pieces) { pc.start = t; t += pc.duration; pc.transition = { type: 'none', dur: 0.5 }; }
      const newDur = t - c.start;
      removed += origDur - newDur;
      p.clips = p.clips.filter((x) => x.id !== c.id);
      if (!(tr.main && store.ui.magnet)) for (const o of p.clips) if (o.trackId === c.trackId && o.start >= c.start + origDur - 1e-3) o.start -= origDur - newDur;
      p.clips.push(...pieces);
    }
  });
  toast(removed > 0.05 ? `Removed ${removed.toFixed(1)}s of silence` : 'No silent parts found', removed > 0.05 ? 'ok' : 'info');
  return removed;
}

// ---- Captions --------------------------------------------------------------------------------
export function parseSRT(text) {
  const out = [];
  const toSec = (s) => { const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : 0; };
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    out.push({ start: toSec(a), end: toSec(b), text: lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '') });
  }
  return out;
}

export function addCaptions(caps, styleIndex = 4) {
  if (!caps.length) return;
  const st = TEXT_STYLES[styleIndex] || TEXT_STYLES[4];
  const isVertical = P().height > P().width;
  store.edit('Add captions', (p) => {
    for (const cap of caps) {
      const c = newClip('text', { name: cap.text.slice(0, 30), start: cap.start, duration: Math.max(0.3, cap.end - cap.start), text: { ...DEFAULT_TEXT, ...st.t, content: cap.text } });
      c.transform.y = isVertical ? 0.72 : 0.86;
      c.caption = true;
      const capTrack = p.tracks.find((t) => t.kind === 'visual' && !t.main && p.clips.some((x) => x.trackId === t.id && x.caption) && isFree(p, t.id, c.start, clipEnd(c)));
      placeClip(p, c, { start: cap.start, trackId: capTrack?.id });
    }
  });
  toast(`Added ${caps.length} captions`, 'ok');
}

export function fitTimelineTo() { return projectDuration(P()); }
export { clipsOn };

export function addEffect(effect, opts = {}) {
  const clip = newClip('effect', { name: effect, effect, intensity: opts.intensity ?? 1, duration: opts.duration || 2 });
  store.edit('Add effect', (p) => {
    const start = opts.start ?? store.playhead;
    clip.start = start;
    // Effects live on the top-most track so they affect everything below.
    const top = p.tracks.find((t) => t.kind === 'visual' && !t.main && t.fx && isFree(p, t.id, start, start + clip.duration));
    const tr = top || (() => { const t = { id: uid('t_'), kind: 'visual', main: false, fx: true, name: 'Effects', muted: false, hidden: false, locked: false }; p.tracks.unshift(t); return t; })();
    clip.trackId = tr.id; p.clips.push(clip);
  });
  store.select(clip.id);
  return clip;
}
