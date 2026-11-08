// Export: renders every frame with the same compositor as the preview, encodes H.264 with WebCodecs,
// mixes audio offline, and lets the local server mux an MP4 with FFmpeg.
import { store, projectDuration, trackById, clipEnd } from './store.js';
import { renderFrame, itemsAt } from './renderer.js';
import { mediaMap, getAudioBuffer, seekVideo } from './media.js';
import { engine } from './engine.js';
import { h, modal, toast, fmtTime, deepClone, uid, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { audioBufferToWav } from './panels.js';
import { getStatus, refreshStatus } from './ai.js';
import { valAt, instSpeed } from './anim.js';
import { buildChain } from './audiofx.js';

const revCache = new WeakMap();
function reversed(ab) {
  if (revCache.has(ab)) return revCache.get(ab);
  const out = new AudioBuffer({ length: ab.length, numberOfChannels: ab.numberOfChannels, sampleRate: ab.sampleRate });
  for (let c = 0; c < ab.numberOfChannels; c++) { const s = ab.getChannelData(c), d = out.getChannelData(c); for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i]; }
  revCache.set(ab, out);
  return out;
}

const RES = [[480, '480p'], [720, '720p'], [1080, '1080p (Full HD)'], [1440, '1440p (2K)'], [2160, '2160p (4K)']];
const QUALITY = { low: 0.06, medium: 0.1, high: 0.16, max: 0.25 };

function dims(p, short) {
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return p.width >= p.height ? { W: even((short * p.width) / p.height), H: even(short) } : { W: even(short), H: even((short * p.height) / p.width) };
}

export function openExportDialog() {
  const p = store.project;
  if (!p.clips.length) { toast('Add something to the timeline first'); return; }
  if (store.playing) engine.pause();
  const dur = projectDuration(p);
  const name = h('input.input', { value: p.name });
  const res = h('select.select', RES.map(([v, l]) => h('option', { value: v, selected: v === 1080 }, l)));
  const fps = h('select.select', [24, 25, 30, 50, 60].map((f) => h('option', { value: f, selected: f === p.fps }, `${f} fps`)));
  const q = h('select.select', Object.keys(QUALITY).map((k) => h('option', { value: k, selected: k === 'high' }, k[0].toUpperCase() + k.slice(1))));
  const est = h('div.small.muted');
  const fmt = h('select.select', [['mp4', 'MP4 video'], ['gif', 'GIF animation'], ['mp3', 'MP3 audio only'], ['wav', 'WAV audio only'], ['png', 'PNG - current frame']].map(([v, l]) => h('option', { value: v }, l)));
  const upd = () => {
    const { W, H } = dims(p, +res.value);
    const br = W * H * +fps.value * QUALITY[q.value];
    est.textContent = `${W}×${H} · ${fmtTime(dur)} · about ${fmtBytes(((br + 192000) / 8) * dur)}`;
  };
  [res, fps, q].forEach((s) => s.addEventListener('change', upd)); upd();
  const body = h('div',
    h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px' } }, h('div.field', h('label', 'File name'), name), h('div.field', h('label', 'Format'), fmt)),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
      h('div.field', h('label', 'Resolution'), res), h('div.field', h('label', 'Frame rate'), fps), h('div.field', h('label', 'Quality'), q)),
    est,
    getStatus().ffmpeg === false ? h('div.notice', { style: { margin: '12px 0 0' } }, 'FFmpeg was not found, so MP4 export will fail. Run start.bat again and let it install FFmpeg.') : null);
  modal({ title: 'Export video', width: 520, body, actions: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: () => {
    const { W, H } = dims(p, +res.value);
    if (fmt.value === 'png') return exportFrame(W, H, name.value || p.name);
    const gfps = fmt.value === 'gif' ? Math.min(15, +fps.value) : +fps.value;
    runExport({ W, H, fps: gfps, bitrate: Math.round(W * H * gfps * QUALITY[q.value]), name: name.value || p.name, format: fmt.value });
  } }] });
  refreshStatus();
}

async function pickCodec(W, H, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser cannot encode video (WebCodecs missing). Open Frame in Chrome or Edge.');
  const codecs = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4d0034', 'avc1.4d0028', 'avc1.42003e', 'avc1.42001f'];
  for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
    for (const codec of codecs) {
      const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'annexb' }, hardwareAcceleration: hw, latencyMode: 'quality', bitrateMode: 'variable' };
      try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch {}
    }
  }
  throw new Error(`No H.264 encoder supports ${W}×${H}. Try a lower resolution.`);
}

