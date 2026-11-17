// Each owned tab is a working page. Chrome removes the group with its last tab.
export class DraftTabs {
  constructor(product, bridge) {
    if (!/^\d{12,22}$/.test(product)) throw Error("Invalid source ID");
    this.product = product;
    this.bridge = bridge;
    this.tabs = new Map();
    this.owned = new Set();
  }

  async open(url) {
    const page = new URL(url);
    const source = page.origin === "https://shop.tiktok.com" &&
      page.pathname.replace(/\/$/, "").split("/").pop() === this.product;
    const seller = page.origin === "https://seller.tiktokshopglobalselling.com" &&
      /^\/product\/(manage|create|edit-draft\/\d+)$/.test(page.pathname) &&
      page.searchParams.get("shop_region") === "MX";
    if (!source && !seller) throw Error("Unexpected product page");
    const anchor = this.owned.values().next().value;
    const { tabId, groupId } = await this.bridge("open_tab", {
      url: page.href,
      active: seller && page.pathname !== "/product/manage",
      ...(anchor == null ? { groupTitle: "PageLens · MX " + this.product.slice(-6) } : { groupWithTab: anchor }),
    });
    this.owned.add(tabId);
    if (!Number.isInteger(groupId) || groupId < 0) throw Error("Chrome did not group the task tab");
    this.tabs.set(url, tabId);
    return tabId;
  }

  async close() {
    const ids = [...this.owned];
    const results = await Promise.allSettled(ids.map(id => this.bridge("close_tab", { tabId: id })));
    const remaining = ids.length ? await this.bridge("list_tabs", {}) : [];
    for (const [index, id] of ids.entries()) {
      const result = results[index];
      if (remaining.some(t => t.id === id) || (result.status === "rejected" && !String(result.reason).includes("TAB_NOT_FOUND")))
        throw Error("Could not close task tab " + id + ": " + (result.reason || "still open"));
    }
    this.owned.clear();
    this.tabs.clear();
    if (ids.length) console.error("PageLens group cleared (" + ids.length + " work tabs)");
  }
}
