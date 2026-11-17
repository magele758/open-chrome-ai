import { commercialDifferences, commerceScript, locateSkuInput, sellerRead, sellerVariants, sellerNumbers } from "./tiktok-mx-commerce.mjs";

export const titleSelector = '[data-id="product.publish.product_name"]';
const localDesc = '[data-id="product.publish.description.local_lang"]';
const gallerySelector = 'input[type=file][accept=".jpg,.png,.jpeg"]';
function sameCategory(a, b) {
  const normalize = s => s?.trim().replace(/\s+(?:-|>|\/)\s+/g, "/");
  return Boolean(a && b && normalize(a) === normalize(b));
}

export function formState() {
  const title = document.querySelector(
    '[data-id="product.publish.product_name"]',
  );
  const editor = document.querySelector(
    '[data-id="product.publish.description.local_lang"] .ProseMirror',
  );
  const realImage = (i) =>
    i.getAttribute("src") &&
    !/placeholder|ProseMirror-separator/.test(i.src + " " + i.className);
  const gallery = [
    ...document.querySelectorAll('[data-id^="product.widget.main_image."]'),
  ].filter(slot => !slot.querySelector('[role="progressbar"],[class*="_uploading_"]') &&
    [...slot.querySelectorAll("img")].some(realImage)).length;
  return {
    url: location.href,
    title: title?.value || "",
    description: editor?.innerText?.trim() || "",
    enTitle: document.querySelector(
      '[data-id="product.publish.title.input_lang"]',
    )?.value,
    enDescription: document
      .querySelector(
        '[data-id="product.publish.description.input_lang"] .ProseMirror',
      )
      ?.innerText.trim(),
    gallery,
    detailImages: editor
      ? new Set(
          [...editor.querySelectorAll("img")]
            .filter(realImage)
            .map((i) => i.src.split("?")[0]),
        ).size
      : 0,
    category:
      document
        .querySelector("#product-cascader-select-view")
        ?.innerText.trim() || "",
    singleSku: document.body.innerText.includes("价格和库存"),
    attributes: [...document.querySelectorAll("[role=combobox]")]
      .filter((e) => !e.closest("[data-id]"))
      .map((e) => e.innerText.trim())
      .filter(Boolean),
    captcha: /拖动完成上方拼图|请完成下列验证后继续|Verify to continue/.test(
      document.body.innerText,
    ),
    fields: [...document.querySelectorAll("[data-id]")]
      .map((e) => e.getAttribute("data-id"))
      .filter((id) =>
        /brand|sku|weight|length|height|width|price|stock/i.test(id),
      )
      .slice(0, 60),
    advice: document.body.innerText
      .split("预览")[0]
      .split("建议")
      .pop()
      ?.slice(-700),
  };
}
// Kept within the run_js size limit; the caller checks all values against its plan.
export function snapshotCode(withCommerce, allowEmptyDescription, settle = false) {
  const numbers = withCommerce ? commerceScript(sellerRead).replace(/^return await /, "") : "null";
  return `let seen=0;for(let i=0;i<100;i++){
    if(document.querySelector('${titleSelector}')?.value && (document.querySelector('${localDesc} .ProseMirror')?.textContent.trim() || (${allowEmptyDescription} && i>=12 && document.querySelector('${localDesc} .ProseMirror')))){
      const state=(${formState.toString()})();state.salesAndShipping=await ${numbers};
      if(!${settle} || state.captcha || (state.category && state.gallery && state.enTitle && state.salesAndShipping?.skus.length) || ++seen>=16)return state;
    }
    await new Promise(r=>setTimeout(r,150));
  }throw Error("Draft editor did not load")`.split("\n").map(line => line.trimStart()).join("\n");
}

// One inbox round trip. Each step still passes through the configured PageLens bridge.
export async function runMxDraftRead({ tabId, url }, dispatch, tabUrl) {
  const page = new URL(url);
  if (!Number.isInteger(tabId) || tabId < 1 || page.origin !== "https://seller.tiktokshopglobalselling.com" ||
      !/^\/product\/edit-draft\/\d+$/.test(page.pathname) || page.searchParams.get("shop_region") !== "MX")
    throw Error("Expected a saved MX draft");
  async function call(tool, args) {
    if (await tabUrl(tabId) !== url) throw Error("Draft URL changed during readback");
    const reply = await dispatch(tool, { tabId, ...args });
    if (!reply.ok || reply.result?.ok === false) throw Error(JSON.stringify(reply.error || reply.result?.error));
    return reply.result;
  }
  return readFreshDocument(url, call);
}

