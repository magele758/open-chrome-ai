export const MAX_FS_TEXT = 400000;
export const MAX_SKILL_DEPTH = 8;
export const MAX_SKILL_COUNT = 300;
export const MAX_SKILL_BODY = 120000;
export const SKILL_META_HEAD = 4096;
export const TEXT_FILE_EXT = new Set(["md", "txt", "vtt", "json", "srt", "csv"]);

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

export function expandUserPath(raw, home) {
  const s = String(raw || "").trim();
  const h = String(home || "").replace(/[/\\]+$/, "");
  if (!s) return "";
  if (s === "~") return h || s;
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    if (!h) return s;
    return `${h}${s.slice(1)}`;
  }
  return s;
}

export function looksAbsolutePath(p) {
  const s = String(p || "").trim();
  return s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\");
}

export function pathBasename(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s) return "";
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export function fileExt(name) {
  const base = String(name || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function splitRelParts(rel) {
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

export function shouldSkipDir(name) {
  const n = String(name || "");
  if (!n || n === "." || n === "..") return true;
  if (n.startsWith(".")) return true;
  return SKIP_DIRS.has(n.toLowerCase());
}

export function isSkillFile(name) {
  return String(name || "").toLowerCase() === "skill.md";
}

export function clipSkillWhen(text, max = 120) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function parseSkillMeta(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  if (!raw.trim()) return null;
  let name = "";
  let when = "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(name|description|when)\s*:\s*(.*)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (val === "|" || val === ">" || val === "|-" || val === ">-") continue;
      if (m[1] === "name") name = val;
      else if (!when) when = val;
    }
  }
  return { name, when: clipSkillWhen(when) };
}
