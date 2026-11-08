// App entry: home screen (projects), editor layout, autosave, keyboard shortcuts, file drop.
import { store, newProject, projectDuration } from './store.js';
import { db } from './db.js';
import { loadMedia, mediaMap, removeMedia } from './media.js';
import { engine } from './engine.js';
import { createTimeline } from './timeline.js';
import { createPreview } from './preview.js';
import { createPanels, importFiles } from './panels.js';
import { createInspector } from './inspector.js';
import { openExportDialog } from './export.js';
import { refreshStatus, settings, openSettings } from './settings.js';
import { showContextMenu } from './ui.js';
import { ASPECTS } from './presets.js';
import { h, iconBtn, toast, modal, confirmDialog, promptDialog, pickFiles, debounce, fmtTime, $, esc } from './util.js';
import { icon } from './icons.js';
import * as A from './actions.js';

const app = $('#app');
let editorUI = null;

// ---------- Home ----------
let homeFilter = '';
async function showHome() {
  if (store.project) await saveNow();
  if (store.playing) engine.pause();
  store.clearListeners();
  store.project = null; editorUI = null;
  document.title = 'Frame';
  const status = await refreshStatus();
  const s = settings.get();
  const projects = (await db.all('projects')).sort((a, b) => b.updated - a.updated);
  app.innerHTML = '';

  // --- AI prompt hero ---
  let aspect = '16:9', pending = [];
  const prompt = h('textarea.hero-input', { rows: 2, placeholder: 'Describe the video you want… e.g. “A fun 30-second TikTok of my trip with captions and upbeat cuts”' });
  const fileNote = h('span.small.muted');
  const aspectChips = h('div.hero-aspects', Object.entries(ASPECTS).slice(0, 4).map(([k, a]) => h('button.hchip' + (k === aspect ? '.on' : ''), { onclick: (e) => { aspect = k; aspectChips.querySelectorAll('.hchip').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, `${k} ${a.label.split(' ')[0]}`)));
  const go = async () => {
    const text = prompt.value.trim();
    if (!text && !pending.length) { prompt.focus(); return; }
    await createProject(aspect, { files: pending, aiPrompt: text || 'Watch my clips and make a great edit: best moments, title, transitions, a fitting filter and captions.' });
  };
  prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  const hero = h('section.hero',
    h('div.hero-glow'),
    h('div.hero-badge', { html: icon('sparkles', 13) + ' AI video editor' }),
    h('h1', 'What will you ', h('span', 'create'), ' today?'),
    h('p.lead', 'Drop your clips and describe your idea. Frame AI watches, cuts, captions and voices your video for you.'),
    h('div.hero-box',
      prompt,
      h('div.hero-row',
        h('button.btn.ghost.sm', { html: icon('upload', 15) + ' Add clips', onclick: async () => { pending = await pickFiles('video/*,audio/*,image/*'); fileNote.textContent = pending.length ? `${pending.length} file(s) ready` : ''; } }),
        fileNote, aspectChips, h('div', { style: { flex: 1 } }),
        h('button.btn.primary', { html: icon('sparkles', 15) + ' Create with AI', onclick: go }))));

  // --- Start blank ---
  const newCard = (key) => {
    const a = ASPECTS[key]; const sc = 40 / Math.max(a.w, a.h);
    return h('div.new-card', { onclick: () => createProject(key) },
      h('div.shape', { style: { width: a.w * sc + 'px', height: a.h * sc + 'px' } }, h('span', { html: icon('plus', 14) })), h('b', a.label), h('small', key));
  };

  // --- AI tools ---
  const tools = [
    ['wand', 'Auto edit', 'AI watches your clips and edits them', 'g1', () => quickTool('autoedit')],
    ['captions', 'Auto captions', 'Subtitles from speech in one click', 'g2', () => quickTool('captions')],
    ['mic', 'AI voiceover', 'Natural voice from your text', 'g3', () => quickTool('voice')],
    ['eyeOff', 'Remove background', 'Cut out people without a green screen', 'g4', () => quickTool('cutout')],
    ['music', 'Beat sync', 'Cut your clips to the music', 'g5', () => quickTool('beats')],
    ['film', 'Make a TikTok', 'Vertical, captions, hooks and effects', 'g6', () => quickTool('tiktok')],
  ];
  const toolCards = h('div.tool-grid', tools.map(([ic, t, d, g, fn]) => h('div.tool-card.' + g, { onclick: fn }, h('div.tool-ic', { html: icon(ic, 20) }), h('b', t), h('span', d))));

  // --- Projects ---
  const grid = h('div.proj-grid');
  const renderProjects = () => {
    grid.innerHTML = '';
    const list = projects.filter((p) => !homeFilter || p.name.toLowerCase().includes(homeFilter.toLowerCase()));
    if (!list.length) { grid.append(h('div.empty', projects.length ? 'No projects match your search.' : 'No projects yet - describe a video above or pick a format to start.')); return; }
    for (const p of list) grid.append(projCard(p));
  };
  const projCard = (p) => h('div.proj', { onclick: () => openProject(p.id) },
    h('div.thumb', { style: p.thumb ? { backgroundImage: `url(${p.thumb})` } : null }, p.thumb ? null : h('span', { html: icon('film', 28) }),
      h('span.dur', fmtTime(projectDuration(p))), h('div.play-ov', { html: icon('play', 22) })),
    h('div.meta', h('b', p.name), h('span', `${p.aspect} · edited ${timeAgo(p.updated)}`)),
    h('button.icon-btn.more', { title: 'More', html: icon('more', 16), onclick: (e) => {
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Open', icon: 'folder', fn: () => openProject(p.id) },
        { label: 'Rename', icon: 'text', fn: async () => { const n = await promptDialog('Rename project', p.name); if (n) { p.name = n; await db.put('projects', p); showHome(); } } },
        { label: 'Duplicate', icon: 'copy', fn: async () => { const d = JSON.parse(JSON.stringify(p)); d.id = 'p_' + Math.random().toString(36).slice(2, 10); d.name = p.name + ' (copy)'; d.updated = Date.now(); d.sharedMedia = true; await db.put('projects', d); showHome(); } },
        '-',
        { label: 'Delete', icon: 'trash', fn: async () => {
          if (!(await confirmDialog('Delete project?', `“${p.name}” will be removed from Frame. Your original files on disk are not touched.`, 'Delete', true))) return;
          const others = projects.filter((x) => x.id !== p.id);
          for (const id of p.media || []) if (!others.some((o) => (o.media || []).includes(id))) await removeMedia(id);
          await db.del('projects', p.id);
          showHome();
        } },
      ]);
    } }));
  renderProjects();

  const dot = (ok, label, fix) => h('div.stat' + (ok ? '.ok' : ''), { onclick: ok ? null : fix, title: ok ? 'Ready' : 'Click to set up' }, h('i'), label);
  const side = h('aside.home-side',
    h('div.brand', h('div.logo', { html: icon('play', 15) }), 'Frame'),
    h('nav',
      h('button.on', { html: icon('home', 17) + ' Home' }),
      h('button', { html: icon('folder', 17) + ' Projects', onclick: () => grid.scrollIntoView({ behavior: 'smooth' }) }),
      h('div.nav-sep', 'Studios'),
      h('button', { html: icon('film', 17) + ' Video editor', onclick: () => createProject('16:9') }),
      h('button', { html: icon('photo', 17) + ' Photo editor', onclick: () => openPhoto({}) }),
      h('button', { html: icon('wave', 17) + ' Audio editor', onclick: () => openAudio({}) }),
      h('div.nav-sep', 'App'),
      h('button', { html: icon('settings', 17) + ' Settings', onclick: () => openSettings() }),
      h('button', { html: icon('download', 17) + ' Check for updates', onclick: () => checkUpdates(true) }),
      h('button', { html: icon('keyboard', 17) + ' Shortcuts', onclick: showShortcuts })),
    h('div.side-foot',
      h('div.small.muted', { style: { marginBottom: '8px', fontWeight: 600 } }, 'Status'),
      dot(status.envKey || !!s.key, 'Frame AI (NVIDIA)', () => openSettings()),
      dot(status.geminiEnv || !!s.geminiKey, 'AI voice (Gemini)', () => openSettings('gemini')),
      dot(status.ffmpeg, 'Export (FFmpeg)', () => toast('Run start.bat again and let it install FFmpeg'))));

  const search = h('input.input.search', { placeholder: 'Search projects', value: homeFilter, oninput: (e) => { homeFilter = e.target.value; renderProjects(); } });
  const photos = (await db.all('photos')).sort((a, b) => b.updated - a.updated);
  const audios = (await db.all('audios')).sort((a, b) => b.updated - a.updated);
  const studioCard = (cls, ic, title, desc, fn) => h('div.studio-card.' + cls, { onclick: fn }, h('div.studio-ic', { html: icon(ic, 24) }), h('div', h('b', title), h('span', desc)), h('span.studio-go', { html: icon('chevronDown', 16) }));
  const studios = h('div.studio-grid',
    studioCard('s-video', 'film', 'Video editor', 'Timeline, effects, captions, AI', () => createProject('16:9')),
    studioCard('s-photo', 'photo', 'Photo editor', 'Layers, brushes, selections, filters, AI', () => openPhoto({})),
    studioCard('s-audio', 'wave', 'Audio editor', 'Waveform, noise reduction, voice, effects', () => openAudio({})));
  const del = async (storeName, idv, refresh) => { if (await confirmDialog('Delete?', 'This removes it from Frame.', 'Delete', true)) { await db.del(storeName, idv); refresh(); } };
  const recentPhotos = photos.length ? h('div', h('div.section-title', h('span', `Photos (${photos.length})`)), h('div.mini-grid', photos.slice(0, 12).map((p) => h('div.mini', { onclick: () => openPhoto({ id: p.id }) },
    h('div.mini-thumb', { style: { backgroundImage: `url(${p.thumb})` } }), h('div.mini-meta', h('b', p.name), h('span', `${p.w}×${p.h} · ${timeAgo(p.updated)}`)),
    h('button.icon-btn.more', { html: icon('trash', 14), title: 'Delete', onclick: (e) => { e.stopPropagation(); del('photos', p.id, showHome); } }))))) : null;
  const recentAudio = audios.length ? h('div', h('div.section-title', h('span', `Audio (${audios.length})`)), h('div.mini-grid', audios.slice(0, 12).map((a) => h('div.mini', { onclick: () => openAudio({ id: a.id }) },
    h('div.mini-thumb.wave-thumb', h('div.wave-bars', (a.peaks || []).filter((_, i) => i % 3 === 0).map((v) => h('i', { style: { height: Math.max(4, v * 100) + '%' } })))),
    h('div.mini-meta', h('b', a.name), h('span', `${fmtTime(a.duration || 0)} · ${timeAgo(a.updated)}`)),
    h('button.icon-btn.more', { html: icon('trash', 14), title: 'Delete', onclick: (e) => { e.stopPropagation(); del('audios', a.id, showHome); } }))))) : null;
  app.append(h('div.home', side, h('main.home-main', h('div.home-inner',
    updateBanner,
    hero,
    h('div.section-title', h('span', 'Studios')), studios,
    h('div.section-title', h('span', 'AI tools')), toolCards,
    h('div.section-title', h('span', 'Start from scratch')), h('div.new-grid', Object.keys(ASPECTS).map(newCard)),
    h('div.section-title', h('span', `Video projects (${projects.length})`), projects.length > 3 ? search : null), grid,
    h('div', { style: { height: '30px' } }), recentPhotos, recentPhotos ? h('div', { style: { height: '30px' } }) : null, recentAudio))));
  setTimeout(() => prompt.focus(), 50);
  checkUpdates(false);
}

