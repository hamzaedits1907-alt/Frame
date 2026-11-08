// Playback engine: keeps <video>/<audio> elements in sync with the timeline and draws the preview.
import { store, projectDuration, clipEnd, trackById } from './store.js';
import { renderFrame, srcTime, itemsAt } from './renderer.js';
import { mediaMap } from './media.js';
import { valAt, instSpeed } from './anim.js';
import { buildChain } from './audiofx.js';

let actx = null, master = null, analyser = null;
export function audioCtx() {
  if (!actx) {
    actx = new AudioContext({ latencyHint: 'interactive' });
    master = actx.createGain();
    analyser = actx.createAnalyser(); analyser.fftSize = 512;
    master.connect(analyser); analyser.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
export const getAnalyser = () => analyser;

/** Per-clip media elements (one element per clip so overlapping clips of one file work). */
class Pool {
  constructor() { this.els = new Map(); }
  get(clip) {
    const m = mediaMap.get(clip.mediaId);
    if (!m) return null;
    if (m.type === 'image') return { el: m.img, image: true };
    let e = this.els.get(clip.id);
    if (e && e.mediaId !== clip.mediaId) { this.drop(clip.id); e = null; }
    if (!e) {
      const el = document.createElement(m.type === 'audio' ? 'audio' : 'video');
      el.preload = 'auto'; el.playsInline = true; el.crossOrigin = 'anonymous';
      el.src = m.url;
      el.addEventListener('seeked', () => engine.requestDraw());
      el.addEventListener('loadeddata', () => engine.requestDraw());
      e = { el, mediaId: clip.mediaId, gain: null };
      if (m.hasAudio !== false) {
        try {
          const ctx = audioCtx();
          e.src = ctx.createMediaElementSource(el);
          e.gain = ctx.createGain(); e.gain.connect(master);
          e.fx = null; this.setFx(e, clip.voiceFx || 'none');
        } catch (err) { console.warn('audio graph', err); }
      } else el.muted = true;
      this.els.set(clip.id, e);
    }
    if (e.src && (clip.voiceFx || 'none') !== e.fx) this.setFx(e, clip.voiceFx || 'none');
    return e;
  }
  setFx(e, fx) {
    try { e.src.disconnect(); } catch {}
    e.chain?.stop(); try { e.chain?.output.disconnect(); } catch {}
    e.chain = null; e.fx = fx;
    if (fx === 'none') { e.src.connect(e.gain); return; }
    e.chain = buildChain(audioCtx(), fx); e.chain.start();
    e.src.connect(e.chain.input); e.chain.output.connect(e.gain);
  }
  drop(id) {
    const e = this.els.get(id);
    if (!e) return;
    e.el.pause(); e.el.removeAttribute('src'); e.el.load();
    try { e.gain?.disconnect(); e.chain?.stop(); } catch {}
    this.els.delete(id);
  }
  prune(validIds) { for (const id of [...this.els.keys()]) if (!validIds.has(id)) this.drop(id); }
}

function clipGain(c, t, track) {
  if (c.muted || track?.muted) return 0;
  const local = t - c.start, remain = clipEnd(c) - t;
  let g = valAt(c, 'volume', local);
  if (c.reverse) return 0;
  if (c.fadeIn > 0 && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && remain < c.fadeOut) g *= Math.max(0, remain / c.fadeOut);
  return g;
}

export const engine = {
  canvas: null, ctx: null, pool: new Pool(),
  W: 0, H: 0, _drawPending: false, _raf: 0, _startWall: 0, _startT: 0, lastItems: [],
  masterVolume: 1,

  attach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    store.on('project', () => { this.pool.prune(new Set(store.project.clips.map((c) => c.id))); this.sync(false); this.requestDraw(); });
    store.on('time', () => { if (!store.playing) { this.sync(false); this.requestDraw(); } });
  },

  resize(cssW, cssH) {
    const p = store.project; if (!p || !this.canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.min(cssW / p.width, cssH / p.height);
    const w = Math.max(2, Math.floor(p.width * s)), h = Math.max(2, Math.floor(p.height * s));
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    // Cap preview resolution for speed.
    const scale = Math.min(dpr, 1920 / Math.max(w, h) * (p.width >= p.height ? 1 : 1));
    this.canvas.width = Math.round(w * scale); this.canvas.height = Math.round(h * scale);
    this.W = this.canvas.width; this.H = this.canvas.height;
    this.cssW = w; this.cssH = h;
    this.requestDraw();
  },

  requestDraw() {
    if (this._drawPending || store.playing) return;
    this._drawPending = true;
    requestAnimationFrame(() => { this._drawPending = false; this.draw(); });
  },

  draw() {
    const p = store.project; if (!p || !this.ctx) return;
    this.lastItems = renderFrame(this.ctx, p, store.playhead, this.W, this.H, (clip) => {
      const e = this.pool.get(clip);
      if (!e) return null;
      if (e.image) return e.el.complete ? e.el : null;
      return e.el.readyState >= 2 ? e.el : null;
    });
    this.onDraw?.();
  },

  /** Align every media element to the playhead. */
  sync(playing) {
    const p = store.project; if (!p) return;
    const t = store.playhead;
    const visualActive = new Map();
    const items = itemsAt(p, t);
    for (const it of items) visualActive.set(it.clip.id, it.t);
    for (const c of p.clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      const m = mediaMap.get(c.mediaId); if (!m) continue;
      const track = trackById(p, c.trackId);
      const inRange = t >= c.start && t < clipEnd(c);
      const want = visualActive.has(c.id) ? visualActive.get(c.id) : inRange ? srcTime(c, t) : null;
      const upcoming = !inRange && c.start > t && c.start - t < 1.5;
      if (want == null && !upcoming) {
        const e = this.pool.els.get(c.id);
        if (e && !e.el.paused) e.el.pause();
        if (e?.gain) e.gain.gain.value = 0;
        continue;
      }
      const e = this.pool.get(c); if (!e || e.image) continue;
      const el = e.el;
      if (want == null) { // preload upcoming clip
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - c.in) > 0.05 && !el.seeking) el.currentTime = c.in;
        if (e.gain) e.gain.gain.value = 0;
        continue;
      }
      const target = Math.min(want, (m.duration || want) - 0.02);
      const g = inRange ? clipGain(c, t, track) * this.masterVolume : 0;
      if (e.gain) e.gain.gain.value = g; else el.volume = Math.min(1, g);
      if (playing && c.reverse) {
        // Browsers cannot play backwards: step by seeking.
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
      } else if (playing) {
        const rate = Math.max(0.0625, Math.min(16, Math.abs(instSpeed(c, t))));
        if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate;
        el.preservesPitch = true;
        const drift = Math.abs(el.currentTime - target);
        if (drift > 0.3 && !el.seeking) el.currentTime = target;
        if (el.paused && want < (m.duration || Infinity) - 0.05) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - target) > 0.01 && !el.seeking) el.currentTime = target;
      }
    }
  },

  play() {
    const p = store.project; if (!p) return;
    audioCtx();
    const dur = projectDuration(p);
    if (dur <= 0) return;
    if (store.playhead >= dur - 0.05) store.setTime(0);
    store.playing = true; store.emit('play');
    this._startWall = performance.now(); this._startT = store.playhead;
    let lastSync = 0;
    const tick = (now) => {
      if (!store.playing) return;
      let t = this._startT + (now - this._startWall) / 1000;
      if (t >= dur) {
        if (store.ui.loop) { this._startWall = now; this._startT = 0; t = 0; this.sync(true); }
        else { store.playhead = dur; this.pause(); store.emit('time'); return; }
      }
      store.playhead = t;
      if (now - lastSync > (p.clips.some((c) => c.reverse || c.curve) ? 40 : 120)) { this.sync(true); lastSync = now; }
      else this.updateGains();
      this.draw();
      store.emit('time', { playing: true });
      this._raf = requestAnimationFrame(tick);
    };
    this.sync(true);
    this._raf = requestAnimationFrame(tick);
  },
  updateGains() {
    const p = store.project, t = store.playhead;
    for (const c of p.clips) {
      const e = this.pool.els.get(c.id);
      if (!e?.gain) continue;
      const inRange = t >= c.start && t < clipEnd(c);
      e.gain.gain.value = inRange ? clipGain(c, t, trackById(p, c.trackId)) * this.masterVolume : 0;
    }
  },
  pause() {
    store.playing = false;
    cancelAnimationFrame(this._raf);
    for (const e of this.pool.els.values()) if (!e.image) e.el.pause();
    store.emit('play');
    this.sync(false); this.requestDraw();
  },
  toggle() { store.playing ? this.pause() : this.play(); },
  seek(t) {
    const was = store.playing;
    if (was) { cancelAnimationFrame(this._raf); store.playing = false; }
    store.setTime(t);
    if (was) this.play();
  },
};
