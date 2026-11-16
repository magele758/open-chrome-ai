import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installMemoryIndexedDB } from "./idb_mem.mjs";
import { saveFullMediaArchive } from "../lib/audio-composer.js";
import { saveDubJob } from "../lib/dub-queue.js";
import { clearLegacyDubDownloads, LEGACY_DUB_FILE_PREFIX, LEGACY_DUB_RETRY_ALARM } from "../lib/interpret-host-sw.js";
import { encodeMonoWav } from "../lib/tts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "..");

function createChromeHarness({ id = "anpjolmpgjncncpocenkchhpkefopjne", initialStorage = {}, initialAlarms = [] } = {}) {
  const store = structuredClone(initialStorage);
  const alarms = new Map(initialAlarms.map((a) => [a.name, structuredClone(a)]));
  const createdAlarms = [];
  const clearedAlarms = [];
  const downloadCalls = [];
  const offscreenCreateCalls = [];
  const storageListeners = [];
  const event = () => {
    const listeners = [];
    return {
      listeners,
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    };
  };

  const onInstalled = event();
  const onStartup = event();
  const onMessage = event();
  const onMessageExternal = event();
  const onAlarm = event();

  const chromeApi = {
    downloads: {
      download: async (opts) => {
        downloadCalls.push(structuredClone(opts));
        return downloadCalls.length;
      },
      search: async () => [],
      onCreated: event(),
      onChanged: event(),
    },
    alarms: {
      create: async (name, info) => {
        const entry = { name, ...(info || {}) };
        alarms.set(name, entry);
        createdAlarms.push(entry);
      },
      get: async (name) => alarms.get(name) || null,
      getAll: async () => [...alarms.values()],
      clear: async (name) => {
        clearedAlarms.push(name);
        return alarms.delete(name);
      },
      onAlarm,
    },
    storage: {
      local: {
        getKeys: async () => Object.keys(store),
        get: async (keys) => {
          if (keys == null) return structuredClone(store);
          const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj || {})) {
            changes[k] = { oldValue: structuredClone(store[k]), newValue: structuredClone(v) };
            store[k] = structuredClone(v);
          }
          for (const fn of storageListeners) fn(changes, "local");
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        },
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    runtime: {
      id,
      getURL: (p) => `chrome-extension://${id}/${p}`,
      getManifest: () => ({ version: "0.12.1" }),
      getContexts: async () => [],
      sendMessage: async () => ({ ok: false }),
      onInstalled,
      onStartup,
      onMessage,
      onMessageExternal,
    },
    offscreen: {
      createDocument: async (opts) => {
        offscreenCreateCalls.push(opts);
      },
      closeDocument: async () => {},
    },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { removeAll: (cb) => cb?.(), create: () => {}, onClicked: event() },
    windows: { onRemoved: event(), create: async () => ({ id: 1 }), remove: async () => {} },
    tabs: { get: async () => null, onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event() },
    webNavigation: { onCompleted: event() },
    debugger: { onEvent: event() },
  };

  return {
    chromeApi,
    store,
    alarms,
    createdAlarms,
    clearedAlarms,
    downloadCalls,
    offscreenCreateCalls,
    onInstalled,
    onStartup,
    onMessage,
    onAlarm,
  };
}

