// Smart features: video understanding, auto captions, AI voiceover, beats, auto-ducking.
import { store, clipById, clipEnd, newClip, placeClip, mainTrack, clipsOn, trackById } from './store.js';
import { mediaMap, getAudioBuffer, saveMediaMeta, sampleFrames } from './media.js';
import { nvChat, parseJSON } from './nv.js';
import { speak, speechSegments, transcribe, toCaptionChunks, VOICES, STYLES } from './gemini.js';
import { detectBeats } from './audiofx.js';
import { settings } from './settings.js';
import { h, modal, toast, fmtTime, round } from './util.js';
import { icon } from './icons.js';
import * as A from './actions.js';

// ---------- Progress dialog ----------
export function progressDialog(title) {
  const bar = h('i'), text = h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, 'Starting…');
  let cancelled = false;
  const m = modal({ title, width: 440, dismissable: false, body: h('div', text, h('div.progress', bar)), actions: [{ label: 'Cancel', onClick: () => { cancelled = true; return false; } }] });
  return { set: (f, t) => { bar.style.width = Math.round(f * 100) + '%'; if (t) text.textContent = t; }, close: () => m.close(), get cancelled() { return cancelled; } };
}

// ---------- Video understanding ----------
/** Watch a media file with the vision model and store a description. */
export async function analyzeMedia(id, onStep) {
  const m = mediaMap.get(id);
  if (!m || m.analysis || m.type === 'audio') return m?.analysis;
  const n = m.type === 'image' ? 1 : Math.max(3, Math.min(12, Math.ceil(m.duration / 3)));
  const times = m.type === 'image' ? [0] : Array.from({ length: n }, (_, i) => round(((i + 0.5) * m.duration) / n, 2));
  onStep?.(`Looking at ${m.name}…`);
  const frames = await sampleFrames(id, times);
  const scenes = []; const sums = [];
  for (let b = 0; b < frames.length; b += 6) {
    const batch = frames.slice(b, b + 6);
    const content = [{ type: 'text', text: `These are ${batch.length} frames from the ${m.type} file "${m.name}"${m.type === 'video' ? ` (length ${m.duration.toFixed(1)}s) taken at seconds ${batch.map((f) => f.t).join(', ')}` : ''}. Describe what is shown. Reply ONLY with JSON: {"summary":"1-2 sentences about this part","frames":[{"t":<seconds>,"d":"short description: subject, action, setting, shot type, any visible text"}],"mood":"one or two words","tags":["..."]}` }];
    for (const f of batch) content.push({ type: 'image_url', image_url: { url: f.url } });
    try {
      const txt = await nvChat([{ role: 'user', content }], { maxTokens: 1500, think: false, vision: true, timeoutMs: 90000 });
      const j = parseJSON(txt) || { summary: txt.slice(0, 300) };
      if (j.summary) sums.push(j.summary);
      for (const f of j.frames || []) scenes.push({ t: +f.t || 0, d: String(f.d || '').slice(0, 200) });
      if (j.mood && !scenes.mood) scenes.mood = j.mood;
    } catch (e) { console.warn('analysis', e); if (!scenes.length && b === 0) throw e; }
  }
  const analysis = { summary: sums.join(' '), scenes, mood: scenes.mood || '', at: Date.now() };
  await saveMediaMeta(id, { analysis });
  return analysis;
}

export async function analyzeProject(onStep) {
  const ids = store.project.media.filter((id) => { const m = mediaMap.get(id); return m && m.type !== 'audio' && !m.analysis; });
  for (let i = 0; i < ids.length; i++) await analyzeMedia(ids[i], (t) => onStep?.(t, i / ids.length));
  return ids.length;
}

// ---------- Transcription / auto captions ----------
export async function transcribeMedia(id, onProgress) {
  const m = mediaMap.get(id);
  if (m.transcript) return m.transcript;
  const ab = await getAudioBuffer(id);
  if (!ab) throw new Error(`${m.name} has no audio`);
  const segs = speechSegments(ab, 0, ab.duration);
  if (!segs.length) { await saveMediaMeta(id, { transcript: [] }); return []; }
  const out = await transcribe(ab, segs, { onProgress, language: settings.get().language });
  await saveMediaMeta(id, { transcript: out });
  return out;
}

/** Transcript lines mapped onto the timeline for one clip. */
export function clipTranscript(c) {
  const m = mediaMap.get(c.mediaId);
  if (!m?.transcript?.length || c.reverse) return [];
  const s0 = c.in, s1 = c.in + c.duration * c.speed;
  return m.transcript.filter((t) => t.end > s0 && t.start < s1).map((t) => ({
    start: c.start + Math.max(0, (t.start - s0) / c.speed), end: c.start + Math.min(c.duration, (t.end - s0) / c.speed), text: t.text,
  }));
}

