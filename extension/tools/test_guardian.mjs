import {
  saveArtifact,
  getArtifact,
  readArtifactPage,
  searchArtifacts,
  deleteSessionArtifacts,
  clearAllMemoryArtifacts,
} from "../lib/agent/artifact-store.js";
import {
  interceptToolOutput,
  parseHandleFromText,
  DEFAULT_ARCHIVE_THRESHOLD,
} from "../lib/agent/tool-guardian.js";
import {
  compressMessages,
  microCompactMessages,
  safeSessionCut,
  formatToolResultStub,
  extractHandle,
  CHAR_BUDGET,
} from "../lib/agent/context.js";
import { createAgentLoop } from "../lib/agent/loop.js";

function assert(cond, msg) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}

console.log("--- 1. Testing ArtifactStore ---");
clearAllMemoryArtifacts();

const testLongText = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: Some interesting data for item_${i + 1}, secret key is XYZ_${i * 7}`).join("\n");
const manifest = await saveArtifact({
  sessionId: "sess_test",
  toolName: "extract_page",
  content: testLongText,
  pageSizeChars: 1000,
});

assert(manifest.handle.startsWith("art_"), "valid handle format");
assert(manifest.totalPages >= 5, "totalPages calculated: " + manifest.totalPages);
assert(manifest.totalChars === testLongText.length, "totalChars correct");

const fetched = await getArtifact(manifest.handle, "sess_test");
assert(fetched && fetched.content === testLongText, "getArtifact content match");

// Test readArtifactPage
const page1 = await readArtifactPage({ handle: manifest.handle, page: 1, sessionId: "sess_test" });
assert(page1.ok && page1.page === 1 && page1.hasNext, "read page 1 ok");
assert(page1.content.startsWith("Line 1:"), "page 1 starts at beginning");

const page2 = await readArtifactPage({ handle: manifest.handle, page: 2, sessionId: "sess_test" });
assert(page2.ok && page2.page === 2, "read page 2 ok");

// Test searchArtifacts with handle
const searchRes1 = await searchArtifacts({
  query: "XYZ_700",
  handle: manifest.handle,
  sessionId: "sess_test",
});
assert(searchRes1.ok && searchRes1.matches.length === 1, "search found XYZ_700");
assert(searchRes1.matches[0].lineStart === 101, "correct lineStart for XYZ_700 (101): " + searchRes1.matches[0].lineStart);
assert(searchRes1.matches[0].preview.includes("XYZ_700"), "preview includes keyword");

// Test searchArtifacts with regex
const searchRegex = await searchArtifacts({
  query: "secret key is XYZ_\\d+",
  handle: manifest.handle,
  sessionId: "sess_test",
  maxMatches: 3,
});
assert(searchRegex.ok && searchRegex.matches.length === 3, "regex search matches cap");
assert(searchRegex.hasMore === true, "regex hasMore flag set");

// Test global search across session without handle
const searchGlobal = await searchArtifacts({
  query: "XYZ_1400",
  sessionId: "sess_test",
});
assert(searchGlobal.ok && searchGlobal.matches.length === 1, "global search found item");
assert(searchGlobal.matches[0].handle === manifest.handle, "matched handle matches");

console.log("PASS: ArtifactStore");

console.log("--- 2. Testing ToolOutputGuardian ---");

// Short content should NOT be intercepted
const shortOutput = await interceptToolOutput({
  sessionId: "sess_test",
  toolName: "get_page_info",
  content: "Short title and url",
  threshold: 1000,
});
assert(!shortOutput.intercepted, "short output not intercepted");
assert(shortOutput.content === "Short title and url", "short content preserved");

// Skip tool should NOT be intercepted
const skipOutput = await interceptToolOutput({
  sessionId: "sess_test",
  toolName: "search_tool_artifact",
  content: "x".repeat(3000),
  threshold: 1000,
});
assert(!skipOutput.intercepted, "search_tool_artifact skipped");

// Long content SHOULD be intercepted
const longContent = "关键信息: 优惠券码 COUPON999\n" + "无用正文填充... ".repeat(400);
const intercepted = await interceptToolOutput({
  sessionId: "sess_test",
  toolName: "extract_page",
  content: longContent,
  threshold: 1000,
});
assert(intercepted.intercepted === true, "long output intercepted");
assert(intercepted.handle.startsWith("art_"), "handle returned");
assert(intercepted.content.includes("【工具结果 · 已归档为分页本地文档】"), "preview template formatted");
assert(intercepted.content.includes(intercepted.handle), "preview includes handle");

const parsedHandle = parseHandleFromText(intercepted.content);
assert(parsedHandle === intercepted.handle, "parseHandleFromText extracted: " + parsedHandle);

console.log("PASS: ToolOutputGuardian");

console.log("--- 3. Testing Context Micro-Compact & Safe Session Cut ---");

const stub = formatToolResultStub("extract_page", "art_s1_test");
assert(stub.includes("extract_page") && stub.includes("ref=art_s1_test"), "formatToolResultStub ok: " + stub);
assert(extractHandle(stub) === "art_s1_test", "extractHandle from stub ok");

// Test Safe Session Cut on a 16-turn conversation
const longConversation = [
  { role: "user", content: "请帮我分析这份文档的几个核心问题（初始意图必须保留）" },
  { role: "assistant", content: "好的，我先读取页面", tool_calls: [{ id: "c1", type: "function", function: { name: "extract_page", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: stub },
  { role: "assistant", content: "看到了页面概况" },
  { role: "user", content: "深入看第二章" },
  { role: "assistant", content: "查询第二章中", tool_calls: [{ id: "c2", type: "function", function: { name: "search_tool_artifact", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c2", content: "第二章要点..." },
  { role: "assistant", content: "第二章分析完毕" },
  { role: "user", content: "深入看第三章" },
  { role: "assistant", content: "查询第三章", tool_calls: [{ id: "c3", type: "function", function: { name: "search_tool_artifact", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c3", content: "第三章要点..." },
  { role: "assistant", content: "第三章分析完毕" },
  { role: "user", content: "第四章呢" },
  { role: "assistant", content: "查询第四章", tool_calls: [{ id: "c4", type: "function", function: { name: "search_tool_artifact", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c4", content: "第四章要点..." },
  { role: "assistant", content: "第四章也完成了" },
  { role: "user", content: "最后请做总结" },
];

const cut = safeSessionCut(longConversation, 150, 4);
assert(cut[0].content.includes("初始意图必须保留"), "First user query preserved!");
assert(cut.at(-1).content === "最后请做总结", "Tail user message preserved!");
assert(cut.some((m) => m.content.includes("系统提示：为优化上下文窗口")), "Bridge notice present");

console.log("PASS: Context upgrades");

console.log("--- 4. Testing End-to-End Loop with Guardian and Search ---");

let archivedEvents = [];
const mockLongPageText = "首段介绍...\n" + "中间段落...\n".repeat(200) + "重要数据: 订单总额 99998888 元\n" + "尾部段落...\n".repeat(200);

const loop = createAgentLoop({
  sessionId: "sess_e2e",
  charBudget: 10000,
  toolArchiveThreshold: 1000,
  tools: [
    {
      name: "extract_page",
      description: "抽取页面",
      parameters: { type: "object", properties: {} },
      async execute() {
        return mockLongPageText;
      },
    },
    {
      name: "search_tool_artifact",
      description: "搜索归档内容",
      parameters: { type: "object", properties: { query: { type: "string" }, handle: { type: "string" } }, required: ["query"] },
      async execute(args) {
        return JSON.stringify(await searchArtifacts({ query: args.query, handle: args.handle, sessionId: "sess_e2e" }));
      },
    },
  ],
  model: {
    async runTurn({ messages }) {
      const last = messages[messages.length - 1];
      // Turn 1: Model asks to extract_page
      if (last.role === "user") {
        return {
          content: "",
          toolCalls: [{ id: "call_ext", name: "extract_page", arguments: "{}" }],
          finishReason: "tool_calls",
        };
      }
      // Turn 2: Model receives intercepted tool preview with handle, searches for keyword
      if (last.role === "tool" && last.tool_call_id === "call_ext") {
        const handle = parseHandleFromText(last.content);
        return {
          content: "输出过长已被拦截，我来检索订单总额",
          toolCalls: [{ id: "call_srch", name: "search_tool_artifact", arguments: JSON.stringify({ query: "订单总额", handle }) }],
          finishReason: "tool_calls",
        };
      }
      // Turn 3: Model receives search match snippet and answers
      if (last.role === "tool" && last.tool_call_id === "call_srch") {
        const parsed = JSON.parse(last.content);
        const snippet = parsed.matches?.[0]?.preview || "";
        return {
          content: `找到结果了：${snippet}`,
          toolCalls: [],
          finishReason: "stop",
        };
      }
      return { content: "完成", toolCalls: [] };
    },
  },
});

const runResult = await loop.run("请提取这页的订单总额", {
  sessionId: "sess_e2e",
  onEvent: (ev) => {
    if (ev.type === "tool_archived") {
      archivedEvents.push(ev);
    }
  },
});

assert(archivedEvents.length === 1, "tool_archived event fired once");
assert(archivedEvents[0].name === "extract_page", "archived tool name is extract_page");
assert(archivedEvents[0].originalLength > 2000, "original length tracked");
assert(runResult.reason === "stop", "loop ended cleanly with stop");
assert(runResult.text.includes("订单总额 99998888 元"), "model successfully retrieved keyword snippet: " + runResult.text);

// Clean up test session
await deleteSessionArtifacts("sess_e2e");
await deleteSessionArtifacts("sess_test");

console.log("PASS: End-to-End Loop with Guardian and Search");
console.log("ALL GUARDIAN & ARTIFACT TESTS PASSED!");
