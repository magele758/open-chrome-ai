/**
 * PageLens - Clippings Module
 * Handles exporting model responses and webpage links to:
 * 1. Obsidian individual markdown cards (with YAML frontmatter)
 * 2. Chrome bookmarks (under a dedicated "PageLens 智库" folder)
 * 3. Local storage index for URL-based smart recall & browsing
 */

import { writeLibraryText } from "./library.js";

export const CLIPPINGS_STORAGE_KEY = "pagelens_clippings";
export const BOOKMARK_FOLDER_NAME = "PageLens 智库";

/**
 * Normalizes a URL for stable matching across visits:
 * - strips tracking query params (utm_*, fbclid, ref, etc.)
 * - removes url hash/fragment
 * - normalizes lowercased host
 */
export function normalizeClippingUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    const trackingPrefixes = ["utm_", "fbclid", "spm", "ref", "ref_src", "from", "source", "feature"];
    const toDelete = [];
    u.searchParams.forEach((_, key) => {
      const lower = key.toLowerCase();
      if (trackingPrefixes.some((p) => lower === p || lower.startsWith("utm_"))) {
        toDelete.push(key);
      }
    });
    for (const key of toDelete) {
      u.searchParams.delete(key);
    }
    let res = u.toString();
    if (u.pathname === "/" && !u.search) {
      res = res.replace(/\/$/, "");
    }
    return res;
  } catch {
    return String(rawUrl || "").trim();
  }
}

/**
 * Escapes YAML string scalar safely.
 */
