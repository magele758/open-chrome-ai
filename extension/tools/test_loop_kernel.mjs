import assert from "node:assert/strict";
import { createKernelAgentLoop, LOOP_ENGINE_ID, resolveMaxTurns, MAX_TURNS } from "../lib/agent/loop-kernel.js";
import { createAgentLoop } from "../lib/agent/loop.js";

const events = [];
const loop = createKernelAgentLoop({
  maxTurns: 4,
  systemPrompt: "test",
  tools: [
    {
      name: "extract_page",
      description: "extract",
      parameters: { type: "object", properties: {} },
      execute: async () => "PAGE_OK",
    },
  ],
  model: {
    async runTurn({ messages }) {
      const last = messages[messages.length - 1];
      if (last.role === "tool" || (last.role === "user" && String(last.content).includes("PAGE_OK"))) {
        return { content: `FINAL:${String(last.content).includes("PAGE_OK") ? "PAGE_OK" : last.content}`, toolCalls: [], finishReason: "stop" };
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "extract_page", arguments: "{}" }],
      };
    },
  },
});

const out = await loop.run("总结此页", {
  onEvent: (ev) => events.push(ev.type + (ev.name ? `:${ev.name}` : "")),
});

assert.equal(out.engine, LOOP_ENGINE_ID);
assert.equal(out.reason, "stop");
assert.match(out.text, /FINAL:PAGE_OK/);
assert.ok(events.includes("tools_done:extract_page"));
console.log("PASS kernel basic tool then answer", out.reason, events.filter((e) => e.startsWith("tools_")));

const deltas = [];
const emptyTools = createKernelAgentLoop({
  maxTurns: 2,
  systemPrompt: "test",
  tools: undefined,
  model: {
    async runTurn({ onTextDelta, tools }) {
      if (tools && tools.length) throw new Error("expected no tools");
      onTextDelta?.("直出");
      return { content: "直出", toolCalls: [], finishReason: "stop" };
    },
  },
});
const plain = await emptyTools.run("你好", { onTextDelta: (d) => deltas.push(d) });
assert.equal(plain.reason, "stop");
assert.equal(plain.text, "直出");
assert.equal(deltas.join(""), "直出");
console.log("PASS kernel plain text");

let executions = 0;
let modelCalls = 0;
const boundaryEvents = [];
const boundary = createKernelAgentLoop({
  maxTurns: 3,
  systemPrompt: "Summarize the page.",
  tools: [{ name: "extract_page", execute: async () => { executions += 1; return `ARTICLE_EVIDENCE_${executions}`; } }],
  model: {
    async runTurn({ messages, tools }) {
      modelCalls += 1;
      if (modelCalls < 3) {
        return { content: "Looking for more.", toolCalls: [{ id: `b${modelCalls}`, name: "extract_page", arguments: "{}" }] };
      }
      assert.equal(tools.length, 0);
      assert.ok(messages.every((m) => m.role !== "tool" && !m.tool_calls));
      assert.ok(messages.some((m) => String(m.content).includes("ARTICLE_EVIDENCE_2")));
      assert.match(messages.at(-1).content, /最后一轮/);
      return { content: "Summary from the available evidence.", usage: { promptTokens: 10, completionTokens: 5 } };
    },
  },
});
const bounded = await boundary.run("Summarize", { onEvent: (e) => boundaryEvents.push(e) });
assert.equal(modelCalls, 3);
assert.equal(executions, 2);
assert.equal(bounded.reason, "max_turns");
assert.equal(bounded.text, "Summary from the available evidence.");
assert.equal(bounded.metrics.totalTokens, 15);
assert.equal(bounded.history.at(-1).content, bounded.text);
assert.equal(boundaryEvents.at(-1).done, true);
console.log("PASS kernel last-turn reservation");

