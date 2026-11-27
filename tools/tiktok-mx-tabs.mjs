import { setTimeout as sleep } from "node:timers/promises";
import { isMxSellerManageReturn } from "./tiktok-mx-editor.mjs";
import { SELLER_LOGIN_ERROR, isSellerLoginUrl } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

// Each owned tab is a working page. Dedicated automation windows isolate tabs by windowId without creating Chrome tab groups; non-windowed close_tab ungroups before removing.
export class DraftTabs {
  constructor(product, bridge) {
    if (!/^\d{12,22}$/.test(product)) throw Error("Invalid source ID");
    this.product = product;
    this.bridge = bridge;
    this.tabs = new Map();
    this.owned = new Set();
    this.pendingForm = null;
  }

  validate(url) {
    const page = new URL(url);
    const source = page.origin === "https://shop.tiktok.com" &&
      page.pathname.replace(/\/$/, "").split("/").pop() === this.product;
    const seller = page.origin === "https://seller.tiktokshopglobalselling.com" &&
      /^\/product\/(manage|create|edit-draft\/\d+)$/.test(page.pathname) &&
      page.searchParams.get("shop_region") === "MX";
    if (!source && !seller) throw Error("Unexpected product page");
    return page;
  }

  async open(url, backgroundUrls = [], active) {
    const page = this.validate(url);
    for (const related of backgroundUrls) this.validate(related);
    const anchor = this.owned.values().next().value;
    const { tabId, groupId, windowId, backgroundTabIds } = await this.bridge("open_tab", {
      url: page.href,
      active: active ?? (page.origin === "https://seller.tiktokshopglobalselling.com" && page.pathname !== "/product/manage"),
      ...(backgroundUrls.length && { backgroundUrls }),
      ...(anchor == null ? { groupTitle: "PageLens · MX " + this.product.slice(-6) } : { groupWithTab: anchor }),
    });
    this.owned.add(tabId);
    for (const [i, id] of (backgroundTabIds || []).entries()) {
      this.owned.add(id);
      this.tabs.set(backgroundUrls[i], id);
    }
    const grouped = Number.isInteger(groupId) && groupId >= 0;
    const windowed = !grouped && Number.isInteger(windowId) && windowId >= 0;
    if (!grouped && !windowed) throw Error("Chrome did not group or isolate the task tab");
    if (grouped) this.groupId = groupId;
    if (Number.isInteger(windowId) && windowId >= 0) this.windowId = windowId;
    this.tabs.set(url, tabId);
    return tabId;
  }

  async waitForUrl(tabId, url) {
    const deadline = Date.now() + 15000;
    do {
      const tab = (await this.bridge("list_tabs", {})).find(entry => entry.id === tabId);
      if (tab?.url === url) return tabId;
      if (isSellerLoginUrl(tab?.url)) throw Error(SELLER_LOGIN_ERROR);
      await sleep(150);
    } while (Date.now() < deadline);
    throw Error("Task tab did not finish navigating");
  }

  recordNavigation(tabId, url) {
    for (const [address, id] of this.tabs) if (id === tabId) this.tabs.delete(address);
    this.tabs.set(url, tabId);
  }

  async navigate(tabId, url) {
    const page = this.validate(url);
    if (!this.owned.has(tabId)) throw Error("Cannot navigate a tab outside the draft task");
    await this.bridge("navigate_tab", { tabId, url: page.href });
    this.recordNavigation(tabId, page.href);
    return this.waitForUrl(tabId, page.href);
  }

  async reopenSavedDraft(tabId, url) {
    const page = this.validate(url);
    if (!/^\/product\/edit-draft\/\d+$/.test(page.pathname)) throw Error("Expected a saved draft URL");
    const current = this.owned.has(tabId) && (await this.bridge("list_tabs", {})).find(tab => tab.id === tabId);
    // Seller Center may return to the draft list or close the editor on save.
    const sameScope = this.groupId >= 0
      ? current?.groupId === this.groupId
      : (this.windowId >= 0 && current?.windowId === this.windowId);
    if (current && sameScope) {
      if (current.url === page.href) {
        this.recordNavigation(tabId, page.href);
        return tabId;
      }
      if (this.tabs.get(current.url) === tabId || isMxSellerManageReturn(current.url))
        return this.navigate(tabId, page.href);
    }
    this.owned.delete(tabId);
    for (const [address, id] of this.tabs) if (id === tabId) this.tabs.delete(address);
    const background = await this.open(page.href, [], false);
    return this.waitForUrl(background, page.href);
  }

  async close() {
    const ids = [...this.owned].filter(id => id !== this.pendingForm);
    const results = await Promise.allSettled(ids.map(id => this.bridge("close_tab", { tabId: id })));
    const remaining = ids.length ? await this.bridge("list_tabs", {}) : [];
    for (const [index, id] of ids.entries()) {
      const result = results[index];
      if (remaining.some(t => t.id === id) || (result.status === "rejected" && !String(result.reason).includes("TAB_NOT_FOUND")))
        throw Error("Could not close task tab " + id + ": " + (result.reason || "still open"));
    }
    for (const id of ids) this.owned.delete(id);
    this.tabs.clear();
    if (this.pendingForm != null) console.error("Unconfirmed draft: kept editor tab " + this.pendingForm);
    else if (ids.length) console.error("PageLens group cleared (" + ids.length + " work tabs)");
  }
}
