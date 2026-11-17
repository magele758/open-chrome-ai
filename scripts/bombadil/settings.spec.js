import { always } from '@antithesishq/bombadil';
import { actions, extract } from '@antithesishq/bombadil/browser';
import { clicks } from '@antithesishq/bombadil/browser/defaults/actions';
import { readSettingsState } from './settings-state.js';

export { noUncaughtExceptions } from '@antithesishq/bombadil/browser/defaults/properties';

const state = extract(readSettingsState);
export const oneMatchingPanel = always(() => state.current.tabAndPanelAgree);
export const activeTabIsFocusable = always(() => state.current.keyboardAccess);
export const unsavedModelSurvivesNavigation = always(() => state.current.draft === 'unsaved-model');

export const switchByClick = clicks.filter(action => action.Click?.fingerprint.role === 'tab' ||
  ['settings-tab-basic', 'settings-tab-advanced'].includes(action.Click?.fingerprint.id));
export const switchByKeyboard = actions(() => state.current.focusedTab
  ? [37, 39, 36, 35].map(code => ({ PressKey: { code } })) // Left, Right, Home, End
  : []);