for (const broken of [{ content: "", toolCalls: [] }, { content: "I will keep searching.", toolCalls: [{ name: "extract_page", arguments: "{}" }] }]) {
  const forced = await createKernelAgentLoop({
    maxTurns: 1,
    systemPrompt: "test",
    tools: [{ name: "extract_page", execute: () => { throw new Error("must not run"); } }],
    model: { runTurn: async () => broken },
  }).run("summarize");
  assert.match(forced.text, /尚未得到可交付的完整回答/);
  assert.equal(forced.history.at(-1).tool_calls, undefined);
  assert.equal(forced.traceSteps.some((s) => s.type === "tool_exec"), false);
}
console.log("PASS kernel last-turn fallback copy");

const abort = new AbortController();
abort.abort();
const stopped = await boundary.run("stop", { signal: abort.signal });
assert.equal(stopped.reason, "abort");
assert.equal(modelCalls, 3);
console.log("PASS kernel abort");

assert.equal(resolveMaxTurns(), MAX_TURNS);
assert.equal(resolveMaxTurns(0), Infinity);

let uncappedCalls = 0;
const uncapped = createKernelAgentLoop({
  maxTurns: 0,
  systemPrompt: "test",
  tools: [{ name: "extract_page", execute: async () => "OK" }],
  model: {
    async runTurn({ tools }) {
      uncappedCalls += 1;
      if (uncappedCalls < 15) {
        assert.ok(tools.length, "unlimited must keep tools open");
        return { content: "", toolCalls: [{ id: `u${uncappedCalls}`, name: "extract_page", arguments: "{}" }] };
      }
      return { content: "done after 15", toolCalls: [] };
    },
  },
});
const free = await uncapped.run("go");
assert.equal(free.reason, "stop");
assert.equal(free.text, "done after 15");
assert.equal(uncappedCalls, 15);
console.log("PASS kernel unlimited turns");

let repeatExec = 0;
let repeatTurns = 0;
const repeater = createKernelAgentLoop({
  maxTurns: 0,
  systemPrompt: "test",
  tools: [{ name: "extract_page", execute: async () => { repeatExec += 1; return "PAGE"; } }],
  model: {
    async runTurn() {
      repeatTurns += 1;
      if (repeatTurns >= 4) return { content: "done", toolCalls: [] };
      return { content: "", toolCalls: [{ id: `r${repeatTurns}`, name: "extract_page", arguments: "{}" }] };
    },
  },
});
const repeated = await repeater.run("again");
assert.equal(repeatExec, 2, "third identical call must not execute");
assert.equal(repeated.history.filter((m) => m.role === "tool" && /重复/.test(m.content || "")).length, 1);
console.log("PASS kernel repeat tool-call circuit breaker");

let openTurns = 0;
let sawForcedClose = false;
const opener = createKernelAgentLoop({
  maxTurns: 0,
  systemPrompt: "test",
  tools: [{ name: "run_shell", execute: async () => { throw new Error("open must not run"); } }],
  model: {
    async runTurn({ tools }) {
      openTurns += 1;
      if (openTurns >= 4) {
        assert.equal(tools.length, 0, "blocked shell streak must close tools");
        sawForcedClose = true;
        return { content: "ok I will stop", toolCalls: [] };
      }
      return { content: "", toolCalls: [{ id: `o${openTurns}`, name: "run_shell", arguments: JSON.stringify({ command: `open /tmp/dir${openTurns}` }) }] };
    },
  },
});
const opened = await opener.run("看一下目录");
assert.equal(sawForcedClose, true);
assert.ok(opened.history.filter((m) => m.role === "tool" && /已拦截/.test(m.content || "")).length >= 3);
console.log("PASS kernel blocked open streak");

