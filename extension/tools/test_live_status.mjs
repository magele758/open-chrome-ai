import assert from "node:assert/strict";
import {
  estimateLiveTokens,
  finishLiveModelTurn,
  formatLiveElapsed,
  liveLines,
  liveModelOutput,
  noteLiveModelOutput,
  noteLiveSample,
  runningToolName,
  startLiveModelTurn,
  tokensPerSecond,
} from "../sidepanel/live-status.js";

assert.equal(runningToolName([{ kind: "meta", name: "读页", status: "running" }, { name: "read_page", status: "ok" }]), "");
assert.equal(runningToolName([{ name: "read_page", status: "ok" }, { name: "click", status: "running" }]), "click");

assert.equal(estimateLiveTokens({ answer: "…", thinking: "" }), 0, "the placeholder is not model output");
assert.equal(estimateLiveTokens({ answer: "hello world", thinking: "你好世界" }), 8);

let samples = noteLiveSample([], 10, 1000);
samples = noteLiveSample(samples, 10, 1500);
assert.equal(samples.length, 1, "unchanged Token totals don't add a speed sample");
samples = noteLiveSample(samples, 40, 1600);
assert.equal(tokensPerSecond(samples, 1600), 50);
assert.equal(tokensPerSecond(samples, 4500), null, "stale bursts are not shown as live speed");
assert.equal(tokensPerSecond(noteLiveSample(samples, 2, 1700), 1700), null, "a new turn restarts the sample when the previous text is cleared");

assert.equal(formatLiveElapsed(1500), "1.5s");
assert.equal(formatLiveElapsed(12_400), "12s");

const waiting = liveLines({ phase: "waiting", elapsedMs: 38_000, tokens: 0, tokensPerSec: null, showDots: true });
assert.equal(waiting.phase, "等待模型");
assert.equal(waiting.pace, "38s");
assert.equal(waiting.showDots, true);
assert.equal(waiting.speed, "还没有输出");
assert.equal(waiting.tokens, "0 Token");

const writing = liveLines({ phase: "writing", elapsedMs: 3000, tokens: 120, tokensPerSec: 40, showDots: false });
assert.equal(writing.phase, "正在写");
assert.equal(writing.pace, "≈40 Token/秒");
assert.equal(writing.speed, "≈40 Token/秒");
assert.equal(writing.showDots, false);
assert.equal(writing.tokens, "≈120 Token");

const thinking = liveLines({ phase: "thinking", elapsedMs: 2000, tokens: 10, tokensPerSec: 5 });
assert.equal(thinking.pace, "≈5 Token/秒");

const tool = liveLines({ phase: "tool", toolName: "read_page", elapsedMs: 2000, tokens: 10, tokensPerSec: 5 });
assert.equal(tool.phase, "正在调用 read_page");
assert.equal(tool.showTool, true);
assert.equal(tool.pace, "2.0s");
assert.equal(tool.speed, "—");

const callOnly = { text: "…" };
startLiveModelTurn(callOnly);
noteLiveModelOutput(callOnly, "calling", 8, 30_000);
const firstChunk = liveLines({ ...liveModelOutput(callOnly, 30_000), elapsedMs: 30_000 });
assert.equal(firstChunk.tokens, "≈8 Token");
assert.equal(firstChunk.speed, "—", "a first chunk alone cannot measure generation speed");

noteLiveModelOutput(callOnly, "calling", 28, 31_000);
const generating = liveLines({ ...liveModelOutput(callOnly, 31_000), elapsedMs: 31_000 });
assert.equal(generating.phase, "正在生成工具调用");
assert.equal(generating.tokens, "≈28 Token");
assert.equal(generating.speed, "≈20 Token/秒");

finishLiveModelTurn(callOnly, { tokens: 24, durationMs: 32_000, estimated: false });
const executing = liveLines({ ...liveModelOutput(callOnly, 33_000), phase: "tool", toolName: "open_tab", elapsedMs: 33_000 });
assert.equal(executing.phase, "正在调用 open_tab");
assert.equal(executing.tokens, "24 Token", "provider usage replaces the provisional tool-call estimate");
assert.equal(executing.speed, "上轮生成 ≈20 Token/秒", "generation speed excludes time before the first and after the last output chunks");

startLiveModelTurn(callOnly);
const waitingAfterCall = liveLines({ ...liveModelOutput(callOnly, 34_000), elapsedMs: 34_000 });
assert.equal(waitingAfterCall.phase, "等待模型");
assert.equal(waitingAfterCall.tokens, "24 Token");
assert.equal(waitingAfterCall.pace, "34s · 上轮生成 ≈20 Token/秒");

noteLiveModelOutput(callOnly, "thinking", "思考", 35_000);
noteLiveModelOutput(callOnly, "writing", "回答", 36_000);
finishLiveModelTurn(callOnly, { tokens: 6, durationMs: 2_000, estimated: true });
const mixed = liveLines({ ...liveModelOutput(callOnly, 36_000), elapsedMs: 36_000 });
assert.equal(mixed.tokens, "≈30 Token");
assert.equal(mixed.speed, "上轮生成 ≈2 Token/秒");

const buffered = {};
startLiveModelTurn(buffered);
noteLiveModelOutput(buffered, "calling", 28, 31_000);
noteLiveModelOutput(buffered, "calling", 29, 31_000);
finishLiveModelTurn(buffered, { tokens: 24, durationMs: 32_000, estimated: false });
const bufferedLines = liveLines({ ...liveModelOutput(buffered, 32_000), elapsedMs: 32_000 });
assert.equal(bufferedLines.tokens, "24 Token");
assert.equal(bufferedLines.speed, "上轮整轮平均 0.8 Token/秒", "a buffered burst only gives a whole-round average");

const longTurn = {};
startLiveModelTurn(longTurn);
noteLiveModelOutput(longTurn, "calling", 10, 10_000);
noteLiveModelOutput(longTurn, "calling", 20, 14_000);
noteLiveModelOutput(longTurn, "calling", 40, 15_000);
const liveLongTurn = liveLines({ ...liveModelOutput(longTurn, 15_000), elapsedMs: 15_000 });
assert.equal(liveLongTurn.speed, "≈20 Token/秒", "live speed uses the recent samples");
finishLiveModelTurn(longTurn, { tokens: 40, durationMs: 17_000, estimated: true });
const finishedLongTurn = liveLines({ ...liveModelOutput(longTurn, 17_000), elapsedMs: 17_000 });
assert.equal(finishedLongTurn.speed, "上轮生成 ≈6 Token/秒", "the round remembers its first output beyond the live window");

console.log("PASS live status");
