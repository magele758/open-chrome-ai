import { normalizeUiTheme, normalizeThemeColors, THEME_COLOR_KEYS, BASE_COLOR_KEYS, ERROR_COLOR_KEYS, paletteTokens, luminance, contrastRatio } from '../lib/ui-theme.js';

let appliedTokens = [];
export function applyUiTheme(value, customColors = {}) {
  const theme = normalizeUiTheme(value);
  const root = document.documentElement;
  appliedTokens.forEach(key => root.style.removeProperty('--' + key));
  appliedTokens = [];
  root.style.removeProperty('color-scheme');
  delete root.dataset.customColors;
  root.dataset.theme = theme;
  const base = getComputedStyle(root);
  const colors = Object.fromEntries(THEME_COLOR_KEYS.map(key => [key, base.getPropertyValue('--' + key).trim()]));
  const custom = normalizeThemeColors(customColors)[theme];
  if (custom) {
    Object.assign(colors, custom);
    const hasBaseColors = BASE_COLOR_KEYS.some(key => key in custom);
    const tokens = hasBaseColors ? paletteTokens(colors) : {};
    for (const key of ERROR_COLOR_KEYS) if (custom[key]) tokens[key] = custom[key];
    Object.assign(colors, tokens);
    for (const [key, color] of Object.entries(tokens)) root.style.setProperty('--' + key, color);
    appliedTokens = Object.keys(tokens);
    if (hasBaseColors) {
      root.style.colorScheme = luminance(colors.surface) < .18 ? 'dark' : 'light';
      root.dataset.customColors = 'true';
    }
  }
  document.querySelectorAll('[data-ui-theme]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.uiTheme === theme));
  });
  for (const key of THEME_COLOR_KEYS) {
    document.querySelectorAll(`[data-theme-color="${key}"]`).forEach(input => { input.value = colors[key]; input.setCustomValidity(''); });
  }
  const warning = document.getElementById('theme-contrast');
  if (warning) warning.textContent = [
    contrastRatio(colors.surface, colors.ink) < 4.5 ? '正文与背景较接近，建议拉开颜色深浅。' : '',
    contrastRatio(colors['danger-bg'], colors.danger) < 4.5 ? '错误框文字与背景较接近，建议拉开颜色深浅。' : '',
  ].filter(Boolean).join(' ');
}

/** Save only appearance: don't commit unrelated edits in the settings form. */
export async function saveUiTheme(value, customColors) {
  const theme = normalizeUiTheme(value);
  const { settings = {} } = await chrome.storage.local.get('settings');
  const appearance = { uiTheme: theme };
  if (customColors !== undefined) appearance.uiThemeColors = normalizeThemeColors(customColors);
  await chrome.storage.local.set({ settings: { ...settings, ...appearance } });
  return theme;
}

export function bindThemeEditor(state) {
  const block = document.getElementById('view-settings');
  if (!block) return;
  let saved = { theme: state.settings.uiTheme, colors: structuredClone(state.settings.uiThemeColors || {}) };
  let saving = false;
  const render = () => applyUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
  const statusNodes = ['theme-status', 'theme-editor-status'].map(id => document.getElementById(id)).filter(Boolean);
  const status = {
    set textContent(value) { statusNodes.forEach(node => { node.textContent = value; }); },
    set className(value) { statusNodes.forEach(node => { node.className = value; }); },
  };
  async function commit() {
    if (state.settings.uiTheme === saved.theme && JSON.stringify(state.settings.uiThemeColors || {}) === JSON.stringify(saved.colors)) return;
    saving = true;
    const controls = block.querySelectorAll('[data-ui-theme],[data-theme-color],#btn-theme-reset');
    controls.forEach(el => { el.disabled = true; });
    status.textContent = '正在保存主题…';
    status.className = 'status';
    try {
      await saveUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
      saved = { theme: state.settings.uiTheme, colors: structuredClone(state.settings.uiThemeColors || {}) };
      status.textContent = '主题已保存'; status.className = 'status ok';
    } catch (err) {
      state.settings.uiTheme = saved.theme;
      state.settings.uiThemeColors = structuredClone(saved.colors);
      render();
      status.textContent = '主题保存失败，请重试'; status.className = 'status bad';
      console.warn('[pagelens] save theme', err);
    } finally {
      controls.forEach(el => { el.disabled = false; }); saving = false;
    }
  }
  block.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button || saving) return;
    if (button.dataset.uiTheme) state.settings.uiTheme = button.dataset.uiTheme;
    else if (button.id === 'btn-theme-reset') {
      delete (state.settings.uiThemeColors ||= {})[state.settings.uiTheme];
    } else return;
    render(); void commit();
  });
  function preview(input) {
    if (!/^#[0-9a-f]{6}$/i.test(input.value)) {
      input.setCustomValidity('请输入 #RRGGBB 格式的六位颜色值');
      input.reportValidity(); return false;
    }
    input.setCustomValidity('');
    const theme = state.settings.uiTheme;
    const all = state.settings.uiThemeColors ||= {};
    (all[theme] ||= {})[input.dataset.themeColor] = input.value.toLowerCase();
    render(); return true;
  }
  block.addEventListener('input', e => {
    if (saving || !e.target.dataset.themeColor) return;
    e.target.setCustomValidity('');
    if (e.target.type === 'color') preview(e.target);
  });
  block.addEventListener('change', e => {
    if (saving || !e.target.dataset.themeColor) return;
    if (preview(e.target)) void commit();
  });
}
