import { NATIVE_HOST_NAME } from "../../lib/native-host.js";
import { runMxDraftJob, runMxDraftRead } from "./tiktok-mx-editor.mjs";

const tools = new Set(["open_tab", "list_tabs", "close_tab", "run_js", "reload_tab", "activate_tab",
  "wait_for", "upload_file", "trusted_type", "press_keys"]);
const seller = "https://seller.tiktokshopglobalselling.com";
export function japaneseSourceId(value) {
  const page = new URL(value);
  const match = page.pathname.match(/^\/jp\/pdp\/(?:[^/]+\/)?(\d{12,22})\/?$/);
  if (page.origin !== "https://shop.tiktok.com" || page.username || page.password || !match)
    throw Error("Expected a Japanese TikTok Shop product link");
  return match[1];
}

export function allowedDraftUrl(value, sourceId) {
  const u = new URL(value);
  if (u.origin === "https://shop.tiktok.com") return japaneseSourceId(u.href) === sourceId;
  return u.origin === seller && u.searchParams.get("shop_region") === "MX" &&
    (/^\/product\/(create|edit-draft\/\d+)$/.test(u.pathname) || (u.pathname === "/product/manage" && u.searchParams.get("tab") === "draft"));
}

export function createDraftTransport(sourceId, call, tabUrl) {
  const owned = new Set();
  async function dispatch(tool, args) {
    if (!tools.has(tool)) throw Error("Unexpected draft tool " + tool);
    if (tool === "open_tab") {
      if (![args.url, ...(args.backgroundUrls || [])].every(u => allowedDraftUrl(u, sourceId)) ||
          (args.groupWithTab != null && !owned.has(args.groupWithTab))) throw Error("Unexpected draft destination");
    } else if (tool !== "list_tabs" && !owned.has(args.tabId)) throw Error("Tab outside draft task");
    else if (tool !== "list_tabs" && tool !== "close_tab" && !allowedDraftUrl(await tabUrl(args.tabId), sourceId))
      throw Error("Task tab navigated outside draft workflow");
    const reply = await call(tool, args);
    if (!reply.ok) throw Error(reply.error?.message || JSON.stringify(reply.error));
    if (tool === "open_tab") for (const id of [reply.result.tabId, ...(reply.result.backgroundTabIds || [])]) owned.add(id);
    if (tool === "list_tabs") return { ...reply, result: reply.result.filter(t => owned.has(t.id)) };
    if (tool === "close_tab") owned.delete(args.tabId);
    return reply;
  }
  return async job => {
    if (job.action === "bridge_call") return (await dispatch(job.request.tool, job.request.args)).result;
    if (!owned.has(job.tabId)) throw Error("Unowned editor");
    if (job.action === "fill_mx_draft") return runMxDraftJob(job, dispatch, tabUrl);
    if (["read_mx_draft", "refresh_mx_draft_list"].includes(job.action)) return runMxDraftRead(job, dispatch, tabUrl);
    throw Error("Unexpected draft action");
  };
}

export async function runNativeDraft(job, bridge) {
  const { rate } = job;
  const sourceId = job.sourceUrl ? japaneseSourceId(job.sourceUrl) : job.sourceId;
  if (job.sourceId != null && job.sourceId !== sourceId) throw Error("Conflicting source identities");
  if (job.token != null || typeof sourceId !== "string" || !/^\d{12,22}$/.test(sourceId) || !Number.isFinite(rate) || rate <= 0)
    throw Error("Expected a local draft request with a source ID and conversion rate");
  let step = 0;
  const execute = createDraftTransport(sourceId, (tool, args) => bridge.call({ id: job.id + "." + ++step, tool, args }),
    async id => { const t = await chrome.tabs.get(id); return t.url || t.pendingUrl; });
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error("Native draft timed out; reconcile its receipt before retrying")), 300000);
      port.onDisconnect.addListener(() => reject(Error(chrome.runtime.lastError?.message || "Draft host disconnected")));
      port.onMessage.addListener(msg => {
        if (msg.type === "mx.done") {
          if (msg.ok) resolve(msg.result);
          else reject(Error(msg.error));
        } else if (msg.type === "mx.tool") {
          execute(msg.job).then(result => port.postMessage({ type: "mx.tool_result", seq: msg.seq, ok: true, result }),
            e => port.postMessage({ type: "mx.tool_result", seq: msg.seq, ok: false, error: e.message })).catch(() => {});
        }
      });
      port.postMessage({ type: "mx.create", sourceId, rate });
    });
  } finally { clearTimeout(timer); port.disconnect(); }
}
