// Frame AI: an editing agent. It watches clips (vision), reads speech transcripts, sees the
// current preview frame, plans, and applies edits as actions - all in one undo step.
import { store, clipById, clipEnd, projectDuration, mainTrack, clipsOn, setSpeed, trimClip, placeClip, newClip } from './store.js';
import { mediaMap } from './media.js';
import { engine } from './engine.js';
import { h, toast, round } from './util.js';
import { icon } from './icons.js';
import { TEXT_STYLES, LOOKS, ANIM_IN, ANIM_OUT, ANIM_LOOP, TRANSITIONS, ASPECTS, STICKERS, FONTS } from './presets.js';
import { EFFECTS, MASKS, DEFAULT_MASK } from './fx.js';
import { CURVES, setAnimated, KF_PROPS } from './anim.js';
import { VOICE_FX } from './audiofx.js';
import { TEMPLATES, addTemplate } from './templates.js';
import { settings, refreshStatus, getStatus, openSettings } from './settings.js';
import { nvChat, parseJSON } from './nv.js';
import * as S from './smart.js';
import * as A from './actions.js';

export { refreshStatus, getStatus };
const hasKey = () => !!settings.get().key || getStatus().envKey;

// ---------- Context ----------
function projectContext() {
  const p = store.project;
  const r = (v) => round(v, 2);
  const timelineSpeech = [];
  for (const c of p.clips) for (const t of S.clipTranscript(c)) timelineSpeech.push(`[${r(t.start)}-${r(t.end)}] ${t.text}`);
  return {
    canvas: { aspect: p.aspect, width: p.width, height: p.height, fps: p.fps, background: p.background },
    duration: r(projectDuration(p)), playhead: r(store.playhead), selected: store.selection,
    media: S.mediaKnowledge(),
    tracks: p.tracks.map((t) => ({ id: t.id, kind: t.kind, main: !!t.main, muted: t.muted, hidden: t.hidden })),
    clips: [...p.clips].sort((a, b) => a.start - b.start).map((c) => {
      const o = { id: c.id, type: c.type, track: c.trackId, start: r(c.start), end: r(clipEnd(c)) };
      if (c.mediaId) { o.media = c.mediaId; o.sourceIn = r(c.in); o.sourceOut = r(c.in + c.duration * c.speed); }
      if (c.type === 'text') { o.text = c.text.content; o.font = c.text.font; o.caption = !!c.caption; }
      if (c.type === 'sticker') o.emoji = c.sticker;
      if (c.type === 'effect') o.effect = c.effect;
      if (c.speed !== 1) o.speed = c.speed;
      if (c.reverse) o.reverse = true;
      if (c.curve) o.speedCurve = c.curve;
      if (c.volume !== 1) o.volume = c.volume;
      if (c.muted) o.muted = true;
      if (c.voice) o.voiceover = true;
      if (c.voiceFx && c.voiceFx !== 'none') o.voiceFx = c.voiceFx;
      if (c.look !== 'none') o.look = c.look;
      if (c.mask?.type && c.mask.type !== 'none') o.mask = c.mask.type;
      if (c.chroma?.on) o.chroma = c.chroma.color;
      if (c.bgRemove) o.bgRemoved = true;
      if (c.kf) o.keyframes = Object.keys(c.kf);
      if (c.anim.in !== 'none' || c.anim.out !== 'none' || c.anim.loop !== 'none') o.anim = { in: c.anim.in, out: c.anim.out, loop: c.anim.loop };
      if (c.transition.type !== 'none') o.transition = c.transition;
      const t = c.transform;
      if (t.x !== 0.5 || t.y !== 0.5 || t.scale !== 1 || t.rotation) o.transform = { x: r(t.x), y: r(t.y), scale: r(t.scale), rotation: t.rotation };
      return o;
    }),
    speechOnTimeline: timelineSpeech.join('\n').slice(0, 6000) || undefined,
    markers: (p.markers || []).length ? { beats: p.markers.filter((m) => m.kind === 'beat').length, other: p.markers.filter((m) => m.kind !== 'beat').map((m) => r(m.t)) } : undefined,
  };
}

