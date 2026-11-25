import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { editorSubmitCode, editorAdvisoryConfirmCode, sellerListCode } from "../native/mx-seller-page.mjs";
import { mxManageUrl, mxDraftUrl, mxSellerRequest, mxSellerUrlAllowed } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

const productId = "1738630710999877196";
const otherId = "1738630711000270412";
const active = mxManageUrl + "&tab=active";
const draft = mxDraftUrl(productId);

function sellerDocument(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
  });
  dom.window.HTMLElement.prototype.getClientRects = () => ({ length: 1 });
  return {
    window: dom.window, document: dom.window.document,
    run(code) { return dom.window.eval("(async()=>{" + code + "})()"); },
  };
}

function productRow(id, state, prefix = "ID") {
  return `<tr><td>Un título igual\n${prefix}:${id}</td><td>${state}</td><td><button id="x${id}">下架</button></td></tr>`;
}

const table = rows => `<h1>商品管理</h1><table><thead><tr><th>商品</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;

{
  const page = sellerDocument(table(productRow(otherId, "在售") + productRow(productId, "审核中 今日")), active);
  const observed = await page.run(sellerListCode(active, productId));
  assert.equal(observed.productId, productId);
  assert.equal(observed.status, "under_review");
  await assert.rejects(page.run(sellerListCode(active, productId, "delist")), /no longer in the active state/);
  page.window.close();
}
{
  const page = sellerDocument(table(productRow(otherId, "在售") + productRow(productId, "在售", "SKU ID") + productRow(productId, "在售")), active);
  const clicks = [];
  for (const button of page.document.querySelectorAll("button")) button.onclick = () => clicks.push(button.id);
  assert.equal((await page.run(sellerListCode(active, productId, "delist"))).dispatched, true);
  assert.deepEqual(clicks, ["x" + productId]);
  assert.equal((await page.run(sellerListCode(active, "123456789012", "delist"))).status, "not_found");
  page.window.close();
}
{
  const page = sellerDocument(table(productRow(productId, "在售") + productRow(productId, "在售")), active);
  await assert.rejects(page.run(sellerListCode(active, productId, "delist")), /More than one/);
  page.window.close();
}
{
  const page = sellerDocument("<button>提交审核</button>", draft);
  const button = page.document.querySelector("button");
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    page.document.body.insertAdjacentHTML("beforeend", '<div role="dialog">提交前请阅读并同意协议<button>同意</button></div>');
  };
  await assert.rejects(page.run(editorSubmitCode(mxDraftUrl(otherId), ["提交审核"])), /changed/);
  assert.match((await page.run(editorSubmitCode(draft, ["提交审核"]))).dialog, /同意协议/);
  await assert.rejects(page.run(editorSubmitCode(draft, ["提交审核"])), /unexpected seller dialog/);
  assert.equal(clicks, 1);
  page.window.close();
}
{
  const page = sellerDocument("<button>提交审核</button>", draft);
  const button = page.document.querySelector("button");
  button.onclick = () => page.document.body.insertAdjacentHTML("beforeend",
    '<div role="dialog">1 个问题可能需要优化 发品详情 建议 图片数量 上传至少 5 张商品图片以提高转化率。<button>返回编辑</button><button>提交</button></div>');
  assert.match((await page.run(editorSubmitCode(draft, ["提交审核"]))).dialog, /上传至少 5 张商品图片/);
  await assert.rejects(page.run(editorAdvisoryConfirmCode(mxDraftUrl(otherId))), /changed/);
  let confirmedClicks = 0;
  for (const control of page.document.querySelectorAll("button")) {
    if (control.textContent === "提交") control.onclick = () => {
      confirmedClicks++;
      control.closest('[role="dialog"]').remove();
      page.document.body.insertAdjacentHTML("beforeend",
        '<div class="arco-message-content">提交成功<a href="' + mxManageUrl + '">商品 ID: ' + otherId + "</a></div>");
    };
  }
  const confirmed = await page.run(editorAdvisoryConfirmCode(draft));
  assert.equal(confirmedClicks, 1);
  assert.equal(confirmed.advisoryConfirmed, true);
  assert.match(confirmed.messages.join(" "), /提交成功/);
  assert.equal(confirmed.productLinks.length, 1);
  page.window.close();
}
{
  const editUrl = "https://seller.tiktokshopglobalselling.com/product/edit/" + productId + "?shop_region=MX";
  const page = sellerDocument("<button>更新</button>", editUrl);
  const button = page.document.querySelector("button");
  button.onclick = () => {
    button.replaceWith(Object.assign(page.document.createElement("button"), { disabled: true, textContent: "更新" }));
    setTimeout(() => {
      page.document.body.innerHTML = '<div>商品提交成功\n更新成功.<a href="' + mxManageUrl + '">管理发品</a></div>';
    }, 150);
  };
  const updated = await page.run(editorSubmitCode(editUrl, ["更新", "保存", "提交审核"]));
  assert.equal(updated.messages.join(" "), "商品提交成功");
  assert.equal(updated.url, editUrl);
  page.window.close();
}
{
  const page = sellerDocument("<button>提交审核</button>", draft);
  page.document.body.insertAdjacentHTML("beforeend", '<div role="dialog">提交前请阅读并同意协议<button>同意</button></div>');
  await assert.rejects(page.run(editorAdvisoryConfirmCode(draft)), /not a confirmable advisory/);
  page.window.close();
}
{
  const page = sellerDocument("<button>提交审核</button>", draft);
  page.document.body.insertAdjacentHTML("beforeend",
    '<div role="dialog">建议 补充合规资质<button>返回编辑</button><button>提交</button><button>取消</button></div>');
  await assert.rejects(page.run(editorAdvisoryConfirmCode(draft)), /not a confirmable advisory/);
  page.window.close();
}
{
  const request = { mode: "publish_draft", sourceId: "1733781903228241493", draftId: productId };
  assert.throws(() => mxSellerRequest(request), /request fields/);
  const offer = { brand: "无品牌", packagedWeightGrams: 480, packageCm: { width: 14, height: 12, length: 24 },
    skus: [{ label: "Silver / 1 piece", stock: 1, priceMXN: 1200 }] };
  assert.equal(mxSellerRequest({ ...request, offer }).offer.skus[0].priceMXN, 1200);
  assert.throws(() => mxSellerRequest({ ...request, offer: { ...offer, skus: [{ label: "Silver", priceMXN: 1200 }] } }), /request fields/);
  assert.equal(mxSellerUrlAllowed(request, draft), true);
  assert.equal(mxSellerUrlAllowed(request, mxDraftUrl(otherId)), false);
  assert.equal(mxSellerUrlAllowed(request, active.replace("MX", "JP")), false);
  assert.equal(mxSellerUrlAllowed({ mode: "read_orders" }, "https://seller.tiktokshopglobalselling.com/order?tab=to_ship"), true);
  assert.equal(mxSellerUrlAllowed({ mode: "read_orders" }, "https://seller.tiktokshopglobalselling.com/order?shop_region=MX&shop_region=JP"), false);
}
{
  const request = { mode: "reprice_draft", sourceId: "1733781903228241493", draftId: productId,
    multiplier: 100, baselinePricesMXN: [{ label: "Silver / 1 piece", priceMXN: 120 }] };
  assert.deepEqual(mxSellerRequest(request), request);
  assert.deepEqual(mxSellerRequest({ ...request, maxTotalStock: 10 }), { ...request, maxTotalStock: 10 });
  assert.throws(() => mxSellerRequest({ ...request, maxTotalStock: 11 }), /stock limit/);
  assert.throws(() => mxSellerRequest({ ...request, multiplier: 1000 }), /multiplier/);
}
{
  const base = "https://seller.tiktokshopglobalselling.com/product/edit/" + productId;
  const editorUrl = base + "?__next_global_seller__=7494613388458952268&category_id=993800&field=undefined" +
    "&global_seller_id=7494613388458952268&online=1&root_category_id=600024&seller_id=7494613388458952268&shop_region=MX&tab=5";
  const request = { mode: "optimize_listing", productId, editorUrl, beforeTitle: "Título anterior", afterTitle: "Título nuevo" };
  assert.deepEqual(mxSellerRequest(request), request);
  assert.equal(mxSellerUrlAllowed(request, editorUrl), true);
  for (const address of [editorUrl.replace(productId, otherId), editorUrl + "&shop_region=MX",
    editorUrl + "&redirect=external", editorUrl.replace("shop_region=MX", "shop_region=JP")]) {
    assert.throws(() => mxSellerRequest({ ...request, editorUrl: address }), /edit link/);
  }
}

console.log("PASS exact product row, one-click submission, offer data and seller scope");
