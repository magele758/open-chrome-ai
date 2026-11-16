import assert from "node:assert/strict";
import { test } from "node:test";
import { installMemoryIndexedDB } from "./idb_mem.mjs";
import { idbDel, idbGet, idbSet } from "../lib/idb-kv.js";
import { saveFullMediaArchive } from "../lib/audio-composer.js";
import { encodeMonoWav } from "../lib/tts.js";
import {
  INTERPRET_EXTENSION_ID,
  PAGELENS_EXTENSION_ID,
  chooseSettingsSyncAction,
  decodeRecordFromWire,
  encodeRecordForWire,
  installInterpretSync,
  joinBase64Chunks,
  mergeSharedSettings,
  splitUint8Chunks,
} from "../lib/interpret-sync.js";

function makeMemoryStorage(initial = {}) {
  const store = structuredClone(initial);
  const listeners = [];
  return {
    store,
    listeners,
    local: {
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
        for (const fn of listeners) fn(changes, "local");
      },
      remove: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete store[k];
      },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  };
}

function makeExtensionBus() {
  const nodes = new Map();
  function createChrome(id, initialStorage) {
    const storage = makeMemoryStorage(initialStorage);
    const internalListeners = [];
    const externalListeners = [];
    const chromeApi = {
      storage,
      runtime: {
        id,
        onMessage: { addListener: (fn) => internalListeners.push(fn) },
        onMessageExternal: { addListener: (fn) => externalListeners.push(fn) },
        sendMessage: (arg1, arg2) => {
          if (typeof arg1 === "string") {
            const target = nodes.get(arg1);
            if (!target) return Promise.reject(new Error("Receiving end does not exist"));
            return new Promise((resolve, reject) => {
              let handled = false;
              for (const fn of target.externalListeners) {
                const res = fn(structuredClone(arg2), { id }, (reply) => resolve(structuredClone(reply)));
                if (res === true) handled = true;
              }
              if (!handled) reject(new Error("No external handler"));
            });
          }
          for (const fn of internalListeners) fn(structuredClone(arg1), { id }, () => {});
          return Promise.resolve({ ok: true });
        },
      },
    };
    nodes.set(id, { chromeApi, storage, externalListeners, internalListeners });
    return chromeApi;
  }
  return { createChrome };
}