test("extension removes automatic dub downloads on boot, startup, install, and legacy retry alarm", async () => {
  assert.equal(
    fs.existsSync(path.join(extDir, "lib/dub-downloads.js")),
    false,
    "dub-downloads.js must not exist",
  );
  const swSource = fs.readFileSync(path.join(extDir, "sw.js"), "utf8");
  assert.doesNotMatch(swSource, /dub-downloads|installDubDownloads|downloads\.download/);
  const offscreenSource = fs.readFileSync(path.join(extDir, "offscreen/audio.js"), "utf8");
  assert.doesNotMatch(offscreenSource, /pl\.dub\.file/);
  const offscreenDocSource = fs.readFileSync(path.join(extDir, "lib/offscreen-doc.js"), "utf8");
  assert.doesNotMatch(offscreenDocSource, /["']BLOBS["']/);

  installMemoryIndexedDB();
  const wav = encodeMonoWav(new Float32Array(1600), 16000);
  const archiveA = await saveFullMediaArchive({
    videoId: "yt:alpha",
    title: "Alpha Video",
    url: "https://youtu.be/alpha",
    duration: 30,
    audioBlob: wav,
    compactAudioBlob: wav,
    complete: true,
  });
  await saveFullMediaArchive({
    videoId: "yt:beta",
    title: "Beta Video",
    url: "https://youtu.be/beta",
    duration: 45,
    audioBlob: wav,
    compactAudioBlob: wav,
    complete: true,
  });
  await saveDubJob({
    id: "yt:alpha",
    url: "https://youtu.be/alpha",
    title: "Alpha Video",
    status: "ready",
    added: 100,
    ownerId: "",
  });

  const harness = createChromeHarness({
    initialAlarms: [{ name: LEGACY_DUB_RETRY_ALARM, scheduledTime: Date.now() + 60_000 }],
    initialStorage: {
      [`${LEGACY_DUB_FILE_PREFIX}alpha`]: { version: archiveA.createdAt, downloadId: 1, pending: true },
      [`${LEGACY_DUB_FILE_PREFIX}beta`]: { version: 1, downloadId: 2 },
      settings: { uiTheme: "warm" },
    },
  });

  const prevChrome = globalThis.chrome;
  const prevFetch = globalThis.fetch;
  const prevSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.chrome = harness.chromeApi;
  globalThis.fetch = async () => new Response("", { status: 404 });
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = prevSetTimeout(fn, ms, ...args);
    handle?.unref?.();
    timers.push(handle);
    return handle;
  };

  try {
    await import("../sw.js");
    await new Promise((r) => prevSetTimeout(r, 25));

    assert.equal(harness.downloadCalls.length, 0, "SW boot must not trigger chrome.downloads.download");
    assert.equal(harness.offscreenCreateCalls.length, 0, "ready archives must not wake offscreen on boot");
    assert.ok(harness.clearedAlarms.includes(LEGACY_DUB_RETRY_ALARM), "legacy save-retry alarm cleared on boot");
    assert.equal(harness.alarms.has(LEGACY_DUB_RETRY_ALARM), false);
    assert.equal(`${LEGACY_DUB_FILE_PREFIX}alpha` in harness.store, false, "legacy dub-file tracking removed");
    assert.equal(`${LEGACY_DUB_FILE_PREFIX}beta` in harness.store, false);
    assert.deepEqual(harness.store.settings, { uiTheme: "warm" }, "user settings must remain untouched");

    // Simulate Chrome restart / extension update / leftover retry alarm / legacy message with archives present.
    harness.alarms.set(LEGACY_DUB_RETRY_ALARM, { name: LEGACY_DUB_RETRY_ALARM });
    harness.store[`${LEGACY_DUB_FILE_PREFIX}reseeded`] = { version: 99, pending: true };
    const clearsBefore = harness.clearedAlarms.length;

    for (const fn of harness.onStartup.listeners) await fn();
    for (const fn of harness.onInstalled.listeners) await fn({ reason: "update" });
    for (const fn of harness.onAlarm.listeners) {
      await fn({ name: LEGACY_DUB_RETRY_ALARM });
      await fn({ name: "pl.queue.watch" });
    }
    for (const fn of harness.onMessage.listeners) {
      fn({ type: "pl.dub.saved", id: "yt:alpha", version: archiveA.createdAt }, { id: harness.chromeApi.runtime.id }, () => {});
    }
    await new Promise((r) => prevSetTimeout(r, 25));

    assert.equal(harness.downloadCalls.length, 0, "restart/install/alarm must never batch-download archived dubs");
    assert.equal(harness.offscreenCreateCalls.length, 0, "completed archives must not wake offscreen on restart");
    assert.ok(harness.clearedAlarms.length > clearsBefore, "startup/install cleans up retry alarm again");
    assert.equal(harness.alarms.has(LEGACY_DUB_RETRY_ALARM), false);
    assert.equal(`${LEGACY_DUB_FILE_PREFIX}reseeded` in harness.store, false);
    assert.equal(
      harness.createdAlarms.some((a) => a.name === LEGACY_DUB_RETRY_ALARM),
      false,
      "save-retry alarm must never be scheduled again",
    );

    // Offscreen script must not mint blob download URLs for legacy pl.dub.file requests.
    const swListeners = harness.onMessage.listeners.splice(0);
    await import("../offscreen/audio.js");
    const offscreenListeners = harness.onMessage.listeners.slice();
    harness.onMessage.listeners.push(...swListeners);
    let replyPayload = null;
    const handled = offscreenListeners.some((fn) =>
      fn(
        { type: "pl.dub.file", id: "yt:alpha", version: archiveA.createdAt },
        { id: harness.chromeApi.runtime.id },
        (res) => { replyPayload = res; },
      ),
    );
    assert.equal(handled, false, "offscreen must not handle legacy pl.dub.file");
    assert.equal(replyPayload, null);
    assert.equal(harness.downloadCalls.length, 0);
  } finally {
    for (const handle of timers) clearTimeout(handle);
    globalThis.setTimeout = prevSetTimeout;
    globalThis.fetch = prevFetch;
    globalThis.chrome = prevChrome;
  }
});

test("clearLegacyDubDownloads handles Chrome versions without storage.local.getKeys", async () => {
  const cleared = [];
  await clearLegacyDubDownloads({
    alarms: { clear: (name) => { cleared.push(name); } },
    storage: { local: {} },
  });
  assert.deepEqual(cleared, [LEGACY_DUB_RETRY_ALARM]);
});
