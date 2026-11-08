// Left side panels: media, audio, text, elements, effects, transitions, AI.
import { store, clipById, mainTrack, clipsOn } from './store.js';
import { mediaMap, importFile, removeMedia, kindOf } from './media.js';
import { h, iconBtn, toast, fmtDur, confirmDialog, pickFiles, esc } from './util.js';
import { icon } from './icons.js';
import { TEXT_STYLES, STICKERS, SOLIDS, SHAPES, LOOKS, TRANSITIONS, DEFAULT_TEXT } from './presets.js';
import { sliderRow, showContextMenu } from './ui.js';
import * as A from './actions.js';
import { createAIPanel } from './ai.js';
import { EFFECTS } from './fx.js';
import { TEMPLATES, addTemplate } from './templates.js';
import * as S from './smart.js';
import { VOICES } from './gemini.js';
import { openSettings, settings } from './settings.js';

export const TABS = [
  ['media', 'media', 'Media'], ['audio', 'music', 'Audio'], ['text', 'text', 'Text'], ['elements', 'sticker', 'Stickers'],
  ['templates', 'layers', 'Templates'], ['fx', 'bolt', 'Effects'], ['effects', 'filter', 'Filters'], ['transitions', 'transition', 'Transitions'],
  ['captions', 'captions', 'Captions'], ['voice', 'mic', 'Voice'], ['ai', 'sparkles', 'AI'],
];

// ---------- Import (shared with global drag & drop) ----------
let importingCount = 0;
export async function importFiles(files, { addToTimeline = false } = {}) {
  files = files.filter((f) => kindOf(f));
  if (!files.length) { toast('No supported media files (video, audio or image)', 'error'); return []; }
  importingCount += files.length; store.emit('importing');
  const out = [];
  for (const f of files) {
    try {
      const m = await importFile(f);
      store.edit('Import', (p) => { if (!p.media.includes(m.id)) p.media.push(m.id); });
      out.push(m);
      if (addToTimeline) A.addMediaClip(m.id, { start: m.type === 'audio' ? 0 : undefined });
    } catch (e) { toast(e.message, 'error', 5000); }
    importingCount--; store.emit('importing');
  }
  if (out.length) toast(`Imported ${out.length} file${out.length > 1 ? 's' : ''}`, 'ok');
  return out;
}

