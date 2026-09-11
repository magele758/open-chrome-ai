import assert from "node:assert";
import {
  createAgentTools,
  resolveActiveTools,
  TOOL_DOMAINS,
} from "../lib/agent/tools.js";

const allTools = createAgentTools({
  getTabId: () => 1,
  getWindowId: () => 1,
  settings: {},
});

assert(allTools.length >= 50, "default returns all tools");

// 1. Reader only (pure summary / reading prompt)
const readerTools = resolveActiveTools({
  userText: "总结一下这篇文章的核心观点",
  tools: allTools,
  hasVideo: false,
});
const readerNames = readerTools.map((t) => t.name);
assert(readerNames.includes("extract_page"), "has extract_page");
assert(readerNames.includes("screenshot"), "has screenshot");
assert(readerNames.includes("request_toolsets"), "has request_toolsets meta-tool");
assert(!readerNames.includes("click"), "does not have click");
assert(!readerNames.includes("open_tab"), "does not have open_tab");
assert(!readerNames.includes("run_shell"), "does not have run_shell");
assert(readerTools.length <= 10, "reader tools count <= 10 (actual: " + readerTools.length + ")");

// 2. DOM interaction intent
const domTools = resolveActiveTools({
  userText: "点击登录按钮并在输入框填写用户名",
  tools: allTools,
  hasVideo: false,
});
const domNames = domTools.map((t) => t.name);
assert(domNames.includes("click"), "has click");
assert(domNames.includes("fill"), "has fill");
assert(domNames.includes("list_controls"), "has list_controls");
assert(!domNames.includes("open_tab"), "does not have open_tab");

// 3. Browser management intent
const tabTools = resolveActiveTools({
  userText: "把当前窗口的未激活标签全部关掉",
  tools: allTools,
  hasVideo: false,
});
const tabNames = tabTools.map((t) => t.name);
assert(tabNames.includes("close_tab"), "has close_tab");
assert(tabNames.includes("list_tabs"), "has list_tabs");
assert(!domNames.includes("run_shell"), "does not have run_shell");

// 4. System / Shell intent
const sysTools = resolveActiveTools({
  userText: "运行 shell 命令测试一下",
  tools: allTools,
  hasVideo: false,
});
const sysNames = sysTools.map((t) => t.name);
assert(sysNames.includes("run_shell"), "has run_shell");
assert(sysNames.includes("load_skill"), "has load_skill");

// 5. Video / Media intent
const videoTools = resolveActiveTools({
  userText: "这篇内容是什么",
  tools: allTools,
  hasVideo: true,
});
const videoNames = videoTools.map((t) => t.name);
assert(videoNames.includes("seek_video"), "has seek_video");
assert(videoNames.includes("get_captions"), "has get_captions");

// 6. Dynamic expansion via requestedDomains
const expanded = resolveActiveTools({
  userText: "纯阅读",
  tools: allTools,
  hasVideo: false,
  requestedDomains: ["dom_interact", "system_ops"],
});
const expNames = expanded.map((t) => t.name);
assert(expNames.includes("click"), "expanded has click");
assert(expNames.includes("run_shell"), "expanded has run_shell");

// 7. allTools flag
const full = resolveActiveTools({
  userText: "纯阅读",
  tools: allTools,
  allTools: true,
});
assert(full.length === allTools.length, "allTools returns all tools");

console.log("PASS test_tool_router.mjs");
