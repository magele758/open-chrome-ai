import assert from 'node:assert/strict';
import { OPENING_READY_TEXT, OPENING_READY_TTS, openingReadyCount, runInterpret } from '../lib/interpret.js';

const textSettings = { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'k' };
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await waitMs(15);
  }
  throw new Error(`timeout: ${fn.toString()}`);
}

function gate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function installChrome(player) {
  player.cmds = player.cmds || [];
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: 'https://example.test/video' }),
      create: async () => { throw new Error('must not open a new tab'); },
      remove: async () => { throw new Error('must not close a spawned tab'); },
    },
    scripting: {
      executeScript: async ({ args }) => {
        const [cmd, arg = {}] = args;
        player.cmds.push(cmd === 'control' ? arg.action : cmd);
        if (cmd === 'control') {
          if (arg.action === 'pause') player.paused = true;
          else player.paused = false;
        }
        if (cmd === 'state' && player.advance && !player.paused && !player.ended) {
          player.currentTime = Math.min(player.duration, player.currentTime + player.advance);
        }
        return [{
          result: {
            ok: true,
            currentTime: player.currentTime,
            duration: player.duration,
            paused: player.paused,
            ended: Boolean(player.ended || player.currentTime >= player.duration - 0.4),
            playbackRate: player.playbackRate || 1,
            seekRevision: player.seekRevision,
            pauseRevision: player.pauseRevision,
            userPaused: player.userPaused,
          },
        }];
      },
    },
  };
}

function mockTranslateFetch({ delay } = {}) {
  return async (_url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body || '{}') : {};
    if (!body.messages) return new Response('not-llm', { status: 404 });
    if (options.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (delay) {
      await Promise.race([
        delay,
        new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }),
      ]);
    }
    const src = body.messages?.at(-1)?.content || '';
    const zh = /second|Cue 1 |cue 1 /i.test(src) ? '第二句' : /Cue (\d+)/.test(src)
      ? `第${src.match(/Cue (\d+)/)[1]}句`
      : '你好世界';
    const content = body.messages[0]?.content?.includes('"prefix"')
      ? JSON.stringify({ prefix: src, translation: zh, suffix: '' }) : zh;
    return Response.json({ choices: [{ message: { content } }] });
  };
}

function loudWav() {
  return new Blob([new Uint8Array(2000)], { type: 'audio/wav' });
}

function mockRecordSlice() {
  return async () => ({ blob: loudWav(), mime: 'audio/wav', seconds: 4 });
}


// --- audio path also silences speakers (dest remains for ASR) ---
{
  const player = { currentTime: 1, duration: 8, paused: false, ended: true, advance: 0 };
  installChrome(player);
  const result = await runInterpret({
    tabId: 1,
    settings: {
      text: textSettings,
      asr: { baseUrl: 'https://asr.test/v1', model: 'w' },
      tts: { preset: 'off', baseUrl: '' },
    },
    cues: [{ start: 0, text: "AD FROM LEGACY CAPTIONS" }],
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
  });
  assert.equal(result.mode, 'audio');
  assert(player.cmds.includes('silence'), 'no-caption path must mute speakers');
  assert(player.cmds.includes('restore'), 'no-caption path restores after stop');
}

// --- audio + TTS: each recorded slice is the voice prompt ---
{
  const player = { currentTime: 0.2, duration: 8, paused: false, ended: false, advance: 0 };
  installChrome(player);
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body);
        if (json.messages) return mockTranslateFetch()(_url, options);
      } catch { /* form upload */ }
    }
    return Response.json({
      text: 'Hello from the speaker.',
      segments: [{ start: 0, text: 'Hello from the speaker.' }],
    });
  };
  const refs = [];
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: {
      text: textSettings,
      asr: { baseUrl: 'https://asr.test/v1', model: 'w' },
      tts: { baseUrl: 'https://tts.example.test' },
    },
    cues: [{ start: 0, text: "AD FROM LEGACY CAPTIONS" }],
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: mockRecordSlice(),
    signal: abort.signal,
    synthesizeTts: async (_tts, _text, opts) => {
      refs.push(Boolean(opts?.referenceBlob));
      player.ended = true;
      abort.abort();
      return { blob: new Blob(['wav']), mime: 'audio/wav' };
    },
  });
  await running.catch((err) => {
    if (err?.name !== 'AbortError' && !/abort/i.test(err?.message || '')) throw err;
  });
  assert(refs[0] === true, 'audio-path TTS must clone from the recorded slice');
}

