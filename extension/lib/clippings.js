/**
 * PageLens - Clippings Module
 * Handles exporting model responses and webpage links to:
 * 1. Obsidian individual markdown cards (with YAML frontmatter)
 * 2. Chrome bookmarks (under a dedicated "PageLens 智库" folder)
 * 3. Local storage index for URL-based smart recall & browsing
 */

import { readLibraryText, writeLibraryText, deleteLibraryFile } from "./library.js";

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
 * Returns local YYYY-MM-DD string.
 */
export function getLocalDateString(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Replaces date tokens in folder template (e.g. YYYY, MM, M月, {YYYY}, {M}).
 */
export function formatFolderWithDate(folder, timestamp = Date.now()) {
  if (!folder || typeof folder !== "string") return "";
  const d = new Date(timestamp);
  const year = String(d.getFullYear());
  const month2 = String(d.getMonth() + 1).padStart(2, "0");
  const month1 = String(d.getMonth() + 1);
  const day2 = String(d.getDate()).padStart(2, "0");
  return folder
    .replace(/\{YYYY\}|YYYY/g, year)
    .replace(/\{YY\}|YY/g, year.slice(2))
    .replace(/\{MM\}|MM/g, month2)
    .replace(/\{M\}|M月/g, `${month1}月`)
    .replace(/\{DD\}|DD/g, day2);
}

/**
 * Computes the relative path for a daily note in the Obsidian vault.
 * e.g. Daily/2026-09-14.md or 日记/2026.9月/2026-09-14.md
 */
export function dailyNoteRelPath(folder = "Daily", timestamp = Date.now(), libraryRoot = "") {
  let clean = String(folder ?? "").trim();
  if (libraryRoot) {
    const normLib = String(libraryRoot).replace(/[\\/]+$/, "");
    if (clean.startsWith(normLib)) {
      clean = clean.slice(normLib.length);
    }
  }
  clean = clean.replace(/^[\\/]+|[\\/]+$/g, "");
  clean = formatFolderWithDate(clean, timestamp);
  clean = clean.replace(/^[\\/]+|[\\/]+$/g, "");
  const day = getLocalDateString(timestamp);
  return clean ? `${clean}/${day}.md` : `${day}.md`;
}

/**
 * Checks if a clipping is already present in existing daily note text.
 */
export function isClippingInDailyNote(existingText, clipping) {
  if (!existingText || typeof existingText !== "string" || !clipping) return false;
  const rawUrl = clipping.url ? String(clipping.url).trim() : "";
  if (rawUrl) {
    if (existingText.includes(rawUrl)) return true;
    const norm = normalizeClippingUrl(rawUrl);
    if (norm && existingText.includes(norm)) return true;
    if (existingText.includes(`](${rawUrl})`)) return true;
  }
  if (clipping.id && existingText.includes(clipping.id)) {
    return true;
  }
  if (clipping.title) {
    const cleanTitle = String(clipping.title).trim();
    if (cleanTitle) {
      if (rawUrl && existingText.includes(`[${cleanTitle}](${rawUrl})`)) return true;
      if (!rawUrl && (existingText.includes(`### 📌 ${cleanTitle}`) || existingText.includes(cleanTitle))) return true;
    }
  }
  return false;
}

/**
 * Formats a clipping into an Obsidian daily note digest entry.
 */
export function formatDailyNoteEntry(clipping) {
  const now = new Date(clipping.createdAt || Date.now());
  const timeStr = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join(":");

  const tags = Array.isArray(clipping.tags)
    ? clipping.tags.filter(Boolean).map((t) => String(t).trim().replace(/^#/, ""))
    : String(clipping.tags || "")
        .split(/[,，\s]+/)
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean);

  const lines = [];
  const linkText = clipping.url
    ? `[${clipping.title || "未命名采摘"}](${clipping.url})`
    : (clipping.title || "未命名采摘");
  lines.push(`### 📌 ${linkText}`);
  lines.push(`- ⏱️ **采摘时间**：${timeStr}`);
  if (clipping.id) {
    lines.push(`<!-- clipping_id: ${clipping.id} -->`);
  }
  if (tags.length) {
    lines.push(`- 🏷️ **标签**：${tags.map((t) => `#${t}`).join(" ")}`);
  }
  if (clipping.note && clipping.note.trim()) {
    lines.push(`> 💡 **我的思考**：${clipping.note.trim()}`);
  }
  if (clipping.content && clipping.content.trim()) {
    lines.push("", clipping.content.trim());
  }
  return lines.join("\n");
}

/**
 * Appends clipping to today's daily journal note in Obsidian.
 * If file does not exist, creates it. If exists, appends with deduplication.
 */
export async function appendClippingToDailyNote(clipping, { folder = "Daily", libraryRoot = "", request = false } = {}) {
  const relPath = dailyNoteRelPath(folder, clipping.createdAt, libraryRoot);
  const entryText = formatDailyNoteEntry(clipping);

  let existing = null;
  try {
    const res = await readLibraryText(relPath, { request });
    if (res?.ok) existing = res.text || "";
  } catch {
    existing = null;
  }

  // Deduplication check
  if (existing !== null && isClippingInDailyNote(existing, clipping)) {
    return { ok: true, path: relPath, skipped: true, reason: "duplicate" };
  }

  let finalContent = "";
  if (existing === null) {
    const day = getLocalDateString(clipping.createdAt);
    finalContent = `# ${day}\n\n## 📌 内容采摘\n\n${entryText}\n`;
  } else {
    const trimmed = existing.trimEnd();
    finalContent = `${trimmed}\n\n${entryText}\n`;
  }

  const written = await writeLibraryText(relPath, finalContent, { request });
  return { ...written, path: relPath, skipped: false, created: existing === null };
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
 * Deletes a clipping completely:
 * 1. Removes record from chrome.storage.local index
 * 2. Removes corresponding Chrome bookmark if bookmarkId is set
 * 3. Removes individual Obsidian card file if obsidianPath is set
 */
export async function deleteClippingFull(clipping) {
  if (!clipping) return { ok: false };
  const id = typeof clipping === "string" ? clipping : clipping.id;
  if (!id) return { ok: false };

  // 1. Delete from local storage index
  await deleteClippingRecord(id);

  // 2. Delete Chrome bookmark if present
  const bookmarkId = clipping.bookmarkId;
  if (bookmarkId && typeof chrome !== "undefined" && chrome.bookmarks?.remove) {
    try {
      await chrome.bookmarks.remove(bookmarkId);
    } catch {
      /* ignore if already removed or not found */
    }
  }

  // 3. Delete Obsidian card file if present
  const cardPath = clipping.obsidianPath;
  if (cardPath) {
    try {
      await deleteLibraryFile(cardPath);
    } catch {
      /* ignore if file does not exist or library not connected */
    }
  }

  return { ok: true, id };
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
  saveDaily = false,
  dailyFolder = "Daily",
  libraryRoot = "",
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
    dailyPath: null,
    dailySkipped: false,
    bookmarkId: null,
  };

  let obsidianError = null;
  let dailyError = null;
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

  if (saveDaily) {
    try {
      const dRes = await appendClippingToDailyNote(clipping, { folder: dailyFolder, libraryRoot, request: true });
      clipping.dailyPath = dRes.path;
      clipping.dailySkipped = dRes.skipped === true;
    } catch (err) {
      console.error("[pagelens] Obsidian daily note append failed:", err);
      dailyError = err;
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
    ok: !obsidianError && !dailyError,
    clipping,
    obsidianError: obsidianError?.message || null,
    dailyError: dailyError?.message || null,
    bookmarkError: bookmarkError?.message || null,
  };
}
