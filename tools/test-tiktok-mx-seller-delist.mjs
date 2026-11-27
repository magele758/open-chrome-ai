import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { sellerListCode } from "../native/mx-seller-page.mjs";
import { createMxSellerTransport } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";
import { mxManageUrl } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

const productId = "1738630710999877196";
const otherId = "1738630711000270412";
const active = mxManageUrl + "&tab=active";
const inactive = mxManageUrl + "&tab=deactivate";
const marker = randomUUID();
const prefix = 'button[data-pagelens-mx-delist';
const label = "下架的商品将在你的店铺中隐藏，不再供客户选购";
const menuItem = (attributes = "") => `<div role="menuitem" data-tid="m4b_dropdown_menu_item" ${attributes}>下架</div>`;
const modal = (title = "下架 1 款商品？", attributes = "") => `<div role="dialog"><h2>${title}</h2>
  <p>${label}</p><button>取消</button><button ${attributes}>下架</button></div>`;
const row = (id, trigger, prefix = "ID", edit = "") => `<tr><td>Mismo título\n${prefix}: ${id}</td>
  <td>在售</td><td>${trigger}${edit}</td></tr>`;
const more = id => `<button id="more-${id}" data-tid="m4b_dropdown_button" aria-controls="menu-${id}">
  <svg class="arco-icon-more"></svg></button>`;

function sellerPage(rows) {
  const dom = new JSDOM(`<h1>商品管理</h1><table><thead><tr><th>商品</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`, { url: active, runScripts: "outside-only" });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  window.HTMLElement.prototype.getClientRects = () => ({ length: 1 });
  return {
    document: window.document,
    insert(html) {
      window.document.body.insertAdjacentHTML("beforeend", html);
      return window.document.body.lastElementChild;
    },
    async run(operation, nonce = marker) {
      const code = sellerListCode(active, productId, operation, nonce);
      assert.ok(code.length <= 8000, "generated script fits the extension's run_js limit");
      return window.eval("(async()=>{" + code + "})()");
    },
    close() { window.close(); },
  };
}

function portal(page, id, contents = menuItem()) {
  return page.insert(`<div role="menu" id="menu-${id}">${contents}</div>`);
}

{
  const page = sellerPage(row(otherId, more(otherId)) + row(productId, more("decoy"), "SKU ID") +
    row(productId, more(productId), "ID", '<button><svg class="arco-icon-edit"></svg></button>'));
  assert.equal((await page.run("read")).canEdit, true);
  const ready = await page.run("prepare_delist");
  assert.equal(ready.productId, productId);
  assert.ok(ready.selector.startsWith(prefix));
  assert.equal(page.document.querySelector(ready.selector).id, "more-" + productId);
  let currentUrl = active;
  let selections = 0;
  let confirmations = 0;
  const call = async (tool, args) => {
    if (tool === "open_tab") return { ok: true, result: { tabId: 11 } };
    assert.equal(tool, "hover");
    assert.equal(page.document.querySelector(args.selector).id, "more-" + productId);
    const menu = portal(page, productId);
    menu.querySelector('[role="menuitem"]').onclick = () => {
      selections++;
      menu.remove();
      const dialog = page.insert(modal());
      dialog.querySelector("button:last-child").onclick = () => {
        confirmations++;
        dialog.remove();
      };
    };
    return { ok: true, result: { ok: true } };
  };
  const dispatch = createMxSellerTransport({ mode: "delist_listing", productId }, call, async () => currentUrl);
  const run = (tool, args) => dispatch({ action: "bridge_call", request: { tool, args } });
  await run("open_tab", { url: active });
  await assert.rejects(run("hover", { tabId: 12, selector: ready.selector }), /outside TikTok MX seller task/);
  await assert.rejects(run("hover", { tabId: 11, selector: "button" }), /marked product dropdown/);
  await assert.rejects(run("hover", { tabId: 11, selector: ready.selector, x: 1, y: 1 }), /marked product dropdown/);
  currentUrl = inactive;
  await assert.rejects(run("hover", { tabId: 11, selector: ready.selector }), /active MX seller list/);
  currentUrl = active;
  await run("hover", { tabId: 11, selector: ready.selector });
  const signal = await page.run("click_delist");
  assert.equal(signal.dispatched, true);
  assert.equal(signal.confirmationReady, true);
  assert.equal(selections, 1);
  await assert.rejects(page.run("confirm_delist", randomUUID()), /No verified single-product/);
  assert.equal((await page.run("confirm_delist")).confirmed, true);
  assert.equal(confirmations, 1);
  await assert.rejects(page.run("confirm_delist"), /No verified single-product/);

  const statusOnly = createMxSellerTransport({ mode: "listing_status", productId }, call, async () => active);
  await assert.rejects(statusOnly({ action: "bridge_call", request: { tool: "hover", args: { tabId: 11, selector: ready.selector } } }),
    /Unexpected TikTok MX seller action or tool/);
  page.close();
}

{
  const page = sellerPage(row(productId, more(productId)));
  portal(page, otherId);
  await assert.rejects(page.run("prepare_delist"), /unexpected seller dropdown/);
  page.close();
}

for (const [id, contents] of [[otherId, menuItem()], [productId, menuItem() + menuItem()],
  [productId, menuItem('aria-disabled="true"')]]) {
  const page = sellerPage(row(productId, more(productId)));
  await page.run("prepare_delist");
  const menu = portal(page, id, contents);
  menu.onclick = () => assert.fail("the unbound, ambiguous, or disabled menu must not be selected");
  await assert.rejects(page.run("click_delist"), /No unique enabled delist item/);
  page.close();
}

{
  const page = sellerPage(row(productId, more(productId)));
  await page.run("prepare_delist");
  page.document.querySelector("td:nth-child(2)").textContent = "审核中";
  const menu = portal(page, productId);
  menu.onclick = () => assert.fail("the product is now in review");
  await assert.rejects(page.run("click_delist"), /exact product as active/);
  page.close();
}

{
  const page = sellerPage(row(productId, '<button id="direct">下架</button>'));
  page.document.getElementById("direct").onclick = () => {
    const dialog = page.insert(modal("下架 2 款商品？"));
    dialog.onclick = () => assert.fail("a multi-product dialog must never be confirmed");
  };
  const signal = await page.run("prepare_delist");
  assert.match(signal.dialog, /下架 2 款商品/);
  assert.equal(signal.confirmationReady, undefined);
  await assert.rejects(page.run("confirm_delist"), /No verified single-product/);
  page.close();
}

assert.throws(() => sellerListCode(inactive, productId, "prepare_delist", marker), /active MX seller list/);
console.log("PASS exact active row hover, owned dropdown, and one-product delist confirmation");
