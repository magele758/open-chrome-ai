/**
 * User-chosen folder for video manuscripts (File System Access API).
 * Handle lives in IndexedDB; files are real VTT/Markdown on disk.
 */

import { formatTranscript } from "./asr.js";
import { fileExt, MAX_FS_TEXT, pathBasename, splitRelParts, TEXT_FILE_EXT } from "./fs-path.js";
import { nativeFs } from "./native-host.js";
import { formatTime } from "./prompts.js";
import { sessionNoteRelPath, sessionToObsidianMarkdown } from "./sessions.js";

const DB_NAME = "pagelens-fs";
const STORE = "kv";
const ROOT_KEY = "libraryRoot";
const PATH_KEY = "libraryPath";
const TEXT_EXT = TEXT_FILE_EXT;
const MAX_TEXT = MAX_FS_TEXT;

export function videoIdentity(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return "yt:" + v;
    }
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id) return "yt:" + id;
    }
    if (host.includes("bilibili.com")) {
      const m = u.pathname.match(/BV[\w]+/);
      if (m) return "bili:" + m[0];
    }
    u.hash = "";
    for (const key of ["t", "start", "t_s", "utm_source", "utm_medium", "utm_campaign", "si"]) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return String(url || "");
  }
}

export function folderNameFor(identity) {
  const raw = String(identity || "unknown")
    .replace(/https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (raw || "unknown").slice(0, 80);
}

export function splitRelPath(rel) {
  return splitRelParts(rel);
}

export function extOf(name) {
  return fileExt(name);
}

export function formatVttTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = Math.floor(rest);
  const ms = Math.min(999, Math.round((rest - whole) * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(whole)}.${pad(ms, 3)}`;
}

function parseVttStamp(raw) {
  const m = String(raw || "")
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return NaN;
  const h = m[1] != null ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(m[4].padEnd(3, "0").slice(0, 3)) : 0;
  return h * 3600 + min * 60 + sec + frac / 1000;
}

export function cuesToVtt(cues, textKey = "text") {
  const rows = Array.isArray(cues) ? cues : [];
  const lines = ["WEBVTT", ""];
  let n = 0;
  rows.forEach((c, i) => {
    const start = Number(c.start) || 0;
    const next = Number(rows[i + 1]?.start);
    const end = Number.isFinite(Number(c.end)) ? Number(c.end) : Number.isFinite(next) ? next : start + 3;
    const text = String(c[textKey] || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    n += 1;
    lines.push(String(n));
    lines.push(`${formatVttTime(start)} --> ${formatVttTime(Math.max(end, start + 0.2))}`);
    lines.push(text);
    lines.push("");
  });
  return lines.join("\n");
}

export function parseVtt(text) {
  const cues = [];
  const body = String(text || "").replace(/^\uFEFF/, "");
  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== "WEBVTT" && !l.startsWith("NOTE") && !l.startsWith("STYLE"));
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startRaw, endRaw] = timeLine.split("-->");
    const start = parseVttStamp(startRaw);
    const end = parseVttStamp(endRaw);
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l));
    const cueText = textLines.join(" ").replace(/\s+/g, " ").trim();
    if (cueText && Number.isFinite(start)) cues.push({ start, end: Number.isFinite(end) ? end : undefined, text: cueText });
  }
  return cues;
}

export function parseTimedText(text) {
  const cues = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s*(.*)$/);
    if (!m) continue;
    const h = m[1] != null ? Number(m[1]) : 0;
    const start = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const t = (m[4] || "").trim();
    if (t) cues.push({ start, text: t });
  }
  return cues;
}

function yamlScalar(value) {
  const s = String(value ?? "");
  if (s === "") return '""';
  if (/[:#\n"'\\]/.test(s) || /^-/.test(s)) return JSON.stringify(s);
  return s;
}

export function cuesToMarkdown(meta, cues) {
  const title = meta?.title || meta?.identity || "untitled";
  const lines = [
    "---",
    `id: ${yamlScalar(meta?.identity || "")}`,
    `title: ${yamlScalar(title)}`,
    `url: ${yamlScalar(meta?.url || "")}`,
    `source: ${yamlScalar(meta?.source || "")}`,
    `updated: ${yamlScalar(meta?.updatedAt || new Date().toISOString())}`,
    "---",
    "",
    `# ${title}`,
    "",
  ];
  if (meta?.url) {
    lines.push(`来源：${meta.url}`, "");
  }
  for (const c of cues || []) {
    lines.push(`## ${formatTime(c.start)}`);
    if (c.text) lines.push(String(c.text).trim());
    if (c.zh) lines.push(String(c.zh).trim());
    lines.push("");
  }
  return lines.join("\n");
}

