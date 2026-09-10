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