// ---------- Command palette (Ctrl+K) ----------
async function openPalette() {
  if (!store.project || document.querySelector('.palette')) return;
  const S = await import('./smart.js'); const { EFFECTS } = await import('./fx.js'); const { TEMPLATES, addTemplate } = await import('./templates.js');
  const tab = (t) => () => store.setUI({ leftTab: t });
  const ai = (p) => () => { store.setUI({ leftTab: 'ai' }); editorUI.panels.aiPanel.send(p); };
  const cmds = [
    ['Play / pause', 'Space', () => engine.toggle()], ['Split at playhead', 'S', () => A.splitAt()], ['Delete selected', 'Del', () => A.deleteSelected()],
    ['Duplicate selected', 'Ctrl+D', A.duplicateSelected], ['Undo', 'Ctrl+Z', () => store.undo()], ['Redo', 'Ctrl+Y', () => store.redo()],
    ['Export video', 'Ctrl+E', openExportDialog], ['Add text', '', () => A.addText(0)], ['Import media', '', async () => importFiles(await pickFiles('video/*,audio/*,image/*'))],
    ['Auto captions', 'AI', () => S.autoCaptions()], ['AI voiceover', 'AI', () => S.voiceoverDialog()], ['Remove silences', 'AI', () => A.removeSilence(null)],
    ['Detect beats', '', () => S.markBeats()], ['Cut clips to the beat', '', () => S.beatSync(2)], ['Auto-duck music', '', () => S.autoDuck()],
    ['AI: Auto edit my video', 'AI', ai('Watch my clips and make a great edit: keep the best moments, cut boring parts, add a title, transitions, a fitting filter and captions.')],
    ['AI: Make it cinematic', 'AI', ai('Make it cinematic.')], ['AI: Make a TikTok version', 'AI', ai('Turn this into a vertical TikTok with hook title, captions and punchy effects.')],
    ['Open Photo editor', '', () => openPhoto({})], ['Open Audio editor', '', () => openAudio({})], ['Go home', '', showHome], ['Settings', '', () => openSettings()],
    ['Keyboard shortcuts', '?', showShortcuts], ['Fit timeline', 'Shift+Z', () => editorUI.timeline.fit()], ['Toggle loop', 'L', () => store.setUI({ loop: !store.ui.loop })],
    ...['media', 'audio', 'text', 'templates', 'elements', 'fx', 'effects', 'transitions', 'captions', 'voice', 'ai'].map((t) => [`Show ${t} panel`, '', tab(t)]),
    ...Object.entries(ASPECTS).map(([k, a]) => [`Canvas ${k} (${a.label})`, '', () => A.setAspect(k)]),
    ...Object.entries(EFFECTS).map(([k, e]) => [`Add effect: ${e.name}`, '', () => A.addEffect(k)]),
    ...Object.entries(TEMPLATES).map(([k, t]) => [`Add template: ${t.name}`, '', () => addTemplate(k)]),
  ];
  const input = h('input.palette-input', { placeholder: 'Type a command…  (e.g. “captions”, “glitch”, “export”)' });
  const list = h('div.palette-list');
  let sel = 0, shown = [];
  const close = () => { wrap.remove(); };
  const render = () => {
    const q = input.value.toLowerCase().trim();
    shown = cmds.filter(([n]) => !q || q.split(/\s+/).every((w) => n.toLowerCase().includes(w))).slice(0, 12);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = '';
    shown.forEach(([n, key, fn], i) => list.append(h('button.palette-item' + (i === sel ? '.on' : ''), { onmouseenter: () => { sel = i; render(); }, onclick: () => { close(); fn(); } }, h('span', n), key ? h('kbd', key) : null)));
    if (!shown.length) list.append(h('div.palette-empty', 'No matching command'));
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = shown[sel]; close(); c?.[2](); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  const wrap = h('div.palette-wrap', { onmousedown: (e) => { if (e.target === wrap) close(); } }, h('div.palette', h('div.palette-head', h('span', { html: icon('command', 16) }), input), list));
  document.body.append(wrap); render(); input.focus();
}

// ---------- Studios ----------
async function leaveCurrent() { if (store.project) await saveNow(); if (store.playing) engine.pause(); store.clearListeners(); store.project = null; editorUI = null; }
async function openPhoto({ id = null, file = null } = {}) {
  await leaveCurrent();
  const { openPhotoEditor } = await import('./photo.js');
  await openPhotoEditor(app, { id, file, onExit: showHome, onSendToVideo: sendToVideo });
}
async function openAudio({ id = null, file = null } = {}) {
  await leaveCurrent();
  const { openAudioEditor } = await import('./audioed.js');
  await openAudioEditor(app, { id, file, onExit: showHome, onSendToVideo: sendToVideo });
}
/** Bring a file from Photo/Audio into the last video project (or a new one). */
async function sendToVideo(file) {
  const last = (() => { try { return localStorage.getItem('frame.last'); } catch { return null; } })();
  const proj = last && (await db.get('projects', last));
  if (proj) await openProject(proj.id); else await createProject(file.type.startsWith('image') ? '1:1' : '16:9');
  const [m] = await importFiles([file]);
  if (m) { A.addMediaClip(m.id, { overlay: m.type === 'image' && store.project.clips.length > 0 }); toast(`Added “${file.name}” to your video`, 'ok'); }
}

// ---------- Updates ----------
let updateBanner = null, updateInfo = null;
async function checkUpdates(manual) {
  try {
    const r = await fetch('/api/update/check'); const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    updateInfo = d;
    if (d.available) {
      const b = h('div.update-banner', h('span', { html: icon('sparkles', 16) }), h('div', h('b', `Frame ${d.latest} is available`), h('span', ` · you have ${d.current}`)),
        h('div', { style: { flex: 1 } }), h('button.btn.sm', { onclick: () => modal({ title: `What's new in ${d.latest}`, width: 520, body: h('div.release-notes', d.notes || 'Improvements and fixes.') }) }, 'What\'s new'),
        h('button.btn.primary.sm', { onclick: installUpdate }, 'Update now'));
      if (updateBanner?.isConnected) updateBanner.replaceWith(b); else document.querySelector('.home-inner')?.prepend(b);
      updateBanner = b;
    } else if (manual) toast(`You have the latest version (${d.current})`, 'ok');
  } catch (e) { if (manual) toast('Could not check for updates: ' + e.message, 'error'); }
}
async function installUpdate() {
  if (store.project) await saveNow();
  const m = modal({ title: 'Updating Frame', width: 420, dismissable: false, body: h('div', h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('span.spinner'), 'Downloading and installing the update…'), h('p.small.muted', 'Frame will restart by itself in a few seconds. Your projects are kept.')) });
  try {
    const r = await fetch('/api/update/apply', { method: 'POST', headers: { 'X-Frame-Client': '1' } }); const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    // Wait for the server to come back with the new version, then reload.
    const until = Date.now() + 120000;
    const poll = async () => {
      try { const s = await (await fetch('/api/status', { cache: 'no-store' })).json(); if (s.version && s.version !== updateInfo?.current) { location.reload(); return; } } catch {}
      if (Date.now() < until) setTimeout(poll, 1500); else { m.close(); toast('Update is taking long - please restart Frame', 'error'); }
    };
    setTimeout(poll, 3000);
  } catch (e) { m.close(); toast('Update failed: ' + e.message, 'error', 8000); }
}
function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return new Date(t).toLocaleDateString();
}

