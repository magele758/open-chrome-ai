import assert from "node:assert/strict";
import { test } from "node:test";
import { DubQueue, unifiedDubList } from "../lib/dub-queue.js";
import { listDubArchives, saveFullMediaArchive } from "../lib/audio-composer.js";
import { loadTimelineArchive } from "../lib/timeline-archive.js";
import { encodeMonoWav } from "../lib/tts.js";
import { installMemoryIndexedDB } from "./idb_mem.mjs";
import { idbSet, idbGet } from "../lib/idb-kv.js";

test("[AC:unified-dub-priority#AC-1] stored archives, including pre-index audio, can be listed and removed", async () => {
  installMemoryIndexedDB();
  const bytes = new ArrayBuffer(180);
  const old = { videoId: "old", hasAudio: true, audioBuffer: bytes, title: "Old", expireAt: Date.now()+10000 };
  await idbSet("pl.media.archive.old", old);
  await saveFullMediaArchive({videoId:"new", complete:true, audioBlob:new Blob([bytes])});
  const rows = await listDubArchives();
  assert.deepEqual(rows.map(r => r.id).sort(), ["new","old"]);
  const queue = new DubQueue({ load: async () => [{id:"new",status:"ready"}] });
  assert.equal(unifiedDubList(await queue.list(), rows, []).length, 2);
  await queue.remove("old");
  await queue.remove("new");
  assert.deepEqual(await listDubArchives(), []);
  assert.deepEqual(await queue.list(), []);
  assert.equal(await idbGet("pl.media.archive.old"), undefined);
});

test("[AC:unified-dub-priority#AC-2] a live video shows queue progress in a single row", () => {
  const jobs = [{ id: "a", status: "running" }, { id: "b", status: "queued" }];
  const live = [{ id: "b", status: "live" }];
  const rows = unifiedDubList(jobs, [], live);
  assert.deepEqual(rows, [jobs[0], { id: "b", status: "queued", live: true }]);
});

test("deleting queued and active jobs waits for pending saves and continues the queue", async () => {
  installMemoryIndexedDB();
  const started = Promise.withResolvers();
  const ran = [];
  const queue = new DubQueue({ process: async (row, progress, signal) => {
    ran.push(row.id);
    if (row.id === "running") {
      started.resolve();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      // Simulate an archive write that began before cancellation and finished afterward.
      await saveFullMediaArchive({ videoId: row.id, complete: true, audioBlob: new Blob(["audio"]) });
    }
    return Date.now() + 10000;
  } });
  for (const id of ["running", "queued", "next"]) await queue.enqueue({ id });
  const worker = queue.drain();
  await started.promise;
  await queue.remove("queued");
  await queue.remove("running");
  await worker;
  assert.deepEqual(ran, ["running", "next"]);
  assert.deepEqual((await queue.list()).map(row => [row.id, row.status]), [["next", "ready"]]);
  assert.equal(await idbGet("dub-queue:running"), undefined);
  assert.equal(await idbGet("dub-queue:queued"), undefined);
  assert.deepEqual(await listDubArchives(), []);
});

test("manual pause frees the worker and a moved task keeps its position across restart", async () => {
  installMemoryIndexedDB();
  const started = Promise.withResolvers();
  const order = [];
  const queue = new DubQueue({ process: async (row, progress, signal) => {
    order.push(row.id);
    if (row.id === "one") {
      started.resolve();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    }
    return Date.now() + 1000;
  } });
  for (const id of ["one", "two", "three"]) await queue.enqueue({ id });
  const worker = queue.drain();
  await started.promise;
  await queue.setPaused("two", true);
  await queue.move("three", -1);
  await queue.setPaused("one", true);
  await worker;
  assert.deepEqual(order, ["one", "three"]);
  const restored = new DubQueue({ process: async row => { order.push(row.id); return Date.now() + 1000; } });
  const paused = (await restored.list()).filter(row => row.status === "paused");
  assert.deepEqual(paused.map(row => row.id).sort(), ["one", "two"]);
  await restored.move("two", -1);
  await restored.setPaused("two", false);
  await restored.setPaused("one", false);
  await restored.drain();
  assert.deepEqual(order, ["one", "three", "two", "one"]);
});

test("moving the next preload above running work hands off the worker and resumes the displaced job", async () => {
  installMemoryIndexedDB();
  const began = Promise.withResolvers();
  const attempts = [];
  const queue = new DubQueue({ process: async (row, _, signal) => {
    attempts.push(row.id);
    if (attempts.length === 1) {
      began.resolve();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    }
    return Date.now() + 60000;
  } });
  await queue.enqueue({ id: "first" });
  await queue.enqueue({ id: "second" });
  const worker = queue.drain();
  await began.promise;
  await queue.move("second", -1);
  await worker;
  assert.deepEqual(attempts, ["first", "second", "first"]);
});

test("automatic video playback accepts legacy timeline WAVs and skips partial, compact-only, expired or unrelated audio", async () => {
  installMemoryIndexedDB();
  const wav = encodeMonoWav(new Float32Array(120), 16000);
  const url = "https://youtu.be/archived";
  const key = "pl.media.archive.yt:archived";
  const legacy = { audioBlob: wav, url, expireAt: Date.now() + 60000 };
  await idbSet(key, legacy);
  assert.equal((await loadTimelineArchive(url)).audioBlob.size, wav.size);
  for (const changes of [
    { complete: false },
    { audioBlob: null, compactAudioBlob: wav },
    { audioBlob: new Blob([new Uint8Array(256)]) },
    { expireAt: Date.now() - 1000 },
  ]) {
    await idbSet(key, { ...legacy, ...changes });
    assert.equal(await loadTimelineArchive(url), null);
  }
  const part = "https://www.bilibili.com/video/BV123456?p=";
  await idbSet("pl.media.archive.bili:BV123456", { ...legacy, url: part + "1" });
  assert.equal(await loadTimelineArchive(part + "2"), null);
});