export async function autoCaptions(ids = null, styleIndex = 4) {
  const p = store.project;
  const clips = (ids?.length ? ids.map((id) => clipById(p, id)) : p.clips).filter((c) => c && (c.type === 'video' || c.type === 'audio') && !c.muted && mediaMap.get(c.mediaId)?.hasAudio !== false);
  if (!clips.length) { toast('Add a video or audio clip with speech first'); return 0; }
  const prog = progressDialog('Auto captions');
  try {
    const media = [...new Set(clips.map((c) => c.mediaId))];
    for (let i = 0; i < media.length; i++) {
      if (prog.cancelled) throw new Error('cancelled');
      await transcribeMedia(media[i], (f, t) => prog.set((i + f) / media.length, `${mediaMap.get(media[i]).name}: ${t}`));
    }
    let caps = [];
    for (const c of clips) caps.push(...toCaptionChunks(clipTranscript(c)));
    caps = caps.filter((x) => x.end - x.start > 0.15).sort((a, b) => a.start - b.start);
    prog.close();
    if (!caps.length) { toast('No speech found'); return 0; }
    store.edit('Remove old captions', (pp) => { pp.clips = pp.clips.filter((x) => !x.caption); });
    A.addCaptions(caps, styleIndex);
    return caps.length;
  } catch (e) { prog.close(); if (e.message !== 'cancelled') toast('Captions failed: ' + e.message, 'error', 7000); return 0; }
}

// ---------- AI voiceover ----------
export async function generateVoiceover(text, { voice, style, start, captions = false } = {}) {
  const s = settings.get();
  voice = voice || s.voice; style = style || s.voiceStyle;
  const r = await speak(text, { voice, style });
  const { importFiles } = await import('./panels.js');
  const [m] = await importFiles([new File([r.blob], `AI voice - ${text.slice(0, 28).replace(/[^\p{L}\p{N} ]/gu, '')}.wav`, { type: 'audio/wav' })]);
  if (!m) throw new Error('Could not import the generated audio');
  await saveMediaMeta(m.id, { transcript: [{ start: 0, end: r.duration, text: r.transcript || text }] });
  const at = start ?? store.playhead;
  const clip = A.addMediaClip(m.id, { start: at });
  store.edit('Voice', (p) => { const c = clipById(p, clip.id); c.voice = true; c.name = `🎙 ${text.slice(0, 40)}`; });
  if (captions) A.addCaptions(toCaptionChunks([{ start: at, end: at + r.duration, text: r.transcript || text }]));
  return { clip, duration: r.duration };
}

export function voiceoverDialog(prefill = '') {
  const s = settings.get();
  const ta = h('textarea.input', { rows: 6, value: prefill, placeholder: 'Hello everyone, today I am going to show you…' });
  const voice = h('select.select', VOICES.map(([v, d]) => h('option', { value: v, selected: v === s.voice }, `${v} - ${d}`)));
  const style = h('select.select', Object.entries(STYLES).map(([k, d]) => h('option', { value: k, selected: k === s.voiceStyle }, d)));
  const caps = h('input', { type: 'checkbox', checked: true });
  const status = h('div.small.muted', { style: { minHeight: '18px' } });
  const preview = h('button.btn', { html: icon('play', 14) + ' Preview', onclick: async () => {
    if (!ta.value.trim()) return;
    status.textContent = 'Generating preview…';
    try { const r = await speak(ta.value.trim().slice(0, 300), { voice: voice.value, style: style.value }); new Audio(URL.createObjectURL(r.blob)).play(); status.textContent = '▶ Playing preview'; }
    catch (e) { status.textContent = '✗ ' + e.message; }
  } });
  modal({ title: 'AI voiceover', width: 560, body: h('div',
    h('p.small.muted', { style: { marginTop: 0 } }, 'Type what the voice should say. Gemini (gemini-3.1-flash-live-preview) reads it with a natural voice and adds it to your timeline at the playhead.'),
    h('div.field', ta),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, h('div.field', h('label', 'Voice'), voice), h('div.field', h('label', 'Style'), style)),
    h('label.check', caps, ' Also add captions for it'),
    h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' } }, preview, status)),
  actions: [{ label: 'Cancel' }, { label: 'Add voiceover', primary: true, onClick: async () => {
    const text = ta.value.trim(); if (!text) return false;
    settings.set({ voice: voice.value, voiceStyle: style.value });
    status.textContent = 'Generating voice…';
    try { const r = await generateVoiceover(text, { voice: voice.value, style: style.value, captions: caps.checked }); toast(`Added ${r.duration.toFixed(1)}s AI voiceover`, 'ok'); }
    catch (e) { status.textContent = '✗ ' + e.message; toast(e.message, 'error', 6000); return false; }
  } }] });
}

// ---------- Beats ----------
export async function beatsFor(id) {
  const m = mediaMap.get(id);
  if (m.beats) return m.beats;
  const ab = await getAudioBuffer(id);
  if (!ab) throw new Error('No audio');
  const r = detectBeats(ab);
  await saveMediaMeta(id, { beats: r.beats, bpm: r.bpm });
  return r.beats;
}