async function quickTool(kind) {
  const needsFiles = kind !== 'voice';
  const files = needsFiles ? await pickFiles(kind === 'beats' ? 'video/*,image/*,audio/*' : 'video/*,image/*,audio/*') : [];
  if (needsFiles && !files.length) return;
  const aspect = kind === 'tiktok' ? '9:16' : '16:9';
  await createProject(aspect, { files, after: async () => {
    const S = await import('./smart.js');
    if (kind === 'captions') await S.autoCaptions();
    else if (kind === 'voice') S.voiceoverDialog('Hello everyone! Today I am going to show you ');
    else if (kind === 'cutout') {
      const c = store.project.clips.find((x) => x.type === 'video' || x.type === 'image');
      if (c) { store.edit('Remove background', (p) => { p.clips.find((x) => x.id === c.id).bgRemove = true; }); store.select(c.id); store.ui.inspectorTab = 'cutout'; store.emit('select'); }
    } else if (kind === 'beats') await S.beatSync(2);
    else if (kind === 'autoedit') { store.setUI({ leftTab: 'ai' }); editorUI.panels.aiPanel.send('Watch my clips and make a great edit: keep the best moments, cut boring parts, add a title, transitions, a fitting filter and captions.'); }
    else if (kind === 'tiktok') { store.setUI({ leftTab: 'ai' }); editorUI.panels.aiPanel.send('Turn this into a vertical TikTok: blurred background, a strong hook title in the first 2 seconds, captions and punchy effects.'); }
  } });
}

