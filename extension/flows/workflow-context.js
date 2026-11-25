import { workflowPlatforms } from "./catalog.js";
import { isTemuEnrollmentPage, temuSellerDataPage, TEMU_SELLER_OPERATIONS } from "./temu/seller-operations/routes.js";

const AMAZON_STOREFRONTS = new Set([
  "amazon.com", "amazon.ca", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it",
  "amazon.es", "amazon.co.jp", "amazon.com.au", "amazon.com.mx", "amazon.nl",
  "amazon.in", "amazon.se", "amazon.com.br", "amazon.pl", "amazon.sg",
]);

export function identifyWorkflowPage(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  const { hostname, pathname, origin, hash } = url;
  const site = hostname.replace(/^(?:www|m)\./u, "");
  const context = (platform, surface, productId, sourceUrl) => ({ platform, surface, productId, sourceUrl });
  if (hostname === "seller.shopee.cn") return context("shopee", "seller");
  if (origin === "https://sellerhub.shein.com") return context("shein", "seller");
  if (temuSellerDataPage(url.href)) return context("temu", "seller");
  if (/^agentseller(?:-[a-z0-9]+)?\.temu\.com$/u.test(hostname)) return context("temu", "seller");
  if (site === "temu.com") {
    const id = pathname.match(/-g-(\d+)\.html$/u)?.[1] ||
      (/\/(?:goods|goods\.html)\/?$/u.test(pathname) && url.searchParams.get("goods_id"));
    return context("temu", "retail", /^\d+$/u.test(id || "") ? id : undefined,
      id && `${origin}${pathname}${!pathname.includes("-g-") ? `?goods_id=${id}` : ""}`);
  }
  if (AMAZON_STOREFRONTS.has(site)) {
    const id = pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/iu)?.[1].toUpperCase();
    return context("amazon", "retail", id, id && `${origin}/dp/${id}`);
  }
  if (hostname === "erp.zhfulfill.com") {
    const query = hash.match(/^#\/catalog\/detail\/?\?(.+)$/u)?.[1];
    const id = query && new URLSearchParams(query).get("id");
    return context("zhfulfill", "catalog", /^\d+$/u.test(id || "") ? id : undefined,
      id && `${origin}/#/catalog/detail/?id=${id}`);
  }
  if (/^seller(?:-[a-z0-9]+)?\.tiktok\.com$/u.test(hostname)) return context("tiktok-shop", "seller");
  return null;
}

export function shortcutsForPage(url) {
  const page = identifyWorkflowPage(url);
  const platform = workflowPlatforms.find(item => item.id === page?.platform);
  const sellerPage = page?.platform === "temu" && page.surface === "seller" ? temuSellerDataPage(url) : null;
  const canStartTemuListing = /^https:\/\/agentseller\.temu\.com\/(?:goods\/(?:list|create\/category)\/?(?:[?#]|$)|[?#]|$)/u.test(url || "");
  const features = platform?.features.filter(feature => {
    if (feature.id === "product-capture") return Boolean(page.productId);
    if (page.surface !== "seller") return false;
    if (platform.id !== "temu") return true;
    if (feature.id === "temu-product-listing") return canStartTemuListing;
    if (feature.id === "temu-campaign-draft") return isTemuEnrollmentPage(url);
    return Boolean(sellerPage && TEMU_SELLER_OPERATIONS[feature.id]?.kind === sellerPage.kind);
  }) ?? [];
  return { page, platform, features };
}