// --- audio + TTS: record enough opening slices, play only after opening dub buffer ---
{
  const player = { currentTime: 0.2, duration: 40, paused: false, ended: false, advance: 0 };
  installChrome(player);
  let records = 0;
  const last = gate();
  let dubs = 0;
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body);
        if (json.messages) return mockTranslateFetch()(_url, options);
      } catch { /* form upload */ }
    }
    return Response.json({
      text: 'Hello from the speaker.',
      segments: [{ start: 0, text: 'Hello from the speaker.' }],
    });
  };
  const need = openingReadyCount(true);
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: {
      text: textSettings,
      asr: { baseUrl: 'https://asr.test/v1', model: 'w' },
      tts: { baseUrl: 'https://tts.example.test' },
    },
    cues: [{ start: 0, text: "AD FROM LEGACY CAPTIONS" }],
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => {
      records += 1;
      if (records > need) {
        abort.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
    signal: abort.signal,
    synthesizeTts: async () => {
      dubs += 1;
      if (dubs >= need) await last.promise;
      return { blob: new Blob([`wav${dubs}`]), mime: 'audio/wav' };
    },
  });
  await waitUntil(() => records >= need);
  await waitUntil(() => dubs >= Math.max(1, need - 1));
  await waitMs(50);
  assert(player.paused, 'audio path stays held until opening dub buffer is ready');
  assert(records >= need, `must record ${need} opening slices, got ${records}`);
  const playsAtHold = player.cmds.filter((c) => c === 'play').length;
  last.resolve();
  await running.catch((err) => {
    if (err?.name !== 'AbortError' && !/abort/i.test(err?.message || '')) throw err;
  });
  assert(
    player.cmds.filter((c) => c === 'play').length > playsAtHold,
    'must resume only after the opening dub buffer is ready',
  );
}

// --- audio without TTS: record opening slices, play only after text buffer settles ---
{
  const player = { currentTime: 0.2, duration: 40, paused: false, ended: false, advance: 0 };
  installChrome(player);
  let records = 0;
  const last = gate();
  let zhN = 0;
  globalThis.fetch = async (_url, options = {}) => {
    const body = options.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body);
        if (json.messages) {
          const i = ++zhN;
          if (i >= OPENING_READY_TEXT) await last.promise;
          return mockTranslateFetch()(_url, options);
        }
      } catch { /* form upload */ }
    }
    return Response.json({
      text: 'Hello from the speaker.',
      segments: [{ start: 0, text: 'Hello from the speaker.' }],
    });
  };
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: {
      text: textSettings,
      asr: { baseUrl: 'https://asr.test/v1', model: 'w' },
      tts: { preset: 'off', baseUrl: '' },
    },
    cues: [{ start: 0, text: "AD FROM LEGACY CAPTIONS" }],
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => {
      records += 1;
      if (records > OPENING_READY_TEXT) {
        abort.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
    signal: abort.signal,
  });
  await waitUntil(() => records >= OPENING_READY_TEXT);
  await waitUntil(() => zhN >= 1);
  await waitMs(50);
  assert(player.paused, 'audio path stays held until opening text buffer settles');
  const playsAtHold = player.cmds.filter((c) => c === 'play').length;
  last.resolve();
  await running.catch((err) => {
    if (err?.name !== 'AbortError' && !/abort/i.test(err?.message || '')) throw err;
  });
  assert(
    player.cmds.filter((c) => c === 'play').length > playsAtHold,
    'must resume only after the opening text buffer settles',
  );
}

