import { setTimeout as sleep } from "node:timers/promises";
import { sellerVerification } from "../extension/skills/tiktok-mx-draft/tiktok-mx-list.mjs";
import { mxOrderStatuses, mxOrderUrl, mxSellerUrlAllowed } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

const statusLabels = {
  all: ["全部", "全部订单"],
  to_ship: ["待发货"],
  shipped: ["已发货"],
  completed: ["已完成"],
  cancelled: ["已取消"],
};
const transientNavigation = /frame (?:was removed|with ID 0 (?:was removed|does not exist))|execution context was destroyed|document unloaded/i;

function orderSnapshot(address, labels, requested, beforeReload, select) {
  const expected = new URL(address);
  const page = new URL(location.href);
  const regions = page.searchParams.getAll("shop_region");
  if (page.origin !== expected.origin || page.pathname !== expected.pathname || page.username || page.password || page.hash ||
      regions.length > 1 || (regions.length === 1 && regions[0] !== "MX"))
    throw Error("Unexpected seller order page");
  if (sellerVerification()) throw Error("Seller verification is required");
  if (document.readyState === "loading" || performance.timeOrigin === beforeReload) return null;

  const text = value => value?.replace(/\s+/g, " ").trim();
  const visible = element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length && style.visibility !== "hidden" && style.display !== "none";
  };
  const heading = [...document.querySelectorAll("h1,h2,h3,[role=heading],div,span")].some(element =>
    visible(element) && text(element.innerText) === "管理订单");
  if (!heading) return null;

  const candidates = [...document.querySelectorAll('button, a, [role=tab], [role=button], [class*="tabs-header-title"]')]
    .filter(element => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true")
    .flatMap(element => {
      const label = text(element.getAttribute("aria-label")) || text(element.innerText);
      const entry = Object.entries(labels).find(([, alternatives]) => alternatives.includes(label));
      return entry ? [{ element, status: entry[0] }] : [];
    });
  const tablists = [...document.querySelectorAll("[role=tablist]")].filter(list =>
    new Set(candidates.filter(({ element }) => list.contains(element)).map(({ status }) => status)).size > 1);
  if (tablists.length > 1) throw Error("Seller order status controls are ambiguous");
  const scoped = tablists[0] ? candidates.filter(({ element }) => tablists[0].contains(element)) : candidates;
  const controls = scoped.filter(({ element, status }) => !scoped.some(other =>
    other.status === status && other.element !== element && element.contains(other.element)));
  if (new Set(controls.map(({ status }) => status)).size !== controls.length)
    throw Error("Seller order status controls are ambiguous");

  const marked = controls.filter(({ element }) => {
    const tab = element.closest("[role=tab]") ?? element;
    return tab.getAttribute("aria-selected") === "true" ||
      ["page", "true"].includes(tab.getAttribute("aria-current")) ||
      ["active", "selected"].includes(tab.getAttribute("data-state")) ||
      [...tab.classList].some(name => /^(?:is-)?(?:active|selected)$|tabs?[-_][\w-]*[-_](?:active|selected)$/i.test(name));
  });
  if (marked.length > 1) throw Error("Seller shows multiple selected order statuses");
  const [urlTab, extraTab] = page.searchParams.getAll("tab");
  const knownUrlStatus = urlTab === "to_ship" ||
    (urlTab === "all" && !page.searchParams.has("order_status[]"));
  const urlStatus = knownUrlStatus && extraTab === undefined &&
    controls.some(({ status }) => status === urlTab) ? urlTab : null;
  const markedStatus = marked[0]?.status ?? null;
  if (markedStatus && urlStatus && markedStatus !== urlStatus) return null;
  const orderStatus = markedStatus ?? urlStatus;
  const supportedOptions = Object.keys(labels).filter(status => controls.some(control => control.status === status));
  if (!supportedOptions.length) return null;

  if (select && orderStatus !== requested) {
    if (document.readyState !== "complete") return null;
    const control = controls.find(({ status }) => status === requested);
    if (!control) throw Error("Requested seller order status is unavailable");
    control.element.click();
    return { clicked: true };
  }

  let count = null;
  if (beforeReload !== null && document.readyState === "complete" && orderStatus === requested &&
      ![...document.querySelectorAll('[aria-busy="true"],[role=progressbar]')].some(visible)) {
    const lines = (document.body?.innerText || "").split("\n").map(text);
    const totals = [...lines.join("\n").matchAll(/^(找到\s*)?(\d+|\d{1,3}(?:,\d{3})+)\s*个订单$/gm)];
    const counts = new Set(totals.map(([, , value]) => Number(value.replaceAll(",", ""))));
    const filtered = totals.some(([, prefix]) => Boolean(prefix));
    const empty = lines.includes("暂无订单");
    const total = counts.values().next().value;
    if (counts.size === 1 && Number.isSafeInteger(total) && (total === 0 ? filtered || empty : !empty)) count = total;
  }
  return { orderStatus, supportedOptions, count, timeOrigin: performance.timeOrigin };
}

