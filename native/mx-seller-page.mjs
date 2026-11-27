import { draftTitleOf, normDraftTitle, sellerVerification } from "../tools/tiktok-mx-editor.mjs";
import { sellerProductRows } from "../extension/skills/tiktok-mx-draft/seller-product-list.mjs";
import { mxManageUrl } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

function describeSellerProduct({ row, product, productId, status, statusLabel }) {
  const editButtons = [...row.querySelectorAll("button:has(svg.arco-icon-edit)")].filter(button =>
    button.getClientRects().length && getComputedStyle(button).visibility === "visible");
  const canEdit = editButtons.length === 1 && !editButtons[0].disabled && editButtons[0].getAttribute("aria-disabled") !== "true";
  const editLinks = [...row.querySelectorAll("a[href]")].map(a => a.href).filter(href => {
    const url = new URL(href);
    return url.origin === location.origin && url.pathname === "/product/edit/" + productId &&
      url.searchParams.get("shop_region") === "MX";
  });
  return { productId, status, statusLabel, title: draftTitleOf(product), editLinks, canEdit };
}

async function runDelistAction(address, productId, operation, marker) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const visible = element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length && style.display !== "none" && style.visibility === "visible";
  };
  const text = element => (element.innerText ?? element.textContent).trim().replace(/\s+/g, " ");
  const enabled = element => !element.disabled && element.getAttribute("aria-disabled") !== "true";
  const dialogs = () => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
  const menuItems = () => [...document.querySelectorAll('div[role="menuitem"][data-tid="m4b_dropdown_menu_item"]')].filter(visible);
  const triggerAttribute = "data-pagelens-mx-delist";
  const confirmationAttribute = "data-pagelens-mx-delist-confirm";
  const selector = 'button[' + triggerAttribute + '="' + marker + '"]';
  const modalSelector = 'div[role="dialog"][' + confirmationAttribute + '="' + marker + '"]';
  const guard = () => {
    if (location.href !== address || sellerVerification()) throw Error("Seller active list changed or verification is required");
    const row = sellerProductRows(productId).match;
    if (!row || row.status !== "active") throw Error("Could not verify the exact product as active");
    return row;
  };
  const matchingConfirm = dialog => {
    if (!dialog.matches('div[role="dialog"]')) return null;
    const labels = new Set([...dialog.querySelectorAll("*")].filter(visible).map(text));
    if (!labels.has("下架 1 款商品？") || !labels.has("下架的商品将在你的店铺中隐藏，不再供客户选购")) return null;
    const actions = [...dialog.querySelectorAll("button")].filter(button => visible(button) && text(button));
    const cancel = actions.find(button => text(button) === "取消");
    const confirm = actions.find(button => text(button) === "下架");
    return actions.length === 2 && cancel && confirm && enabled(cancel) && enabled(confirm) ? confirm : null;
  };
  async function clickDelist(control) {
    const result = { productId, status: "active", dispatched: true };
    control.click();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (location.href !== address || sellerVerification()) return result;
      const current = dialogs();
      if (current.length) {
        result.dialog = current.map(text).join(" ").slice(0, 350);
        if (current.length === 1 && matchingConfirm(current[0])) {
          current[0].setAttribute(confirmationAttribute, marker);
          result.confirmationReady = true;
          return result;
        }
      }
      await pause();
    }
    return result;
  }

  const row = guard();
  const currentDialogs = dialogs();
  if (operation === "confirm_delist") {
    const dialog = currentDialogs[0];
    const confirm = currentDialogs.length === 1 && dialog.matches(modalSelector) && matchingConfirm(dialog);
    if (!confirm) throw Error("No verified single-product delist confirmation");
    dialog.removeAttribute(confirmationAttribute);
    confirm.click();
    return { productId, status: "active", dispatched: true, confirmed: true };
  }
  if (currentDialogs.length) throw Error("An unexpected seller dialog is open");
  if (operation === "prepare_delist") {
    if (menuItems().length || document.querySelector("[" + triggerAttribute + "]"))
      throw Error("An unexpected seller dropdown is open or prepared");
    const direct = row.directDelist.filter(visible);
    if (direct.length) {
      if (direct.length !== 1 || !enabled(direct[0])) throw Error("No unique enabled delist button on the exact product row");
      return clickDelist(direct[0]);
    }
    const buttons = [...row.row.querySelectorAll('button[data-tid="m4b_dropdown_button"]:has(svg.arco-icon-more)')].filter(visible);
    if (buttons.length !== 1 || !enabled(buttons[0])) throw Error("No unique enabled dropdown on the exact product row");
    buttons[0].setAttribute(triggerAttribute, marker);
    return { productId, status: "active", selector };
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const currentRow = guard();
    if (dialogs().length) throw Error("An unexpected seller dialog is open");
    const triggers = document.querySelectorAll(selector);
    const trigger = triggers[0];
    if (triggers.length !== 1 || !currentRow.row.contains(trigger) || !visible(trigger) || !enabled(trigger))
      throw Error("The prepared seller dropdown is no longer on the exact product row");
    const items = menuItems().filter(element => text(element) === "下架");
    if (items.length) {
      const owner = trigger.getAttribute("aria-controls");
      if (items.length !== 1 || !enabled(items[0]) ||
          (owner && !document.getElementById(owner)?.contains(items[0])))
        throw Error("No unique enabled delist item for the prepared seller dropdown");
      trigger.removeAttribute(triggerAttribute);
      return clickDelist(items[0]);
    }
    await pause();
  }
  throw Error("The prepared seller dropdown did not show a delist item");
}