// --- audio opening must not force play over a user pause ---
{
  const player = { currentTime: 0.2, duration: 40, paused: true, ended: false, advance: 0 };
  installChrome(player);
  let records = 0;
  const abort = new AbortController();
  globalThis.fetch = mockTranslateFetch();
  const running = runInterpret({
    tabId: 1,
    settings: {
      text: textSettings,
      asr: { baseUrl: 'https://asr.test/v1', model: 'w' },
      tts: { preset: 'off', baseUrl: '' },
    },
    cues: [{ start: 0, text: "AD FROM LEGACY CAPTIONS" }],
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => {
      records += 1;
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
    signal: abort.signal,
  });
  await waitUntil(() => player.cmds.includes('silence'));
  await waitMs(80);
  assert.equal(records, 0, 'must not capture opening slices while the user is paused');
  assert(!player.cmds.includes('play'), 'user pause is not forced for opening capture');
  abort.abort();
  await running;
}

console.log('ok audio-only interpret: TTS reference, opening buffer, user pause, no new page');

// Retry a looping ASR result before dropping the original slice.
{
  const player = { currentTime: 0, duration: 30, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const bad = '社会,我们只能有两个研究的研究' + '仅'.repeat(30);
  let asrCalls = 0;
  globalThis.fetch = async () => Response.json({ segments: [{ start: 0, text: ++asrCalls === 1 ? bad : '下面介绍第二个研究。' }] });
  const events = [], dubbed = [];
  const result = await runInterpret({
    tabId: 1,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { baseUrl: 'https://tts.test' } },
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => { player.currentTime += 5; return { blob: loudWav(), mime: 'audio/wav', seconds: 5 }; },
    synthesizeTts: async (_settings, text) => { dubbed.push(text); return { blob: loudWav() }; },
    onEvent: event => {
      events.push(event);
      if (event.type === 'line') player.ended = true;
    },
  });
  assert(!events.some(e => e.type === 'warn' && /语音识别出现异常重复/.test(e.message)), 'successful ASR retry should not report a dropped slice');
  assert(result.lines.length > 0, 'continues after rejected segment');
  assert(result.lines.every(line => !line.src.includes('仅')));
  assert(dubbed.length > 0 && dubbed.every(text => !text.includes('仅')));
}
console.log('PASS bad ASR recovered before display/TTS; subsequent speech still completes');

function mockAsrAndTranslate(text = 'Hello from the speaker now.') {
  return async (_url, options = {}) => {
    const body = options.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body);
        if (json.messages) return mockTranslateFetch()(_url, options);
      } catch { /* form upload */ }
    }
    return Response.json({ text, segments: [{ start: 0, end: 5, text }] });
  };
}

// 2x playback: slice end is video.currentTime, not wall-clock seconds.
{
  const player = { currentTime: 10, duration: 40, paused: false, ended: false, advance: 0, playbackRate: 2 };
  installChrome(player);
  globalThis.fetch = mockAsrAndTranslate();
  const events = [];
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { preset: 'off', baseUrl: '' } },
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => {
      player.currentTime += 10;
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
    signal: abort.signal,
    onEvent: ev => {
      events.push(ev);
      if (ev.type === 'line') {
        player.ended = true;
        abort.abort();
      }
    },
  });
  await running.catch(err => {
    if (err?.name !== 'AbortError' && !/abort/i.test(err?.message || '')) throw err;
  });
  const line = events.find(ev => ev.type === 'line');
  assert(line, '2x path still emits a caption');
  assert(line.start >= 9.5 && line.start <= 11, `2x start follows video clock, got ${line.start}`);
  assert(line.end >= 19.5, `2x end follows video clock, not 5s wall, got ${line.end}`);
}
console.log('PASS 2x slice timestamps follow video.currentTime');

// After the spoken window + trail, the stale caption is cleared.
{
  const player = { currentTime: 0.2, duration: 40, paused: false, ended: false, advance: 0 };
  installChrome(player);
  globalThis.fetch = mockAsrAndTranslate();
  const events = [];
  const abort = new AbortController();
  let records = 0;
  const running = runInterpret({
    tabId: 1,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { preset: 'off', baseUrl: '' } },
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => {
      if (records++ > 0) {
        // Real recording takes time. Hold the next slice while the clock moves
        // past the first caption instead of finishing the entire mock video.
        await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
      }
      player.currentTime += 5;
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
    signal: abort.signal,
    onEvent: ev => events.push(ev),
  });
  await waitUntil(() => events.some(ev => ev.type === 'line'));
  player.currentTime = 12;
  await waitUntil(() => events.some(ev => ev.type === 'status' && ev.clearLine));
  abort.abort();
  await running;
}
console.log('PASS stale caption clears after leaving the video window');

