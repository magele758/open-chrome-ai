/** Edit only the independent details decoration dialog on a scoped Temu draft. */
export async function temuDecorationPage({ href, description = "", kind = "fill", hasImages, images = [] }) {
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const modalSelector = '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]';
  const modals = () => [...document.querySelectorAll(modalSelector)].filter(visible);
  const unique = items => items.length === 1 ? items[0] : null;
  const exact = (area, selector, label) => unique([...area.querySelectorAll(selector)]
    .filter(node => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && clean(node.textContent) === label));
  const buttons = 'button,[role="button"]';
  const decoration = () => {
    const candidates = modals().filter(node => [...node.querySelectorAll('h1,h2,h3,[role="heading"],span,div')]
      .some(heading => visible(heading) && heading.childElementCount === 0 && clean(heading.textContent) === "详情页装修"));
    return unique(candidates.filter(node => !candidates.some(other => node !== other && node.contains(other))));
  };
  const textControl = dialog => unique([...dialog.querySelectorAll('textarea[placeholder="请输入"]')]
    .filter(node => visible(node) && !node.disabled && !node.readOnly));
  const isOnlyDecoration = dialog => dialog && modals().every(node => node === dialog || node.contains(dialog));

  function imageIdentity(source) {
    try {
      const url = new URL(source);
      return url.protocol === "https:" ? url.origin + url.pathname : "";
    } catch { return ""; }
  }

  function imagesVerified(dialog) {
    if (!images.length) return hasImages !== true;
    const present = new Set([...dialog.querySelectorAll("img[src]")].filter(visible)
      .map(node => imageIdentity(node.currentSrc || node.src)).filter(Boolean));
    return images.every(source => present.has(imageIdentity(source)));
  }

  async function waitFor(resolve) {
    const deadline = Date.now() + 3000;
    do {
      if (!onPage()) return null;
      const result = resolve();
      if (result) return result;
      await new Promise(next => setTimeout(next, 45));
    } while (Date.now() < deadline);
    return null;
  }

  async function cancel(dialog) {
    if (decoration() !== dialog || !isOnlyDecoration(dialog)) return false;
    const button = exact(dialog, buttons, "取消");
    if (!button) return false;
    button.click();
    const done = await waitFor(() => {
      if (!decoration()) return { closed: true };
      const match = unique([...document.querySelectorAll("div,span,p")].filter(node =>
        visible(node) && !node.childElementCount && clean(node.textContent) === "确认直接退出吗？当前已填写内容将不会被保存"));
      // This confirmation is outside the decoration dialog on the live page.
      const confirmation = match && modals().filter(node => node.contains(match) && !node.contains(dialog));
      const area = confirmation && unique(confirmation.filter(node =>
        !confirmation.some(other => node !== other && node.contains(other))));
      const confirm = area && exact(area, buttons, "确认");
      return confirm && { confirm };
    });
    if (!done || done.closed) return Boolean(done);
    done.confirm.click();
    return Boolean(await waitFor(() => !decoration()));
  }

  function boundedText(input, value) {
    if (input.maxLength < 0 || value.length <= input.maxLength) return value;
    const prefix = value.slice(0, input.maxLength).replace(/[\uD800-\uDBFF]$/u, "");
    return prefix.trimEnd();
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品页已切换。");
  if (kind === "cancel") return { ok: await cancel(decoration()) };
  async function apply(text) {
    const active = decoration();
    if (!isOnlyDecoration(active)) return fail("MODAL_BLOCKED", "详情装修弹窗不在前台，请先核对。");
    if (!imagesVerified(active)) {
      return fail("DETAIL_IMAGE_REQUIRED", "没有在详情装修预览中核对到已选图片。");
    }
    if (text.trim() && textControl(active)?.value !== text) {
      return fail("READBACK_MISMATCH", "详情图文内容已变化。");
    }
    const save = exact(active, buttons, "保存");
    if (!save) return fail("DECORATION_UNVERIFIED", "找不到详情页装修弹窗内的保存按钮。");
    save.click();
    const outcome = await waitFor(() => {
      if (!decoration()) return { ok: true, status: "verified" };
      const imageRequired = [...document.querySelectorAll('div,span,[role="alert"]')].some(node =>
        visible(node) && !node.childElementCount && clean(node.textContent) === "详情图文需至少上传一张图片");
      return imageRequired ? fail("DETAIL_IMAGE_REQUIRED", "Temu 要求详情图文至少有一张图片。请选含详情图的商品目录，并勾选上传图片后重试。") : null;
    });
    return outcome || fail("DECORATION_UNVERIFIED", "详情页装修弹窗尚未关闭，请核对后继续。");
  }

  if (typeof description !== "string" || description.length > 10000) return fail("VALUE_INVALID", "商品详情文本超长。");
  if (kind === "apply") return apply(description);
  if (!["begin", "write", "prepare", "fill"].includes(kind)) return fail("ACTION_UNSUPPORTED", "此操作不属于详情装修。");
  if (kind === "write") {
    const dialog = decoration();
    if (!isOnlyDecoration(dialog)) return fail("MODAL_BLOCKED", "详情装修弹窗不在前台。");
    if (!await waitFor(() => isOnlyDecoration(dialog) && imagesVerified(dialog))) {
      return fail("DETAIL_IMAGE_REQUIRED", "没有在详情装修预览中核对到已选图片，详情文本尚未填写。");
    }
    return write(dialog);
  }
  if (modals().length) return fail("MODAL_BLOCKED", "页面已有弹窗，详情图文尚未开始试填。");
  if (hasImages === false && [...root?.querySelectorAll("p,div,span") || []].some(node =>
    visible(node) && node.childElementCount <= 1 && /详情装修请同时具备图片展示及文字描述/u.test(clean(node.textContent)) &&
    clean(node.textContent).length <= 220)) {
    return fail("DETAIL_IMAGE_REQUIRED", "Temu 要求详情图文包含图片。请选择含详情图的商品目录并勾选上传图片。");
  }
  const open = root && exact(root, '[class^="decoration_operate__"] button', "开始装修");
  if (!open) return fail("DECORATION_MISSING", "当前类目没有可核对的详情图文装修入口。");
  open.click();
  const dialog = await waitFor(decoration);
  if (!dialog) return fail("DECORATION_UNVERIFIED", "详情页装修弹窗未出现。");
  if (kind === "begin") return { ok: true, status: "opened" };
  if (!imagesVerified(dialog)) return fail("DETAIL_IMAGE_REQUIRED", "请先在详情装修中加入图片，再填写详情文本。");
  return write(dialog);

  async function write(dialog) {
    if (!description.trim()) return kind === "fill" ? apply("") : { ok: true, status: "opened", written: "" };
    async function recover(code, message) {
      if (kind === "write") return fail(code, message);
      const closed = await cancel(dialog);
      return fail(code, closed ? message : message + " 请在 Temu 关闭详情装修后继续。");
    }

    const item = exact(dialog, '[class^="side-left_sectionItem__"] span', "文本");
    if (!item) return recover("DECORATION_UNVERIFIED", "没有唯一匹配的装修文本组件。");
    if (textControl(dialog)) return recover("DECORATION_OCCUPIED", "详情图文已有编辑内容，请核对现有内容。");
    if (decoration() !== dialog || !isOnlyDecoration(dialog)) return fail("MODAL_BLOCKED", "详情装修弹窗已切换。");
    item.click();
    const input = await waitFor(() => decoration() === dialog && isOnlyDecoration(dialog) && textControl(dialog));
    if (!input || input.value) return recover("DECORATION_UNVERIFIED", "详情文本编辑框缺失或已有内容。");
    const written = boundedText(input, description);
    if (!written.trim()) return recover("VALUE_INVALID", "详情文本超过此类目的输入限制。");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set.call(input, written);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (input.isConnected && onPage()) input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    const verified = await waitFor(() => decoration() === dialog && textControl(dialog)?.value === written);
    if (!verified) return recover("READBACK_MISMATCH", "平台未接受填写的详情图文。");
    const detailIssue = written.length < description.length ?
      { code: "DESCRIPTION_TRUNCATED", message: `Temu 此组件限 ${input.maxLength} 字，已试填前 ${written.length} 字，原文保留在商品资料中。` } : null;
    if (kind === "fill") return apply(written);
    return { ok: true, status: "opened", written, ...(detailIssue && { detailIssue }) };
  }
}
