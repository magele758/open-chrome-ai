/** Stable IDs persisted with the other local settings. */
export const UI_THEMES = ['default', 'cyber', 'terminal', 'warm', 'mint'];
export function normalizeUiTheme(value) {
  return UI_THEMES.includes(value) ? value : 'default';
}

export const BASE_COLOR_KEYS = ['surface', 'ink', 'accent', 'teal'];
export const ERROR_COLOR_KEYS = ['danger-bg', 'danger', 'danger-line'];
export const THEME_COLOR_KEYS = [...BASE_COLOR_KEYS, ...ERROR_COLOR_KEYS];
export function normalizeThemeColors(value) {
  const result = {};
  for (const theme of UI_THEMES) {
    const colors = {};
    for (const key of THEME_COLOR_KEYS) {
      const color = value?.[theme]?.[key];
      if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) colors[key] = color.toLowerCase();
    }
    if (Object.keys(colors).length) result[theme] = colors;
  }
  return result;
}

function rgb(hex) { return hex.slice(1).match(/../g).map(x => parseInt(x, 16)); }
export function mixColors(a, b, weight) {
  const x = rgb(a), y = rgb(b);
  return '#' + x.map((v, i) => Math.round(v * (1 - weight) + y[i] * weight).toString(16).padStart(2, '0')).join('');
}
export function luminance(color) {
  return rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
}
export function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function paletteTokens({ surface, ink, accent, teal }) {
  const mix = (color, weight) => mixColors(surface, color, weight);
  const tokens = { surface, ink, accent, teal,
    bg: mix(ink, .055), line: mix(ink, .2), muted: mix(ink, .7),
    'accent-soft': mix(accent, .16), cite: mix(accent, .28), 'teal-soft': mix(teal, .16),
    'strong-line': mix(accent, .55), 'hover-bg': mix(accent, .12), 'subtle-bg': mix(ink, .035),
    'code-bg': mix(ink, .07), 'code-ink': ink,
  };
  for (const [name, color] of [['info', teal], ['warning', '#bc8622'], ['danger', '#cd5353'], ['success', '#4c9956']]) {
    tokens[name + '-bg'] = mix(color, .14);
    tokens[name + '-line'] = mix(color, .5);
    tokens[name + '-ink'] = mixColors(color, ink, .45);
  }
  tokens.danger = tokens['danger-ink']; tokens.ok = tokens['success-ink'];
  tokens['on-solid'] = contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#111111') ? '#ffffff' : '#111111';
  return tokens;
}