export async function readFreshDocument(url, call) {
  const guard = "if(location.href!==" + JSON.stringify(url) + ")throw Error('Wrong draft document');";
  const initial = await call("run_js", { code: guard + "return performance.timeOrigin" });
  if (!Number.isFinite(initial?.result)) throw Error("Draft document unavailable before reload");
  await call("reload_tab", {});
  const code = guard + "if(performance.timeOrigin===" + initial.result + ")return null;" + snapshotCode(true, true, true);
  const deadline = Date.now() + 20000;
  do {
    try {
      const reply = await call("run_js", { code });
      if (reply?.result) return reply.result;
    } catch (error) {
      if (!/frame (?:was removed|with ID 0 (?:was removed|does not exist))|execution context was destroyed|document unloaded/i.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw Error("Fresh draft document did not load");
}

export function sameText(a, b) {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}
function checkCopy(state, copy) {
  if (state.captcha)
    throw new Error("TikTok verification is open in the seller editor");
  if (
    state.title !== copy.title ||
    !sameText(state.description, copy.description) ||
    (copy.enTitle &&
      (state.enTitle !== copy.enTitle ||
        !sameText(state.enDescription || "", copy.enDescription)))
  )
    throw Error(
      "Bilingual title or description did not match the editor: " +
        JSON.stringify(state),
    );
}
export function check(state, copy) {
  checkCopy(state, copy);
  if (
    state.gallery !== copy.gallery.length ||
    state.detailImages < (copy.details?.length || 0)
  )
    throw new Error("Seller readback differs: " + JSON.stringify(state));
}

// One driver is used by both the extension and the Node recovery/readback path.
export function mxEditor(bridge, runCode, skuWrites) {
  const js = (tab, fn, ...args) => runCode(tab, "return await (" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  async function category(tab, choice) {
    if (!choice)
      return { selected: false, reason: "No accurate category identified" };
    return js(
      tab,
      async ({ search, label }) => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const control = document.querySelector("#product-cascader-select-view");
        if (!control)
          return { selected: false, reason: "Category selector unavailable" };
        const norm = (s) => s.replace(/\s*[-/>]\s*/g, "/").trim();
        const selected = () => document.querySelector("#product-cascader-select-view")?.innerText.trim() || "";
        const readSelection = async () => {
          for (let i = 0; i < 24 && !selected(); i++) await pause(200);
          const shown = selected();
          return { selected: norm(shown) === norm(label), label, shown };
        };
        if (norm(selected()) === norm(label)) return readSelection();
        const recommendation = [...document.querySelectorAll("button")].find(
          (b) =>
            b.innerText.trim() === "应用" &&
            norm(b.parentElement.parentElement.innerText.replace("应用", "")) ===
              norm(label),
        );
        if (recommendation && !recommendation.disabled) {
          recommendation.click();
          return readSelection();
        }
        control.click();
        await pause(300);
        const input = document.querySelector("input.core-cascader-view-input");
        if (!input)
          return { selected: false, reason: "Category search unavailable" };
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set.call(input, search);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        for (let i = 0; i < 18; i++) {
          await pause(250);
          const items = [...document.querySelectorAll("li[role=menuitem]")];
          const option = items.find(
            (e) => norm(e.title || e.innerText) === norm(label),
          );
          if (!option) continue;
          if (option.getAttribute("aria-disabled") === "true") {
            control.click();
            return {
              selected: false,
              reason: "Option disabled by seller center",
              label,
            };
          }
          option.click();
          return readSelection();
        }
        control.click();
        return { selected: false, reason: "Exact category not offered", label };
      },
      choice,
    );
  }
  const applyAttributes = async (attrs) => {
    const out = {};
    for (const [label, terms] of Object.entries(attrs)) {
      const box = [...document.querySelectorAll("[role=combobox]")].find(
        (e) =>
          e.parentElement.parentElement.parentElement.parentElement.innerText.split(
            "\n",
          )[0] === label,
      );
      if (!box) continue;
      for (const term of terms) {
        if (box.innerText.split("\n").includes(term)) continue;
        if (box.getAttribute("aria-expanded") !== "true")
          box.querySelector(".core-select-view")?.click();
        await new Promise((r) => setTimeout(r, 200));
        const menu = document.getElementById(box.getAttribute("aria-controls"));
        const option = [
          ...(menu || document).querySelectorAll("[role=option]"),
        ].find(
          (e) =>
            e.getBoundingClientRect().height &&
            e.innerText.split("\n").includes(term),
        );
        if (option && option.getAttribute("aria-selected") !== "true")
          option.click();
      }
      if (box.getAttribute("aria-expanded") === "true")
        box.querySelector(".core-select-view")?.click();
      out[label] = box.innerText.trim();
    }
    return out;
  };

  async function supplement(tab, copy) {
    if (copy.attributes) await js(tab, applyAttributes, copy.attributes);
  }
  const fillCopy = async (copy) => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (el, val) => {
      if (el.value === val) return;
      el.focus();
      el.select();
      if (document.execCommand("insertText", false, val)) {
        el.blur();
        return;
      }
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.blur();
    };
    const desc = (id, val) => {
      const e = document.querySelector('[data-id="' + id + '"] .ProseMirror');
      if (!e) throw new Error("Missing description editor");
      if (
        e.innerText.replace(/\s+/g, " ").trim() ===
        val.replace(/\s+/g, " ").trim()
      )
        return;
      const view = e.pmViewDesc?.view;
      if (view?.state?.schema.nodes.paragraph && view.dispatch) {
        const { doc, schema, tr } = view.state;
        const paragraphs = val
          .split(/\n+/)
          .filter(Boolean)
          .map((t) => schema.nodes.paragraph.create(null, schema.text(t)));
        // Replace only paragraphs of prose. Images, including wrapped inline images, retain their original nodes.
        const ranges = [];
        doc.forEach((node, pos) => {
          if (
            node.type === schema.nodes.paragraph &&
            [...node.content.content].every(
              (n) => n.isText || n.type.name === "hardBreak",
            )
          )
            ranges.push([pos, pos + node.nodeSize]);
        });
        view.focus();
        for (const [from, to] of ranges.slice(1).reverse()) tr.delete(from, to);
        const [from, to] = ranges[0] || [0, 0];
        tr.replaceWith(from, to, paragraphs);
        view.dispatch(tr);
        e.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText" }),
        );
        e.dispatchEvent(
          new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }),
        );
        if (!view.state.doc.textContent.includes(paragraphs[0].textContent))
          throw Error("Editor did not commit description");
        e.blur();
        return;
      }
      e.focus();
      const r = document.createRange();
      if (
        copy.preserveImages &&
        [...e.querySelectorAll("img")].some((i) => i.getAttribute("src"))
      ) {
        // Replace the contiguous prose range, leaving the original ProseMirror image nodes intact.
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode())
          if (walker.currentNode.textContent.trim())
            texts.push(walker.currentNode);
        if (!texts.length)
          throw Error("No editable prose alongside existing images");
        r.setStart(texts[0], 0);
        r.setEnd(texts.at(-1), texts.at(-1).length);
        if (r.cloneContents().querySelector("img[src]"))
          throw Error("Images interleaved with prose; keep original media");
      } else r.selectNodeContents(e);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      if (!document.execCommand("insertText", false, val))
        throw new Error("Description edit failed");
      e.blur();
    };
    const src = document.querySelector(
      '[data-id="product.publish.title.input_lang"]',
    );
    if (src && copy.enTitle) {
      set(src, copy.enTitle);
      desc("product.publish.description.input_lang", copy.enDescription);
      await pause(1600);
    }
    set(
      document.querySelector('[data-id="product.publish.product_name"]'),
      copy.title,
    );
    desc("product.publish.description.local_lang", copy.description);
    return true;
  };
  async function setCopy(tab, copy) {
    const code =
      "await (" +
      fillCopy.toString() +
      ")(" +
      JSON.stringify(copy) +
      ");return (" +
      formState.toString() +
      ")()";
    if (
      code
        .split("\n")
        .map((line) => line.trimStart())
        .join("\n").length < 7700
    )
      return runCode(tab, code);
    await js(tab, fillCopy, copy);
    return js(tab, formState);
  }
  async function repairSavedCopy(tab, state, copy, details) {
    if (copy.enTitle && state.enTitle !== copy.enTitle) {
      await bridge("trusted_type", {
        tabId: tab, selector: '[data-id="product.publish.title.input_lang"]',
        value: copy.enTitle, clear: true,
      });
      await bridge("press_keys", { tabId: tab, keys: ["Tab"] });
      // Recommit both halves of the bilingual title even when the Spanish
      // wording happens to match the previous draft.
      await bridge("trusted_type", { tabId: tab, selector: titleSelector, value: copy.title, clear: true });
      await bridge("press_keys", { tabId: tab, keys: ["Tab"] });
    }
    const { title, description, enTitle, enDescription } = copy;
    const written = await setCopy(tab, { title, description, enTitle, enDescription, preserveImages: true });
    check(await restoreDetails(tab, written, copy, details), copy);
  }
  async function restoreDetails(tab, state, copy, details) {
    if (state.captcha || !details.length || state.detailImages !== 0 || state.gallery !== copy.gallery.length)
      return state;
    // Seller Center can replace the local description (including all its images)
    // when it translates the English text. Only restore a completely empty gallery.
    for (const file of details)
      await bridge("upload_file", { tabId: tab, selector: localDesc + " input[type=file]", paths: [file] });
    return runCode(tab, "for(let i=0;i<50;i++){const s=(" + formState.toString() +
      ")(); if(s.detailImages >= " + details.length + ") return s; await new Promise(r=>setTimeout(r,200))} throw Error('Detail images did not finish uploading')");
  }
  async function commercialState(
    tab,
    plan,
    update = false,
    force = false,
    snapshot = null,
  ) {
    let state = snapshot || (await runCode(tab, commerceScript(sellerRead)));
    let differences = commercialDifferences(state, plan);
    if (update && (force || differences.length)) {
      const batches = [];
      for (let i = 0; i < plan.skus.length; i += 4)
        batches.push(
          plan.skus
            .slice(i, i + 4)
            .map(({ option, stock, priceMXN }) => ({ option, stock, priceMXN })),
        );
      const structureChanged = differences.some(
        (d) => d === "brand" || d === "SKU count" || d.startsWith("variant "),
      );
      if (structureChanged) {
        for (const { option } of plan.skus) {
          const selector = await runCode(tab, commerceScript(sellerVariants, {
            axis: plan.axis, brand: plan.brand, skus: [{ option }], trustedCommit: true,
          }));
          if (selector === true) continue;
          await bridge("trusted_type", { tabId: tab, selector, value: option, clear: true, submit: true });
          await bridge("press_keys", { tabId: tab, keys: ["Tab"] });
          await runCode(tab, commerceScript(async (ui, label) => {
            await ui.wait(() => ui.options().some(slot =>
              ui.optionLabels(slot).some(value => ui.norm(value) === ui.norm(label))), "committed option " + label);
            return true;
          }, option));
        }
      }
      for (const sku of plan.skus) {
        const rowStart = Date.now();
        let keys = ["stock", "priceMXN"];
        const attempts = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          for (const key of keys) {
            const selector = await runCode(tab, commerceScript(locateSkuInput, sku.option, key, sku[key], force));
            if (!selector) continue;
            const typed = await bridge("trusted_type", {
              tabId: tab, selector, clear: true, value: String(sku[key]),
            });
            if (typed?.ok === false) throw Error("Trusted SKU input failed");
            await bridge("press_keys", { tabId: tab, keys: ["Tab"] });
          }
          const observed = await runCode(tab, commerceScript((ui, sku, force) => {
            const tags = ui.options().map(ui.optionLabels).filter(labels => labels.includes(sku.option));
            const rows = ui.rows().filter(row => tags.length === 1 && tags[0].includes(row.label));
            if (rows.length !== 1) throw Error("Cannot identify SKU row " + sku.option);
            const receipts = Object.values(JSON.parse(document.body.dataset.plSkuWrites || "{}"))
              .filter(r => r.option === sku.option);
            const values = { stock: ui.numeric(rows[0].stock), priceMXN: ui.numeric(rows[0].price) };
            const missing = Object.keys(values).filter(key => {
              const hit = receipts.find(r => r.field === key);
              return values[key] !== sku[key] || (force && !hit?.events.some(
                e => e.type === "insertText" && e.value && Number(e.value) === sku[key]));
            });
            return { values, missing, receipts };
          }, { option: sku.option, stock: sku.stock, priceMXN: sku.priceMXN }, force));
          attempts.push(observed.values);
          keys = observed.missing;
          if (!keys.length) {
            skuWrites.push({ option: sku.option, start: rowStart, end: Date.now(), attempts, observed: observed.receipts });
            break;
          }
        }
        if (keys.length) throw Error("SKU readback differs after retry: " + sku.option + " " + keys.join(", "));
      }
      for (const skus of batches)
        state = await runCode(
          tab,
          commerceScript(sellerNumbers, "write", {
            skus,
            total: plan.skus.length,
            brand: plan.brand,
            axis: plan.axis,
            packagedWeightGrams: plan.packagedWeightGrams,
            packageCm: plan.packageCm,
          }),
        );
      differences = commercialDifferences(state, plan);
      if (differences.length)
        throw new Error(
          "Commercial fields differ before saving: " + differences.join(", "),
        );
      return { changed: true, state };
    }
    if (differences.length)
      throw new Error(
        "Commercial fields differ after refresh: " + differences.join(", "),
      );
    return { changed: false, state };
  }


  async function fillPage(tab, url, copy, plan, gallery, details, force) {
    const phases = { start: Date.now() };
    let state = await js(tab, formState);
    if (state.url !== url || state.captcha) throw Error("Unexpected draft editor or verification");
    if (new URL(url).pathname === "/product/create") {
      const { title, description, enTitle, enDescription } = copy;
      if (enTitle && state.enTitle !== enTitle) {
        const selector = '[data-id="product.publish.title.input_lang"]';
        await bridge("trusted_type", { tabId: tab, selector, clear: true, value: enTitle });
        await bridge("press_keys", { tabId: tab, selector, keys: ["Tab"] });
      }
      checkCopy(
        await setCopy(tab, { title, description, enTitle, enDescription }),
        copy,
      );
      phases.copyRead = Date.now();
      // The seller uploads asynchronously. Submit the ordered selection once on
      // its multi-file input, then use the upload time for the dependent controls.
      const multiple = gallery.length > 1 && await js(tab, selector =>
        document.querySelector(selector)?.multiple === true, gallerySelector);
      const batchSize = multiple ? gallery.length : 1;
      for (let i = 0; i < gallery.length; i += batchSize) {
        await bridge("upload_file", { tabId: tab, selector: gallerySelector, paths: gallery.slice(i, i + batchSize) });
        if (!multiple && i + 1 < gallery.length) {
          await bridge("wait_for", { tabId: tab,
            selector: '[data-id="product.widget.main_image.' + i + '"] img:not([src*="placeholder"])',
            timeoutMs: 30000 });
        }
      }
      for (const file of details)
        await bridge("upload_file", { tabId: tab, selector: localDesc + " input[type=file]", paths: [file] });
      phases.uploadsSubmitted = Date.now();
      const fillSales = async selected => {
        const categoryPath = value => (value || "").replace(/\s*[-/>]\s*/g, "/");
        if (categoryPath(selected.shown) !== categoryPath(copy.category?.label))
          throw Error("Selected category differs");
        phases.categoryRead = Date.now();
        await supplement(tab, copy);
        const result = await commercialState(tab, plan, true);
        phases.fieldsRead = Date.now();
        return result;
      };
      let cat = await category(tab, copy.category);
      let commerce = cat.selected ? await fillSales(cat) : null;
      // A slow earlier slot may still show 上传中 after the last slot is ready.
      // Check every image in the page, without submitting the same file again.
      const waitForMedia = `const until=Date.now()+12000;do{
        const s=(${formState.toString()})();
        if(s.captcha || (s.gallery===${gallery.length} && s.detailImages>=${details.length}) || Date.now()>=until)return s;
        await new Promise(r=>setTimeout(r,250));
      }while(true)`;
      for (let i = 0; i < 4; i++) {
        state = await runCode(tab, waitForMedia);
        if (state.captcha || (state.gallery === gallery.length && state.detailImages >= details.length)) break;
      }
      check(state, copy);
      phases.mediaRead = Date.now();
      if (!cat.selected && sameCategory(state.category, copy.category?.label))
        cat = { selected: true, shown: state.category, label: copy.category.label };
      else if (!cat.selected && !state.category && !state.captcha && copy.category)
        cat = await category(tab, copy.category);
      if (cat.selected && !commerce) {
        commerce = await fillSales(cat);
        state = await js(tab, formState);
        check(state, copy);
      }
      if (state.category && copy.category?.label && !sameCategory(state.category, copy.category.label))
        throw Error("Expected category did not load: " + (state.category || cat.reason || ""));
      if (commerce && phases.fieldsRead <= phases.mediaRead) {
        // Upload completion can re-render controlled inputs. Only repair rows
        // whose final committed values differ from the original plan.
        commerce = await commercialState(tab, plan, true);
        phases.fieldsRead = Date.now();
      }
      return { category: cat, state, commerce, phases };

    }
    if (!state.category || (copy.category?.label && !sameCategory(state.category, copy.category.label)) ||
        state.gallery !== gallery.length || (state.detailImages && state.detailImages < details.length))
      throw Error("Original draft category or media changed");
    const { title, description, enTitle, enDescription } = copy;
    state = await setCopy(tab, { title, description, enTitle, enDescription, preserveImages: true });
    state = await restoreDetails(tab, state, copy, details);
    check(state, copy);
    phases.copyRead = Date.now();
    const commerce = await commercialState(tab, plan, true, force);
    phases.fieldsRead = Date.now();
    return { state, commerce, phases };
  }
  return { fillPage, setCopy, category, supplement, repairSavedCopy, restoreDetails, commercialState };
}