// Seek revision flushes queued work and clears the current line.
{
  const player = { currentTime: 0.2, duration: 80, paused: false, ended: false, advance: 0, seekRevision: 0 };
  installChrome(player);
  globalThis.fetch = mockAsrAndTranslate();
  const events = [];
  const abort = new AbortController();
  let jumped = false;
  const running = runInterpret({
    tabId: 1,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { preset: 'off', baseUrl: '' } },
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => {
      if (jumped) {
        await waitMs(30);
        return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
      }
      player.currentTime += 5;
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
    signal: abort.signal,
    onEvent: ev => {
      events.push(ev);
      if (ev.type === 'line' && !jumped) {
        jumped = true;
        player.seekRevision = 1;
        player.currentTime = 40;
      }
    },
  });
  await waitUntil(() => events.some(ev => ev.type === 'status' && ev.clearLine && /跳转/.test(ev.message || '')));
  abort.abort();
  await running;
}
console.log('PASS seek revision clears the line and realigns');

// Independent source must never play the picture to gather opening audio.
{
  const player = { currentTime: 10, duration: 100, paused: false, advance: 0, userPaused: false };
  installChrome(player);
  const translation = mockTranslateFetch();
  globalThis.fetch = async (url, opts = {}) => String(url).includes('asr.test')
    ? Response.json({ text: 'Hello from the speaker.', segments: [{ start: 0, end: 5, text: 'Hello from the speaker.' }] })
    : translation(url, opts);
  const third = gate(), abort = new AbortController();
  let dubs = 0, closed = false;
  const running = runInterpret({
    tabId: 1, startAt: 10, signal: abort.signal,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { baseUrl: 'https://tts.test' } },
    openSource: async () => {
      assert(player.paused, 'download starts with the player really paused');
      assert.equal(player.cmds.filter(c => c === 'play').length, 0);
      return { duration: 100, close: async () => { closed = true; },
        slice: async start => ({ blob: loudWav(), mime: 'audio/wav', start, end: start + 5, seconds: 5 }) };
    },
    recordSlice: async () => { throw new Error('must not capture the visible player'); },
    synthesizeTts: async () => {
      dubs++;
      if (dubs === 3) await third.promise;
      return { blob: loudWav() };
    },
  });
  await waitUntil(() => dubs === 3);
  assert(player.paused);
  assert.equal(player.currentTime, 10, 'preparation must not advance the video');
  assert.equal(player.cmds.filter(c => c === 'play').length, 0, 'no hidden play during download, ASR or synthesis');
  third.resolve();
  await waitUntil(() => player.cmds.includes('play'));
  abort.abort();
  await running;
  assert(closed, 'independent audio job is cleaned up');
  console.log('PASS independent source holds video until three complete dubs');
}

// Real orchestration: no startup sentence, cross-chunk negation, then an EOF tail.
{
  const player = { currentTime: 0, duration: 15, paused: false, advance: 0, seekRevision: 0 };
  installChrome(player);
  const sources = ["I don't think.", 'this is a good idea.', 'We can discuss another option'];
  const requests = [];
  let asrIndex = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('asr.test')) {
      const text = sources[asrIndex++];
      return Response.json({ segments: [{ start: 0, end: 5, text }] });
    }
    const body = JSON.parse(options.body);
    requests.push(body);
    const src = body.messages.at(-1).content;
    const structured = body.messages[0].content.includes('"prefix"');
    const last = src === sources[2];
    const zh = last ? '我们可以讨论另一个方案。' : '我不认为这是个好主意。';
    return Response.json({ choices: [{ message: { content: structured
      ? JSON.stringify(last ? { prefix: '', translation: '', suffix: src } : { prefix: src, translation: zh, suffix: '' })
      : zh } }] });
  };
  const result = await runInterpret({
    tabId: 1,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { preset: 'off' } },
    capture: { stream: {}, playback: { setGain() {} } },
    recordSlice: async () => {
      player.currentTime += 5;
      return { blob: loudWav(), mime: 'audio/wav', seconds: 5 };
    },
  });
  assert.deepEqual(result.lines.map(line => line.src), ["I don't think this is a good idea.", sources[2]]);
  assert.deepEqual(result.lines.map(line => line.zh), ['我不认为这是个好主意。', '我们可以讨论另一个方案。']);
  assert.equal(result.lines[0].start, 0);
  assert.equal(result.lines[0].end, 10);
  assert.equal(result.lines[1].end, 15);
  assert.equal(requests.length, 3, 'one combined translation, one defer decision, one EOF translation');
  assert.equal(requests[2].messages[2].content, '我不认为这是个好主意。', 'EOF translation receives confirmed previous meaning');
  assert.equal(asrIndex, 3);
  console.log('PASS semantic startup obtains continuation; negation and EOF tail translated once with context');
}

