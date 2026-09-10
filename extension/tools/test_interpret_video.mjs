import assert from 'node:assert/strict';
import { plInterpretVideo } from '../lib/interpret-video.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
let timer;
globalThis.setInterval = fn => { timer = fn; return 1; };
globalThis.clearInterval = () => { timer = null; };
class Video extends EventTarget {
  constructor() { super(); this._time = 120; this.duration = 600; this.paused = false; this.ended = false; this.playbackRate = 1; this.readyState = 4; this.isConnected = true; this.muted = false; }
  get currentTime() { return this._time; }
  set currentTime(value) { this._time = value; this.seeking = true; this.dispatchEvent(new Event('seeking')); this.seeking = false; }
  pause() { if (this.paused) return; this.paused = true; queueMicrotask(() => this.dispatchEvent(new Event('pause'))); }
  play() { if (this.paused) { this.paused = false; queueMicrotask(() => this.dispatchEvent(new Event('play'))); } return Promise.resolve(); }
}
const video = new Video();
globalThis.document = { querySelector: () => video };
const audios = [];
globalThis.Audio = class {
  constructor() { this.duration = 8; this.currentTime = 0; this.paused = true; audios.push(this); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() { if (this.src) queueMicrotask(() => this.onloadedmetadata?.()); }
  removeAttribute() { this.src = ''; }
};
const token = 'test';
const call = (cmd, arg = {}) => plInterpretVideo(cmd, { token, ...arg });
call('start');
await flush();
assert(video.paused && video.muted, 'visible video waits silently for initial buffer');
assert(call('state').desiredPlaying, 'internal buffering pause preserves play intent');
await call('audio', { start: 120, end: 125, b64: btoa('wave'), revision: 0 });
await flush();
assert(!video.paused);
timer(); await flush();
assert(!audios[0].paused);
assert.equal(audios[0].playbackRate, 1.6, 'fit translated duration to source span');
video._time = 122;
timer();
assert.equal(audios[0].currentTime, 0, 'drift correction must never skip unspoken audio');
assert(audios[0].playbackRate > 1.6, 'drift is corrected gradually through playback speed');
audios[0].currentTime = 3.2;
video.pause(); await flush();
assert(audios[0].paused, 'pause stops audio via video event');
assert(!call('state').desiredPlaying);
video.play(); await flush(); timer(); await flush();
assert(!audios[0].paused);
video.playbackRate = 1.5;
video.dispatchEvent(new Event('ratechange'));
assert(Math.abs(audios[0].playbackRate - 2.4) < 1e-9, 'native playback speed applies to audio');
video.readyState = 2;
timer();
assert(audios[0].paused, 'network stall stops translated speech');
video.readyState = 4;
video._time = 125;
timer(); await flush();
assert(!call('state').done && video.paused, 'video waits at the boundary until speech actually ends');
assert(!audios[0].paused, 'tail keeps playing while the video is held');
assert.equal(audios[0].currentTime, 3.2, 'boundary must not skip directly to the audio end');
assert(!call('audio', { revision: 0 }).ok, 'a new segment cannot replace unfinished speech');
audios[0].currentTime = audios[0].duration;
audios[0].onended();
assert(call('state').done, 'audio ended event releases the segment');
assert(call('state').desiredPlaying, 'boundary is not a user pause');
await call('audio', { start: 125, end: 130, b64: btoa('wave2'), revision: 0 });
await flush(); timer();
video.currentTime = 240;
await flush();
assert(audios[1].paused && video.paused, 'seek stops stale audio and waits for new buffer');
assert.equal(call('state').revision, 1);
assert(call('audio', { revision: 0 }).stale, 'old requests cannot install audio after seek');
await call('audio', { start: 240, end: 245, b64: btoa('wave3'), revision: 1 });
await flush();
assert(!video.paused);
audios[2].onended();
assert(!call('state').done && !video.paused, 'shorter speech waits for the corresponding video to finish');
video._time = 245;
timer(); await flush();
assert(call('state').done && video.paused);
await call('audio', { start: 245, end: 250, b64: btoa('final'), revision: 1 });
await flush();
video._time = 250;
video.ended = true;
video.pause();
await flush(); timer(); await flush();
assert(call('state').desiredPlaying && !audios[3].paused && !call('state').done, 'natural video end must drain final speech');
audios[3].onended();
assert(call('state').done);
video.ended = false;
video.play(); await flush();
// Already internally held at the boundary; install a fresh segment to test
// an ordinary user pause during active playback before cleanup.
await call('audio', { start: 250, end: 255, b64: btoa('last'), revision: 1 });
await flush();
video.pause(); await flush();
call('stop');
assert(!video.muted && video.paused, 'cleanup restores original sound and respects user pause');
assert.equal(timer, null);
assert(!call('state').ok);
console.log('ok video sync: buffering, clock, duration, pause/resume, rate, stall, seek, stale work, cleanup');
