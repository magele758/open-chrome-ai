import { mxManageUrl } from "../../skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

const manage = new URL(mxManageUrl);
const READ_TIMEOUT_MS = 5000;

function isMxAllProducts(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.origin === manage.origin && url.pathname === manage.pathname && !url.username && !url.password &&
    url.searchParams.getAll("shop_region").length === 1 && url.searchParams.get("shop_region") === "MX" &&
    url.searchParams.getAll("tab").length === 1 && url.searchParams.get("tab") === "all";
}

// Runs in Chrome's isolated world. Recheck after import in case the user switched
// lists while the packaged module was loading.
async function observe(productId, expectedUrl, since, expiresAt) {
  const unavailable = { productId, status: "unreadable", verified: false };
  if (location.href !== expectedUrl || Date.now() >= expiresAt) return unavailable;
  const documentAt = window.performance.timeOrigin;
  if (!Number.isFinite(documentAt) || documentAt <= 0) return unavailable;
  if (documentAt < since) return { productId, status: "stale_page", verified: false, documentAt };
  const moduleUrl = chrome.runtime.getURL("skills/tiktok-mx-draft/seller-product-list.mjs");
  const { observeOpenSellerList } = await import(moduleUrl);
  if (Date.now() >= expiresAt) return unavailable;
  return { ...observeOpenSellerList(productId, expectedUrl), documentAt };
}

async function scanOpenLists(productId, browser, since, expiresAt, signal) {
  const unavailable = { productId, status: "unreadable", verified: false };
  const tabs = (await browser.tabs.query({ url: manage.origin + manage.pathname + "*" }))
    .filter(tab => isMxAllProducts(tab.url));
  if (!tabs.length) return { productId, status: "no_page", verified: false };

  let matched;
  let absent;
  let stale;
  let unreadable = false;
  for (const tab of tabs) {
    if (signal.aborted || Date.now() >= expiresAt) return unavailable;
    if (!Number.isInteger(tab.id) || tab.discarded || tab.frozen || tab.pendingUrl || tab.status === "loading") {
      unreadable = true;
      continue;
    }
    try {
      const [frame] = await browser.scripting.executeScript({
        target: { tabId: tab.id }, func: observe, args: [productId, tab.url, since, expiresAt],
      });
      const reading = frame?.result;
      if (reading?.productId !== productId || !Number.isFinite(reading.documentAt)) unreadable = true;
      else if (reading.status === "stale_page") {
        if (!stale || stale.documentAt < reading.documentAt) stale = reading;
      } else if (reading.verified === true) {
        if (matched && (matched.status !== reading.status || matched.title !== reading.title)) return unavailable;
        if (!matched || matched.documentAt < reading.documentAt) matched = reading;
      } else if (reading.status === "not_found") {
        if (!absent || absent.documentAt < reading.documentAt) absent = reading;
      } else unreadable = true;
    } catch { unreadable = true; }
  }
  return matched ?? (unreadable ? unavailable : absent ?? stale ?? unavailable);
}

export async function readOpenMxApprovalStatus(productId, browser = chrome, since = 0) {
  if (typeof productId !== "string" || !/^\d{12,22}$/.test(productId)) throw Error("Expected an exact TikTok product ID");
  const unavailable = { productId, status: "unreadable", verified: false };
  const controller = new AbortController();
  const expiresAt = Date.now() + READ_TIMEOUT_MS;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(unavailable);
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([scanOpenLists(productId, browser, since, expiresAt, controller.signal), timeout]);
  } catch { return unavailable; }
  finally { clearTimeout(timer); }
}
