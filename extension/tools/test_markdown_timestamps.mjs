// Uses the existing DOM test runtime: npm install --prefix .tmp/x-article-tests jsdom
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { formatAnswer, decorateInlines } from '../lib/markdown.js';
const require = createRequire(import.meta.url);
const { JSDOM } = require('../../.tmp/x-article-tests/node_modules/jsdom');
const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
for (const file of ['marked.min.js', 'purify.min.js']) {
  dom.window.eval(readFileSync(new URL('../vendor/' + file, import.meta.url), 'utf8'));
}
for (const name of ['document', 'NodeFilter', 'marked', 'DOMPurify']) globalThis[name] = dom.window[name];
const root = document.querySelector('main');
const times = ['0:00', '0:44', '1:40', '2:52', '4:34', '5:52'];
root.innerHTML = formatAnswer('### 时间索引\n\n' + times.map(t => '- `' + t + '` 章节说明').join('\n') + '\n\n普通时间 8:20，长视频 `1:02:03`。\n\n```text\n0:44\n```\n\n`const time = "0:44"`，`0:99`，[`0:44`](https://example.com)。');
decorateInlines(root);
assert.deepEqual([...root.querySelectorAll('button.ts')].map(b => b.dataset.t), [...times, '8:20', '1:02:03']);
assert.equal(root.querySelectorAll('pre button').length, 0);
assert.equal(root.querySelectorAll('a button').length, 0);
assert(root.textContent.includes('const time = "0:44"'));
assert(root.querySelector('pre code'));
assert([...root.querySelectorAll('code')].some(c => c.textContent === '0:99'));
decorateInlines(root);
assert.equal(root.querySelectorAll('button.ts').length, 8, 'redecoration does not duplicate or nest controls');
assert([...root.querySelectorAll('button.ts')].every(b => b.type === 'button'));
dom.window.close();
console.log('PASS summary timestamp buttons: inline code, plain text, hours, excluded code/links and idempotence');
