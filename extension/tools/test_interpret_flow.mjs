// Production interpretation flow: side panel -> service worker -> offscreen host
// -> InterpretController -> runPlannedInterpret, over a JSON-serializing message
// bus like chrome.runtime. The engine must keep running after the panel closes.
import assert from 'node:assert/strict';
import { createInterpretHost } from '../lib/interpret-host.js';
import { createInterpretRouter } from '../lib/interpret-host-sw.js';
import { INTERPRET_VIDEO, INTERPRET_CMD, toMessage } from '../lib/interpret-messages.js';
import { AUDIO_PAGE, createOffscreenDoc } from '../lib/offscreen-doc.js';
import { RemoteInterpretController } from '../sidepanel/interpret-client.js';
import { blob, chat, settings, sleep, source, until } from './interpret-test-harness.mjs';

console.warn = console.info = () => {};
const BASE = 'chrome-extension://ext/';
const wire = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function createBus() {
  const contexts = new Set();
  function deliver(from, msg) {
    const payload = wire(msg);
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        let pending = false, done = false;
        const respond = value => { if (!done) { done = true; resolve(wire(value)); } };
        const targets = [...contexts].filter(c => c !== from);
        for (const ctx of targets) {
          for (const listener of [...ctx.listeners]) {
            if (listener(payload, { url: from.url }, respond) === true) pending = true;
          }
        }
        if (pending || done) return;
        if (!targets.some(c => c.listeners.size)) reject(new Error('Could not establish connection. Receiving end does not exist.'));
        else resolve(undefined);
      });
    });
  }
  function context(path) {
    const ctx = { url: BASE + path, listeners: new Set() };
    ctx.runtime = {
      getURL: p => BASE + p,
      sendMessage: msg => deliver(ctx, msg),
      onMessage: { addListener: fn => ctx.listeners.add(fn), removeListener: fn => ctx.listeners.delete(fn) },
    };
    contexts.add(ctx);
    return ctx;
  }
  return { context, close: ctx => { ctx.listeners.clear(); contexts.delete(ctx); } };
}

function createPlayer() {
  const state = { ok: true, currentTime: 0, duration: 38, paused: false, ended: false, readyState: 4, playbackRate: 1, silenced: false, userPaused: false, seekRevision: 0 };
  const commands = [];
  const video = async (tabId, cmd, arg = {}) => {
    commands.push({ tabId, cmd, action: arg?.action });
    if (cmd === 'control') state.paused = arg.action === 'pause';
    if (cmd === 'silence') state.silenced = true;
    if (cmd === 'restore') state.silenced = false;
    return { ...state };
  };
  return { state, commands, video };
}

const subtitles = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, start: 1 + i * 4, end: 5 + i * 4, src: `Sentence ${i}.` }));

function createExtension({ player, nativeReply = { ok: true, pong: true } }) {
  const bus = createBus();
  const sw = bus.context('sw.js');
  const audios = [];
  let offscreen = null, host = null, created = 0;
  const chromeApi = {
    runtime: {
      ...sw.runtime,
      getContexts: async () => (offscreen ? [{ documentUrl: offscreen.url }] : []),
      sendNativeMessage: async (_name, message) => ({ ...nativeReply, echo: message }),
    },
    offscreen: {
      createDocument: async ({ url }) => {
        assert.equal(url, AUDIO_PAGE);
        created++;
        offscreen = bus.context(url);
        delete offscreen.runtime.sendNativeMessage;
        host = createInterpretHost({ runtime: offscreen.runtime, engineOptions: {
          openSource: async () => source(subtitles, 38),
          cacheGet: async () => null, cacheSet: async () => {}, getTtsRef: async () => null,
          voiceRef: async () => blob, audioDuration: async () => 3, synthesizeTts: async () => ({ blob }), chat,
          createAudio: () => {
            const audio = { paused: true, currentTime: 0, playbackRate: 1,
              pause() { this.paused = true; }, async play() { this.paused = false; this.played = true; } };
            audios.push(audio);
            return audio;
          },
        } });
      },
      closeDocument: async () => { if (offscreen) bus.close(offscreen); offscreen = null; },
    },
  };
  const doc = createOffscreenDoc({ chromeApi, sleep: () => sleep(1) });
  createInterpretRouter({ chromeApi, doc, video: player.video }).install();
  // Plays the page and the dub elements while unpaused, like a real tab would.
  const clock = setInterval(() => {
    if (!player.state.paused && !player.state.ended) player.state.currentTime += 0.1;
    if (player.state.currentTime >= player.state.duration) { player.state.currentTime = player.state.duration; player.state.ended = true; }
    for (const audio of audios) if (!audio.paused) {
      audio.currentTime += 0.1;
      if (audio.currentTime >= 3) { audio.pause(); audio.onended?.(); }
    }
  }, 5);
  return {
    bus, doc, audios, chromeApi,
    get host() { return host; },
    get offscreen() { return offscreen; },
    get created() { return created; },
    openPanel: () => {
      const panel = bus.context('sidepanel/index.html');
      const client = new RemoteInterpretController({ runtime: panel.runtime, loadArchive: async () => null });
      const events = [];
      client.subscribe((event, state) => events.push({ event, state }));
      return { panel, client, events, close: () => { client.dispose(); bus.close(panel); } };
    },
    stop: () => clearInterval(clock),
  };
}

const tab = { id: 7, url: 'https://video.test/watch?v=flow', title: 'Flow' };

