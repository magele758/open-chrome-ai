// Parenthetical asides do not name the product. A title that still names this
// accessory, and is not an included-with phrase, is that accessory.
function titleSubjectIsAccessory(title, type) {
  const core = String(title || "")
    .normalize("NFKC")
    .replace(/[（(【\[].*?[）)】\]]/g, "")
    .trim();
  if (!type.test(core)) return false;
  if (/付き|套装|套裝|included|incluid[oa]|同梱/i.test(core)) return false;
  return true;
}

// Require both a named accessory and an explicit standalone-sale statement.
// A bundle, or a listing whose subject is this accessory, stays eligible.
export function sourceVariants(source) {
  const accessoryTypes = [
    /クリーニングクロス|清潔布|清洁布|眼鏡拭き|cleaning cloth|paño de limpieza/i,
    /交換用フィルター|替えフィルター|替换滤芯|替換濾芯|replacement filter|filtro de repuesto/i,
    /専用ケース|收纳盒|收納盒|carrying case|estuche de transporte/i,
  ];
  const standalone = /独立した単品|単品販売|別売|のみ(?:です|となります|$)|单独出售|單獨出售|仅售|僅售|sold separately|sold individually|accessory only|se vende por separado/i;
  const bundle = /セット|付き|同梱|套装|套裝|附赠|附贈|bundle|included|incluid[oa]|\s\+\s/i;
  const title = String(source.title || "").normalize("NFKC");
  const skus = [], excludedSkus = {};
  for (const sku of source.skus) {
    const label = (sku.options || []).join(" / ").normalize("NFKC").trim();
    const accessory = accessoryTypes.find(type => type.test(label));
    // A mention of the accessory in the title is not the product itself.
    if (title && accessory && standalone.test(label) && !bundle.test(label) && !titleSubjectIsAccessory(title, accessory))
      excludedSkus[sku.id] = "来源规格明确标注配件单卖：" + label;
    else skus.push(sku);
  }
  if (!skus.length) throw Error("No primary product SKU identified");
  return { skus, excludedSkus };
}

// One seller variant axis can also represent a source's sparse combinations (e.g. “Azul / M”).
// This keeps each actual source SKU in its own row without inventing a Cartesian product.
export function commercialPlan(copy, source) {
  const s = copy.salesAndShipping;
  if (!s) throw new Error("Complete salesAndShipping in listing.json first");
  const skus =
    s.skus ||
    Object.entries(s.variant || {}).map(([, option]) => ({
      option,
      stock: s.stock,
      priceMXN: s.priceMXN,
    }));
  const axis = s.axis || Object.keys(s.variant || {})[0];
  if (!s.brand?.trim() || !axis?.trim() || !skus.length)
    throw new Error("Missing brand, variant name or sellable options");
  const { excludedSkus } = sourceVariants(source);
  const labels = new Set(),
    ids = new Set();
  for (const id of Object.keys(s.excludedSkus || {})) {
    if (!excludedSkus[id])
      throw new Error("Cannot drop source SKU " + id);
  }
  for (const row of skus) {
    if (!row.sourceSkuId)
      throw new Error("Missing source SKU: " + (row.option || ""));
    if (excludedSkus[row.sourceSkuId]) throw Error("Standalone accessory included: " + row.sourceSkuId);
    if (!row.option?.trim() || labels.has(row.option.trim().toLowerCase()))
      throw new Error("Each SKU needs a unique option");
    labels.add(row.option.trim().toLowerCase());
    if (
      ids.has(row.sourceSkuId) ||
      !source.skus.some((x) => x.id === row.sourceSkuId)
    )
      throw new Error(
        "Missing, duplicate or unrelated source SKU: " + row.sourceSkuId,
      );
    const src = source.skus.find((x) => x.id === row.sourceSkuId);
    const stockNote = s.origins?.[row.option + ".stock"];
    if (
      Number.isInteger(src?.stock) &&
      src.stock >= 0 &&
      row.stock !== src.stock &&
      !(stockNote?.kind === "seller" && stockNote.verified === true)
    )
      throw new Error("Stock does not match source SKU " + row.sourceSkuId);
    ids.add(row.sourceSkuId);
    if (
      !Number.isInteger(row.stock) ||
      row.stock < 0 ||
      !Number.isFinite(row.priceMXN) ||
      row.priceMXN <= 0 ||
      Math.abs(row.priceMXN * 100 - Math.round(row.priceMXN * 100)) > 1e-6
    )
      throw new Error("Invalid stock or peso price for " + row.option);
  }
  for (const item of source.skus) {
    if (!ids.has(item.id) && !excludedSkus[item.id])
      throw new Error("Source SKU not accounted for: " + item.id);
  }
  for (const key of ["length", "width", "height"])
    if (!(Number.isFinite(s.packageCm?.[key]) && s.packageCm[key] > 0))
      throw new Error("Invalid package " + key);
  if (!Number.isInteger(s.packagedWeightGrams) || s.packagedWeightGrams <= 0)
    throw new Error("Invalid package weight in grams");
  const fields = {
    brand: s.brand,
    packagedWeightGrams: s.packagedWeightGrams,
    ...Object.fromEntries(
      Object.entries(s.packageCm).map(([k, v]) => ["packageCm." + k, v]),
    ),
  };
  for (const row of skus)
    for (const k of ["option", "stock", "priceMXN"])
      fields[row.option + "." + k] = row[k];
  const origins = {};
  for (const [key, value] of Object.entries(fields)) {
    const note = s.origins?.[key];
    if (
      !note ||
      !["source", "seller", "converted", "estimated"].includes(note.kind) ||
      !note.basis?.trim()
    )
      throw new Error(
        "Record source/estimate and basis for " +
          key +
          " in salesAndShipping.origins",
      );
    if (
      note.kind === "converted" && key.endsWith(".priceMXN") &&
      !(/汇率/.test(note.basis) && /日期/.test(note.basis) && /来源/.test(note.basis))
    )
      throw new Error("Converted basis needs rate, date and source for " + key);
    if (note.kind === "seller" && key.endsWith(".priceMXN")) {
      const option = key.slice(0, -".priceMXN".length);
      const row = skus.find((item) => item.option === option);
      const src = source.skus.find((item) => item.id === row?.sourceSkuId);
      if (src?.currency && src.currency !== "MXN" && note.verified !== true)
        throw new Error("Unverified foreign price is not a seller price for " + key);
    }
    origins[key] = {
      value,
      kind: note.kind,
      basis: note.basis,
      ...(note.verified === true ? { verified: true } : {}),
    };
  }
  return {
    brand: s.brand,
    axis,
    skus,
    packagedWeightGrams: s.packagedWeightGrams,
    packageCm: s.packageCm,
    origins,
  };
}

