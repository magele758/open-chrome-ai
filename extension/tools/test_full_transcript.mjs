import assert from 'node:assert/strict';
import { acquireFullTranscript, ensureMediaHelper, helperRequestInit, mediaHelperStartHint, probeMediaHelper } from '../lib/full-transcript.js';
import { summarizeTranscript, splitTranscript } from '../lib/summarize-transcript.js';
import { getCachedTranscript, setCachedTranscript, videoIdentity } from '../lib/captions.js';
import { formatTranscript } from '../lib/asr.js';
import { installMemoryIndexedDB } from './idb_mem.mjs';

const idb = installMemoryIndexedDB();
async function asrItemKey(url) {
  const id = videoIdentity(url);
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id));
  const hash = [...new Uint8Array(buf)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'pl.asr.item.' + hash;
}
const id = 'a'.repeat(32);
let deleted = 0, requests = 0;
const statuses = [];
const fetchImpl = async (url, options = {}) => {
  if (options.method === 'POST') return Response.json({ id });
  if (options.method === 'DELETE') { deleted++; return Response.json({ ok: true }); }
  if (url.includes('/audio/')) return new Response(new Blob(['audio'], { type: 'audio/wav' }));
  return Response.json({ status: 'ready', duration: 610, parts: [{ index: 0, start: 0, duration: 300 }, { index: 1, start: 300, duration: 300 }, { index: 2, start: 600, duration: 10 }] });
};
const asr = { preset: 'v1-transcribe', baseUrl: 'https://asr.test' };
globalThis.fetch = async () => Response.json({ segments: ++requests === 2 ? [] : [{ start: 1, end: 3, text: requests === 3 ? 'ENDING' : 'BEGINNING' }] });
const result = await acquireFullTranscript({ url: 'https://video.test', asr, fetchImpl, onProgress: p => statuses.push(p) });
assert.equal(result.complete, true);
assert.equal(result.cues.at(-1).start, 601);
assert.match(result.text, /ENDING/);
assert.equal(requests, 3, 'silence does not omit the next audio segment');
assert.equal(deleted, 1);
assert(!statuses.some(s => s.status === 'recording'));
globalThis.fetch = async () => new Response('failure', { status: 500 });
await assert.rejects(acquireFullTranscript({ url: 'https://video.test', asr, fetchImpl }), /500/);
assert.equal(deleted, 2, 'failure also cleans up');
const abort = new AbortController();
await assert.rejects(acquireFullTranscript({ url: 'https://video.test', asr, fetchImpl, signal: abort.signal, onProgress: p => { if (p.status === 'uploading') abort.abort(); } }), /abort/i);
assert.equal(deleted, 3);
await assert.rejects(acquireFullTranscript({ url: 'https://video.test', asr, fetchImpl: async (url, opts = {}) => opts.method === 'POST' ? Response.json({ id }) : opts.method === 'DELETE' ? Response.json({}) : Response.json({ status: 'ready', duration: 10, subtitle: { format: 'vtt', body: 'untrusted subtitles' } }) }), /没有取得完整音轨/, 'old helper subtitle responses are never consumed');
const store = {};
globalThis.chrome = { storage: { local: {
  get: async (keys) => {
    if (typeof keys === 'string') return { [keys]: store[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      return out;
    }
    return { ...store };
  },
  set: async (value) => Object.assign(store, value),
  remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
} } };
const large = formatTranscript(Array.from({ length: 1200 }, (_, i) => ({ start: i, text: `cue ${i} ${'full text '.repeat(4)}` })));
await setCachedTranscript('https://video.test', { ...large, complete: true, source: "asr-full" });
const cached = await getCachedTranscript('https://video.test');
assert.equal(cached.text, large.text);
assert.equal(cached.cues.length, 1200);
assert.equal(cached.complete, true);
const largeKey = await asrItemKey('https://video.test');
assert.equal(store[largeKey], undefined, 'transcript body not in chrome.storage');
assert.equal(idb.has(largeKey), true, 'transcript body in idb');
assert.equal(store['pl.asr.index']?.length, 1, 'asr index stays in chrome.storage');

const legacyUrl = 'https://legacy.test/video';
const legacyKey = await asrItemKey(legacyUrl);
store[legacyKey] = { text: 'legacy transcript', cues: [{ start: 1, text: 'hi' }], complete: true };
const migrated = await getCachedTranscript(legacyUrl);
assert.equal(migrated, null, 'unverified legacy cache is ignored');
assert.equal(store[legacyKey], undefined, 'legacy chrome item removed');
assert.equal(idb.get(legacyKey)?.text, 'legacy transcript');

for (let i = 0; i < 25; i++) {
  await setCachedTranscript(`https://video.test/v${i}`, { text: `t${i}`, cues: [], complete: true, source: 'asr-full' });
}
assert.equal(store['pl.asr.index']?.length, 24, 'asr cache cap');
const droppedKey = await asrItemKey('https://video.test/v0');
assert.equal(await getCachedTranscript('https://video.test/v0'), null);
assert.equal(idb.has(droppedKey), false, 'evicted asr item dropped from idb');
assert.equal((await getCachedTranscript('https://video.test/v24'))?.text, 't24');
const text = Array.from({ length: 7 }, (_, i) => `[${i}:00] MARKER_${i} ${'words '.repeat(1700)}\n`).join('');
assert.equal(splitTranscript(text).join(''), text, 'chunking loses no characters');
const seen = [];
const summary = await summarizeTranscript({ text, model: {}, complete: async (_model, { messages, maxTokens }) => {
  const input = messages.at(-1).content;
  if (input.includes('提取本段要点')) {
    assert.ok(maxTokens >= 8000, 'note budget must outrun thinking tokens');
    seen.push(input);
    return input.match(/MARKER_\d/g)?.join(' ') || 'continuation';
  }
  assert(input.includes('MARKER_6'), 'final synthesis includes the ending');
  return 'complete summary';
} });
assert.equal(summary, 'complete summary');
for (let i = 0; i < 7; i++) assert(seen.some(s => s.includes(`MARKER_${i}`)));

assert.match(mediaHelperStartHint(), /conda run -n pagelens-media python tools\/media_helper.py --ensure/);
assert.match(mediaHelperStartHint(), /不会改为跟随播放录音/);
assert.equal(helperRequestInit({ method: 'POST' }).targetAddressSpace, 'loopback');
assert.equal(helperRequestInit({ method: 'POST' }).method, 'POST');
assert.equal((await probeMediaHelper({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })).ok, false);
assert.equal((await probeMediaHelper({ fetchImpl: async () => Response.json({ ok: true, service: 'pagelens-media' }) })).ok, true);
assert.equal((await probeMediaHelper({ fetchImpl: async () => Response.json({ ok: true, service: 'other' }) })).ok, false);

globalThis.fetch = async () => Response.json({ segments: [{ start: 1, end: 3, text: 'RECOVERED' }] });
let started = 0;
let up = false;
const flaky = async (url, options = {}) => {
  if (!up) throw new TypeError('Failed to fetch');
  if (String(url).endsWith('/health')) return Response.json({ ok: true, service: 'pagelens-media' });
  if (options.method === 'POST') return Response.json({ id });
  if (options.method === 'DELETE') return Response.json({ ok: true });
  if (String(url).includes('/audio/')) return new Response(new Blob(['audio'], { type: 'audio/wav' }));
  return Response.json({ status: 'ready', duration: 610, parts: [{ index: 0, start: 0, duration: 300 }, { index: 1, start: 300, duration: 300 }, { index: 2, start: 600, duration: 10 }] });
};
const recovered = await acquireFullTranscript({
  url: 'https://video.test', asr, fetchImpl: flaky,
  startImpl: async () => { started += 1; up = true; },
});
assert.equal(recovered.complete, true);
assert.equal(recovered.source, 'asr-full');
assert.equal(started, 1, 'helper is started once after a connection failure');

const stillDown = async () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(
  acquireFullTranscript({ url: 'https://video.test', asr, fetchImpl: stillDown, startImpl: async () => {} }),
  /完整媒体服务未启动/,
);
assert.equal((await ensureMediaHelper({ fetchImpl: stillDown, startImpl: async () => {} })).ok, false);

// Subtitle-first priority test:
{
  let subDeleted = 0;
  const subStatuses = [];
  const subFetch = async (url, options = {}) => {
    if (options.method === 'POST') return Response.json({ id });
    if (options.method === 'DELETE') { subDeleted++; return Response.json({ ok: true }); }
    return Response.json({
      status: 'ready',
      duration: 120,
      subtitles: [
        { id: 'sub:0', start: 0.5, end: 3.2, src: 'Hello from native subtitles' },
        { id: 'sub:1', start: 3.5, end: 6.8, src: 'This is fast and skips ASR' },
      ],
      parts: [{ index: 0, start: 0, duration: 120 }],
    });
  };
  const noAsr = { preset: 'none', baseUrl: '' };
  const subResult = await acquireFullTranscript({
    url: 'https://video.test/with-sub',
    asr: noAsr,
    fetchImpl: subFetch,
    onProgress: p => subStatuses.push(p),
  });
  assert.equal(subResult.complete, true);
  assert.equal(subResult.source, 'subtitles');
  assert.equal(subResult.duration, 120);
  assert.equal(subResult.cues.length, 2);
  assert.match(subResult.text, /Hello from native subtitles/);
  assert.match(subResult.text, /skips ASR/);
  assert.equal(subDeleted, 1, 'subtitle job cleans up via DELETE');
  assert(subStatuses.some(s => String(s.hint).includes('字幕优先')));

  // Subtitle missing and ASR not configured throws helpful error
  const noSubFetch = async (url, options = {}) => {
    if (options.method === 'POST') return Response.json({ id });
    if (options.method === 'DELETE') return Response.json({ ok: true });
    return Response.json({
      status: 'ready',
      duration: 60,
      parts: [{ index: 0, start: 0, duration: 60 }],
    });
  };
  await assert.rejects(
    acquireFullTranscript({ url: 'https://video.test/no-sub', asr: noAsr, fetchImpl: noSubFetch }),
    /当前视频未检测到字幕，请在设置中配置语音识别（ASR）后重新提取。/,
  );
}

console.log('PASS full acquisition, silent segments, offsets, failure/cancel cleanup, reject subtitle-only, untruncated cache, whole-document summary, helper auto-start, subtitle-first priority');
