import assert from 'node:assert/strict';
import { normalizeSettings, loadSettings, saveSettings } from '../lib/storage.js';
import { UI_THEMES, normalizeThemeColors, paletteTokens, contrastRatio } from '../lib/ui-theme.js';
import { saveUiTheme } from '../sidepanel/theme.js';
let stored = { settings: { uiFont: 'xl', text: { apiKey: 'test-only', model: 'test' }, custom: 'preserve' } };
globalThis.chrome = { storage: { local: {
  get: async () => structuredClone(stored),
  set: async value => { stored = structuredClone(value); },
} } };
assert.equal(normalizeSettings({}).uiTheme, 'default');
for (const invalid of [null, '', 'unknown', {}, 1]) assert.equal(normalizeSettings({uiTheme: invalid}).uiTheme, 'default');
for (const theme of UI_THEMES) {
  await saveUiTheme(theme);
  assert.equal(stored.settings.uiTheme, theme);
  assert.equal(stored.settings.text.apiKey, 'test-only');
  assert.equal(stored.settings.uiFont, 'xl');
  assert.equal(stored.settings.custom, 'preserve');
  assert.equal((await loadSettings()).uiTheme, theme);
  await saveSettings(await loadSettings());
  assert.equal((await loadSettings()).uiTheme, theme);
}
const custom = {cyber:{accent:'#aabbcc',surface:'#101010'},mint:{accent:'#6B8022'}};
assert.deepEqual(normalizeThemeColors({...custom, invalid:{accent:'#ffffff'}}), {cyber:{surface:'#101010',accent:'#aabbcc'},mint:{accent:'#6b8022'}});
assert.deepEqual(normalizeThemeColors({warm:{accent:'red',ink:'#123',teal:'url(x)'}}), {});
await saveUiTheme('mint', custom);
assert.equal((await loadSettings()).uiThemeColors.cyber.accent, '#aabbcc');
await saveSettings(await loadSettings());
assert.equal((await loadSettings()).uiThemeColors.mint.accent, '#6b8022');
await saveUiTheme('cyber');
assert.equal(stored.settings.uiThemeColors.mint.accent, '#6b8022');
await saveUiTheme('cyber', {mint:custom.mint});
assert.equal(stored.settings.uiThemeColors.cyber, undefined);
assert.equal(stored.settings.uiThemeColors.mint.accent, '#6b8022');
assert.equal(contrastRatio('#ffffff','#000000'),21);
for (const accent of ['#ffff00','#101010']) {
 const tokens = paletteTokens({surface:'#ffffff',ink:'#222222',accent,teal:'#348833'});
 assert.ok(contrastRatio(accent,tokens['on-solid']) >= 4.5);
 assert.ok(Object.values(tokens).every(x=>/^#[a-f0-9]{6}$/i.test(x)));
}
await saveUiTheme('warm', {warm:{'danger-bg':'#221122',danger:'#ffeeff','danger-line':'#aa44aa'}});
assert.deepEqual((await loadSettings()).uiThemeColors.warm, {'danger-bg':'#221122',danger:'#ffeeff','danger-line':'#aa44aa'});
await saveSettings(await loadSettings());
assert.equal((await loadSettings()).uiThemeColors.warm.danger, '#ffeeff');
chrome.storage.local.set = async () => { throw new Error('storage unavailable'); };
await assert.rejects(saveUiTheme('cyber'), /storage unavailable/);
console.log('Theme migration, persistence, settings isolation and storage errors passed');
