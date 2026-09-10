/**
 * User-chosen folder of SKILL.md files (File System Access API or absolute path).
 * Separate DB from pagelens-fs (library) and pagelens-data. Read-only.
 */

import {
  isSkillFile,
  MAX_SKILL_BODY,
  MAX_SKILL_COUNT,
  MAX_SKILL_DEPTH,
  pathBasename,
  parseSkillMeta,
  shouldSkipDir,
  SKILL_META_HEAD,
} from "./fs-path.js";
import { nativeFs } from "./native-host.js";

export const SKILL_DB = "pagelens-skills-fs";
export const SKILL_STORE = "kv";
export const SKILL_ROOT_KEY = "skillsRoot";
export const SKILL_PATH_KEY = "skillsPath";
export { MAX_SKILL_BODY, MAX_SKILL_COUNT, MAX_SKILL_DEPTH, isSkillFile, shouldSkipDir };

export const MAX_SKILL_WHEN = 120;

export function clipSkillWhen(text, max = MAX_SKILL_WHEN) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function skillIdFromPath(relPath, rootName = "") {
  const parts = String(relPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (parts.length && isSkillFile(parts[parts.length - 1])) parts.pop();
  if (!parts.length) {
    const fallback = String(rootName || "skill").trim();
    return fallback || "skill";
  }
  return parts.join("/");
}

function unquote(value) {
  const t = String(value || "").trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseSimpleYaml(block) {
  const out = {};
  const lines = String(block || "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const m = raw.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m || /^\s/.test(raw)) {
      i += 1;
      continue;
    }
    const key = m[1];
    const val = m[2];
    if (val === "|" || val === ">" || val === "|-" || val === ">-" || val === "|+" || val === ">+") {
      const parts = [];
      i += 1;
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i] === "")) {
        parts.push(lines[i].replace(/^\s{1,2}/, ""));
        i += 1;
      }
      out[key] = parts.join("\n").trim();
      continue;
    }
    out[key] = unquote(val);
    i += 1;
  }
  return out;
}

export function parseSkillMarkdown(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  if (!raw.trim()) return null;
  let name = "";
  let when = "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm) {
    const meta = parseSimpleYaml(fm[1]);
    name = String(meta.name || "").trim();
    when = String(meta.description || meta.when || "").trim();
  }
  return { name, when, body: raw.trim() };
}

function isDirHandle(handle) {
  if (!handle) return false;
  if (handle.kind === "directory") return true;
  return typeof handle.getFile !== "function" && (typeof handle.entries === "function" || typeof handle.values === "function");
}

function isFileHandle(handle) {
  if (!handle) return false;
  return handle.kind === "file" || typeof handle.getFile === "function";
}

async function listEntries(dir) {
  const out = [];
  if (typeof dir.entries === "function") {
    for await (const [name, handle] of dir.entries()) out.push([name, handle]);
    return out;
  }
  if (typeof dir.values === "function") {
    for await (const handle of dir.values()) out.push([handle.name, handle]);
  }
  return out;
}

export async function scanSkillTree(root, { maxSkills = MAX_SKILL_COUNT, maxDepth = MAX_SKILL_DEPTH } = {}) {
  const files = [];
  let truncated = false;

  async function walk(dir, prefix, depth) {
    if (truncated || !dir) return;
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await listEntries(dir);
    } catch {
      return;
    }
    for (const [name, handle] of entries) {
      if (truncated) return;
      if (isDirHandle(handle)) {
        if (shouldSkipDir(name)) continue;
        await walk(handle, prefix ? `${prefix}/${name}` : name, depth + 1);
        continue;
      }
      if (!isFileHandle(handle) || !isSkillFile(name)) continue;
      if (files.length >= maxSkills) {
        truncated = true;
        return;
      }
      files.push({ path: prefix ? `${prefix}/${name}` : name, handle });
    }
  }

  await walk(root, "", 0);
  return { files, truncated };
}

