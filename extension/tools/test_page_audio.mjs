import assert from 'node:assert/strict';
import { plPageAudio } from '../lib/video-pick.js';
let plays = 0;
const video = { paused: true, ended: false, currentTime: 10, play() { plays++; this.paused = false; if (this.ended) this.currentTime = 0; return Promise.resolve(); } };
globalThis.document = { querySelector: () => video };
const stream = { getAudioTracks: () => [{}], getTracks: () => [{ stop() {} }] };
globalThis.__plAudioTap = { dest: { stream } };
globalThis.MediaRecorder = class {
  static isTypeSupported() { return true; }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
  start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['audio']) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
};
globalThis.FileReader = class {
  readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = 'data:audio/webm;base64,' + Buffer.from(buffer).toString('base64'); this.onload(); }); }
};
assert(plPageAudio('start').ok);
assert.equal(plays, 1, 'initial start may start the source');
video.paused = true;
video.ended = true;
video.currentTime = 20;
assert((await plPageAudio('take')).ok);
assert.equal(plays, 1, 'taking final slice must not restart an ended source');
assert.equal(video.currentTime, 20);
video.ended = false;
assert((await plPageAudio('take')).ok);
assert.equal(plays, 1, 'taking a slice also respects a paused source after seeking');
await plPageAudio('stop');
console.log('ok page audio: chunk rollover preserves ended and paused playback state');
