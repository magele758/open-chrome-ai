/** 下载、整页存档、最近关闭的标签、默认搜索引擎：对应 downloads / pageCapture / sessions / search 权限。 */

import { isHttpUrl, restrictedUrl, toToolText } from "../chrome.js";
import { ensureToolPermissions } from "../optional-permissions.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

export function safeRelativeFilename(name) {
  const cleaned = String(name || "")
    .replace(/[\\:*?"<>|\u0000-\u001f]/g, "_")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned.slice(0, 180);
}

async function blockRedirectedDownload(downloads, id, url) {
  if (typeof downloads.cancel === "function") {
    try { await downloads.cancel(id); } catch { /* 已经结束或已取消 */ }
  }
  if (typeof downloads.removeFile === "function") {
    try { await downloads.removeFile(id); } catch { /* 文件还没落到磁盘 */ }
  }
  if (typeof downloads.erase === "function") {
    try { await downloads.erase({ id }); } catch { /* 历史记录已经没有这一条 */ }
  }
  return {
    id,
    state: "blocked",
    filename: "",
    bytes: 0,
    mime: "",
    url,
    error: "EGRESS_NOT_ALLOWED",
    reason: `出站拦截：下载被重定向到未声明的目的地 ${url}`,
  };
}

function downloadRow(item) {
  return {
    id: item.id,
    state: item.state,
    filename: item.filename || "",
    bytes: item.fileSize ?? item.totalBytes ?? 0,
    mime: item.mime || "",
    error: item.error || undefined,
    url: item.finalUrl || item.url,
  };
}

/**
 * 等到下载结束。allowFinalUrl 只在最终 URL 和请求 URL 不同（发生了重定向）时调用；
 * 返回 false 则取消下载、删文件，并标成 EGRESS_NOT_ALLOWED。
 */
export async function waitForDownload(downloads, id, { timeoutMs = 30000, pollMs = 300, allowFinalUrl, requestedUrl = "" } = {}) {
  const started = Date.now();
  for (;;) {
    const [item] = await downloads.search({ id });
    if (!item) return { id, state: "missing" };
    if (typeof allowFinalUrl === "function") {
      const requested = String(requestedUrl || item.url || "").trim();
      const current = String(item.url || "").trim();
      const finalUrl = String(item.finalUrl || "").trim();
      const landed = finalUrl || (current && current !== requested ? current : "");
      if (landed && requested && landed !== requested && !(await allowFinalUrl(landed))) {
        return blockRedirectedDownload(downloads, id, landed);
      }
    }
    if (item.state !== "in_progress" || Date.now() - started >= timeoutMs) return downloadRow(item);
    await sleep(pollMs);
  }
}

export function createBrowserApiTools(ctx, { resolveTabId, api = globalThis.chrome, pollMs = 300, allowDownloadUrl } = {}) {
  const missing = (name) => `当前环境没有 chrome.${name}，请在扩展里重新加载以获得新权限。`;
  const startDownload = async (options, timeoutMs, allowFinalUrl) => {
    const id = await api.downloads.download({ conflictAction: "uniquify", saveAs: false, ...options });
    return waitForDownload(api.downloads, id, { timeoutMs, pollMs, allowFinalUrl, requestedUrl: options.url });
  };

  return [
    {
      name: "download_file",
      description:
        "把一个 http(s) 链接下载到本机下载目录，等完成后返回本机绝对路径（可交给 upload_file 上传，或用 read_file 读取）。filename 可选，只能是下载目录下的相对路径。若被重定向到未声明的目的地，会取消下载。",
      parameters: obj(
        {
          url: { type: "string" },
          filename: { type: "string", description: "保存名，如 reports/a.pdf" },
          timeoutMs: { type: "integer", description: "最长等待，默认 30000，最大 120000" },
        },
        ["url"],
      ),
      async execute(args, hooks = {}) {
        const denied = await ensureToolPermissions(["downloads"]);
        if (denied) return denied;
        if (!api.downloads?.download) return missing("downloads");
        const url = String(args?.url || "");
        if (!isHttpUrl(url)) return "只能下载 http(s) 链接。";
        const filename = safeRelativeFilename(args?.filename);
        const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 30000, 2000), 120000);
        const allowFinalUrl = hooks.allowFinalUrl || allowDownloadUrl;
        try {
          return toToolText(await startDownload({ url, ...(filename ? { filename } : {}) }, timeoutMs, allowFinalUrl));
        } catch (err) {
          return `下载失败：${err?.message || err}`;
        }
      },
    },
    {
      name: "list_downloads",
      description: "列出最近的下载（文件名、状态、大小、来源）。query 按文件名或网址过滤。",
      parameters: obj({
        query: { type: "string" },
        limit: { type: "integer", description: "默认 10，最大 30" },
      }),
      async execute(args) {
        const denied = await ensureToolPermissions(["downloads"]);
        if (denied) return denied;
        if (!api.downloads?.search) return missing("downloads");
        const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 30);
        const query = String(args?.query || "").trim();
        const rows = await api.downloads.search({
          ...(query ? { query: [query] } : {}),
          orderBy: ["-startTime"],
          limit,
        });
        return toToolText(
          rows.map((d) => ({
            id: d.id,
            state: d.state,
            filename: d.filename,
            bytes: d.fileSize ?? d.totalBytes ?? 0,
            url: d.finalUrl || d.url,
            startTime: d.startTime,
          })),
        );
      },
    },
    {
      name: "save_page_mhtml",
      description: "把标签页完整存成单个 MHTML 文件（含样式和图片，离线可看），返回本机路径。",
      parameters: obj({ tabId: { type: "integer", minimum: 1 } }),
      async execute(args) {
        const denied = await ensureToolPermissions(["pageCapture", "downloads"]);
        if (denied) return denied;
        if (!api.pageCapture?.saveAsMHTML) return missing("pageCapture");
        const tabId = await resolveTabId(args);
        const tab = await api.tabs.get(tabId);
        if (restrictedUrl(tab.url)) return `受限页，无法存档：${tab.url || ""}`;
        const blob = await new Promise((resolve, reject) => {
          api.pageCapture.saveAsMHTML({ tabId }, (data) => {
            const err = api.runtime?.lastError;
            if (err || !data) reject(new Error(err?.message || "存档失败"));
            else resolve(data);
          });
        });
        const objectUrl = URL.createObjectURL(blob);
        try {
          const name = safeRelativeFilename(tab.title || "page") || "page";
          return toToolText(await startDownload({ url: objectUrl, filename: `PageLens/${name}.mhtml` }, 30000));
        } finally {
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60000).unref?.();
        }
      },
    },
    {
      name: "recently_closed_tabs",
      description: "列出最近关闭的标签/窗口（可恢复）。用户说「刚才关掉的那个页面」时用。",
      parameters: obj({ limit: { type: "integer", description: "默认 10，最大 25" } }),
      async execute(args) {
        const denied = await ensureToolPermissions(["sessions"]);
        if (denied) return denied;
        if (!api.sessions?.getRecentlyClosed) return missing("sessions");
        const maxResults = Math.min(Math.max(Number(args?.limit) || 10, 1), 25);
        const rows = await api.sessions.getRecentlyClosed({ maxResults });
        return toToolText(
          rows.map((s) =>
            s.tab
              ? { sessionId: s.tab.sessionId, kind: "tab", title: s.tab.title, url: s.tab.url, closedAt: s.lastModified }
              : { sessionId: s.window?.sessionId, kind: "window", tabs: s.window?.tabs?.length || 0, closedAt: s.lastModified },
          ),
        );
      },
    },
    {
      name: "restore_closed_tab",
      description: "恢复 recently_closed_tabs 里的某个标签或窗口。",
      parameters: obj({ sessionId: { type: "string" } }, ["sessionId"]),
      async execute(args) {
        const denied = await ensureToolPermissions(["sessions"]);
        if (denied) return denied;
        if (!api.sessions?.restore) return missing("sessions");
        const restored = await api.sessions.restore(String(args.sessionId));
        const tab = restored?.tab;
        return toToolText({ ok: true, tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : undefined, windowId: restored?.window?.id });
      },
    },
    {
      name: "web_search",
      description: "用浏览器默认搜索引擎搜索，结果在新标签打开（之后用 extract_page 读结果页）。",
      parameters: obj({
        text: { type: "string" },
        newTab: { type: "boolean", description: "默认 true；false 则替换当前标签" },
      }),
      async execute(args) {
        const denied = await ensureToolPermissions(["search"]);
        if (denied) return denied;
        if (!api.search?.query) return missing("search");
        const text = String(args?.text || "").trim();
        if (!text) return "搜索词不能为空。";
        await api.search.query({ text, disposition: args?.newTab === false ? "CURRENT_TAB" : "NEW_TAB" });
        return `已用默认搜索引擎搜索「${text.slice(0, 60)}」。`;
      },
    },
  ];
}
