// Gemini Live (gemini-3.1-flash-live-preview ONLY): AI voiceover (text -> speech) and speech -> text for captions.
import { settings } from './settings.js';

export const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export const VOICES = [
  ['Puck', 'Upbeat, male'], ['Kore', 'Firm, female'], ['Charon', 'Informative, male'], ['Aoede', 'Breezy, female'],
  ['Fenrir', 'Excitable, male'], ['Leda', 'Youthful, female'], ['Orus', 'Firm, male'], ['Zephyr', 'Bright, female'],
  ['Callirrhoe', 'Easy-going, female'], ['Autonoe', 'Bright, female'], ['Enceladus', 'Breathy, male'], ['Iapetus', 'Clear, male'],
  ['Umbriel', 'Easy-going, male'], ['Algieba', 'Smooth, male'], ['Despina', 'Smooth, female'], ['Erinome', 'Clear, female'],
  ['Algenib', 'Gravelly, male'], ['Rasalgethi', 'Informative, male'], ['Laomedeia', 'Upbeat, female'], ['Achernar', 'Soft, female'],
  ['Alnilam', 'Firm, male'], ['Schedar', 'Even, male'], ['Gacrux', 'Mature, female'], ['Pulcherrima', 'Forward, female'],
  ['Achird', 'Friendly, male'], ['Zubenelgenubi', 'Casual, male'], ['Vindemiatrix', 'Gentle, female'], ['Sadachbia', 'Lively, male'],
  ['Sadaltager', 'Knowledgeable, male'], ['Sulafat', 'Warm, female'],
];
export const STYLES = {
  natural: 'natural, friendly and clear',
  youtuber: 'energetic YouTuber, enthusiastic and punchy',
  narrator: 'calm documentary narrator, warm and deep',
  news: 'professional news anchor, crisp and confident',
  excited: 'very excited and hyped',
  calm: 'calm, soft and relaxing',
  whisper: 'soft whisper, intimate',
  dramatic: 'dramatic movie-trailer voice',
  storyteller: 'cozy storyteller',
};

let envKeyCache = null;
export async function geminiKey() {
  const k = settings.get().geminiKey;
  if (k) return k;
  if (envKeyCache == null) { try { envKeyCache = (await (await fetch('/api/gemini-key')).json()).key || ''; } catch { envKeyCache = ''; } }
  return envKeyCache;
}

