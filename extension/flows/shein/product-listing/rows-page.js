/** Serialized into the verified SHEIN add-product page. */
export async function sheinRowsPage({ href, categoryPath, kind = "inspect", rows = [], dimensions, upload,
  expectSupply = false, defaultSku = "", skcTitle = "" } = {}) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const measureHeaders = { widthCm: "宽度", shaftHeightCm: "筒高", lengthCm: "长度", heightCm: "高度", diameterCm: "直径" };
  const supplyFields = [
    { key: "priceUsd", header: /^价格\s*\(USD\)/u, label: "价格 (USD)", numeric: true },
    { key: "sellerSku", header: /^商家SKU/u, label: "商家 SKU" },
  ];
  const editable = node => node && !node.disabled && !node.readOnly && node.getClientRects().length;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const one = values => values.length === 1 ? values[0] : undefined;
  const items = [];
  const issues = [];
  const category = () => one([...document.querySelectorAll('[class*="commodityCategoryItem--"] [class*="categoryInfo--"]')].filter(visible));
  const onPage = () => {
    if (window !== window.top || location.origin !== "https://sellerhub.shein.com" || location.href !== href ||
        !location.hash.startsWith("#/spmp/commoditiesInfo?") || new URLSearchParams(location.hash.split("?")[1]).get("mode") !== "add") return false;
    const actual = clean(category()?.textContent).split(/\s*[>›]\s*/u);
    return categoryPath?.length > 0 && actual.length === categoryPath.length && actual.every((name, index) => name === clean(categoryPath[index]));
  };
  const blocked = () => [...document.querySelectorAll('.so-modal-show .so-modal-panel,[role="alertdialog"],[aria-modal="true"]')].some(visible);
  const live = () => onPage() && !blocked();
  if (!live()) return fail("SHEIN_EDIT_CONTEXT_CHANGED", "SHEIN 商品、类目或弹窗已变化。");

  const headerCells = table => [...table?.querySelectorAll('.so-table-head thead th') || []];
  const columns = table => headerCells(table)
    .map(cell => visible(cell) ? clean(cell.innerText || cell.textContent).replace(/^[*＊]\s*/u, "") : "");
  const cellText = cell => clean((cell?.innerText || cell?.textContent || "").split(/\bSKC\s*[:：]/iu)[0]);
  const wrappers = () => [...document.querySelectorAll(".so-table")].filter(visible);
  const tableRows = table => [...table?.querySelectorAll("tbody tr") || []].filter(row =>
    visible(row) && row.closest(".so-table") === table && row.cells.length > 0);
  const tableFor = search => one(wrappers().filter(table => columns(table).some(search)));
  const refs = {
    supply: () => one(wrappers().filter(table => table.matches('[class*="supplyInfoTable--"]') && columns(table).some(h => /^价格\s*\(USD\)/u.test(h)))),
    package: () => tableFor(h => /^含包装重量/u.test(h)),
    media: () => one(wrappers().filter(table => table.closest(".detail_img_container") && columns(table).some(title => /^方形图/u.test(title)))),
    size: () => one(wrappers().filter(table => table.closest('[class*="sizeContentBox--"]') && columns(table).some(h => /\(cm\)/iu.test(h)))),
  };
  const partition = (table, row, headers = columns(table)) => {
    const names = [];
    for (const [index, title] of headers.entries()) {
      if (/^(?:颜色|规格|尺码|尺寸|尺寸大小|容量|款式|样式|Color|Size|Style)$/iu.test(title)) {
        const name = cellText(row.cells[index]);
        if (name) names.push(name);
      }
    }
    return names;
  };
  const unnamedSku = (table, row, headers = columns(table)) => {
    if (headers[0] !== "主规格" || row.cells.length !== headers.length) return "";
    return /^SKC\s*:\s*([a-z0-9][a-z0-9_-]{4,63})$/iu.exec(clean(row.cells[0]?.innerText || row.cells[0]?.textContent))?.[1] || "";
  };
  const observedDefaultSku = () => {
    const tables = [refs.media(), refs.package(), refs.supply()];
    if (!tables[0] || !tables[1]) return "";
    const ids = tables.filter(Boolean).map(table => {
      const row = one(tableRows(table));
      return row ? unnamedSku(table, row) : "";
    });
    return ids[0] && ids.every(id => id === ids[0]) ? ids[0] : "";
  };
  const isDefaultTarget = (table, row) => Boolean(defaultSku && observedDefaultSku() === defaultSku &&
    unnamedSku(table, row) === defaultSku);
  const sameOptions = (names, opts) => names.length > 0 && names.length === opts.length &&
    opts.every((opt, index) => names[index] === clean(opt));
  const rowFor = (table, opts) => one(tableRows(table).filter(row => opts.length
    ? sameOptions(partition(table, row), opts) : isDefaultTarget(table, row)));
  const writeableInputs = (cell, selector = 'input:not([type="file"]),textarea') =>
    [...cell?.querySelectorAll(selector) || []].filter(editable);
  const writeable = (cell, selector) => one(writeableInputs(cell, selector));
  const safeNumber = (value, { integer = false, zero = false } = {}) => {
    const amount = clean(value);
    return /^\d{1,8}(?:\.\d{1,3})?$/u.test(amount) && Number(amount) >= (zero ? 0 : 0.001) &&
      (!integer || Number.isInteger(Number(amount))) ? amount : "";
  };
  async function waitUntil(check, timeout = 2500) {
    const end = Date.now() + timeout;
    do {
      if (!live()) return false;
      if (check()) return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    } while (Date.now() < end);
    return false;
  }
  async function waitForSupply() {
    const targets = rows.filter(row => Array.isArray(row.options) && (row.options.length || defaultSku)).map(row => ({ options: row.options,
      fields: supplyFields.filter(field => field.numeric ? safeNumber(row[field.key]) : clean(row[field.key])) }));
    if (!targets.length) return;
    const ambiguous = Symbol("ambiguous supply target");
    let previous = [];
    let since = 0;
    await waitUntil(() => {
      const table = refs.supply();
      const headers = columns(table);
      const snapshot = targets.flatMap(target => {
        const node = rowFor(table, target.options);
        if (!node) return [undefined];
        return [node, ...target.fields.map(({ header }) => {
          const positions = headers.flatMap((text, index) => header.test(text) ? [index] : []);
          if (positions.length !== 1) return positions.length > 1 ? ambiguous : undefined;
          const inputs = writeableInputs(node.cells[positions[0]]);
          return inputs.length > 1 ? ambiguous : inputs[0];
        })];
      });
      if (snapshot.some(target => !target) || snapshot.length !== previous.length ||
          snapshot.some((node, index) => node !== previous[index])) since = Date.now();
      previous = snapshot;
      return Date.now() - since >= 120;
    }, 5000);
  }
  async function write(field, value, label, options = {}, supply) {
    if (value == null || clean(value) === "") return;
    const expected = options.numeric ? safeNumber(value, options) : clean(value);
    const agrees = node => options.numeric ? safeNumber(node.value, options) && Number(node.value) === Number(expected) : clean(node.value) === expected;
    const first = field();
    if (!expected || !first || first.maxLength >= 0 && expected.length > first.maxLength || !live()) {
      const issue = { label, code: "SHEIN_ROW_FIELD", message: "缺少唯一控件或所给值不符合输入范围。" };
      if (supply && expected && !first && live()) issue.supply = supply;
      issues.push(issue);
      return;
    }
    if (agrees(first)) {
      items.push({ label, status: "unchanged" });
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(first.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    if (!setter) return;
    first.focus({ preventScroll: true });
    setter.call(first, expected);
    first.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    first.dispatchEvent(new Event("change", { bubbles: true }));
    first.blur();
    let agreedAt;
    if (await waitUntil(() => {
      const current = field();
      if (!current || !agrees(current)) { agreedAt = undefined; return false; }
      agreedAt ??= Date.now();
      return Date.now() - agreedAt >= 120;
    })) items.push({ label, status: "filled" });
    else issues.push({ label, code: "SHEIN_ROW_READBACK", message: "SHEIN 未回显写入值。" });
  }
  const rowCell = (role, options, header) => {
    const table = refs[role]();
    const positions = columns(table).flatMap((text, index) => header.test(text) ? [index] : []);
    const row = table && rowFor(table, options);
    return positions.length === 1 && row ? row.cells[positions[0]] : undefined;
  };
  const rowInput = (role, options, header, selector) => writeable(rowCell(role, options, header), selector);

  async function useCentimeters(options, label) {
    const dimension = () => rowCell("package", options, /^含包装尺寸/u);
    const select = () => one([...dimension()?.querySelectorAll('.so-select .so-select-result') || []].filter(visible));
    const chosen = () => {
      const el = select();
      return el && !el.classList.contains("so-select-empty") ? clean(el.innerText || el.textContent) : "";
    };
    const control = select();
    if (!control) return true;
    if (/^cm$/iu.test(chosen())) return true;
    const active = () => [...document.querySelectorAll('.so-list.so-select-options.so-hidable-show')].filter(visible);
    if (!chosen() && !active().length && live()) {
      control.click();
      let target;
      let since;
      if (await waitUntil(() => {
        const candidate = one([...one(active())?.querySelectorAll('.so-select-option') || []].filter(node =>
          visible(node) && !node.matches('[aria-disabled="true"],.so-select-disabled') && /^cm$/iu.test(clean(node.innerText || node.textContent))));
        if (candidate !== target) { target = candidate; since = Date.now(); }
        return candidate && Date.now() - since >= 240;
      }, 1600)) {
        if (target.matches('a[href]')) target.addEventListener("click", event => event.preventDefault(), { once: true });
        target.click();
        if (await waitUntil(() => /^cm$/iu.test(chosen()) && !active().length, 1300)) {
          items.push({ label, status: "verified" });
          return true;
        }
      }
      if (active().length === 1 && live() && select()) select().click();
    }
    issues.push({ label, code: "SHEIN_PACKAGE_UNIT", message: "未能核对商品包装尺寸的厘米单位，请在 SHEIN 检查。" });
    return false;
  }

  const missingSwatch = cell => /请上传色块图/u.test(clean(cell?.innerText || cell?.textContent));
  const remoteImage = image => /^(?:https?:)?\/\//iu.test(image.currentSrc || image.getAttribute("src") || "") &&
    image.complete && image.naturalWidth > 0;
  const mediaIssue = /^(?:请(?:先)?上传|至少上传|最多上传|上传失败|图片(?:大小|尺寸|比例|格式).*(?:不符|错误|超出))/u;
  const requiredMarker = '[class*="requiredTitle--"],[aria-required="true"],[data-required="true"]';
  const requiredImage = cell => Boolean(cell && (cell.matches(requiredMarker) ||
    /^[*＊]/u.test(clean(cell.innerText || cell.textContent)) ||
    [...cell.querySelectorAll(`span,i,em,${requiredMarker}`)].filter(visible).some(marker => marker.matches(requiredMarker) ||
      /^(?:\*|＊)$/u.test(clean(marker.innerText || marker.textContent)))));
  function imageValidation() {
    return ["media", "supply"].flatMap(role => {
      const table = refs[role]();
      const headers = columns(table);
      return tableRows(table).flatMap(row => headers.flatMap((header, index) => {
        if (!/^(?:细节图|方形图|色块图|SKU图)/u.test(header)) return [];
        const cell = row.cells[index];
        const messages = [...cell?.querySelectorAll("span,div,p,[role=alert]") || []].filter(visible)
          .map(node => clean(node.innerText || node.textContent))
          .filter(message => message.length <= 70 && mediaIssue.test(message));
        const options = partition(table, row, headers);
        if (!options.length && !unnamedSku(table, row, headers)) return [];
        const label = [...options, header.split(" ")[0]].join(" · ");
        const result = [...new Set(messages)].map(message => ({ label, code: "IMAGE_VALIDATION", message }));
        if (!result.length && requiredImage(headerCells(table)[index]) &&
            ![...cell?.querySelectorAll("img") || []].some(image => visible(image) && remoteImage(image))) {
          result.push({ label, code: "IMAGE_REQUIRED", message: "SHEIN 当前类目标记此图片为必填，请上传后核对。" });
        }
        return result;
      }));
    });
  }
  const state = () => {
    const id = observedDefaultSku();
    const packageTable = refs.package();
    const packageRow = one(tableRows(packageTable));
    const defaultPackageSku = packageRow && unnamedSku(packageTable, packageRow);
    const supplyTable = refs.supply();
    const supplyRow = one(tableRows(supplyTable));
    const sellerSkuIndex = one(columns(supplyTable).flatMap((header, index) => /^商家SKU/u.test(header) ? [index] : []));
    const sellerSkuInput = supplyRow && defaultPackageSku && unnamedSku(supplyTable, supplyRow) === defaultPackageSku &&
      one([...supplyRow.cells[sellerSkuIndex]?.querySelectorAll('input:not([type="file"]),textarea') || []].filter(visible));
    const defaultSellerSku = clean(sellerSkuInput?.value);
    const tables = Object.fromEntries(Object.entries(refs).map(([key, find]) => {
      const table = find();
      const headers = columns(table);
      const defaultTable = key !== "size" && id && headers[0] === "主规格";
      return [key, tableRows(table).map(row => partition(table, row, headers)).filter(options =>
        options.length || key === "size" || defaultTable)];
    }));
    const media = refs.media();
    const headers = columns(media);
    const swatchColumn = headers.findIndex(title => /^色块图/u.test(title));
    const swatchAvailable = swatchColumn >= 0;
    const swatchRequired = media ? swatchAvailable && (requiredImage(headerCells(media)[swatchColumn]) ||
      tableRows(media).some(row => missingSwatch(row.cells[swatchColumn]))) : undefined;
    const swatches = swatchAvailable ? tableRows(media).flatMap(row => {
      const cell = row.cells[swatchColumn];
      const loaded = [...cell?.querySelectorAll("img") || []].filter(image => visible(image) && remoteImage(image));
      return loaded.length === 1 && !missingSwatch(cell) ? [partition(media, row, headers)] : [];
    }) : [];
    return { ...tables, ...(id && { defaultSku: id }), ...(defaultPackageSku && { defaultPackageSku }),
      ...(defaultSellerSku && { defaultSellerSku }), swatchRequired, swatchAvailable, swatches };
  };
  if (kind === "inspect") return { ok: true, tables: state(), validation: imageValidation() };

  if (kind === "upload") {
    const { role, options, files } = upload || {};
    const capacity = role === "detail" ? 5 : 1;
    if (!["detail", "square", "variant", "swatch"].includes(role) || !Array.isArray(options) ||
        !options.length && (!defaultSku || observedDefaultSku() !== defaultSku) ||
        !Array.isArray(files) || !files.length || files.length > capacity) {
      return fail("SHEIN_IMAGE_INPUT", "请为当前规格选择合适的 SHEIN 图片。");
    }
    const patterns = { detail: /^细节图/u, square: /^方形图/u, swatch: /^色块图/u, variant: /^SKU图/u };
    const findCell = (imageRole = role) => rowCell(imageRole === "variant" ? "supply" : "media", options, patterns[imageRole]);
    const slot = (imageRole = role) => one([...findCell(imageRole)?.querySelectorAll('input[type="file"]') || []].filter(node =>
      !node.disabled && visible(node.parentElement) && /(?:image\/|\.(?:jpe?g|png|gif))/iu.test(node.accept)));
    const reveal = imageRole => findCell(imageRole)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const readPreviews = (imageRole = role) => {
      const cell = findCell(imageRole);
      if (!cell) return null;
      const existing = [...cell.querySelectorAll('[class*="uploadImgItemExist"]')].filter(visible);
      const selector = imageRole === "detail" ? '[class*="uploadImgItemExist"] img' : "img";
      const images = [...cell.querySelectorAll(selector)].filter(visible);
      const thumbs = [];
      let loading = /(?:上传中|加载中|图片处理中)/u.test(clean(cell.innerText || cell.textContent)) ||
        imageRole === "detail" && existing.some(holder => !images.some(image => holder.contains(image)));
      for (const image of images) {
        const raw = image.currentSrc || image.getAttribute("src") || "";
        const src = raw.startsWith("//") ? "https:" + raw : raw;
        if (/^https?:/iu.test(src) && image.complete && image.naturalWidth > 0) thumbs.push(src);
        else if (imageRole === "detail" || /^(?:blob:|https?:)/iu.test(src)) loading = true;
      }
      return { thumbs: [...new Set(thumbs)], loading };
    };
    async function settledPreviews(imageRole, check = () => true, timeout = 25000) {
      let snapshot;
      let key;
      let since;
      const found = await waitUntil(() => {
        const current = readPreviews(imageRole);
        if (!current || current.loading || !check(current.thumbs)) { since = undefined; return false; }
        const signature = JSON.stringify(current.thumbs);
        if (signature !== key) { key = signature; since = undefined; }
        since ??= Date.now();
        snapshot = current.thumbs;
        return Date.now() - since >= 240;
      }, timeout);
      return found ? snapshot : null;
    }
    if (!findCell()) return fail("SHEIN_IMAGE_TARGET", "未定位到规格对应的唯一图片上传位置。");
    reveal(role);
    const initial = await settledPreviews(role);
    if (!initial) return fail("SHEIN_IMAGE_PENDING", "当前规格图片还未稳定回显，请先检查上传进度。");
    const typeByExtension = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif" };
    const decoded = [];
    for (const file of files) {
      const extension = /^[^/\\\0]{1,140}\.(jpe?g|png|gif)$/iu.exec(String(file?.name))?.[1]?.toLowerCase();
      if (!extension || file.type !== typeByExtension[extension] || typeof file.base64 !== "string" ||
          file.base64.length > 12 * 1024 * 1024) return fail("SHEIN_IMAGE_FORMAT", "SHEIN 图片请使用 JPEG、PNG 或 GIF。");
      let bytes;
      try { bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0)); }
      catch { return fail("SHEIN_IMAGE_FORMAT", "无法读取本地图片数据。"); }
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) return fail("SHEIN_IMAGE_SIZE", "请选择 8 MB 以内的有效图片。");
      if (!crypto.subtle) return fail("SHEIN_IMAGE_FINGERPRINT", "无法核对本地图片内容，请重新打开当前标签后重试。");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      decoded.push({ name: file.name, type: file.type, extension, bytes, fingerprint });
    }
    const fingerprints = decoded.map(file => file.fingerprint);
    if (fingerprints.length !== new Set(fingerprints).size) return fail("SHEIN_IMAGE_INPUT", "同一规格内有内容相同的待上传图片。");
    // The injection world is tied to this document. Receipts are only valid while the same thumbnails remain in the exact cell.
    const mediaReceipts = Symbol.for("pagelens.shein.mediaReceipts.v3");
    const receipts = document[mediaReceipts] ??= new Map();
    const receiptGroup = imageRole => JSON.stringify([categoryPath, imageRole, options.map(clean), ...(!options.length ? [defaultSku] : [])]);
    const group = receiptGroup(role);
    const active = (receipts.get(group) || []).filter(entry => initial.includes(entry.thumb));
    const known = src => one(active.filter(entry => entry.thumb === src))?.fingerprint;
    if (role === "square" && initial.length === 1 && known(initial[0]) !== decoded[0].fingerprint) {
      const hero = one((receipts.get(receiptGroup("detail")) || []).filter(entry => entry.generatedSquare &&
        entry.fingerprint === decoded[0].fingerprint && sameSheinAsset(entry.thumb, initial[0])));
      if (hero) {
        reveal("detail");
        const gallery = await settledPreviews("detail", thumbs => thumbs[0] === hero.thumb, 2200);
        reveal("square");
        const square = gallery && await settledPreviews("square", thumbs => thumbs.length === 1 && thumbs[0] === initial[0], 2200);
        if (square && live()) {
          receipts.set(group, [{ fingerprint: hero.fingerprint, thumb: square[0] }]);
          return { ok: true, status: "verified" };
        }
      }
    }
    const expected = initial.slice();
    const review = () => fail("SHEIN_IMAGE_REVIEW", "当前规格图与提供的顺序不一致。已保留原有图片，请在 SHEIN 核对。");
    for (const [index, file] of decoded.entries()) {
      const thumb = expected[index];
      if (thumb && known(thumb) !== file.fingerprint) return role === "detail" ? review() :
        fail("SHEIN_IMAGE_OCCUPIED", "该图片位置已有内容，请先核对当前图片。");
      if (!thumb && active.some(entry => entry.fingerprint === file.fingerprint)) return review();
    }
    const pending = decoded.slice(initial.length);
    if (!pending.length) return live() && findCell() ? { ok: true, status: "unchanged" } :
      fail("SHEIN_IMAGE_TARGET", "图片位置已变化。");
    const accepts = (field, file) => {
      const types = field.accept.toLowerCase().split(",").map(value => value.trim());
      return types.includes("image/*") || types.includes(file.type) || types.includes("." + file.extension);
    };
    const first = slot();
    if (!first) return fail("SHEIN_IMAGE_TARGET", "未定位到规格对应的唯一图片上传位置。");
    if (pending.some(file => !accepts(first, file))) return fail("SHEIN_IMAGE_FORMAT", "图片类型不符合当前上传位置的要求。");
    for (const file of pending) {
      reveal(role);
      const current = await settledPreviews(role, thumbs => thumbs.length === expected.length &&
        expected.every((src, index) => src === thumbs[index]));
      const field = slot();
      if (!live() || !current || !field?.isConnected || !accepts(field, file)) {
        return fail("SHEIN_IMAGE_TARGET", "图片位置或其原有图片已变化。");
      }
      const beforeSquare = role === "detail" && !expected.length ? readPreviews("square") : null;
      const generatedSquare = Boolean(beforeSquare && !beforeSquare.loading && !beforeSquare.thumbs.length && slot("square"));
      // Wait for each file before selecting the next, so the gallery order follows the planned upload order.
      const transfer = new DataTransfer();
      transfer.items.add(new File([file.bytes], file.name, { type: file.type }));
      field.files = transfer.files;
      field.dispatchEvent(new Event("change", { bubbles: true }));
      const verified = await settledPreviews(role, thumbs => thumbs.length === expected.length + 1 &&
        !expected.includes(thumbs.at(-1)) && expected.every((src, index) => src === thumbs[index]) &&
        (role !== "swatch" || !missingSwatch(findCell())));
      if (!verified) {
        return fail("SHEIN_IMAGE_READBACK", "未核对到 SHEIN 图片按预期顺序回显，请检查当前规格图片和上传进度。");
      }
      const thumb = verified.at(-1);
      expected.push(thumb);
      active.push({ fingerprint: file.fingerprint, thumb, generatedSquare });
      receipts.set(group, active);
      if (receipts.size > 100) receipts.delete(receipts.keys().next().value);
    }
    return { ok: true, status: "verified" };
  }

  function sameSheinAsset(hero, square) {
    const cdn = /^https:\/\/img\.ltwebstatic\.com\/v4\/j\/spmp\//u;
    return cdn.test(hero) && cdn.test(square) && hero.replace(/_square(?=\.(?:jpe?g|png|gif)(?:[?#]|$))/iu, "") === square;
  }

  if (kind !== "fill" && kind !== "retrySupply") return fail("SHEIN_ACTION_UNSUPPORTED", "此 SHEIN 表单操作不可用。");
  if (expectSupply) await waitForSupply();
  if (kind === "fill" && typeof skcTitle === "string" && clean(skcTitle)) {
    const mediaRows = new Map();
    for (const { options } of rows) {
      if (Array.isArray(options) && (options.length || defaultSku)) mediaRows.set(options[0] || "", options.slice(0, 1));
    }
    for (const [name, options] of mediaRows) {
      const field = () => rowInput("media", options, /^SKC标题/u, 'textarea[placeholder*="SPU标题"]') ||
        rowInput("media", options, /^SKC标题/u);
      const control = field();
      if (control && !clean(control.value)) await write(field, skcTitle, (name || "默认 SKU") + " 商详标题");
    }
  }
  for (const row of rows) {
    if (!live()) return fail("SHEIN_EDIT_CONTEXT_CHANGED", "SHEIN 商品、类目或弹窗已变化。");
    const options = row.options;
    if (!Array.isArray(options) || !options.length && !defaultSku) continue;
    const label = options.join(" / ") || "默认 SKU";
    if (kind === "fill" && !rowFor(refs.supply(), options) && !rowFor(refs.package(), options)) {
      issues.push({ label, code: "SHEIN_SKU_MISSING", message: "当前表格未找到唯一对应规格。" });
      continue;
    }
    for (const field of supplyFields) {
      await write(() => rowInput("supply", options, field.header),
        row[field.key], label + " " + field.label, field, { options, key: field.key });
    }
    if (kind === "retrySupply") continue;
    await write(() => rowInput("package", options, /^含包装重量/u), row.weightG, label + " 包装重量 (g)", { numeric: true });
    const edges = [["lengthCm", "长(最长边)"], ["widthCm", "宽(次长边)"], ["heightCm", "高(最短边)"]];
    if (edges.some(([key]) => clean(row[key])) && await useCentimeters(options, label + " 包装尺寸单位")) {
      for (const [key, prompt] of edges) await write(() => rowInput("package", options, /^含包装尺寸/u,
        `input[placeholder="${prompt}"]`), row[key], label + " 包装" + prompt, { numeric: true });
    }
  }
  if (dimensions) for (const [key, name] of Object.entries(measureHeaders)) {
    await write(() => {
      const table = refs.size();
      const row = table && one(tableRows(table));
      const index = one(columns(table).flatMap((header, position) =>
        header.replace(/\s+(?=\(cm\)$)/iu, "").toLowerCase() === name + "(cm)" ? [position] : []));
      return row && index !== undefined && writeable(row.cells[index]);
    }, dimensions[key], "产品" + name + " (cm)", { numeric: true });
  }
  return { ok: true, items, issues, tables: state() };
}
