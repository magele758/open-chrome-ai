import assert from 'node:assert/strict';
import { isReusablePageTranscript, usableTranscript } from '../lib/captions.js';
import { loadYoutubeCaptions } from '../lib/youtube.js';
import { summarizeTranscript } from '../lib/summarize-transcript.js';

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
      return [{ result: { events: [{ tStartMs: 900, dDurationMs: 1200, segs: [{ utf8: 'Hello from page' }] }] } }];
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
console.log('ok usable captions, youtube page-context fallback, summarize without complete-only gate');
