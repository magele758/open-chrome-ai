/**
 * Execute PageLens chrome tools inside @ppeng/agent-loop, keeping distill policies.
 */

import { interceptToolOutput } from "./tool-guardian.js";
import {
  ARCHIVE_SEARCH_STREAK,
  BLOCKED_SHELL_STREAK,
  DIR_BROWSE_LIMIT,
  REPEAT_TOOL_LIMIT,
  SEARCH_SHELL_LIMIT,
  SIMILAR_SEARCH_LIMIT,
  countCodeSearchRuns,
  countCompletedToolRuns,
  countDirectoryBrowseRuns,
  countSimilarSearchRuns,
  isCodeSearchCommand,
  isDirectoryBrowseCommand,
  shellPolicyBlock,
} from "./shell-policy.js";
import { debugLog } from "../debug-log.js";
import { foldedToChromeHistory } from "./chrome-loop-codec.js";

const TOOL_RESULT_CHARS = 12000;

function listHostTools(host) {
  return Array.isArray(host.tools) ? host.tools : [];
}

function listAllTools(host) {
  return host.allTools || listHostTools(host);
}

function findTool(host, name) {
  return listHostTools(host).find((t) => t.name === name) || listAllTools(host).find((t) => t.name === name);
}

function emitToolsDone(onEvent, payload) {
  onEvent({
    type: "tools_done",
    name: payload.name,
    ok: payload.ok,
    args: payload.args || {},
    content: String(payload.content ?? "").slice(0, 4000),
    durationMs: payload.durationMs || 0,
    archived: /已归档为分页本地文档/.test(String(payload.content || "")),
  });
}

export function createChromeToolGate() {
  return { forceAnswer: false, blockedShell: 0, archivedSearch: 0 };
}

