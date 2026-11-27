import { NATIVE_HOST_NAME } from "../../lib/native-host.js";
import { isMxSellerManageReturn, runMxDraftJob, runMxDraftRead } from "./tiktok-mx-editor.mjs";
import { SELLER_LOGIN_ERROR, isSellerLoginUrl, mxManageUrl, mxSellerRequest, mxSellerUrlAllowed } from "./tiktok-mx-seller-request.mjs";

const tools = new Set(["open_tab", "list_tabs", "close_tab", "run_js", "reload_tab", "activate_tab",
  "wait_for", "upload_file", "trusted_type", "press_keys", "navigate_tab"]);
const seller = "https://seller.tiktokshopglobalselling.com";
const productId = /^\d{12,22}$/;
const sellerTools = new Set(["open_tab", "list_tabs", "close_tab", "run_js", "reload_tab", "activate_tab",
  "wait_for", "trusted_type", "press_keys", "navigate_tab"]);
const orderTools = new Set(["open_tab", "list_tabs", "close_tab", "run_js", "reload_tab"]);
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

export function repairDraftRequest({ sourceId, draftId, repair, queries }) {
  if (![sourceId, draftId].every(id => typeof id === "string" && productId.test(id)))
    throw Error("Expected numeric source and draft IDs for TikTok draft repair");
  if (repair !== "attributes" && repair !== "category") throw Error("Expected repair mode attributes or category");
  if (queries !== undefined && (repair !== "category" || !Array.isArray(queries) || !queries.length ||
      queries.length > 6 || !queries.every(query => typeof query === "string" && query.trim() && query.length <= 35)))
    throw Error("Category queries must contain one to six nonempty search terms of at most 35 characters");
  return { sourceId, draftId, repair, ...(queries !== undefined && { queries }) };
}

export function createDraftTransport(sourceId, call, tabUrl, { draftId } = {}) {
  if (draftId !== undefined && (typeof draftId !== "string" || !productId.test(draftId))) throw Error("Invalid repair draft ID");
  const repairUrl = draftId && `${seller}/product/edit-draft/${draftId}?shop_region=MX`;
  const allowedDestination = value => repairUrl ? value === repairUrl : allowedDraftUrl(value, sourceId);
  const owned = new Set();
  async function assertNotSellerLogin() {
    for (const id of owned) {
      let u;
      try { u = await tabUrl(id); } catch { continue; }
      if (isSellerLoginUrl(u)) throw Error(SELLER_LOGIN_ERROR);
    }
  }
  async function dispatch(tool, args) {
    if (!tools.has(tool) || (repairUrl && tool === "upload_file")) throw Error("Unexpected draft tool " + tool);
    if (tool === "navigate_tab" && !allowedDestination(args.url)) throw Error("Unexpected draft destination");
    if (tool === "open_tab") {
      const background = args.backgroundUrls || [];
      if ((repairUrl && background.length) || ![args.url, ...background].every(allowedDestination) ||
          (args.groupWithTab != null && !owned.has(args.groupWithTab))) throw Error("Unexpected draft destination");
    } else if (tool !== "list_tabs" && !owned.has(args.tabId)) throw Error("Tab outside draft task");
    else if (tool !== "list_tabs" && (repairUrl || tool !== "close_tab")) {
      const currentUrl = await tabUrl(args.tabId);
      if (tool !== "close_tab" && isSellerLoginUrl(currentUrl)) throw Error(SELLER_LOGIN_ERROR);
      const reopening = isMxSellerManageReturn(currentUrl) &&
        (tool === "activate_tab" || (tool === "navigate_tab" && /^\/product\/edit-draft\/\d+$/.test(new URL(args.url).pathname)));
      const cleanup = repairUrl && tool === "close_tab" && (isMxSellerManageReturn(currentUrl) || isSellerLoginUrl(currentUrl));
      const transientError = !repairUrl && ["activate_tab", "reload_tab", "navigate_tab"].includes(tool) &&
        (currentUrl === "about:blank" || String(currentUrl || "").startsWith("chrome-error://"));
      if (!reopening && !cleanup && !transientError && !allowedDestination(currentUrl))
        throw Error("Task tab navigated outside draft workflow");
    }
    const effectiveArgs = tool === "open_tab" && (args?.groupTitle != null || args?.groupWithTab != null)
      ? { ...args, newWindow: true }
      : args;
    const reply = await call(tool, effectiveArgs);
    if (!reply.ok) throw Error(reply.error?.message || JSON.stringify(reply.error));
    if (tool === "open_tab") for (const id of [reply.result.tabId, ...(reply.result.backgroundTabIds || [])]) owned.add(id);
    if (tool === "list_tabs") {
      await assertNotSellerLogin();
      return { ...reply, result: reply.result.filter(t => owned.has(t.id) &&
        (!repairUrl || t.url === repairUrl || isMxSellerManageReturn(t.url))) };
    }
    if (tool === "close_tab") owned.delete(args.tabId);
    return reply;
  }
  return async job => {
    if (job.action === "bridge_call") return (await dispatch(job.request.tool, job.request.args)).result;
    if (!owned.has(job.tabId)) throw Error("Unowned editor");
    if (repairUrl && (job.action !== "read_mx_draft" || job.url !== repairUrl)) throw Error("Unexpected repair action or draft URL");
    if (job.action === "fill_mx_draft") return runMxDraftJob(job, dispatch, tabUrl);
    if (["read_mx_draft", "refresh_mx_draft_list"].includes(job.action)) return runMxDraftRead(job, dispatch, tabUrl);
    throw Error("Unexpected draft action");
  };
}

