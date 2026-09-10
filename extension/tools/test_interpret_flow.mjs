import assert from 'node:assert/strict';
import { runInterpret } from '../lib/interpret.js';

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
globalThis.fetch = async (_url, options = {}) => {
  const body = JSON.parse(options.body || '{}');
  const src = body.messages?.at(-1)?.content || '';
  return Response.json({
    choices: [{ message: { content: src.includes('second') ? '第二句' : '你好世界' } }],
  });
};

const result = await runInterpret({
  tabId: 1,
  settings: {
    text: { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'k' },
    tts: { baseUrl: 'https://tts.example.test' },
  },
  cues: [
    { start: 0, end: 2, text: 'Hello world from the lecture' },
    { start: 2, end: 4.5, text: 'This is the second sentence' },
  ],
  capture: null,
  onEvent: (e) => events.push(e),
});

assert(result.lines.length >= 1, `expected translated lines, got ${result.lines.length}`);
assert(result.lines.some((line) => /你好|第二/.test(line.zh)), `zh=${result.lines.map((l) => l.zh).join('|')}`);
assert(!events.some((e) => /后台/.test(e.message || '')), 'must stay on the current tab');
console.log('ok same-tab interpret: TTS configured but no new page, translations still emit');
