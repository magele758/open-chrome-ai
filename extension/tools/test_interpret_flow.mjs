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
    return Response.json({ choices: [{ message: { content: zh } }] });
  };
}

function settings({ tts = false } = {}) {
  return {
    text: textSettings,
    tts: tts ? { baseUrl: 'https://tts.example.test' } : { preset: 'off', baseUrl: '' },
  };
}

function twoCues() {
  return [
    { start: 0, end: 2, text: 'Hello world from the lecture' },
    { start: 2, end: 4.5, text: 'This is the second sentence' },
  ];
}

function nCues(n, label = 'spoken line for opening buffer') {
  return Array.from({ length: n }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 2,
    text: `Cue ${i} ${label}`,
  }));
}

// --- smoke: stay on the current tab, translations still emit ---
{
  let currentTime = 0.2;
  const events = [];
  globalThis.chrome = {
    tabs: {
      get: async () => ({ url: 'https://example.test/video' }),
      create: async () => { throw new Error('must not open a new tab'); },
      remove: async () => { throw new Error('must not close a spawned tab'); },
    },
    scripting: {
      executeScript: async ({ args }) => {
        const [cmd] = args;
        if (cmd === 'state') {
          const t = currentTime;
          currentTime = Math.min(5, currentTime + 1.6);
          return [{ result: { ok: true, currentTime: t, duration: 5, paused: false, ended: t >= 4.5 } }];
        }
        return [{ result: { ok: true, currentTime, duration: 5, paused: false } }];
      },
    },
  };
  globalThis.fetch = mockTranslateFetch();
  const result = await runInterpret({
    tabId: 1,
    settings: settings({ tts: true }),
    cues: twoCues(),
    capture: null,
    onEvent: (e) => events.push(e),
  });
  assert(result.lines.length >= 1, `expected translated lines, got ${result.lines.length}`);
  assert(result.lines.some((line) => /你好|第二/.test(line.zh)), `zh=${result.lines.map((l) => l.zh).join('|')}`);
  assert(!events.some((e) => /后台/.test(e.message || '')), 'must stay on the current tab');
}

// --- captions: pause first, play only after opening text buffer settles ---
{
  const player = { currentTime: 0.2, duration: 20, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const last = gate();
  let n = 0;
  globalThis.fetch = async (url, options = {}) => {
    const i = ++n;
    if (i >= OPENING_READY_TEXT) await last.promise;
    return mockTranslateFetch()(url, options);
  };
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    cues: nCues(Math.max(4, OPENING_READY_TEXT)),
    capture: null,
  });
  await waitUntil(() => player.cmds.includes('pause'));
  assert(!player.cmds.includes('play'), 'must not play before opening buffer is ready');
  assert(player.paused, 'system hold pauses the picture');
  const firstClock = player.cmds.find((c) => c === 'pause' || c === 'play');
  assert.equal(firstClock, 'pause', 'click interpret pauses before anything else');
  await waitUntil(() => player.cmds.includes('silence'));
  await waitUntil(() => n >= 1);
  await waitMs(80);
  assert(!player.cmds.includes('play'), 'one settled translation must not resume the picture');
  last.resolve();
  await waitUntil(() => player.cmds.includes('play'));
  assert(player.cmds.indexOf('pause') < player.cmds.indexOf('play'), 'resume only after opening text buffer settles');
  player.ended = true;
  await running;
  assert(player.cmds.includes('restore'), 'captions path restores original sound');
}

// --- user pause: first audio/translation must not auto-resume ---
{
  const player = { currentTime: 0.2, duration: 8, paused: true, ended: false, advance: 0 };
  installChrome(player);
  globalThis.fetch = mockTranslateFetch();
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    cues: twoCues(),
    capture: null,
    signal: abort.signal,
  });
  await waitUntil(() => player.cmds.includes('silence'));
  await waitMs(80);
  assert(!player.cmds.includes('play'), 'user pause is not auto-resumed when dubbing is ready');
  assert(player.paused, 'user still paused');
  abort.abort();
  await running;
  assert(!player.cmds.includes('play'), 'stop must not play over a user pause');
}