export function skillsFromTexts(files, { rootName = "", maxBody = MAX_SKILL_BODY, rootPath = "" } = {}) {
  const skills = [];
  const seen = new Set();
  for (const item of files || []) {
    const parsed = parseSkillMarkdown(item?.text || "");
    if (!parsed) continue;
    const id = skillIdFromPath(item.path, rootName);
    const key = id.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    let body = parsed.body;
    if (body.length > maxBody) body = `${body.slice(0, maxBody)}\n\n【已截断】`;
    skills.push({
      id,
      name: parsed.name || id.split("/").pop() || id,
      when: clipSkillWhen(parsed.when),
      body,
      source: "folder",
      root: rootPath,
      filePath: item.path,
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

export function skillsFromMeta(files, { rootName = "", rootPath = "" } = {}) {
  const skills = [];
  const seen = new Set();
  for (const item of files || []) {
    const id = skillIdFromPath(item.path, rootName);
    const key = id.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    const skill = {
      id,
      name: item.name || id.split("/").pop() || id,
      when: clipSkillWhen(item.when),
      body: "",
      source: "folder",
      root: rootPath,
      filePath: item.path,
    };
    if (item.handle) skill.handle = item.handle;
    skills.push(skill);
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

function applySkillText(skill, text) {
  const parsed = parseSkillMarkdown(text || "");
  skill.body = parsed?.body || text || "";
  if (parsed?.name && !skill.name) skill.name = parsed.name;
  if (parsed?.when && !skill.when) skill.when = clipSkillWhen(parsed.when);
  return skill;
}

async function metaFromFileHandle(handle) {
  const blob = await handle.getFile();
  const text = typeof blob.slice === "function"
    ? await blob.slice(0, SKILL_META_HEAD).text()
    : await blob.text();
  return parseSkillMeta(text) || { name: "", when: "" };
}

export async function ensureSkillBody(skill) {
  if (!skill) return skill;
  if (skill.body) return skill;
  if (skill.handle && typeof skill.handle.getFile === "function") {
    try {
      const blob = await skill.handle.getFile();
      return applySkillText(skill, await blob.text());
    } catch {
      return skill;
    }
  }
  if (skill.root && skill.filePath) {
    const res = await nativeFs({ action: "readText", root: skill.root, rel: skill.filePath });
    if (!res.ok) return skill;
    return applySkillText(skill, res.text || "");
  }
  if (skill.source === "bundled" && skill.id && typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    try {
      const url = chrome.runtime.getURL(`skills/${skill.id}/SKILL.md`);
      const res = await fetch(url);
      if (res.ok) return applySkillText(skill, await res.text());
    } catch {
      /* packaged files optional */
    }
  }
  return skill;
}

export async function skillsFromFiles(files, { rootName = "", maxBody = MAX_SKILL_BODY } = {}) {
  const texts = [];
  for (const item of files || []) {
    try {
      const blob = await item.handle.getFile();
      texts.push({ path: item.path, text: await blob.text() });
    } catch {
      /* unreadable file */
    }
  }
  return skillsFromTexts(texts, { rootName, maxBody });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境没有 IndexedDB。"));
      return;
    }
    const req = indexedDB.open(SKILL_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SKILL_STORE)) db.createObjectStore(SKILL_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("打开 skill 目录存储失败"));
  });
}

async function skillIdbGet(key) {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILL_STORE, "readonly");
      const req = tx.objectStore(SKILL_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function skillIdbPut(key, value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SKILL_STORE, "readwrite");
    tx.objectStore(SKILL_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function skillIdbDelete(...keys) {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILL_STORE, "readwrite");
      const store = tx.objectStore(SKILL_STORE);
      for (const key of keys) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

async function getSkillHandle() {
  return skillIdbGet(SKILL_ROOT_KEY);
}

async function setSkillHandle(handle) {
  await skillIdbPut(SKILL_ROOT_KEY, handle);
  await skillIdbDelete(SKILL_PATH_KEY);
}

export async function getSavedSkillPath() {
  const raw = await skillIdbGet(SKILL_PATH_KEY);
  const path = String(raw || "").trim();
  return path || "";
}

export async function clearSkillFolderHandle() {
  await skillIdbDelete(SKILL_ROOT_KEY, SKILL_PATH_KEY);
}

async function ensureSkillPermission(handle, { request = false } = {}) {
  if (!handle) return false;
  const opts = { mode: "read" };
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

export async function skillFolderStatus({ request = false } = {}) {
  const savedPath = await getSavedSkillPath();
  if (savedPath) {
    const stat = await nativeFs({ action: "stat", path: savedPath });
    const granted = stat.ok === true && stat.kind === "directory";
    return {
      ok: true,
      configured: true,
      granted,
      mode: "path",
      name: (granted ? stat.name : "") || pathBasename(savedPath),
      path: (granted ? stat.path : "") || savedPath,
      permission: granted ? "granted" : "prompt",
      count: 0,
      error: granted ? "" : stat.error || "路径不可用。填绝对路径需要已安装 Native Host。",
    };
  }
  const handle = await getSkillHandle();
  if (!handle) return { ok: true, configured: false, granted: false, name: "", count: 0 };
  const granted = await ensureSkillPermission(handle, { request });
  return {
    ok: true,
    configured: true,
    granted,
    mode: "picker",
    name: handle.name || "",
    permission: granted ? "granted" : "prompt",
    count: 0,
  };
}

export async function pickSkillFolder() {
  if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前 Chrome 不支持选择文件夹。需要较新的 Chrome，并在侧栏里点选。");
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({
      id: "pagelens-skills",
      mode: "read",
      startIn: "documents",
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    handle = await window.showDirectoryPicker({
      id: "pagelens-skills",
      startIn: "documents",
    });
  }
  await setSkillHandle(handle);
  return { ok: true, mode: "picker", name: handle.name, granted: true };
}

export async function setSkillFolderPath(raw) {
  const res = await nativeFs({ action: "stat", path: String(raw || "") });
  if (!res.ok) throw new Error(res.error || "无法访问路径。填绝对路径需要已安装 Native Host。");
  if (res.kind !== "directory") throw new Error("必须是目录。");
  await skillIdbPut(SKILL_PATH_KEY, res.path);
  await skillIdbDelete(SKILL_ROOT_KEY);
  return {
    ok: true,
    configured: true,
    granted: true,
    mode: "path",
    path: res.path,
    name: res.name || pathBasename(res.path),
  };
}

export async function loadFolderSkills({ request = false, timeoutMs } = {}) {
  const empty = { configured: false, granted: false, name: "", path: "", mode: "", count: 0, truncated: false, skills: [] };
  const savedPath = await getSavedSkillPath();
  if (savedPath) {
    const res = await nativeFs(
      {
        action: "scanSkills",
        path: savedPath,
        maxSkills: MAX_SKILL_COUNT,
        maxDepth: MAX_SKILL_DEPTH,
      },
      timeoutMs ? { timeoutMs } : {},
    );
    if (!res.ok) {
      return {
        ...empty,
        configured: true,
        mode: "path",
        path: savedPath,
        name: pathBasename(savedPath),
        error: res.error || "路径不可用。填绝对路径需要已安装 Native Host。",
      };
    }
    const skills = skillsFromMeta(res.files, {
      rootName: res.name || pathBasename(savedPath),
      rootPath: res.path || savedPath,
    });
    return {
      configured: true,
      granted: true,
      mode: "path",
      path: res.path || savedPath,
      name: res.name || pathBasename(savedPath),
      count: skills.length,
      truncated: res.truncated === true,
      skills,
    };
  }
  const handle = await getSkillHandle();
  if (!handle) return empty;
  const granted = await ensureSkillPermission(handle, { request });
  if (!granted) {
    return { ...empty, configured: true, mode: "picker", name: handle.name || "" };
  }
  const scanned = await scanSkillTree(handle);
  const files = [];
  for (const item of scanned.files) {
    let name = "";
    let when = "";
    try {
      const meta = await metaFromFileHandle(item.handle);
      name = meta.name || "";
      when = meta.when || "";
    } catch {
      /* unreadable file */
    }
    files.push({ path: item.path, name, when, handle: item.handle });
  }
  const skills = skillsFromMeta(files, { rootName: handle.name || "" });
  return {
    configured: true,
    granted: true,
    mode: "picker",
    name: handle.name || "",
    count: skills.length,
    truncated: scanned.truncated,
    skills,
  };
}
