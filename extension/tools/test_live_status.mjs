import assert from "node:assert/strict";
import {
  charsPerSecond,
  formatLiveElapsed,
  liveLines,
  noteLiveSample,
  runningToolName,
} from "../sidepanel/live-status.js";

assert.equal(runningToolName([{ kind: "meta", name: "读页", status: "running" }, { name: "read_page", status: "ok" }]), "");
assert.equal(runningToolName([{ name: "read_page", status: "ok" }, { name: "click", status: "running" }]), "click");

let samples = noteLiveSample([], 0, 1000);
samples = noteLiveSample(samples, 0, 1200);
assert.equal(samples.length, 1, "same count inside the sample gap stays one point");
samples = noteLiveSample(samples, 40, 1600);
assert.equal(charsPerSecond(samples, 1600), 67);

assert.equal(formatLiveElapsed(1500), "1.5s");
assert.equal(formatLiveElapsed(12_400), "12s");

const waiting = liveLines({ phase: "waiting", elapsedMs: 800, chars: 0, charsPerSec: null, showDots: true });
assert.equal(waiting.phase, "等待模型");
assert.equal(waiting.pace, "0.8s");
assert.equal(waiting.showDots, true);
assert.equal(waiting.speed, "还没有输出");

const writing = liveLines({ phase: "writing", elapsedMs: 3000, chars: 120, charsPerSec: 40, showDots: false });
assert.equal(writing.phase, "正在写");
assert.equal(writing.pace, "40 字/秒");
assert.equal(writing.showDots, false);
assert.equal(writing.chars, "120 字");

const tool = liveLines({ phase: "tool", toolName: "read_page", elapsedMs: 2000, chars: 10, charsPerSec: null, showDots: false });
assert.equal(tool.phase, "正在调用 read_page");
assert.equal(tool.showTool, true);

console.log("PASS live status");
