import {
  chineseRatio,
  cleanTranslation,
  cueKey,
  stripTimeline,
  isImplausibleReset,
  isSeekJump,
  joinSegmentText,
  linesToCaptions,
  LOOKAHEAD_MAX_CUES,
  OPENING_READY_TEXT,
  OPENING_READY_TTS,
  openingReadyCount,
  pickLiveCue,
  pickLookaheadCues,
  pruneSpokenOnSeek,
  shouldTranslate,
  timedCues,
  captionsForInterpret,
  voiceRefForTime,
  voiceRefFromBlob,
  withCueEnds,
} from "../lib/interpret.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(chineseRatio("hello world") < 0.1, "en ratio");
assert(chineseRatio("这是中文句子") > 0.8, "zh ratio");
assert(shouldTranslate("The model is trained on video."), "translate en");
assert(!shouldTranslate("这个模型在视频上训练。"), "skip zh");

assert(cleanTranslation("<think>plan</think>\n你好世界", "x") === "你好世界", "strip think before timeline tags");
assert(cleanTranslation("译文：你好世界", "x") === "你好世界", "strip prefix");
assert(cleanTranslation("「你好」", "x") === "你好", "strip quotes");
assert(cleanTranslation("```\nhello\n```", "x") === "hello", "strip fence");
assert(cleanTranslation("", "fallback") === "fallback", "fallback");
assert(stripTimeline("[1:23] Hello world") === "Hello world", "strip display clock");
assert(stripTimeline("[1:02:03] 下一句\n[1:02:08] 再一句") === "下一句 再一句", "strip leaked transcript clocks");
assert(stripTimeline("00:01:23.000 --> 00:01:26.000 你好") === "你好", "strip vtt span");
assert(
  stripTimeline("团队成员以及 招聘<00:29:15.990><c>人员</c><00:29:16.660><c>都</c><00:29:17.330><c>谈论</c><00:29:18.000><c>对</c>")
    === "团队成员以及 招聘人员都谈论对",
  "strip youtube karaoke clocks",
);
assert(cleanTranslation("[3:20] 你好世界", "x") === "你好世界", "translation drops clock");
assert(timedCues([{ start: 83, text: "[1:23] Hello world" }])[0].text === "Hello world", "cues keep words only");
assert(
  timedCues([
    { start: 10, text: "团队成员以及 招聘<00:29:15.990><c>人员</c>" },
    { start: 12, text: "团队成员以及 招聘人员都<00:29:17.330><c>谈论</c>" },
  ]).map((c) => c.text).join("|") === "团队成员以及 招聘人员|都谈论",
  "karaoke rolling windows collapse after stripping clocks",
);

const cues = withCueEnds([
  { start: 0, text: "hello" },
  { start: 2.5, text: "world" },
  { start: 5, end: 8, text: "done" },
]);
assert(cues[0].end === 2.5, "infer end from next");
assert(cues[2].end === 8, "keep explicit end");

const spoken = new Set();
const a = pickLiveCue(cues, 0.1, spoken);
assert(a?.cue?.text === "hello", "pick first " + a?.cue?.text);
spoken.add(a.key);
const b = pickLiveCue(cues, 0.1, spoken);
assert(!b, "do not repeat");
const c = pickLiveCue(cues, 2.6, spoken);
assert(c?.cue?.text === "world", "pick second");
const late = pickLiveCue(cues, 40, spoken);
assert(!late, "skip far future");