// --- paused lookahead is bounded; does not enqueue the whole transcript ---
{
  const player = { currentTime: 0.2, duration: 80, paused: true, ended: false, advance: 0 };
  installChrome(player);
  const seen = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const src = body.messages?.at(-1)?.content || '';
    seen.push(src);
    return Response.json({ choices: [{ message: { content: `译:${src.slice(0, 12)}` } }] });
  };
  const abort = new AbortController();
  const cues = Array.from({ length: 20 }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 2,
    text: `Cue ${i} spoken line for lookahead`,
  }));
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    cues,
    capture: null,
    signal: abort.signal,
  });
  await waitUntil(() => seen.length >= 1);
  await waitMs(400);
  abort.abort();
  await running;
  assert(seen.length <= 4, `lookahead must not enqueue the whole transcript, got ${seen.length}`);
  assert(seen.every((src) => /Cue [0-3] /.test(src)), `only the first window, got ${seen.join('|')}`);
}

// --- seek / gen++ drops waiting work and translates the new position ---
{
  const player = { currentTime: 0.2, duration: 80, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const extra = gate();
  let translates = 0;
  const lines = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const src = body.messages?.at(-1)?.content || '';
    translates++;
    if (translates > OPENING_READY_TEXT) {
      await Promise.race([
        extra.promise,
        new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }),
      ]);
    }
    return Response.json({ choices: [{ message: { content: `译 ${src.slice(0, 12)}` } }] });
  };
  const abort = new AbortController();
  const cues = Array.from({ length: 25 }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 2,
    text: `Cue ${i} spoken line after seek`,
  }));
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    cues,
    capture: null,
    signal: abort.signal,
    onEvent: (e) => { if (e.type === 'line') lines.push(e.src || ''); },
  });
  await waitUntil(() => player.cmds.includes('play'));
  player.currentTime = 40;
  await waitUntil(() => translates >= 5);
  extra.resolve();
  await waitUntil(() => lines.some((src) => /Cue 20 /.test(src)));
  player.ended = true;
  abort.abort();
  await running;
  assert(lines.some((src) => /Cue 0 /.test(src)), 'opening cue still translated');
  assert(lines.some((src) => /Cue 1 /.test(src)), 'opening buffer second cue translated');
  assert(lines.some((src) => /Cue 20 /.test(src)), 'seek flushes and starts the new window');
  assert(!lines.some((src) => /Cue [2-3] /.test(src)), `stale waiting cues must not emit after gen++, got ${lines.join('|')}`);
}

