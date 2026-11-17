// This function is also serialized into the generated page. Report only states reached through the UI.
export function observeCoverage(scenario) {
  const seen = new Set();
  const get = id => document.getElementById(id);
  const visible = el => el && !el.closest('.hidden,[hidden]');
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    document.documentElement.dataset.bombadilVisits = [...seen].join(' ');
    navigator.sendBeacon('/observed/' + name);
  }
  function sample() {
    if (scenario === 'settings') {
      const tab = document.querySelector('[role=tab][aria-selected=true]');
      if (tab && !get(tab.getAttribute('aria-controls')).hidden) visit(tab.dataset.settingsTab);
    } else if (scenario === 'graph') {
      if (!get('domain').options.length) return;
      const n = get('sources').children.length;
      if (n === 2) visit('two-sources');
      if (n === 1) visit('one-source');
      if (!n && get('heading').textContent === '无匹配主题') visit('empty');
      if (get('domain').value) visit('domain-filter');
    } else {
      for (const name of ['history', 'settings', 'review']) {
        if (visible(get('view-' + name))) visit(name);
      }
      if (visible(get('media-zone')) && get('btn-media-toggle').getAttribute('aria-expanded') === 'false') visit('media-collapsed');
      if (get('compose-chip-label').textContent === '未带网页') visit('context-off');
      if (seen.has('context-off') && get('compose-chip-label').textContent === '当前网页：Fixture article') visit('article-context');
      if (!visible(get('sc-thread-view'))) return;
      const title = get('sc-thread-title').textContent;
      if (title === 'Note Alpha' && get('sc-input').value === 'draft-Alpha') {
        visit('alpha-draft');
        if (seen.has('beta-draft')) visit('alpha-restored');
      }
      if (title === 'Note Beta' && get('sc-input').value === 'draft-Beta') visit('beta-draft');
    }
  }
  new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('input', sample);
  document.addEventListener('change', sample);
  sample();
}

export const requiredVisits = {
  settings: ['basic', 'advanced'],
  panel: ['alpha-draft', 'history', 'beta-draft', 'alpha-restored', 'media-collapsed', 'context-off', 'article-context'],
  graph: ['two-sources', 'one-source', 'domain-filter', 'empty'],
};