/** Add beat markers for a music clip (or the longest audio clip). */
export async function markBeats(clipId) {
  const p = store.project;
  const c = clipId ? clipById(p, clipId) : [...p.clips].filter((x) => x.type === 'audio').sort((a, b) => b.duration - a.duration)[0];
  if (!c || (c.type !== 'audio' && c.type !== 'video')) { toast('Add a music clip first'); return []; }
  const beats = await beatsFor(c.mediaId);
  const times = beats.map((b) => c.start + (b - c.in) / c.speed).filter((t) => t >= c.start && t <= clipEnd(c));
  store.edit('Beat markers', (pp) => { pp.markers = (pp.markers || []).filter((mk) => mk.kind !== 'beat').concat(times.map((t) => ({ t, kind: 'beat', color: '#22d3ee' }))); });
  toast(`Marked ${times.length} beats (${mediaMap.get(c.mediaId).bpm} BPM)`, 'ok');
  return times;
}

/** Cut main-track clips so every cut lands on a beat. */
export async function beatSync(beatsPerCut = 2) {
  const p = store.project;
  let beats = (p.markers || []).filter((m) => m.kind === 'beat').map((m) => m.t).sort((a, b) => a - b);
  if (!beats.length) beats = await markBeats();
  if (beats.length < 2) { toast('Need music with a beat'); return; }
  store.edit('Beat sync', (pp) => {
    const list = clipsOn(pp, mainTrack(pp).id);
    let t = 0, bi = 0;
    for (const c of list) {
      // next beat index at least beatsPerCut beats after current position
      while (bi < beats.length && beats[bi] <= t + 0.05) bi++;
      const target = beats[Math.min(beats.length - 1, bi + beatsPerCut - 1)];
      if (target && target > t + 0.2) {
        const want = target - t;
        const max = c.type === 'video' ? (mediaMap.get(c.mediaId).duration - c.in) / c.speed : Infinity;
        c.duration = Math.min(want, max);
      }
      t += c.duration;
      bi = beats.findIndex((b) => b > t - 0.05); if (bi < 0) bi = beats.length;
    }
  });
  toast('Cuts synced to the beat', 'ok');
}

// ---------- Auto ducking ----------
/** Lower music under speech using volume keyframes. */
export async function autoDuck(level = 0.25) {
  const p = store.project;
  const isVoice = (c) => c.voice || c.type === 'video' || /voice/i.test(c.name || '');
  const music = p.clips.filter((c) => c.type === 'audio' && !isVoice(c));
  const voices = p.clips.filter((c) => (c.type === 'video' || c.type === 'audio') && isVoice(c) && !c.muted && mediaMap.get(c.mediaId)?.hasAudio !== false);
  if (!music.length || !voices.length) { toast('Need both music and speech (video or voiceover) to duck'); return; }
  const ranges = [];
  for (const v of voices) {
    const ab = await getAudioBuffer(v.mediaId); if (!ab || v.reverse) continue;
    for (const s of speechSegments(ab, v.in, Math.min(ab.duration, v.in + v.duration * v.speed), { thresholdDb: -36, minGap: 0.6 })) {
      ranges.push([v.start + (s.start - v.in) / v.speed, v.start + (s.end - v.in) / v.speed]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = []; for (const r of ranges) { const l = merged[merged.length - 1]; if (l && r[0] < l[1] + 0.5) l[1] = Math.max(l[1], r[1]); else merged.push([...r]); }
  store.edit('Auto duck', (pp) => {
    for (const mc of music) {
      const c = clipById(pp, mc.id); const full = c.volume ?? 1, low = full * level;
      const ks = [{ t: 0, v: full, e: 'ease' }];
      for (const [a, b] of merged) {
        const la = a - c.start, lb = b - c.start;
        if (lb < 0 || la > c.duration) continue;
        ks.push({ t: Math.max(0, la - 0.3), v: full, e: 'ease' }, { t: Math.max(0, la), v: low, e: 'ease' }, { t: Math.min(c.duration, lb), v: low, e: 'ease' }, { t: Math.min(c.duration, lb + 0.4), v: full, e: 'ease' });
      }
      ks.sort((x, y) => x.t - y.t);
      c.kf = c.kf || {}; c.kf.volume = ks.filter((k, i) => i === 0 || k.t - ks[i - 1].t > 0.01);
    }
  });
  toast(`Music lowered under ${merged.length} speech parts`, 'ok');
}

// ---------- Context for the AI ----------
export function mediaKnowledge() {
  return store.project.media.map((id) => mediaMap.get(id)).filter(Boolean).map((m) => ({
    id: m.id, name: m.name, type: m.type, duration: isFinite(m.duration) ? round(m.duration, 2) : null, hasAudio: m.hasAudio,
    ...(m.analysis ? { looksLike: m.analysis.summary, mood: m.analysis.mood, scenes: m.analysis.scenes?.map((s) => `${s.t}s: ${s.d}`) } : {}),
    ...(m.transcript?.length ? { speech: m.transcript.map((t) => `[${round(t.start, 1)}-${round(t.end, 1)}s] ${t.text}`).join(' ').slice(0, 4000) } : {}),
    ...(m.bpm ? { bpm: m.bpm } : {}),
  }));
}