// --- TTS on: do not resume picture until opening Chinese audio buffer is ready ---
{
  const player = { currentTime: 0.2, duration: 20, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const last = gate();
  let n = 0;
  globalThis.fetch = mockTranslateFetch();
  const running = runInterpret({
    tabId: 1,
    settings: settings({ tts: true }),
    cues: nCues(Math.max(6, OPENING_READY_TTS)),
    capture: null,
    synthesizeTts: async () => {
      n += 1;
      if (n >= OPENING_READY_TTS) await last.promise;
      return { blob: new Blob([`wav${n}`]), mime: 'audio/wav' };
    },
  });
  await waitUntil(() => player.cmds.includes('pause'));
  await waitUntil(() => n >= Math.max(1, OPENING_READY_TTS - 1));
  await waitMs(60);
  assert(!player.cmds.includes('play'), 'translation alone must not advance the picture when TTS is on');
  assert(player.paused, 'must wait for the opening dub buffer, not the first segment');
  last.resolve();
  await waitUntil(() => player.cmds.includes('play'));
  player.ended = true;
  await running;
}

// --- current cue without dub holds again; video must not skip ahead ---
{
  const player = { currentTime: 0.2, duration: 16, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const second = gate();
  let n = 0;
  globalThis.fetch = mockTranslateFetch();
  const running = runInterpret({
    tabId: 1,
    settings: settings({ tts: true }),
    cues: [
      { start: 0, end: 2, text: 'Hello world from the lecture' },
      { start: 2, end: 4, text: 'Cue 1 spoken line after opening' },
      { start: 4, end: 6, text: 'Cue 2 spoken line after opening' },
      { start: 6, end: 10, text: 'This is the second sentence' },
    ],
    capture: null,
    synthesizeTts: async () => {
      n += 1;
      if (n > OPENING_READY_TTS) await second.promise;
      return { blob: new Blob([`wav${n}`]), mime: 'audio/wav' };
    },
  });
  await waitUntil(() => player.cmds.includes('play'));
  const playsAfterFirst = player.cmds.filter((c) => c === 'play').length;
  player.currentTime = 6.4;
  await waitUntil(() => player.cmds.filter((c) => c === 'pause').length >= 2);
  assert(player.paused, 'must hold when the current cue has no Chinese audio yet');
  assert(player.cmds.filter((c) => c === 'play').length === playsAfterFirst, 'must not skip ahead before the next dub');
  second.resolve();
  await waitUntil(() => player.cmds.filter((c) => c === 'play').length > playsAfterFirst);
  player.ended = true;
  await running;
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
    cues: [],
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
  });
  assert.equal(result.mode, 'audio');
  assert(player.cmds.includes('silence'), 'no-caption path must mute speakers');
  assert(player.cmds.includes('restore'), 'no-caption path restores after stop');
}

// --- leaked silence after remount is re-applied ---
{
  const player = { currentTime: 0.2, duration: 8, paused: false, ended: false, advance: 0, silenced: true };
  const orig = globalThis.chrome;
  installChrome(player);
  const exec = globalThis.chrome.scripting.executeScript;
  globalThis.chrome.scripting.executeScript = async (opts) => {
    const [cmd] = opts.args;
    const [entry] = await exec(opts);
    if (cmd === 'state') entry.result.silenced = player.silenced;
    return [entry];
  };
  globalThis.fetch = mockTranslateFetch();
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    cues: twoCues(),
    capture: null,
    signal: abort.signal,
  });
  await waitUntil(() => player.cmds.includes('play'));
  const silences = player.cmds.filter((c) => c === 'silence').length;
  player.silenced = false;
  await waitUntil(() => player.cmds.filter((c) => c === 'silence').length > silences);
  player.ended = true;
  abort.abort();
  await running;
  globalThis.chrome = orig;
}

// --- user original-audio toggle must not be re-silenced ---
{
  const player = { currentTime: 0.2, duration: 8, paused: false, ended: false, advance: 0, silenced: true };
  const orig = globalThis.chrome;
  installChrome(player);
  const exec = globalThis.chrome.scripting.executeScript;
  globalThis.chrome.scripting.executeScript = async (opts) => {
    const [cmd] = opts.args;
    const [entry] = await exec(opts);
    if (cmd === 'state') entry.result.silenced = player.silenced;
    if (cmd === 'silence') player.silenced = true;
    if (cmd === 'restore') player.silenced = false;
    return [entry];
  };
  globalThis.fetch = mockTranslateFetch();
  let wantOn = false;
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    cues: twoCues(),
    capture: null,
    signal: abort.signal,
    wantOriginalAudio: () => wantOn,
  });
  await waitUntil(() => player.cmds.includes('silence'));
  wantOn = true;
  await waitUntil(() => player.cmds.includes('restore'));
  const silences = player.cmds.filter((c) => c === 'silence').length;
  await waitMs(350);
  assert.equal(
    player.cmds.filter((c) => c === 'silence').length,
    silences,
    'must not re-silence after the user turns original audio on',
  );
  player.ended = true;
  abort.abort();
  await running;
  globalThis.chrome = orig;
}

