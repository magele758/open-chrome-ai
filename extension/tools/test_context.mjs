import {
  CHAR_BUDGET,
  compressMessages,
  isResumableRun,
  messageChars,
  packForModel,
  repairMessages,
  stringifyContent,
} from "../lib/agent/context.js";
import { createAgentLoop } from "../lib/agent/loop.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(stringifyContent([{ type: "text", text: "hi" }, { type: "image_url" }]) === "hi【截图】", "stringify");

const broken = repairMessages(
  [
    { role: "system", content: "x" },
    { role: "user", content: "问" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "extract_page", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "orphan", content: "nope" },
    { role: "assistant", content: "" },
  ],
  { completePending: true },
);
assert(broken.messages[0].role === "user", "drop system");
assert(broken.messages[1].tool_calls[0].id.startsWith("call_repair_"), "id filled");
assert(broken.messages[2].role === "tool" && /已修补/.test(broken.messages[2].content), "stub missing tool");
assert(!broken.messages.some((m) => m.tool_call_id === "orphan"), "drop orphan");
assert(!broken.messages.some((m) => m.role === "assistant" && !m.content && !m.tool_calls), "drop empty assistant");
assert(broken.pending.length === 0, "completePending cleared");

const open = repairMessages(
  [
    { role: "user", content: "问" },
    {
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "extract_page", arguments: "{}" } }],
    },
  ],
  { completePending: false },
);
assert(open.pending.length === 1 && open.pending[0].id === "c1", "pending kept");
assert(open.messages.at(-1).role === "assistant", "no stub yet");

const long = "正文".repeat(3000);
const bulky = [
  { role: "user", content: "先看这页" },
  { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "extract_page", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "t1", content: long },
  { role: "assistant", content: "第一轮结论" },
  { role: "user", content: "再看" },
  { role: "assistant", content: "", tool_calls: [{ id: "t2", type: "function", function: { name: "extract_page", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "t2", content: long },
  { role: "user", content: "现在呢" },
];
const compact = compressMessages(bulky, 4000, 3);
assert(compact.compressed, "did compress");
assert(compact.after < compact.before, "smaller");
assert(compact.messages.at(-1).content === "现在呢", "keep tail user");
assert(compact.messages[2].content.length < long.length, "old tool shrunk");
assert(compact.messages[1].tool_calls[0].id === "t1", "keep tool_calls");

const packed = packForModel(
  [
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "extract_page", arguments: "{}" } }] },
  ],
  { budget: CHAR_BUDGET },
);
assert(packed.messages.at(-1).role === "tool", "pack stubs before model");

assert(
  isResumableRun({
    status: "running",
    startedAt: Date.now(),
    history: [
      { role: "user", content: "问" },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "extract_page", arguments: "{}" } }] },
    ],
  }),
  "resumable pending",
);
assert(
  !isResumableRun({
    status: "running",
    startedAt: Date.now(),
    history: [
      { role: "user", content: "问" },
      { role: "assistant", content: "答完了" },
    ],
  }),
  "final assistant not resumable",
);
assert(
  !isResumableRun({
    status: "running",
    startedAt: Date.now() - 25 * 3600 * 1000,
    history: [{ role: "user", content: "问" }],
  }),
  "stale",
);

let executed = 0;
const events = [];
const loop = createAgentLoop({
  maxTurns: 4,
  systemPrompt: "test",
  charBudget: 2000,
  tools: [
    {
      name: "extract_page",
      description: "extract",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executed += 1;
        return "PAGE_OK";
      },
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

const resumed = await loop.run("", {
  resume: true,
  turnsUsed: 1,
  history: [
    { role: "user", content: "总结此页" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "extract_page", arguments: "{}" } }],
    },
  ],
  onEvent: (ev) => events.push(ev.type),
});
assert(resumed.reason === "stop" && resumed.text === "FINAL:PAGE_OK", "resume drain then answer");
assert(executed === 1, "pending tool ran once");
assert(events.includes("checkpoint"), "checkpoint");
assert(resumed.turnsUsed >= 2, "counted the follow-up model call");

let sawPackedShrink = false;
const prior = [{ role: "user", content: "old" }];
for (let i = 0; i < 6; i += 1) {
  prior.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: `x${i}`, type: "function", function: { name: "extract_page", arguments: "{}" } }],
  });
  prior.push({ role: "tool", tool_call_id: `x${i}`, content: "Z".repeat(2500) });
}
const loop2 = createAgentLoop({
  maxTurns: 2,
  systemPrompt: "t",
  charBudget: 3000,
  tools: [],
  model: {
    async runTurn({ messages }) {
      const blob = JSON.stringify(messages);
      if (blob.includes("已压缩")) sawPackedShrink = true;
      return { content: "OK", toolCalls: [], finishReason: "stop" };
    },
  },
});
const overBudget = await loop2.run("go", { history: prior });
assert(overBudget.reason === "stop" && overBudget.text === "OK", "still finishes");
assert(sawPackedShrink, "model saw compressed payload");
assert(messageChars(bulky) > 4000, "fixture is large");

console.log("PASS context");
