import { createAgentLoop } from "../lib/agent/loop.js";

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
