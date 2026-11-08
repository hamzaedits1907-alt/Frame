// Reusable UI controls: context menu, slider rows, segmented controls, toggles, color pickers.
import { h, iconBtn } from './util.js';
import { icon } from './icons.js';

let openMenu = null;
export function showContextMenu(x, y, items) {
  openMenu?.remove();
  const menu = h('div.ctx-menu');
  for (const it of items) {
    if (it === '-') { if (menu.lastChild && menu.lastChild.tagName !== 'HR') menu.append(h('hr')); continue; }
    menu.append(h('button', { disabled: it.disabled, style: it.disabled ? { opacity: 0.4 } : null, onclick: () => { close(); it.fn(); } },
      h('span', { html: icon(it.icon || 'more', 15) }), it.label, it.key ? h('kbd', it.key) : null));
  }
  if (menu.lastChild?.tagName === 'HR') menu.lastChild.remove();
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const close = () => { menu.remove(); openMenu = null; window.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  openMenu = menu;
}

/** Slider + number + reset. onInput(v) for live changes. */
export function sliderRow(label, value, { min = 0, max = 100, step = 1, def = 0, unit = '', fmt, onInput }) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = h('input.num', { type: 'text', value: fmt ? fmt(value) : round(value, step) });
  const setFill = () => range.style.setProperty('--fill', ((+range.value - min) / (max - min)) * 100 + '%');
  const set = (v, fromNum) => {
    v = Math.min(max, Math.max(min, +v)); if (!isFinite(v)) return;
    if (!fromNum) num.value = fmt ? fmt(v) : round(v, step);
    range.value = v; setFill(); onInput(v);
  };
  range.oninput = () => set(range.value);
  num.onchange = () => set(parseFloat(num.value), false);
  num.onkeydown = (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(+range.value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)); } };
  setFill();
  const rst = h('button.rst', { title: 'Reset', html: icon('reset', 13), onclick: () => set(def) });
  return h('div.slider-row', h('label', { title: label }, label + (unit ? ` (${unit})` : '')), range, num, rst);
}
const round = (v, step) => { const d = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0; return (+v).toFixed(d); };

export function seg(options, value, onChange) {
  const el = h('div.seg');
  for (const [v, label] of options) {
    el.append(h('button' + (v === value ? '.on' : ''), { html: label, onclick: () => { el.querySelectorAll('button').forEach((b) => b.classList.remove('on')); el.querySelector(`[data-v="${CSS.escape(String(v))}"]`)?.classList.add('on'); onChange(v); }, 'data-v': String(v) }));
  }
  return el;
}

export function toggle(on, onChange) {
  const b = h('button.toggle' + (on ? '.on' : ''), { onclick: () => { b.classList.toggle('on'); onChange(b.classList.contains('on')); } });
  return b;
}

export function colorRow(label, value, onInput, swatches = ['#ffffff', '#000000', '#facc15', '#f43f5e', '#22c55e', '#3b82f6', '#a855f7', '#22d3ee']) {
  const input = h('input', { type: 'color', value: value || '#ffffff', oninput: () => onInput(input.value) });
  const sw = h('div.swatches', swatches.map((c) => h('div.swatch' + (c === value ? '.on' : ''), { style: { background: c }, title: c, onclick: () => { input.value = c; onInput(c); sw.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.title === c)); } })));
  return h('div.row', h('label', label), input, h('div.grow', sw));
}

export function card(title, ...kids) { return h('div.card', title ? h('h4', title) : null, ...kids); }
export { iconBtn };
