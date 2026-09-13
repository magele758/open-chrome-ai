import assert from 'node:assert/strict';
import { loadPageCaptions, getCachedTranscript, isReusablePageTranscript, setCachedTranscript, usableTranscript, videoIdentity } from '../lib/captions.js';
import { summarizeTranscript } from '../lib/summarize-transcript.js';
import { installMemoryIndexedDB } from './idb_mem.mjs';

const idb = installMemoryIndexedDB();
const store = {};
let pageReads = 0;
async function asrItemKey(url) {
  const id = videoIdentity(url);
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id));
  const hash = [...new Uint8Array(buf)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'pl.asr.item.' + hash;
}

assert.equal(usableTranscript(null), null);
assert.equal(usableTranscript({ status: 'ready', text: '' }), null);
assert.equal(usableTranscript({ status: 'n/a', text: 'x' }), null);

const packed = usableTranscript({
  status: 'ready',
  text: '[0:01] Hello\n[0:08] World',
  cues: [{ start: 1, text: 'Hello' }],
  source: 'asr-full',
  complete: true,
});
assert.equal(packed.text.includes('Hello'), true);
assert.equal(packed.complete, true);

const tracks = usableTranscript({
  status: 'ready',
  text: '[0:00] only what the player has loaded',
  source: 'textTracks',
});
assert.equal(tracks, null);
for (const source of ['youtube', 'textTracks', 'downloaded-subtitles', 'library', 'unknown']) {
  assert.equal(usableTranscript({ status: 'ready', text: 'ad', source, complete: true }), null);
}
assert.equal(isReusablePageTranscript(tracks), false);
assert.equal(isReusablePageTranscript({ status: 'ready', text: 'partial', source: 'asr-cache' }), false);
assert.equal(isReusablePageTranscript({ status: 'ready', text: 'partial', source: 'library' }), false);
assert.equal(isReusablePageTranscript(packed), true);
assert.equal(isReusablePageTranscript({ status: 'ready', text: 'full', source: 'asr-full', complete: true }), true);

globalThis.fetch = async () => new Response('no', { status: 403 });
globalThis.chrome = {
  scripting: {
    executeScript: async () => { pageReads++; throw new Error('must not read player subtitles'); },
  },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = store[k];
          return out;
        }
        return { ...store };
      },
      set: async (obj) => Object.assign(store, obj),
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
};
const caps = await loadPageCaptions(7, 'https://www.youtube.com/watch?v=x');
assert.equal(caps.status, 'missing');
assert.equal(pageReads, 0, 'cached transcript lookup never reads site subtitles');
await setCachedTranscript('https://ads.test', { source: 'downloaded-subtitles', text: 'advertisement', complete: true });
assert.equal(await getCachedTranscript('https://ads.test'), null, 'subtitles cannot be saved as audio cache');

const summary = await summarizeTranscript({
  text: packed.text,
  title: 'fixture',
  model: {},
  complete: async () => '要点：问候。\n\n00:01 开场',
});
assert.match(summary, /要点/);

await setCachedTranscript('https://cache.test/v', { source: 'asr-full', text: 'cached body', cues: [{ start: 0, text: 'hi' }], complete: true });
const cacheKey = await asrItemKey('https://cache.test/v');
assert.equal(store[cacheKey], undefined, 'asr body not in chrome.storage');
assert.equal(idb.get(cacheKey)?.text, 'cached body');
assert.equal((await getCachedTranscript('https://cache.test/v'))?.text, 'cached body');
const subCaps = usableTranscript({
  status: 'ready',
  text: '[0:00] Subtitle line 1\n[0:05] Subtitle line 2',
  cues: [{ start: 0, text: 'Subtitle line 1' }, { start: 5, text: 'Subtitle line 2' }],
  source: 'subtitles',
  complete: true,
});
assert.notEqual(subCaps, null);
assert.equal(subCaps.complete, true);
assert.equal(isReusablePageTranscript(subCaps), true);
assert.equal(subCaps.source, 'subtitles');
await setCachedTranscript('https://sub.test/v', subCaps);
const cachedSub = await getCachedTranscript('https://sub.test/v');
assert.equal(cachedSub?.text, subCaps.text);
assert.equal(cachedSub?.source, 'subtitles');

const subSummary = await summarizeTranscript({
  text: subCaps.text,
  title: 'subtitle fixture',
  model: {},
  complete: async () => '要点：字幕总结。\n\n00:00 开场',
});
assert.match(subSummary, /字幕总结/);

console.log('ok audio & subtitle cache, rejects legacy cache and summarizes correctly');