export function yamlScalar(val) {
  const s = String(val ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
  return `"${s}"`;
}

/**
 * Generates a filesystem-safe slug for clipping filenames.
 */
export function clippingSlug(title) {
  const raw = String(title || "clipping")
    .replace(/https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (raw || "clipping").slice(0, 36);
}

/**
 * Generates relative file path in the Obsidian vault:
 * e.g. PageLens/clippings/2026-09-12-my-article-title-a1b2c3d4.md
 */
export function clippingNoteRelPath(clipping) {
  const d = new Date(clipping.createdAt || Date.now());
  const day = d.toISOString().slice(0, 10);
  const slug = clippingSlug(clipping.title || "clip");
  const shortId = String(clipping.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "card";
  return `PageLens/clippings/${day}-${slug}-${shortId}.md`;
}

/**
 * Generates Obsidian-compatible Markdown with YAML Frontmatter.
 */
export function clippingToObsidianMarkdown(clipping) {
  const now = new Date(clipping.createdAt || Date.now());
  const dateStr = now.toISOString().replace("T", " ").slice(0, 19);
  const day = dateStr.slice(0, 10);

  const tags = Array.isArray(clipping.tags)
    ? clipping.tags.filter(Boolean).map((t) => String(t).trim().replace(/^#/, ""))
    : String(clipping.tags || "")
        .split(/[,，\s]+/)
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean);

  const tagList = ["pagelens", "clipping", ...tags];
  const uniqueTags = [...new Set(tagList)];

  const fm = [
    "---",
    `title: ${yamlScalar(clipping.title || "未命名剪藏")}`,
    `url: ${yamlScalar(clipping.url || "")}`,
    `date: ${day}`,
    `created_at: ${yamlScalar(dateStr)}`,
    `tags: [${uniqueTags.map((t) => yamlScalar(t)).join(", ")}]`,
    `clipping_id: ${yamlScalar(clipping.id || "")}`,
    "source: PageLens",
  ];

  if (clipping.note) {
    fm.push(`note_summary: ${yamlScalar(clipping.note.slice(0, 60))}`);
  }
  fm.push("---", "");

  const parts = [
    fm.join("\n"),
    `# ${clipping.title || "未命名剪藏"}`,
    "",
    `> 🔗 **原文链接**：[${clipping.title || clipping.url}](${clipping.url || "#"})  `,
    `> 📅 **剪藏时间**：${dateStr}  `,
    `> 🏷️ **标签**：${uniqueTags.map((t) => `#${t}`).join(" ")}`,
    "",
  ];

  if (clipping.note && clipping.note.trim()) {
    parts.push("## 💡 个人思考 / 备注", "", clipping.note.trim(), "");
  }

  if (clipping.content && clipping.content.trim()) {
    parts.push("## 🤖 AI 核心提炼", "", clipping.content.trim(), "");
  }

  return parts.join("\n");
}

/**
 * Writes an individual clipping card into the Obsidian vault folder.
 */
export async function writeClippingCard(clipping, { request = false } = {}) {
  const rel = clippingNoteRelPath(clipping);
  const md = clippingToObsidianMarkdown(clipping);
  const written = await writeLibraryText(rel, md, { request });
  return { ...written, path: rel };
}

/**
 * Finds the default bookmark root folder ID (usually '1' for bookmark bar).
 */
async function defaultBookmarkParentId(parentId) {
  if (parentId) return String(parentId);
  try {
    const [bar] = await chrome.bookmarks.get("1");
    if (bar) return "1";
  } catch {
    /* ignore */
  }
  try {
    const tree = await chrome.bookmarks.getTree();
    return tree[0]?.children?.[0]?.id || "1";
  } catch {
    return "1";
  }
}

/**
 * Retrieves or creates a dedicated bookmark folder in Chrome.
 */
export async function getOrCreateBookmarkFolder(folderName = BOOKMARK_FOLDER_NAME) {
  if (!chrome.bookmarks?.search) {
    throw new Error("Chrome bookmarks API unavailable.");
  }
  const hits = await chrome.bookmarks.search({ title: folderName });
  const existing = hits.find((h) => !h.url);
  if (existing) return existing.id;

  const parentId = await defaultBookmarkParentId();
  const folder = await chrome.bookmarks.create({ parentId, title: folderName });
  return folder.id;
}

/**
 * Formats bookmark title incorporating user's note if available.
 */
export function formatBookmarkTitle(title, note) {
  const cleanTitle = String(title || "未命名网页").trim();
  const cleanNote = String(note || "").trim().replace(/\r?\n/g, " ");
  if (!cleanNote) return cleanTitle;
  const notePrefix = cleanNote.length > 15 ? cleanNote.slice(0, 15) + "…" : cleanNote;
  return `[${notePrefix}] ${cleanTitle}`;
}

/**
 * Saves webpage bookmark into Chrome Bookmarks under PageLens folder.
 */
export async function saveToChromeBookmarks(clipping, { folderName = BOOKMARK_FOLDER_NAME } = {}) {
  if (!chrome.bookmarks?.create) return null;
  const url = clipping.url;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const folderId = await getOrCreateBookmarkFolder(folderName);
  const title = formatBookmarkTitle(clipping.title, clipping.note);

  const node = await chrome.bookmarks.create({
    parentId: folderId,
    title,
    url,
  });
  return node;
}

/**
 * Reads all stored clippings from chrome.storage.local.
 */
export async function listAllClippings() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const data = await chrome.storage.local.get(CLIPPINGS_STORAGE_KEY);
  const items = Array.isArray(data[CLIPPINGS_STORAGE_KEY]) ? data[CLIPPINGS_STORAGE_KEY] : [];
  return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Saves a clipping record into local storage.
 */
export async function saveClippingRecord(clipping) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return clipping;
  const list = await listAllClippings();
  const next = [clipping, ...list.filter((item) => item.id !== clipping.id)];
  const capped = next.slice(0, 1000);
  await chrome.storage.local.set({ [CLIPPINGS_STORAGE_KEY]: capped });
  return clipping;
}

/**
 * Finds existing clippings matching a given page URL (normalized).
 */
export async function getClippingsForUrl(targetUrl) {
  if (!targetUrl) return [];
  const norm = normalizeClippingUrl(targetUrl);
  if (!norm) return [];
  const list = await listAllClippings();
  return list.filter((item) => normalizeClippingUrl(item.url) === norm);
}

/**
 * Deletes a clipping record by ID from local storage.
 */
export async function deleteClippingRecord(id) {
  if (!id || typeof chrome === "undefined" || !chrome.storage?.local) return;
  const list = await listAllClippings();
  const next = list.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [CLIPPINGS_STORAGE_KEY]: next });
}

/**
 * Unified high-level function to perform the full clipping workflow:
 * 1. Write to Obsidian card (if requested)
 * 2. Save to Chrome Bookmarks (if requested)
 * 3. Store record in local storage for smart recall
 */
export async function executeClipping({
  id = crypto.randomUUID(),
  title,
  url,
  note = "",
  content = "",
  tags = [],
  saveObsidian = true,
  saveBookmark = true,
  createdAt = Date.now(),
}) {
  const clipping = {
    id,
    title: String(title || "未命名网页").trim(),
    url: String(url || "").trim(),
    note: String(note || "").trim(),
    content: String(content || "").trim(),
    tags: Array.isArray(tags) ? tags : String(tags || "").split(/[,，\s]+/).filter(Boolean),
    createdAt,
    obsidianPath: null,
    bookmarkId: null,
  };

  let obsidianError = null;
  let bookmarkError = null;

  if (saveObsidian) {
    try {
      const res = await writeClippingCard(clipping, { request: true });
      clipping.obsidianPath = res.path;
    } catch (err) {
      console.error("[pagelens] Obsidian card write failed:", err);
      obsidianError = err;
    }
  }

  if (saveBookmark) {
    try {
      const bm = await saveToChromeBookmarks(clipping);
      if (bm) clipping.bookmarkId = bm.id;
    } catch (err) {
      console.warn("[pagelens] Bookmark creation failed:", err);
      bookmarkError = err;
    }
  }

  // Always save local clipping record for smart recall
  await saveClippingRecord(clipping);

  return {
    ok: !obsidianError,
    clipping,
    obsidianError: obsidianError?.message || null,
    bookmarkError: bookmarkError?.message || null,
  };
}