// Serialized by PageLens and executed in the seller editor. Keep browser helpers inside this function.
function commerceDom() {
  const all = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));
  const field = (name) =>
    document.querySelector('[data-id="product.publish.' + name + '"]');
  const byPrefix = (name) => all('[data-id^="product.publish.' + name + '."]');
  const text = (e) => (e?.innerText || e?.textContent || "").trim();
  const norm = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const visible = (e) => e && e.getBoundingClientRect().width > 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function wait(find, label, times = 24) {
    for (let i = 0; i < times; i++) {
      const found = find();
      if (found) return found;
      await sleep(200);
    }
    throw new Error("Seller control not ready: " + label);
  }
  function set(input, value) {
    if (!input || input.disabled || input.readOnly)
      throw new Error("Input cannot be edited: " + value);
    input.focus();
    input.select();
    if (
      !document.execCommand?.("insertText", false, String(value)) ||
      Number(input.value) !== Number(value)
    ) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
    field("product_name")?.focus();
    input.blur();
  }
  const numeric = (e) =>
    e?.value?.trim() ? Number(e.value.replaceAll(",", "")) : null;
  const numberInput = (e) =>
    e?.querySelector(
      'input[role=spinbutton],input[placeholder]:not([placeholder=""])',
    );
  const names = () => byPrefix("sale_property.name");
  const options = () => byPrefix("sale_property.value.name");
  const optionLabels = (e) => [
    ...new Set(all(".pulse-input-tag-item", e).map(text).filter(Boolean)),
  ];
  const axisName = (e) =>
    text(e?.querySelector(".core-cascader-view-value,.pulse-overflow-text")) ||
    text(e);
  const brandValue = () =>
    text(field("brand")?.querySelector(".core-select-view-value"));
  const rows = () =>
    byPrefix("skus.stock").map((e) => {
      const id = e.dataset.id.slice("product.publish.skus.stock.".length);
      const tr = e.closest("tr");
      const cell = tr?.cells?.[0];
      // The seller renders the input label and its translation as adjacent spans.
      const primary = cell?.querySelector('[data-tid="m4b_overflow_text"] > span:first-child');
      return {
        label: text(primary) || text(cell),
        stock: e.querySelector("input"),
        price: field("skus.sale_price." + id)?.querySelector("input"),
      };
    });
  const units = () =>
    text(field("package_weight")?.querySelector("[role=combobox]"));
  const lengthUnit = () =>
    ["length", "width", "height"].every((k) =>
      /厘米|\bcm\b/i.test(text(field("package_" + k))),
    );
  const weightFactor = () =>
    /千克|公斤|\bkg\b/i.test(units())
      ? 1000
      : /克|\bg\b/i.test(units())
        ? 1
        : 0;
  // Integer grams. 1.001 kg * 1000 is 1000.9999999999999 before rounding.
  const toGrams = (weight) => {
    const factor = weightFactor();
    if (weight == null || !factor) return null;
    return Math.round(Number(weight) * factor);
  };
  function verifyEditor() {
    if (
      location.hostname !== "seller.tiktokshopglobalselling.com" ||
      new URL(location.href).searchParams.get("shop_region") !== "MX"
    )
      throw new Error("Expected MX seller editor");
    if (!field("brand") || !field("package_weight"))
      throw new Error("Select an available product category first");
  }
  return {
    all,
    field,
    text,
    norm,
    visible,
    wait,
    sleep,
    set,
    numeric,
    numberInput,
    names,
    options,
    optionLabels,
    axisName,
    brandValue,
    rows,
    units,
    lengthUnit,
    weightFactor,
    toGrams,
    verifyEditor,
  };
}