export function mergeZhCues(srcCues, zhCues) {
  const src = Array.isArray(srcCues) ? srcCues : [];
  const zh = Array.isArray(zhCues) ? zhCues : [];
  return src.map((c, i) => {
    let hit = zh[i];
    if (!hit || Math.abs((hit.start || 0) - (c.start || 0)) > 1.5) {
      hit = zh.find((z) => Math.abs((z.start || 0) - (c.start || 0)) <= 1.5);
    }
    return { ...c, zh: hit?.text || c.zh || "" };
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境没有 IndexedDB。"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("打开文稿库失败"));
  });
}

async function idbGet(key) {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(key, value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(...keys) {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const key of keys) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

let cachedRootHandle = null;

export async function getSavedHandle() {
  if (cachedRootHandle) return cachedRootHandle;
  const handle = await idbGet(ROOT_KEY);
  if (handle) cachedRootHandle = handle;
  return handle;
}

export async function setSavedHandle(handle) {
  cachedRootHandle = handle || null;
  await idbPut(ROOT_KEY, handle);
  await idbDelete(PATH_KEY);
}

export async function getSavedLibraryPath() {
  const raw = await idbGet(PATH_KEY);
  const path = String(raw || "").trim();
  return path || "";
}

export async function clearSavedHandle() {
  cachedRootHandle = null;
  await idbDelete(ROOT_KEY, PATH_KEY);
}

export async function ensurePermission(handle, { request = false } = {}) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  try {
    if (typeof handle.queryPermission === "function") {
      const q = await handle.queryPermission(opts);
      if (q === "granted") return true;
      const qRead = await handle.queryPermission({ mode: "read" });
      if (qRead === "granted") return true;
    }
    // Test if handle is directly accessible in current memory session without prompt
    if (typeof handle.keys === "function") {
      try {
        const iter = handle.keys();
        await iter.next();
        return true;
      } catch {
        /* not accessible */
      }
    }
    if (request && typeof handle.requestPermission === "function") {
      try {
        const res = await handle.requestPermission(opts);
        if (res === "granted") return true;
      } catch {
        /* requestPermission might fail in extension sidepanel */
      }
      try {
        const resRead = await handle.requestPermission({ mode: "read" });
        if (resRead === "granted") return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    return false;
  }
  return false;
}

function missingLibraryError() {
  return "还没有选择文稿文件夹。到设置里选一个目录，或填绝对路径。";
}

export async function libraryStatus({ request = false } = {}) {
  const root = await getLibraryRoot({ request });
  if (!root) return { ok: true, configured: false, granted: false, name: "", mode: "", path: "" };
  return {
    ok: true,
    configured: true,
    granted: root.granted,
    mode: root.mode || "picker",
    name: root.name || "",
    path: root.mode === "path" ? root.path || "" : "",
    permission: root.granted ? "granted" : "prompt",
    error: root.error || "",
  };
}

export async function pickLibraryFolder() {
  if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前 Chrome 不支持选择文件夹。需要较新的 Chrome，并在侧栏里点选。");
  }
  const oldHandle = await getSavedHandle();
  const options = {
    id: "pagelens-library",
    mode: "readwrite",
  };
  if (oldHandle) {
    options.startIn = oldHandle;
  } else {
    options.startIn = "documents";
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker(options);
  } catch (err) {
    if (options.startIn !== "documents") {
      handle = await window.showDirectoryPicker({ id: "pagelens-library", mode: "readwrite", startIn: "documents" });
    } else {
      throw err;
    }
  }
  await setSavedHandle(handle);
  return { ok: true, mode: "picker", name: handle.name, granted: true };
}

export async function setLibraryPath(raw) {
  const res = await nativeFs({ action: "stat", path: String(raw || "") });
  if (!res.ok) throw new Error(res.error || "无法访问路径。填绝对路径需要已安装 Native Host。");
  if (res.kind !== "directory") throw new Error("必须是目录。");
  await idbPut(PATH_KEY, res.path);
  await idbDelete(ROOT_KEY);
  return {
    ok: true,
    configured: true,
    granted: true,
    mode: "path",
    path: res.path,
    name: res.name || pathBasename(res.path),
  };
}

export async function getLibraryRoot({ request = false } = {}) {
  const savedPath = await getSavedLibraryPath();
  if (savedPath) {
    const stat = await nativeFs({ action: "stat", path: savedPath });
    if (!stat.ok || stat.kind !== "directory") {
      return {
        mode: "path",
        path: savedPath,
        name: pathBasename(savedPath),
        granted: false,
        error: stat.error || "路径不可用。填绝对路径需要已安装 Native Host。",
      };
    }
    return {
      mode: "path",
      path: stat.path || savedPath,
      name: stat.name || pathBasename(savedPath),
      granted: true,
    };
  }
  const handle = await getSavedHandle();
  if (!handle) return null;
  const granted = await ensurePermission(handle, { request });
  if (!granted) return { mode: "picker", handle, granted: false, name: handle.name || "" };
  return { mode: "picker", handle, granted: true, name: handle.name || "" };
}

async function walkDir(root, dirParts, create) {
  let dir = root;
  for (const part of dirParts) {
    dir = await dir.getDirectoryHandle(part, { create: Boolean(create) });
  }
  return dir;
}

export async function writeSessionNote(session, { request = false } = {}) {
  const rel = sessionNoteRelPath(session);
  const written = await writeLibraryText(rel, sessionToObsidianMarkdown(session), { request });
  return { ...written, path: rel };
}

export async function writeSessionNotes(sessions, { request = false } = {}) {
  const files = [];
  for (const session of sessions || []) {
    files.push(await writeSessionNote(session, { request }));
  }
  return { ok: true, count: files.length, folder: "PageLens/sessions", files };
}

function requireLibraryRoot(root) {
  if (!root) throw new Error(missingLibraryError());
  if (!root.granted) {
    throw new Error(root.mode === "path"
      ? (root.error || "文稿路径不可用。确认已安装 Native Host，并到设置重新填路径。")
      : "文稿文件夹未授权。到设置点「重新授权」。");
  }
  return root;
}

export async function writeLibraryText(rel, text, { request = false } = {}) {
  const root = requireLibraryRoot(await getLibraryRoot({ request }));
  const parts = splitRelPath(rel);
  const name = parts[parts.length - 1];
  if (!TEXT_EXT.has(extOf(name))) {
    throw new Error(`只能写入 ${[...TEXT_EXT].join("、")} 文件。`);
  }
  const body = String(text ?? "");
  if (body.length > MAX_TEXT) throw new Error(`文件太大（>${MAX_TEXT} 字）。`);
  if (root.mode === "path") {
    const res = await nativeFs({ action: "writeText", root: root.path, rel: parts.join("/"), text: body });
    if (!res.ok) throw new Error(res.error || "写入文稿失败。");
    return { ok: true, path: parts.join("/"), bytes: body.length };
  }
  const dir = await walkDir(root.handle, parts.slice(0, -1), true);
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(body);
  await writable.close();
  return { ok: true, path: parts.join("/"), bytes: body.length };
}

export async function readLibraryText(rel, { request = false } = {}) {
  const root = requireLibraryRoot(await getLibraryRoot({ request }));
  const parts = splitRelPath(rel);
  const name = parts[parts.length - 1];
  if (root.mode === "path") {
    const res = await nativeFs({ action: "readText", root: root.path, rel: parts.join("/") });
    if (!res.ok) throw new Error(res.error || "读取文稿失败。");
    return { ok: true, path: parts.join("/"), text: res.text || "", bytes: res.bytes || 0 };
  }
  const dir = await walkDir(root.handle, parts.slice(0, -1), false);
  const file = await dir.getFileHandle(name, { create: false });
  const blob = await file.getFile();
  const body = await blob.text();
  return { ok: true, path: parts.join("/"), text: body, bytes: body.length };
}

export async function listLibrary(rel = "", { request = false } = {}) {
  const root = requireLibraryRoot(await getLibraryRoot({ request }));
  const parts = String(rel || "").trim() ? splitRelPath(rel) : [];
  if (root.mode === "path") {
    const res = await nativeFs({ action: "readdir", root: root.path, rel: parts.join("/") });
    if (!res.ok) throw new Error(res.error || "列出文稿失败。");
    return {
      ok: true,
      folder: root.name,
      path: parts.join("/"),
      count: res.count || (res.entries || []).length,
      entries: (res.entries || []).slice(0, 200),
    };
  }
  const dir = await walkDir(root.handle, parts, false);
  const entries = [];
  if (typeof dir.entries === "function") {
    for await (const [name, handle] of dir.entries()) {
      entries.push({
        name,
        path: [...parts, name].join("/"),
        kind: handle.kind || (typeof handle.getFile === "function" ? "file" : "directory"),
      });
    }
  } else if (typeof dir.values === "function") {
    for await (const handle of dir.values()) {
      entries.push({
        name: handle.name,
        path: [...parts, handle.name].join("/"),
        kind: handle.kind,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    ok: true,
    folder: root.name,
    path: parts.join("/"),
    count: entries.length,
    entries: entries.slice(0, 200),
  };
}

const lastSync = new Map();

function normalizeCues(doc) {
  if (Array.isArray(doc.cues) && doc.cues.length) return doc.cues;
  if (doc.text) return parseTimedText(doc.text);
  return [];
}

export async function writeVideoDoc(doc, { request = false } = {}) {
  const root = await getLibraryRoot({ request });
  if (!root) return { ok: false, error: missingLibraryError() };
  if (!root.granted) {
    return {
      ok: false,
      error: root.mode === "path"
        ? (root.error || "文稿路径不可用。")
        : "文稿文件夹未授权。",
    };
  }
  const identity = doc.identity || videoIdentity(doc.url || "");
  const folder = folderNameFor(identity);
  if (!doc.complete) {
    const prior = await readLibraryText(`${folder}/meta.json`, { request }).then(r => JSON.parse(r.text)).catch(() => ({}));
    if (prior.complete) return { ok: true, skipped: true, folder };
  }
  const cues = normalizeCues(doc);
  if (!cues.length) return { ok: false, error: "没有可写入的字幕。" };

  let zhCues = Array.isArray(doc.zhCues) ? doc.zhCues : [];
  if (!zhCues.length) {
    try {
      const existing = await readLibraryText(`${folder}/zh.vtt`, { request });
      zhCues = parseVtt(existing.text);
    } catch {
      zhCues = [];
    }
  }
  const merged = mergeZhCues(cues, zhCues);
  const updatedAt = new Date().toISOString();
  const meta = {
    id: identity,
    folder,
    title: doc.title || "",
    url: doc.url || "",
    duration: doc.duration || null,
    source: doc.source || "",
    audioOnly: ["asr-full", "asr", "asr-cache", "interpret"].includes(doc.source),
    complete: doc.complete === true,
    cueCount: cues.length,
    hasZh: merged.some((c) => c.zh),
    updatedAt,
  };
  await writeLibraryText(`${folder}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`, { request });
  await writeLibraryText(`${folder}/original.vtt`, cuesToVtt(cues, "text"), { request });
  if (merged.some((c) => c.zh)) {
    await writeLibraryText(`${folder}/zh.vtt`, cuesToVtt(merged, "zh"), { request });
  }
  await writeLibraryText(`${folder}/transcript.md`, cuesToMarkdown({ ...meta, identity }, merged), { request });
  lastSync.set(identity, `${doc.source || ""}:${cues.length}:${(doc.text || "").length}`);
  return { ok: true, folder, files: ["meta.json", "original.vtt", "transcript.md"].concat(merged.some((c) => c.zh) ? ["zh.vtt"] : []) };
}

export async function readVideoDocFromLibrary(url, { request = false } = {}) {
  const identity = videoIdentity(url);
  if (!identity) return null;
  const folder = folderNameFor(identity);
  try {
    const vtt = await readLibraryText(`${folder}/original.vtt`, { request });
    const cues = parseVtt(vtt.text);
    if (!cues.length) return null;
    const formatted = formatTranscript(cues);
    const meta = await readLibraryText(`${folder}/meta.json`, { request }).then(r => JSON.parse(r.text)).catch(() => ({}));
    if (meta.audioOnly !== true && !["asr-full", "asr"].includes(meta.source)) return null;
    return { status: "ready", ...formatted, source: meta.source || "unknown", complete: meta.complete === true, duration: meta.duration };
  } catch {
    return null;
  }
}

export async function syncPackToLibrary(pack, { request = false } = {}) {
  if (!pack?.url || pack.captionsStatus !== "ready") return { ok: false, skipped: true };
  const identity = videoIdentity(pack.url);
  const sig = `${pack.captionsSource || ""}:${(pack.captionsText || "").length}`;
  if (lastSync.get(identity) === sig) return { ok: true, skipped: true };
  const result = await writeVideoDoc(
    {
      identity,
      url: pack.url,
      title: pack.title || "",
      duration: pack.video?.duration,
      source: pack.captionsSource || "",
      complete: pack.captionsComplete === true,
      cues: pack.captionsCues,
      text: pack.captionsText,
    },
    { request },
  );
  if (result.ok) lastSync.set(identity, sig);
  return result;
}