export function createMxSellerTransport(parameters, call, tabUrl) {
  const owned = new Set();
  const allowedTools = parameters.mode === "read_orders" ? orderTools : sellerTools;
  const allowed = (url, destination = false) => mxSellerUrlAllowed(parameters, url, { destination });
  return async job => {
    const { tool, args } = job.request || {};
    const delistHover = parameters.mode === "delist_listing" && tool === "hover";
    if (job.action !== "bridge_call" || (!allowedTools.has(tool) && !delistHover) || !args || typeof args !== "object")
      throw Error("Unexpected TikTok MX seller action or tool");
    if (tool === "open_tab") {
      if (!allowed(args.url, true) || (args.backgroundUrls != null && (!Array.isArray(args.backgroundUrls) || args.backgroundUrls.length)) ||
          (args.groupWithTab != null && !owned.has(args.groupWithTab))) throw Error("Unexpected TikTok MX seller destination");
    } else if (tool !== "list_tabs") {
      if (!owned.has(args.tabId)) throw Error("Tab outside TikTok MX seller task");
      let currentUrl;
      try { currentUrl = await tabUrl(args.tabId); }
      catch (error) {
        if (tool === "close_tab" && /\bNo tab with id\b/i.test(error?.message || "")) {
          owned.delete(args.tabId);
          throw Error("TAB_NOT_FOUND: TikTok MX seller task tab already closed");
        }
        throw error;
      }
      if (tool !== "close_tab" && isSellerLoginUrl(currentUrl)) throw Error(SELLER_LOGIN_ERROR);
      if (!(tool === "close_tab" && isSellerLoginUrl(currentUrl)) && !allowed(currentUrl))
        throw Error("Task tab navigated outside the TikTok MX seller scope");
      if (delistHover && (currentUrl !== mxManageUrl + "&tab=active" ||
          !/^button\[data-pagelens-mx-delist="[a-f0-9-]{36}"\]$/i.test(args.selector) ||
          Object.keys(args).some(key => !["tabId", "selector"].includes(key))))
        throw Error("Expected the marked product dropdown on the active MX seller list");
      if (tool === "navigate_tab" && !allowed(args.url, true)) throw Error("Unexpected TikTok MX seller destination");
    }
    const effectiveArgs = tool === "open_tab" && (args?.groupTitle != null || args?.groupWithTab != null)
      ? { ...args, newWindow: true }
      : args;
    const reply = await call(tool, effectiveArgs);
    if (!reply.ok) throw Error(reply.error?.message || JSON.stringify(reply.error));
    if (tool === "open_tab") owned.add(reply.result.tabId);
    if (tool === "close_tab") owned.delete(args.tabId);
    if (tool === "list_tabs") {
      for (const id of owned) {
        let u;
        try { u = await tabUrl(id); } catch { continue; }
        if (isSellerLoginUrl(u)) throw Error(SELLER_LOGIN_ERROR);
      }
      return reply.result.filter(tab => owned.has(tab.id) && allowed(tab.url));
    }
    return reply.result;
  };
}

