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
console.log(ok ? "PASS" : "FAIL", out, events);
if (!ok) process.exit(1);
