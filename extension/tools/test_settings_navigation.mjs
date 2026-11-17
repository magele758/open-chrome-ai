import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { settingsFixture } from '../../scripts/bombadil/settings-fixture.mjs';
import { readSettingsState } from '../../scripts/bombadil/settings-state.js';

const errors = [];
const virtualConsole = new VirtualConsole().on('jsdomError', err => errors.push(err));
const dom = new JSDOM(await settingsFixture(), {
  url: 'https://fixture.invalid/', runScripts: 'dangerously', virtualConsole,
});
const { document, KeyboardEvent } = dom.window;
const tab = name => document.querySelector(`[data-settings-tab="${name}"]`);
function click(name) {
  tab(name).focus();
  tab(name).click();
}
function check(expected, action, keyboard = false) {
  const state = readSettingsState({ document });
  assert.ok(state.tabAndPanelAgree, action + ': visible panel must match selected tab');
  assert.ok(state.keyboardAccess, action + ': tab order and focus must match selection');
  assert.equal(state.selected, expected, action);
  if (keyboard) assert.equal(state.focusedTab, expected, action + ': keyboard focus');
  assert.equal(state.draft, 'unsaved-model', action + ': unsaved model');
}

try {
  check('basic', 'initial state');
  for (const start of ['basic', 'advanced']) {
    const other = start === 'basic' ? 'advanced' : 'basic';
    for (const [action, expected] of [
      ['basic', 'basic'], ['advanced', 'advanced'], ['Home', 'basic'], ['End', 'advanced'],
      ['ArrowLeft', other], ['ArrowRight', other],
    ]) {
      click(start);
      check(start, 'prepare ' + start);
      const keyboard = action !== 'basic' && action !== 'advanced';
      if (keyboard) tab(start).dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true }));
      else click(action);
      check(expected, start + ' → ' + action, keyboard);
    }
  }
  assert.deepEqual(errors, []);
  console.log('Passed all 12 settings navigation transitions.');
} finally {
  dom.window.close();
}
