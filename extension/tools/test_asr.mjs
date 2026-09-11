import { defaultSettings, normalizeSettings, isAsrReady, isModelReady, isTtsReady, isSkillsEnabled, ASR_PRESETS } from "../lib/storage.js";
import {
  transcriptionsUrl,
  transcribeUrl,
  asrHealthUrl,
  asrProtocol,
  asrLanguageValue,
  filenameForMime,
  silentWav,
  segmentsFromTranscription,
  formatTranscript,
  collapseRollingCues,
  rollingDelta,
  transcribeAudio,
} from "../lib/asr.js";
import { buildGenSingleData, ttsOrigin, encodeMonoWav, TTS_EMO_SAME_AS_REF } from "../lib/tts.js";
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
    { start: 1.2, end: 3.4, text: " hello " },
    { start: 4, end: 5, text: "world" },
  ],
});
assert(asrProtocol({ preset: "v1-transcribe" }) === "v1-transcribe", "preset protocol");
assert(asrProtocol({ baseUrl: "http://127.0.0.1:8002/v1/transcribe" }) === "v1-transcribe", "url protocol");
assert(asrProtocol({ preset: "openai", baseUrl: "https://api.openai.com/v1" }) === "openai", "openai protocol");
assert(transcribeUrl({ preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002" }) === "http://127.0.0.1:8002/v1/transcribe", "v1 url");
assert(transcribeUrl({ preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002/v1" }) === "http://127.0.0.1:8002/v1/transcribe", "v1 suffix");
assert(asrHealthUrl({ baseUrl: "http://127.0.0.1:8002/v1" }) === "http://127.0.0.1:8002/health", "health url");
assert(asrLanguageValue({ language: "zh-CN" }) === "zh", "lang map");
assert(asrLanguageValue({ language: "" }) === "", "lang auto");
assert(isAsrReady({ preset: "v1-transcribe", baseUrl: "http://127.0.0.1:8002", model: "" }), "v1 ready without model");
assert(!isAsrReady({ preset: "openai", baseUrl: "https://api.openai.com/v1", model: "" }), "openai needs model");
assert(!isTtsReady(defaultSettings().tts), "tts off by default");
assert(isTtsReady({ baseUrl: "http://127.0.0.1:7860" }), "tts ready with url");
assert(ttsOrigin("http://127.0.0.1:7860/") === "http://127.0.0.1:7860", "tts origin");
const payload = buildGenSingleData({ promptFile: { path: "x" }, text: "你好", lang: "ZH", durationFactor: 1 });
assert(TTS_EMO_SAME_AS_REF === "Same as the voice reference", "index-tts2.5 emo label");
assert(payload.length === 26 && payload[0] === TTS_EMO_SAME_AS_REF && payload[2] === "你好" && payload[3] === "ZH", "gen_single arity");
const refWav = encodeMonoWav(new Float32Array(16000), 16000);
assert(refWav.size === 44 + 16000 * 2 && refWav.type === "audio/wav", "encode ref wav");
assert(!JSON.stringify(payload).includes("100.97"), "no private host in payload");

assert(segs.length === 2 && segs[0].start === 1.2 && segs[0].end === 3.4 && segs[0].text === "hello", "parse segments");
assert(segmentsFromTranscription({ text: "only" })[0].text === "only", "text only");
assert(segmentsFromTranscription("plain").length === 1, "plain string");

const formatted = formatTranscript(segs);
assert(formatted.status === "ready", "ready");
assert(formatTime(1.2) === "0:01", "format 1.2s");
assert(formatted.text.includes("[0:01] hello"), "cue 1: " + formatted.text);
assert(formatted.text.includes("[0:04] world"), "cue 2");
const shifted = formatTranscript(segs, 60);
assert(shifted.text.includes(`[${formatTime(64)}] world`), "offset");
assert(rollingDelta("", "团队成员以及 招聘") === "团队成员以及 招聘", "first window");
assert(rollingDelta("团队成员以及 招聘", "团队成员以及 招聘人员都谈论") === "人员都谈论", "cjk tail");
assert(rollingDelta("团队成员以及 招聘人员都谈论", "招聘人员都谈论对") === "对", "cjk slide");
assert(rollingDelta("hello everyone welcome", "everyone welcome to the show") === "to the show", "en slide");
const rolled = collapseRollingCues([
  { start: 1, text: "团队成员以及 招聘" },
  { start: 2, text: "团队成员以及 招聘人员都谈论" },
  { start: 3, text: "招聘人员都谈论对" },
]);
assert(rolled.map((c) => c.text).join("|") === "团队成员以及 招聘|人员都谈论|对", "collapse rolling youtube windows");
const rolledFmt = formatTranscript([
  { start: 1, text: "hello everyone welcome" },
  { start: 3, text: "hello everyone welcome to the show" },
]);
assert(!rolledFmt.text.includes("[0:03] hello everyone welcome to the show"), rolledFmt.text);
assert(rolledFmt.text.includes("[0:03] to the show"), rolledFmt.text);

const empty = normalizeSettings(null);
assert(empty.asr && empty.asr.baseUrl === "", "default asr");
assert(!isAsrReady(empty.asr), "asr not ready");
assert(!isModelReady(empty.text), "text not ready");
const ready = normalizeSettings({ asr: { baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1" } });
assert(isAsrReady(ready.asr), "local asr no key");
assert(ASR_PRESETS.some((p) => p.id === "groq"), "groq preset");
assert(ASR_PRESETS.some((p) => p.id === "v1-transcribe"), "v1 preset");
assert(defaultSettings().asr, "default asr slot");
assert(defaultSettings().tts.preset === "off", "tts off");
assert(defaultSettings().skillsEnabled === false, "skills off by default");
assert(isSkillsEnabled(defaultSettings()) === false, "skills helper off");
assert(isSkillsEnabled(normalizeSettings({})) === false, "missing skills stays off");
assert(isSkillsEnabled(normalizeSettings({ skillsEnabled: true })) === true, "persist skills on");
assert(isSkillsEnabled(normalizeSettings({ skillsEnabled: false })) === false, "persist skills off");

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

assert(!("interpretUseCaptions" in normalizeSettings({ interpretUseCaptions: true })), "legacy caption switch removed");
