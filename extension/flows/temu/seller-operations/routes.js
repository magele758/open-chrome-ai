const seller = "https://agentseller.temu.com";
const finance = "https://seller.kuajingmaihuo.com";
const ads = "https://ads.temu.com";

export const TEMU_SELLER_OPERATIONS = {
  "temu-campaign-data": {
    kind: "campaigns", title: "活动数据", href: seller + "/activity/marketing-activity",
    links: [
      { label: "营销活动", href: seller + "/activity/marketing-activity" },
      { label: "报名结果", href: seller + "/activity/marketing-activity/result" },
      { label: "报名记录", href: seller + "/activity/marketing-activity/log" },
    ],
  },
  "temu-marketing-data": {
    kind: "marketing", title: "营销数据", href: ads + "/index.html?adAreaOverride=2&source=2&seller_source=11",
  },
  "temu-order-data": {
    kind: "orders", title: "订单数据", href: seller + "/mmsos/orders.html",
  },
  "temu-finance-data": {
    kind: "finance", title: "资金数据", href: finance + "/labor/account",
    links: [
      { label: "资金中心", href: finance + "/labor/account" },
      { label: "对账中心", href: finance + "/labor/bill" },
      { label: "结算数据", href: finance + "/labor/settle" },
      { label: "资金限制", href: finance + "/labor/limited/list" },
    ],
  },
  "temu-product-data": {
    kind: "products", title: "商品数据", href: seller + "/goods/list",
  },
  "temu-campaign-draft": {
    kind: "enrollment", title: "活动报名试填", href: seller + "/activity/marketing-activity",
  },
};

export function temuSellerDataPage(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;

  const path = url.pathname.replace(/\/$/u, "");
  const { origin } = url;
  const key = origin + path;
  const route = href => new URL(href).origin + new URL(href).pathname;
  const operation = Object.values(TEMU_SELLER_OPERATIONS).find(item =>
    item.kind !== "enrollment" && (route(item.href) === key || item.links?.some(link => route(link.href) === key))
  );
  if (operation) return { kind: operation.kind, origin, path, url: url.href };
  if (key === seller + "/activity/marketing-activity/detail") return { kind: "campaigns", origin, path, url: url.href };
  if (key === finance + "/labor/finance") return { kind: "finance", origin, path, url: url.href };
  return null;
}

export function isTemuEnrollmentPage(url) {
  const page = temuSellerDataPage(url);
  return page?.origin === seller && ["/activity/marketing-activity", "/activity/marketing-activity/detail"].includes(page.path);
}
