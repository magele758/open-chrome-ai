import assert from "node:assert/strict";
import { test } from "node:test";
import { DubQueue, unifiedDubList } from "../lib/dub-queue.js";
import { listDubArchives, saveFullMediaArchive } from "../lib/audio-composer.js";
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

test("[AC:unified-dub-priority#AC-2] foreground aborts current work and FIFO resumes from it", async () => {
  const seen = [];
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const queue = new DubQueue({ load: async () => [], save: async () => {}, process: async (row, progress, signal) => {
    seen.push(row.id);
    if (seen.length === 1) {
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    return Date.now()+1000;
  }});
  for (const id of ["a","b"]) await queue.enqueue({id});
  const running = queue.drain();
  await first;
  queue.setForeground(true);
  await running;
  await queue.drain();
  assert.deepEqual(seen, ["a"]);
  const list = unifiedDubList(await queue.list(), [], [{id:"b",status:"live"}]);
  assert.deepEqual(list.map(r => [r.id,r.status]), [["b","live"],["a","queued"]]);
  queue.setForeground(false);
  await queue.drain();
  assert.deepEqual(seen, ["a","a","b"]);
});
