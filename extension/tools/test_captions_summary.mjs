import assert from 'node:assert/strict';
import { getCachedTranscript, isReusablePageTranscript, setCachedTranscript, usableTranscript, videoIdentity } from '../lib/captions.js';
import { loadYoutubeCaptions } from '../lib/youtube.js';
import { summarizeTranscript } from '../lib/summarize-transcript.js';
import { installMemoryIndexedDB } from './idb_mem.mjs';

const idb = installMemoryIndexedDB();
const store = {};
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
  source: 'youtube',
  complete: true,
});
assert.equal(packed.text.includes('Hello'), true);
assert.equal(packed.complete, true);

const tracks = usableTranscript({
  status: 'ready',
  text: '[0:00] only what the player has loaded',
  source: 'textTracks',
});
assert.equal(tracks.complete, false);
assert(tracks.text.includes('only what'));
assert.equal(isReusablePageTranscript(tracks), false);
assert.equal(isReusablePageTranscript({ status: 'ready', text: 'partial', source: 'asr-cache' }), false);
assert.equal(isReusablePageTranscript({ status: 'ready', text: 'partial', source: 'library' }), false);
assert.equal(isReusablePageTranscript(packed), true);
assert.equal(isReusablePageTranscript({ status: 'ready', text: 'full', source: 'asr-full', complete: true }), true);

globalThis.fetch = async () => new Response('no', { status: 403 });
globalThis.chrome = {
  scripting: {
    executeScript: async ({ args }) => {
      if (!args?.length) {
        return [{ result: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x', languageCode: 'en', kind: '', name: '' }] }];
      }
      return [{ result: { events: [
        { tStartMs: 900, dDurationMs: 3000, segs: [{ utf8: 'Hello from page' }] },
        { tStartMs: 2100, dDurationMs: 3000, segs: [{ utf8: 'Hello from page\nagain' }] },
      ] } }];
    },
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
const caps = await loadYoutubeCaptions(7, 'https://www.youtube.com/watch?v=x');
assert.equal(caps.status, 'ready');
assert.equal(caps.complete, true);
assert(caps.text.includes('Hello from page'), caps.text);

const summary = await summarizeTranscript({
  text: packed.text,
  title: 'fixture',
  model: {},
  complete: async () => '要点：问候。\n\n00:01 开场',
});
assert.match(summary, /要点/);

await setCachedTranscript('https://cache.test/v', { text: 'cached body', cues: [{ start: 0, text: 'hi' }], complete: true });
const cacheKey = await asrItemKey('https://cache.test/v');
assert.equal(store[cacheKey], undefined, 'asr body not in chrome.storage');
assert.equal(idb.get(cacheKey)?.text, 'cached body');
assert.equal((await getCachedTranscript('https://cache.test/v'))?.text, 'cached body');
const oldKey = await asrItemKey('https://old.test/v');
store[oldKey] = { text: 'old asr', cues: [], complete: true };
assert.equal((await getCachedTranscript('https://old.test/v'))?.text, 'old asr');
assert.equal(store[oldKey], undefined, 'old asr migrated off chrome.storage');

console.log('ok usable captions, youtube page-context fallback, summarize without complete-only gate');