/** Opens a Live session. Resolves once setup is complete. */
function openSession(setupExtra, onMsg) {
  return new Promise(async (resolve, reject) => {
    const key = await geminiKey();
    if (!key) { reject(new Error('Add your Gemini API key in Settings first (free at aistudio.google.com).')); return; }
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(key)}`);
    let ready = false;
    const timer = setTimeout(() => { if (!ready) { ws.close(); reject(new Error('Gemini did not respond (timeout).')); } }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: `models/${GEMINI_MODEL}`, ...setupExtra } }));
    ws.onmessage = async (ev) => {
      const txt = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let msg; try { msg = JSON.parse(txt); } catch { return; }
      if (msg.setupComplete && !ready) { ready = true; clearTimeout(timer); resolve(ws); return; }
      if (msg.error) { reject(new Error(msg.error.message || 'Gemini error')); return; }
      onMsg(msg);
    };
    ws.onerror = () => { clearTimeout(timer); if (!ready) reject(new Error('Could not connect to Gemini. Check your API key and internet connection.')); };
    ws.onclose = (ev) => { clearTimeout(timer); if (!ready) reject(new Error(ev.reason || `Gemini closed the connection (${ev.code}). Check your API key.`)); else onMsg({ _closed: ev }); };
  });
}

const b64ToBytes = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const bytesToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

function pcmToWav(chunks, rate = 24000) {
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + len), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + len, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, len, true);
  let o = 44; for (const c of chunks) { u8.set(c, o); o += c.length; }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Text to speech. Returns { blob (wav), transcript, duration }.
 */
export async function speak(text, { voice = 'Puck', style = 'natural', onProgress } = {}) {
  const chunks = []; let transcript = ''; let done, fail;
  const finished = new Promise((r, j) => { done = r; fail = j; });
  const ws = await openSession({
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }, thinkingConfig: { thinkingLevel: 'minimal' } },
    systemInstruction: { parts: [{ text: `You are a professional voice-over artist. Speaking style: ${STYLES[style] || style}. When the user sends a script, read it aloud EXACTLY word for word, in the language it is written in. Do not add greetings, comments, questions or anything else. Do not answer the script - just perform it.` }] },
    outputAudioTranscription: {},
  }, (msg) => {
    const sc = msg.serverContent;
    if (msg._closed) { if (chunks.length) done(); else fail(new Error('Gemini closed the connection before speaking.')); return; }
    if (!sc) return;
    for (const part of sc.modelTurn?.parts || []) if (part.inlineData?.data) { chunks.push(b64ToBytes(part.inlineData.data)); onProgress?.(chunks.length); }
    if (sc.outputTranscription?.text) transcript += sc.outputTranscription.text;
    if (sc.turnComplete || sc.generationComplete) done();
  });
  const script = `Read this script aloud exactly:\n\n${text}`;
  ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: script }] }], turnComplete: true } }));
  // Fallback for sessions that only react to realtime input.
  const nudge = setTimeout(() => { if (!chunks.length) ws.send(JSON.stringify({ realtimeInput: { text: script } })); }, 7000);
  const timeout = setTimeout(() => (chunks.length ? done() : fail(new Error('Gemini did not produce audio.'))), 90000);
  try { await finished; } finally { clearTimeout(nudge); clearTimeout(timeout); try { ws.close(); } catch {} }
  const bytes = chunks.reduce((s, c) => s + c.length, 0);
  return { blob: pcmToWav(chunks), transcript: transcript.trim(), duration: bytes / 2 / 24000 };
}

// ---- Speech to text ---------------------------------------------------------------------------
async function to16kMono(ab, from, to) {
  const len = Math.max(1, Math.ceil((to - from) * 16000));
  const ctx = new OfflineAudioContext(1, len, 16000);
  const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination);
  src.start(0, from, to - from);
  const out = (await ctx.startRendering()).getChannelData(0);
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, out[i] * 32767));
  return new Uint8Array(pcm.buffer);
}

/** Split an AudioBuffer range into speech segments (source seconds) using energy. */
export function speechSegments(ab, from, to, { thresholdDb = -40, minGap = 0.35, maxLen = 12 } = {}) {
  const sr = ab.sampleRate, ch = ab.getChannelData(0), win = Math.round(sr * 0.02), thr = Math.pow(10, thresholdDb / 20);
  const segs = []; let cur = null, quiet = 0;
  for (let t = from; t < to; t += 0.02) {
    const i0 = Math.floor(t * sr); let s = 0, n = 0;
    for (let i = i0; i < Math.min(ch.length, i0 + win); i += 2) { s += ch[i] * ch[i]; n++; }
    const loud = Math.sqrt(s / Math.max(1, n)) > thr;
    if (loud) { if (!cur) cur = { start: Math.max(from, t - 0.1), end: t }; cur.end = t + 0.02; quiet = 0; if (cur.end - cur.start > maxLen) { segs.push(cur); cur = null; } }
    else if (cur) { quiet += 0.02; if (quiet > minGap) { cur.end = Math.min(to, cur.end + 0.12); segs.push(cur); cur = null; quiet = 0; } }
  }
  if (cur) segs.push(cur);
  return segs.filter((s) => s.end - s.start > 0.25);
}

/** Transcribe speech segments. Returns [{start, end, text}] in source seconds. */
export async function transcribe(ab, segs, { onProgress, language } = {}) {
  let curText = '', turnDone = null;
  const ws = await openSession({
    generationConfig: { responseModalities: ['AUDIO'], thinkingConfig: { thinkingLevel: 'minimal' } },
    systemInstruction: { parts: [{ text: `You are a silent listener used only for transcription. Do not answer. If you must respond, say only "ok".${language ? ' The speech language is ' + language + '.' : ''}` }] },
    inputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  }, (msg) => {
    const sc = msg.serverContent; if (!sc) { if (msg._closed) turnDone?.(); return; }
    if (sc.inputTranscription?.text) { curText += sc.inputTranscription.text; idle(); }
    if (sc.turnComplete) turnDone?.();
  });
  let idleTimer = null;
  const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => turnDone?.(), 1800); };
  const out = [];
  try {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      onProgress?.(i / segs.length, `Listening ${i + 1}/${segs.length}`);
      const pcm = await to16kMono(ab, s.start, s.end);
      curText = '';
      const wait = new Promise((r) => { turnDone = r; });
      ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      for (let o = 0; o < pcm.length; o += 16000) ws.send(JSON.stringify({ realtimeInput: { audio: { data: bytesToB64(pcm.subarray(o, o + 16000)), mimeType: 'audio/pcm;rate=16000' } } }));
      ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
      const hard = setTimeout(() => turnDone?.(), 20000);
      await wait; clearTimeout(hard); clearTimeout(idleTimer);
      const text = curText.replace(/\s+/g, ' ').trim();
      if (text && ws.readyState === 1) out.push({ start: s.start, end: s.end, text });
      if (ws.readyState !== 1) throw new Error('Gemini disconnected during transcription.');
    }
  } finally { try { ws.close(); } catch {} }
  onProgress?.(1, 'Done');
  return out;
}

/** Break transcript segments into short caption chunks with estimated word timing. */
export function toCaptionChunks(segs, maxWords = 6, maxDur = 2.6) {
  const caps = [];
  for (const s of segs) {
    const words = s.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const totalChars = words.reduce((a, w) => a + w.length + 1, 0);
    let t = s.start, group = [], gStart = s.start;
    const per = (s.end - s.start) / totalChars;
    for (const w of words) {
      group.push(w); t += (w.length + 1) * per;
      if (group.length >= maxWords || t - gStart >= maxDur || /[.!?]$/.test(w)) { caps.push({ start: gStart, end: t, text: group.join(' ') }); group = []; gStart = t; }
    }
    if (group.length) caps.push({ start: gStart, end: s.end, text: group.join(' ') });
  }
  return caps;
}