function systemPrompt() {
  return `You are Frame AI, an expert video editor built into the "Frame" editor (like CapCut, but easier). You edit the user's project by returning actions. You can SEE: media descriptions ("looksLike", "scenes") come from watching the clips, "speech" is a transcript of what is said, and the user's message may include an image of the current preview frame.
Answer ONLY with one JSON object:
{"message":"<short friendly reply in the user's language: what you did / what you see>","actions":[ ... ]}
Use "actions": [] for questions. Use ids from the project state. Times are seconds on the timeline unless the field says "source".

ACTIONS ("do" picks it):
Media & timeline
- {"do":"add_media","media":"<id>","start":0,"in":<source s>,"duration":5,"overlay":false}  (in+duration pick a part of the source: use scenes/speech to choose the best moments)
- {"do":"clear_timeline"}  remove all clips (to rebuild an edit from scratch)
- {"do":"split","time":4.2,"clip":"<optional id>"}  {"do":"delete","clips":["<id>"],"ripple":true}
- {"do":"trim","clip":"<id>","start":1,"end":6.5}   {"do":"move","clip":"<id>","start":3}   {"do":"duplicate","clip":"<id>"}
- {"do":"freeze","clip":"<video id>","time":3,"duration":2}   {"do":"extract_audio","clip":"<video id>"}
- {"do":"remove_silence","clips":["<id>"],"threshold_db":-38}
Look
- {"do":"set","clip":"<id>|selected|all|main|text|media","props":{volume 0-2, muted, speed 0.1-10, reverse true/false, speedCurve "<curve>|none", opacity 0-1, scale, x, y (0-1, 0.5=center), rotation, fadeIn, fadeOut, duration, look, lookAmount, adjust{brightness,contrast,saturation,temperature,tint,hue,blur,vignette,grayscale,sepia}, text{content,color,size,font,bold,italic,strokeWidth,strokeColor,bg,bgColor,glow,uppercase}, anim{in,out,loop,inDur,outDur}, transition{type,dur}, voiceFx, mask{type,x,y,w,h,rot,feather,invert}, chroma{on,color,tol}, bgRemove true/false, blend}}
- {"do":"keyframe","clip":"<id>","prop":"x|y|scale|rotation|opacity|volume","time":<timeline s>,"value":1.2}  (add several for motion, e.g. zoom-in: scale 1 at start, 1.3 at end)
- {"do":"effect","name":"<effect>","start":0,"duration":2,"intensity":1}  adjustment effect over everything below
- {"do":"transition_all","type":"fade","duration":0.5}
Text & graphics
- {"do":"add_text","text":"Hello","start":0,"duration":3,"style":"Title","position":"top|center|bottom","color":"#fff","size":96,"font":"Montserrat","anim_in":"pop","anim_out":"fade"}
- {"do":"template","name":"<template>","start":0,"texts":["main text","second line"]}
- {"do":"add_sticker","emoji":"🔥","start":1,"duration":2,"x":0.8,"y":0.2}
- {"do":"add_background","color":"#000","gradient":["#7f00ff","#e100ff"],"start":0,"duration":3}
- {"do":"captions","items":[{"start":0,"end":2.5,"text":"..."}],"style":"Subtitle"}
- {"do":"auto_captions"}  transcribe real speech with Gemini and add captions
Audio & voice
- {"do":"voiceover","text":"Hello everyone, today...","voice":"Puck","style":"youtuber|natural|narrator|news|excited|calm|dramatic|storyteller|whisper","start":0,"captions":true}  AI voice reads the text
- {"do":"beat_sync","beats_per_cut":2}  cut main clips on music beats   {"do":"mark_beats"}
- {"do":"auto_duck","level":0.25}  lower music while someone speaks
Project
- {"do":"aspect","ratio":"16:9|9:16|1:1|4:5|4:3|21:9"}  {"do":"background","mode":"color|blur","color":"#000"}
- {"do":"select","clips":["<id>"]}  {"do":"seek","time":0}  {"do":"play"}  {"do":"rename","name":"..."}  {"do":"export"}

VALUES
looks: ${Object.keys(LOOKS).join(', ')}
effects: ${Object.keys(EFFECTS).join(', ')}
templates: ${Object.keys(TEMPLATES).join(', ')}
anim in: ${Object.keys(ANIM_IN).join(', ')} | out: ${Object.keys(ANIM_OUT).join(', ')} | loop: ${Object.keys(ANIM_LOOP).join(', ')}
transitions: ${Object.keys(TRANSITIONS).join(', ')}
speed curves: ${Object.keys(CURVES).join(', ')}
voiceFx: ${Object.keys(VOICE_FX).join(', ')}
masks: ${Object.keys(MASKS).join(', ')}
text styles: ${TEXT_STYLES.map((s) => s.name).join(', ')}
fonts: ${FONTS.join(', ')}

HOW TO WORK: Think like a pro editor. Use the scenes and speech to make smart choices (cut boring/silent parts, keep the best moments, put titles where they fit, match music mood). Do the whole job in one reply - e.g. "make a TikTok": aspect 9:16 + background blur + hook title + captions + punchy transitions/effects. Main-track clips stay back-to-back automatically. Keep "message" short and concrete. If something is impossible, say so and offer an alternative.

CURRENT PROJECT STATE:
${JSON.stringify(projectContext())}`;
}

