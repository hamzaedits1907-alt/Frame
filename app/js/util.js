// Generic helpers: ids, math, time formatting, DOM building, toasts and modals.
import { icon } from './icons.js';

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
export const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function fmtTime(t, fps = 30, withFrames = false) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!withFrames) return base;
  const f = Math.floor((t % 1) * fps + 1e-6);
  return `${base}:${String(f).padStart(2, '0')}`;
}
export function fmtDur(t) {
  if (!isFinite(t)) return '--';
  if (t < 60) return `${t.toFixed(1)}s`;
  return fmtTime(t);
}
export function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return (b / 1024 ** 3).toFixed(2) + ' GB';
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny element builder: h('div.cls#id', {attrs}, children...) */
export function h(tag, attrs, ...kids) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  (m[2].match(/[.#][\w-]+/g) || []).forEach((p) => (p[0] === '.' ? el.classList.add(p.slice(1)) : (el.id = p.slice(1))));
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list' && k !== 'type') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function iconBtn(name, title, onClick, extra = {}) {
  return h('button.icon-btn', { title, 'aria-label': title, html: icon(name, extra.size || 18), onclick: onClick, ...extra.attrs });
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- Toasts -------------------------------------------------------------------------------
export function toast(msg, kind = 'info', ms = 3200) {
  let host = $('#toasts');
  if (!host) { host = h('div#toasts'); document.body.append(host); }
  const t = h('div.toast.' + kind, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---- Modal --------------------------------------------------------------------------------
export function modal({ title, body, actions = [], width = 480, onClose, dismissable = true }) {
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); } };
  const wrap = h('div.modal-wrap', { onmousedown: (e) => { if (e.target === wrap && dismissable) close(); } },
    h('div.modal', { style: { width: width + 'px' } },
      h('div.modal-head', h('h2', title), dismissable ? iconBtn('x', 'Close', close) : null),
      h('div.modal-body', body),
      actions.length ? h('div.modal-foot', actions.map((a) => h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), {
        onclick: async () => { const r = await a.onClick?.(); if (r !== false) close(); },
      }, a.label))) : null));
  document.body.append(wrap);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => wrap.querySelector('input,textarea,select')?.focus(), 30);
  return { close, el: wrap };
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    let ok = false;
    modal({ title, body: h('p.muted', text), width: 400, onClose: () => res(ok),
      actions: [{ label: 'Cancel' }, { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } }] });
  });
}

export function promptDialog(title, value = '', placeholder = '') {
  return new Promise((res) => {
    let out = null;
    const inp = h('input.input', { value, placeholder });
    const m = modal({ title, body: inp, width: 400, onClose: () => res(out),
      actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { out = inp.value; } }] });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { out = inp.value; m.close(); } });
  });
}

export function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.onchange = () => res([...inp.files]);
    inp.click();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
