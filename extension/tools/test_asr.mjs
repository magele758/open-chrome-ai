import { defaultSettings, normalizeSettings, isAsrReady, isModelReady, ASR_PRESETS } from "../lib/storage.js";
import {
  transcriptionsUrl,
  filenameForMime,
  silentWav,
  segmentsFromTranscription,
  formatTranscript,
  transcribeAudio,
} from "../lib/asr.js";
import { videoIdentity } from "../lib/captions.js";
import { packToContext, formatTime } from "../lib/prompts.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(transcriptionsUrl("https://api.openai.com/v1") === "https://api.openai.com/v1/audio/transcriptions", "url join");
assert(transcriptionsUrl("https://x/v1/") === "https://x/v1/audio/transcriptions", "trim slash");
assert(
  transcriptionsUrl("http://127.0.0.1:8000/v1/audio/transcriptions") ===
    "http://127.0.0.1:8000/v1/audio/transcriptions",
  "already complete",
);
assert(filenameForMime("audio/webm;codecs=opus") === "audio.webm", "webm name");
assert(filenameForMime("audio/wav") === "audio.wav", "wav name");

const wav = silentWav(0.2);
assert(wav.size === 44 + 16000 * 0.2 * 2, "wav size " + wav.size);
assert(wav.type === "audio/wav", "wav type");

const segs = segmentsFromTranscription({
  text: "hello world",
  segments: [
    { start: 1.2, text: " hello " },
    { start: 4, text: "world" },
  ],
});
assert(segs.length === 2 && segs[0].start === 1.2 && segs[0].text === "hello", "parse segments");
assert(segmentsFromTranscription({ text: "only" })[0].text === "only", "text only");
assert(segmentsFromTranscription("plain").length === 1, "plain string");

const formatted = formatTranscript(segs);
assert(formatted.status === "ready", "ready");
assert(formatTime(1.2) === "0:01", "format 1.2s");
assert(formatted.text.includes("[0:01] hello"), "cue 1: " + formatted.text);
assert(formatted.text.includes("[0:04] world"), "cue 2");
const shifted = formatTranscript(segs, 60);
assert(shifted.text.includes(`[${formatTime(64)}] world`), "offset");

const empty = normalizeSettings(null);
assert(empty.asr && empty.asr.baseUrl === "", "default asr");
assert(!isAsrReady(empty.asr), "asr not ready");
assert(!isModelReady(empty.text), "text not ready");
const ready = normalizeSettings({ asr: { baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1" } });
assert(isAsrReady(ready.asr), "local asr no key");
assert(ASR_PRESETS.some((p) => p.id === "groq"), "groq preset");
assert(defaultSettings().asr, "default asr slot");

assert(videoIdentity("https://www.youtube.com/watch?v=dQw4w9wgGcQ&t=12") === "yt:dQw4w9wgGcQ", "yt id");
assert(videoIdentity("https://youtu.be/dQw4w9wgGcQ?t=3") === "yt:dQw4w9wgGcQ", "youtu.be");
assert(videoIdentity("https://www.bilibili.com/video/BV1xx411c7mD?p=1") === "bili:BV1xx411c7mD", "bili");
assert(!videoIdentity("https://example.com/a?utm_source=x").includes("utm_source"), "strip utm");

const ctx = packToContext({
  videoIsPrimary: true,
  video: { duration: 90, currentTime: 3 },
  title: "Demo",
  url: "https://youtu.be/x",
  captionsText: "[0:01] hi",
  captionsSource: "asr",
});
assert(/语音转写/.test(ctx), "asr note in context");
assert(/\[0:01\] hi/.test(ctx), "captions in context");

const missing = packToContext({
  videoIsPrimary: true,
  video: { duration: 10, currentTime: 0 },
  title: "No",
  url: "https://example.com/",
});
assert(/transcribe_video/.test(missing), "hint transcribe");

let fetchUrl = "";
let fetchFile = "";
globalThis.fetch = async (url, opts) => {
  fetchUrl = url;
  const form = opts.body;
  fetchFile = form.get("file")?.name || "";
  return {
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({
      text: "hello world",
      segments: [
        { start: 0.5, text: "hello" },
        { start: 1.5, text: "world" },
      ],
    }),
  };
};

const out = await transcribeAudio(
  { baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1", apiKey: "" },
  wav,
  { filename: "silent.wav" },
);
assert(fetchUrl.endsWith("/audio/transcriptions"), "posted transcriptions " + fetchUrl);
assert(fetchFile === "silent.wav", "filename " + fetchFile);
assert(out[0].text === "hello" && out[1].start === 1.5, "transcribeAudio segments");

console.log("PASS asr");
