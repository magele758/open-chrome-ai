// Each owned tab is a working page. Chrome removes the group with its last tab.
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
    const { tabId, groupId, backgroundTabIds } = await this.bridge("open_tab", {
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
    if (!Number.isInteger(groupId) || groupId < 0) throw Error("Chrome did not group the task tab");
    this.groupId = groupId;
    this.tabs.set(url, tabId);
    return tabId;
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
