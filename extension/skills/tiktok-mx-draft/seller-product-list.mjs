import { draftTitleOf, sellerVerification } from "./tiktok-mx-list.mjs";

// Identify a product using its ID in the product column and the state in the
// separate status column. A matching title or SKU is insufficient.
export function sellerProductRows(productId) {
  const text = element => element?.innerText?.trim() || "";
  const visible = element => Boolean(element?.getClientRects().length);
  const byText = (parent, selector, label) => [...parent.querySelectorAll(selector)]
    .filter(element => visible(element) && text(element) === label);
  const statusLabels = {
    "在售": "active", "审核中": "under_review", "已下架": "inactive", "草稿": "draft",
    "已删除": "deleted", "需要关注": "attention", "审核未通过": "attention",
  };
  const tables = [...document.querySelectorAll("table,[role=table]")].filter(visible);
  const records = [];
  let hasProducts = false;
  for (const table of tables) {
    const headers = [...table.querySelectorAll("th,[role=columnheader]")];
    const productColumn = headers.findIndex(header => text(header) === "商品");
    const statusColumn = headers.findIndex(header => text(header) === "状态");
    if (productColumn < 0 || statusColumn < 0) continue;
    for (const row of table.querySelectorAll("tbody tr,[role=row]")) {
      if (!visible(row)) continue;
      const cells = [...row.querySelectorAll("td,[role=cell]")];
      const product = text(cells[productColumn]);
      const matches = [...product.matchAll(/^(?:(?:商品|产品)\s*)?ID\s*[:：]\s*(\d{12,22})\s*$/gim)];
      if (matches.length !== 1) continue;
      hasProducts = true;
      if (matches[0][1] !== productId) continue;
      const phrase = text(cells[statusColumn]);
      const label = Object.keys(statusLabels).find(value => phrase === value || phrase.startsWith(value + "\n") || phrase.startsWith(value + " "));
      records.push({ row, product, productId, status: statusLabels[label] || "unrecognized", statusLabel: phrase,
        directDelist: byText(row, 'button,[role=button]', "下架"),
      });
    }
  }
  if (records.length > 1) throw Error("More than one visible seller row has this exact product ID");
  return { match: records[0], hasProducts };
}

export function observeOpenSellerList(productId, expectedUrl) {
  const unavailable = { productId, status: "unreadable", verified: false };
  if (location.href !== expectedUrl || sellerVerification()) return unavailable;
  const content = document.body?.innerText || "";
  const blocked = [...document.querySelectorAll('[aria-busy=true],[role=progressbar],[role=dialog],[aria-modal=true]')]
    .some(element => element.getClientRects().length);
  if (blocked || !content.includes("商品管理")) return unavailable;

  const { match, hasProducts } = sellerProductRows(productId);
  if (match?.status === "unrecognized") return unavailable;
  if (match) {
    const status = /^审核未通过(?:\s|$)/.test(match.statusLabel) ? "rejected" : match.status;
    return { productId, status, title: draftTitleOf(match.product), verified: true };
  }
  if (hasProducts || content.includes("暂无商品")) return { productId, status: "not_found", verified: false };
  return unavailable;
}