let hitlDenied = 0;
let hitlTurns = 0;
const hitl = createKernelAgentLoop({
  maxTurns: 3,
  systemPrompt: "test",
  tools: [{ name: "run_shell", execute: async () => { throw new Error("must not run after deny"); } }],
  interceptToolCall: async () => {
    hitlDenied += 1;
    return { allow: false, reason: "[安全拦截] 用户拒绝" };
  },
  model: {
    async runTurn({ tools }) {
      hitlTurns += 1;
      if (!tools.length || hitlTurns >= 2) return { content: "已按拦截结果作答", toolCalls: [] };
      return { content: "", toolCalls: [{ id: "h1", name: "run_shell", arguments: JSON.stringify({ command: "ls" }) }] };
    },
  },
});
const blocked = await hitl.run("列目录");
assert.equal(hitlDenied, 1);
assert.equal(blocked.traceSteps.some((s) => s.type === "tool_exec"), false);
assert.ok(blocked.history.some((m) => m.role === "tool" && /拦截|拒绝/.test(m.content || "")));
assert.match(blocked.text, /作答/);
console.log("PASS kernel HITL intercept stays on chrome host");

const seenTools = [];
const named = createKernelAgentLoop({
  maxTurns: 2,
  systemPrompt: "test",
  tools: [
    { name: "extract_page", execute: async () => "PAGE" },
    { name: "run_shell", execute: async () => "SHELL" },
  ],
  model: {
    async runTurn({ tools }) {
      seenTools.push((tools || []).map((t) => t.function?.name || t.name));
      if (seenTools.length === 1) {
        return { content: "", toolCalls: [{ id: "n1", name: "extract_page", arguments: "{}" }] };
      }
      return { content: "ok", toolCalls: [] };
    },
  },
});
const namedOut = await named.run("总结");
assert.deepEqual(seenTools[0].sort(), ["extract_page", "run_shell"]);
assert.equal(namedOut.text, "ok");
assert.ok(!JSON.stringify(seenTools).includes("bash"));
assert.ok(!JSON.stringify(seenTools).includes("browser_"));
console.log("PASS kernel exposes only chrome host tools");

const distillStillWorks = createAgentLoop({
  maxTurns: 1,
  systemPrompt: "test",
  tools: [],
  model: { async runTurn() { return { content: "legacy", toolCalls: [] }; } },
});
const legacy = await distillStillWorks.run("hi");
assert.equal(legacy.text, "legacy");
assert.equal(legacy.engine, undefined);
console.log("PASS original distill loop still available");

// Empty replies: SDK retries with a [recovery] note that must reach the model,
// and recovers without surfacing an error once the model answers.
{
  const seen = [];
  const recovering = createKernelAgentLoop({
    maxTurns: 4, systemPrompt: "test", tools: [{ name: "noop", description: "noop", parameters: { type: "object", properties: {} }, execute: async () => "" }],
    model: { async runTurn({ messages }) {
      seen.push(messages);
      return seen.length < 3 ? { content: "", toolCalls: [], finishReason: "stop" } : { content: "OK_AFTER_RETRY", toolCalls: [], finishReason: "stop" };
    } },
  });
  const recovered = await recovering.run("hi");
  assert.equal(recovered.text, "OK_AFTER_RETRY");
  assert.equal(recovered.reason, "stop");
  assert.ok(!seen[0].some((m) => /\[recovery\]/.test(String(m.content))));
  const last = seen[1][seen[1].length - 1];
  assert.equal(last.role, "user");
  assert.match(last.content, /^\[recovery\]/);
  assert.ok(!seen[2].some((m) => m.role === "assistant" && !m.content), "empty assistant rows are not replayed");
  assert.ok(!recovered.history.some((m) => /\[recovery\]/.test(String(m.content))), "nudges are not persisted into chat history");

  let calls = 0;
  const dead = await createKernelAgentLoop({
    maxTurns: 6, systemPrompt: "test", tools: [],
    model: { async runTurn() { calls++; return { content: "", toolCalls: [], finishReason: "stop" }; } },
  }).run("hi");
  assert.equal(dead.reason, "empty_assistant");
  assert.equal(dead.text, "");
  assert.equal(calls, 3, "one call plus two automatic retries");
  console.log("PASS empty-reply recovery reaches the model and ends as empty_assistant");
}
