// Multi-element templates (titles, lower thirds, social overlays). Each adds several clips at once.
import { store, newClip, addTrack, isFree } from './store.js';
import { DEFAULT_TEXT, TEXT_STYLES } from './presets.js';

const T = (content, t, opts = {}) => ({ kind: 'text', content, t: { ...DEFAULT_TEXT, ...t }, ...opts });
const S = (shape, color, opts = {}) => ({ kind: 'shape', shape, color, ...opts });
const E = (emoji, opts = {}) => ({ kind: 'sticker', emoji, ...opts });

export const TEMPLATES = {
  lowerThird: { name: 'Lower third', icon: '▭', dur: 5, items: (tx) => [
    S('round', '#8b5cf6', { x: 0.27, y: 0.82, scale: 1, sx: 1.3, sy: 0.33, anim: { in: 'slideRight', inDur: 0.5, out: 'slideLeft' } }),
    T(tx[0] || 'Your Name', { font: 'Montserrat', size: 64, bold: true, align: 'left', shadow: 0 }, { x: 0.27, y: 0.8, anim: { in: 'slideRight', inDur: 0.6, out: 'fade' } }),
    T(tx[1] || 'Creator · Editor', { font: 'Inter', size: 34, bold: false, align: 'left', color: '#e9e5ff', shadow: 0 }, { x: 0.27, y: 0.865, anim: { in: 'fade', inDur: 0.8, out: 'fade' } }),
  ] },
  subscribe: { name: 'Subscribe button', icon: '🔔', dur: 4, items: (tx) => [
    S('round', '#ef4444', { x: 0.5, y: 0.82, sx: 1.05, sy: 0.3, anim: { in: 'pop', inDur: 0.45, out: 'zoomOut', loop: 'pulse' } }),
    T(tx[0] || 'SUBSCRIBE', { font: 'Montserrat', size: 62, bold: true, shadow: 0, letterSpacing: 2 }, { x: 0.5, y: 0.82, anim: { in: 'pop', inDur: 0.45, out: 'zoomOut', loop: 'pulse' } }),
    E('🔔', { x: 0.69, y: 0.8, scale: 0.35, anim: { in: 'pop', inDur: 0.6, loop: 'swing' } }),
    E('👆', { x: 0.58, y: 0.9, scale: 0.3, anim: { in: 'slideUp', inDur: 0.6, loop: 'float' }, delay: 0.8 }),
  ] },
  bigTitle: { name: 'Big title', icon: 'T', dur: 4, items: (tx) => [
    T(tx[0] || 'THE BIG DAY', { font: 'Bebas Neue', size: 220, bold: false, letterSpacing: 8, shadow: 0.5 }, { y: 0.46, anim: { in: 'zoomOut', inDur: 0.8, out: 'fade', loop: 'kenburns' } }),
    T(tx[1] || 'a short film', { font: 'Playfair Display', size: 56, bold: false, italic: true, shadow: 0.4 }, { y: 0.6, anim: { in: 'fade', inDur: 1.2, out: 'fade' }, delay: 0.5 }),
    { kind: 'effect', effect: 'letterbox' },
  ] },
  chapter: { name: 'Chapter', icon: '#', dur: 3, items: (tx) => [
    T(tx[0] || 'CHAPTER 1', { font: 'Inter', size: 40, bold: true, letterSpacing: 10, color: '#a5b4fc', shadow: 0 }, { y: 0.43, anim: { in: 'slideUp', inDur: 0.5, out: 'fade' } }),
    T(tx[1] || 'The Beginning', { font: 'Montserrat', size: 120, bold: true, shadow: 0.3 }, { y: 0.53, anim: { in: 'blur', inDur: 0.7, out: 'fade' } }),
  ] },
  countdown: { name: 'Countdown 3-2-1', icon: '3', dur: 3, items: () => ['3', '2', '1'].map((n, i) => T(n, { font: 'Anton', size: 360, bold: false, color: '#ffffff', strokeWidth: 0, shadow: 0.6 }, { delay: i, dur: 1, anim: { in: 'pop', inDur: 0.35, out: 'zoomIn', outDur: 0.3 } })) },
  quote: { name: 'Quote', icon: '“', dur: 5, items: (tx) => [
    T('“', { font: 'Playfair Display', size: 260, bold: true, color: '#8b5cf6', shadow: 0 }, { y: 0.3, anim: { in: 'fade', inDur: 0.6 } }),
    T(tx[0] || 'Creativity is intelligence\nhaving fun.', { font: 'Playfair Display', size: 72, italic: true, bold: false, lineHeight: 1.3 }, { y: 0.5, anim: { in: 'typewriter', inDur: 2 } }),
    T(tx[1] || '- Albert Einstein', { font: 'Inter', size: 36, color: '#cbd5e1', shadow: 0 }, { y: 0.66, anim: { in: 'fade', inDur: 0.6 }, delay: 2 }),
  ] },
  breaking: { name: 'Breaking news', icon: '!', dur: 5, items: (tx) => [
    S('rect', '#dc2626', { x: 0.5, y: 0.86, sx: 4.8, sy: 0.24, anim: { in: 'slideRight', inDur: 0.4 } }),
    S('rect', '#ffffff', { x: 0.13, y: 0.86, sx: 0.6, sy: 0.24, anim: { in: 'slideRight', inDur: 0.4 } }),
    T('BREAKING', { font: 'Oswald', size: 44, bold: true, color: '#dc2626', shadow: 0 }, { x: 0.13, y: 0.86, anim: { in: 'slideRight', inDur: 0.45 } }),
    T(tx[0] || 'Something amazing just happened', { font: 'Oswald', size: 48, bold: false, align: 'left', shadow: 0 }, { x: 0.52, y: 0.86, anim: { in: 'wipe', inDur: 0.8 } }),
  ] },
  location: { name: 'Location', icon: '📍', dur: 4, items: (tx) => [
    E('📍', { x: 0.12, y: 0.12, scale: 0.3, anim: { in: 'drop', inDur: 0.7 } }),
    T(tx[0] || 'Paris, France', { font: 'Montserrat', size: 60, bold: true, align: 'left' }, { x: 0.3, y: 0.12, anim: { in: 'slideRight', inDur: 0.5, out: 'fade' } }),
  ] },
  like: { name: 'Like & follow', icon: '❤', dur: 3, items: (tx) => [
    E('❤️', { x: 0.42, y: 0.5, scale: 0.6, anim: { in: 'pop', inDur: 0.4, loop: 'heartbeat' } }),
    T(tx[0] || 'Like & Follow', { font: 'Poppins', size: 90, bold: true, strokeWidth: 6 }, { x: 0.6, y: 0.5, anim: { in: 'pop', inDur: 0.5 } }),
    { kind: 'effect', effect: 'hearts' },
  ] },
  endScreen: { name: 'End screen', icon: '■', dur: 6, items: (tx) => [
    { kind: 'color', gradient: ['#0f172a', '#312e81'] },
    T(tx[0] || 'Thanks for watching!', { font: 'Montserrat', size: 110, bold: true }, { y: 0.4, anim: { in: 'pop', inDur: 0.5 } }),
    T(tx[1] || 'See you in the next one', { font: 'Inter', size: 48, color: '#c7d2fe', shadow: 0 }, { y: 0.55, anim: { in: 'fade', inDur: 0.8 }, delay: 0.5 }),
    { kind: 'effect', effect: 'sparkle' },
  ] },
  meme: { name: 'Meme top/bottom', icon: 'M', dur: 4, items: (tx) => [
    T(tx[0] || 'WHEN THE CODE WORKS', { ...TEXT_STYLES[2].t, font: 'Anton', size: 110, color: '#ffffff', strokeWidth: 10 }, { y: 0.1 }),
    T(tx[1] || 'ON THE FIRST TRY', { ...TEXT_STYLES[2].t, font: 'Anton', size: 110, color: '#ffffff', strokeWidth: 10 }, { y: 0.9 }),
  ] },
  callout: { name: 'Callout arrow', icon: '➜', dur: 3, items: (tx) => [
    S('arrow', '#facc15', { x: 0.62, y: 0.42, scale: 0.6, rotation: 150, anim: { in: 'pop', inDur: 0.4, loop: 'float' } }),
    T(tx[0] || 'Look at this!', { font: 'Permanent Marker', size: 90, bold: false, color: '#facc15', shadow: 0.6 }, { x: 0.75, y: 0.3, anim: { in: 'pop', inDur: 0.45 } }),
  ] },
};