const spokenAhead = new Set();
const many = withCueEnds(Array.from({ length: 20 }, (_, i) => ({ start: i * 2, text: `cue ${i} hello` })));
const ahead = pickLookaheadCues(many, 0.1, spokenAhead);
assert(OPENING_READY_TTS <= LOOKAHEAD_MAX_CUES, "tts opening stays within lookahead");
assert(OPENING_READY_TEXT <= LOOKAHEAD_MAX_CUES, "text opening stays within lookahead");
assert(openingReadyCount(true) === OPENING_READY_TTS, "tts opening count");
assert(openingReadyCount(false) === OPENING_READY_TEXT, "text opening count");
assert(ahead.length === LOOKAHEAD_MAX_CUES, `lookahead capped at ${LOOKAHEAD_MAX_CUES}, got ${ahead.length}`);
assert(ahead[0].cue.text.includes("cue 0"), "lookahead starts at current");
assert(!ahead.some((h) => h.cue.start >= 20), "lookahead stops at ~20s");
const midCues = withCueEnds(Array.from({ length: 25 }, (_, i) => ({ start: i * 2, text: `cue ${i} hello` })));
const mid = pickLookaheadCues(midCues, 40.4, new Set());
assert(mid[0].cue.text.includes("cue 20"), "mid-video lookahead starts at current progress");
assert(!mid.some((h) => h.cue.start < 40), "does not translate from the beginning");
assert(timedCues([{ start: 12, text: "ok" }, { text: "no time" }, { start: 1, text: "  " }]).length === 1, "timed cues need start+text");
assert(isImplausibleReset(40, 0), "stale player at 0 is not a real seek");
assert(!isImplausibleReset(0.2, 0), "opening seconds are not a reset");
assert(!isImplausibleReset(40, 41), "normal advance is not a reset");
const horizonFirst = pickLookaheadCues(many, 0.1, spokenAhead, { maxCues: 8, maxSeconds: 5 });
assert(horizonFirst.length === 3, "horizon can stop before cue count");
ahead.forEach((h) => spokenAhead.add(h.key));
const again = pickLookaheadCues(many, 0.1, spokenAhead);
assert(again.length === 0, "already queued cues are skipped");
assert(!isSeekJump(0.2, 1.8), "small forward step is not seek");
assert(isSeekJump(10, 1), "seek backward");
assert(isSeekJump(2, 40), "seek forward jump");
assert(isSeekJump(8, 8.1, { paused: true }) === false, "tiny pause drift is not seek");
assert(isSeekJump(8, 12, { paused: true }), "paused scrub is seek");
assert(!isSeekJump(10, 15.2, { audioChunk: true }), "audio chunk advance is not seek");
const spokenSeek = new Set(many.slice(0, 8).map((c) => cueKey(c)));
pruneSpokenOnSeek(many, spokenSeek, 40);
assert(spokenSeek.has(cueKey(many[0])), "past spoken keys remain");
assert(spokenSeek.size === 8, "seek forward does not revive past cues");
pruneSpokenOnSeek(many, spokenSeek, 2);
assert(!spokenSeek.has(cueKey(many[3])), "seek back allows re-queue of upcoming cues");

assert(joinSegmentText([{ text: " a " }, { text: "b" }]) === "a b", "join segs");
assert(cueKey({ start: 1.2, text: "hi" }).startsWith("1.20|"), "cue key");

const caps = linesToCaptions([
  { start: 1.2, src: "hello", zh: "你好" },
  { start: 4, src: "world", zh: "世界" },
]);
assert(caps.status === "ready", "caps ready");
assert(caps.source === "interpret", "source");
assert(caps.text.includes("[0:01] 你好"), "zh cue " + caps.text);
assert(caps.cues[0].src === "hello", "keep src");

assert(await voiceRefFromBlob(null) === null, "empty voice ref");
assert(await voiceRefFromBlob(new Blob([new Uint8Array(8)], { type: "audio/wav" })) === null, "quiet clip is not a voice ref");
{
  const wav = new Blob([new Uint8Array(2000)], { type: "audio/wav" });
  assert(await voiceRefFromBlob(wav) === wav, "loud wav is reused as voice ref");
}

{
  const a = { start: 0, end: 4, blob: "old" };
  const b = { start: 4, end: 8, blob: "new" };
  assert(voiceRefForTime([a, b], 0.2, "fb") === "old", "cover opening cue");
  assert(voiceRefForTime([a, b], 5, "fb") === "new", "cover later cue");
  assert(voiceRefForTime([a, b], 40, "fb") === "fb", "fallback when no overlap");
  assert(voiceRefForTime([a, b], 4.1, "fb") === "new", "later overlapping slice wins");
}

assert(captionsForInterpret([{ start: 1, text: "hi" }]).length === 0, "default ignores captions");
assert(captionsForInterpret([{ start: 1, text: "hi" }], true).length === 1, "use captions");
assert(captionsForInterpret([{ start: 1, text: "hi" }], false).length === 0, "ignore captions");

console.log("ok interpret");