export async function sellerVariants(ui, plan) {
  const {
    all,
    field,
    text,
    norm,
    visible,
    wait,
    sleep,
    names,
    options,
    optionLabels,
    axisName,
    brandValue,
  } = ui;
  ui.verifyEditor();
  if (brandValue() !== plan.brand) {
    const box = field("brand").querySelector("[role=combobox]");
    box.querySelector(".core-select-view")?.click();
    const menu = () =>
      document.getElementById(box.getAttribute("aria-controls"));
    const match = () =>
      all("[role=option]", menu() || document).find(
        (e) =>
          visible(e) &&
          text(e)
            .split("\n")
            .some((v) => norm(v) === norm(plan.brand)),
      );
    await sleep(200);
    if (!match()) {
      const input = box.querySelector("input");
      if (input && !input.readOnly) {
        input.focus();
        document.execCommand("insertText", false, plan.brand);
      }
    }
    (await wait(match, "brand " + plan.brand)).click();
    await wait(() => norm(brandValue()) === norm(plan.brand), "selected brand");
  }
  const toggle = all("button[role=switch]").find(
    (e) => text(e.parentElement.parentElement.parentElement) === "添加变体",
  );
  if (toggle?.getAttribute("aria-checked") === "false") toggle.click();
  const name = await wait(() => names()[0], "variant name");
  if (names().length !== 1)
    throw new Error("Existing draft has a different variant structure");
  const box = name.querySelector("[role=combobox]");
  if (norm(axisName(name)) !== norm(plan.axis)) {
    if (options().some((e) => optionLabels(e).length))
      throw new Error("Existing variant name differs: " + axisName(name));
    box.querySelector("input").click();
    await sleep(200);
    const menu = () =>
      document.getElementById(box.getAttribute("aria-controls"));
    const exact = all("li,[role=menuitem]", menu() || document).find(
      (e) => visible(e) && norm(text(e)) === norm(plan.axis),
    );
    if (exact) exact.click();
    else {
      const button = (label, root) =>
        all("button", root || document).find(
          (e) => visible(e) && text(e) === label,
        );
      (
        await wait(
          () => button("新增", menu()) || button("新增"),
          "add variant name",
        )
      ).click();
      const add = await wait(
        () =>
          all("button").find(
            (e) =>
              visible(e) &&
              text(e) === "添加" &&
              e.parentElement.querySelector("input[maxlength='30']"),
          ) || button("添加", menu()),
        "custom name",
      );
      const input = add.parentElement.querySelector("input");
      input.focus();
      document.execCommand("insertText", false, plan.axis);
      await wait(() => !add.disabled, "custom name enabled");
      await sleep(200);
      add.click();
    }
    await wait(
      () => names()[0] && norm(axisName(names()[0])) === norm(plan.axis),
      "selected variant name",
    );
  }
  for (const sku of plan.skus) {
    const matches = () =>
      options().find((e) =>
        optionLabels(e).some((s) => norm(s) === norm(sku.option)),
      );
    if (matches()) continue;
    let input = options()
      .filter((e) => !optionLabels(e).length)
      .map((e) => e.querySelector("input:not([readonly])"))
      .find(Boolean);
    if (!input) {
      const add = all("button").find((b) => text(b) === "添加选项");
      if (!add) throw new Error("Cannot add variant " + sku.option);
      await sleep(200);
      add.click();
      input = await wait(
        () =>
          options()
            .filter((e) => !optionLabels(e).length)
            .map((e) => e.querySelector("input:not([readonly])"))
            .find(Boolean),
        "new option",
      );
    }
    if (plan.trustedCommit) {
      const slot = options().find(e => e.contains(input));
      const id = slot?.dataset.id;
      if (!/^product\.publish\.sale_property\.value\.name\.[\w-]+$/.test(id))
        throw Error("Unexpected variant input for " + sku.option);
      return '[data-id="' + id + '"] input:not([readonly])';
    }
    input.focus();
    input.select();
    document.execCommand("insertText", false, sku.option);
    await sleep(200);
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
    input.blur();
    field("product_name").focus();
    await wait(matches, "committed option " + sku.option, 45);
  }
  return true;
}