function draftOpening(job, action) {
  const { rate } = job;
  const repair = action === "ptc_repair_mx_draft" ? repairDraftRequest(job) : null;
  const sourceId = repair?.sourceId ?? (job.sourceUrl ? japaneseSourceId(job.sourceUrl) : job.sourceId);
  if (job.sourceId != null && job.sourceId !== sourceId) throw Error("Conflicting source identities");
  if (repair && job.token != null) throw Error("TikTok draft repair does not accept a token");
  if (!repair && (job.token != null || typeof sourceId !== "string" || !productId.test(sourceId) || !Number.isFinite(rate) || rate <= 0))
    throw Error("Expected a local draft request with a source ID and conversion rate");
  return repair ? { type: "mx.repair", ...repair } : { type: "mx.create", sourceId, rate };
}

export async function runNativeDraft(job, bridge) {
  const action = String(job.action || "").trim();
  const sellerAction = action === "ptc_mx_seller_action";
  if (sellerAction && job.token != null) throw Error("TikTok MX seller action does not accept a token");
  const opening = sellerAction ? { type: "mx.seller", request: mxSellerRequest(job.request) } : draftOpening(job, action);
  let step = 0;
  let failedMsg = "";
  const ownedEver = new Set();
  const ownedWindows = new Set();
  const call = async (tool, args) => {
    const reply = await bridge.call({ id: job.id + "." + ++step, tool, args });
    if (reply?.ok && tool === "open_tab") {
      for (const id of [reply.result?.tabId, ...(reply.result?.backgroundTabIds || [])]) {
        if (Number.isInteger(id)) ownedEver.add(id);
      }
      if (args?.newWindow === true && args?.groupWithTab == null && Number.isInteger(reply.result?.windowId)) {
        ownedWindows.add(reply.result.windowId);
      }
    }
    return reply;
  };
  const tabUrl = async id => { const t = await chrome.tabs.get(id); return t.url || t.pendingUrl; };
  const execute = sellerAction
    ? createMxSellerTransport(opening.request, call, tabUrl)
    : createDraftTransport(opening.sourceId, call, tabUrl, { draftId: opening.draftId });
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  const task = sellerAction ? "TikTok MX seller action" : "Native draft";
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const fail = err => { failedMsg = String(err?.message || err || ""); reject(err); };
      timer = setTimeout(() => fail(Error(task + " timed out; reconcile its receipt before retrying")), 300000);
      port.onDisconnect.addListener(() => fail(Error(chrome.runtime.lastError?.message ||
        (sellerAction ? "TikTok MX seller action host disconnected" : "Draft host disconnected"))));
      port.onMessage.addListener(msg => {
        if (msg.type === "mx.done") {
          if (msg.ok) resolve(msg.result);
          else fail(Error(msg.error));
        } else if (msg.type === "mx.tool") {
          execute(msg.job).then(result => port.postMessage({ type: "mx.tool_result", seq: msg.seq, ok: true, result }),
            e => port.postMessage({ type: "mx.tool_result", seq: msg.seq, ok: false, error: e.message })).catch(() => {});
        }
      });
      port.postMessage(opening);
    });
  } finally {
    clearTimeout(timer);
    port.disconnect();
    // The host leaves an unconfirmed draft's editor open for recovery.
    const preserveDraft = opening.type === "mx.create" && failedMsg &&
      !failedMsg.includes("SELLER_LOGIN_REQUIRED");
    if (!/verification|captcha|验证/i.test(failedMsg)) {
      for (const winId of ownedWindows) {
        try {
          const win = await chrome.windows?.get?.(winId, { populate: true });
          const tabs = win?.tabs || [];
          const onlyAutomation = tabs.every(t => {
            const u = String(t.url || t.pendingUrl || "");
            return ownedEver.has(t.id) || !u || u === "about:blank" || u.startsWith("chrome://newtab");
          });
          const pendingEditor = preserveDraft && tabs.some(t => ownedEver.has(t.id) &&
            /^https:\/\/seller\.tiktokshopglobalselling\.com\/product\/(?:create|edit-draft\/\d+)(?:\?|$)/.test(t.url || t.pendingUrl || ""));
          if (win && onlyAutomation && !pendingEditor) {
            const groupedIds = tabs.filter(t => t.groupId != null && t.groupId >= 0).map(t => t.id);
            if (groupedIds.length && typeof chrome.tabs?.ungroup === "function") {
              await chrome.tabs.ungroup(groupedIds).catch(() => {});
            }
            await chrome.windows.remove(winId).catch(() => {});
          }
        } catch {}
      }
    }
  }
}
