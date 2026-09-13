import { installMemoryIndexedDB } from "./idb_mem.mjs";
installMemoryIndexedDB();

import assert from "node:assert/strict";
import { encodeMonoWav } from "../lib/tts.js";
import {
  extractPcmSamplesFromWav,
  composeFullDubTrack,
  composeCompactDubTrack,
  calculateExpireAt,
  isArchiveExpired,
  saveFullMediaArchive,
  loadFullMediaArchive,
  cleanExpiredMediaArchives,
  ARCHIVE_TTL_DAYS,
} from "../lib/audio-composer.js";
import { idbSet } from "../lib/idb-kv.js";

console.log("--- 1. Testing PCM Extraction & Encoding ---");
const sampleRate = 16000;
const tone = new Float32Array(sampleRate); // 1 second of tone
for (let i = 0; i < tone.length; i++) {
  tone[i] = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.5;
}
const wavBlob = encodeMonoWav(tone, sampleRate);
const arrayBuf = await wavBlob.arrayBuffer();
const pcm = extractPcmSamplesFromWav(arrayBuf);
assert.ok(pcm, "PCM should be extracted");
assert.equal(pcm.sampleRate, 16000, "Sample rate matches");
assert.equal(pcm.samples.length, 16000, "Sample count matches");
console.log("PASS: PCM extraction and encoding");

console.log("--- 2. Testing Compose Full Dub Track ---");
// Segment 1 at 0.5s, Segment 2 at 2.0s
const seg1Samples = new Float32Array(8000); // 0.5s
seg1Samples.fill(0.3);
const seg2Samples = new Float32Array(16000); // 1.0s
seg2Samples.fill(0.6);

const seg1Blob = encodeMonoWav(seg1Samples, sampleRate);
const seg2Blob = encodeMonoWav(seg2Samples, sampleRate);

const fullTrackBlob = await composeFullDubTrack([
  { start: 0.5, end: 1.0, blob: seg1Blob },
  { start: 2.0, end: 3.0, blob: seg2Blob },
], { sampleRate, totalDuration: 3.5 });

assert.ok(fullTrackBlob, "Full track blob generated");
assert.equal(fullTrackBlob.type, "audio/wav");
const fullTrackPcm = extractPcmSamplesFromWav(await fullTrackBlob.arrayBuffer());
assert.ok(fullTrackPcm, "Full track extracted");
assert.ok(fullTrackPcm.samples.length >= 3.0 * sampleRate, "Total samples >= 3s");
// Check that silence exists before 0.5s
assert.equal(fullTrackPcm.samples[Math.floor(0.1 * sampleRate)], 0, "Silence before seg1");
// Check that audio exists at 0.6s
assert.ok(Math.abs(fullTrackPcm.samples[Math.floor(0.6 * sampleRate)] - 0.3) < 0.05, "Seg1 placed at 0.5s");
// Check that silence exists between 1.5s and 1.9s
assert.equal(fullTrackPcm.samples[Math.floor(1.5 * sampleRate)], 0, "Silence between segments");
// Check that seg2 exists at 2.2s
assert.ok(Math.abs(fullTrackPcm.samples[Math.floor(2.2 * sampleRate)] - 0.6) < 0.05, "Seg2 placed at 2.0s");
console.log("PASS: Compose full dub track with correct timestamps");

console.log("--- 2.1 Testing Compose Compact Dub Track ---");
// Compact mode: seg1 (0.5s) + 0.25s gap + seg2 (1.0s) = 1.75s total! (No long video pause)
const compactRes = await composeCompactDubTrack([
  { id: "line-1", zh: "第一句", src: "sentence one", blob: seg1Blob },
  { id: "line-2", zh: "第二句", src: "sentence two", blob: seg2Blob },
], { sampleRate, gapMs: 250 });

assert.ok(compactRes.blob, "Compact blob generated");
assert.equal(compactRes.cues.length, 2, "2 cues returned");
assert.equal(compactRes.cues[0].compactStart, 0, "First cue starts at 0s");
assert.equal(compactRes.cues[0].compactEnd, 0.5, "First cue ends at 0.5s");
assert.equal(compactRes.cues[1].compactStart, 0.75, "Second cue starts after 0.25s gap (0.75s)");
assert.equal(compactRes.cues[1].compactEnd, 1.75, "Second cue ends at 1.75s");
assert.ok(Math.abs(compactRes.duration - 1.75) < 0.01, "Total compact duration is 1.75s");
console.log("PASS: Compose compact dub track without video timeline gaps");

console.log("--- 3. Testing 7-Day TTL Expiration & Storage ---");
const now = Date.now();
const expireAt = calculateExpireAt(now);
assert.equal(Math.round((expireAt - now) / (24 * 3600 * 1000)), 7, "TTL is 7 days");
assert.equal(isArchiveExpired(expireAt), false, "Fresh archive is not expired");
assert.equal(isArchiveExpired(now - 1000), true, "Past timestamp is expired");

await saveFullMediaArchive({
  videoId: "test-video-1",
  title: "Test Video 1",
  url: "https://example.com/v1",
  duration: 120,
  lines: [{ start: 0, zh: "你好" }],
  audioBlob: fullTrackBlob,
});

const loaded = await loadFullMediaArchive("test-video-1");
assert.ok(loaded, "Archive loaded successfully");
assert.equal(loaded.title, "Test Video 1");
assert.equal(loaded.remainingDays, 7);
assert.ok(loaded.hasAudio);

// Test expired cleanup
await idbSet("pl.media.archive.expired-video", {
  videoId: "expired-video",
  expireAt: now - 3600 * 1000, // expired 1h ago
});

const deleted = await cleanExpiredMediaArchives();
assert.ok(deleted.includes("pl.media.archive.expired-video"), "Expired archive cleaned");
const expiredLoad = await loadFullMediaArchive("expired-video");
assert.equal(expiredLoad, null, "Expired archive cannot be loaded");
console.log("PASS: 7-Day TTL archive storage & automatic cleanup");

console.log("ALL AUDIO COMPOSER TESTS PASSED!");
