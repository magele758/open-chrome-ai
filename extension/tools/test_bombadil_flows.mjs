import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { instrumentedFixture } from '../../scripts/bombadil/browser-fixture.mjs';
import { requiredVisits } from '../../scripts/bombadil/coverage.js';
import { readGraph } from '../../scripts/bombadil/graph-state.js';
import { readPanel } from '../../scripts/bombadil/panel-state.js';

async function mount(html, width) {
  const errors = [];
  const visits = new Set();
  const virtualConsole = new VirtualConsole().on('jsdomError', e => errors.push(e)).on('error', (...args) => errors.push(args));
  const dom = new JSDOM(html, {
    url: 'https://fixture.invalid/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.navigator.sendBeacon = path => { visits.add(path.split('/').pop()); return true; };
      Object.assign(w, { innerWidth: width, TextEncoder, TextDecoder, structuredClone });
      w.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  return { dom, document: dom.window.document, errors, visits };
}

async function until(check, label) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(label);
}

function field(document, id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new document.defaultView.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

const panelHtml = await instrumentedFixture('panel');
for (const width of [400, 900]) {
  const { document, dom, errors, visits } = await mount(panelHtml, width);
  const state = () => readPanel({ document });
  const check = (label) => {
    const s = state();
    for (const key of ['ready', 'viewAgrees', 'threadAgrees', 'draftIsLocal', 'paneAgrees', 'mediaAgrees', 'historyMatches']) {
      assert.ok(s[key], label + ' / ' + key + ' ' + JSON.stringify(s));
    }
    assert.deepEqual(errors, []);
    return s;
  };
  const click = id => document.getElementById(id).click();
  async function openSession(name) {
    click('btn-history');
    await until(() => state().view === 'history', 'open history');
    check('history');
    field(document, 'hist-q', 'no-match');
    await until(() => document.querySelector('#hist-list .hist-empty'), 'empty search');
    check('empty history');
    field(document, 'hist-q', name);
    await until(() => document.querySelector('.hist-main')?.textContent.includes('Question ' + name), 'matching history');
    click('btn-hist-sort-domain');
    await until(() => document.querySelector('.lab-toggle'), 'domain grouped history');
    check('domain grouped history');
    const group = document.querySelector('.lab-toggle');
    group.click();
    assert.ok(document.getElementById(group.getAttribute('aria-controls')).hidden);
    check('collapsed history group');
    group.click();
    click('btn-hist-sort-recent');
    await until(() => document.getElementById('hist-list').dataset.sortMode === 'recent' && !document.querySelector('.lab-toggle'), 'recent history');
    check('recent history');
    document.querySelector('.hist-main').click();
    await until(() => state().owner === name && state().view === 'chat', 'open ' + name);
    if (!state().open) click('btn-sidechat-header');
    check('session ' + name);
  }
  try {
    await until(() => state().ready && !document.getElementById('media-zone').classList.contains('hidden'), 'boot panel');
    check('boot');
    click('btn-media-tools');
    assert.ok(check('tools expanded').toolsOpen);
    click('btn-media-toggle');
    assert.equal(check('media collapsed').mediaOpen, false);
    click('btn-settings');
    assert.equal(check('settings').view, 'settings');
    click('btn-back');
    await until(() => state().view === 'chat', 'return from settings');
    click('btn-review');
    await until(() => state().view === 'review', 'open review');
    assert.equal(check('review').view, 'review');
    click('btn-review-back');
    click('btn-media-toggle');
    assert.ok(check('return to media').toolsOpen);
    if (!state().open) click('btn-sidechat-header');
    if (!state().thread) click('btn-sc-list');
    assert.ok(check('thread opened').thread);
    assert.equal(document.getElementById('sidechat-pane').classList.contains('is-split'), width === 900);
    click('btn-sc-list');
    assert.equal(check('branch list').thread, false);
    click('btn-sc-list');
    click('btn-sc-resolve');
    assert.ok(check('mark resolved').resolved);
    field(document, 'sc-input', 'draft-Alpha');
    await openSession('Beta');
    assert.equal(check('Beta is independent').resolved, false);
    assert.equal(state().draft, '');
    field(document, 'sc-input', 'draft-Beta');
    await openSession('Alpha');
    assert.ok(check('Alpha resolution restored').resolved);
    assert.equal(state().draft, 'draft-Alpha');
    click('btn-clear-ref');
    assert.equal(document.getElementById('compose-chip-label').textContent, '未带网页');
    for (const [id, title] of [[18, 'Fixture article'], [17, 'Fixture video']]) {
      document.dispatchEvent(new dom.window.CustomEvent('fixture-activate-tab', { detail: id }));
      await until(() => document.getElementById('compose-chip-label').textContent === '当前网页：' + title, 'attach ' + title);
      await until(() => document.getElementById('media-zone').classList.contains('hidden') === (id === 18), 'media visibility on ' + title);
      check('tab switch to ' + title);
    }
    await until(() => requiredVisits.panel.every(v => visits.has(v)), 'missing panel coverage: ' + [...visits]);
    console.log('Passed sidebar navigation, history, media and branch isolation at width ' + width);
  } finally { dom.window.close(); }
}

const { document, dom, errors, visits } = await mount(await instrumentedFixture('graph'), 900);
try {
  const seen = new Set();
  const check = () => {
    const s = readGraph({ document });
    for (const key of ['ready', 'topicsMatch', 'selectionMatches', 'sourcesMatch']) assert.ok(s[key], JSON.stringify(s));
    seen.add(s.name);
    assert.deepEqual(errors, []);
  };
  await until(() => readGraph({ document }).ready, 'load clippings');
  for (const domain of ['', 'Research', 'Engineering']) {
    field(document, 'domain', domain);
    for (const query of ['', 'queue', 'Notebook', 'no-match', '']) {
      field(document, 'query', query);
      check();
      for (let i = 0; i < document.querySelectorAll('#topics button').length; i++) {
        document.querySelectorAll('#topics button')[i].click();
        check();
      }
    }
  }
  document.querySelector('#edges button').click();
  assert.equal(document.getElementById('domain').value, '');
  check();
  assert.deepEqual([...seen].sort(), ['agent', 'notes', 'queue', '无匹配主题'].sort());
  await until(() => requiredVisits.graph.every(v => visits.has(v)), 'missing graph coverage: ' + [...visits]);
  console.log('Passed graph topic, source, domain, related-topic and empty-state checks.');
} finally { dom.window.close(); }
