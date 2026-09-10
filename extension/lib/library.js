/**
 * User-chosen folder for video manuscripts (File System Access API).
 * Handle lives in IndexedDB; files are real VTT/Markdown on disk.
 */

import { formatTranscript } from "./asr.js";
import { formatTime } from "./prompts.js";
import { sessionNoteRelPath, sessionToObsidianMarkdown } from "./sessions.js";

const DB_NAME = "pagelens-fs";
const STORE = "kv";
const ROOT_KEY = "libraryRoot";
const TEXT_EXT = new Set(["md", "txt", "vtt", "json", "srt", "csv"]);
const MAX_TEXT = 400000;

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
  const trimmed = String(rel || "").trim();
  if (!trimmed) throw new Error("路径不能为空。");
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) throw new Error("不能使用绝对路径。");
  const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) throw new Error("路径不能为空。");
  if (parts.some((p) => p === "." || p === ".." || p.includes("\0"))) {
    throw new Error("路径不合法。");
  }
  return parts;
}

export function extOf(name) {
  const base = String(name || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
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

export async function getSavedHandle() {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(ROOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function setSavedHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, ROOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSavedHandle() {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(ROOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

export async function ensurePermission(handle, { request = false } = {}) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  try {
    if (typeof handle.queryPermission === "function") {
      const q = await handle.queryPermission(opts);
      if (q === "granted") return true;
      if (!request) return false;
    }
    if (request && typeof handle.requestPermission === "function") {
      return (await handle.requestPermission(opts)) === "granted";
    }
  } catch {
    return false;
  }
  return Boolean(handle);
}

export async function libraryStatus({ request = false } = {}) {
  const handle = await getSavedHandle();
  if (!handle) return { ok: true, configured: false, granted: false, name: "" };
  const granted = await ensurePermission(handle, { request });
  return {
    ok: true,
    configured: true,
    granted,
    name: handle.name || "",
    permission: granted ? "granted" : "prompt",
  };
}

export async function pickLibraryFolder() {
  if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前 Chrome 不支持选择文件夹。需要较新的 Chrome，并在侧栏里点选。");
  }
  const handle = await window.showDirectoryPicker({
    id: "pagelens-library",
    mode: "readwrite",
    startIn: "documents",
  });
  await setSavedHandle(handle);
  return { ok: true, name: handle.name, granted: true };
}

export async function getLibraryRoot({ request = false } = {}) {
  const handle = await getSavedHandle();
  if (!handle) return null;
  const granted = await ensurePermission(handle, { request });
  if (!granted) return { handle, granted: false, name: handle.name || "" };
  return { handle, granted: true, name: handle.name || "" };
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

export async function writeLibraryText(rel, text, { request = false } = {}) {
  const root = await getLibraryRoot({ request });
  if (!root) throw new Error("还没有选择文稿文件夹。到设置里选一个目录。");
  if (!root.granted) throw new Error("文稿文件夹未授权。到设置点「重新授权」。");
  const parts = splitRelPath(rel);
  const name = parts[parts.length - 1];
  if (!TEXT_EXT.has(extOf(name))) {
    throw new Error(`只能写入 ${[...TEXT_EXT].join("、")} 文件。`);
  }
  const body = String(text ?? "");
  if (body.length > MAX_TEXT) throw new Error(`文件太大（>${MAX_TEXT} 字）。`);
  const dir = await walkDir(root.handle, parts.slice(0, -1), true);
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(body);
  await writable.close();
  return { ok: true, path: parts.join("/"), bytes: body.length };
}

export async function readLibraryText(rel, { request = false } = {}) {
  const root = await getLibraryRoot({ request });
  if (!root) throw new Error("还没有选择文稿文件夹。到设置里选一个目录。");
  if (!root.granted) throw new Error("文稿文件夹未授权。到设置点「重新授权」。");
  const parts = splitRelPath(rel);
  const name = parts[parts.length - 1];
  const dir = await walkDir(root.handle, parts.slice(0, -1), false);
  const file = await dir.getFileHandle(name, { create: false });
  const blob = await file.getFile();
  const body = await blob.text();
  return { ok: true, path: parts.join("/"), text: body, bytes: body.length };
}

export async function listLibrary(rel = "", { request = false } = {}) {
  const root = await getLibraryRoot({ request });
  if (!root) throw new Error("还没有选择文稿文件夹。到设置里选一个目录。");
  if (!root.granted) throw new Error("文稿文件夹未授权。到设置点「重新授权」。");
  const parts = String(rel || "").trim() ? splitRelPath(rel) : [];
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
  if (!root) return { ok: false, error: "还没有选择文稿文件夹。" };
  if (!root.granted) return { ok: false, error: "文稿文件夹未授权。" };
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
    return { status: "ready", ...formatted, source: "library", complete: meta.complete === true, duration: meta.duration };
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
