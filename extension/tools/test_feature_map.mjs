import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const map = new URL('../../docs/feature-map.md', import.meta.url);
const markdown = await readFile(map, 'utf8');
for (const [, target] of markdown.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
  if (target.startsWith('https://')) continue;
  await access(new URL(target, map));
}

const html = await readFile(new URL('../sidepanel/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html);
const controls = [...markdown.matchAll(/`(#[\w-]+)`/g)];
assert.ok(controls.length, 'Feature map must reference side panel controls');
for (const [, selector] of controls) {
  assert.equal(dom.window.document.querySelectorAll(selector).length, 1, selector + ' must identify one control');
}
dom.window.close();
console.log('Feature map links and ' + controls.length + ' UI references verified.');
