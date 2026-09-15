import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { usableTranscript } from '../lib/captions.js';
import { estimateTokens } from '../lib/openai.js';

// Exercise the actual panel handlers with deferred network/capture operations.
const source = await readFile(new URL('../sidepanel/app.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('function applyCaptions('), source.indexOf('async function captureTab('));
const render = source.slice(source.indexOf('const isTranscribing ='), source.indexOf('\nfunction ', source.indexOf('function renderTranscribeAction(') + 1));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const full = { status: 'ready', source: 'asr-full', text: 'entire audio', cues: [], complete: true };
function harness() {
  const extraction = gate(), live = gate(), summary = gate();
  const elements = new Map();
  const state = { tab: { id: 1, url: 'https://video.test', title: 'video' }, pack: { video: {} }, settings: { asr: {} }, share: true, messages: [], busy: false };
  let interpretationSignal;
  let captured = 0;
  let currentAbort = null;
  const interpretController = {
    isRunning: tabId => state.interpret?.status === 'running',
    getState: tabId => state.interpret || { status: 'idle' },
    getRunningTasks: () => state.interpret?.status === 'running' ? [state.interpret] : [],
    stop: async tabId => {
      if (currentAbort) currentAbort.abort();
      state.interpret = { status: 'idle' };
    },
    start: async ({ tab, settings, onCaptionsReady }) => {
      const abort = new AbortController();
      currentAbort = abort;
      interpretationSignal = abort.signal;
      state.interpret = { status: 'running', mode: 'audio' };
      try {
        const res = await live.promise;
        if (res?.captions) onCaptionsReady?.(res.captions);
        state.interpret = { status: 'idle' };
      } catch (e) {
        state.interpret = { status: 'error', error: e.message };
      }
    },
  };
  const compactController = { stop: async () => {}, isRunning: () => false };
  const context = vm.createContext({
    state, AbortController, usableTranscript, interpretController, compactController, estimateTokens,
    compactPlaying: false, compactSegments: [], compactStreamPlayer: null, compactPlayerAudio: null,
    compactPendingAutoplay: false, compactFullGenerating: false,
    stopCompactPlayback() {}, getSharedAudioContext() {}, needAsrSettings() {}, toggleOriginalAudio() {},
    document: { createElement: () => ({ classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, append() {}, appendChild() {}, setAttribute() {} }) },
    $: id => { if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, appendChild() {}, append() {} }); return elements.get(id); },
    renderContext() {}, syncPackToLibrary: async () => ({}), abortRecording() {}, discardCapture: async () => {},
    renderSettingsForm() {}, setView() {}, needModelMessage: () => '', requireModel: () => ({}), isAsrReady: () => true,
    injectVideo: async () => ({ ok: true, paused: true, currentTime: 3 }),
    beginCapture: async () => { captured += 1; return { stream: {} }; },
    transcribeTab: async ({ signal }) => { await extraction.promise; signal.throwIfAborted(); return full; },
    runInterpret: async ({ signal, cues }) => { assert.equal(cues, undefined); interpretationSignal = signal; return live.promise; },
    summarizeTranscript: async ({ text }) => { assert.equal(text, full.text); return summary.promise; },
    pushError: message => { throw new Error(message); }, renderMessages() {}, paintBot() {}, persistSession: async () => {}, formatTime: String,
  });
  vm.runInContext(render + '\n' + handlers + '\nglobalThis.api = { startTranscribe, startSummarizeVideo, startInterpret, stopInterpret, renderTranscribeAction };', context);
  return { state, api: context.api, extraction, live, summary, elements, captured: () => captured, get siSignal() { return interpretationSignal; } };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
for (const first of ['interpret', 'summary']) {
  const h = harness();
  let si, sum;
  if (first === 'interpret') { si = h.api.startInterpret(); await flush(); sum = h.api.startSummarizeVideo(); }
  else { sum = h.api.startSummarizeVideo(); await flush(); si = h.api.startInterpret(); }
  await flush();
  assert.equal(h.state.interpret.status, 'running');
  assert.equal(h.state.transcribe.status, 'extracting');
  assert.equal(h.siSignal.aborted, false);
  assert.equal(h.state.workAbort.signal.aborted, false);
  h.api.renderTranscribeAction();
  assert.equal(h.elements.get('btn-interpret').disabled, false, 'stop interpretation remains available during extraction');
  assert.equal(h.elements.get('btn-transcribe').disabled, false, 'stop extraction remains available during interpretation');
  h.extraction.resolve(); await flush();
  assert.equal(h.state.busy, true, 'summary and interpretation overlap');
  h.live.resolve({ captions: { status: 'ready', source: 'interpret', text: 'partial translation' }, lines: [1] });
  await si;
  assert.equal(h.state.pack.captionsText, full.text, 'live fragments cannot overwrite full transcript');
  h.summary.resolve('summary'); await sum;
  assert.equal(h.state.messages.at(-1).text, 'summary');
}
{
  const h = harness();
  const si = h.api.startInterpret(); await flush();
  h.api.renderTranscribeAction();
  assert.equal(h.elements.get('btn-summarize-video').disabled, false);
  assert.equal(h.elements.get('btn-summarize-bar').disabled, false);
  const tr = h.api.startTranscribe(); await flush();
  await h.api.startSummarizeVideo();
  assert.equal(h.siSignal.aborted, false, 'cancel extraction does not cancel interpretation');
  h.extraction.resolve(); await tr;
  h.live.resolve({}); await si;
}
{
  const h = harness();
  const tr = h.api.startTranscribe(); await flush();
  const si = h.api.startInterpret(); await flush();
  h.api.stopInterpret();
  assert.equal(h.state.workAbort.signal.aborted, false, 'stop interpretation does not cancel extraction');
  h.extraction.resolve(); await tr;
  h.live.resolve({}); await si;
  assert.equal(h.state.pack.captionsText, full.text);
}
{
  const h = harness();
  const sum = h.api.startSummarizeVideo();
  await flush();
  assert.equal(h.state.transcribe.status, 'extracting');
  h.extraction.resolve();
  h.summary.resolve('summary');
  await sum;
  assert.equal(h.captured(), 0, 'one-click summary never records the tab');
  assert.equal(h.state.messages.at(-1).text, 'summary');
}
console.log('PASS video actions: both start orders, simultaneous summary, independent cancellation, complete transcript preservation');
