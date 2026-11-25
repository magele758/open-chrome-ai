import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
import { choose, enter } from './dom-actions.js';
import { readPanel } from './panel-state.js';
export { noUncaughtExceptions } from '@antithesishq/bombadil/browser/defaults/properties';

const panel = extract(readPanel);
const switchTab = registerCustomAction('switchFixtureTab', async (document, window, id) => {
  document.dispatchEvent(new window.CustomEvent('fixture-activate-tab', { detail: id }));
});
export const oneActiveView = always(() => !panel.current.ready || panel.current.viewAgrees);
export const branchBelongsToSession = always(() => panel.current.threadAgrees);
export const branchDraftIsIsolated = always(() => panel.current.draftIsLocal);
export const drawerMatchesHeader = always(() => !panel.current.ready || panel.current.paneAgrees);
export const mediaControlsMatchPanels = always(() => !panel.current.ready || panel.current.mediaAgrees);
export const historyMatchesSearchAndDisclosure = always(() => panel.current.historyMatches);

const visited = extract(({ document }) => (document.documentElement.dataset.bombadilVisits || '').split(' '));
const controls = extract(({ document }) => {
  const selectors = ['#btn-history', '#btn-hist-back', '#btn-hist-sort-recent', '#btn-hist-sort-domain', '.hist-main', '.lab-toggle', '#btn-review', '#btn-review-back',
    '#btn-settings', '#btn-back', '#btn-sidechat-header', '#btn-sc-list', '#btn-sc-close', '#btn-sc-resolve',
    '#btn-clear-ref', '#btn-media-toggle', '#btn-media-tools', '#btn-tasks-toggle'];
  return selectors.flatMap(selector => [...document.querySelectorAll(selector)].flatMap((el, index) =>
    !el.disabled && el.getClientRects().length && !el.closest('.hidden,[hidden]') ? [{ selector, index, text: selector === '.hist-main' ? el.textContent : '' }] : []));
});

export const navigatePanel = actions(() => {
  const current = panel.current;
  if (!current.ready) return ['Wait'];
  const options = controls.current.map(({ selector, index }) => choose(selector, index));
  const seen = visited.current;
  const nextOwner = !seen.includes('alpha-draft') ? 'Alpha' : !seen.includes('beta-draft') ? 'Beta' : 'Alpha';
  if (!seen.includes('alpha-restored')) {
    if (current.view === 'history') {
      const row = controls.current.find(c => c.selector === '.hist-main' && c.text.includes('Question ' + nextOwner));
      if (row) return [choose(row.selector, row.index)];
    } else if (current.owner !== nextOwner) return [choose('#btn-history', 0)];
    else if (!current.open) return [choose('#btn-sidechat-header', 0)];
    else if (!current.thread) return [choose('#btn-sc-list', 0)];
    else if (nextOwner === 'Beta' || !seen.includes('alpha-draft')) return [enter('sc-input', 'draft-' + nextOwner)];
    else return ['Wait']; // Restoration must come from the application.
  }
  if (!seen.includes('media-collapsed') && controls.current.some(c => c.selector === '#btn-media-toggle')) {
    return [choose('#btn-media-toggle', 0)];
  }
  if (!seen.includes('context-off') && controls.current.some(c => c.selector === '#btn-clear-ref')) {
    return [choose('#btn-clear-ref', 0)];
  }
  if (seen.includes('context-off') && !seen.includes('article-context')) return [switchTab(18)];
  options.push(switchTab(17), switchTab(18));
  if (current.thread) options.push(enter('sc-input', 'draft-' + current.owner));
  if (current.view === 'history') {
    for (const query of ['', 'Alpha', 'Beta', 'no-match']) options.push(enter('hist-q', query));
  }
  return options;
});