export function sellerListCode(url, productId, operation = "read", marker) {
  if (["prepare_delist", "click_delist", "confirm_delist"].includes(operation)) {
    if (url !== mxManageUrl + "&tab=active" || typeof marker !== "string" || !/^[a-f0-9-]{36}$/i.test(marker))
      throw Error("Expected the active MX seller list and a delist marker");
    const helpers = [sellerVerification, sellerProductRows].map(fn => fn.toString()).join("\n");
    return helpers + "\nreturn await (" + runDelistAction.toString() + ")(" +
      [url, productId, operation, marker].map(value => JSON.stringify(value)).join(",") + ");";
  }
  const run = async (address, id, mode) => {
    const guard = () => {
      if (location.href !== address || sellerVerification()) throw Error("Seller product list changed or verification is required");
    };
    let previous = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      guard();
      const content = document.body?.innerText || "";
      const busy = [...document.querySelectorAll('[aria-busy=true],[role=progressbar]')].some(node => node.getClientRects().length);
      const loaded = !busy && content.includes("商品管理") &&
        (content.includes("暂无商品") || document.querySelector("tbody tr,[role=row] [role=cell]"));
      const row = loaded ? sellerProductRows(id).match : null;
      const current = row?.statusLabel || (loaded ? "absent" : null);
      if (current && current === previous) {
        if (!row) return { productId: id, status: "not_found", url: address };
        const { productId, status } = row;
        if (mode === "delist") {
          if (status !== "active") throw Error("The exact product is no longer in the active state");
          if (row.directDelist.length !== 1 || row.directDelist[0].disabled ||
              row.directDelist[0].getAttribute("aria-disabled") === "true")
            throw Error("No unique enabled delist button on the exact product row");
          if ([...document.querySelectorAll('[role=dialog],[aria-modal=true]')].some(el => el.getClientRects().length))
            throw Error("An unexpected seller dialog is open");
          row.directDelist[0].click();
          await new Promise(resolve => setTimeout(resolve, 450));
          const dialogs = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(el => el.getClientRects().length);
          const dialog = dialogs.map(el => el.innerText.trim()).join(" ").slice(0, 350);
          return { productId, status, dispatched: true, ...(dialog && { dialog }) };
        }
        return { ...describeSellerProduct(row), url: address };
      }
      previous = current;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error("Seller product management did not finish loading");
  };
  const helpers = [normDraftTitle, draftTitleOf, sellerVerification, sellerProductRows, describeSellerProduct]
    .map(fn => fn.toString()).join("\n");
  return helpers + "\nreturn await (" + run.toString() + ")(" +
    [url, productId, operation].map(x => JSON.stringify(x)).join(",") + ");";
}