async function createProject(aspect, { files = [], aiPrompt = null, after = null } = {}) {
  const p = newProject(`My video ${new Date().toLocaleDateString()}`, aspect);
  await db.put('projects', p);
  await openProject(p.id);
  if (files.length) { await importFiles(files, { addToTimeline: true }); editorUI?.timeline.fit(); }
  if (aiPrompt) { store.setUI({ leftTab: 'ai' }); editorUI.panels.aiPanel.send(aiPrompt); }
  if (after) await after();
}

async function openProject(id) {
  const p = await db.get('projects', id);
  if (!p) { toast('Project not found', 'error'); return showHome(); }
  await loadMedia(p.media || []);
  p.media = (p.media || []).filter((m) => mediaMap.has(m));
  p.clips = p.clips.filter((c) => !c.mediaId || mediaMap.has(c.mediaId));
  store.project = p;
  buildEditor();
  store.load(p);
  store.emit('resize');
  setTimeout(() => editorUI.timeline.fit(), 50);
  try { localStorage.setItem('frame.last', id); } catch {}
}

// ---------- Save ----------
let saving = false;
async function saveNow() {
  const p = store.project; if (!p || saving) return;
  saving = true;
  try {
    try {
      const c = engine.canvas;
      if (c && c.width && p.clips.length) {
        const t = document.createElement('canvas'); t.width = 320; t.height = Math.round((320 * c.height) / c.width);
        t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
        p.thumb = t.toDataURL('image/jpeg', 0.6);
      }
    } catch {}
    await db.put('projects', JSON.parse(JSON.stringify(p)));
    const el = $('.saved'); if (el) el.textContent = 'Saved';
  } catch (e) { toast('Could not save: ' + e.message, 'error'); }
  saving = false;
}
const saveSoon = debounce(saveNow, 700);
store.onSave = () => { const el = $('.saved'); if (el) el.textContent = 'Saving…'; saveSoon(); };

