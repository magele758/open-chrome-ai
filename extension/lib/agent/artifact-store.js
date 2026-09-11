/**
 * Ephemeral & persistent artifact store for tool outputs in Chrome extension.
 * Supports L1 memory cache + L2 IndexedDB persistence.
 * Pure JS / RegExp search over stored artifacts (no external embedding needed).
 */

import { idbAvailable, idbDel, idbGet, idbSet } from "../idb-kv.js";

export const DEFAULT_PAGE_SIZE = 3000;
export const ARTIFACT_PREFIX = "pl.art.";
export const SESSION_INDEX_PREFIX = "pl.art.idx.";

// L1 In-memory cache for ultra-fast sync/async lookups and test fallback
const memoryArtifacts = new Map();
const memorySessionIndex = new Map();

function offsetToLine(text, offset) {
  const clamped = Math.min(offset, text.length);
  let line = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

export function generateHandle(sessionId = "s", toolName = "tool") {
  const safeSession = String(sessionId || "s").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) || "s";
  const safeTool = String(toolName || "tool").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "tool";
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `art_${safeSession}_${safeTool}_${ts}_${rand}`;
}

export async function saveArtifact({ sessionId = "default", toolName = "tool", content = "", pageSizeChars = DEFAULT_PAGE_SIZE }) {
  const text = String(content ?? "");
  const handle = generateHandle(sessionId, toolName);
  const totalChars = text.length;
  const totalPages = Math.max(1, Math.ceil(totalChars / pageSizeChars));
  const createdAt = Date.now();

  const manifest = {
    handle,
    sessionId,
    sourceTool: toolName,
    totalChars,
    totalPages,
    pageSizeChars,
    createdAt,
  };

  const record = { manifest, content: text };

  // 1. Update L1 memory
  memoryArtifacts.set(handle, record);
  const curList = memorySessionIndex.get(sessionId) || [];
  if (!curList.includes(handle)) {
    curList.push(handle);
    memorySessionIndex.set(sessionId, curList);
  }

  // 2. Persist to L2 IndexedDB (if available)
  if (idbAvailable()) {
    try {
      await idbSet(ARTIFACT_PREFIX + handle, record);
      const storedIdx = (await idbGet(SESSION_INDEX_PREFIX + sessionId)) || [];
      if (!storedIdx.includes(handle)) {
        storedIdx.push(handle);
        await idbSet(SESSION_INDEX_PREFIX + sessionId, storedIdx);
      }
    } catch (err) {
      console.warn("[artifact-store] failed to persist to IDB:", err?.message || err);
    }
  }

  return manifest;
}

