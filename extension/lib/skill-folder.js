/**
 * User-chosen folder of SKILL.md files (File System Access API).
 * Separate DB from pagelens-fs (library) and pagelens-data. Read-only.
 */

export const SKILL_DB = "pagelens-skills-fs";
export const SKILL_STORE = "kv";
export const SKILL_ROOT_KEY = "skillsRoot";
export const MAX_SKILL_DEPTH = 8;
export const MAX_SKILL_COUNT = 300;
export const MAX_SKILL_BODY = 120000;
export const MAX_SKILL_WHEN = 120;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".cache",
  "dist",
  "build",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".turbo",
  ".next",
  "out",
  "tmp",
  "temp",
]);

export function shouldSkipDir(name) {
  const n = String(name || "");
  if (!n || n === "." || n === "..") return true;
  if (n.startsWith(".")) return true;
  return SKIP_DIRS.has(n.toLowerCase());
}

export function isSkillFile(name) {
  return String(name || "").toLowerCase() === "skill.md";
}

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

export async function skillsFromFiles(files, { rootName = "", maxBody = MAX_SKILL_BODY } = {}) {
  const skills = [];
  const seen = new Set();
  for (const item of files || []) {
    try {
      const blob = await item.handle.getFile();
      const text = await blob.text();
      const parsed = parseSkillMarkdown(text);
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
      });
    } catch {
      /* unreadable file */
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
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

async function getSkillHandle() {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILL_STORE, "readonly");
      const req = tx.objectStore(SKILL_STORE).get(SKILL_ROOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function setSkillHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SKILL_STORE, "readwrite");
    tx.objectStore(SKILL_STORE).put(handle, SKILL_ROOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSkillFolderHandle() {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SKILL_STORE, "readwrite");
      tx.objectStore(SKILL_STORE).delete(SKILL_ROOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
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
  const handle = await getSkillHandle();
  if (!handle) return { ok: true, configured: false, granted: false, name: "", count: 0 };
  const granted = await ensureSkillPermission(handle, { request });
  return {
    ok: true,
    configured: true,
    granted,
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
  return { ok: true, name: handle.name, granted: true };
}

export async function loadFolderSkills({ request = false } = {}) {
  const handle = await getSkillHandle();
  if (!handle) {
    return { configured: false, granted: false, name: "", count: 0, truncated: false, skills: [] };
  }
  const granted = await ensureSkillPermission(handle, { request });
  if (!granted) {
    return { configured: true, granted: false, name: handle.name || "", count: 0, truncated: false, skills: [] };
  }
  const scanned = await scanSkillTree(handle);
  const skills = await skillsFromFiles(scanned.files, { rootName: handle.name || "" });
  return {
    configured: true,
    granted: true,
    name: handle.name || "",
    count: skills.length,
    truncated: scanned.truncated,
    skills,
  };
}
