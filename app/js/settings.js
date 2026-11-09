// App settings (API keys, AI model, voice) stored on this computer only.
import { h, modal, toast } from './util.js';

export const DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export const SUGGESTED_MODELS = ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3.5-bolt-e4b'];
const DEFAULTS = { key: '', model: DEFAULT_MODEL, temperature: 0.2, deepThink: false, seeFrames: true, geminiKey: '', voice: 'Puck', voiceStyle: 'natural', language: '' };

export const settings = {
  get() {
    try {
      const ai = JSON.parse(localStorage.getItem('frame.ai') || '{}');
      const s = JSON.parse(localStorage.getItem('frame.settings') || '{}');
      const out = { ...DEFAULTS, ...ai, ...s };
      if (/llama-3\.3-70b/.test(out.model)) out.model = DEFAULT_MODEL; // retired model
      return out;
    } catch { return { ...DEFAULTS }; }
  },
  set(v) { try { localStorage.setItem('frame.settings', JSON.stringify({ ...this.get(), ...v })); } catch {} },
};

let status = { envKey: false, geminiEnv: false, ffmpeg: false };
export async function refreshStatus() {
  try { status = await (await fetch('/api/status')).json(); } catch { status = { envKey: false, geminiEnv: false, ffmpeg: false, offline: true }; }
  return status;
}
export const getStatus = () => status;

export async function openSettings(focus) {
  const { VOICES, STYLES, speak } = await import('./gemini.js');
  await refreshStatus();
  const s = settings.get();
  const key = h('input.input', { type: 'password', value: s.key, placeholder: status.envKey ? 'Using NVIDIA_API_KEY from your computer' : 'nvapi-…', autocomplete: 'off' });
  const model = h('input.input', { value: s.model, list: 'ai-models' });
  const dl = h('datalist#ai-models', SUGGESTED_MODELS.map((m) => h('option', { value: m })));
  const deep = h('input', { type: 'checkbox', checked: s.deepThink });
  const see = h('input', { type: 'checkbox', checked: s.seeFrames });
  const gkey = h('input.input', { type: 'password', value: s.geminiKey, placeholder: status.geminiEnv ? 'Using GEMINI_API_KEY from .env' : 'AIza…', autocomplete: 'off' });
  const voice = h('select.select', VOICES.map(([v, d]) => h('option', { value: v, selected: v === s.voice }, `${v} - ${d}`)));
  const style = h('select.select', Object.entries(STYLES).map(([k, d]) => h('option', { value: k, selected: k === s.voiceStyle }, d)));
  const nStatus = h('div.small.muted', { style: { minHeight: '18px' } });
  const gStatus = h('div.small.muted', { style: { minHeight: '18px' } });
  const save = () => settings.set({ key: key.value.trim(), model: model.value.trim() || DEFAULT_MODEL, deepThink: deep.checked, seeFrames: see.checked, geminiKey: gkey.value.trim(), voice: voice.value, voiceStyle: style.value });

  const testN = h('button.btn.sm', { onclick: async () => {
    nStatus.textContent = 'Testing…';
    try {
      const r = await fetch('/api/ai/models', { headers: key.value ? { 'X-NVIDIA-Key': key.value } : {} });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || d.error || d.detail || r.status);
      nStatus.textContent = `✓ Key works (${(d.data || []).length} models listed).`;
    } catch (e) { nStatus.textContent = '✗ ' + e.message; }
  } }, 'Test key');
  const testG = h('button.btn.sm', { onclick: async () => {
    save(); gStatus.textContent = 'Generating a test voice…';
    try {
      const r = await speak('Hello everyone! This is your Frame voice.', { voice: voice.value, style: style.value });
      gStatus.textContent = `✓ Works (${r.duration.toFixed(1)}s of audio).`;
      new Audio(URL.createObjectURL(r.blob)).play();
    } catch (e) { gStatus.textContent = '✗ ' + e.message; }
  } }, 'Test voice');

  const section = (title, sub, ...kids) => h('div.set-section', h('div.set-title', h('b', title), sub ? h('span.small.muted', sub) : null), ...kids);
  modal({ title: 'Settings', width: 580, body: h('div',
    section('Frame AI (NVIDIA)', 'Edits your video, watches your clips',
      h('div.field', h('label', 'NVIDIA API key'), key, h('div.hint', { html: 'Free at <a href="https://build.nvidia.com" target="_blank" rel="noopener">build.nvidia.com</a> → profile → API Keys.' })),
      h('div.field', h('label', 'Model'), model, dl, h('div.hint', 'Default: Nemotron 3.5 Super VL - fast and can see images. Nemotron 3 Ultra is smartest but slower.')),
      h('label.check', see, ' Let the AI look at video frames (understands what is in your clips)'),
      h('label.check', deep, ' Deep thinking (slower, better for big edits)'),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' } }, testN, nStatus)),
    section('AI Voice (Gemini)', `Model: gemini-3.1-flash-live-preview`,
      h('div.field', h('label', 'Gemini API key'), gkey, h('div.hint', { html: 'Free at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Used for AI voiceovers and auto captions.' })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } }, h('div.field', h('label', 'Default voice'), voice), h('div.field', h('label', 'Default style'), style)),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, testG, gStatus)),
    section('Your data', 'Projects, photos, audio and settings',
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button.btn.sm', { onclick: async () => {
          const B = await import('./backup.js'); toast('Creating backup…');
          const blob = await B.createBackup();
          h('a', { href: URL.createObjectURL(blob), download: `Frame backup ${new Date().toISOString().slice(0, 10)}.framebackup` }).click();
          toast('Backup saved', 'ok');
        } }, 'Download backup'),
        h('button.btn.sm', { onclick: async () => {
          const B = await import('./backup.js');
          const f = await new Promise((r) => { const i = h('input', { type: 'file', accept: '.framebackup' }); i.onchange = () => r(i.files[0]); i.click(); });
          if (!f) return;
          try { const n = await B.restoreBackup(f); toast(`Restored ${n} item(s) - reloading`, 'ok'); setTimeout(() => { location.hash = '#home'; location.reload(); }, 900); }
          catch (e) { toast('Restore failed: ' + e.message, 'error', 6000); }
        } }, 'Restore backup…')),
      h('div.hint', 'A backup file contains all your projects and imported media. Use it to move Frame to another PC.')),
    h('p.small.muted', { style: { margin: '10px 0 0' } }, 'Keys are stored only on this computer.')),
  actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => { save(); toast('Settings saved', 'ok'); } }] });
  if (focus === 'gemini') setTimeout(() => gkey.focus(), 60);
}