// --- mid-video: start from current progress, not from the beginning ---
{
  const player = { currentTime: 40, duration: 80, paused: false, ended: false, advance: 0 };
  installChrome(player);
  const first = gate();
  const seen = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const src = body.messages?.at(-1)?.content || '';
    seen.push(src);
    await first.promise;
    return Response.json({ choices: [{ message: { content: `译:${src.slice(0, 12)}` } }] });
  };
  const running = runInterpret({
    tabId: 1,
    settings: settings(),
    startAt: 40,
    cues: Array.from({ length: 25 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 2,
      text: `Cue ${i} spoken line from progress`,
    })),
    capture: null,
  });
  await waitUntil(() => player.cmds.includes('pause') && seen.length >= 1);
  assert.equal(player.cmds.find((c) => c === 'pause' || c === 'play'), 'pause', 'mid-video still pauses first');
  assert(!player.cmds.includes('play'), 'must not resume until the current-progress audio/translation is ready');
  assert(seen.every((src) => /Cue (19|2[0-3]) /.test(src)), `from current progress, got ${seen.join('|')}`);
  assert(!seen.some((src) => /Cue [0-5] /.test(src)), 'must not translate from the beginning');
  first.resolve();
  await waitUntil(() => player.cmds.includes('play'));
  player.ended = true;
  await running;
}

function loudWav() {
  return new Blob([new Uint8Array(2000)], { type: 'audio/wav' });
}

function mockRecordSlice() {
  return async () => ({ blob: loudWav(), mime: 'audio/wav', seconds: 4 });
}

// --- captions + TTS: original audio is the voice prompt ---
{
  const player = { currentTime: 0.2, duration: 8, paused: false, ended: false, advance: 0 };
  installChrome(player);
  globalThis.fetch = mockTranslateFetch();
  const refs = [];
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: settings({ tts: true }),
    cues: twoCues(),
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
  assert(refs[0] === true, 'caption TTS must clone from captured original audio');
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
      text: 'Hello from the speaker',
      segments: [{ start: 0, text: 'Hello from the speaker' }],
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
    cues: [],
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

// --- queued caption TTS uses the latest harvested voice, not the prepare-time sample ---
{
  const player = { currentTime: 0.2, duration: 8, paused: false, ended: false, advance: 0 };
  installChrome(player);
  globalThis.fetch = mockTranslateFetch();
  const oldRef = new Blob([new Uint8Array(2000).fill(1)], { type: 'audio/wav' });
  const newRef = new Blob([new Uint8Array(2000).fill(2)], { type: 'audio/wav' });
  let latest = oldRef;
  const dubs = [];
  const abort = new AbortController();
  const running = runInterpret({
    tabId: 1,
    settings: settings({ tts: true }),
    cues: twoCues(),
    capture: { stream: { id: 'tab' }, playback: { setGain() {} } },
    recordSlice: async () => ({ blob: oldRef, mime: 'audio/wav', seconds: 4 }),
    voiceRefNow: () => latest,
    signal: abort.signal,
    synthesizeTts: async (_tts, _text, opts) => {
      dubs.push(opts?.referenceBlob);
      player.ended = true;
      abort.abort();
      return { blob: new Blob(['wav']), mime: 'audio/wav' };
    },
    onEvent: (ev) => {
      if (ev.type === 'line') latest = newRef;
    },
  });
  await running.catch((err) => {
    if (err?.name !== 'AbortError' && !/abort/i.test(err?.message || '')) throw err;
  });
  assert.equal(dubs.length, 1, 'first queued cue is dubbed once');
  assert.equal(dubs[0], newRef, 'synthesize uses harvest after translate, not the opening freeze');
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
      text: 'Hello from the speaker',
      segments: [{ start: 0, text: 'Hello from the speaker' }],
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
    cues: [],
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
      text: 'Hello from the speaker',
      segments: [{ start: 0, text: 'Hello from the speaker' }],
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
    cues: [],
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
    cues: [],
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

console.log('ok same-tab interpret: hold, user pause, lookahead, seek flush, no new page');