// Custom bufferSegments (e.g. 5) buffers 5 complete dubs before releasing hold.
{
  const player = { currentTime: 0, duration: 60, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const translation = mockTranslateFetch();
  globalThis.fetch = async (url, opts = {}) => String(url).includes('asr.test')
    ? Response.json({ text: 'Speech slice', segments: [{ start: 0, end: 5, text: 'Speech slice' }] })
    : translation(url, opts);
  const fifth = gate(), abort = new AbortController();
  let dubs = 0, closed = false;
  const running = runInterpret({
    tabId: 1, startAt: 0, signal: abort.signal,
    settings: {
      text: textSettings,
      asr: { baseUrl: 'https://asr.test/v1', model: 'w' },
      tts: { baseUrl: 'https://tts.test', bufferSegments: 5 },
    },
    openSource: async () => ({
      duration: 60,
      close: async () => { closed = true; },
      slice: async start => ({ blob: loudWav(), mime: 'audio/wav', start, end: start + 5, seconds: 5 }),
    }),
    recordSlice: async () => { throw new Error('must not capture live'); },
    synthesizeTts: async () => {
      dubs++;
      if (dubs === 5) await fifth.promise;
      return { blob: loudWav() };
    },
  });
  await waitUntil(() => dubs === 5);
  assert(player.paused, 'paused while buffering 5 segments');
  assert.equal(player.cmds.filter(c => c === 'play').length, 0, 'no playback before 5 segments ready');
  fifth.resolve();
  await waitUntil(() => player.cmds.includes('play'));
  abort.abort();
  await running;
  assert(closed);
  console.log('PASS custom bufferSegments=5 buffers 5 complete dubs before starting playback');
}


// Downloaded EOF must not disable buffering/transport control while TTS is pending.
{
  const player = { currentTime: 0, duration: 15, paused: false, advance: 0, userPaused: false };
  installChrome(player);
  globalThis.fetch = async () => Response.json({ segments: [{ start: 0, end: 5, text: '这是完整的一句话。' }] });
  const audios = [], nextDub = gate(), abort = new AbortController();
  const OriginalAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor() { this.paused = true; this.readyState = 4; this.duration = 8; this.currentTime = 0; audios.push(this); }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  };
  let dubs = 0, slices = 0;
  const running = runInterpret({ tabId: 1, signal: abort.signal, bufferSegments: 1,
    settings: { text: textSettings, asr: { baseUrl: 'https://asr.test/v1', model: 'w' }, tts: { baseUrl: 'https://tts.test' } },
    openSource: async () => ({ duration: 15, close: async () => {}, slice: async start => {
      slices++; return { blob: loudWav(), mime: 'audio/wav', start, end: start + 5, seconds: 5 };
    } }),
    synthesizeTts: async () => { if (++dubs === 2) await nextDub.promise; return { blob: loudWav() }; },
  });
  try {
    await waitUntil(() => slices === 3 && audios[0] && !audios[0].paused);
    player.currentTime = 5;
    await waitUntil(() => player.paused);
    assert(!audios[0].paused, 'long translation continues while picture waits at sentence boundary');
    audios[0].onended();
    await waitUntil(() => dubs === 2);
    await waitMs(350);
    assert(player.paused, 'EOF must keep monitoring and pause picture during TTS starvation');
    player.userPaused = true;
    nextDub.resolve();
    await waitUntil(() => audios.length === 2);
    await waitMs(150);
    assert(player.paused && audios[1].paused, 'refill must respect user pause');
    player.userPaused = false;
    // A user resumes the actual player too.
    player.paused = false;
    await waitUntil(() => !audios[1].paused);
  } finally {
    abort.abort(); nextDub.resolve(); await running; globalThis.Audio = OriginalAudio;
  }
  console.log('PASS EOF starvation, long dub picture hold, refill and user pause');
}