// Runs inside the extension. Each browser operation still uses the ordinary
// bridge, with its existing origin, scope, upload and input checks.
export async function runMxDraftJob(job, dispatch, tabUrl) {
  const { tabId, url, copy, plan, gallery, details, force } = job;
  const page = new URL(url);
  if (page.origin !== "https://seller.tiktokshopglobalselling.com" ||
      page.searchParams.get("shop_region") !== "MX" ||
      !/^\/product\/(?:create|edit-draft\/\d+)$/.test(page.pathname) ||
      !Number.isInteger(tabId) || tabId < 1)
    throw Error("Expected an MX product editor");
  if (!copy?.title || !copy.description || !Array.isArray(plan?.skus) || !plan.skus.length ||
      !Array.isArray(gallery) || gallery.length < 1 || gallery.length > 9 || !Array.isArray(details) ||
      ![...gallery, ...details].every(path => typeof path === "string") ||
      !Array.isArray(copy.gallery) || gallery.length !== copy.gallery.length ||
      details.length !== (copy.details?.length || 0))
    throw Error("Incomplete MX draft form");
  const skuWrites = [];
  const steps = [];
  async function call(tool, args) {
    if (args.tabId !== tabId || await tabUrl(tabId) !== url)
      throw Error("Draft editor changed during filling");
    const start = Date.now();
    const reply = await dispatch(tool, args);
    if (!reply.ok || reply.result?.ok === false)
      throw Error(tool + ": " + JSON.stringify(reply.error || reply.result?.error));
    steps.push({ tool, ms: Date.now() - start });
    return reply.result;
  }
  async function runCode(tabId, body) {
    const guard = "if(location.href!==" + JSON.stringify(url) + ")throw Error('Unexpected draft URL');";
    const code = guard + body.split("\n").map(line => line.trimStart()).join("\n");
    const result = await call("run_js", { tabId, code });
    if (!result?.ok) throw Error("Seller page script did not complete");
    return result.result;
  }
  const result = await mxEditor(call, runCode, skuWrites).fillPage(tabId, url, copy, plan, gallery, details, force);
  return { ...result, skuWrites, steps };
}