export function addTemplate(key, { start = store.playhead, texts = [] } = {}) {
  const tpl = TEMPLATES[key]; if (!tpl) return [];
  const items = tpl.items(Array.isArray(texts) ? texts : [texts]);
  const ids = [];
  store.edit(`Template: ${tpl.name}`, (p) => {
    const extra = [];
    // Later items stack on top: insert each new track right above the previous one.
    const baseIdx = p.tracks.findIndex((t) => t.fx) >= 0 ? p.tracks.findIndex((t) => t.fx) + 1 : 0;
    for (const it of items) {
      const dur = it.dur ?? tpl.dur - (it.delay || 0);
      let c;
      if (it.kind === 'text') c = newClip('text', { name: it.content.slice(0, 30), text: { ...it.t, content: it.content } });
      else if (it.kind === 'shape') { c = newClip('shape', { name: it.shape, shape: it.shape, fill: { color: it.color } }); }
      else if (it.kind === 'sticker') c = newClip('sticker', { name: it.emoji, sticker: it.emoji });
      else if (it.kind === 'effect') c = newClip('effect', { name: it.effect, effect: it.effect, intensity: 1 });
      else if (it.kind === 'color') c = newClip('color', { name: 'Background', fill: { gradient: it.gradient } });
      c.start = start + (it.delay || 0); c.duration = Math.max(0.3, dur);
      if (it.x != null) c.transform.x = it.x;
      if (it.y != null) c.transform.y = it.y;
      if (it.scale != null) c.transform.scale = it.scale;
      if (it.rotation != null) c.transform.rotation = it.rotation;
      if (it.sx) { c.shapeW = it.sx; c.shapeH = it.sy; }
      if (it.anim) c.anim = { ...c.anim, ...it.anim };
      c.template = key;
      if (it.kind === 'color') { extra.push(c); continue; }
      if (it.kind === 'effect') {
        let ft = p.tracks.find((t) => t.fx && isFree(p, t.id, c.start, c.start + c.duration));
        if (!ft) { ft = addTrack(p, 'visual', 0); ft.fx = true; ft.name = 'Effects'; }
        c.trackId = ft.id; p.clips.push(c); ids.push(c.id); continue;
      }
      const tr = addTrack(p, 'visual', baseIdx);
      c.trackId = tr.id; p.clips.push(c);
      ids.push(c.id);
    }
    // backgrounds go below the template's other parts
    for (const c of extra) { const bt = addTrack(p, 'visual', p.tracks.findIndex((t) => t.main)); c.trackId = bt.id; p.clips.push(c); ids.push(c.id); }
  });
  store.select(ids);
  return ids;
}