test("initial sync picks PageLens real settings even when PageLens 同传 only has local-settings overlay", () => {
  const pagelens = {
    text: { baseUrl: "https://api.example/v1", model: "gpt-4o", apiKey: "k1", summaryInputTokens: 120000 },
    textProviders: [{ id: "p1", name: "Main", baseUrl: "https://api.example/v1", models: [{ id: "gpt-4o", enabled: true }] }],
    asr: { preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002" },
    tts: { preset: "index-tts", baseUrl: "http://127.0.0.1:7860", lang: "ZH" },
    hitlMode: "strict",
  };
  const interpret = {
    text: { baseUrl: "", model: "", apiKey: "", summaryInputTokens: 200000 },
    textProviders: [],
    asr: { preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002" },
    tts: { preset: "index-tts", baseUrl: "http://127.0.0.1:7860", lang: "ZH" },
  };
  assert.equal(
    chooseSettingsSyncAction({ role: "interpret", settings: interpret, updatedAt: 0 }, { role: "pagelens", settings: pagelens, updatedAt: 0 }),
    "pull",
  );
  const mergedOnPagelens = mergeSharedSettings(pagelens, { ...pagelens, text: { ...pagelens.text, summaryInputTokens: 200000 } });
  assert.equal(mergedOnPagelens.text.summaryInputTokens, 120000);
  assert.equal(mergedOnPagelens.hitlMode, "strict");
});

test("chunked binary wire encoding round-trips archive ArrayBuffers intact", () => {
  const buf1 = new Uint8Array(1024 * 32);
  for (let i = 0; i < buf1.length; i++) buf1[i] = i % 251;
  const record = {
    videoId: "yt:abc",
    title: "Test",
    audioBuffer: buf1.buffer,
    compactAudioBuffer: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer,
  };
  const { payload, binaries } = encodeRecordForWire(record);
  assert.equal(binaries.length, 2);
  const reassembled = binaries.map((b) => joinBase64Chunks(splitUint8Chunks(b, 4096)));
  const decoded = decodeRecordFromWire(payload, reassembled);
  assert.equal(decoded.videoId, "yt:abc");
  assert.deepEqual(new Uint8Array(decoded.audioBuffer), buf1);
  assert.deepEqual(new Uint8Array(decoded.compactAudioBuffer), new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test("bidirectional sync migrates PageLens settings & data and syncs changes back without loops", async () => {
  installMemoryIndexedDB();
  const bus = makeExtensionBus();
  const pagelensChrome = bus.createChrome(PAGELENS_EXTENSION_ID, {
    settings: {
      text: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-test", summaryInputTokens: 150000 },
      textProviders: [{ id: "oa", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", models: [{ id: "gpt-4o-mini", enabled: true }] }],
      textRef: { providerId: "oa", modelId: "gpt-4o-mini" },
      asr: { preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002", language: "en" },
      tts: { preset: "index-tts", baseUrl: "http://127.0.0.1:7860", lang: "ZH" },
      uiTheme: "cyber",
      hitlMode: "strict",
    },
  });
  const interpretChrome = bus.createChrome(INTERPRET_EXTENSION_ID, {
    settings: {
      text: { baseUrl: "", model: "", apiKey: "" },
      asr: { preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002" },
      tts: { preset: "off", baseUrl: "" },
      uiTheme: "default",
    },
  });

  // Seed one queue job in shared IDB (note: in real Chrome they have separate IDBs;
  // here we also verify settings & manifest sync end-to-end across separate chrome.storage stores).
  await idbSet("dub-queue:yt:demo", { id: "yt:demo", url: "https://youtu.be/demo", title: "Demo", status: "queued", added: 100 });

  installInterpretSync({ role: "pagelens", chromeApi: pagelensChrome });
  const interpretSync = installInterpretSync({ role: "interpret", chromeApi: interpretChrome });

  const status = await interpretSync.syncWithPeer({ reason: "test-initial" });
  assert.equal(status.connected, true);
  const synced = interpretChrome.storage.store.settings;
  assert.equal(synced.text.model, "gpt-4o-mini");
  assert.equal(synced.text.apiKey, "sk-test");
  assert.equal(synced.asr.language, "en");
  assert.equal(synced.tts.baseUrl, "http://127.0.0.1:7860");
  assert.equal(synced.uiTheme, "cyber");
  assert.equal(synced.hitlMode, undefined, "PageLens-only agent fields are not copied");

  // Update theme in PageLens 同传 and verify it propagates back to PageLens while preserving hitlMode!
  await interpretChrome.storage.local.set({
    settings: { ...synced, uiTheme: "warm", tts: { ...synced.tts, lang: "EN" } },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pagelensChrome.storage.store.settings.uiTheme, "warm");
  assert.equal(pagelensChrome.storage.store.settings.tts.lang, "EN");
  assert.equal(pagelensChrome.storage.store.settings.hitlMode, "strict");
  assert.equal(pagelensChrome.storage.store.settings.text.summaryInputTokens, 150000);
  assert.ok(await idbGet("dub-queue:yt:demo"));
});

test("archive manifest uses pl.media.info metadata and syncs/deletes info alongside archive", async () => {
  installMemoryIndexedDB();
  const bus = makeExtensionBus();
  const pagelensChrome = bus.createChrome(PAGELENS_EXTENSION_ID, {});
  const interpretChrome = bus.createChrome(INTERPRET_EXTENSION_ID, {});

  const wav = encodeMonoWav(new Float32Array(1600), 16000);
  const archive = await saveFullMediaArchive({
    videoId: "yt:syncinfo",
    title: "Info Sync",
    url: "https://youtu.be/syncinfo",
    duration: 10,
    audioBlob: wav,
    complete: true,
  });
  // Orphan info record without a backing pl.media.archive. record must be ignored.
  await idbSet("pl.media.info.yt:orphan", { id: "yt:orphan", added: 500, playable: true });

  const pagelensSync = installInterpretSync({ role: "pagelens", chromeApi: pagelensChrome });
  const manifest = await pagelensSync.handleExternal({ type: "pl.sync.getManifest" });
  assert.equal(manifest.records["pl.media.archive.yt:syncinfo"].ts, archive.createdAt);
  assert.equal(manifest.records["pl.media.archive.yt:syncinfo"].complete, true);
  assert.equal(manifest.records["pl.media.archive.yt:orphan"], undefined);

  const readRes = await pagelensSync.handleExternal({
    type: "pl.sync.beginRead",
    kind: "idb",
    key: "pl.media.archive.yt:syncinfo",
  });
  assert.equal(readRes.exists, true);
  assert.equal(readRes.payload.info.id, "yt:syncinfo");

  const interpretSync = installInterpretSync({ role: "interpret", chromeApi: interpretChrome });
  await interpretSync.handleExternal({
    type: "pl.sync.deleteRecord",
    kind: "idbDelete",
    keys: ["pl.media.archive.yt:syncinfo"],
    deletedAt: Date.now(),
  });
  assert.equal(await idbGet("pl.media.archive.yt:syncinfo"), undefined);
  assert.equal(await idbGet("pl.media.info.yt:syncinfo"), undefined);
  await idbDel(["pl.media.info.yt:orphan"]);
});