export function sellerRead(ui) {
  const {
    field,
    numeric,
    numberInput,
    names,
    options,
    optionLabels,
    axisName,
    brandValue,
    rows,
    units,
    lengthUnit,
    weightFactor,
    toGrams,
  } = ui;
  const weight = numeric(numberInput(field("package_weight")));
  return {
    brand: brandValue(),
    axes: names().map(axisName),
    options: options()
      .map(optionLabels)
      .filter((x) => x.length),
    skus: rows().map((r) => ({
      label: r.label,
      priceField: r.price?.closest("[data-id]")?.dataset.id,
      stockField: r.stock?.closest("[data-id]")?.dataset.id,
      stock: numeric(r.stock),
      priceMXN: numeric(r.price),
    })),
    weightUnit: units(),
    packagedWeightGrams: toGrams(weight),
    dimensionsInCm: lengthUnit(),
    packageCm: Object.fromEntries(
      ["length", "width", "height"].map((k) => [
        k,
        numeric(numberInput(field("package_" + k))),
      ]),
    ),
  };
}

// Resolve the current row immediately before each trusted edit. Seller Center
// may replace its numeric SKU IDs when an earlier input commits.
export function locateSkuInput(ui, option, field, value, force = false) {
  const tags = ui.options().map(ui.optionLabels).filter(labels =>
    labels.some(label => ui.norm(label) === ui.norm(option)));
  if (tags.length !== 1) throw Error("Cannot identify variant " + option);
  const matches = ui.rows().filter(row => tags[0].some(label => ui.norm(label) === ui.norm(row.label)));
  if (matches.length !== 1) throw Error("Cannot identify SKU row " + option);
  const input = matches[0][field === "stock" ? "stock" : "price"];
  if (!input || input.disabled || input.readOnly) throw Error("Cannot edit " + option + " " + field);
  if (!force && ui.numeric(input) === value) return null;
  input.scrollIntoView({ block: "center", inline: "center" });
  const id = input.closest("[data-id]")?.dataset.id;
  if (!/^product\.publish\.skus\.(stock|sale_price)\.[\w-]+$/.test(id)) throw Error("Unexpected SKU control");
  const selector = '[data-id="' + id + '"] input';
  if (force) {
    // Keep evidence on the document so a row re-render cannot erase it.
    const previous = JSON.parse(document.body.dataset.plSkuWrites || "{}");
    for (const [key, entry] of Object.entries(previous))
      if (entry.option === option && entry.field === field) delete previous[key];
    document.body.dataset.plSkuWrites = JSON.stringify(previous);
    const events = [];
    const record = (event) => {
      if (!event.isTrusted || !event.target.matches?.(selector)) return;
      events.push({ type: event.inputType, value: event.target.value });
      if (event.inputType === "insertText") {
        document.removeEventListener("input", record, true);
        const receipts = JSON.parse(document.body.dataset.plSkuWrites || "{}");
        receipts[id] = { option, field, events };
        document.body.dataset.plSkuWrites = JSON.stringify(receipts);
      }
    };
    document.addEventListener("input", record, true);
  }
  return selector;
}