export function createPanels(rail, panel) {
  const render = {};
  let current = null;

  for (const [id, ic, label] of TABS) {
    rail.append(h('button' + (id === 'ai' ? '.ai' : ''), { 'data-tab': id, title: label, onclick: () => store.setUI({ leftTab: id }) }, h('span', { html: icon(ic, 20) }), label));
  }
  const aiPanel = createAIPanel();

  function show() {
    const tab = store.ui.leftTab;
    rail.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === current && tab === 'ai') return;
    current = tab;
    panel.innerHTML = '';
    if (tab === 'ai') { panel.append(aiPanel.el); aiPanel.focus(); return; }
    panel.append(render[tab]());
  }
  store.on('ui', () => { if (store.ui.leftTab !== current) show(); });
  const rerenderIf = (...tabs) => () => { if (tabs.includes(current)) { const s = panel.querySelector('.panel-body')?.scrollTop; show(); const b = panel.querySelector('.panel-body'); if (b) b.scrollTop = s; } };
  store.on('importing', rerenderIf('media', 'audio'));
  store.on('project', (d) => { if (!d?.live) rerenderIf('media', 'audio', 'effects', 'transitions', 'captions')(); });
  store.on('select', rerenderIf('effects', 'transitions', 'captions'));

  const wrap = (title, headExtra, ...body) => h('div', { style: { display: 'contents' } },
    h('div.panel-head', h('h3', title), headExtra), h('div.panel-body', ...body));

  // ---------- Media ----------
  let filter = 'all';
  render.media = () => {
    const p = store.project;
    const dz = h('div.dropzone', { onclick: async () => importFiles(await pickFiles('video/*,audio/*,image/*')) },
      h('span', { html: icon('upload', 22) }), h('b', 'Import media'), h('span.small', 'Videos, photos, music - or drop files here'));
    const items = p.media.map((id) => mediaMap.get(id)).filter(Boolean).filter((m) => filter === 'all' || m.type === filter);
    const used = new Set(p.clips.map((c) => c.mediaId));
    const grid = h('div.media-grid', items.map((m) => mediaItem(m, used.has(m.id))));
    const filters = h('div.chips', { style: { marginTop: '12px' } }, [['all', 'All'], ['video', 'Videos'], ['image', 'Photos'], ['audio', 'Audio']].map(([v, l]) =>
      h('button.chip' + (filter === v ? '.on' : ''), { onclick: () => { filter = v; show(); } }, l)));
    return wrap('Media', null, dz,
      importingCount ? h('div.importing', h('div.spinner'), `Importing ${importingCount} file(s)…`) : null,
      p.media.length ? filters : null,
      items.length ? grid : h('p.muted.small', { style: { textAlign: 'center', marginTop: '18px' } }, p.media.length ? 'Nothing in this filter.' : 'Your imported files will appear here.'));
  };

  function mediaItem(m, isUsed) {
    const el = h('div.mitem' + (isUsed ? '.used' : ''), { draggable: true, title: `${m.name}\n${m.width ? m.width + '×' + m.height + '  ' : ''}${isFinite(m.duration) ? fmtDur(m.duration) : ''}` },
      m.type === 'audio' ? h('div.audio-thumb', { html: icon('music', 26) }) : h('img', { src: m.thumbs[Math.floor(m.thumbs.length / 3)] || m.thumbs[0], alt: '' }),
      h('div.mname', m.name),
      isFinite(m.duration) && m.type !== 'image' ? h('div.badge', fmtDur(m.duration)) : null,
      h('button.add', { title: 'Add to timeline at playhead', html: icon('plus', 14), onclick: (e) => { e.stopPropagation(); A.addMediaClip(m.id); } }),
      h('button.rm', { title: 'Remove from project', html: icon('x', 12), onclick: async (e) => {
        e.stopPropagation();
        const usedBy = store.project.clips.filter((c) => c.mediaId === m.id).length;
        if (usedBy && !(await confirmDialog('Remove media?', `“${m.name}” is used by ${usedBy} clip(s). They will be removed too.`, 'Remove', true))) return;
        store.edit('Remove media', (p) => { p.media = p.media.filter((x) => x !== m.id); p.clips = p.clips.filter((c) => c.mediaId !== m.id); });
      } }));
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-frame-media', m.id); e.dataTransfer.effectAllowed = 'copy'; });
    el.addEventListener('dblclick', () => A.addMediaClip(m.id));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const file = new File([m.blob], m.name, { type: m.mime || (m.type === 'image' ? 'image/png' : 'audio/wav') });
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Add to timeline', icon: 'plus', fn: () => A.addMediaClip(m.id) },
        m.type !== 'audio' ? { label: 'Add as overlay', icon: 'layers', fn: () => A.addMediaClip(m.id, { overlay: true }) } : null,
        m.type === 'image' ? { label: 'Edit in Photo editor', icon: 'photo', fn: () => store.emit('openStudio', { kind: 'photo', file }) } : null,
        m.type !== 'image' ? { label: 'Edit audio in Audio editor', icon: 'wave', fn: () => store.emit('openStudio', { kind: 'audio', file }) } : null,
      ].filter(Boolean));
    });
    return el;
  }

  // ---------- Audio ----------
  let recorder = null;
  render.audio = () => {
    const p = store.project;
    const items = p.media.map((id) => mediaMap.get(id)).filter((m) => m && m.type === 'audio');
    const recBtn = h('button.btn.block' + (recorder ? '.danger' : ''), { onclick: toggleRecord, html: icon(recorder ? 'stop' : 'mic', 16) + (recorder ? ' Stop recording' : ' Record voiceover') });
    return wrap('Audio', null,
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('button.btn.block', { onclick: async () => importFiles(await pickFiles('audio/*')), html: icon('upload', 16) + ' Import music / sound' }),
        recBtn),
      h('div.sub', 'Sound effects'),
      h('div.tile-grid.three', SFX.map((s) => h('div.tile', { title: 'Add at playhead', onclick: () => addSfx(s) }, h('span', { html: icon('bolt', 18) }), h('span.label', s.name)))),
      h('div.sub', 'Your audio'),
      items.length ? h('div.media-grid', items.map((m) => mediaItem(m, p.clips.some((c) => c.mediaId === m.id)))) : h('p.muted.small', 'No audio yet. Import music or record a voiceover.'),
      h('div.sub', 'Tips'),
      h('p.muted.small', 'Select a video clip and use “Extract audio” to edit its sound separately. Use the Audio tab on the right to change volume and fades.'));
  };

  async function toggleRecord() {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const chunks = [];
      const startAt = store.playhead;
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder = null; show();
        const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
        const [m] = await importFiles([new File([blob], `Voiceover ${new Date().toLocaleTimeString()}.webm`, { type: blob.type })]);
        if (m) A.addMediaClip(m.id, { start: startAt });
      };
      recorder.start();
      toast('Recording… click Stop when you are done');
      show();
    } catch (e) { toast('Microphone not available: ' + e.message, 'error'); recorder = null; }
  }

  async function addSfx(s) {
    const blob = await renderSfx(s);
    const [m] = await importFiles([new File([blob], s.name + '.wav', { type: 'audio/wav' })]);
    if (m) A.addMediaClip(m.id);
  }

  // ---------- Text ----------
  render.text = () => wrap('Text', null,
    h('button.btn.primary.block', { onclick: () => A.addText(0), html: icon('plus', 16) + ' Add text' }),
    h('div.sub', 'Styles'),
    h('div.tile-grid', TEXT_STYLES.map((st, i) => {
      const t = { ...DEFAULT_TEXT, ...st.t };
      const style = {
        fontFamily: `"${t.font}"`, fontWeight: t.bold ? 700 : 400, fontStyle: t.italic ? 'italic' : 'normal', color: t.color,
        textShadow: t.glow ? `0 0 10px ${t.color}` : t.strokeWidth ? `-1.5px -1.5px 0 ${t.strokeColor},1.5px -1.5px 0 ${t.strokeColor},-1.5px 1.5px 0 ${t.strokeColor},1.5px 1.5px 0 ${t.strokeColor}` : '0 2px 4px rgba(0,0,0,.5)',
        background: t.bg ? hexToRgba(t.bgColor, t.bgOpacity) : 'transparent', padding: t.bg ? '2px 8px' : 0, borderRadius: '4px',
        letterSpacing: (t.letterSpacing || 0) / 4 + 'px', textTransform: t.uppercase ? 'uppercase' : 'none',
      };
      return h('div.tile.text-tile', { title: st.name, onclick: () => A.addText(i) }, h('span', { style }, st.name));
    })),
    h('div.sub', 'Animated titles'),
    h('div.tile-grid', [
      ['Typewriter', { anim: { in: 'typewriter', inDur: 1.5 } }, 4], ['Pop in', { anim: { in: 'pop', inDur: 0.45, out: 'fade' } }, 2],
      ['Slide up', { anim: { in: 'slideUp', inDur: 0.6, out: 'slideDown' } }, 1], ['Bounce', { anim: { in: 'drop', inDur: 0.8, out: 'fade' } }, 9],
      ['Neon pulse', { anim: { in: 'fade', loop: 'pulse' } }, 5], ['Glitch', { anim: { in: 'blur', loop: 'glitch' } }, 2],
    ].map(([name, o, si]) => h('div.tile', { onclick: () => A.addText(si, { ...o, text: { content: name } }) }, h('span', { html: icon('sparkles', 16) }), h('span.label', name)))));

  // ---------- Elements: stickers / shapes / backgrounds ----------
  render.elements = () => wrap('Stickers & elements', null,
    h('div.sub', { style: { marginTop: 0 } }, 'Stickers'),
    h('div.tile-grid.five', STICKERS.map((s) => h('div.tile.emoji', { title: 'Add sticker', onclick: () => A.addSticker(s) }, s))),
    h('div.sub', 'Shapes'),
    h('div.tile-grid.three', SHAPES.map((s) => h('div.tile', { onclick: () => A.addShape(s.shape) }, h('span', { html: shapeIcon(s.shape) }), h('span.label', s.name)))),
    h('div.sub', 'Backgrounds'),
    h('div.tile-grid.three', SOLIDS.map((s) => h('div.tile', { title: 'Add as a clip on the main track', onclick: () => A.addColor(s) },
      h('div.prev', { style: { background: s.gradient ? `linear-gradient(135deg, ${s.gradient[0]}, ${s.gradient[1]})` : s.color, height: '30px' } }), h('span.label', s.name)))));

  // ---------- Effects ----------
  render.effects = () => {
    const c = store.selected;
    const targets = selectionOfType(['video', 'image', 'color', 'text', 'sticker', 'shape']);
    const tiles = h('div.tile-grid.three', Object.entries(LOOKS).map(([k, l]) =>
      h('div.tile' + (c?.look === k ? '.on' : ''), { onclick: () => applyLook(k, targets) },
        h('div.look-prev', { style: { filter: lookCss(l.adj) } }), h('span.label', l.name))));
    return wrap('Filters', null,
      !targets.length ? h('p.muted.small', { style: { marginTop: 0 } }, 'Select a clip in the timeline, then pick a filter. Fine-tune it in the Adjust tab on the right.') : h('p.muted.small', { style: { marginTop: 0 } }, `Applies to ${targets.length} selected clip(s).`),
      tiles,
      c && c.look !== 'none' ? h('div', { style: { marginTop: '14px' } }, sliderRow('Strength', Math.round((c.lookAmount ?? 1) * 100), { min: 0, max: 100, def: 100, unit: '%', onInput: (v) => store.edit('Filter strength', (p) => { clipById(p, c.id).lookAmount = v / 100; }, 'look' + c.id) })) : null,
      h('button.btn.block', { style: { marginTop: '14px' }, onclick: () => applyLook(c?.look || 'none', store.project.clips.filter((x) => x.type === 'video' || x.type === 'image').map((x) => x.id)), disabled: !c }, 'Apply this filter to all videos & photos'));
  };
  function applyLook(k, ids) {
    if (!ids.length) { toast('Select a clip first'); return; }
    store.edit('Filter', (p) => ids.forEach((id) => { const x = clipById(p, id); if (x) x.look = k; }));
  }

  // ---------- Transitions ----------
  let transDur = 0.6;
  render.transitions = () => {
    const c = store.selected;
    const ok = c && c.type !== 'audio';
    return wrap('Transitions', null,
      h('p.muted.small', { style: { marginTop: 0 } }, ok ? 'The transition plays at the start of the selected clip, blending in from the clip before it.' : 'Select a clip in the timeline. The transition plays where it begins.'),
      h('div.tile-grid.three', Object.entries(TRANSITIONS).map(([k, name]) =>
        h('div.tile' + (c?.transition?.type === k ? '.on' : ''), { onclick: () => {
          if (!ok) { toast('Select a clip first'); return; }
          store.edit('Transition', (p) => { const x = clipById(p, c.id); x.transition = { type: k, dur: transDur }; });
          if (k !== 'none') A.previewAround?.(c.start);
        } }, h('div.prev', { html: transIcon(k) }), h('span.label', name)))),
      h('div', { style: { marginTop: '14px' } }, sliderRow('Duration', transDur, { min: 0.1, max: 3, step: 0.1, def: 0.6, unit: 's', onInput: (v) => {
        transDur = v;
        if (ok && c.transition.type !== 'none') store.edit('Transition length', (p) => { clipById(p, c.id).transition.dur = v; }, 'tr' + c.id);
      } })),
      h('button.btn.block', { style: { marginTop: '6px' }, onclick: () => {
        const type = c?.transition?.type && c.transition.type !== 'none' ? c.transition.type : 'fade';
        store.edit('Transitions on all', (p) => clipsOn(p, mainTrack(p).id).slice(1).forEach((x) => { x.transition = { type, dur: transDur }; }));
        toast(`Added “${TRANSITIONS[type]}” between all main clips`, 'ok');
      } }, 'Apply to all main-track cuts'));
  };

  // ---------- Captions ----------
  render.captions = () => {
    const caps = store.project.clips.filter((c) => c.type === 'text' && c.caption).sort((a, b) => a.start - b.start);
    const capStyles = [4, 3, 2, 5, 9, 0];
    const ts = (t) => { const ms = Math.round(t * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
    const allCaps = (label, fn) => store.edit(label, (p) => p.clips.filter((c) => c.caption).forEach(fn));
    const quick = () => {
      const ta = h('textarea.input', { placeholder: 'One caption per line.\nThey are spread evenly across the selected clip (or the whole video).', rows: 6 });
      return h('div', ta, h('button.btn.block', { style: { marginTop: '8px' }, onclick: () => {
        const lines = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (!lines.length) return;
        const sel = store.selected;
        const from = sel ? sel.start : 0, to = sel ? sel.start + sel.duration : Math.max(3, A.fitTimelineTo());
        const step = (to - from) / lines.length;
        A.addCaptions(lines.map((text, i) => ({ start: from + i * step, end: from + (i + 1) * step - 0.05, text })));
      } }, 'Add captions'));
    };
    return wrap('Captions', null,
      h('button.btn.primary.block', { html: icon('captions', 16) + ' Auto captions (AI)', onclick: () => S.autoCaptions(store.selection.length ? store.selection : null) }),
      h('p.muted.small', 'Gemini listens to your video and writes timed captions. Select clips first to caption only those.'),
      h('div', { style: { display: 'grid', gap: '8px', gridTemplateColumns: '1fr 1fr' } },
        h('button.btn.sm', { html: icon('upload', 14) + ' Import .srt', onclick: async () => {
          const [f] = await pickFiles('.srt,.vtt', false); if (!f) return;
          const c = A.parseSRT(await f.text());
          if (!c.length) toast('No captions found in that file', 'error'); else A.addCaptions(c);
        } }),
        h('button.btn.sm', { html: icon('download', 14) + ' Save .srt', disabled: !caps.length, onclick: () => {
          const srt = caps.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.start + c.duration)}\n${c.text.content}\n`).join('\n');
          h('a', { href: URL.createObjectURL(new Blob([srt], { type: 'text/plain' })), download: `${store.project.name}.srt` }).click();
        } })),
      caps.length ? h('div', h('div.sub', 'Style for all captions'),
        h('div.chips', capStyles.map((si) => h('button.chip', { onclick: () => allCaps('Caption style', (c) => { c.text = { ...DEFAULT_TEXT, ...TEXT_STYLES[si].t, content: c.text.content }; }) }, TEXT_STYLES[si].name))),
        h('div.chips', { style: { marginTop: '6px' } },
          [['Top', 0.15], ['Middle', 0.5], ['Bottom', store.project.height > store.project.width ? 0.72 : 0.86]].map(([l, y]) => h('button.chip', { onclick: () => allCaps('Caption position', (c) => { c.transform.y = y; }) }, l)),
          h('button.chip', { onclick: () => allCaps('Caption case', (c) => { c.text.uppercase = !c.text.uppercase; }) }, 'AA'),
          h('button.chip', { onclick: () => allCaps('Caption pop', (c) => { c.anim.in = 'pop'; c.anim.inDur = 0.25; }) }, 'Pop in'),
          h('button.chip', { onclick: () => store.edit('Delete captions', (p) => { p.clips = p.clips.filter((c) => !c.caption); }) }, 'Delete all'))) : null,
      h('div.sub', caps.length ? `Edit captions (${caps.length})` : 'Quick captions from text'),
      caps.length ? h('div.cap-list', caps.map((c) => h('div.cap-row' + (store.selection.includes(c.id) ? '.on' : ''),
        h('button.cap-time', { onclick: () => { store.select(c.id); store.setTime(c.start + 0.01); } }, fmtDur(c.start)),
        h('textarea.cap-text', { rows: 1, value: c.text.content, onchange: (e) => store.edit('Edit caption', (p) => { const x = clipById(p, c.id); x.text.content = e.target.value; x.name = e.target.value.slice(0, 30); }) })))) : quick());
  };

  // ---------- Video effects ----------
  render.fx = () => {
    const cats = {};
    for (const [k, e] of Object.entries(EFFECTS)) (cats[e.cat] = cats[e.cat] || []).push([k, e]);
    return wrap('Effects', null,
      h('p.muted.small', { style: { marginTop: 0 } }, 'Click to add an effect at the playhead. It changes everything below it - drag its edges on the timeline to set how long it lasts.'),
      Object.entries(cats).map(([cat, list]) => [h('div.sub', cat), h('div.tile-grid.three', list.map(([k, e]) =>
        h('div.tile.fx-tile', { onclick: () => A.addEffect(k), title: `Add ${e.name}` }, h('div.fx-prev', { 'data-fx': k }), h('span.label', e.name))))]));
  };

  // ---------- Templates ----------
  render.templates = () => wrap('Templates', null,
    h('p.muted.small', { style: { marginTop: 0 } }, 'Ready-made animated titles and overlays. Click to add at the playhead, then edit the texts.'),
    h('div.tile-grid', Object.entries(TEMPLATES).map(([k, t]) => h('div.tile.tpl-tile', { onclick: () => addTemplate(k) }, h('div.tpl-prev', h('span', t.icon)), h('span.label', t.name)))));

  // ---------- Voice ----------
  render.voice = () => {
    const s = settings.get();
    const recBtn = h('button.btn.block' + (recorder ? '.danger' : ''), { onclick: toggleRecord, html: icon(recorder ? 'stop' : 'mic', 16) + (recorder ? ' Stop recording' : ' Record my voice') });
    return wrap('Voice', null,
      h('div.voice-hero', h('div', { html: icon('sparkles', 22) }), h('b', 'AI voiceover'), h('span.small', 'Type a script and a natural AI voice reads it - no microphone needed.')),
      h('button.btn.primary.block', { onclick: () => S.voiceoverDialog(store.selected?.type === 'text' ? store.selected.text.content : ''), html: icon('mic', 16) + ' Create AI voiceover' }),
      h('p.muted.small', `Voice: ${s.voice} · Powered by Gemini (gemini-3.1-flash-live-preview).`),
      h('button.btn.sm', { onclick: () => openSettings('gemini') }, 'Gemini key & default voice'),
      h('div.sub', 'Read text clips aloud'),
      h('button.btn.block', { onclick: async () => {
        const texts = store.project.clips.filter((c) => c.type === 'text' && (store.selection.includes(c.id) || !store.selection.length) && !c.caption);
        if (!texts.length) { toast('Add or select a text clip first'); return; }
        for (const c of texts) { try { await S.generateVoiceover(c.text.content, { start: c.start }); } catch (e) { toast(e.message, 'error'); break; } }
      }, html: icon('text', 16) + ' Text to speech (selected text)' }),
      h('div.sub', 'Your voice'),
      recBtn,
      h('div.sub', 'Smart audio'),
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('button.btn.block', { onclick: () => S.autoDuck(), html: icon('volume', 16) + ' Auto-duck music under speech' }),
        h('button.btn.block', { onclick: () => S.markBeats(store.selected?.type === 'audio' ? store.selected.id : null), html: icon('music', 16) + ' Detect music beats' }),
        h('button.btn.block', { onclick: () => S.beatSync(2), html: icon('scissors', 16) + ' Cut clips to the beat' })));
  };

  show();
  return { show, aiPanel };
}

function selectionOfType(types) {
  return store.selection.map((id) => clipById(store.project, id)).filter((c) => c && types.includes(c.type)).map((c) => c.id);
}
function hexToRgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function lookCss(a) {
  const f = [];
  if (a.brightness) f.push(`brightness(${1 + a.brightness / 100})`);
  if (a.contrast) f.push(`contrast(${1 + a.contrast / 100})`);
  if (a.saturation) f.push(`saturate(${1 + a.saturation / 100})`);
  if (a.hue) f.push(`hue-rotate(${a.hue}deg)`);
  if (a.grayscale) f.push(`grayscale(${a.grayscale}%)`);
  if (a.sepia) f.push(`sepia(${a.sepia}%)`);
  if (a.temperature > 0) f.push(`sepia(${a.temperature / 3}%)`);
  if (a.temperature < 0) f.push(`hue-rotate(${a.temperature / 3}deg)`);
  return f.join(' ') || 'none';
}
function shapeIcon(s) {
  const m = { rect: '<rect x="3" y="5" width="18" height="14" fill="currentColor"/>', round: '<rect x="3" y="5" width="18" height="14" rx="4" fill="currentColor"/>', circle: '<circle cx="12" cy="12" r="8" fill="currentColor"/>', line: '<rect x="2" y="11" width="20" height="2.5" rx="1.2" fill="currentColor"/>', arrow: '<path d="M2 10h13V6l7 6-7 6v-4H2z" fill="currentColor"/>', star: '<polygon points="12 2 15 9 22 9.5 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.5 9 9" fill="currentColor"/>' };
  return `<svg width="22" height="22" viewBox="0 0 24 24">${m[s]}</svg>`;
}
function transIcon(k) {
  const a = '#6366f1', b = '#22d3ee';
  const box = (inner) => `<svg width="56" height="32" viewBox="0 0 56 32">${inner}</svg>`;
  switch (k) {
    case 'none': return box(`<rect x="4" y="4" width="48" height="24" rx="3" fill="${a}"/><path d="M8 28 48 4" stroke="#fff" stroke-width="2"/>`);
    case 'fade': return box(`<defs><linearGradient id="gf" x1="0" x2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect x="4" y="4" width="48" height="24" rx="3" fill="url(#gf)"/>`);
    case 'black': return box(`<rect x="4" y="4" width="20" height="24" rx="3" fill="${a}"/><rect x="22" y="4" width="12" height="24" fill="#000"/><rect x="32" y="4" width="20" height="24" rx="3" fill="${b}"/>`);
    case 'white': return box(`<rect x="4" y="4" width="20" height="24" rx="3" fill="${a}"/><rect x="22" y="4" width="12" height="24" fill="#fff"/><rect x="32" y="4" width="20" height="24" rx="3" fill="${b}"/>`);
    case 'circle': return box(`<rect x="4" y="4" width="48" height="24" rx="3" fill="${a}"/><circle cx="28" cy="16" r="9" fill="${b}"/>`);
    case 'zoom': return box(`<rect x="4" y="4" width="48" height="24" rx="3" fill="${a}"/><rect x="18" y="10" width="20" height="12" rx="2" fill="${b}"/>`);
    case 'blur': return box(`<defs><filter id="bf"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="4" y="4" width="48" height="24" rx="3" fill="${b}" filter="url(#bf)"/>`);
    case 'spin': return box(`<rect x="4" y="4" width="48" height="24" rx="3" fill="${a}"/><rect x="20" y="8" width="16" height="16" rx="2" fill="${b}" transform="rotate(30 28 16)"/>`);
    case 'wipeLeft': case 'slideLeft': case 'push': return box(`<rect x="4" y="4" width="28" height="24" rx="3" fill="${a}"/><rect x="28" y="4" width="24" height="24" rx="3" fill="${b}"/><path d="M42 16h-10m3-3-3 3 3 3" stroke="#fff" stroke-width="2" fill="none"/>`);
    case 'wipeRight': case 'slideRight': return box(`<rect x="4" y="4" width="24" height="24" rx="3" fill="${b}"/><rect x="24" y="4" width="28" height="24" rx="3" fill="${a}"/><path d="M14 16h10m-3-3 3 3-3 3" stroke="#fff" stroke-width="2" fill="none"/>`);
    case 'slideUp': return box(`<rect x="4" y="4" width="48" height="12" rx="3" fill="${a}"/><rect x="4" y="14" width="48" height="14" rx="3" fill="${b}"/>`);
    default: return box(`<rect x="4" y="4" width="48" height="24" rx="3" fill="${a}"/>`);
  }
}

// ---------- Built-in sound effects (synthesised, no downloads) ----------
const SFX = [
  { name: 'Pop', dur: 0.25 }, { name: 'Whoosh', dur: 0.8 }, { name: 'Ding', dur: 1.4 }, { name: 'Click', dur: 0.08 },
  { name: 'Boom', dur: 1.5 }, { name: 'Riser', dur: 2.5 }, { name: 'Swoosh', dur: 0.5 }, { name: 'Beep', dur: 0.35 }, { name: 'Glitch', dur: 0.5 },
];
async function renderSfx(s) {
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * s.dur), sr);
  const noise = () => { const b = ctx.createBuffer(1, sr * s.dur, sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const n = ctx.createBufferSource(); n.buffer = b; return n; };
  const g = ctx.createGain(); g.connect(ctx.destination);
  const env = (a, peak, d) => { g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(peak, a); g.gain.exponentialRampToValueAtTime(0.0001, d); };
  if (s.name === 'Pop') { const o = ctx.createOscillator(); o.frequency.setValueAtTime(900, 0); o.frequency.exponentialRampToValueAtTime(140, 0.12); o.connect(g); env(0.005, 0.8, 0.22); o.start(); }
  else if (s.name === 'Whoosh' || s.name === 'Swoosh') {
    const n = noise(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, 0); f.frequency.exponentialRampToValueAtTime(s.name === 'Whoosh' ? 3500 : 6000, s.dur * 0.6); f.frequency.exponentialRampToValueAtTime(500, s.dur);
    n.connect(f); f.connect(g); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.9, s.dur * 0.55); g.gain.linearRampToValueAtTime(0, s.dur); n.start();
  } else if (s.name === 'Ding') { [1, 2.76, 5.4].forEach((m, i) => { const o = ctx.createOscillator(); o.frequency.value = 880 * m; const og = ctx.createGain(); og.gain.value = [0.6, 0.25, 0.1][i]; o.connect(og); og.connect(g); o.start(); }); env(0.005, 0.7, 1.35); }
  else if (s.name === 'Click') { const n = noise(); const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2000; n.connect(f); f.connect(g); env(0.001, 0.9, 0.06); n.start(); }
  else if (s.name === 'Boom') { const o = ctx.createOscillator(); o.frequency.setValueAtTime(110, 0); o.frequency.exponentialRampToValueAtTime(30, 1.2); o.connect(g); const n = noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400; n.connect(f); f.connect(g); env(0.01, 1, 1.45); o.start(); n.start(); }
  else if (s.name === 'Riser') { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(120, 0); o.frequency.exponentialRampToValueAtTime(1600, s.dur); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(400, 0); f.frequency.exponentialRampToValueAtTime(8000, s.dur); o.connect(f); f.connect(g); g.gain.setValueAtTime(0.001, 0); g.gain.exponentialRampToValueAtTime(0.35, s.dur * 0.95); g.gain.linearRampToValueAtTime(0, s.dur); o.start(); }
  else if (s.name === 'Beep') { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1000; const og = ctx.createGain(); og.gain.value = 0.25; o.connect(og); og.connect(g); g.gain.setValueAtTime(1, 0); g.gain.setValueAtTime(1, s.dur - 0.02); g.gain.linearRampToValueAtTime(0, s.dur); o.start(); }
  else if (s.name === 'Glitch') { const o = ctx.createOscillator(); o.type = 'square'; for (let i = 0; i < 10; i++) o.frequency.setValueAtTime(200 + Math.random() * 1800, i * 0.05); const og = ctx.createGain(); og.gain.value = 0.2; o.connect(og); og.connect(g); g.gain.setValueAtTime(1, 0); g.gain.linearRampToValueAtTime(0, s.dur); o.start(); }
  const buf = await ctx.startRendering();
  return audioBufferToWav(buf);
}

export function audioBufferToWav(buf) {
  const nch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const out = new DataView(new ArrayBuffer(44 + len * nch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + len * nch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, nch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * nch * 2, true); out.setUint16(32, nch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * nch * 2, true);
  const chans = []; for (let c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
