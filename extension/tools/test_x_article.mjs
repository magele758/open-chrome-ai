// Setup: npm install --prefix .tmp/x-article-tests --no-audit --no-fund jsdom
// Run: node extension/tools/test_x_article.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractPage } from '../lib/extract.js';
import { packToContext } from '../lib/prompts.js';
import { createAgentTools } from '../lib/agent/tools.js';
const require = createRequire(import.meta.url);
const { JSDOM } = require('../../.tmp/x-article-tests/node_modules/jsdom');
const url = 'https://x.com/marfinxx/status/2094016175617241109';
async function extract(html, setup = () => {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  setup(dom.window);
  try { return await dom.window.eval(`(${extractPage.toString()})()`); }
  finally { dom.window.close(); }
}
const longform = `<article><h1>Trace Engineering</h1><div data-testid="twitterArticleRichTextView">
<h2 class="longform-header-two">Log vs. Trajectory vs. Trace</h2>
<div>BEGIN_BODY A trace records the causal relationship between tool calls and observed state.</div>
<div>${'Evidence-backed explanation. '.repeat(950)}</div>
<div>END_BODY Deterministic replay requires retaining the tool observations.</div></div>
<button>Follow noise</button><article data-testid="tweet"><div data-testid="tweetText">REPLY_NOISE</div></article></article>`;
const pack = await extract(`<title>Trace Engineering / X</title><meta name="description" content="X"><nav>HOME_NOISE</nav><main>${longform}</main>`);
assert.equal(pack.article, true);
assert.equal(pack.kind, 'x');
assert.ok(pack.text.includes('BEGIN_BODY') && pack.text.includes('END_BODY'));
assert.ok(pack.text.length > 24000, 'long articles survive the old 9k extraction cap');
assert.ok(!/HOME_NOISE|REPLY_NOISE|Follow noise/.test(pack.text));
assert.match(packToContext(pack), /X 长文章/);
assert.match(packToContext(pack), /仅为文章部分内容/);
let refreshes = 0;
const tools = createAgentTools({ getTabId: () => 1, refreshPack: async tabId => {
  assert.equal(tabId, 1, 'refresh must receive the resolved target, not reselect the active tab');
  refreshes++;
  return pack;
} });
const result = await tools.find(t => t.name === 'extract_page').execute({});
assert.match(result, /END_BODY/, 'extract_page must not truncate the longform tail again');
await tools.find(t => t.name === 'extract_page').execute({ tabId: 1 });
assert.equal(refreshes, 2, 'explicit extraction must refresh on every request');
const genericArticle = await extract(`<main><article><h2 class="longform-header-two">A longform heading</h2><div>${'Body prose '.repeat(30)}TAIL</div></article></main>`);
assert.equal(genericArticle.article, true, 'recognize observed longform markup without relying only on test IDs');
assert.match(genericArticle.text, /TAIL/);
const tweet = await extract(`<article data-testid="tweet"><div data-testid="User-Name">Alice @alice</div><a href="/alice/status/2094016175617241109"><time>Today</time></a><div data-testid="tweetText">ORDINARY_TWEET remains available.</div></article>`);
assert.equal(tweet.article, false);
assert.match(tweet.text, /ORDINARY_TWEET/);
const clipped = await extract(`<article data-testid="twitterArticleRichTextView"><div>${'x'.repeat(60100)}</div></article>`);
assert.equal(clipped.text.length, 60000);
assert.equal(clipped.textTruncated, true);
const delayed = await extract('<main></main>', win => win.setTimeout(() => { win.document.querySelector('main').innerHTML = longform; }, 30));
assert.equal(delayed.article, true, 'wait for longform rendering even without a tweet');
const withVideo = await extract(`${longform}<video></video>`, win => {
  const video = win.document.querySelector('video');
  Object.defineProperties(video, { offsetWidth: { value: 640 }, offsetHeight: { value: 360 } });
});
assert.ok(withVideo.video);
assert.equal(withVideo.videoIsPrimary, false, 'a reply video must not turn article summary into audio transcription');
const missing = await extract('<title>X</title><meta name="description" content="X"><main></main>');
assert.notEqual(missing.text.trim(), 'X');
assert.match(missing.text, /未能读取帖子正文/);
console.log('PASS X article extraction: rich text, legacy markup, full tail, context limit, delayed render, ordinary tweet, missing content');
