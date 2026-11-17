export function readGraph({ document }) {
  const get = id => document.getElementById(id);
  const rows = [
    { title: 'Scheduler', domain: 'Engineering', topics: ['agent', 'queue'] },
    { title: 'Notebook', domain: 'Research', topics: ['agent', 'notes'] },
  ];
  const domain = get('domain').value;
  const query = get('query').value.trim().toLowerCase();
  const topics = [...get('topics').querySelectorAll('button')];
  const active = topics.filter(el => el.getAttribute('aria-pressed') === 'true');
  const name = get('heading').textContent;
  const candidates = rows.filter(row => !domain || domain === row.domain);
  const expected = new Set(candidates.flatMap(row => row.topics.filter(t => t.includes(query) || row.title.toLowerCase().includes(query))));
  const sources = [...get('sources').querySelectorAll('article > :first-child')].map(el => el.textContent).sort();
  const expectedSources = candidates.filter(row => row.topics.includes(name)).map(r => r.title).sort();
  return {
    ready: get('domain').options.length === 3, name, query, domain,
    topicsMatch: topics.length === expected.size && [...expected].every(t => topics.some(el => el.textContent.split(' · ')[0] === t)),
    selectionMatches: expected.size ? active.length === 1 && active[0].textContent.split(' · ')[0] === name &&
      get('map').querySelector('.focus-topic title')?.textContent === name && !get('assign').hidden :
      !active.length && name === '无匹配主题' && get('assign').hidden && !get('map').children.length,
    sourcesMatch: JSON.stringify(sources) === JSON.stringify(expectedSources),
  };
}
