import { always } from '@antithesishq/bombadil';
import { actions, extract } from '@antithesishq/bombadil/browser';
import { readGraph } from './graph-state.js';
import { choose, enter } from './dom-actions.js';
export { noUncaughtExceptions } from '@antithesishq/bombadil/browser/defaults/properties';

const state = extract(readGraph);
export const filtersMatchTopicIndex = always(() => !state.current.ready || state.current.topicsMatch);
export const selectionMatchesMap = always(() => !state.current.ready || state.current.selectionMatches);
export const sourcesBelongToSelectedTopic = always(() => !state.current.ready || state.current.sourcesMatch);
const counts = extract(({ document }) => ({
  topics: document.querySelectorAll('#topics button').length, edges: document.querySelectorAll('#edges button').length,
}));
export const browseGraph = actions(() => {
  if (!state.current.ready) return ['Wait'];
  const choices = ['', 'queue', 'Notebook', 'no-match'].map(query => enter('query', query));
  for (const domain of ['', 'Research', 'Engineering']) choices.push(enter('domain', domain));
  for (const [section, count] of Object.entries(counts.current)) {
    for (let i = 0; i < count; i++) choices.push(choose('#' + section + ' button', i));
  }
  return choices;
});