async function poll(read, message) {
  const deadline = Date.now() + 12000;
  do {
    try {
      const result = await read();
      if (result) return result;
    } catch (error) {
      if (!transientNavigation.test(error.message)) throw error;
    }
    await sleep(150);
  } while (Date.now() < deadline);
  throw Error(message);
}

export async function readMxOrders(send, { orderStatus = "all", productId } = {}) {
  if (!mxOrderStatuses.includes(orderStatus)) throw Error("Unsupported seller order status");
  if (productId !== undefined) {
    if (typeof productId !== "string" || !/^\d{12,22}$/.test(productId)) throw Error("Invalid seller product ID");
    throw Error("Exact product ID order filtering is unavailable");
  }

  const { tabId } = await send("open_tab", { url: mxOrderUrl, active: false });
  if (!Number.isInteger(tabId) || tabId <= 0) throw Error("Seller order tab was not opened");
  const call = (tool, args = {}) => send(tool, { tabId, ...args });
  const read = async (beforeReload = null, select = false) => {
    const code = [sellerVerification, orderSnapshot].map(fn => fn.toString()).join("\n") +
      "\nreturn orderSnapshot(" + [mxOrderUrl, statusLabels, orderStatus, beforeReload, select].map(value => JSON.stringify(value)).join(",") + ");";
    const reply = await call("run_js", { code });
    if (!reply?.ok) {
      const error = reply?.error?.message ?? reply?.error;
      throw Error(typeof error === "string" ? error : "Seller order page could not be read");
    }
    return reply.result;
  };

  try {
    await poll(async () => {
      const tab = (await send("list_tabs", {})).find(tab => tab.id === tabId);
      if (!tab) return false;
      if (!mxSellerUrlAllowed({ mode: "read_orders" }, tab.url)) throw Error("Seller order tab reached an unexpected page");
      return true;
    }, "Seller order tab did not reach the order page");
    const initial = await poll(() => read(), "Seller order controls did not load");
    const isSelected = state => state?.orderStatus === orderStatus && Number.isFinite(state.timeOrigin);
    let clicks = 0;
    let nextClick = 0;
    const selected = isSelected(initial) ? initial : await poll(async () => {
      const state = await read();
      if (isSelected(state)) return state;
      if (!state || clicks >= 2 || Date.now() < nextClick) return null;
      const outcome = await read(null, true);
      if (outcome?.clicked) {
        clicks += 1;
        nextClick = Date.now() + 1000;
      }
      return isSelected(outcome) ? outcome : null;
    }, "Requested seller order status did not become selected");
    await call("reload_tab");

    let previous = null;
    const result = await poll(async () => {
      const state = await read(selected.timeOrigin);
      if (!state || state.orderStatus !== orderStatus || !Number.isSafeInteger(state.count) || !Number.isFinite(state.timeOrigin)) {
        previous = null;
        return null;
      }
      const same = previous && previous.timeOrigin === state.timeOrigin && previous.count === state.count &&
        previous.supportedOptions.join() === state.supportedOptions.join();
      previous = state;
      return same ? state : null;
    }, "Fresh seller order status or count could not be verified");

    return { verified: true, orderStatus, count: result.count, supportedOptions: result.supportedOptions };
  } finally {
    await call("close_tab");
  }
}