export async function sellerNumbers(ui, readState, mode, plan) {
  const {
    field,
    norm,
    wait,
    set,
    numeric,
    numberInput,
    names,
    options,
    optionLabels,
    axisName,
    brandValue,
    rows,
    units,
    lengthUnit,
    weightFactor,
    toGrams,
  } = ui;
  if (mode === "read") return readState(ui);
  ui.verifyEditor();
  if (!weightFactor() || !lengthUnit())
    throw new Error("Unrecognized weight or dimension units");
  if (
    plan.brand &&
    (brandValue() !== plan.brand ||
      names().length !== 1 ||
      norm(axisName(names()[0])) !== norm(plan.axis))
  )
    throw Error("Brand or variant axis changed before writing SKU values");
  const table = await wait(
    () => rows().length === plan.total && rows(),
    "exact SKU table",
  );
  for (const sku of plan.skus) {
    const aliases = options()
      .map(optionLabels)
      .find((a) => a.some((v) => norm(v) === norm(sku.option)))
      .map(norm);
    const matched = table.filter((r) => aliases.includes(norm(r.label)));
    if (matched.length !== 1)
      throw new Error("Ambiguous SKU row " + sku.option);
    const row = matched[0];
    if (numeric(row.stock) !== sku.stock) set(row.stock, sku.stock);
    if (numeric(row.price) !== sku.priceMXN) set(row.price, sku.priceMXN);
  }
  for (const sku of plan.skus) {
    const aliases =
      options()
        .map(optionLabels)
        .find((a) => a.some((v) => norm(v) === norm(sku.option))) || [];
    const row = rows().find((r) => aliases.map(norm).includes(norm(r.label)));
    if (
      !row ||
      numeric(row.price) !== sku.priceMXN ||
      numeric(row.stock) !== sku.stock
    )
      throw Error("SKU readback differs: " + sku.option);
  }
  const weight = numberInput(field("package_weight"));
  if (toGrams(numeric(weight)) !== plan.packagedWeightGrams)
    set(weight, plan.packagedWeightGrams / weightFactor());
  for (const k of ["length", "width", "height"]) {
    const input = numberInput(field("package_" + k));
    if (numeric(input) !== plan.packageCm[k]) set(input, plan.packageCm[k]);
  }
  return readState(ui);
}

// Each submission stays within PageLens's run_js source limit. Send only the
// current batch of SKUs; provenance belongs in the local receipt.
export function commerceScript(fn, ...args) {
  let code =
    "return await (" +
    fn.toString() +
    ")((" +
    commerceDom.toString() +
    ")()," +
    (fn === sellerNumbers ? "(" + sellerRead.toString() + ")," : "") +
    "..." +
    JSON.stringify(args) +
    ")";
  if (code.length > 7700)
    code = code
      .split("\n")
      .map((line) => line.trimStart())
      .join("\n");
  if (code.length > 7800)
    throw new Error("Commercial field batch exceeds PageLens run_js limit");
  return code;
}

export function commercialDifferences(state, plan) {
  const norm = (s) =>
    String(s ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  const errors = [];
  if (norm(state.brand) !== norm(plan.brand)) errors.push("brand");
  if (state.axes.length !== 1 || norm(state.axes[0]) !== norm(plan.axis))
    errors.push("variant name");
  if (
    state.options.length !== plan.skus.length ||
    state.skus.length !== plan.skus.length
  )
    errors.push("SKU count");
  const used = new Set();
  for (const sku of plan.skus) {
    const tags = state.options.filter((a) =>
      a.some((v) => norm(v) === norm(sku.option)),
    );
    const matches = state.skus.filter(
      (r) => tags.length === 1 && tags[0].map(norm).includes(norm(r.label)),
    );
    if (matches.length !== 1 || used.has(matches[0])) {
      errors.push("variant " + sku.option);
      continue;
    }
    const row = matches[0];
    used.add(row);
    if (row.stock !== sku.stock) errors.push(sku.option + " stock");
    if (row.priceMXN !== sku.priceMXN) errors.push(sku.option + " priceMXN");
  }
  if (
    state.packagedWeightGrams == null ||
    Math.round(state.packagedWeightGrams) !== plan.packagedWeightGrams
  )
    errors.push("packagedWeightGrams");
  for (const k of ["length", "width", "height"])
    if (!state.dimensionsInCm || state.packageCm[k] !== plan.packageCm[k])
      errors.push("packageCm." + k);
  return errors;
}
