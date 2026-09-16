/**
 * Tool Output Guardian: intercepts long tool results before they pollute LLM context.
 * Archives large output to ArtifactStore and returns a structured preview with Handle.
 */

import { saveArtifact } from "./artifact-store.js";

export const DEFAULT_ARCHIVE_THRESHOLD = 1800;
export const PREVIEW_CHARS = 900;

export const SKIP_GUARDIAN_TOOLS = new Set([
  "search_tool_artifact",
  "read_tool_page",
  "recall",
  "remember",
  "read_artifact_page",
  "search_artifact_content",
  "retrieve_tool_result",
]);

export function formatToolArchivePreview(manifest, fullText, previewChars = PREVIEW_CHARS) {
  const preview = fullText.slice(0, previewChars).trim();
  const truncated = fullText.length > previewChars ? "\n…" : "";
  return (
    `【工具结果 · 已归档为分页本地文档】\n` +
    `来源工具: ${manifest.sourceTool}\n` +
    `文档句柄 (Handle): \`${manifest.handle}\`（共 ${manifest.totalPages} 页 / ${manifest.totalChars} 字符）\n` +
    `完整内容已存入本地，未全量打入上下文以保护模型窗口。\n\n` +
    `💡 下一步必须先读这份归档，不要换关键词再搜一遍：\n` +
    `  • 搜索关键内容: search_tool_artifact(query="...", handle="${manifest.handle}")\n` +
    `  • 翻阅指定页数: read_tool_page(handle="${manifest.handle}", page=1)\n\n` +
    `前瞻预览：\n${preview}${truncated}`
  );
}

export function parseHandleFromText(text) {
  if (typeof text !== "string") return undefined;
  const match = /`?(art_[a-zA-Z0-9_-]+)`?/.exec(text);
  return match ? match[1] : undefined;
}

export async function interceptToolOutput({
  sessionId = "default",
  toolName,
  content,
  threshold = DEFAULT_ARCHIVE_THRESHOLD,
  previewChars = PREVIEW_CHARS,
}) {
  const text = String(content ?? "");
  if (!toolName || SKIP_GUARDIAN_TOOLS.has(toolName) || text.length <= threshold) {
    return {
      intercepted: false,
      content: text,
      originalLength: text.length,
    };
  }

  try {
    const manifest = await saveArtifact({
      sessionId,
      toolName,
      content: text,
    });

    const preview = formatToolArchivePreview(manifest, text, previewChars);
    return {
      intercepted: true,
      handle: manifest.handle,
      originalLength: text.length,
      content: preview,
      manifest,
    };
  } catch (err) {
    console.warn("[tool-guardian] failed to archive tool result:", err?.message || err);
    return {
      intercepted: false,
      content: text,
      originalLength: text.length,
    };
  }
}