async function renderAudio(p, dur) {
  const sr = 48000;
  const clips = p.clips.filter((c) => (c.type === 'video' || c.type === 'audio') && !c.muted && !trackById(p, c.trackId)?.muted && (c.volume ?? 1) > 0);
  if (!clips.length) return null;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(dur * sr)), sr);
  let any = false;
  for (const c of clips) {
    const m = mediaMap.get(c.mediaId);
    if (!m || m.hasAudio === false) continue;
    const ab = await getAudioBuffer(c.mediaId);
    if (!ab) continue;
    any = true;
    const src = ctx.createBufferSource();
    let offset = c.in;
    if (c.reverse) { src.buffer = reversed(ab); offset = ab.duration - (c.in + c.duration * c.speed); }
    else src.buffer = ab;
    // Gain curve: volume keyframes x fades, sampled at 100 Hz.
    const g = ctx.createGain();
    const N = Math.max(2, Math.ceil(c.duration * 100)), curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const local = (i / (N - 1)) * c.duration, remain = c.duration - local;
      let v = valAt(c, 'volume', local);
      if (c.fadeIn > 0 && local < c.fadeIn) v *= local / c.fadeIn;
      if (c.fadeOut > 0 && remain < c.fadeOut) v *= remain / c.fadeOut;
      curve[i] = v;
    }
    g.gain.setValueCurveAtTime(curve, c.start, c.duration);
    if (c.curve) {
      const rc = new Float32Array(N);
      for (let i = 0; i < N; i++) rc[i] = Math.abs(instSpeed(c, c.start + (i / (N - 1)) * c.duration));
      src.playbackRate.setValueCurveAtTime(rc, c.start, c.duration);
    } else src.playbackRate.value = c.speed;
    const chain = buildChain(ctx, c.voiceFx || 'none');
    src.connect(chain.input); chain.output.connect(g); g.connect(ctx.destination);
    chain.start(0);
    src.start(c.start, Math.max(0, offset), c.duration * c.speed + 0.05);
  }
  if (!any) return null;
  return audioBufferToWav(await ctx.startRendering());
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-Frame-Client': '1' }, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Server error ${r.status}`);
  return d;
}

