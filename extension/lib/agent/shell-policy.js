/**
 * Hard stops for run_shell: GUI folder launchers, unbounded walks, and browse loops.
 */

export const REPEAT_TOOL_LIMIT = 2;
export const DIR_BROWSE_LIMIT = 8;
export const BLOCKED_SHELL_STREAK = 3;

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

export function shellPolicyBlock(cmd) {
  if (isGuiLaunchCommand(cmd)) {
    return "已拦截：不要用 open/xdg-open/访达打开目录。列一层用 ls，读文件用 cat。";
  }
  if (isUnboundedFsWalk(cmd)) {
    return "已拦截：不要递归扫盘。只 ls 当前一层，或 find 带 -maxdepth 1-3（不要从 / 开始）。";
  }
  return "";
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

export function countCompletedToolRuns(history, name, rawArgs) {
  const sig = toolCallSignature(name, rawArgs);
  return countCompletedToolRunsBy(history, (n, _args, raw) => toolCallSignature(n, raw) === sig);
}

export function countDirectoryBrowseRuns(history) {
  return countCompletedToolRunsBy(history, (name, args) => (
    name === "run_shell" && isDirectoryBrowseCommand(String(args?.command || ""))
  ));
}