// ---------- Editor ----------
function buildEditor() {
  app.innerHTML = '';
  store.clearListeners();
  store.on('openExport', openExportDialog);
  store.on('openStudio', ({ kind, file }) => (kind === 'photo' ? openPhoto({ file }) : openAudio({ file })));
  const nameInput = h('input.name', { spellcheck: false, onchange: () => store.edit('Rename', (p) => { p.name = nameInput.value.trim() || 'Untitled'; }), onkeydown: (e) => { if (e.key === 'Enter') nameInput.blur(); } });
  const undoB = iconBtn('undo', 'Undo (Ctrl+Z)', () => { const l = store.undo(); if (l) toast('Undo: ' + l); });
  const redoB = iconBtn('redo', 'Redo (Ctrl+Y)', () => { const l = store.redo(); if (l) toast('Redo: ' + l); });
  const top = h('header.topbar',
    iconBtn('home', 'Back to projects', () => showHome()),
    h('div.brand', { style: { fontSize: '15px', marginRight: '6px' } }, h('div.logo', { style: { width: '24px', height: '24px', borderRadius: '7px' }, html: icon('play', 11) })),
    nameInput, h('span.saved'),
    h('div.spacer'),
    undoB, redoB, h('div.vsep'),
    iconBtn('keyboard', 'Keyboard shortcuts (?)', showShortcuts),
    iconBtn('settings', 'Settings (API keys, voice)', () => openSettings()),
    h('div.res-badge', { title: 'Canvas size' }),
    h('button.btn.ai-btn', { onclick: () => store.setUI({ leftTab: 'ai' }), title: 'AI assistant (Ctrl+J)', html: icon('sparkles', 16) + ' AI' }),
    h('button.btn.primary', { onclick: openExportDialog, html: icon('download', 16) + ' Export' }));

  const rail = h('nav.rail'), panel = h('aside.panel'), center = h('section.center'), insp = h('aside.inspector');
  const ws = h('main.workspace', rail, panel, center, insp);
  const splitter = h('div.splitter', { title: 'Drag to resize timeline' });
  const tl = h('section.tl');
  const editor = h('div.editor', top, ws, splitter, tl);
  app.append(editor);

  const preview = createPreview(center);
  const panels = createPanels(rail, panel);
  const inspector = createInspector(insp);
  const timeline = createTimeline(tl);
  editorUI = { preview, panels, inspector, timeline };

  // Restore layout sizes
  const L = (() => { try { return JSON.parse(localStorage.getItem('frame.layout') || '{}'); } catch { return {}; } })();
  const setVar = (k, v) => editor.style.setProperty(k, v + 'px');
  setVar('--tl-h', L.tl || 300); ws.style.setProperty('--left-w', (L.left || 300) + 'px'); ws.style.setProperty('--right-w', (L.right || 300) + 'px');
  const saveLayout = () => { try { localStorage.setItem('frame.layout', JSON.stringify(L)); } catch {} };
  splitter.addEventListener('pointerdown', (e) => {
    const y0 = e.clientY, h0 = tl.getBoundingClientRect().height;
    splitter.classList.add('drag');
    const mv = (ev) => { L.tl = Math.max(150, Math.min(innerHeight - 260, h0 - (ev.clientY - y0))); setVar('--tl-h', L.tl); };
    const up = () => { splitter.classList.remove('drag'); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); saveLayout(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  const vs = (side) => {
    const bar = h('div.vsplit');
    ws.style.position = 'relative'; ws.append(bar);
    const place = () => { const r = (side === 'left' ? panel : insp).getBoundingClientRect(), wr = ws.getBoundingClientRect(); bar.style.left = (side === 'left' ? r.right - wr.left - 3 : r.left - wr.left - 3) + 'px'; };
    new ResizeObserver(place).observe(ws); setTimeout(place, 50);
    bar.addEventListener('pointerdown', (e) => {
      const x0 = e.clientX, w0 = (side === 'left' ? panel : insp).getBoundingClientRect().width;
      bar.classList.add('drag');
      const mv = (ev) => { const w = Math.max(220, Math.min(520, w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX))); L[side] = w; ws.style.setProperty(side === 'left' ? '--left-w' : '--right-w', w + 'px'); place(); };
      const up = () => { bar.classList.remove('drag'); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); saveLayout(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
  };
  vs('left'); vs('right');

  const syncTop = () => {
    if (!store.project) return;
    if (document.activeElement !== nameInput) nameInput.value = store.project.name;
    nameInput.style.width = Math.min(280, Math.max(80, store.project.name.length * 8 + 24)) + 'px';
    undoB.disabled = !store.undoStack.length; redoB.disabled = !store.redoStack.length;
    document.title = `${store.project.name} - Frame`;
    const rb = top.querySelector('.res-badge'); if (rb) rb.textContent = `${store.project.aspect} · ${store.project.height > store.project.width ? store.project.width : store.project.height}p · ${store.project.fps}fps`;
  };
  store.on('project', syncTop);
}

// ---------- Shortcuts ----------
const SHORTCUTS = [
  ['Play / pause', 'Space'], ['Split at playhead', 'S  or  Ctrl+B'], ['Delete', 'Delete'], ['Ripple delete (close gap)', 'Shift+Delete'],
  ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'], ['Copy / Paste', 'Ctrl+C / Ctrl+V'], ['Duplicate', 'Ctrl+D'], ['Select all', 'Ctrl+A'],
  ['Previous / next frame', '← / →'], ['Jump 1 second', 'Shift+← / Shift+→'], ['Go to start / end', 'Home / End'],
  ['Zoom timeline', '+ / -  or  Ctrl+Wheel'], ['Fit timeline', 'Shift+Z'], ['Add marker', 'M'], ['Toggle snapping', 'N'],
  ['Loop playback', 'L'], ['Fullscreen preview', 'F'], ['AI assistant', 'Ctrl+J'], ['Command palette', 'Ctrl+K'], ['Export', 'Ctrl+E'], ['Deselect', 'Esc'],
];
function showShortcuts() {
  modal({ title: 'Keyboard shortcuts', width: 460, body: h('div.shortcuts', SHORTCUTS.flatMap(([a, k]) => [h('span', a), h('span', k.split('  ').map((x, i) => [i ? ' ' : '', h('kbd', x)]))])) });
}

document.addEventListener('keydown', (e) => {
  if (!store.project || !editorUI) return;
  if (document.querySelector('.modal-wrap')) return;
  const tag = e.target.tagName;
  if ((tag === 'INPUT' && !['range', 'checkbox', 'button'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key;
  const fps = store.project.fps;
  const run = (fn) => { e.preventDefault(); fn(); };
  if (k === ' ') return run(() => engine.toggle());
  if (ctrl && (k === 'z' || k === 'Z')) return run(() => (e.shiftKey ? store.redo() : store.undo()));
  if (ctrl && (k === 'y' || k === 'Y')) return run(() => store.redo());
  if (ctrl && k === 'c') return run(A.copySelected);
  if (ctrl && k === 'v') return run(A.paste);
  if (ctrl && k === 'd') return run(A.duplicateSelected);
  if (ctrl && k === 'a') return run(A.selectAll);
  if (ctrl && k === 'b') return run(() => A.splitAt());
  if (ctrl && k === 'e') return run(openExportDialog);
  if (ctrl && k === 'j') return run(() => store.setUI({ leftTab: 'ai' }));
  if (ctrl && k === 'k') return run(openPalette);
  if (ctrl) return;
  if (k === 's' || k === 'S') return run(() => A.splitAt());
  if (k === 'Delete' || k === 'Backspace') return run(() => A.deleteSelected(e.shiftKey));
  if (k === 'ArrowLeft') return run(() => engine.seek(store.playhead - (e.shiftKey ? 1 : 1 / fps)));
  if (k === 'ArrowRight') return run(() => engine.seek(store.playhead + (e.shiftKey ? 1 : 1 / fps)));
  if (k === 'Home') return run(() => engine.seek(0));
  if (k === 'End') return run(() => engine.seek(projectDuration(store.project)));
  if (k === '+' || k === '=') return run(() => editorUI.timeline.setZoom(store.ui.zoom * 1.4));
  if (k === '-' || k === '_') return run(() => editorUI.timeline.setZoom(store.ui.zoom / 1.4));
  if (k === 'Z' && e.shiftKey) return run(() => editorUI.timeline.fit());
  if (k === 'n' || k === 'N') return run(() => store.setUI({ snap: !store.ui.snap }));
  if (k === 'l' || k === 'L') return run(() => store.setUI({ loop: !store.ui.loop }));
  if (k === 'f' || k === 'F') return run(() => { const s = $('.stage'); document.fullscreenElement ? document.exitFullscreen() : s?.requestFullscreen(); });
  if (k === 'm' || k === 'M') return run(() => store.edit('Marker', (p) => { p.markers = p.markers || []; p.markers.push({ t: store.playhead, color: '#facc15' }); }));
  if (k === 'Escape') return run(() => store.select([]));
  if (k === '?') return run(showShortcuts);
});

// ---------- Global file drop ----------
let dragDepth = 0, dropOverlay = null;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !store.project) return;
  dragDepth++;
  if (!dropOverlay) { dropOverlay = h('div.drop-overlay', 'Drop to import'); document.body.append(dropOverlay); }
});
addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; dropOverlay?.remove(); dropOverlay = null; } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropOverlay?.remove(); dropOverlay = null;
  if (!store.project) return;
  const files = [...e.dataTransfer.files];
  const wasEmpty = !store.project.clips.length;
  await importFiles(files, { addToTimeline: wasEmpty || !!e.target.closest?.('.tl, .stage') });
  if (wasEmpty) editorUI?.timeline.fit();
});

addEventListener('beforeunload', () => { saveNow(); });

// ---------- Boot ----------
(async () => {
  await refreshStatus();
  // Debug / automation hook
  window.frame = { store, engine, A, importFiles, openProject, showHome, openPhoto, openAudio, checkUpdates };
  if (location.hash === '#photo') return openPhoto({});
  if (location.hash === '#audio') return openAudio({});
  const last = (() => { try { return localStorage.getItem('frame.last'); } catch { return null; } })();
  if (last && (await db.get('projects', last)) && location.hash !== '#home') openProject(last);
  else showHome();
})();
