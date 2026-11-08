// Creative presets: aspect ratios, looks (filters), animations, transitions, text styles, stickers.

export const ASPECTS = {
  '16:9': { w: 1920, h: 1080, label: 'YouTube', hint: '16:9' },
  '9:16': { w: 1080, h: 1920, label: 'TikTok / Reels', hint: '9:16' },
  '1:1': { w: 1080, h: 1080, label: 'Square', hint: '1:1' },
  '4:5': { w: 1080, h: 1350, label: 'Instagram', hint: '4:5' },
  '4:3': { w: 1440, h: 1080, label: 'Classic', hint: '4:3' },
  '21:9': { w: 2560, h: 1080, label: 'Cinema', hint: '21:9' },
};

export const DEFAULT_ADJUST = { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0, blur: 0, vignette: 0, grayscale: 0, sepia: 0, invert: 0, sharpen: 0 };

// Looks are adjustment bundles. Values are deltas around 0 (percent-ish units).
export const LOOKS = {
  none: { name: 'None', adj: {} },
  vivid: { name: 'Vivid', adj: { saturation: 35, contrast: 12 } },
  warm: { name: 'Warm', adj: { temperature: 35, saturation: 8 } },
  cool: { name: 'Cool', adj: { temperature: -35, brightness: 3 } },
  bw: { name: 'B&W', adj: { grayscale: 100, contrast: 15 } },
  noir: { name: 'Noir', adj: { grayscale: 100, contrast: 45, brightness: -8, vignette: 55 } },
  vintage: { name: 'Vintage', adj: { sepia: 45, contrast: -8, saturation: -15, vignette: 35 } },
  cinematic: { name: 'Cinematic', adj: { contrast: 18, saturation: -10, temperature: -12, tint: 6, vignette: 30 } },
  tealorange: { name: 'Teal & Orange', adj: { contrast: 15, saturation: 20, temperature: 18, tint: -10 } },
  fade: { name: 'Faded', adj: { contrast: -25, brightness: 8, saturation: -20 } },
  dramatic: { name: 'Dramatic', adj: { contrast: 40, saturation: -20, brightness: -6, vignette: 45 } },
  sunset: { name: 'Sunset', adj: { temperature: 50, tint: 15, saturation: 15, contrast: 6 } },
  dreamy: { name: 'Dreamy', adj: { brightness: 10, contrast: -12, saturation: 10, blur: 0.6 } },
  moody: { name: 'Moody', adj: { brightness: -12, saturation: -25, temperature: -10, vignette: 40 } },
  pop: { name: 'Pop', adj: { saturation: 60, contrast: 20, brightness: 4 } },
  matrix: { name: 'Matrix', adj: { hue: 70, saturation: -10, tint: -30, contrast: 15 } },
};

export const ANIM_IN = {
  none: 'None', fade: 'Fade in', zoomIn: 'Zoom in', zoomOut: 'Zoom out', pop: 'Pop', slideLeft: 'Slide from right',
  slideRight: 'Slide from left', slideUp: 'Slide up', slideDown: 'Slide down', spin: 'Spin in', blur: 'Blur in',
  drop: 'Drop', typewriter: 'Typewriter (text)', wipe: 'Wipe',
};
export const ANIM_OUT = {
  none: 'None', fade: 'Fade out', zoomIn: 'Zoom in', zoomOut: 'Zoom out', pop: 'Shrink', slideLeft: 'Slide left',
  slideRight: 'Slide right', slideUp: 'Slide up', slideDown: 'Slide down', spin: 'Spin out', blur: 'Blur out', wipe: 'Wipe',
};
export const ANIM_LOOP = {
  none: 'None', kenburns: 'Ken Burns', pulse: 'Pulse', shake: 'Shake', float: 'Float', swing: 'Swing', glitch: 'Glitch', heartbeat: 'Heartbeat',
};

export const TRANSITIONS = {
  none: 'None', fade: 'Cross dissolve', black: 'Dip to black', white: 'Flash white', slideLeft: 'Slide left',
  slideRight: 'Slide right', slideUp: 'Slide up', push: 'Push', wipeLeft: 'Wipe left', wipeRight: 'Wipe right',
  circle: 'Circle reveal', zoom: 'Zoom', blur: 'Blur', spin: 'Spin',
};

export const FONTS = [
  'Inter', 'Montserrat', 'Poppins', 'Bebas Neue', 'Anton', 'Oswald', 'Playfair Display', 'Lobster',
  'Pacifico', 'Permanent Marker', 'Bangers', 'Roboto Mono', 'Caveat', 'Arial', 'Georgia', 'Impact',
];

