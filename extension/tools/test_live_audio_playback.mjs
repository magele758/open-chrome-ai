import assert from 'node:assert/strict';
import { playFollowingVideo } from '../lib/live-audio-playback.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class AudioMock {
  constructor() { this.paused = true; this.duration = 8; this.currentTime = 0; this.readyState = 4; this.playCalls = 0; }
  play() { this.paused = false; this.playCalls++; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() {}
  load() {}
}
const blob = new Blob(['audio']);
{
  const audio = new AudioMock();
  const abort = new AbortController();
  const state = { ok: true, currentTime: 5, paused: true, systemHold: true, userPaused: false, readyState: 4, playbackRate: 1 };
  let starts = 0;
  const task = playFollowingVideo({ blob, start: 0, end: 5, signal: abort.signal,
    readState: async () => state, createAudio: () => audio, onStart: () => starts++, tickMs: 5 });
  try {
    await sleep(30);
    assert(audio.playCalls > 0, 'internal picture hold must allow queued speech to drain, otherwise backlog deadlocks');
    assert.equal(starts, 1);
    state.userPaused = true;
    await sleep(20);
    assert(audio.paused, 'real user pause always stops speech');
    state.userPaused = false; state.paused = false; state.systemHold = false; state.playbackRate = 2;
    await sleep(20);
    assert(!audio.paused && audio.playbackRate >= 2, 'resume and 2x speed follow video');
    assert.equal(starts, 1, 'resume cannot re-emit same line');
    audio.currentTime = 3;
    state.seeking = true;
    await sleep(20);
    assert(audio.paused, 'seek pauses old audio');
    abort.abort(); await task;
    assert(audio.paused, 'stop releases actual audio');
  } finally { abort.abort(); await task; }
}
{
  const audio = new AudioMock();
  let stale = false;
  const task = playFollowingVideo({ blob, start: 0, end: 5, isStale: () => stale,
    readState: async () => ({ ok: true, currentTime: 5, paused: false, readyState: 4, playbackRate: 1 }),
    createAudio: () => audio, tickMs: 5,
    align: () => ({ action: 'show', offset: 7 }) });
  try {
    await sleep(20);
    assert.equal(audio.currentTime, 0, 'latency correction must not skip most of a translated sentence');
  } finally { stale = true; await task; }
  assert(audio.paused, 'old generation stops active sound');
}
console.log('PASS live audio: internal hold, pause/resume, speed, seek, abort, no skipped words');
