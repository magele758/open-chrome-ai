export function readPanel({ document }) {
  const get = id => document.getElementById(id);
  const visible = el => !!el && !el.closest('.hidden,[hidden]');
  const views = ['chat', 'history', 'settings', 'review'].filter(name => visible(get('view-' + name)));
  const message = document.querySelector('#msgs .msg.bot[data-msg-id]');
  const owner = message?.dataset.msgId?.replace(/^a-/, '') || '';
  const ready = ['Alpha', 'Beta'].includes(owner);
  const pane = get('sidechat-pane');
  const wide = (get('view-chat').clientWidth || document.defaultView.innerWidth) >= 680;
  const thread = visible(get('sc-thread-view'));
  const open = visible(pane);
  const mark = message?.querySelector('mark.sc-anchor');
  const selected = document.querySelectorAll('button[aria-current="page"]');
  const activeNav = views[0] === 'chat' ? selected.length === 0 :
    selected.length === 1 && selected[0].id === 'btn-' + views[0];
  const mediaPairs = [['btn-media-toggle', 'media-body'], ['btn-media-tools', 'media-tools'], ['btn-tasks-toggle', 'media-tasks']];
  const mediaAgrees = mediaPairs.every(([control, panel]) =>
    get(control).getAttribute('aria-expanded') === String(!get(panel).classList.contains('hidden')));
  const draft = get('sc-input').value;
  const query = get('hist-q').value.toLowerCase();
  const rows = [...document.querySelectorAll('.hist-main .t')];
  const histList = get('hist-list');
  const histSort = histList?.dataset.sortMode || 'recent';
  const sortButtons = [...document.querySelectorAll('button[data-hist-sort]')];
  const sortControlsAgree = sortButtons.length === 2 && sortButtons.every(el =>
    el.getAttribute('aria-pressed') === String(el.dataset.histSort === histSort));
  const itemTimes = [...document.querySelectorAll('#hist-list .hist-item')].map(el => Number(el.dataset.updatedAt || 0));
  const timeDescending = itemTimes.every((t, i) => i === 0 || itemTimes[i - 1] >= t);
  const toggles = [...document.querySelectorAll('.lab-toggle')];
  // The explorer uses names or an explicit no-match query on the two seeded conversations.
  const expected = ['Alpha', 'Beta'].filter(name => ('Question ' + name).toLowerCase().includes(query));
  const layoutMatches = expected.length === 0
    ? toggles.length === 0
    : histSort === 'domain'
      ? toggles.length > 0 && toggles.every(el =>
          el.getAttribute('aria-expanded') === String(!get(el.getAttribute('aria-controls')).hidden))
      : toggles.length === 0 && timeDescending;
  const historyMatches = views[0] !== 'history' || (sortControlsAgree &&
    rows.length === expected.length &&
    expected.every(name => rows.some(el => el.textContent.includes('Question ' + name))) &&
    layoutMatches);
  return {
    ready, owner, view: views[0], open, thread, draft,
    resolved: get('btn-sc-resolve').classList.contains('is-resolved'),
    viewAgrees: views.length === 1 && activeNav,
    threadAgrees: !ready || (mark?.textContent === owner && get('sc-header-count').textContent === '1' &&
      (!thread || (get('sc-thread-title').textContent === 'Note ' + owner &&
        get('sc-detail-quote').textContent.includes(owner) &&
        mark.classList.contains('is-resolved') === get('btn-sc-resolve').classList.contains('is-resolved')))),
    paneAgrees: views[0] !== 'chat' || (open === (get('btn-sidechat-header').getAttribute('aria-expanded') === 'true') &&
      (!open || (thread !== visible(get('sc-list-view')) &&
        pane.classList.contains('is-split') === wide && pane.classList.contains('is-drawer') === !wide &&
        visible(get('sc-drawer-backdrop')) === !wide))),
    draftIsLocal: !thread || !draft || draft === 'draft-' + owner,
    mediaAgrees, historyMatches, mediaOpen: !get('media-body').classList.contains('hidden'),
    toolsOpen: !get('media-tools').classList.contains('hidden'),
  };
}
