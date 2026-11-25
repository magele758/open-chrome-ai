/** Executed as a self-contained function in the pinned Temu editor document. */
export async function temuEditorPage({ kind, href, categoryPath, key, value, role, identifier, expectedCount }) {
  const scope = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const fail = (code, message) => ({ ok: false, code, message });
  const clean = (text, limit = 200) => String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const translated = (text) => clean(text).normalize("NFKC").replace(/^[*＊]\s*|[：:]$/gu, "").trim();
  const visible = (element) => Boolean(element?.isConnected && element.getClientRects().length &&
    !element.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(element).visibility !== "hidden");
  const control = 'input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]';
  const labels = 'label,[data-field-label],[class*="Form_itemLabelContent_"],[class*="STF_label_"]';
  const formItem = '[data-testid="beast-core-form-item"],[class*="Form_item_"]';
  const modals = 'dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]';
  const csselect = '[class*="ST_outerWrapper_"],[role="combobox"],[aria-haspopup="listbox"],[class*="colour-spec-select_colorSpecSelect__"]';
  const root = document.getElementById("page_container_id");
  const blocked = () => [...document.querySelectorAll(modals)].some(visible);
  const ready = () => scope() && root && visible(root) && !blocked();
  const isStable = (id) => /^[A-Za-z_][A-Za-z0-9_[\].:-]{1,230}$/u.test(id);
  const itemLabel = (el) => el.matches(labels) ? el : el.querySelector(labels);
  const titleLabels = {
    productName: ["商品名称", "中文名称", "中文商品名称", "商品中文名称"],
    productEnName: ["英文名称", "英文商品名称", "商品英文名称"],
  };
  const names = {
    productName: "中文商品名称", productEnName: "英文商品名称", productDesc: "商品描述",
    productDescription: "商品描述", productEnDesc: "英文商品描述",
    productOriginCode: "商品产地", "productProperties[15]": "成分比例",
    "productProperties[7817]": "辅料成分比例",
  };
  const shipping = { inputLen: "最长边", inputWidth: "次长边", inputHeight: "最短边", inputWeight: "重量" };
  const skuNames = {
    skuCode: "SKU 货号", usSuggestSalesPrice: "制造商建议零售价", stock: "库存", quantity: "库存",
    "productSkuMultiPack.packIncludeInfo": "共计内含数量", "productSkuSameReferPrice.url": "参考链接",
  };

  if (!scope()) return fail("PAGE_CHANGED", "Temu 商品页已切换。");
  if (blocked()) return fail("MODAL_BLOCKED", "Temu 表单上有弹窗，请核对后继续。");
  if (!ready()) return fail("EDITOR_LOADING", "商品信息表单还在加载。");
  const titleFields = kind === "inspect" ? resolveTitles() : null;
  if (titleFields?.size === 0) return fail("EDITOR_LOADING", "商品名称输入框尚未加载或无法唯一定位。");
  if (categoryPath?.length) {
    const normalized = text => translated(text).replace(/\s*[>＞›→]\s*/gu, ">");
    const wanted = normalized(categoryPath.join(">"));
    const crumbs = [...root.querySelectorAll('label,[class*="itemLabelContent_"],span,div')].filter(el =>
      visible(el) && el.childElementCount <= 6).map(el => normalized(el.innerText || el.textContent || ""));
    const seen = crumbs.some(crumb => crumb === wanted || crumb.endsWith(">" + wanted) ||
      /^(?:\*?商品(?:分类|类目)[:>]?|>)/u.test(crumb) && crumb.endsWith(wanted) ||
      crumb.startsWith(wanted + "修改") || crumb.startsWith(wanted + " 重新选择"));
    if (!seen) return fail("EDITOR_LOADING", "暂时无法核对第二步的已选商品类目。");
  }

  const skuId = id => /^(?:productSkuMap|productSkuVolumeWeightMap)\.([\w-]*)\.(.+)$/u.exec(id);

  function resolveTitles() {
    const aliases = new Map(Object.entries(titleLabels).flatMap(([id, labels]) => labels.map(label => [label, id])));
    const eligible = input => visible(input) && !input.matches(':disabled,[readonly]') &&
      !input.closest(csselect + ',[aria-disabled="true"],[aria-readonly="true"]');
    const candidates = new Map(Object.keys(titleLabels).map(id => [id, new Set()]));
    for (const label of root.querySelectorAll('label,[data-field-label],span,div')) {
      const text = label.textContent;
      if (text.length > 45) continue;
      const id = aliases.get(translated(text));
      if (!id || !visible(label) || label.querySelector(control)) continue;
      const linked = label.control ? [label.control] : label.id ? [...root.querySelectorAll('textarea[aria-labelledby]')]
        .filter(input => input.getAttribute("aria-labelledby").split(/\s+/u).includes(label.id)) : [];
      const direct = linked.filter(input => input.matches("textarea") && root.contains(input) && eligible(input));
      if (direct.length) {
        for (const input of direct) candidates.get(id).add(input);
        continue;
      }
      for (let area = label.parentElement, depth = 0; area && area !== root && depth < 6; area = area.parentElement, depth++) {
        const inputs = [...area.querySelectorAll("textarea")].filter(eligible);
        if (inputs.length === 1) candidates.get(id).add(inputs[0]);
        if (inputs.length || area.matches('[data-testid="beast-core-form-item"],[class*="Form_item_"]')) break;
      }
    }
    const uniqueTitles = new Map();
    for (const [key, inferred] of candidates) {
      const holder = document.getElementById(key);
      const selector = 'textarea,input[type="text"],input:not([type])';
      const pinned = holder && root.contains(holder) ? (holder.matches(selector) ? [holder] :
        [...holder.querySelectorAll(selector)]).filter(eligible) : [];
      if (pinned.length === 1) uniqueTitles.set(key, pinned[0]);
      else if (inferred.size === 1) uniqueTitles.set(key, [...inferred][0]);
    }
    const titles = [...uniqueTitles];
    return new Map(titles.filter(([, input]) => titles.filter(([, other]) => other === input).length === 1));
  }

  function holderFor(input) {
    let closest = null;
    for (let node = input, depth = 0; node && node !== root && depth < 12; node = node.parentElement, depth++) {
      if (isStable(node.id) && document.getElementById(node.id) === node &&
          (node === input || [...node.querySelectorAll(control)].filter(el => el.type !== "hidden").length === 1)) {
        if (Object.hasOwn(names, node.id) || skuId(node.id)) return node;
        closest ||= node;
      }
    }
    return closest;
  }

  function nearby(input) {
    const linked = clean(input.getAttribute("aria-label")) || clean(input.getAttribute("aria-labelledby")?.split(/\s+/u)
      .map(id => document.getElementById(id)?.textContent).filter(Boolean).join(" ")) ||
      [...(input.labels || [])].filter(visible).map(el => clean(el.textContent)).join(" ");
    if (linked) return linked;
    for (let node = input, depth = 0; node?.parentElement && node !== root && depth < 7; node = node.parentElement, depth++) {
      const parent = node.parentElement;
      const options = [...parent.querySelectorAll(labels)].filter(el => visible(el) && !el.querySelector(control));
      if (options.length === 1) return clean(options[0].textContent);
      if (options.length > 1) {
        const previous = node.previousElementSibling && itemLabel(node.previousElementSibling);
        return previous && visible(previous) ? clean(previous.textContent) : "";
      }
    }
    return "";
  }

  function rowLabelSet(input) {
    const row = input.closest("tr");
    if (!row) return [];
    const cells = [...row.cells];
    for (let index = row.sectionRowIndex - 1; index >= 0; index--) {
      for (const cell of row.parentElement.rows[index]?.cells || []) {
        if (cell.rowSpan === 0 || index + cell.rowSpan > row.sectionRowIndex) cells.push(cell);
      }
    }
    return cells.filter(cell => !cell.querySelector(control) && !cell.querySelector('button,a,[role="combobox"]'))
      .map(cell => clean(cell.dataset.value || cell.getAttribute("aria-label") || cell.textContent))
      .filter(text => text && !/^[-–—]+$/u.test(text)).slice(0, 12);
  }

  function fromField(input, titleKey) {
    const holder = holderFor(input);
    const id = titleKey || holder?.id;
    if (!id || !titleKey && Object.hasOwn(titleLabels, id) || input.matches(':disabled,[readonly]') ||
        input.closest('[aria-disabled="true"],[aria-readonly="true"]')) return null;
    const section = input.closest(formItem);
    const sku = skuId(id);
    if (sku && input.closest('[data-placeholder="true"],[class*="skeleton" i]')) return null;
    const label = names[id] || shipping[sku?.[2]] || skuNames[sku?.[2]] ||
      (sku?.[2]?.startsWith("siteSupplierPriceMap.") ? "申报价格（CNY）" : "") ||
      (/^productSkcList\[\d+\]\.extCode$/u.test(id) ? "颜色货号" : "") || nearby(input);
    let fieldKind;
    if (input.localName === "select") fieldKind = "select";
    else if (input.type === "checkbox" || input.type === "radio") fieldKind = input.type;
    else if (input.isContentEditable || input.matches('textarea,input[type="text"],input[type="number"],input[type="url"],input:not([type])')) fieldKind = "text";
    if (!fieldKind || input.closest(csselect) || !label || /密码|验证码|password|captcha|otp/iu.test(label)) return null;
    const required = Boolean(titleKey || input.required || input.getAttribute("aria-required") === "true" ||
      shipping[sku?.[2]] || sku?.[2]?.startsWith("siteSupplierPriceMap.") ||
      /^[*＊]/u.test(label) || section?.querySelector('[class*="Form_required"],[class*="itemLabelRequired"],[data-required="true"]'));
    const options = fieldKind === "select" ? [...input.options].filter(option => option.value && !option.disabled &&
      !option.closest("optgroup[disabled]")).map(option => ({ label: clean(option.textContent), value: option.value })) : [];
    const constraint = (attr) => input.hasAttribute(attr) && input.getAttribute(attr) !== "" && Number.isFinite(Number(input.getAttribute(attr)))
      ? Number(input.getAttribute(attr)) : undefined;
    return {
      input, field: {
        key: id, label: translated(label), kind: fieldKind, required,
        value: fieldKind === "checkbox" || fieldKind === "radio" ? input.checked :
          input.isContentEditable ? input.textContent : input.value,
        options, min: constraint("min"), max: constraint("max"), maxLength: constraint("maxlength"),
        ...(sku && { skuGroup: sku[1], skuMember: sku[2], rowLabels: rowLabelSet(holder) }),
      },
    };
  }

  const visibleField = input => visible(input) ||
    (["checkbox", "radio"].includes(input.type) && [...(input.labels || [])].some(visible));
  const fields = () => {
    const titleByInput = new Map([...titleFields].map(([id, input]) => [input, id]));
    return [...root.querySelectorAll(control)].filter(visibleField).map(input => fromField(input, titleByInput.get(input))).filter(Boolean);
  };
  const getField = (id) => {
    if (Object.hasOwn(titleLabels, id)) {
      const title = resolveTitles().get(id);
      return title && fromField(title, id);
    }
    const holder = document.getElementById(id);
    if (!holder || !root.contains(holder)) return null;
    const inputs = holder.matches(control) ? [holder] : [...holder.querySelectorAll(control)];
    const matches = inputs.filter(visibleField).map(input => fromField(input)).filter(item => item?.field.key === id);
    return matches.length === 1 ? matches[0] : null;
  };
  function validation(entries, media) {
    const errors = root.querySelectorAll('[aria-invalid="true"],[data-invalid="true"],[data-testid*="error"],[role="alert"],[class*="Form_error_"],[class*="itemError_"]');
    const notifications = [...document.querySelectorAll('[role="alert"],[data-testid*="toast"],[class*="Toast_content"]')]
      .filter(el => /失败|错误|未成功|有误|超出|没有权限|error|failed|invalid/iu.test(clean(el.textContent)));
    const present = [...new Set([...errors, ...notifications])].filter(visible);
    if (!present.length) return [];

    const owners = entries.map(({ input, field }) => ({
      input, holder: holderFor(input) || input, key: field.key, label: field.label, kind: field.kind,
    }));
    // The dropdown adapter reads these controls separately. Use only unique platform attribute IDs to associate their errors.
    for (const holder of root.querySelectorAll('[id^="productProperties"]')) {
      if (!/^productProperties\[\d+\]$/u.test(holder.id) || document.querySelectorAll(`[id="${holder.id}"]`).length !== 1) continue;
      const candidates = [...holder.querySelectorAll("input")].filter(input => visible(input) && input.closest(csselect));
      if (candidates.length === 1 && !owners.some(owner => owner.key === holder.id)) {
        owners.push({ input: candidates[0], holder, key: holder.id, label: nearby(candidates[0]), kind: "select" });
      }
    }
    const uploadLabels = { main: "商品轮播图", detail: "详情图", "size-chart": "尺码图", variant: "规格图" };
    for (const upload of media) {
      const holder = document.getElementById(upload.key);
      if (holder && root.contains(holder)) {
        const label = upload.variant ? `${upload.variant}规格图` : uploadLabels[upload.role];
        owners.push({ holder, key: upload.key, label, kind: "upload" });
      }
    }
    const referenceIds = input => [input?.getAttribute("aria-describedby"), input?.getAttribute("aria-errormessage")]
      .filter(Boolean).flatMap(value => value.split(/\s+/u));
    const rows = present.map(error => {
      const item = error.closest(formItem);
      const direct = owners.filter(({ input }) => input === error || error.id && referenceIds(input).includes(error.id));
      const local = direct.length || !root.contains(error) ? direct : owners.filter(({ input, holder }) =>
        holder.contains(error) || error.contains(input || holder) || item && (input || holder).closest(formItem) === item);
      const owner = local.length === 1 ? local[0] : null;
      const detail = owner && (owner.input === error || owner.holder === error) ?
        referenceIds(owner.input).map(id => document.getElementById(id)).filter(el => visible(el) && root.contains(el))
          .map(el => clean(el.textContent, 160)).find(Boolean) : "";
      const message = detail || (!error.matches(control) ? clean(error.textContent, 160) : "") ||
        clean(error.getAttribute("aria-label"), 160) || (owner ? "当前控件校验未通过" : nearby(error));
      return message ? {
        ...(owner && { key: owner.key, ...(owner.label && { label: translated(owner.label) }), kind: owner.kind }), message,
      } : null;
    }).filter(Boolean);
    return [...new Map(rows.map(row => [JSON.stringify([row.key, row.message]), row])).values()].slice(0, 35);
  }

  function uploads() {
    const list = [];
    for (const area of root.querySelectorAll('[id="noCostumeCarouselImgsI18n.common"],[id$=".previewImgsI18n.common"],[id$=".carouselImgsI18n.common"]')) {
      const main = area.id === "noCostumeCarouselImgsI18n.common";
      const sku = /^productSkuMap\.[\w-]*\.previewImgsI18n\.common$/u.test(area.id);
      const skc = /^productSkcList\[(\d{1,3})\]\.carouselImgsI18n\.common$/u.exec(area.id);
      if ((!main && !sku && !skc) || !visible(area) || !area.querySelector('[class^="upload-trigger_wrap__"]')) continue;
      const images = [...area.querySelectorAll('img[src]')].filter(node => visible(node) &&
        !node.closest('[class^="upload-trigger_wrap__"],[aria-busy="true"],[class*="uploading" i]') &&
        /^https?:\/\//iu.test(node.src) && !node.matches('[class*="placeholder" i],[class*="icon" i]')).map(node => {
        const url = new URL(node.currentSrc || node.src);
        return url.origin + url.pathname;
      });
      const markers = images.length;
      if (main) {
        list.push({ key: area.id, role: "main", mode: "material", multiple: true, markers, minimum: 3 });
      } else if (sku) {
        list.push({ key: area.id, role: "variant", mode: "material", multiple: true, markers, rowLabels: rowLabelSet(area) });
      } else {
        const color = document.getElementById(`productSkcList[${skc[1]}].mainSpec[0]`);
        const input = color?.querySelector('input[data-testid="beast-core-input-htmlInput"]');
        // The custom color selector renders committed colors as its input placeholder.
        const prompt = clean(input?.placeholder);
        const saved = prompt && !/^(?:选择或自定义颜色|请选择颜色|请选择|请输入)$/u.test(prompt) &&
          (!input.value || clean(input.value) === prompt) ? prompt : "";
        const legacy = color && !color.querySelector('[class*="colour-spec-select_colorSpecSelect__"]')
          ? color.querySelector('input[placeholder="选择或自定义颜色"]')?.value : "";
        const variant = clean(color?.querySelector('[class*="ST_selectValueSingle_"]')?.textContent || saved || legacy);
        if (variant) list.push({ key: area.id, role: "variant", mode: "material", multiple: true, markers, images, variant, minimum: 3 });
      }
    }
    for (const input of root.querySelectorAll('input[type="file"]')) {
      if (input.disabled || input.closest('[aria-disabled="true"]') || input.accept && !/image|png|jpe?g|webp/iu.test(input.accept)) continue;
      let section = null;
      let uploadRole = "";
      for (let node = input.parentElement, depth = 0; node && node !== root && depth < 7; node = node.parentElement, depth++) {
        const id = node.id;
        const prompt = clean(node.textContent, 210);
        const label = translated(prompt);
        if (/sizeChart|sizeTable|尺码图|尺码表/u.test(id) || /^(?:尺码图|尺码表图片)/u.test(label)) uploadRole = "size-chart";
        else if (/productSkcList|sku.*image/iu.test(id)) uploadRole = "variant";
        else if (/detail.*(?:image|pic)|details.*album/iu.test(id) || /^(?:商品)?详情图/u.test(label)) uploadRole = "detail";
        else if (/(?:album|image|pic)/iu.test(id) || /^(?:商品主图|商品图片|轮播图|素材图片|商品轮播图|正面图)/u.test(label)) uploadRole = "main";
        if (uploadRole && visible(node)) { section = node; break; }
      }
      if (!section || !uploadRole) continue;
      let selector = "";
      if (isStable(input.id) && document.getElementById(input.id) === input) selector = `[id="${input.id}"][type="file"]`;
      else if (isStable(section.id) && document.getElementById(section.id) === section &&
          section.querySelectorAll('input[type="file"]').length === 1) {
        selector = `[id="${section.id}"] input[type="file"]`;
      } else {
        const steps = [];
        for (let node = input; node && node !== root; node = node.parentElement) {
          steps.unshift(`${node.localName}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
        }
        selector = `#page_container_id > ${steps.join(" > ")}[type="file"]`;
      }
      if (document.querySelectorAll(selector).length !== 1 || document.querySelector(selector) !== input) continue;
      const owner = uploadRole === "variant" ? section.id.match(/^productSkcList\[(\d+)\]/u)?.[1] : undefined;
      const spec = owner != null ? document.getElementById(`productSkcList[${owner}].mainSpec[0]`) : null;
      const match = clean(spec?.querySelector("input")?.value || spec?.querySelector('[class*="ST_selectValueSingle_"]')?.textContent);
      const markers = [...section.querySelectorAll('img')]
        .filter(el => visible(el) && !el.closest('button,[role="button"]') &&
          !el.matches('[class*="icon" i]') && !el.closest('[aria-busy="true"],[class*="uploading" i]') &&
          !/^data:image\/svg\+xml/iu.test(el.getAttribute("src") || "")).length;
      const ruleText = clean(section.textContent, 400);
      const minimum = uploadRole === "main" ? Number(/(?:至少|最少|(?:^|[^\d]))\s*(\d{1,2})\s*(?:至|[-~–—～]|张图|张图片)/u.exec(ruleText)?.[1]) || undefined : undefined;
      if (list.some(item => item.key === section.id)) continue;
      list.push({ role: uploadRole, key: section.id || selector, selector, multiple: input.multiple, accept: input.accept,
        selectedFiles: input.files?.length || 0, markers, ...(minimum && { minimum }), ...(match && { variant: match }) });
    }
    return list;
  }

  if (kind === "inspect") {
    const entries = fields();
    const counts = new Map();
    for (const { field: { key } } of entries) counts.set(key, (counts.get(key) || 0) + 1);
    const uniqueFields = entries.filter(({ field }) => counts.get(field.key) === 1);
    const list = uniqueFields.map(({ field }) => field);
    const rows = new Map();
    for (const { input, field } of uniqueFields) {
      if (!field.skuGroup || !/^(?:siteSupplierPriceMap\.[\w-]+|stock|quantity)$/u.test(field.skuMember) ||
          !visible(input.closest("tbody tr"))) continue;
      const prior = rows.get(field.skuGroup) || [];
      rows.set(field.skuGroup, [...new Set([...prior, ...field.rowLabels])]);
    }
    const skuRows = rows.size ? [...rows].map(([id, labels]) => ({ id, labels })) : null;
    const hasApparelSizes = [...root.querySelectorAll('button,[role="button"]')].some(button =>
      visible(button) && /^\+?\s*添加尺码表$/u.test(clean(button.textContent)));
    const media = uploads();
    const findings = validation(uniqueFields, media);
    return { ok: true, fields: list.slice(0, 400), skuRows, uploads: media, validation: findings,
      issues: [...new Set(findings.map(finding => finding.message))], hasApparelSizes,
      truncated: list.length > 400 };
  }
  if (kind === "upload-target") {
    const matches = uploads().filter(item => item.role === role && item.key === key && (identifier == null || item.variant === identifier));
    if (matches.length !== 1) return fail("UPLOAD_CONTROL_MISSING", "没有唯一匹配的图片上传控件。");
    const match = matches[0];
    if (expectedCount > 1 && !match.multiple) return fail("UPLOAD_CONTROL_SINGLE", "此控件每次只接收一张图片。");
    return { ok: true, ...match };
  }
  if (kind === "add-parent-spec") {
    const buttons = [...root.querySelectorAll('button,[role="button"]')].filter(el => visible(el) &&
      !el.matches('[disabled],[aria-disabled="true"]') && /^添加父规格\s*2$/u.test(clean(el.textContent)));
    if (buttons.length !== 1) return fail("SPEC_ADD_MISSING", "未找到可用的添加父规格 2 按钮。");
    buttons[0].click();
    return { ok: true, status: "opened" };
  }
  if (kind !== "write") return fail("UNSUPPORTED_ACTION", "不支持此编辑动作。");
  const entry = getField(key);
  if (!entry) return fail("FIELD_MISSING", "不能在当前商品页唯一定位字段。");
  const { input, field } = entry;
  const defaultOutcome = { key, label: field.label };
  let wanted;
  if (field.kind === "checkbox" || field.kind === "radio") {
    if (typeof value !== "boolean" || field.kind === "radio" && !value) return fail("VALUE_INVALID", "选项需要明确的布尔值。");
    wanted = value;
  } else {
    if (typeof value !== "string" && typeof value !== "number") return fail("VALUE_INVALID", "字段需要文本或数字。");
    wanted = String(value);
    if (field.kind === "select") {
      const matches = field.options.filter(option => translated(option.label) === translated(wanted) || option.value === wanted);
      if (matches.length !== 1) return fail("OPTION_MISSING", "下拉列表没有唯一匹配的可选项。");
      wanted = matches[0].value;
    }
    if ((field.required && !wanted.trim()) || field.maxLength != null && wanted.length > field.maxLength ||
        field.min != null && (!Number.isFinite(Number(wanted)) || Number(wanted) < field.min) ||
        field.max != null && (!Number.isFinite(Number(wanted)) || Number(wanted) > field.max)) {
      return fail("VALUE_INVALID", `「${field.label}」超出平台校验范围。`);
    }
  }
  const titleComparable = text => text.normalize("NFKC").replace(/[‘’]/gu, "'").toLowerCase();
  const sameValue = actual => actual === wanted || key === "productEnName" &&
    typeof actual === "string" && typeof wanted === "string" && titleComparable(actual) === titleComparable(wanted);
  if (sameValue(field.value)) return { ok: true, status: "unchanged", ...defaultOutcome };
  if (!ready()) return fail("PAGE_CHANGED", "当前商品或弹窗已变化。");
  if (typeof wanted === "boolean") input.click();
  else {
    if (input.isContentEditable) input.textContent = wanted;
    else {
      const prototype = input.localName === "textarea" ? HTMLTextAreaElement.prototype :
        input.localName === "select" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set.call(input, wanted);
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (input.isConnected && ready()) input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await new Promise(resolve => setTimeout(resolve, 35));
  if (!scope() || blocked()) return fail("PAGE_CHANGED", "写入后页面发生变化，请检查结果。");
  const readback = getField(key);
  if (!readback || !sameValue(readback.field.value) || readback.input.getAttribute("aria-invalid") === "true" ||
      readback?.input.validity?.valid === false) return fail("READBACK_MISMATCH", `「${field.label}」的填写结果未能核对。`);
  return { ok: true, status: "filled", ...defaultOutcome };
}
