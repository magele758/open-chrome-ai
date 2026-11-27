import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { DEFAULT_PORT, createPlaygroundServer } from '../../tools/risk-control-playground/server.mjs';

assert.equal(DEFAULT_PORT, 18473, 'Default playground port should avoid common 4173 conflicts');

function stubCanvas2D(window) {
  const noop = () => {};
  const fakeGradient = { addColorStop: noop };
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      arc: noop,
      quadraticCurveTo: noop,
      bezierCurveTo: noop,
      clip: noop,
      fill: noop,
      stroke: noop,
      fillRect: noop,
      clearRect: noop,
      drawImage: noop,
      translate: noop,
      rotate: noop,
      fillText: noop,
      createLinearGradient: () => fakeGradient,
    };
  };
}

const indexUrl = new URL('../../tools/risk-control-playground/index.html', import.meta.url);
const frameUrl = new URL('../../tools/risk-control-playground/verifycenter-captcha-frame.html', import.meta.url);

const [indexHtml, frameHtml] = await Promise.all([
  readFile(indexUrl, 'utf8'),
  readFile(frameUrl, 'utf8'),
]);

// 1. Offline self-contained check (no external script/stylesheet/image CDN links)
assert.equal(/https?:\/\//i.test(indexHtml), false, 'index.html must not require external URLs');
assert.equal(/https?:\/\//i.test(frameHtml), false, 'verifycenter-captcha-frame.html must not require external URLs');

// 2. Boot index.html in JSDOM and assert all 8 widgets + modal workflows initialize cleanly
const pageErrors = [];
const dom = new JSDOM(indexHtml, {
  url: `http://127.0.0.1:${DEFAULT_PORT}/`,
  runScripts: 'dangerously',
  beforeParse(window) {
    stubCanvas2D(window);
    window.addEventListener('error', e => pageErrors.push(e.error || e.message));
  },
});

const { window } = dom;
const { document } = window;
assert.deepEqual(pageErrors, [], 'Playground page must boot without runtime errors');

const expectedWidgets = [
  'slider-puzzle',
  'click-text',
  'rotate-image',
  'image-grid',
  'checkbox-human',
  'text-captcha',
  'two-factor-auth',
  'iframe-challenge',
];

for (const id of expectedWidgets) {
  const card = document.querySelector(`[data-rc-widget="${id}"]`);
  assert.ok(card, `Widget card ${id} must exist`);
  assert.equal(card.dataset.rcStatus, 'idle', `Widget ${id} must start idle`);
}

// Embedded iframe uses a path recognizable by iframe CAPTCHA detectors
const iframe = document.getElementById('rc-verifycenter-iframe');
assert.ok(iframe, 'VerifyCenter iframe must exist');
assert.match(iframe.getAttribute('src') || '', /verifycenter.*captcha/i);

// Read-only state snapshot exposes only status metadata (never challenge targets/answers)
assert.equal(typeof window.__RC_PLAYGROUND_STATE__, 'function');
const state = window.__RC_PLAYGROUND_STATE__();
assert.equal(state.totalCount, 8);
assert.equal(state.passedCount, 0);
assert.equal(state.modal.open, false);
const serializedState = JSON.stringify(state);
assert.equal(/targetX|expectedAnswer|expectedCode|targetSequence/.test(serializedState), false);

// 3. Test blocking modal trigger & close via protected action form
const modalSelect = document.getElementById('modal-challenge-select');
modalSelect.value = 'click-text';
const form = document.getElementById('protected-action-form');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

assert.equal(document.body.dataset.rcModalOpen, 'true');
assert.equal(document.body.dataset.rcModalKind, 'click-text');
assert.ok(document.getElementById('rc-modal-backdrop').classList.contains('open'));
assert.ok(document.querySelector('#rc-modal-body .click-canvas'));

document.getElementById('rc-modal-close').click();
assert.equal(document.body.dataset.rcModalOpen, 'false');
assert.equal(document.body.dataset.rcModalKind, '');

// 4. Test Rate-Limit 429 modal trigger & cleanup
document.querySelector('[data-open-modal="rate-limit-429"]').click();
assert.equal(document.body.dataset.rcModalOpen, 'true');
assert.equal(document.body.dataset.rcModalKind, 'rate-limit-429');
assert.match(document.getElementById('rc-modal-body').textContent || '', /HTTP 429/);
document.getElementById('rc-modal-close').click();

// 5. Test refresh-all and reset-all toolbar actions
document.getElementById('btn-refresh-all').click();
document.getElementById('btn-reset-all').click();
assert.deepEqual(pageErrors, [], 'Toolbar actions and modals must not throw errors');
dom.window.close();

// 6. Boot verifycenter-captcha-frame.html in JSDOM
const frameErrors = [];
const frameDom = new JSDOM(frameHtml, {
  url: `http://127.0.0.1:${DEFAULT_PORT}/verifycenter-captcha-frame.html`,
  runScripts: 'dangerously',
  beforeParse(w) {
    w.addEventListener('error', e => frameErrors.push(e.error || e.message));
  },
});
assert.deepEqual(frameErrors, [], 'Iframe challenge page must boot without runtime errors');
assert.equal(frameDom.window.document.body.dataset.status, 'idle');
assert.match(frameDom.window.document.body.textContent || '', /Verify to continue/);
frameDom.window.close();

// 7. Test local HTTP static server (routes + path traversal protection)
const server = createPlaygroundServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const resIndex = await fetch(`${base}/`);
  assert.equal(resIndex.status, 200);
  assert.match(resIndex.headers.get('content-type') || '', /text\/html/);
  const servedIndex = await resIndex.text();
  assert.match(servedIndex, /Risk Control Playground/);

  const resFrame = await fetch(`${base}/verifycenter-captcha-frame.html`);
  assert.equal(resFrame.status, 200);
  assert.match(resFrame.headers.get('content-type') || '', /text\/html/);

  const resMissing = await fetch(`${base}/does-not-exist.html`);
  assert.equal(resMissing.status, 404);

  // Raw path traversal attempt without fetch URL normalization
  const traversalStatus = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/%2e%2e/%2e%2e/package.json' }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(traversalStatus, 403);
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log('Risk control playground widgets, modals, iframe, and server verified.');