// Panel starts, then closes mid-run; the offscreen host finishes the whole video.
{
  const player = createPlayer();
  const ext = createExtension({ player });
  try {
    const first = ext.openPanel();
    await first.client.ready;
    assert.equal(first.client.isRunning(tab.id), false);
    await first.client.start({ tab, settings });
    assert.equal(ext.created, 1, 'start creates the offscreen document');
    await until(() => first.events.some(e => e.event.type === 'line'), 5000);
    assert(first.client.isRunning(tab.id), 'panel mirrors the running host task');
    assert(first.client.getState(tab.id).zh, 'panel mirror carries the current line');
    const cmds = player.commands.map(c => c.cmd);
    for (const cmd of ['pick', 'state', 'control', 'watch']) assert(cmds.includes(cmd), `page control goes through the worker: ${cmd}`);
    assert(player.commands.every(c => c.tabId === tab.id));

    const lineAtClose = ext.host.controller.getTask(tab.id)?.details?.lineId;
    first.close();
    assert(lineAtClose, 'some speech played before the panel closed');
    const playedAtClose = ext.audios.filter(a => a.played).length;
    assert(playedAtClose < subtitles.length, 'test closes the panel mid-run');

    await until(() => ext.host.controller.tasks.size === 0, 10000);
    assert.equal(ext.audios.filter(a => a.played).length, subtitles.length, 'every line still plays after the panel closed');
    assert(player.commands.some(c => c.cmd === 'unwatch'), 'engine released the page after finishing');
    await until(() => !ext.offscreen, 2000);
  } finally { ext.stop(); }
  console.log('PASS panel close does not interrupt interpretation; idle document is released');
}

// Reopening the panel resyncs the running task and can stop it.
{
  const player = createPlayer();
  const ext = createExtension({ player });
  try {
    const first = ext.openPanel();
    await first.client.ready;
    await first.client.start({ tab, settings });
    await until(() => first.events.some(e => e.event.type === 'line'), 5000);
    first.close();

    const second = ext.openPanel();
    await second.client.ready;
    assert(second.client.isRunning(tab.id), 'reopened panel sees the running task');
    assert.equal(second.client.getRunningTasks().length, 1);
    assert(second.events.some(e => e.event.type === 'sync' && e.state.tabId === tab.id));
    assert.equal(await ext.doc.release(), false, 'busy interpretation keeps the shared offscreen document');
    assert(ext.offscreen);

    await second.client.stop(tab.id);
    assert.equal(ext.host.controller.tasks.size, 0);
    await until(() => !second.client.isRunning(tab.id));
    assert(second.events.some(e => e.event.type === 'stopped'));
    assert(player.commands.some(c => c.cmd === 'restore' || c.cmd === 'unwatch'), 'stop hands the page back');
    await until(() => !ext.offscreen, 2000);
    second.close();
  } finally { ext.stop(); }
  console.log('PASS reopened panel resyncs and stops the background task');
}

// With the panel open the run ends normally and captions reach the panel.
{
  const player = createPlayer();
  const ext = createExtension({ player });
  try {
    const view = ext.openPanel();
    await view.client.ready;
    let captions = null;
    await view.client.start({ tab, settings, onCaptionsReady: c => { captions = c; } });
    await until(() => view.events.some(e => e.event.type === 'idle'), 10000);
    assert.equal(captions?.status, 'ready');
    assert(captions.cues.length > 0);
    assert(view.events.some(e => e.event.type === 'stopped'));
    assert(!view.events.some(e => e.event.type === 'error'), view.events.find(e => e.event.type === 'error')?.event.error);
    view.close();
  } finally { ext.stop(); }
  console.log('PASS open panel receives lifecycle events and final captions');
}

// Only the offscreen host may drive pages or native messaging through the worker.
{
  const player = createPlayer();
  const ext = createExtension({ player });
  try {
    const view = ext.openPanel();
    const denied = await view.panel.runtime.sendMessage({ type: INTERPRET_VIDEO, tabId: 7, cmd: 'control', arg: { action: 'play' } });
    assert.equal(denied.ok, false);
    assert.equal(player.commands.length, 0);
    const listed = await view.panel.runtime.sendMessage({ type: INTERPRET_CMD, op: 'list' });
    assert.deepEqual(listed, { ok: true, tasks: [] });
    assert.equal(ext.created, 0, 'listing never creates the offscreen document');

    await ext.doc.ensure();
    const reply = await ext.offscreen.runtime.sendNativeMessage('com.pagelens.host', { op: 'ping' });
    assert.equal(reply.pong, true, 'offscreen native messaging is proxied through the worker');
    assert.deepEqual(reply.echo, { op: 'ping' });
    view.close();
  } finally { ext.stop(); }
  console.log('PASS worker rejects page control from non-host contexts; native proxy works');
}

// Binary payloads never cross the runtime bus; the panel reloads archives from IndexedDB.
{
  const cleaned = toMessage({ type: 'dub_segment', segment: { id: 'a', blob, buf: new ArrayBuffer(4), bytes: new Uint8Array(2) }, fn() {} });
  assert.deepEqual(cleaned, { type: 'dub_segment', segment: { id: 'a' } });
  const loaded = [];
  const client = new RemoteInterpretController({
    runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => ({ ok: true, tasks: [] }) },
    loadArchive: async id => { loaded.push(id); return { videoId: id, complete: true, compactAudioBlob: blob }; },
  });
  const seen = [];
  client.subscribe(event => seen.push(event));
  await client.receive({ event: { type: 'archive_saved', tabId: 7, archive: { videoId: 'v1', complete: true } }, tasks: [] });
  assert.deepEqual(loaded, ['v1']);
  assert.equal(seen[0].archive.compactAudioBlob, blob);
  console.log('PASS events are JSON-safe and archives are rehydrated in the panel');
}
