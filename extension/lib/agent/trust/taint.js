/**
 * 会话污点：一旦读入页面 / PDF / 字幕 / 工具结果等数据，之后 LLM 发起的工具调用都“可能受数据影响”。
 * 命中注入特征时升为 high：只影响胶囊外的动作与出站范围，不撤销胶囊内的自动放行。
 */

export const TAINT_CLEAN = "clean";
export const TAINT_DATA = "data";
export const TAINT_HIGH = "high";

const RANK = { [TAINT_CLEAN]: 0, [TAINT_DATA]: 1, [TAINT_HIGH]: 2 };
const MAX_SOURCES = 20;

const SOURCE_BY_TOOL = {
  extract_page: "page",
  extract_pages: "page",
  get_page_info: "page",
  get_selection: "page",
  get_links: "page",
  find_in_page: "page",
  query_dom: "page",
  list_controls: "page",
  snapshot_controls: "page",
  run_js: "page",
  read_rendered_html: "page",
  get_captions: "subtitle",
  transcribe_video: "subtitle",
  clipboard_read: "clipboard",
  list_tabs: "tabs",
  search_history: "history",
  search_bookmarks: "bookmarks",
  read_file: "local_file",
  read_library: "local_file",
  run_shell: "shell_output",
};

/** 工具结果的来源标签；未列出的工具一律视为 tool_result（同样是数据） */
export function sourceLabel(toolName) {
  return SOURCE_BY_TOOL[toolName] || "tool_result";
}

export function createTaintState() {
  return { level: TAINT_CLEAN, sources: [], injection: null };
}

export function taintLevel(state) {
  if (typeof state === "string") return RANK[state] != null ? state : TAINT_CLEAN;
  return RANK[state?.level] != null ? state.level : TAINT_CLEAN;
}

export function isTainted(state) {
  return taintLevel(state) !== TAINT_CLEAN;
}

function maxLevel(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

/** 记录一次数据读入，返回新状态 */
export function ingestData(state, { source = "tool_result", tool = "", origin = "" } = {}) {
  const cur = state || createTaintState();
  const key = `${source}|${tool}|${origin}`;
  const sources = cur.sources.some((s) => `${s.source}|${s.tool}|${s.origin}` === key)
    ? cur.sources
    : [...cur.sources, { source, tool, origin }].slice(-MAX_SOURCES);
  return { ...cur, level: maxLevel(cur.level, TAINT_DATA), sources };
}

/** 注入特征命中：升为高污染，保留第一次命中用于提示与审计 */
export function markHighTaint(state, hit = {}) {
  const cur = state || createTaintState();
  return {
    ...cur,
    level: TAINT_HIGH,
    injection: cur.injection || { tool: hit.tool || "", match: hit.match || "", excerpt: hit.excerpt || "" },
  };
}

export function describeTaint(state) {
  const level = taintLevel(state);
  if (level === TAINT_HIGH) return "高污染：外部内容疑似含提示词注入";
  if (level === TAINT_DATA) return "已读入外部数据";
  return "未读入外部数据";
}
