import { id, version, replayShopeeListing } from "./listing.flow.mjs";

const origin = "https://seller.shopee.cn";
const path = "/portal/mtsku/new";

export function shopeeShopId(url, { listingOnly = false } = {}) {
  try {
    const target = new URL(url);
    const shops = target.searchParams.getAll("cnsc_shop_id");
    const sellerPage = listingOnly ? target.pathname === path : target.pathname.startsWith("/portal/");
    return target.origin === origin && !target.username && !target.password && sellerPage &&
      shops.length === 1 && /^\d+$/.test(shops[0]) ? shops[0] : "";
  } catch {
    return "";
  }
}

function matchesTarget(url, shopId) {
  const currentShop = shopeeShopId(url, { listingOnly: true });
  return Boolean(currentShop && (shopId == null || currentShop === shopId));
}

export const shopeeProductListing = {
  id,
  version,
  title: "Shopee 商品上架",
  origin,
  path,
  matchesTarget,
  replay: replayShopeeListing,
};
