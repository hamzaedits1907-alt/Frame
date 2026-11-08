// Media library: import files, generate thumbnails and waveforms, keep object URLs.
import { db } from './db.js';
import { uid } from './util.js';

export const mediaMap = new Map(); // id -> runtime media record

export function kindOf(file) {
  const t = file.type || '';
  const n = (file.name || '').toLowerCase();
  if (t.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(n)) return 'audio';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(n)) return 'image';
  return null;
}

const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { cleanup(); res(); };
  const bad = () => { cleanup(); rej(new Error('Could not load media (unsupported format?)')); };
  const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok, { once: true }); el.addEventListener('error', bad, { once: true });
});

export async function seekVideo(v, t) {
  t = Math.max(0, Math.min(t, (v.duration || t) - 0.001));
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  const p = new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(to); res(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
  });
  v.currentTime = t;
  await p;
}

async function makeThumbs(v, count = 12, height = 72) {
  const w = Math.max(1, Math.round((v.videoWidth / v.videoHeight) * height)) || 128;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = height;
  const ctx = cv.getContext('2d');
  const out = [];
  const n = Math.max(1, Math.min(count, Math.ceil(v.duration / 1.5)));
  for (let i = 0; i < n; i++) {
    await seekVideo(v, (v.duration * (i + 0.5)) / n);
    ctx.drawImage(v, 0, 0, w, height);
    out.push(cv.toDataURL('image/jpeg', 0.7));
  }
  return out;
}

export async function decodeAudio(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, 48000);
  return await ctx.decodeAudioData(buf);
}

function computePeaks(ab, perSec = 40) {
  const ch0 = ab.getChannelData(0);
  const ch1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null;
  const total = Math.max(1, Math.min(Math.ceil(ab.duration * perSec), 20000));
  const step = Math.max(1, Math.floor(ch0.length / total));
  const peaks = new Array(total);
  for (let i = 0; i < total; i++) {
    let m = 0; const s = i * step, e = Math.min(ch0.length, s + step);
    for (let j = s; j < e; j += 4) { const v = Math.abs(ch0[j]) + (ch1 ? Math.abs(ch1[j]) : 0); if (v > m) m = v; }
    peaks[i] = Math.round(Math.min(1, ch1 ? m / 2 : m) * 1000) / 1000;
  }
  return { peaks, peaksPerSec: total / ab.duration };
}

function register(rec) {
  const r = { ...rec, url: URL.createObjectURL(rec.blob) };
  if (rec.type === 'image') {
    r.img = new Image();
    r.img.src = r.url;
    r.ready = r.img.decode().catch(() => {});
  } else r.ready = Promise.resolve();
  mediaMap.set(rec.id, r);
  return r;
}

/** Import a File into IndexedDB and return the runtime record. */
export async function importFile(file, onProgress) {
  const type = kindOf(file);
  if (!type) throw new Error(`${file.name}: unsupported file type`);
  const rec = { id: uid('m_'), name: file.name, type, mime: file.type, size: file.size, blob: file, duration: 0, width: 0, height: 0, hasAudio: type !== 'image', thumbs: [], peaks: null, peaksPerSec: 0, added: Date.now() };
  const url = URL.createObjectURL(file);
  try {
    if (type === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = url;
      await once(v, 'loadeddata');
      rec.duration = v.duration; rec.width = v.videoWidth; rec.height = v.videoHeight;
      onProgress?.('thumbnails');
      rec.thumbs = await makeThumbs(v);
      v.removeAttribute('src'); v.load();
    } else if (type === 'image') {
      const img = new Image(); img.src = url; await img.decode();
      rec.width = img.naturalWidth; rec.height = img.naturalHeight; rec.duration = Infinity;
      const cv = document.createElement('canvas'); const hh = 72; cv.height = hh; cv.width = Math.max(1, Math.round((img.naturalWidth / img.naturalHeight) * hh));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      rec.thumbs = [cv.toDataURL('image/jpeg', 0.75)];
    } else {
      const a = document.createElement('audio'); a.preload = 'metadata'; a.src = url;
      await once(a, 'loadedmetadata');
      rec.duration = a.duration;
    }
    if (type !== 'image' && file.size < 600 * 1024 * 1024) {
      onProgress?.('waveform');
      try {
        const ab = await decodeAudio(file);
        Object.assign(rec, computePeaks(ab));
        rec.hasAudio = true;
        if (type === 'audio' && !isFinite(rec.duration)) rec.duration = ab.duration;
      } catch { rec.hasAudio = type === 'audio'; }
    }
  } finally { URL.revokeObjectURL(url); }
  if (!isFinite(rec.duration) && type !== 'image') throw new Error(`${file.name}: could not read duration`);
  await db.put('media', rec);
  return register(rec);
}

export async function loadMedia(ids) {
  for (const id of ids) {
    if (mediaMap.has(id)) continue;
    const rec = await db.get('media', id);
    if (rec) register(rec);
  }
  await Promise.all(ids.map((id) => mediaMap.get(id)?.ready));
}

export async function removeMedia(id) {
  const m = mediaMap.get(id);
  if (m) URL.revokeObjectURL(m.url);
  mediaMap.delete(id);
  await db.del('media', id);
}

/** Persist extra info (analysis, transcript, beats) on a media record. */
export async function saveMediaMeta(id, patch) {
  const m = mediaMap.get(id);
  if (m) Object.assign(m, patch);
  const rec = await db.get('media', id);
  if (rec) await db.put('media', { ...rec, ...patch });
}

/** Grab frames from a video as small JPEG data URLs. */
export async function sampleFrames(id, times, width = 384) {
  const m = mediaMap.get(id); if (!m) return [];
  if (m.type === 'image') {
    const cv = document.createElement('canvas'); cv.width = width; cv.height = Math.round((width * m.height) / m.width);
    cv.getContext('2d').drawImage(m.img, 0, 0, cv.width, cv.height);
    return [{ t: 0, url: cv.toDataURL('image/jpeg', 0.7) }];
  }
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = m.url;
  await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); });
  const cv = document.createElement('canvas'); cv.width = width; cv.height = Math.round((width * (v.videoHeight || 9)) / (v.videoWidth || 16));
  const ctx = cv.getContext('2d'); const out = [];
  for (const t of times) { await seekVideo(v, t); ctx.drawImage(v, 0, 0, cv.width, cv.height); out.push({ t, url: cv.toDataURL('image/jpeg', 0.65) }); }
  v.removeAttribute('src'); v.load();
  return out;
}

/** Cached decoded audio for export / silence detection. */
const audioCache = new Map();
export async function getAudioBuffer(id) {
  if (audioCache.has(id)) return audioCache.get(id);
  const m = mediaMap.get(id);
  if (!m) return null;
  const p = decodeAudio(m.blob).catch(() => null);
  audioCache.set(id, p);
  return p;
}
export function clearAudioCache() { audioCache.clear(); }

/** Save a canvas as an image media item (freeze frame, snapshots). */
export async function importCanvas(canvas, name) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return importFile(new File([blob], name, { type: 'image/png' }));
}