export const DEFAULT_TEXT = {
  content: 'Your text', font: 'Montserrat', size: 96, color: '#ffffff', bold: true, italic: false, align: 'center',
  letterSpacing: 0, lineHeight: 1.15, strokeWidth: 0, strokeColor: '#000000', shadow: 0.35, shadowColor: '#000000',
  bg: false, bgColor: '#000000', bgOpacity: 0.6, glow: 0, uppercase: false,
};

export const TEXT_STYLES = [
  { name: 'Classic', t: {} },
  { name: 'Title', t: { font: 'Bebas Neue', size: 180, bold: false, letterSpacing: 6, shadow: 0.5 } },
  { name: 'Bold Pop', t: { font: 'Anton', size: 130, color: '#ffe14d', strokeWidth: 10, strokeColor: '#000000', shadow: 0, uppercase: true } },
  { name: 'Caption', t: { font: 'Inter', size: 64, bold: true, bg: true, bgColor: '#000000', bgOpacity: 0.7, shadow: 0 } },
  { name: 'Subtitle', t: { font: 'Inter', size: 58, bold: true, strokeWidth: 6, strokeColor: '#000000', shadow: 0 } },
  { name: 'Neon', t: { font: 'Montserrat', size: 110, color: '#7cf7ff', glow: 1, shadow: 0 } },
  { name: 'Pink Neon', t: { font: 'Pacifico', size: 110, bold: false, color: '#ff6ad5', glow: 1, shadow: 0 } },
  { name: 'Elegant', t: { font: 'Playfair Display', size: 110, bold: false, italic: true, shadow: 0.25 } },
  { name: 'Marker', t: { font: 'Permanent Marker', size: 110, bold: false, color: '#ffffff', strokeWidth: 0, shadow: 0.6 } },
  { name: 'Comic', t: { font: 'Bangers', size: 140, bold: false, color: '#ffffff', strokeWidth: 12, strokeColor: '#e3262f', letterSpacing: 3 } },
  { name: 'Label', t: { font: 'Poppins', size: 70, color: '#111111', bg: true, bgColor: '#ffffff', bgOpacity: 1, shadow: 0 } },
  { name: 'Mono', t: { font: 'Roboto Mono', size: 64, bold: false, color: '#c8ffb0', bg: true, bgColor: '#0b0f0a', bgOpacity: 0.85, shadow: 0 } },
  { name: 'Handwritten', t: { font: 'Caveat', size: 130, bold: true, shadow: 0.4 } },
  { name: 'Retro', t: { font: 'Lobster', size: 130, bold: false, color: '#ffb347', strokeWidth: 6, strokeColor: '#5a1e00', shadow: 0.5 } },
];

export const STICKERS = [
  '😀', '😂', '🥹', '😍', '😎', '🤯', '😱', '🥳', '😭', '🤔', '🙄', '😴', '🤩', '😡', '🥶', '🤡',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '✌️', '🤝', '👉', '👈', '👆', '👇', '🫶', '💯', '✅',
  '❌', '⚠️', '❗', '❓', '🔥', '✨', '⭐', '🌟', '💥', '💫', '⚡', '💡', '🎉', '🎊', '🎁', '🏆',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '🎵', '🎬', '📸', '🎮', '💰', '📈', '📉', '🚀',
  '🌈', '☀️', '🌙', '☁️', '🌧️', '❄️', '🌊', '🌸', '🍕', '🍔', '☕', '🍿', '⚽', '🏀', '🐶', '🐱',
];

export const SOLIDS = [
  { name: 'Black', color: '#000000' }, { name: 'White', color: '#ffffff' }, { name: 'Midnight', color: '#0f172a' },
  { name: 'Red', color: '#e11d48' }, { name: 'Orange', color: '#f97316' }, { name: 'Yellow', color: '#facc15' },
  { name: 'Green', color: '#22c55e' }, { name: 'Teal', color: '#14b8a6' }, { name: 'Blue', color: '#3b82f6' },
  { name: 'Purple', color: '#8b5cf6' }, { name: 'Pink', color: '#ec4899' },
  { name: 'Sunset', gradient: ['#ff7e5f', '#feb47b'] }, { name: 'Ocean', gradient: ['#2193b0', '#6dd5ed'] },
  { name: 'Purple Haze', gradient: ['#7f00ff', '#e100ff'] }, { name: 'Mint', gradient: ['#00b09b', '#96c93d'] },
  { name: 'Night', gradient: ['#0f2027', '#2c5364'] }, { name: 'Peach', gradient: ['#ffecd2', '#fcb69f'] },
];

export const SHAPES = [
  { name: 'Rectangle', shape: 'rect' }, { name: 'Rounded', shape: 'round' }, { name: 'Circle', shape: 'circle' },
  { name: 'Line', shape: 'line' }, { name: 'Arrow', shape: 'arrow' }, { name: 'Star', shape: 'star' },
];

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
