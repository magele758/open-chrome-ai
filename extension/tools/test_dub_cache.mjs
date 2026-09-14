import { installMemoryIndexedDB } from "./idb_mem.mjs";
installMemoryIndexedDB();

import assert from "node:assert/strict";
import { dubKey, readDubCache, writeDubCache } from "../lib/dub-cache.js";
import { idbSet, idbGet, idbDel } from "../lib/idb-kv.js";

console.log("Starting dub-cache test suite...");

// 1. Test Array preservation
const keyArr = await dubKey({ test: "array-preservation" });
const testLines = [
  { id: "cue-0", zh: "第一句翻译", src: "First sentence", speaker: "spk:0" },
  { id: "cue-1", zh: "第二句翻译", src: "Second sentence", speaker: "spk:1" },
];
await writeDubCache(keyArr, testLines);

const loadedLines = await readDubCache(keyArr);
assert.ok(loadedLines, "Array data should be successfully loaded");
assert.ok(Array.isArray(loadedLines), "Data should remain an Array and not be converted to Object");
assert.equal(loadedLines.length, 2, "Array length must match");
assert.equal(loadedLines[0].zh, "第一句翻译", "Array element 0 matches");
assert.equal(loadedLines[1].zh, "第二句翻译", "Array element 1 matches");
console.log("  PASS: Array preservation in writeDubCache and readDubCache");

// 2. Test Plan Object preservation
const keyPlan = await dubKey({ test: "plan-preservation" });
const testPlan = {
  lines: testLines,
  cues: [{ id: "c1", start: 0, end: 5 }],
  context: "测试视频上下文",
  sourceKey: "src-123",
};
await writeDubCache(keyPlan, testPlan);

const loadedPlan = await readDubCache(keyPlan);
assert.ok(loadedPlan, "Plan object should be loaded");
assert.ok(Array.isArray(loadedPlan.lines), "Plan lines must be Array");
assert.ok(Array.isArray(loadedPlan.cues), "Plan cues must be Array");
assert.equal(loadedPlan.context, "测试视频上下文", "Context preserved");
assert.equal(loadedPlan.lines[0].zh, "第一句翻译", "Plan line 0 matches");
console.log("  PASS: Plan object and nested arrays preservation");

// 3. Test Legacy / Corrupted Object Array Auto-Repair
const keyCorrupted = await dubKey({ test: "corrupted-array-repair" });
const corruptedObj = {
  "0": { id: "c0", zh: "修复测试0" },
  "1": { id: "c1", zh: "修复测试1" },
  blob: undefined,
  backgroundBlob: undefined,
  blobBuffer: undefined,
  backgroundBuffer: undefined,
  mime: "audio/wav",
};
await idbSet(keyCorrupted, { expires: Date.now() + 86400000, value: corruptedObj });

const repaired = await readDubCache(keyCorrupted);
assert.ok(repaired, "Corrupted entry should be read and repaired");
assert.ok(Array.isArray(repaired), "Corrupted entry should be auto-repaired to Array");
assert.equal(repaired.length, 2, "Repaired array length should be 2");
assert.equal(repaired[0].zh, "修复测试0", "Repaired item 0 content matches");
assert.equal(repaired[1].zh, "修复测试1", "Repaired item 1 content matches");
console.log("  PASS: Legacy corrupted array object auto-repair");

// 4. Test Audio Blob Serialization & Deserialization
const keyAudio = await dubKey({ test: "audio-blob-handling" });
const dummyBytes = new Uint8Array(100);
for (let i = 0; i < 100; i++) dummyBytes[i] = i % 256;
const dummyBlob = new Blob([dummyBytes], { type: "audio/wav" });
const testAudioItem = {
  id: "dub-audio-1",
  zh: "配音音频",
  audioSeconds: 2.5,
  slotEnd: 2.5,
  blob: dummyBlob,
};
await writeDubCache(keyAudio, testAudioItem);

const loadedAudio = await readDubCache(keyAudio);
assert.ok(loadedAudio, "Audio entry should be loaded");
assert.ok(loadedAudio.blob instanceof Blob, "Audio blob should be reconstructed as in-memory Blob");
assert.equal(loadedAudio.blob.size, 100, "Audio blob size matches original");
assert.equal(loadedAudio.audioSeconds, 2.5, "audioSeconds preserved");
console.log("  PASS: Audio blob serialization and reconstruction");

// 5. Test Corrupted / Empty Audio Purge
const keyBadAudio = await dubKey({ test: "bad-audio-purge" });
const emptyAudioItem = {
  id: "bad-audio",
  blobBuffer: new ArrayBuffer(10), // Less than 44 bytes wav header
};
await idbSet(keyBadAudio, { expires: Date.now() + 86400000, value: emptyAudioItem });

const purged = await readDubCache(keyBadAudio);
assert.equal(purged, null, "Corrupt audio buffer should be purged and return null");
const idbDirect = await idbGet(keyBadAudio);
assert.equal(idbDirect, undefined, "Corrupt key should be removed from storage");
console.log("  PASS: Corrupt audio buffer purge");

console.log("All dub-cache tests passed successfully!");
