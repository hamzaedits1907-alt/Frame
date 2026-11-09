// Full backup / restore of everything Frame stores in the browser (projects, media, photos, audio,
// settings). Format: "FRMB" + uint32 header length + JSON header + concatenated binary blobs.
import { db } from './db.js';

const STORES = ['projects', 'media', 'photos', 'audios'];
const LS_KEYS = ['frame.settings', 'frame.ai', 'frame.layout', 'frame.last'];

/** Replace Blob values with {__blob: index} placeholders, collecting the blobs. */
function strip(value, blobs) {
  if (value instanceof Blob) { blobs.push(value); return { __blob: blobs.length - 1, type: value.type, name: value.name || null }; }
  if (Array.isArray(value)) return value.map((v) => strip(v, blobs));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) { if (typeof v !== 'function') out[k] = strip(v, blobs); }
    return out;
  }
  if (typeof value === 'number' && !isFinite(value)) return { __num: String(value) };
  return value;
}
function unstrip(value, getBlob) {
  if (Array.isArray(value)) return value.map((v) => unstrip(v, getBlob));
  if (value && typeof value === 'object') {
    if ('__blob' in value) { const b = getBlob(value.__blob, value.type); return value.name ? new File([b], value.name, { type: value.type }) : b; }
    if ('__num' in value) return Number(value.__num);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unstrip(v, getBlob);
    return out;
  }
  return value;
}

export async function counts() {
  const c = {};
  for (const s of STORES) c[s] = (await db.all(s)).length;
  return c;
}

export async function createBackup() {
  const blobs = [], data = {};
  for (const s of STORES) data[s] = strip(await db.all(s), blobs);
  const ls = {};
  for (const k of LS_KEYS) { try { const v = localStorage.getItem(k); if (v != null) ls[k] = v; } catch {} }
  const header = { format: 'frame-backup', version: 1, created: Date.now(), data, localStorage: ls, sizes: blobs.map((b) => b.size) };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8);
  head.set([70, 82, 77, 66]); new DataView(head.buffer).setUint32(4, json.length, true);
  return new Blob([head, json, ...blobs], { type: 'application/octet-stream' });
}

/** Restore a backup. mode 'merge' keeps existing items (same id is overwritten). */
export async function restoreBackup(blob, { includeSettings = true } = {}) {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (String.fromCharCode(...head.slice(0, 4)) !== 'FRMB') throw new Error('This is not a Frame backup file.');
  const len = new DataView(head.buffer).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(await blob.slice(8, 8 + len).arrayBuffer()));
  const offsets = []; let o = 8 + len;
  for (const s of header.sizes) { offsets.push(o); o += s; }
  const getBlob = (i, type) => blob.slice(offsets[i], offsets[i] + header.sizes[i], type || '');
  let n = 0;
  for (const s of STORES) {
    for (const rec of unstrip(header.data[s] || [], getBlob)) {
      // Materialise the slice so it survives in IndexedDB on its own.
      await db.put(s, await materialise(rec));
      n++;
    }
  }
  if (includeSettings) for (const [k, v] of Object.entries(header.localStorage || {})) { try { if (localStorage.getItem(k) == null || k !== 'frame.last') localStorage.setItem(k, v); } catch {} }
  return n;
}
async function materialise(v) {
  if (v instanceof Blob) { const buf = await v.arrayBuffer(); return v instanceof File ? new File([buf], v.name, { type: v.type }) : new Blob([buf], { type: v.type }); }
  if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await materialise(x)); return out; }
  if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = await materialise(x); return out; }
  return v;
}

export const isNativeWindow = () => !!(window.chrome && window.chrome.webview);
