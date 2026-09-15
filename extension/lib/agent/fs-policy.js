/**
 * Aliases and read-ext checks for agent list_directory / read_file.
 * Host still enforces the real allowlist after expanding ~.
 */

export const AGENT_PATH_ALIASES = {
  home: "~",
  "~": "~",
  downloads: "~/Downloads",
  desktop: "~/Desktop",
  documents: "~/Documents",
  tmp: "/tmp",
  cache: "~/.cache/pagelens-docs",
};

const READ_EXT = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "csv",
  "vtt",
  "srt",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "kt",
  "swift",
  "sh",
  "zsh",
  "bash",
  "html",
  "htm",
  "css",
  "vue",
  "xml",
  "yaml",
  "yml",
  "toml",
  "log",
  "ini",
  "conf",
  "sql",
]);

const BLOCK_ROOTS = new Set(["/", "/users", "/home", "/etc", "/system", "/private", "/var", "/opt"]);

export function aliasAgentPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const mapped = AGENT_PATH_ALIASES[s.toLowerCase()];
  return mapped || s;
}

export function isBlockedAgentRoot(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "") || "/";
  return BLOCK_ROOTS.has(s.toLowerCase());
}

export function fileNameExt(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function isAllowedAgentReadName(name) {
  const ext = fileNameExt(name);
  if (!ext) return false;
  return READ_EXT.has(ext);
}