export async function executeChromeToolCalls({
  host,
  toolCalls,
  foldMessages,
  gate,
  sessionId,
  signal,
  onEvent,
  traceSteps,
  turn = 0,
}) {
  const history = foldedToChromeHistory(foldMessages);
  const results = [];
  for (const call of toolCalls || []) {
    if (signal?.aborted) {
      results.push({
        toolCallId: call.toolCallId,
        name: call.name,
        ok: false,
        content: "aborted",
      });
      continue;
    }
    const chromeCall = {
      id: call.toolCallId,
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}),
    };
    const tool = findTool(host, call.name);
    let ok = true;
    let content = "";
    let args = call.input && typeof call.input === "object" ? { ...call.input } : {};
    const t0 = Date.now();
    onEvent({ type: "tools_start", name: call.name, args });
    debugLog("agent.tool.start", { name: call.name, args });
    try {
      if (!tool) {
        ok = false;
        content = `unknown tool: ${call.name}`;
      } else {
        if (typeof host.interceptToolCall === "function") {
          const check = await host.interceptToolCall({ tool, args, call: chromeCall, signal });
          if (check && check.allow === false) {
            ok = false;
            content = check.reason || `[安全拦截] 用户拒绝或未授权执行工具: ${call.name}`;
            onEvent({ type: "tools_intercepted", name: call.name, args, reason: content });
            emitToolsDone(onEvent, { name: call.name, ok, args, content, durationMs: Date.now() - t0 });
            if (gate && call.name === "run_shell") {
              gate.blockedShell += 1;
              if (gate.blockedShell >= BLOCKED_SHELL_STREAK) gate.forceAnswer = true;
            }
            traceSteps.push({
              type: "tool_intercepted",
              turn,
              name: call.name,
              args,
              reason: content,
              durationMs: Date.now() - t0,
              timestamp: Date.now(),
            });
            results.push({ toolCallId: call.toolCallId, name: call.name, ok, content });
            continue;
          }
        }
        const prior = countCompletedToolRuns(history, call.name, chromeCall.arguments);
        const command = String(args?.command || "");
        const policy = call.name === "run_shell" ? shellPolicyBlock(command) : "";
        const dirUsed =
          call.name === "run_shell" && isDirectoryBrowseCommand(command) ? countDirectoryBrowseRuns(history) : 0;
        const searchUsed =
          call.name === "run_shell" && isCodeSearchCommand(command) ? countCodeSearchRuns(history) : 0;
        const similarSearch =
          call.name === "run_shell" && isCodeSearchCommand(command)
            ? countSimilarSearchRuns(history, command)
            : 0;
        if (prior >= REPEAT_TOOL_LIMIT) {
          ok = false;
          content = `已拦截重复工具调用：${call.name} 同样参数已执行 ${prior} 次。请基于已有结果作答，不要再打开目录或重复同一条命令。`;
        } else if (policy) {
          ok = false;
          content = policy;
        } else if (dirUsed >= DIR_BROWSE_LIMIT) {
          ok = false;
          content = `已拦截：本轮列目录已 ${dirUsed} 次。不要再 ls/find/open，请根据已有结果直接回答。`;
        } else if (searchUsed >= SEARCH_SHELL_LIMIT) {
          ok = false;
          content = `已拦截：本轮代码搜索已 ${searchUsed} 次。请用 read_tool_page / search_tool_artifact 阅读已归档结果后直接回答，不要再换关键词 rg/grep。`;
          if (gate) gate.forceAnswer = true;
        } else if (similarSearch >= SIMILAR_SEARCH_LIMIT) {
          ok = false;
          content = `已拦截：同类搜索已执行 ${similarSearch} 次。先 read_tool_page / search_tool_artifact，不要改几个词再搜一遍。`;
          if (gate) gate.forceAnswer = true;
        } else if (gate && isCodeSearchCommand(command) && (gate.archivedSearch || 0) >= ARCHIVE_SEARCH_STREAK) {
          ok = false;
          content = `已拦截：连续 ${gate.archivedSearch} 次搜索结果已归档且未翻页。请先 read_tool_page 或 search_tool_artifact，不要再开新的 rg。`;
          gate.forceAnswer = true;
        } else {
          content = await tool.execute(args, { signal });
        }
        if (gate && call.name === "run_shell") {
          if (!ok || (typeof content === "string" && content.startsWith("已拦截"))) {
            gate.blockedShell += 1;
            if (gate.blockedShell >= BLOCKED_SHELL_STREAK) gate.forceAnswer = true;
          } else {
            gate.blockedShell = 0;
          }
        }
        if (content != null && typeof content !== "string") content = JSON.stringify(content);
        if (ok && content) {
          const guarded = await interceptToolOutput({
            sessionId,
            toolName: call.name,
            content,
            threshold: host.toolArchiveThreshold,
          });
          if (guarded.intercepted) {
            onEvent({
              type: "tool_archived",
              name: call.name,
              handle: guarded.handle,
              originalLength: guarded.originalLength,
            });
            content = guarded.content;
            if (gate && call.name === "run_shell" && isCodeSearchCommand(command)) {
              gate.archivedSearch = (gate.archivedSearch || 0) + 1;
            }
          }
        }
        if (gate && (call.name === "read_tool_page" || call.name === "search_tool_artifact") && ok) {
          gate.archivedSearch = 0;
        }
      }
    } catch (err) {
      ok = false;
      content = err?.message || String(err);
    }
    const durationMs = Date.now() - t0;
    content = String(content ?? "").slice(0, TOOL_RESULT_CHARS);
    traceSteps.push({
      type: "tool_exec",
      turn,
      name: call.name,
      args,
      ok,
      durationMs,
      result: String(content ?? ""),
      resultPreview: String(content ?? "").slice(0, 4000),
      timestamp: Date.now(),
    });
    emitToolsDone(onEvent, { name: call.name, ok, args, content, durationMs });
    debugLog("agent.tool", {
      name: call.name,
      ok,
      durationMs,
      args,
      preview: String(content).slice(0, 300),
      blocked: !ok && /拦截/.test(String(content || "")),
    });
    results.push({ toolCallId: call.toolCallId, name: call.name, ok, content });
    history.push({ role: "tool", tool_call_id: call.toolCallId, content });
  }
  return results;
}
