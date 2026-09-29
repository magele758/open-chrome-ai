// Real-service end-to-end run of the production scheduler (runPlannedInterpret):
// real media helper, text model and TTS; a simulated player advances in real time.
// Usage: node extension/tools/live_interpret_e2e.mjs <settings.json> <videoUrl> [watchSeconds] [startAt]
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { completeChat } from '../lib/openai.js';
import { runPlannedInterpret } from '../lib/planned-interpret.js';
import { normalizeSettings } from '../lib/storage.js';
import { openInterpretSource } from '../lib/downloaded-audio-source.js';
import { wavSeconds } from './test_interpret_functional.mjs';

const [settingsPath, url, watchArg = '150', startArg = '0'] = process.argv.slice(2);
if (!settingsPath || !url) throw new Error('Usage: live_interpret_e2e.mjs <settings.json> <videoUrl> [watchSeconds] [startAt]');
const settings = normalizeSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
const watch = Number(watchArg), startAt = Number(startArg);
const t0 = Date.now(), el = () => ((Date.now() - t0) / 1000).toFixed(1);

async function duration(blob) {
  const buffer = await blob.arrayBuffer();
  try { return wavSeconds(buffer); } catch {
    const file = `/tmp/pl-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(file, Buffer.from(buffer));
    try { return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString()); }
    finally { unlinkSync(file); }
  }
}

const state = { ok: true, currentTime: startAt, paused: true, readyState: 4, playbackRate: 1, silenced: false,
  userPaused: false, seekRevision: 0, ended: false, duration: 0 };
let lastTick = Date.now(), pausedMs = 0, firstPlayAt = null, pauses = [], pauseStart = null;
const clock = setInterval(() => {
  const now = Date.now(), dt = now - lastTick; lastTick = now;
  if (!state.paused) state.currentTime += dt / 1000 * state.playbackRate;
  else if (firstPlayAt) pausedMs += dt;
  if (state.duration && state.currentTime >= state.duration) { state.currentTime = state.duration; state.ended = true; }
}, 20);
const setPaused = paused => {
  if (paused === state.paused) return;
  state.paused = paused;
  if (paused && firstPlayAt) pauseStart = { at: Date.now(), video: state.currentTime };
  if (!paused && pauseStart) { pauses.push({ seconds: (Date.now() - pauseStart.at) / 1000, video: pauseStart.video }); pauseStart = null; }
};

const played = [], events = [], metrics = [];
const createAudio = () => {
  const audio = { paused: true, currentTime: 0, playbackRate: 1, timer: null, startedAt: 0,
    pause() { if (this.paused) return; this.paused = true; clearTimeout(this.timer);
      this.currentTime += (Date.now() - this.startedAt) / 1000 * this.playbackRate; },
    async play() {
      if (!this.paused) return;
      this.paused = false; this.startedAt = Date.now();
      if (!this.played) { this.played = true; played.push({ at: el(), video: state.currentTime.toFixed(1), item: this.dubItem });
        if (!firstPlayAt) firstPlayAt = Date.now(); }
      const left = Math.max(0, (this.dubItem?.audioSeconds || 0) - this.currentTime) / Math.max(.25, this.playbackRate);
      this.timer = setTimeout(() => { this.paused = true; this.onended?.(); }, left * 1000);
    } };
  return audio;
};

const abort = new AbortController();
const memory = new Map();
const video = async (cmd, arg = {}) => {
  if (cmd === 'media') return { ok: true, duration: state.duration || undefined };
  if (cmd === 'control') setPaused(arg.action === 'pause');
  if (cmd === 'silence') state.silenced = true;
  if (cmd === 'restore') state.silenced = false;
  if (cmd === 'seek') { state.currentTime = arg.seconds; state.seekRevision++; if (arg.paused) setPaused(true); }
  return { ...state };
};
let lastStatus = '';
const running = runPlannedInterpret({ tabId: 1, sourceUrl: url, settings, signal: abort.signal, startAt, video,
  cacheGet: async k => memory.get(k), cacheSet: async (k, v) => { memory.set(k, v); },
  getTtsRef: async () => null,
  chat: async (model, request) => {
    const began = Date.now();
    const out = await completeChat(model, request);
    if (process.env.E2E_CHAT_LOG) appendFileSync(process.env.E2E_CHAT_LOG, JSON.stringify({ ms: Date.now() - began,
      system: request.messages[0].content.slice(0, 120), input: request.messages[1].content, output: out }) + '\n');
    return out;
  },
  voiceRef: async blob => blob && blob.size > 32000 * 2 ? blob : null,
  audioDuration: duration, createAudio,
  openSource: async args => {
    const source = await openInterpretSource(args);
    state.duration = source.duration;
    console.log(`[${el()}s] source ready: duration=${source.duration}s subtitles=${source.subtitles?.length || 0} complete=${source.subtitlesComplete}`);
    return source;
  },
  onEvent: ev => {
    events.push({ at: el(), ...ev, blob: undefined, segment: undefined });
    if (ev.type === 'metric') metrics.push(ev);
    if (ev.type === 'status' && ev.message !== lastStatus) { lastStatus = ev.message; console.log(`[${el()}s v=${state.currentTime.toFixed(1)}] ${ev.message}`); }
    if (ev.type === 'warn' || ev.type === 'dub_gap') console.log(`[${el()}s v=${state.currentTime.toFixed(1)}] ${ev.type}: ${ev.message || ev.reason}`);
  },
});
const outcome = running.then(value => ({ value }), error => ({ error }));
const deadline = Date.now() + (watch + 600) * 1000;
while (Date.now() < deadline) {
  const done = await Promise.race([outcome, new Promise(r => setTimeout(() => r(null), 500))]);
  if (done) { if (done.error) console.log('RUN ERROR:', done.error.message); break; }
  if (firstPlayAt && state.currentTime - startAt >= watch) break;
}
abort.abort(); await outcome; clearInterval(clock);

const lines = events.filter(e => e.type === 'line');
const fallback = lines.filter(e => e.fallbackOriginal);
const byStage = {};
for (const m of metrics) (byStage[m.stage] ||= []).push(m.durationMs);
const stat = arr => arr?.length ? `n=${arr.length} avg=${(arr.reduce((a, b) => a + b, 0) / arr.length / 1000).toFixed(2)}s max=${(Math.max(...arr) / 1000).toFixed(2)}s` : '-';
const wall = firstPlayAt ? (Date.now() - firstPlayAt) / 1000 : 0;
const longPauses = pauses.filter(p => p.seconds >= 1);
console.log('\n===== REPORT =====');
console.log(`first dub audio: ${firstPlayAt ? ((firstPlayAt - t0) / 1000).toFixed(1) + 's' : 'NEVER'}`);
console.log(`video advanced: ${(state.currentTime - startAt).toFixed(1)}s in ${wall.toFixed(1)}s after first play; paused ${(pausedMs / 1000).toFixed(1)}s (${wall ? (pausedMs / 10 / wall).toFixed(1) : 0}%)`);
console.log(`pauses>=1s: ${longPauses.length}, longest ${Math.max(0, ...pauses.map(p => p.seconds)).toFixed(1)}s`);
console.log(`lines shown: ${lines.length}, dub audio played: ${played.length}, original-audio fallback: ${fallback.length}`);
for (const [stage, arr] of Object.entries(byStage)) console.log(`  ${stage}: ${stat(arr)}`);
const gaps = events.filter(e => e.type === 'dub_gap');
if (gaps.length) console.log('dub_gap reasons:', [...new Set(gaps.map(g => g.reason))].join(', '));
console.log('sample:', played.slice(0, 5).map(p => `${p.video}s ${p.item?.zh?.slice(0, 24)} (${p.item?.audioSeconds?.toFixed(1)}s/${(p.item?.end - p.item?.start).toFixed(1)}s)`).join(' | '));
process.exit(0);