// Only a visible, unique action in the exact editor can be triggered. Modal
// confirmations and legal agreements are recorded for the caller to resolve.
export function editorSubmitCode(url, labels) {
  const run = async (address, actions) => {
    const visible = el => Boolean(el?.getClientRects().length);
    const normalize = el => (el.innerText || el.textContent).trim().replace(/\s+/g, " ");
    const dialogs = () => [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(visible);
    const feedback = () => [...document.querySelectorAll('[class*=message-content],[role=alert]')].filter(visible);
    if (location.href !== address || sellerVerification()) throw Error("Seller editor changed or verification is required");
    if (dialogs().length) throw Error("An unexpected seller dialog is open");
    const controls = [...document.querySelectorAll("button")].filter(button => visible(button) && actions.includes(normalize(button)));
    if (controls.length !== 1 || controls[0].disabled || controls[0].getAttribute("aria-disabled") === "true")
      throw Error("Seller submit control is missing, disabled or ambiguous");
    const previous = new Set(feedback().map(normalize));
    const hadSuccess = /商品提交成功|更新成功|发布成功/.test(document.body?.innerText || "");
    controls[0].click();
    for (let attempt = 0; attempt < 45; attempt++) {
      if (sellerVerification()) return { verificationRequired: true };
      const dialog = dialogs().map(normalize).join(" ").slice(0, 350);
      if (dialog) return { dialog };
      const messages = feedback().map(normalize).filter(message => message && !previous.has(message));
      const pageSuccess = !hadSuccess && /商品提交成功|更新成功|发布成功/.test(document.body?.innerText || "");
      if (messages.length || location.href !== address || pageSuccess) {
        const productLinks = [...feedback().filter(element => /提交成功|发布成功/.test(normalize(element))),
          ...(pageSuccess ? [document.body] : [])]
          .flatMap(element => [...element.querySelectorAll("a[href]")])
          .map(link => link.href);
        return { messages: messages.length ? messages : (pageSuccess ? ["商品提交成功"] : []), url: location.href, productLinks };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { messages: [], url: location.href };
  };
  return sellerVerification.toString() + "\nreturn await (" + run.toString() + ")(" +
    JSON.stringify(url) + "," + JSON.stringify(labels) + ");";
}

// A seller advisory dialog (for example the at-least-5-images suggestion)
// offers 返回编辑 / 提交. Confirm the advisory once so the submission
// proceeds; every other dialog shape stays unresolved for the caller.
export function editorAdvisoryConfirmCode(url) {
  const run = async address => {
    const visible = el => Boolean(el?.getClientRects().length);
    const normalize = el => (el.innerText || el.textContent).trim().replace(/\s+/g, " ");
    const enabled = el => !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const dialogs = () => [...document.querySelectorAll('[role="dialog"],[aria-modal=true]')].filter(visible);
    const feedback = () => [...document.querySelectorAll('[class*=message-content],[role=alert]')].filter(visible);
    if (location.href !== address || sellerVerification()) throw Error("Seller editor changed or verification is required");
    const open = dialogs();
    if (open.length !== 1) throw Error("Expected exactly one seller dialog to confirm");
    const text = normalize(open[0]);
    const controls = [...open[0].querySelectorAll("button")].filter(visible)
      .map(element => ({ element, label: normalize(element) })).filter(({ label }) => label);
    const labels = controls.map(({ label }) => label);
    const back = labels.includes("返回编辑");
    const submit = controls.find(({ label }) => label === "提交")?.element;
    if (!/建议/.test(text) || labels.length !== 2 || !back || !submit || !enabled(submit))
      throw Error("The seller dialog is not a confirmable advisory");
    const previous = new Set(feedback().map(normalize));
    submit.click();
    for (let attempt = 0; attempt < 24; attempt++) {
      if (sellerVerification()) return { verificationRequired: true, advisoryConfirmed: true };
      const dialog = dialogs().map(normalize).join(" ").slice(0, 350);
      if (dialog && dialog !== text) return { dialog, advisoryConfirmed: true };
      const messages = feedback().map(normalize).filter(message => message && !previous.has(message));
      if (messages.length || location.href !== address) {
        const productLinks = feedback().filter(element => /提交成功|发布成功/.test(normalize(element)))
          .flatMap(element => [...element.querySelectorAll("a[href]")])
          .map(link => link.href);
        return { messages, url: location.href, productLinks, advisoryConfirmed: true };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { messages: [], url: location.href, advisoryConfirmed: true };
  };
  return sellerVerification.toString() + "\nreturn await (" + run.toString() + ")(" +
    JSON.stringify(url) + ");";
}
