/** 工具分类：只读 / 有副作用、作用于哪个 origin、属于哪类动作。纯函数，bridge 与侧栏共用。 */

/** 只读工具：不改页面、不外发、不碰本机文件；即使会话被标为高污染也免确认 */
export const READ_ONLY_TOOLS = new Set([
  "extract_page",
  "extract_pages",
  "get_page_info",
  "screenshot",
  "get_selection",
  "get_links",
  "find_in_page",
  "query_dom",
  "list_controls",
  "snapshot_controls",
  "wait_for",
  "wait_for_navigation",
  "scroll_page",
  "list_tabs",
  "get_captions",
  "seek_video",
  "highlight_quote",
  "search_tool_artifact",
  "read_tool_page",
  "list_companion_extensions",
  "request_toolsets",
  "get_settings",
  "list_downloads",
  "search_bookmarks",
  "search_history",
  "recently_closed_tabs",
  "recall",
  "library_info",
]);

/** 作用于已有标签、能读写页面或代用户输入的工具：目标与用户所在 origin 不同则需确认 */
export const ORIGIN_SCOPED_TAB_TOOLS = new Set([
  "run_js",
  "fill",
  "trusted_type",
  "trusted_click",
  "paste_into_page",
]);

/** 以 URL 发起请求的工具：URL 本身就能把数据带出去 */
export const ORIGIN_SCOPED_NAV_TOOLS = new Set(["open_tab", "navigate_tab"]);

/** 需要知道目标标签 URL 才能判断胶囊 / 出站 / 付款页的工具 */
export const TAB_TARGET_TOOLS = new Set([
  ...ORIGIN_SCOPED_TAB_TOOLS,
  "click",
  "select_option",
  "press_key",
  "press_keys",
  "act_element",
  "hover",
  "drag_drop",
  "upload_file",
  "handle_dialog",
  "switch_tab",
  "reload_tab",
  "close_tab",
]);

// run_js 里出现这些能力时，即使同源也可能外发数据或读凭据
export const RUN_JS_SENSITIVE_RE =
  /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|RTCPeerConnection|importScripts|eval|Function|postMessage|cookieStore)\b|document\s*\.\s*cookie|\b(local|session)Storage\b|\bindexedDB\b|\bimport\s*\(|\.\s*(src|href|action)\s*=(?!=)|\blocation\s*(\.\s*\w+\s*)?=(?!=)|\bwindow\s*\.\s*open\b/;

/** 胶囊里的动作类别 */
export const ACTION_CATEGORIES = Object.freeze([
  "navigate",
  "input",
  "publish",
  "send",
  "download",
  "upload",
  "shell",
  "write",
  "clipboard",
  "close",
  "delete",
  "settings",
  "automation",
  "purchase",
]);

const TOOL_CATEGORY = {
  open_tab: "navigate",
  navigate_tab: "navigate",
  switch_tab: "navigate",
  reload_tab: "navigate",
  restore_closed_tab: "navigate",
  web_search: "navigate",
  click: "input",
  fill: "input",
  select_option: "input",
  press_key: "input",
  press_keys: "input",
  act_element: "input",
  trusted_click: "input",
  trusted_type: "input",
  hover: "input",
  drag_drop: "input",
  paste_into_page: "input",
  handle_dialog: "input",
  run_js: "input",
  cose_publish: "publish",
  download_file: "download",
  save_page_mhtml: "download",
  upload_file: "upload",
  run_shell: "shell",
  write_library: "write",
  save_session_note: "write",
  save_video_doc: "write",
  remember: "write",
  add_bookmark: "write",
  create_bookmark_folder: "write",
  bookmark_open_tabs: "write",
  clipboard_write: "clipboard",
  copy_selection: "clipboard",
  close_tab: "close",
  close_task_group: "close",
  update_settings: "settings",
  automa_execute: "automation",
};

/** 工具对应的动作类别；只读工具返回 "read"，未知工具返回 "" */
export function toolCategory(toolName, args = {}) {
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (toolName === "chrome_call") {
    return /remove|delete|clear/i.test(String(args?.method || "")) ? "delete" : /update|create|move/i.test(String(args?.method || "")) ? "write" : "read";
  }
  return TOOL_CATEGORY[toolName] || "";
}

export function urlOrigin(url) {
  try {
    const u = new URL(String(url || ""));
    return /^https?:$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
}

export function urlHost(url) {
  try {
    const u = new URL(String(url || ""));
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * 跨源判定：目标 origin 不明、与用户所在 origin 不同且未经用户放行时返回目标 origin（可能为空串），否则返回 null。
 */
export function crossOriginTarget({ targetUrl, userUrl, approvedOrigins, isAllowed } = {}) {
  const target = urlOrigin(targetUrl);
  const home = urlOrigin(userUrl);
  if (target && home && target === home) return null;
  if (target && approvedOrigins?.has?.(target)) return null;
  if (target && isAllowed?.(targetUrl)) return null;
  return target;
}

/** 判断工具是否属于高危特权类；origin 类工具需传 { targetUrl, userUrl, approvedOrigins } */
export function isToolPrivileged(toolName, args = {}, origin = {}) {
  if (toolName === "run_js" && RUN_JS_SENSITIVE_RE.test(String(args?.code || ""))) return true;
  if (ORIGIN_SCOPED_TAB_TOOLS.has(toolName) || ORIGIN_SCOPED_NAV_TOOLS.has(toolName)) {
    return crossOriginTarget(origin) !== null;
  }
  if (toolName === "run_shell") return true;
  if (toolName === "cose_publish") return true;
  if (toolName === "close_tab" || toolName === "close_task_group") return true;
  if (toolName === "write_library") return true;
  if (toolName === "automa_execute") return true;
  if (toolName === "download_file" || toolName === "upload_file") return true;
  if (toolName === "chrome_call") {
    const method = String(args?.method || "");
    if (/remove|delete|update/i.test(method)) return true;
  }
  return false;
}