export function parseReply(text) {
  const o = parseJSON(text);
  if (o) return { message: String(o.message ?? o.reply ?? ''), actions: Array.isArray(o.actions) ? o.actions : [] };
  return { message: String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), actions: [] };
}

// ---------- Executing actions ----------
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : d);
function resolveClips(ref) {
  const p = store.project;
  if (Array.isArray(ref)) return ref.flatMap(resolveClips);
  if (ref === 'selected') return [...store.selection];
  if (ref === 'all') return p.clips.map((c) => c.id);
  if (ref === 'main') return clipsOn(p, mainTrack(p).id).map((c) => c.id);
  if (ref === 'text') return p.clips.filter((c) => c.type === 'text').map((c) => c.id);
  if (ref === 'media') return p.clips.filter((c) => c.type === 'video' || c.type === 'image').map((c) => c.id);
  if (typeof ref === 'string' && clipById(p, ref)) return [ref];
  return [];
}

function applyProps(c, props) {
  const md = A.mediaDur(c);
  for (const [k, v] of Object.entries(props || {})) {
    switch (k) {
      case 'volume': c.volume = Math.max(0, Math.min(2, num(v, 1))); break;
      case 'muted': c.muted = !!v; break;
      case 'speed': if (c.type === 'video' || c.type === 'audio') setSpeed(c, num(v, 1), md); break;
      case 'reverse': if (c.type === 'video' || c.type === 'audio') c.reverse = !!v; break;
      case 'speedCurve': if (c.type === 'video' || c.type === 'audio') c.curve = CURVES[v] ? v : null; break;
      case 'opacity': c.transform.opacity = Math.max(0, Math.min(1, num(v, 1))); break;
      case 'scale': case 'x': case 'y': case 'rotation': c.transform[k] = num(v, c.transform[k]); break;
      case 'flipH': case 'flipV': c.transform[k] = !!v; break;
      case 'fadeIn': case 'fadeOut': c[k] = Math.max(0, num(v, 0)); break;
      case 'duration': if (!isFinite(md)) c.duration = Math.max(0.1, num(v, c.duration)); else c.duration = Math.max(0.1, Math.min(num(v, c.duration), (md - c.in) / c.speed)); break;
      case 'look': if (LOOKS[v]) c.look = v; break;
      case 'lookAmount': c.lookAmount = Math.max(0, Math.min(1, num(v, 1))); break;
      case 'adjust': for (const [ak, av] of Object.entries(v || {})) if (ak in c.adjust) c.adjust[ak] = num(av, 0); break;
      case 'text': if (c.text) for (const [tk, tv] of Object.entries(v || {})) if (tk in c.text) { c.text[tk] = tv; if (tk === 'content') c.name = String(tv).slice(0, 30); } break;
      case 'anim':
        if (v.in && ANIM_IN[v.in]) c.anim.in = v.in;
        if (v.out && ANIM_OUT[v.out]) c.anim.out = v.out;
        if (v.loop && ANIM_LOOP[v.loop]) c.anim.loop = v.loop;
        if (v.inDur) c.anim.inDur = num(v.inDur, 0.5);
        if (v.outDur) c.anim.outDur = num(v.outDur, 0.5);
        break;
      case 'transition': if (v && TRANSITIONS[v.type]) c.transition = { type: v.type, dur: num(v.dur ?? v.duration, 0.5) }; break;
      case 'voiceFx': if (VOICE_FX[v]) c.voiceFx = v; break;
      case 'mask': if (v && MASKS[v.type]) c.mask = { ...DEFAULT_MASK, ...(c.mask || {}), ...v }; break;
      case 'chroma': c.chroma = { on: true, color: '#00ff00', tol: 30, soft: 15, spill: 50, ...(c.chroma || {}), ...(v || {}) }; break;
      case 'bgRemove': c.bgRemove = !!v; break;
      case 'blend': c.blend = String(v); break;
      case 'transform': applyProps(c, v); break;
    }
  }
}

