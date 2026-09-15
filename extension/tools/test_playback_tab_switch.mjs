import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app = fs.readFileSync(new URL('../sidepanel/app.js', import.meta.url), 'utf8');
const refresh = app.slice(app.indexOf('async function refreshTab()'), app.indexOf('\nasync function ', app.indexOf('async function refreshTab()') + 1));
for (const mode of ['interpret', 'compact-generation', 'compact-playback', 'archive']) {
  let queries = 0;
  const tab = { id: 1, url: 'https://video.test/watch' };
  const context = vm.createContext({
    state: { tab, dubPlaying: mode === 'archive' },
    interpretController: { isRunning: () => mode === 'interpret' },
    compactController: { isRunning: () => mode === 'compact-generation' },
    compactSessionOpen: mode === 'compact-playback',
    chrome: { tabs: { get: async id => { assert.equal(id, 1); return tab; } } },
    pickTargetTab: async () => { queries++; return { id: 2, url: 'https://other.test' }; },
    renderContext() {},
    stopCompactPlayback: () => { throw Error('must preserve playback'); },
    stopDubPlayback: () => { throw Error('must preserve playback'); },
  });
  vm.runInContext(refresh, context);
  await vm.runInContext('refreshTab()', context);
  assert.equal(queries, 0, mode);
  assert.equal(context.state.tab.id, 1, mode);
}
console.log('PASS tab switches retain the source and playback across all audio modes');
