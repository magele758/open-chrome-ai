/** Inspect new promotion forms and try safe, local-only fields in the rendered page. */
export async function operateShopeeCampaignDraft({ expectedUrl, operation = "read", values } = {}) {
  const url = new URL(location.href);
  const shopIds = url.searchParams.getAll("cnsc_shop_id");
  const titles = {
    "/portal/marketing/discount/create": "普通折扣活动",
    "/portal/marketing/global-discount/create": "全球商品折扣",
    "/portal/marketing/shop-flash-sale/create": "店铺限时抢购",
  };
  const title = titles[url.pathname];
  const onDraft = () => location.href === expectedUrl && url.origin === "https://seller.shopee.cn" &&
    !url.username && !url.password && !url.hash && title &&
    shopIds.length === 1 && /^\d+$/.test(shopIds[0]);
  const failure = (code, error) => ({ ok: false, code, error, submitted: false });
  if (!onDraft()) return failure("page-changed", "请打开同一店铺的活动新建页。");
  if (operation !== "read" && operation !== "fill") return failure("unsupported-action", "不支持此活动表单操作。");

  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" &&
    !node.closest("[hidden],[inert],[aria-hidden=true]");
  const shown = selector => [...document.querySelectorAll(selector)].filter(visible);
  const clean = node => String(node?.innerText ?? node?.textContent ?? "").replace(/\s+/gu, " ").trim();
  const hasLabel = (node, expression) => node.parentElement &&
    [...node.parentElement.children].some(child => expression.test(clean(child)));
  const flashes = url.pathname.includes("shop-flash-sale");
  const labels = shown("label,span,div,p");
  const hasNameLabel = labels.some(node => /^[*＊]?\s*活动名称$/u.test(clean(node)));
  const names = shown('input[maxlength="150"]').filter(node =>
    clean(node.labels?.[0]) === "活动名称" ||
    /^(?:\s*|请输入活动名称)$/u.test(node.placeholder) && (() => {
      for (let parent = node, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
        if (hasLabel(parent, /^[*＊]?\s*活动名称$/u)) return true;
      }
      return false;
    })());
  const name = names.length === 1 && hasNameLabel ? names[0] : null;
  const dateInputs = shown('input[placeholder="Select Date"]');
  const pageText = clean(document.body);
  const flashEvidence = /选择(?:店内秒杀选购的)?时间段/u.test(pageText);
  if (flashes ? !flashEvidence : !name) {
    return failure("campaign-draft-loading", "未找到可识别的新建活动表单。请等页面加载完毕后重试。");
  }

  const editable = !flashes && name && !name.disabled && !name.readOnly && !name.closest('[aria-disabled=true],fieldset:disabled');
  const readFields = () => [
    ...(name ? [{ key: "name", label: "活动名称", value: name.value, required: true, readOnly: !editable, maxLength: 150 }] : []),
    ...(flashes ? [{ key: "timeSlot", label: "限时抢购时间段", value: "", required: true, readOnly: true }] : [
      { key: "startsAt", label: "活动开始时间", value: dateInputs[0]?.value || "", readOnly: true, required: true },
      { key: "endsAt", label: "活动结束时间", value: dateInputs[1]?.value || "", readOnly: true, required: true },
    ]),
    { key: "products", label: "活动商品与优惠", value: "", readOnly: true, required: true },
  ];
  const blockers = flashes
    ? ["请在 Shopee 选择可用时间段，再按该时段要求添加商品、价格和活动库存。"]
    : ["请在 Shopee 核对活动时间，添加商品并设置折扣。"];
  const result = () => ({
    ok: true, kind: "campaign-draft", title: `Shopee ${title}`, url: location.href,
    fields: readFields(), ...(editable ? { sample: { name: `PageLens 试填 ${title}` } } : {}),
    blockers, submitted: false,
  });
  if (operation === "read") return result();
  if (!editable || !values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).length !== 1 || typeof values.name !== "string") {
    return failure("campaign-fields-unsupported", "当前工作流仅支持试填普通折扣或全球商品折扣的活动名称。");
  }
  const value = values.name.trim();
  if (!value || value.length > 150 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return failure("campaign-name-invalid", "活动名称须为 1 至 150 个字符。");
  }
  if (name.value && name.value !== value) return failure("campaign-draft-not-empty", "活动名称已有内容，请打开空白新建页试填。");
  if (!onDraft() || !name.isConnected || !visible(name)) return failure("page-changed", "活动表单已变化。");
  if (name.value !== value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(name, value);
    name.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  }
  if (!onDraft() || !name.isConnected || name.value !== value) {
    return failure("campaign-name-unverified", "页面上的活动名称未通过回读核对。");
  }
  return { ...result(), applied: ["name"] };
}