const POS = { top: 0.15, center: 0.5, middle: 0.5, bottom: 0.85 };
async function runAction(a) {
  const p = store.project;
  const styleIdx = (name) => Math.max(0, TEXT_STYLES.findIndex((s) => s.name.toLowerCase() === String(name || '').toLowerCase()));
  switch (a.do) {
    case 'add_media': {
      if (!mediaMap.get(a.media)) throw new Error(`unknown media ${a.media}`);
      const c = A.addMediaClip(a.media, { start: a.start != null ? num(a.start, 0) : undefined, overlay: !!a.overlay, in: num(a.in, 0) || undefined });
      if (a.duration) store.edit('AI', () => applyProps(clipById(store.project, c.id), { duration: a.duration }));
      return `Added ${mediaMap.get(a.media).name}${a.in ? ` from ${num(a.in, 0)}s` : ''}`;
    }
    case 'clear_timeline': store.edit('Clear', (pp) => { pp.clips = []; }); store.select([]); return 'Cleared the timeline';
    case 'add_text': {
      const text = { content: String(a.text ?? 'Text') };
      if (a.color) text.color = a.color; if (a.size) text.size = num(a.size, 96); if (a.font && FONTS.includes(a.font)) text.font = a.font;
      const anim = {}; if (ANIM_IN[a.anim_in]) anim.in = a.anim_in; if (ANIM_OUT[a.anim_out]) anim.out = a.anim_out;
      A.addText(styleIdx(a.style), { start: num(a.start, store.playhead), duration: num(a.duration, 3), y: POS[a.position] ?? num(a.y, 0.5), x: num(a.x, 0.5), text, anim });
      return `Added text “${text.content.slice(0, 40)}”`;
    }
    case 'template': { if (!TEMPLATES[a.name]) throw new Error(`unknown template ${a.name}`); addTemplate(a.name, { start: num(a.start, store.playhead), texts: a.texts }); return `Added ${TEMPLATES[a.name].name}`; }
    case 'add_sticker': A.addSticker(a.emoji || STICKERS[0], { start: num(a.start, store.playhead), duration: num(a.duration, 2), x: num(a.x, 0.5), y: num(a.y, 0.5) }); return `Added sticker ${a.emoji}`;
    case 'add_background': A.addColor({ color: a.color || '#000000', gradient: Array.isArray(a.gradient) && a.gradient.length === 2 ? a.gradient : null }, { start: num(a.start, store.playhead), duration: num(a.duration, 3) }); return 'Added background clip';
    case 'effect': { if (!EFFECTS[a.name]) throw new Error(`unknown effect ${a.name}`); A.addEffect(a.name, { start: num(a.start, store.playhead), duration: num(a.duration, 2), intensity: num(a.intensity, 1) }); return `Added ${EFFECTS[a.name].name} effect`; }
    case 'keyframe': {
      if (!KF_PROPS.includes(a.prop)) throw new Error(`can't keyframe ${a.prop}`);
      store.edit('AI keyframe', (pp) => {
        const c = clipById(pp, a.clip); if (!c) throw new Error('unknown clip');
        const local = Math.max(0, Math.min(c.duration, num(a.time, c.start) - c.start));
        c.kf = c.kf || {}; if (!c.kf[a.prop]) c.kf[a.prop] = [];
        setAnimated(c, a.prop, num(a.value, 1), local);
      });
      return `Keyframe ${a.prop}=${a.value} at ${num(a.time, 0)}s`;
    }
    case 'split': { const ids = a.clip ? resolveClips(a.clip) : null; const r = A.splitAt(num(a.time, store.playhead), ids); return r.length ? `Split at ${num(a.time, store.playhead).toFixed(2)}s` : 'Nothing to split there'; }
    case 'delete': { const ids = resolveClips(a.clips ?? a.clip); if (!ids.length) throw new Error('no matching clips'); store.select(ids); A.deleteSelected(!!a.ripple); return `Deleted ${ids.length} clip(s)`; }
    case 'trim': {
      if (!clipById(p, a.clip)) throw new Error(`unknown clip ${a.clip}`);
      store.edit('AI trim', (pp) => { const x = clipById(pp, a.clip); if (a.start != null) trimClip(pp, x, 'start', num(a.start, x.start), A.mediaDur(x)); if (a.end != null) trimClip(pp, x, 'end', num(a.end, clipEnd(x)), A.mediaDur(x)); });
      return 'Trimmed clip';
    }
    case 'move': store.edit('AI move', (pp) => { const x = clipById(pp, a.clip); if (!x) throw new Error('unknown clip'); x.start = Math.max(0, num(a.start, x.start)); }); return 'Moved clip';
    case 'set': {
      const ids = resolveClips(a.clip ?? a.clips ?? 'selected');
      if (!ids.length) throw new Error('no matching clips for "set"');
      store.edit('AI change', (pp) => ids.forEach((id) => applyProps(clipById(pp, id), a.props)));
      return `Changed ${ids.length} clip(s): ${Object.keys(a.props || {}).join(', ')}`;
    }
    case 'transition_all': {
      const type = TRANSITIONS[a.type] ? a.type : 'fade';
      store.edit('AI transitions', (pp) => clipsOn(pp, mainTrack(pp).id).slice(1).forEach((c) => { c.transition = { type, dur: num(a.duration, 0.5) }; }));
      return `Added ${TRANSITIONS[type]} transitions`;
    }
    case 'remove_silence': { const s = await A.removeSilence(a.clips ? resolveClips(a.clips) : null, { thresholdDb: num(a.threshold_db, -38) }); return `Removed ${s.toFixed(1)}s of silence`; }
    case 'captions': {
      const items = (a.items || []).filter((x) => x && x.text).map((x) => ({ start: num(x.start, 0), end: num(x.end, num(x.start, 0) + 2), text: String(x.text) }));
      A.addCaptions(items, styleIdx(a.style || 'Subtitle')); return `Added ${items.length} captions`;
    }
    case 'auto_captions': { const n = await S.autoCaptions(a.clips ? resolveClips(a.clips) : null, styleIdx(a.style || 'Subtitle')); return `Added ${n} captions from speech`; }
    case 'voiceover': { const r = await S.generateVoiceover(String(a.text || ''), { voice: a.voice, style: a.style, start: a.start != null ? num(a.start, 0) : undefined, captions: !!a.captions }); return `Added ${r.duration.toFixed(1)}s AI voiceover`; }
    case 'beat_sync': await S.beatSync(num(a.beats_per_cut, 2)); return 'Synced cuts to the beat';
    case 'mark_beats': { const b = await S.markBeats(a.clip); return `Marked ${b.length} beats`; }
    case 'auto_duck': await S.autoDuck(num(a.level, 0.25)); return 'Lowered music under speech';
    case 'aspect': if (!ASPECTS[a.ratio]) throw new Error('unknown ratio'); A.setAspect(a.ratio); return `Canvas set to ${a.ratio}`;
    case 'background': store.edit('AI background', (pp) => { if (a.mode === 'blur' || a.mode === 'color') pp.background.mode = a.mode; if (a.color) pp.background.color = a.color; }); return 'Background updated';
    case 'extract_audio': A.detachAudio(a.clip); return 'Extracted audio';
    case 'duplicate': store.select(resolveClips(a.clip)); A.duplicateSelected(); return 'Duplicated clip';
    case 'freeze': { if (a.time != null) { store.setTime(num(a.time, 0)); engine.sync(false); await new Promise((r) => setTimeout(r, 400)); } await A.freezeFrame(a.clip, num(a.duration, 3)); return 'Added freeze frame'; }
    case 'select': store.select(resolveClips(a.clips ?? a.clip)); return 'Selected clips';
    case 'seek': engine.seek(num(a.time, 0)); return `Moved playhead to ${num(a.time, 0)}s`;
    case 'play': engine.play(); return 'Playing';
    case 'rename': store.edit('Rename', (pp) => { pp.name = String(a.name || pp.name); }); return `Renamed to ${a.name}`;
    case 'export': store.emit('openExport'); return 'Opened export';
    default: throw new Error(`unknown action "${a.do}"`);
  }
}