async function runExport(opts) {
  const p = deepClone(store.project);
  const dur = projectDuration(p);
  const total = Math.max(1, Math.ceil(dur * opts.fps));
  let cancelled = false;
  const bar = h('i'), stage = h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, 'Preparing…'), info = h('div.small.muted', { style: { marginTop: '8px' } });
  const preview = h('canvas', { style: { width: '100%', borderRadius: '8px', background: '#000', marginBottom: '12px', aspectRatio: `${opts.W}/${opts.H}`, maxHeight: '260px', objectFit: 'contain' } });
  const dlg = modal({ title: 'Exporting…', width: 520, dismissable: false, body: h('div', preview, stage, h('div.progress', bar), info),
    actions: [{ label: 'Cancel', onClick: () => { cancelled = true; return false; } }] });
  const setP = (f, text, sub) => { bar.style.width = Math.round(f * 100) + '%'; if (text) stage.textContent = text; if (sub != null) info.textContent = sub; };

  const pool = new Map();
  try {
    await document.fonts.ready;
    const audioOnly = opts.format === 'mp3' || opts.format === 'wav';
    const cfg = audioOnly ? null : await pickCodec(opts.W, opts.H, opts.fps, opts.bitrate);
    const chunks = []; let encErr = null;
    const enc = audioOnly ? null : new VideoEncoder({ output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push(b); }, error: (e) => { encErr = e; } });
    enc?.configure(cfg);
    const canvas = document.createElement('canvas'); canvas.width = opts.W; canvas.height = opts.H;
    const ctx = canvas.getContext('2d', { alpha: false });
    const pctx = preview.getContext('2d'); preview.width = 480; preview.height = Math.round((480 * opts.H) / opts.W);

    const getEl = async (clip) => {
      const m = mediaMap.get(clip.mediaId); if (!m) return null;
      if (m.type === 'image') return m.img;
      let v = pool.get(clip.id);
      if (!v) {
        v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = m.url;
        await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); });
        pool.set(clip.id, v);
      }
      return v;
    };

    const t0 = performance.now();
    for (let i = 0; i < (audioOnly ? 0 : total); i++) {
      if (cancelled) throw new Error('cancelled');
      if (encErr) throw encErr;
      const t = Math.min(i / opts.fps, dur - 1e-4);
      const items = itemsAt(p, t);
      const srcs = new Map();
      for (const it of items) {
        if (it.clip.type !== 'video' && it.clip.type !== 'image') continue;
        const el = await getEl(it.clip);
        if (el && it.clip.type === 'video') {
          const m = mediaMap.get(it.clip.mediaId);
          await seekVideo(el, Math.min(it.t, (m.duration || it.t) - 0.001));
        }
        srcs.set(it.clip.id, el);
      }
      renderFrame(ctx, p, t, opts.W, opts.H, (clip) => srcs.get(clip.id) || null);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / opts.fps), duration: Math.round(1e6 / opts.fps) });
      enc.encode(frame, { keyFrame: i % (opts.fps * 2) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      if (i % 5 === 0 || i === total - 1) {
        const el = (performance.now() - t0) / 1000, rate = (i + 1) / el;
        pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
        setP(((i + 1) / total) * 0.85, 'Rendering video…', `Frame ${i + 1} / ${total} · ${rate.toFixed(1)} fps · about ${fmtTime((total - i - 1) / rate)} left`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (enc) { await enc.flush(); enc.close(); }
    if (cancelled) throw new Error('cancelled');

    setP(0.88, 'Mixing audio…', '');
    const wav = await renderAudio(p, dur);
    if (cancelled) throw new Error('cancelled');

    if (audioOnly && !wav) throw new Error('There is no audio in this project');
    setP(0.93, 'Saving file…', '');
    const id = uid('x');
    if (!audioOnly) await post(`/api/export/upload?id=${id}&kind=video`, new Blob(chunks));
    if (wav) await post(`/api/export/upload?id=${id}&kind=audio`, wav);
    const done = await post(`/api/export/finish?id=${id}&fps=${opts.fps}&format=${opts.format || 'mp4'}&name=${encodeURIComponent(opts.name)}`, '');
    setP(1, 'Done!', '');
    dlg.close();
    showDone(done);
  } catch (e) {
    dlg.close();
    if (e.message === 'cancelled') toast('Export cancelled');
    else { console.error(e); toast('Export failed: ' + e.message, 'error', 8000); }
  } finally {
    for (const v of pool.values()) { v.removeAttribute('src'); v.load(); }
  }
}

function showDone(d) {
  const url = `/api/export/file?name=${encodeURIComponent(d.file)}`;
  modal({ title: 'Your export is ready 🎉', width: 560, body: h('div',
    /.(mp3|wav)$/i.test(d.file) ? h('audio', { src: url, controls: true, style: { width: '100%' } }) : /.gif$/i.test(d.file) ? h('img', { src: url, style: { width: '100%', borderRadius: '10px' } }) : h('video', { src: url, controls: true, style: { width: '100%', borderRadius: '10px', background: '#000', maxHeight: '320px' } }),
    h('p.small.muted', { style: { wordBreak: 'break-all' } }, 'Saved to ' + d.path)),
    actions: [
      { label: 'Open folder', onClick: () => { post('/api/open-exports', ''); return false; } },
      { label: 'Download copy', onClick: () => { const a = h('a', { href: url, download: d.file }); a.click(); return false; } },
      { label: 'Done', primary: true },
    ] });
}

async function exportFrame(W, H, name) {
  await document.fonts.ready;
  const p = store.project, t = store.playhead;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const els = new Map();
  for (const it of itemsAt(p, t)) {
    const m = mediaMap.get(it.clip.mediaId); if (!m) continue;
    if (m.type === 'image') { els.set(it.clip.id, m.img); continue; }
    if (m.type !== 'video') continue;
    const v = document.createElement('video'); v.muted = true; v.src = m.url;
    await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); });
    await seekVideo(v, it.t); els.set(it.clip.id, v);
  }
  renderFrame(canvas.getContext('2d'), p, t, W, H, (c) => els.get(c.id) || null);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const a = h('a', { href: URL.createObjectURL(blob), download: `${name} ${fmtTime(t).replace(':', '-')}.png` }); a.click();
  toast('Frame saved as PNG', 'ok');
}
