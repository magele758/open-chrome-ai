import { createAgentLoop, resolveMaxTurns, MAX_TURNS } from "../lib/agent/loop.js";

const events = [];
const loop = createAgentLoop({
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
      if (last.role === "tool") {
        return { content: `FINAL:${last.content}`, toolCalls: [], finishReason: "stop" };
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

const ok = out.reason === "stop" && out.text === "FINAL:PAGE_OK" && events.includes("tools_done:extract_page");
if (!ok) {
  console.log("FAIL", out, events);
  process.exit(1);
}

const deltas = [];
const emptyTools = createAgentLoop({
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
if (plain.reason !== "stop" || plain.text !== "直出" || deltas.join("") !== "直出") {
  console.log("FAIL plain", plain, deltas);
  process.exit(1);
}

console.log("PASS", out.reason, events);

// A tool-hungry model must spend the last allowed call answering with the
// previous tool result; it must never execute a new batch on that last call.
const assert = (await import('node:assert/strict')).default;
let executions = 0, modelCalls = 0;
const boundaryEvents = [];
const boundary = createAgentLoop({
  maxTurns: 3, systemPrompt: 'Summarize the page.',
  tools: [{ name: 'extract_page', execute: async () => { executions++; return `ARTICLE_EVIDENCE_${executions}`; } }],
  model: { async runTurn({ messages, tools }) {
    modelCalls++;
    if (modelCalls < 3) return { content: 'Looking for more.', toolCalls: [{ id: `b${modelCalls}`, name: 'extract_page', arguments: '{}' }] };
    assert.equal(tools.length, 0);
    assert.ok(messages.every(m => m.role !== 'tool' && !m.tool_calls));
    assert.ok(messages.some(m => String(m.content).includes('ARTICLE_EVIDENCE_2')));
    assert.match(messages.at(-1).content, /最后一轮/);
    return { content: 'Summary from the available evidence.', usage: { promptTokens: 10, completionTokens: 5 } };
  } },
});
const bounded = await boundary.run('Summarize', { onEvent: e => boundaryEvents.push(e) });
assert.equal(modelCalls, 3);
assert.equal(executions, 2);
assert.equal(bounded.reason, 'max_turns');
assert.equal(bounded.text, 'Summary from the available evidence.');
assert.equal(bounded.metrics.totalTokens, 15);
assert.equal(bounded.history.at(-1).content, bounded.text);
assert.equal(boundaryEvents.at(-1).done, true);
for (const broken of [{ content: '', toolCalls: [] }, { content: 'I will keep searching.', toolCalls: [{ name: 'extract_page', arguments: '{}' }] }]) {
  const forced = await createAgentLoop({ maxTurns: 1, systemPrompt: 'test', tools: [{ name: 'extract_page', execute: () => { throw new Error('must not run'); } }], model: { runTurn: async () => broken } }).run('summarize');
  assert.match(forced.text, /尚未得到可交付的完整回答/);
  assert.equal(forced.history.at(-1).tool_calls, undefined);
  assert.equal(forced.traceSteps.some(s => s.type === 'tool_exec'), false);
}
const abort = new AbortController();
abort.abort();
const stopped = await boundary.run('stop', { signal: abort.signal });
assert.equal(stopped.reason, 'abort');
assert.equal(modelCalls, 3);
console.log('PASS bounded final answer, malformed final output, and abort');

assert.equal(resolveMaxTurns(), MAX_TURNS);
assert.equal(resolveMaxTurns(12), 12);
assert.equal(resolveMaxTurns(0), Infinity);
assert.equal(resolveMaxTurns(-1), Infinity);
assert.equal(resolveMaxTurns(Infinity), Infinity);

let uncappedCalls = 0;
const uncapped = createAgentLoop({
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
assert.doesNotMatch(free.text, /轮次上限/);
console.log("PASS unlimited turns keep tools open");

let repeatExec = 0;
let repeatTurns = 0;
const repeater = createAgentLoop({
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
console.log("PASS repeat tool-call circuit breaker");

let openTurns = 0;
let sawForcedClose = false;
const opener = createAgentLoop({
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
console.log("PASS blocked open streak forces answer");

let lsExec = 0;
let lsTurns = 0;
const walker = createAgentLoop({
  maxTurns: 0,
  systemPrompt: "test",
  tools: [{ name: "run_shell", execute: async () => { lsExec += 1; return "ok"; } }],
  model: {
    async runTurn({ tools }) {
      lsTurns += 1;
      assert.ok(lsTurns < 20, "dir browse must not spin forever");
      if (!tools.length) return { content: "enough", toolCalls: [] };
      return { content: "", toolCalls: [{ id: `l${lsTurns}`, name: "run_shell", arguments: JSON.stringify({ command: `ls /tmp/p${lsTurns}` }) }] };
    },
  },
});
const walked = await walker.run("列目录");
assert.equal(lsExec, 8, "ninth distinct ls must not execute");
assert.ok(walked.history.some((m) => /列目录已/.test(m.content || "")));
console.log("PASS directory browse budget");