export async function getArtifact(handle, sessionId) {
  if (!handle) return null;
  // 1. Check L1 Memory
  let record = memoryArtifacts.get(handle);
  if (record) return record;

  // 2. Check L2 IndexedDB
  if (idbAvailable()) {
    try {
      record = await idbGet(ARTIFACT_PREFIX + handle);
      if (record) {
        memoryArtifacts.set(handle, record);
        return record;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function listSessionArtifacts(sessionId = "default") {
  const handles = new Set(memorySessionIndex.get(sessionId) || []);
  if (idbAvailable()) {
    try {
      const stored = (await idbGet(SESSION_INDEX_PREFIX + sessionId)) || [];
      for (const h of stored) handles.add(h);
    } catch {
      // ignore
    }
  }
  const manifests = [];
  for (const h of handles) {
    const rec = await getArtifact(h, sessionId);
    if (rec?.manifest) manifests.push(rec.manifest);
  }
  return manifests.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function readArtifactPage({ handle, page = 1, sessionId }) {
  const record = await getArtifact(handle, sessionId);
  if (!record) {
    return {
      ok: false,
      error: `未找到文档句柄: ${handle}，可能已过期或会话已被清理。`,
    };
  }

  const { manifest, content } = record;
  const targetPage = Math.max(1, Math.min(manifest.totalPages, Number(page) || 1));
  const start = (targetPage - 1) * manifest.pageSizeChars;
  const end = Math.min(content.length, start + manifest.pageSizeChars);
  const slice = content.slice(start, end);

  return {
    ok: true,
    handle: manifest.handle,
    toolName: manifest.sourceTool,
    page: targetPage,
    totalPages: manifest.totalPages,
    pageSizeChars: manifest.pageSizeChars,
    totalChars: manifest.totalChars,
    startOffset: start,
    endOffset: end,
    hasNext: targetPage < manifest.totalPages,
    nextPage: targetPage < manifest.totalPages ? targetPage + 1 : null,
    content: slice,
  };
}

export async function searchArtifacts({
  query = "",
  handle = null,
  sessionId = "default",
  maxMatches = 8,
  contextChars = 140,
}) {
  const q = String(query ?? "").trim();
  if (!q) {
    return { ok: false, error: "search query 不能为空" };
  }

  let targets = [];
  if (handle) {
    const rec = await getArtifact(handle, sessionId);
    if (rec) targets.push(rec);
  } else {
    const manifests = await listSessionArtifacts(sessionId);
    for (const m of manifests) {
      const rec = await getArtifact(m.handle, sessionId);
      if (rec) targets.push(rec);
    }
  }

  if (!targets.length) {
    return {
      ok: true,
      query: q,
      matches: [],
      totalMatches: 0,
      hasMore: false,
      note: handle ? `未找到文档 ${handle}` : "当前会话暂无归档的工具输出",
    };
  }

  const matches = [];
  let totalMatches = 0;
  let hasMore = false;

  // Try compiling as RegExp if it has regex special characters; fall back to substring search
  let regex = null;
  const isRegexPattern = /[\\^$.*+?()[\]{}|]/.test(q);
  if (isRegexPattern) {
    try {
      regex = new RegExp(q, "gi");
    } catch {
      regex = null;
    }
  }

  const queryLower = q.toLowerCase();

  for (const item of targets) {
    const { manifest, content } = item;
    if (!content) continue;

    if (regex) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        totalMatches += 1;
        if (matches.length < maxMatches) {
          const idx = match.index;
          const matchEnd = idx + match[0].length;
          const ctxStart = Math.max(0, idx - contextChars);
          const ctxEnd = Math.min(content.length, matchEnd + contextChars);
          matches.push({
            handle: manifest.handle,
            toolName: manifest.sourceTool,
            page: Math.floor(idx / manifest.pageSizeChars) + 1,
            lineStart: offsetToLine(content, idx),
            lineEnd: offsetToLine(content, matchEnd),
            preview: content.slice(ctxStart, ctxEnd).trim(),
          });
        } else {
          hasMore = true;
        }
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    } else {
      const contentLower = content.toLowerCase();
      let searchFrom = 0;
      while (searchFrom < contentLower.length) {
        const idx = contentLower.indexOf(queryLower, searchFrom);
        if (idx === -1) break;
        totalMatches += 1;
        if (matches.length < maxMatches) {
          const matchEnd = idx + q.length;
          const ctxStart = Math.max(0, idx - contextChars);
          const ctxEnd = Math.min(content.length, matchEnd + contextChars);
          matches.push({
            handle: manifest.handle,
            toolName: manifest.sourceTool,
            page: Math.floor(idx / manifest.pageSizeChars) + 1,
            lineStart: offsetToLine(content, idx),
            lineEnd: offsetToLine(content, matchEnd),
            preview: content.slice(ctxStart, ctxEnd).trim(),
          });
        } else {
          hasMore = true;
        }
        searchFrom = idx + Math.max(1, q.length);
      }
    }
  }

  return {
    ok: true,
    query: q,
    matches,
    totalMatches,
    hasMore,
  };
}

export async function deleteSessionArtifacts(sessionId) {
  if (!sessionId) return;
  const handles = new Set(memorySessionIndex.get(sessionId) || []);
  if (idbAvailable()) {
    try {
      const stored = (await idbGet(SESSION_INDEX_PREFIX + sessionId)) || [];
      for (const h of stored) handles.add(h);
      await idbDel(SESSION_INDEX_PREFIX + sessionId);
      const keysToDel = Array.from(handles).map((h) => ARTIFACT_PREFIX + h);
      if (keysToDel.length) await idbDel(keysToDel);
    } catch (err) {
      console.warn("[artifact-store] error deleting session artifacts:", err?.message || err);
    }
  }

  for (const h of handles) {
    memoryArtifacts.delete(h);
  }
  memorySessionIndex.delete(sessionId);
}

export function clearAllMemoryArtifacts() {
  memoryArtifacts.clear();
  memorySessionIndex.clear();
}