export async function runActions(actions, onStep) {
  const before = store.undoStack.length;
  const results = [];
  for (const a of actions) {
    onStep?.(a);
    try { results.push({ ok: true, text: await runAction(a) }); }
    catch (e) { results.push({ ok: false, text: `${a?.do || 'action'}: ${e.message}` }); }
  }
  if (store.undoStack.length > before + 1) store.undoStack.splice(before + 1);
  if (store.undoStack.length > before) store.undoStack[before].label = 'AI edit';
  store.emit('project');
  return results;
}

function previewSnapshot() {
  try {
    const c = engine.canvas; if (!c?.width) return null;
    const w = 512, t = document.createElement('canvas'); t.width = w; t.height = Math.round((w * c.height) / c.width);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

// ---------- Panel ----------
export function createAIPanel() {
  const history = [];
  const log = h('div.ai-log');
  const input = h('textarea', { rows: 1, placeholder: 'Tell Frame AI what to do…' });
  const sendBtn = h('button.send', { title: 'Send (Enter)', html: icon('send', 17) });
  const notice = h('div.notice.hidden');
  const QUICK = [
    ['wand', 'Auto edit', 'Watch my clips and make a great edit: keep the best moments, cut boring parts, add a title, transitions, a fitting filter and captions.'],
    ['captions', 'Auto captions', 'Add captions for everything that is said.'],
    ['mic', 'AI voiceover', 'Write a short engaging intro voiceover for this video and add it at the start with captions.'],
    ['film', 'TikTok version', 'Turn this into a vertical TikTok: 9:16, blurred background, a strong hook title, captions and punchy effects.'],
    ['sparkles', 'Make it cinematic', 'Make it cinematic: cinematic look, cinema bars, smooth transitions, slow zoom on key shots and an elegant title.'],
    ['music', 'Sync to beat', 'Cut my clips to the beat of the music and add flash effects on the drops.'],
    ['eye', 'What do you see?', 'Describe what is in my video, and suggest 3 improvements.'],
    ['scissors', 'Remove silences', 'Remove silent parts and awkward pauses.'],
  ];
  const quick = h('div.ai-quick', QUICK.map(([ic, label, prompt]) => h('button.qa', { onclick: () => send(prompt), title: prompt }, h('span', { html: icon(ic, 16) }), label)));
  const hero = h('div.ai-hero', h('div.orb', { html: icon('sparkles', 26) }), h('h4', 'Frame AI'),
    h('p', 'I can watch your clips, hear what is said, and edit for you - cuts, captions, voiceovers, effects, music sync and more.'));
  log.append(hero);
  const status = h('div.ai-status.hidden');
  const el = h('div.ai-panel',
    h('div.panel-head', h('h3', { html: icon('sparkles', 16) + ' Frame AI', style: { display: 'flex', gap: '6px', alignItems: 'center' } }),
      h('div', h('button.icon-btn', { title: 'Watch & understand all clips now', html: icon('eye', 16), onclick: () => ensureAnalysis(true) }),
        h('button.icon-btn', { title: 'New chat', html: icon('plus', 16), onclick: () => { history.length = 0; log.innerHTML = ''; log.append(hero); quick.classList.remove('hidden'); } }),
        h('button.icon-btn', { title: 'Settings (API keys, model, voice)', html: icon('settings', 16), onclick: () => openSettings() }))),
    notice, log, quick, status, h('div.ai-input', input, sendBtn));

  const updateNotice = () => {
    notice.classList.toggle('hidden', hasKey());
    notice.innerHTML = 'To use AI, add a free NVIDIA API key from <a href="https://build.nvidia.com" target="_blank" rel="noopener">build.nvidia.com</a>. ';
    notice.append(h('button.btn.sm', { style: { marginTop: '6px' }, onclick: () => openSettings() }, 'Open settings'));
  };
  refreshStatus().then(updateNotice);

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  sendBtn.onclick = () => send(input.value);

  function bubble(cls, content) { const b = h('div.msg.' + cls, content); log.append(b); log.scrollTop = log.scrollHeight; return b; }
  const setStatus = (t) => { status.classList.toggle('hidden', !t); status.innerHTML = t ? `<span class="spinner"></span> ${t}` : ''; };

  async function ensureAnalysis(force = false) {
    if (!settings.get().seeFrames && !force) return;
    const todo = store.project.media.filter((id) => { const m = mediaMap.get(id); return m && m.type !== 'audio' && !m.analysis; });
    if (!todo.length) { if (force) toast('All clips are already understood'); return; }
    try { await S.analyzeProject((t) => setStatus(t)); if (force) toast('Frame AI watched your clips', 'ok'); }
    catch (e) { toast('Could not analyze clips: ' + e.message, 'error'); }
    finally { setStatus(''); }
  }

  let busy = false;
  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (!hasKey()) { openSettings(); return; }
    input.value = ''; autosize();
    hero.remove(); quick.classList.add('hidden');
    bubble('user', text);
    busy = true; sendBtn.disabled = true;
    try {
      await ensureAnalysis();
      setStatus('Thinking…');
      const s = settings.get();
      const snap = s.seeFrames && store.project.clips.length ? previewSnapshot() : null;
      const userContent = snap ? [{ type: 'text', text: `${text}\n\n(Attached: the current preview frame at ${store.playhead.toFixed(2)}s.)` }, { type: 'image_url', image_url: { url: snap } }] : text;
      const messages = [{ role: 'system', content: systemPrompt() }, ...history.slice(-12), { role: 'user', content: userContent }];
      let content;
      try { content = await nvChat(messages, { vision: !!snap }); }
      catch (e) { if (snap) content = await nvChat([...messages.slice(0, -1), { role: 'user', content: text }]); else throw e; }
      history.push({ role: 'user', content: text }, { role: 'assistant', content });
      const { message, actions } = parseReply(content);
      setStatus(actions.length ? 'Editing…' : '');
      const b = bubble('ai', message || (actions.length ? 'Done.' : '(no reply)'));
      if (actions.length) {
        const results = await runActions(actions, (a) => setStatus(`Editing: ${a.do.replace(/_/g, ' ')}…`));
        b.append(h('div.acts', results.map((r) => h('div.act' + (r.ok ? '.ok' : '.bad'), h('span', { html: icon(r.ok ? 'check' : 'x', 13) }), r.text))));
        if (results.some((r) => r.ok)) b.append(h('button.undo-link', { onclick: (e) => { store.undo(); e.target.remove(); toast('Undid AI edit'); } }, 'Undo these changes'));
        history.push({ role: 'user', content: `[editor] Results: ${results.map((r) => (r.ok ? 'OK ' : 'FAILED ') + r.text).join('; ')}` }, { role: 'assistant', content: '{"message":"Noted.","actions":[]}' });
      }
    } catch (e) {
      bubble('ai.err', `⚠ ${e.message}`);
    } finally { busy = false; sendBtn.disabled = false; setStatus(''); log.scrollTop = log.scrollHeight; }
  }

  return {
    el,
    focus: () => setTimeout(() => input.focus(), 30),
    prefill: (t) => { input.value = t; autosize(); setTimeout(() => { input.focus(); input.setSelectionRange(t.length, t.length); }, 50); },
    send, openSettings,
  };
}
