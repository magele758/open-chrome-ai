import {
  chineseRatio,
  cleanTranslation,
  cueKey,
  joinSegmentText,
  linesToCaptions,
  pickLiveCue,
  shouldTranslate,
  withCueEnds,
} from "../lib/interpret.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(chineseRatio("hello world") < 0.1, "en ratio");
assert(chineseRatio("这是中文句子") > 0.8, "zh ratio");
assert(shouldTranslate("The model is trained on video."), "translate en");
assert(!shouldTranslate("这个模型在视频上训练。"), "skip zh");

assert(cleanTranslation("译文：你好世界", "x") === "你好世界", "strip prefix");
assert(cleanTranslation("「你好」", "x") === "你好", "strip quotes");
assert(cleanTranslation("```\nhello\n```", "x") === "hello", "strip fence");
assert(cleanTranslation("", "fallback") === "fallback", "fallback");

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

console.log("ok interpret");
