import assert from 'node:assert/strict';
import { loadSettings, saveSettings, normalizeSettings } from '../lib/storage.js';
import { normalizeJevSettings, testJevConnection } from '../lib/jev.js';

// Use populated legacy settings, including disabled providers and optional fields.
const legacy = {
  text: { preset: 'custom', baseUrl: 'https://text.example/v1', apiKey: 'text-test', model: 'text-model', summaryInputTokens: 78000 },
  multimodal: { preset: 'custom', baseUrl: 'https://image.example/v1', apiKey: 'image-test', model: 'image-model' },
  multimodalSameAsText: false,
  textProviders: [
    { id: 'one', name: 'Primary', preset: 'custom', baseUrl: 'https://text.example/v1', apiKey: 'text-test', models: [{ id: 'text-model', enabled: true }, { id: 'hidden-model', enabled: false }] },
    { id: 'two', name: 'Secondary', preset: 'custom', baseUrl: 'http://localhost:8888/v1', apiKey: 'second-test', models: [{ id: 'other-model', enabled: true }] },
  ],
  textRef: { providerId: 'one', modelId: 'text-model' },
  asr: { preset: 'groq', baseUrl: 'https://asr.example/v1', apiKey: 'asr-test', model: 'whisper', language: 'en' },
  tts: { preset: 'index-tts', baseUrl: 'http://localhost:7860', lang: 'EN', durationFactor: 1.2, bufferSegments: 7, preparationVersion: 1, preparationMode: 'buffered', contextMode: 'sentence', translateAheadSeconds: 600, bufferSeconds: 45, playbackMode: 'stream', gapMs: 120, customOption: 'preserve' },
  langfuse: { enabled: true, baseUrl: 'https://trace.example', publicKey: 'public-test', secretKey: 'secret-test', environment: 'test', release: 'custom-release' },
  uiTheme: 'cyber', uiFont: 'xl', uiThemeColors: { cyber: { accent: '#aabbcc', 'danger-bg': '#221122' }, mint: { surface: '#ffffff' } },
  answerLanguage: 'page', nativeShell: false, hitlMode: 'strict', hitlTimeoutSeconds: 90,
  skillsEnabled: true, shareActiveTab: false, dailyNotesFolder: 'My Daily Notes',
  shortcuts: [{ id: 'custom-question', label: 'Review', prompt: 'Review this page' }],
  futureOption: { preserve: true },
};
let stored = { settings: structuredClone(legacy), libraryPath: '/example/Notes', skillPath: '/example/skills', unrelated: { preserved: true } };
globalThis.chrome = { storage: { local: {
  get: async () => structuredClone(stored),
  set: async value => { Object.assign(stored, structuredClone(value)); },
} } };
const loaded = await loadSettings();
assert.equal(loaded.jev.enabled, false, 'Existing users must not opt into JEV automatically');
for (const key of ['multimodal', 'asr', 'tts', 'langfuse', 'uiThemeColors', 'textRef', 'shortcuts', 'futureOption']) {
  assert.deepEqual(loaded[key], legacy[key], `${key} survives load`);
}
for (const provider of legacy.textProviders) {
  const actual = loaded.textProviders.find(item => item.id === provider.id);
  assert.equal(actual.apiKey, provider.apiKey);
  assert.deepEqual(actual.models.map(({ id, enabled }) => ({ id, enabled })), provider.models);
}
const before = structuredClone(loaded);
loaded.jev = { enabled: true, baseUrl: 'https://jev.example/v1/systemone', model: 'jev-latest', apiKey: 'jev-test', futurePolicy: { untouched: true } };
await saveSettings(loaded);
let after = await loadSettings();
const { jev, ...withoutJev } = after;
const { jev: initialJev, ...beforeWithoutJev } = before;
assert.deepEqual(withoutJev, beforeWithoutJev, 'Adding JEV must preserve every normalized legacy setting');
assert.deepEqual(jev, loaded.jev);
after.jev.enabled = false;
await saveSettings(after);
after = await loadSettings();
assert.deepEqual(after.jev, { ...jev, enabled: false }, 'Switching off retains credentials and unknown future fields');
assert.equal(stored.libraryPath, '/example/Notes');
assert.equal(stored.skillPath, '/example/skills');
assert.deepEqual(stored.unrelated, { preserved: true });
assert.equal(normalizeSettings({ jev: null }).jev.enabled, false);
assert.equal(normalizeJevSettings({ baseUrl: '', model: '', apiKey: '' }).baseUrl, '', 'An explicitly empty field must stay empty');

let request;
await testJevConnection(jev, { fetchImpl: async (url, options) => {
  request = { url, options };
  return { ok: true, json: async () => ({ answers: { ready: { noul: 0.95 } } }) };
} });
assert.equal(request.url, jev.baseUrl);
assert.equal(request.options.headers.Authorization, 'Bearer jev-test');
assert.equal(request.options.redirect, 'error');
const body = JSON.parse(request.options.body);
assert.equal(body.model, 'jev-latest');
assert.deepEqual(Object.keys(body.questions), ['ready']);
assert.equal(body.state, 'PageLens connection test. The status is ready.');
await assert.rejects(testJevConnection({ ...jev, apiKey: '' }, { fetchImpl: () => { throw Error('must not fetch'); } }), /请填写/);
await assert.rejects(testJevConnection({ ...jev, baseUrl: 'file:///tmp/test' }), /请填写/);
await assert.rejects(testJevConnection({ ...jev, baseUrl: 'https://user:password@example.com' }), /请填写/);
await assert.rejects(testJevConnection(jev, { fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
await assert.rejects(testJevConnection(jev, { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) }), /结构化判断/);
await assert.rejects(testJevConnection(jev, { fetchImpl: async () => { throw new TypeError('network'); } }), /无法连接/);
await assert.rejects(testJevConnection(jev, { timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /超时/);
console.log('Settings preservation, JEV round-trip and connection success/failure checks passed');
