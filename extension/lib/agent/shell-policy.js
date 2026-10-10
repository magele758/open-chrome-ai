/**
 * Hard stops for run_shell: GUI folder launchers, unbounded walks, and browse loops.
 */

export const REPEAT_TOOL_LIMIT = 2;
export const DIR_BROWSE_LIMIT = 8;
export const BLOCKED_SHELL_STREAK = 3;
export const SEARCH_SHELL_LIMIT = 4;
export const ARCHIVE_SEARCH_STREAK = 2;
export const SIMILAR_SEARCH_LIMIT = 2;

const GUI_OPEN = /(?:^|[\s;&|`($'"])(?:\/(?:usr\/)?bin\/)?open\s+(?:(?:-[A-Za-z]+|--)\s+)*['"]?(?:\/|~|\.|\.\.\/|\$HOME)/i;
const GUI_OPEN_FLAG = /(?:^|[\s;&|`($'"])(?:\/(?:usr\/)?bin\/)?open\s+-[WwAa]/i;
const GUI_XDG = /\bxdg-open\b|\bgio\s+open\b|\bnautilus\b|\bdolphin\b|\bnemo\b|\bexplorer(?:\.exe)?\b/i;
const DIR_CMD = /(?:^|[\s;&|`($])(?:\/(?:usr\/)?bin\/)?(?:ls|find|tree|du)\b/i;

function parseArgs(raw) {
  try {
    return JSON.parse(String(raw || "{}"));
  } catch {
    return {};
  }
}

export function isGuiLaunchCommand(cmd) {
  const s = String(cmd || "");
  if (!s.trim()) return false;
  if (GUI_OPEN.test(s) || GUI_OPEN_FLAG.test(s) || GUI_XDG.test(s)) return true;
  if (/\bosascript\b/i.test(s) && /Finder/i.test(s)) return true;
  if (/\bstart\s+(?:["']|[A-Za-z]:\\)/i.test(s)) return true;
  return false;
}

export function isUnboundedFsWalk(cmd) {
  const s = String(cmd || "");
  if (!s.trim()) return false;
  if (/\bls\b[\s\S]*?(?:-[A-Za-z]*R|--recursive)/i.test(s)) return true;
  if (/\bfind\b/i.test(s)) {
    if (!/-maxdepth\s+[1-3]\b/.test(s)) return true;
    if (/\bfind\s+\/(?:\s|$)/.test(s)) return true;
  }
  if (/\btree\b/i.test(s) && !/-L\s+[1-3]\b/.test(s)) return true;
  if (/\bdu\b/i.test(s) && !/(?:-d|--max-depth)\s+[1-3]\b/.test(s)) return true;
  return false;
}

export function isDirectoryBrowseCommand(cmd) {
  const s = String(cmd || "");
  if (isGuiLaunchCommand(s) || isUnboundedFsWalk(s)) return true;
  return DIR_CMD.test(s);
}

const SEARCH_BIN = /(?:^|[\s;&|`($])(?:\/(?:usr\/)?bin\/)?(?:rg|grep|egrep|fgrep|ag|ack|mdfind)\b|\bgit\s+grep\b/i;
const SEARCH_STOP = new Set([
  "head", "printf", "files", "packages", "apps", "grep", "egrep", "fgrep",
  "true", "false", "echo", "cwd", "tmp", "usr", "bin", "timeout", "type",
  "and", "the", "for", "from", "with",
]);

export function isCodeSearchCommand(cmd) {
  return SEARCH_BIN.test(String(cmd || ""));
}

export function searchKeywords(cmd) {
  const s = String(cmd || "").toLowerCase();
  const tokens = [...s.matchAll(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/g)].map((m) => m[0]);
  return [...new Set(tokens.filter((t) => t !== "rg" && !SEARCH_STOP.has(t)))];
}

export function searchesAreSimilar(a, b) {
  const ka = searchKeywords(a);
  const kb = searchKeywords(b);
  if (!ka.length || !kb.length) return false;
  const setB = new Set(kb);
  return ka.filter((k) => setB.has(k)).length >= 2;
}

export function countCodeSearchRuns(history) {
  return countCompletedToolRunsBy(history, (name, args) => (
    name === "run_shell" && isCodeSearchCommand(String(args?.command || ""))
  ));
}

export function countSimilarSearchRuns(history, cmd) {
  return countCompletedToolRunsBy(history, (name, args) => {
    if (name !== "run_shell") return false;
    const other = String(args?.command || "");
    return isCodeSearchCommand(other) && searchesAreSimilar(cmd, other);
  });
}

export function shellPolicyBlock(cmd) {
  if (isGuiLaunchCommand(cmd)) {
    return "已拦截：不要用 open/xdg-open/访达打开目录。列一层用 ls，读文件用 cat。";
  }
  if (isUnboundedFsWalk(cmd)) {
    return "已拦截：不要递归扫盘。只 ls 当前一层，或 find 带 -maxdepth 1-3（不要从 / 开始）。";
  }
  return "";
}

const SENSITIVE_SEG = new Set([
  ".ssh", ".aws", ".gnupg", ".kube", ".netrc", ".docker", ".npmrc", ".pypirc",
  ".git-credentials", ".pgpass", ".password-store", "keychains", "gcloud",
]);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|id_[a-z0-9]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const READ_ABS_OK = /^(?:~(?:\/|$)|\/tmp(?:\/|$)|\/private\/tmp(?:\/|$)|\/Users\/|\/home\/)/;

/** Split into shell words; returns null if anything could expand, chain, or redirect. */
function shellWords(cmd) {
  const words = [];
  let cur = "";
  let has = false;
  let quote = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "$" || c === "`" || c === "\\") return null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === " " || c === "\t") {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else if (/[;&|`$<>(){}*?[\]\\\n\r!#]/.test(c)) {
      return null;
    } else if (c === "~" && has && /[=:]/.test(cmd[i - 1])) {
      return null;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) return null;
  if (has) words.push(cur);
  return words;
}

export function isSensitivePath(p) {
  const segs = String(p || "").split(/[/\\=]/);
  return segs.some((s) => SENSITIVE_SEG.has(s.toLowerCase()) || SENSITIVE_NAME.test(s));
}

function pathOk(p, { read = false } = {}) {
  if (isSensitivePath(p)) return false;
  if (/^~[^/]/.test(p)) return false;
  if (!read) return true;
  if (p.split("/").includes("..")) return false;
  return !p.startsWith("/") && !p.startsWith("~") ? true : READ_ABS_OK.test(p);
}

function optionValue(tok) {
  const i = tok.indexOf("=");
  return i > 0 ? tok.slice(i + 1) : "";
}

function shortFlags(tok) {
  return /^-[^-]/.test(tok) ? tok.slice(1) : "";
}

const GIT_DIFF_DENY = /^--(?:output|ext-diff|no-index)/;
const GIT_BRANCH_FLAGS = new Set([
  "--list", "--all", "--remotes", "--verbose", "--show-current", "--color", "--no-color",
  "--column", "--no-column", "--ignore-case", "--abbrev", "--no-abbrev", "--omit-empty",
]);
const GIT_BRANCH_VALUE = new Set(["--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format"]);

function gitBranchReadOnly(rest) {
  let listing = false;
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    const name = t.split("=")[0];
    if (t === "-l" || t === "--list") listing = true;
    if (GIT_BRANCH_VALUE.has(name)) {
      if (!t.includes("=")) i += 1;
      continue;
    }
    if (GIT_BRANCH_FLAGS.has(name)) continue;
    if (t.startsWith("--")) return false;
    const flags = shortFlags(t);
    if (flags) {
      if (!/^[arvl]+$/.test(flags)) return false;
      continue;
    }
    positional.push(t);
  }
  return positional.length === 0 || listing;
}

function gitReadOnly(words) {
  const [, sub, ...rest] = words;
  if (["diff", "log", "show"].includes(sub)) return !rest.some((t) => GIT_DIFF_DENY.test(t));
  if (sub === "status" || sub === "rev-parse") return true;
  if (sub === "branch") return gitBranchReadOnly(rest);
  if (sub === "remote") {
    const action = rest.find((t) => !t.startsWith("-"));
    return !action || action === "get-url" || action === "show";
  }
  return false;
}

const FIND_ALLOWED = new Set([
  "-maxdepth", "-mindepth", "-type", "-name", "-iname", "-path", "-ipath", "-size", "-mtime",
  "-mmin", "-newer", "-empty", "-print", "-print0", "-not", "-a", "-o", "-and", "-or", "-L", "-H", "-P",
]);

function findReadOnly(words) {
  return words.slice(1).every((t) => !t.startsWith("-") || FIND_ALLOWED.has(t));
}

const READERS = new Set(["cat", "head", "tail", "grep", "wc", "file"]);

function readerOptionsOk(bin, opts) {
  for (const t of opts) {
    const flags = shortFlags(t);
    if (bin === "grep" && (/^--(?:recursive|dereference-recursive|directories|file)\b/.test(t) || /[rRdf]/.test(flags))) return false;
    if ((bin === "tail" || bin === "head") && (/^--(?:follow|retry)\b/.test(t) || /[fF]/.test(flags))) return false;
    if (bin === "file" && (/^--(?:compile|magic-file|files-from)\b/.test(t) || /[Cmf]/.test(flags))) return false;
    if (bin === "wc" && /^--files0-from\b/.test(t)) return false;
  }
  return true;
}

/** Read-only shell commands that balanced HITL mode may run without confirmation. */
export function isShellCommandWhitelisted(cmd, { cwd } = {}) {
  const s = String(cmd || "").trim();
  if (!s || isUnboundedFsWalk(s)) return false;
  const words = shellWords(s);
  if (!words?.length) return false;
  const [bin] = words;
  const args = words.slice(1);
  const read = READERS.has(bin);
  if (cwd != null && String(cwd).trim() && !pathOk(String(cwd).trim(), { read })) return false;
  for (const t of args) {
    if (t.startsWith("-")) {
      const v = optionValue(t);
      if (v && !pathOk(v, { read })) return false;
    } else if (!pathOk(t, { read })) {
      return false;
    }
  }
  switch (bin) {
    case "git":
      return gitReadOnly(words);
    case "ls":
      return !args.some((t) => t === "--recursive" || /R/.test(shortFlags(t)));
    case "pwd":
    case "uname":
    case "which":
    case "echo":
      return true;
    case "find":
      return findReadOnly(words);
    case "node":
    case "python":
    case "python3":
      return args.length === 1 && args[0] === "--version";
    default:
      return read && readerOptionsOk(bin, args.filter((t) => t.startsWith("-")));
  }
}

export function toolCallSignature(name, rawArgs) {
  const tool = String(name || "");
  let args = String(rawArgs || "{}");
  try {
    args = JSON.stringify(JSON.parse(args));
  } catch {
    /* keep raw */
  }
  return `${tool}:${args}`;
}

export function countCompletedToolRunsBy(history, match) {
  const ids = new Set();
  for (const m of history || []) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const cn = c.function?.name || c.name || "";
      const ca = c.function?.arguments || c.arguments || "{}";
      if (c.id && match(cn, parseArgs(ca), ca)) ids.add(String(c.id));
    }
  }
  let n = 0;
  for (const m of history || []) {
    if (m.role === "tool" && ids.has(String(m.tool_call_id || ""))) n += 1;
  }
  return n;
}

// 只读观察类工具：页面被操作过之后，同样参数再读一次是在验证新状态，不算重复。
const OBSERVE_TOOLS = new Set([
  "run_js",
  "list_controls",
  "snapshot_controls",
  "query_dom",
  "find_in_page",
  "get_page_info",
  "extract_page",
  "get_links",
  "screenshot",
]);
const MUTATING_TOOLS = new Set([
  "click",
  "fill",
  "select_option",
  "press_key",
  "scroll_page",
  "trusted_click",
  "trusted_type",
  "press_keys",
  "set_checks",
  "hover",
  "drag_drop",
  "upload_file",
  "act_element",
  "jev_next_action",
  "paste_into_page",
  "navigate_tab",
  "reload_tab",
  "switch_tab",
  "open_tab",
  "handle_dialog",
]);

function sinceLastMutation(history) {
  const list = history || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    if (m.tool_calls.some((c) => MUTATING_TOOLS.has(c.function?.name || c.name || ""))) return list.slice(i + 1);
  }
  return list;
}

export function countCompletedToolRuns(history, name, rawArgs) {
  const sig = toolCallSignature(name, rawArgs);
  const scope = OBSERVE_TOOLS.has(String(name)) ? sinceLastMutation(history) : history;
  return countCompletedToolRunsBy(scope, (n, _args, raw) => toolCallSignature(n, raw) === sig);
}

export function countDirectoryBrowseRuns(history) {
  return countCompletedToolRunsBy(history, (name, args) => (
    name === "run_shell" && isDirectoryBrowseCommand(String(args?.command || ""))
  ));
}
