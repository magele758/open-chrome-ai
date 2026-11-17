#!/usr/bin/env node
// Browser operations run in the signed-in Chrome profile through PageLens.
import { DraftTabs } from "./tiktok-mx-tabs.mjs";
import fs from "node:fs/promises";
import { commercialPlan, commerceScript, sellerRead } from "./tiktok-mx-commerce.mjs";
import { mxEditor, formState, sameText, check, titleSelector } from "./tiktok-mx-editor.mjs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
const home = process.env.PAGELENS_HOME
  ? path.resolve(process.env.PAGELENS_HOME)
  : path.join(os.homedir(), ".pagelens");
let bridgeOverride = null;
export function setDraftBridgeForTests(fn) {
  bridgeOverride = fn;
}
const seller = "https://seller.tiktokshopglobalselling.com";
const drafts = seller + "/product/manage?shop_region=MX&tab=draft";
const createUrl = seller + "/product/create?shop_region=MX";
const localDesc = '[data-id="product.publish.description.local_lang"]';
let calls = 0;
let group;
let expectedEdit;
let pendingPreflight;
const editTabs = new Set();
const stages = {};
const bridgeCalls = [];
const skuWrites = [];
const formRuns = [];
const editor = mxEditor(bridge, runCode, skuWrites);
const { setCopy, category, supplement, commercialState, restoreDetails, repairSavedCopy } = editor;
function mark(name) {
  stages[name] = Date.now();
}
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function write(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}
async function bridge(tool, args) {
  if (bridgeOverride) return bridgeOverride(tool, args);
  return inbox(tool, { action: "bridge_call", request: { tool, args } });
}
async function fillPage(tabId, url, copy, plan, gallery, details, force = false) {
  const { title, description, enTitle, enDescription, category, attributes } = copy;
  const content = { title, description, enTitle, enDescription, category, attributes, gallery: copy.gallery, details: copy.details };
  const { brand, axis, skus, packagedWeightGrams, packageCm } = plan;
  const commerce = { brand, axis, skus, packagedWeightGrams, packageCm };
  const job = { action: "fill_mx_draft", tabId, url, copy: content, plan: commerce, gallery, details, force };
  let result;
  try {
    result = await inbox("fill_mx_draft", job, 600000);
  } catch (error) {
    // An older running extension rejected the job before executing any steps.
    if (!String(error.message).includes("unknown action: fill_mx_draft")) throw error;
    console.error("PageLens needs an extension reload for single-request filling; using the installed bridge");
    const legacy = await editor.fillPage(tabId, url, content, commerce, gallery, details, force);
    formRuns.push({ url, transport: "per-step", phases: legacy.phases });
    return legacy;
  }
  formRuns.push({ url, transport: "page", steps: result.steps, phases: result.phases, enTitle: result.state.enTitle, skus: result.commerce?.state.skus });
  skuWrites.push(...result.skuWrites);
  return result;
}
async function inbox(tool, job, timeoutMs = 75000) {
  const id = randomUUID();
  const queue = path.join(home, "agent-inbox");
  const start = Date.now();
  calls++;
  await write(path.join(queue, id + ".json"), {
    id,
    createdAt: new Date().toISOString(),
    ...job,
  });
  for (let i = 0; i < timeoutMs / 250; i++) {
    try {
      const reply = await read(path.join(home, "agent-outbox", id + ".json"));
      bridgeCalls.push({ tool, start, end: Date.now(), executionMs: reply.meta?.ms });
      if (!reply.ok) throw new Error(tool + ": " + JSON.stringify(reply.error));
      return reply.result;
    } catch (e) {
      if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
    }
    await sleep(250);
  }
  throw new Error("PageLens did not reply to " + tool + " (" + id + ")");
}
async function js(tabId, fn, ...args) {
  const code =
    "return await (" + fn.toString() + ")(..." + JSON.stringify(args) + ")";
  return runCode(tabId, code);
}
async function runCode(tabId, code) {
  if (editTabs.has(tabId) && expectedEdit) {
    code =
      "if(location.href !== " +
      JSON.stringify(expectedEdit) +
      ") throw Error('Unexpected draft URL');" +
      code;
  }
  if (code.length > 7800)
    code = code
      .split("\n")
      .map((line) => line.trimStart())
      .join("\n");
  const value = await bridge("run_js", { tabId, code });
  if (!value?.ok)
    throw new Error(value?.error || "PageLens page script failed");
  return value.result;
}
async function open(url) {
  const tab = await group.open(url);
  if (expectedEdit && url === expectedEdit) editTabs.add(tab);
  return tab;
}
function sourceId(url) {
  const u = new URL(url);
  if (u.origin !== "https://shop.tiktok.com")
    throw new Error("Expected a shop.tiktok.com product link");
  const id = u.pathname.match(
    /^\/[a-z]{2}\/pdp\/(?:[^/]+\/)?(\d{12,22})\/?$/i,
  )?.[1];
  if (!id) throw new Error("Unrecognized TikTok Shop product link");
  return id;
}
async function extract(id) {
  for (let i = 0; i < 45; i++) {
    const el = document.querySelector("#__MODERN_ROUTER_DATA__");
    if (el) {
      const data = Object.values(JSON.parse(el.textContent).loaderData).find(
        (v) => v?.page_config,
      );
      const info = Object.values(data?.page_config.components_map || {}).find(
        (v) => v.component_name === "product_info",
      )?.component_data;
      const p = info?.product_info;
      if (p?.product_id === id)
        return {
          id,
          title: p.title,
          seller: p.seller?.name,
          brand: p.brand?.name ?? p.brand_name ?? null,
          packageWeight: p.package_weight ?? null,
          packageDimensions: p.package_dimensions ?? null,
          categories: info.categories.map((c) => c.category_name),
          specs: p.specifications || [],
          description: (p.desc_blocks || [])
            .filter((v) => v.text)
            .map((v) => v.text),
          skus: (p.skus || []).map((s) => ({
            id: s.sku_id,
            options: s.sku_sale_props?.map((v) => v.prop_value),
            stock: s.stock ?? null,
            properties: s.sku_sale_props?.map((v) => ({
              name: v.prop_name,
              value: v.prop_value,
            })),
            price: s.price?.sale_price_decimal,
            currency: s.price?.currency_name,
          })),
          gallery: p.images.map((v) => v.url_list[0]),
          detail: (p.desc_blocks || []).flatMap(
            (v) => v.image?.url_list?.slice(0, 1) || [],
          ),
        };
    }
    if (
      /Security Check|请完成下列验证|Verify to continue/i.test(
        document.title + " " + document.body?.innerText?.slice(0, 1000),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    "Product data unavailable. Check the product tab for region, login or verification.",
  );
}
const imageHostSuffixes = [
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tiktokcdn-us\.com$/,
  /(^|\.)ibyteimg\.com$/,
  /(^|\.)tiktokcdn\.eu$/,
];
export function imageHostAllowed(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return imageHostSuffixes.some((pattern) => pattern.test(host));
}
function pathInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
export async function listingImage(dir, name, assets) {
  if (typeof name !== "string" || !name || path.basename(name) !== name)
    throw new Error("Image path must be a file name: " + name);
  if (!assets.some((asset) => asset.name === name))
    throw new Error("Unknown source image " + name);
  const root = await fs.realpath(dir);
  const resolved = path.resolve(dir, name);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Missing source image " + name);
    throw error;
  }
  const real = await fs.realpath(resolved);
  if (!pathInside(root, real))
    throw new Error(
      (stat.isSymbolicLink() ? "Image symlink escapes the run directory: " : "Image path escapes the run directory: ") +
        name,
    );
  const followed = await fs.stat(real);
  if (!followed.isFile()) throw new Error("Image path is not a regular file: " + name);
  return real;
}
async function imageFile(url, file) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !imageHostAllowed(u.hostname))
    throw new Error("Unexpected product image host: " + u.hostname);
  const raw = file + ".source";
  await exec("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--proto",
    "=https",
    "--max-time",
    "40",
    "--retry",
    "2",
    "--retry-all-errors",
    "-o",
    raw,
    url,
  ]);
  await exec("magick", [
    raw + "[0]",
    "-auto-orient",
    "-resize",
    "1400x1400>",
    "-background",
    "white",
    "-alpha",
    "remove",
    "-strip",
    "-quality",
    "90",
    file,
  ]);
  await fs.unlink(raw);
}
function sourceRecord(id) {
  return path.join(home, "mx-draft-sources", id + ".json");
}
async function lookup(file) {
  try {
    return await read(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
async function prepare(url, fresh = false, afterOpening, onFactsReady) {
  const previousRun = await lookup(sourceRecord(sourceId(url)));
  if (previousRun && !fresh) {
    console.log(JSON.stringify({ existing: true, ...previousRun }));
    return;
  }
  const id = sourceId(url),
    start = Date.now();
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pagelens-mx-" + id + "-"),
  );
  group = new DraftTabs(id, bridge);
  const tab = await open(url);
  afterOpening?.();
  const data = await js(tab, extract, id);
  mark("sourceRead");
  if (!data.title || !data.gallery?.length)
    throw new Error("Product title or gallery missing");
  await write(path.join(dir, "source-capture.json"), {
    ...data,
    url,
    start,
    sourceRead: stages.sourceRead,
  });
  const images = [
    ...new Set([...data.gallery.slice(0, 9), ...data.detail.slice(0, 10)]),
  ];
  const priorSource =
    previousRun && (await lookup(path.join(previousRun.dir, "source.json")));
  const assetKey = (url) => new URL(url).pathname.split("~")[0];
  const assets = images.map((url, i) => ({
    name: "image-" + String(i + 1).padStart(2, "0") + ".jpg", url, reused: false,
  }));
  const downloadImages = async () => {
    for (let i = 0; i < assets.length; i += 5) {
      await Promise.all(assets.slice(i, i + 5).map(async asset => {
        const cached = priorSource?.assets.find(a => assetKey(a.url) === assetKey(asset.url));
        if (cached) {
          const old = path.join(previousRun.dir, cached.name);
          if (await fs.stat(old).then(stat => stat.size > 0, () => false)) {
            await fs.copyFile(old, path.join(dir, asset.name));
            asset.reused = true;
            return;
          }
        }
        await imageFile(asset.url, path.join(dir, asset.name));
      }));
    }
    mark("mediaReady");
  };
  await Promise.all([downloadImages(), onFactsReady?.({ ...data, assets }, dir)]);
  await write(path.join(dir, "source.json"), {
    ...data,
    url,
    assets,
    start,
    prepared: Date.now(),
    prepareCalls: calls,
    sourceRead: stages.sourceRead,
  });
  console.log(
    JSON.stringify({
      dir,
      title: data.title,
      skus: data.skus,
      specs: data.specs,
      categories: data.categories,
      images: assets.map((a) => a.name),
      seconds: (Date.now() - start) / 1000,
    }),
  );
  return dir;
}

async function createDraft(url, rate, review) {
  if (await lookup(sourceRecord(sourceId(url)))) throw Error("Source already registered; use rerun");
  const { generateListing, matchingPlan } = await import("./tiktok-mx-ptc.mjs");
  let generated;
  const dir = await prepare(url, false, () => {
    pendingPreflight = openCreateForm();
    pendingPreflight.catch(() => {});
  }, async (facts, dir) => {
    const previous = await matchingPlan(facts);
    mark("generationStarted");
    generated = await generateListing(facts, previous, rate, undefined, Boolean(previous));
    mark("generationReady");
    await write(path.join(dir, "generation.json"), generated.ptc);
  });
  const data = await read(path.join(dir, "source.json"));
  const tab = await pendingPreflight;
  if (review) await review(generated.copy, data);
  commercialPlan(generated.copy, data);
  await write(path.join(dir, "listing.json"), generated.copy);
  mark("planReady");
  await save(dir, false, false, null, null, null, tab);
  return dir;
}

async function rerun(url, yenToPeso) {
  const registered = await lookup(sourceRecord(sourceId(url)));
  if (!registered?.id) throw Error("No registered draft to rerun");
  expectedEdit =
    seller + "/product/edit-draft/" + registered.id + "?shop_region=MX";
  let preflight;
  const dir = await prepare(url, true, () => {
    preflight = (async () => {
      const edit = await open(expectedEdit);
      const original = await readyForm(edit, true);
      if (original.url !== expectedEdit || original.title !== registered.title)
        throw Error("Registered draft ID or title differs in the editor");
      // A real focus event lets the bilingual editor commit its controlled fields.
      await bridge("press_keys", {
        tabId: edit,
        selector: titleSelector,
        keys: ["End"],
      });
      return { edit, original, editorAt: Date.now() };
    })();
    preflight.catch(() => {}); // observed again at the join; avoid unhandled rejection during collection.
    pendingPreflight = preflight;
  });
  const fresh = await read(path.join(dir, "source.json"));
  const prior = await read(path.join(registered.dir, "source.json"));
  const fields = [
    "id",
    "title",
    "brand",
    "specs",
    "description",
    "categories",
    "packageWeight",
    "packageDimensions",
  ];
  const assetIds = (images) =>
    images.map((u) => new URL(u).pathname.split("~")[0]);
  const layout = (source) => source.skus.map(({ price, ...spec }) => spec);
  if (
    JSON.stringify(layout(fresh)) !== JSON.stringify(layout(prior)) ||
    fields.some((k) => JSON.stringify(fresh[k]) !== JSON.stringify(prior[k])) ||
    ["gallery", "detail"].some(
      (k) =>
        JSON.stringify(assetIds(fresh[k])) !==
        JSON.stringify(assetIds(prior[k])),
    )
  )
    throw Error(
      "Source changed. Review fresh data in " +
        dir +
        " before resaving the original draft.",
    );
  const copy = await read(path.join(registered.dir, "listing.json"));
  const { generateListing } = await import("./tiktok-mx-ptc.mjs");
  const [prepared, target] = await Promise.all([
    generateListing(fresh, copy, yenToPeso),
    preflight,
  ]);
  mark("planReady");
  await write(path.join(dir, "listing.json"), prepared.copy);
  await write(path.join(dir, "generation.json"), prepared.ptc);
  await save(registered.dir, false, true, fresh, prepared.copy, {
    ...target,
    ptc: prepared.ptc,
    expectedId: registered.id,
  });
}

async function readyForm(tab, withCommerce = false, allowEmptyDescription = false) {
  const numbers = withCommerce
    ? commerceScript(sellerRead).replace(/^return await /, "")
    : "null";
  return runCode(
    tab,
    `for(let i=0;i<100;i++){
    if(document.querySelector('${titleSelector}')?.value && (document.querySelector('${localDesc} .ProseMirror')?.textContent.trim() || (${allowEmptyDescription} && i>=12 && document.querySelector('${localDesc} .ProseMirror')))){
      const state=(${formState.toString()})();
      state.salesAndShipping=await ${numbers};
      return state;
    }
    await new Promise(r=>setTimeout(r,150));
  } throw Error("Draft editor did not load")`,
  );
}
export function normDraftTitle(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}
export function draftTitleOf(text) {
  const idToken = /(?:草稿|draft|商品|产品|SKU|product|shop|店铺)?\s*ID\s*[:：]\s*\d+/gi;
  // A wrapped title is every remaining line. Price sits in its own column.
  const lines = String(text ?? "")
    .split(/\n/)
    .map((line) => line.replace(idToken, "").trim())
    .filter((line) => line && !/^MX\$\s*[\d.,]+$/i.test(line));
  return normDraftTitle(lines.join(" "));
}
export function draftIdOf(text) {
  const source = String(text ?? "");
  const explicit = [...source.matchAll(/(?:草稿|draft)\s*ID\s*[:：]\s*(\d+)/gi)];
  if (explicit.length > 1) return null;
  if (explicit.length === 1) return explicit[0][1];
  if (/(?:商品|产品|SKU|product|shop|店铺)\s*ID\s*[:：]\s*\d+/i.test(source)) return null;
  const ids = [...source.matchAll(/(^|[^\p{L}\p{N}_])ID\s*[:：]\s*(\d+)/giu)].map((match) => match[2]);
  return ids.length === 1 ? ids[0] : null;
}
export function selectDraftRows(records, title, draftId = null) {
  const want = normDraftTitle(title);
  const matches = [];
  for (const record of records) {
    const text = String(record.text ?? "");
    const titleText = record.title != null && String(record.title).trim()
      ? draftTitleOf(record.title)
      : draftTitleOf(text);
    const id = record.id ?? draftIdOf(text);
    if (draftId != null && draftId !== "") {
      if (id != null && String(id) === String(draftId))
        matches.push({ text: text.slice(0, 450), id: String(id) });
      continue;
    }
    if (titleText !== want) continue;
    matches.push({ text: text.slice(0, 450), id: id || undefined });
  }
  return matches;
}
export function draftListReady(text, rowCount) {
  if (/暂无商品/.test(String(text || ""))) return true;
  return rowCount > 0;
}
export function writableDraftId({ matches, knownId = null, previous = {} }) {
  if (matches.length > 1 || (matches.length === 1 && !matches[0].id))
    throw new Error("Ambiguous draft match");
  const id = matches[0]?.id ? String(matches[0].id) : null;
  if (knownId && id !== String(knownId))
    throw new Error("Recorded draft ID not found in matching draft row; no new product created");
  if (!id || (knownId && id === String(knownId))) return id;
  const claimed = Boolean(previous?.saving || previous?.startedTab || previous?.stagedTab);
  const before = new Set((previous?.draftIdsBefore || []).map(String));
  if (claimed) {
    if (!Array.isArray(previous?.draftIdsBefore) || before.has(id))
      throw new Error("Refusing to edit another draft with the same title: " + id);
    return id;
  }
  throw new Error(
    "A matching draft already exists: " + id + ". Open it to reconcile; no duplicate created.",
  );
}
async function readDraftList(title, draftId) {
  let previous = null;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const text = document.body?.innerText || "";
    const empty = /暂无商品/.test(text);
    const records = [...document.querySelectorAll("tbody tr, [role=row]")].map((row) => {
      // The generic overflow component is also used by the “草稿” status badge.
      // The product cell contains the standalone draft ID and its adjacent title.
      const cell = [...row.querySelectorAll("td,[role=cell]")].find(c => draftIdOf(c.innerText));
      const raw = cell?.innerText || row.innerText || "";
      return { title: raw, text: row.innerText || "" };
    }).filter((row) => draftTitleOf(row.title) || draftIdOf(row.text));
    const ready = location.search.includes("tab=draft") && draftListReady(text, empty ? 0 : records.length);
    const signature = empty ? "empty" : records.map((row) => row.text).join("\u0000");
    if (ready && signature === previous) stable += 1;
    else stable = 0;
    previous = signature;
    if (ready && stable >= 1) {
      const rows = empty ? [] : records;
      return {
        matches: selectDraftRows(rows, title, draftId),
        ids: rows.map((row) => draftIdOf(row.text)).filter(Boolean),
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Draft list not ready or seller login required");
}
async function listDrafts(list, title, draftId = null) {
  const code = [
    normDraftTitle,
    draftTitleOf,
    draftIdOf,
    selectDraftRows,
    draftListReady,
    readDraftList,
  ].map((fn) => fn.toString()).join("\n");
  return runCode(
    list,
    code + "\nreturn await readDraftList(" + JSON.stringify(title) + "," + JSON.stringify(draftId) + ")",
  );
}
async function recoverTitle(tab, link, state, copy, dir) {
  if (state.url !== link || !copy.enTitle || state.enTitle === copy.enTitle) return false;
  // Only a title discrepancy can take this path. Keep all other checks active.
  check({ ...state, enTitle: copy.enTitle, title: copy.title }, copy);
  const selector = '[data-id="product.publish.title.input_lang"]';
  await bridge("trusted_type", { tabId: tab, selector, clear: true, value: copy.enTitle });
  await bridge("press_keys", { tabId: tab, keys: ["Tab"] });
  const translated = await js(tab, async (link, expected, old) => {
    let last = "", stable = 0;
    for (let i = 0; i < 40; i++) {
      if (location.href !== link) throw Error("Wrong draft during title recovery");
      const en = document.querySelector('[data-id="product.publish.title.input_lang"]')?.value;
      const es = document.querySelector('[data-id="product.publish.product_name"]')?.value;
      if (en === expected && es && es === last) stable++;
      else stable = 0;
      last = es;
      if (stable >= 5 && (es !== old || i >= 16)) return es;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error("Seller translation did not settle");
  }, link, copy.enTitle, state.title);
  if (translated !== copy.title) {
    const { validateTranslatedTitle } = await import("./tiktok-mx-ptc.mjs");
    const ptc = await validateTranslatedTitle(copy, translated);
    await write(path.join(dir, "title-generation.json"), { ...ptc, original: copy.title, translated });
  }
  const updated = await js(tab, formState);
  check(updated, { ...copy, title: translated });
  copy.title = translated;
  return true;
}
async function draftButton(tab, alreadyActive = false) {
  if (!alreadyActive) await bridge("activate_tab", { tabId: tab });
  const message = await js(tab, async () => {
    const button = [...document.querySelectorAll("button")].find(
      (e) => e.textContent.trim() === "另存为草稿",
    );
    if (!button || button.disabled)
      throw new Error("Draft save control not available");
    let result = "";
    const observer = new MutationObserver(() => {
      for (const e of document.querySelectorAll(
        "[class*=message-content],[role=alert]",
      )) {
        if (/提交失败|保存失败|草稿保存成功/.test(e.innerText))
          result = e.innerText.trim();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      button.click();
      for (let i = 0; i < 18 && !result; i++)
        await new Promise((r) => setTimeout(r, 150));
      return result;
    } finally {
      observer.disconnect();
    }
  });
  if (alreadyActive && message !== "草稿保存成功")
    throw Error("Draft save was not acknowledged: " + message);
  if (/失败/.test(message))
    throw new Error("Seller Center rejected the draft: " + message);
}
async function sellerTab(url, forceReload = false) {
  const existing = group.tabs.get(url);
  if (!existing) return open(url);
  if (forceReload) await bridge("reload_tab", { tabId: existing });
  return existing;
}
async function openCreateForm() {
  const tab = await open(createUrl);
  await bridge("wait_for", { tabId: tab, selector: titleSelector, timeoutMs: 20000 });
  mark("createFormReady");
  return tab;
}
export async function save(
  dir,
  readOnly = false,
  resave = false,
  fresh = null,
  revised = null,
  target = null,
  preparedForm = null,
) {
  const data = fresh || (await read(path.join(dir, "source.json"))),
    copy = revised || (await read(path.join(dir, "listing.json")));
  if (data.id !== sourceId(data.url))
    throw new Error("Source ID / URL mismatch");
  group ??= new DraftTabs(data.id, bridge);
  const invocationStarted = Date.now();
  const plan = commercialPlan(copy, data);
  const resultFile = path.join(dir, "receipt.json");
  const previous = await read(resultFile).catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return {};
  });
  if (
    !copy.title?.trim() ||
    copy.title.length > 255 ||
    !copy.description?.trim() ||
    !copy.gallery?.length ||
    copy.gallery.length > 9
  )
    throw new Error(
      "Check Spanish title, description and 1–9 gallery files in listing.json",
    );
  const files = (names) => Promise.all(names.map((n) => listingImage(dir, n, data.assets)));
  const gallery = await files(copy.gallery),
    details = await files(copy.details || []);
  // Serialize writes for this source, including separate callers preparing it simultaneously.
  const lock = path.join(home, "tiktok-mx-" + sourceId(data.url) + ".lock");
  await fs.mkdir(lock);
  try {
    const recordFile = sourceRecord(sourceId(data.url));
    await fs.mkdir(path.dirname(recordFile), { recursive: true, mode: 0o700 });
    const registered = await lookup(recordFile);
    if (registered && registered.dir !== dir)
      throw new Error("Source already has a run: " + registered.dir);
    const knownId = registered?.id || previous.id;
    if (readOnly && !knownId) throw new Error("No existing draft ID to verify");
    if (resave && !knownId) throw Error("Resave requires an existing draft ID");
    mark("saveStarted");
    if (target && knownId !== target.expectedId)
      throw Error("Draft mapping changed while preparing content");
    const list = target ? null : await sellerTab(drafts, true);
    const listState = target ? { matches: [], ids: [] } : await listDrafts(list, copy.title, knownId);
    const seenIds = [...new Set((listState.ids || []).map(String))];
    if (!target) mark("listRead");
    const claimed = Boolean(previous.saving || previous.startedTab || previous.stagedTab);
    const beforeIds = new Set((previous.draftIdsBefore || []).map(String));
    const matches = !knownId && claimed
      ? listState.matches.filter((row) => row.id && Array.isArray(previous.draftIdsBefore) && !beforeIds.has(String(row.id)))
      : listState.matches;
    let id = target ? target.expectedId : writableDraftId({ matches, knownId, previous });
    if (copy.missing?.length)
      throw new Error(
        "Resolve outstanding fields before saving: " + copy.missing.join(", "),
      );
    if (!readOnly) {
      await write(recordFile, {
        dir,
        title: registered?.title || copy.title,
        id: id || previous.id || null,
      });
      // Invalidate a previous success before changing or rechecking its persisted values.
      await write(resultFile, {
        ...previous,
        id: id || previous.id,
        verified: false,
        origins: plan.origins,
        draftIdsBefore: seenIds,
      });
    }
    let cat = previous.category;
    if (!id) {
      if (readOnly) throw new Error("No existing draft ID to verify");
      if (previous.saving || previous.id)
        throw new Error(
          "Previous save pending or draft missing. Reconcile the draft list before retrying.",
        );
      // A create tab already exists. Reuse it; never open a second form.
      let tab = preparedForm ?? null;
      if (previous.startedTab) {
        const sameForm = preparedForm == null || preparedForm === previous.startedTab;
        if (!previous.groupOwned || !sameForm)
          throw new Error(
            "Previous save pending or draft missing. Reconcile the draft list before retrying.",
          );
        tab = previous.startedTab;
      } else if (tab == null) tab = await openCreateForm();
      await write(resultFile, {
        groupOwned: true,
        draftIdsBefore: seenIds,
        startedTab: tab,
        title: copy.title,
      });
      const result = await fillPage(tab, seller + "/product/create?shop_region=MX", copy, plan, gallery, details);
      cat = result.category;
      await write(resultFile, {
        saving: true,
        draftIdsBefore: seenIds,
        tab,
        category: cat,
        title: copy.title,
        groupOwned: true,
        startedTab: tab,
      });
      mark("initialFieldsReady");
      await draftButton(tab, true);
      mark("initialSave");
      for (let i = 0; i < 3 && !id; i++) {
        await bridge("reload_tab", { tabId: list });
        const saved = await listDrafts(list, copy.title, null);
        const fresh = (saved.matches || []).filter((row) => row.id && !seenIds.includes(String(row.id)));
        if (fresh.length > 1) throw new Error("Ambiguous draft match");
        if (fresh.length === 1) id = fresh[0].id;
      }
      if (!id)
        throw new Error(
          "Save sent; draft ID not yet confirmed. Check before retrying.",
        );
      await write(resultFile, { id, category: cat, saving: true, draftIdsBefore: seenIds });
    }
    if (!knownId) mark("draftIdentified");
    const link = seller + "/product/edit-draft/" + id + "?shop_region=MX";
    let edit = target?.edit ?? (await sellerTab(link, true));
    // One read waits for the editor and captures bilingual text, media and every SKU.
    // Reload explicitly after the initial save, then reuse this persisted snapshot.
    if (!knownId && !target) await bridge("reload_tab", { tabId: edit });
    let state = target?.original ?? await readyForm(edit, true, true);
    if (state.url !== link) throw Error("Draft URL changed before readback");
    const firstPersisted = { at: Date.now(), title: state.enTitle, skus: state.salesAndShipping.skus };
    let changed = false;
    if (!state.category && copy.category && !readOnly) {
      cat = await category(edit, copy.category);
      if (!cat.selected && ["Exact category not offered", "Option disabled by seller center"].includes(cat.reason)) {
        const candidates = await js(edit, expected => {
          if (location.href !== expected) throw Error("Wrong draft during category recovery");
          const buttons = [...document.querySelectorAll("button")];
          return [...new Set(buttons.filter(b => b.innerText.trim() === "应用" && !b.disabled && b.getClientRects().length)
            .map(b => b.parentElement.parentElement.innerText.replace(/\s*应用\s*$/, "").trim())
            .filter(path => path.split(/\s+[>/-]\s+/).length >= 3))];
        }, link);
        if (candidates.length) {
          const { chooseCategory } = await import("./tiktok-mx-ptc.mjs");
          const { choice, ptc } = await chooseCategory(data, candidates);
          cat = await category(edit, choice);
          if (cat.selected) {
            copy.category = choice;
            await write(path.join(dir, "listing.json"), copy);
            await write(path.join(dir, "category-generation.json"), ptc);
          }
        }
      }
      for (let attempt = 0; !cat.selected && attempt < 20; attempt++) {
        const status = await js(edit, () => ({
          category: document
            .querySelector("#product-cascader-select-view")
            ?.innerText.trim(),
          captcha:
            /拖动完成上方拼图|请完成下列验证|Verify to continue/.test(
              document.body.innerText,
            ) ||
            [...document.querySelectorAll("iframe")].some(
              (f) =>
                /captcha|verifycenter/.test(f.src) &&
                f.getBoundingClientRect().height > 20,
            ),
          dialogs: [...document.querySelectorAll("[role=dialog]")].map((e) =>
            e.innerText.slice(0, 180),
          ),
        }));
        if (status.category) {
          cat = { ...cat, selected: true, shown: status.category };
          break;
        }
        console.error(
          "Category pending on tab " + edit + ": " + JSON.stringify(status),
        );
        if (!status.captcha && attempt > 1) break;
        await sleep(1500);
      }
      if (!cat.selected)
        throw Error("Category could not be selected: " + JSON.stringify(cat));
      await supplement(edit, copy);
      state = await js(edit, formState);
      changed = true;
    }
    let filled;
    if (target) {
      mark("copyStarted");
      filled = await fillPage(edit, link, copy, plan, gallery, details, resave);
      state = filled.state;
      stages.copyRead = filled.phases.copyRead;
      changed = true;
    }
    if (
      !readOnly &&
      !state.captcha &&
      state.title === copy.title &&
      state.gallery === gallery.length &&
      !state.detailImages &&
      (!state.description || state.description === "翻译为西班牙语")
    ) {
      const { title, description, enTitle, enDescription } = copy;
      await setCopy(edit, { title, description, enTitle, enDescription });
      for (const file of details)
        await bridge("upload_file", {
          tabId: edit,
          selector: localDesc + " input[type=file]",
          paths: [file],
        });
      state = await js(edit, formState);
      changed = true;
    }
    if (!target && !readOnly && await recoverTitle(edit, link, state, copy, dir)) {
      state = await js(edit, formState);
      changed = true;
    }
    check(state, copy);
    const categoryShown = state.category || cat.shown;
    const expectedCategory = copy.category?.label;
    const categoryPath = (s) => s?.trim().replace(/\s+(?:-|>|\/)\s+/g, "/");
    if (
      expectedCategory &&
      categoryPath(categoryShown) !== categoryPath(expectedCategory)
    )
      throw new Error("Category differs: " + categoryShown);
    mark("editorRead");
    const commerce = filled?.commerce ?? await commercialState(
      edit,
      plan,
      !readOnly,
      resave,
      state.salesAndShipping,
    );
    mark("fieldsWritten");
    if (changed || commerce.changed) {
      if (target) {
        // The seller can translate the English input asynchronously while prices are being set.
        const latest = await js(edit, formState);
        if (
          !sameText(latest.description, copy.description) ||
          latest.title !== copy.title
        ) {
          state = await setCopy(edit, {
            title: copy.title,
            description: copy.description,
            preserveImages: true,
          });
        } else state = latest;
        state = await restoreDetails(edit, state, copy, details);
        check(state, copy);
      }
      await draftButton(edit, !!target);
      mark("saved");
      // A successful save can navigate the editor back to the product list.
      edit = await open(link);
      await bridge("reload_tab", { tabId: edit });
      state = await readyForm(edit, true);
      if (await recoverTitle(edit, link, state, copy, dir)) {
        mark("titleRepair");
        await draftButton(edit, true);
        edit = await open(link);
        await bridge("reload_tab", { tabId: edit });
        state = await readyForm(edit, true);
      } else if (target && state.url === link && state.gallery === gallery.length &&
                 state.detailImages >= details.length && !state.captcha) {
        try {
          check(state, copy);
        } catch {
          await repairSavedCopy(edit, state, copy, details);
          await draftButton(edit, true);
          edit = await open(link);
          await bridge("reload_tab", { tabId: edit });
          state = await readyForm(edit, true);
        }
      }
      check(state, copy);
    }
    if (
      new URL(state.url).pathname !== "/product/edit-draft/" + id ||
      !state.category ||
      categoryPath(state.category) !== categoryPath(categoryShown)
    )
      throw new Error("Draft ID or category did not persist");
    let refreshed = commerce;
    if (commerce.changed || changed) {
      try {
        refreshed = await commercialState(
          edit,
          plan,
          false,
          false,
          state.salesAndShipping,
        );
      } catch (error) {
        if (!error.message.startsWith("Commercial fields differ after refresh"))
          throw error;
        await bridge("reload_tab", { tabId: edit });
        await bridge("wait_for", {
          tabId: edit,
          selector: titleSelector,
          timeoutMs: 20000,
        });
        state = await js(edit, formState);
        check(state, copy);
        if (
          new URL(state.url).pathname !== "/product/edit-draft/" + id ||
          categoryPath(state.category) !== categoryPath(categoryShown)
        )
          throw Error("Wrong draft or category on second read");
        refreshed = await commercialState(edit, plan);
      }
    }
    mark("verified");
    const started =
      (knownId && !resave) || readOnly ? invocationStarted : data.start;
    const receipt = {
      id,
      link,
      title: copy.title,
      verified: true,
      formRuns,
      skuWrites,
      firstPersisted,
      bridgeCalls,
      ...(target && {
        ptc: target.ptc,
        preflight: { editorAt: target.editorAt },
      }),
      category: cat,
      readback: { ...state, salesAndShipping: refreshed.state },
      origins: plan.origins,
      estimates: Object.fromEntries(
        Object.entries(plan.origins).filter(([, v]) => v.kind === "estimated"),
      ),
      missing: copy.missing || [],
      started: new Date(started).toISOString(),
      verifiedAt: new Date().toISOString(),
      stages: {
        start: data.start,
        sourceRead: data.sourceRead,
        prepared: data.prepared,
        ...stages,
      },
      elapsedSeconds: (Date.now() - started) / 1000,
      calls:
        (fresh || (knownId && !resave) || readOnly ? 0 : data.prepareCalls) +
        calls,
    };
    if (!readOnly) {
      if (fresh && revised) await write(path.join(dir, "source.json"), fresh);
      await write(path.join(dir, "listing.json"), copy);
      await write(resultFile, receipt);
      await write(recordFile, { dir, id, title: copy.title, link });
      const { rememberPlan } = await import("./tiktok-mx-ptc.mjs");
      await rememberPlan(data, copy, receipt);
    }
    console.log(JSON.stringify(receipt));
  } finally {
    await fs.rmdir(lock);
  }
}
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}
if (invokedDirectly()) {
try {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "install") {
    await fs.mkdir(home, { recursive: true });
    await fs.copyFile(
      new URL("./tiktok-mx-tabs.mjs", import.meta.url),
      path.join(home, "tiktok-mx-tabs.mjs"),
    );
    for (const name of ["tiktok-mx-commerce.mjs", "tiktok-mx-editor.mjs"])
      await fs.copyFile(new URL("../extension/skills/tiktok-mx-draft/" + name, import.meta.url), path.join(home, name));
    const { build } = await import("esbuild");
    await build({
      entryPoints: [new URL("./tiktok-mx-ptc.mjs", import.meta.url).pathname],
      bundle: true,
      platform: "node",
      define: { "process.env.PAGELENS_MX_DEFAULT_FLOW_DIR": JSON.stringify(
        fileURLToPath(new URL("../.pagelens-flows/tiktok-mx", import.meta.url))) },
      format: "esm",
      outfile: path.join(home, "tiktok-mx-ptc.mjs"),
    });
    await fs.copyFile(
      new URL(import.meta.url),
      path.join(home, "tiktok-mx-draft.mjs"),
    );
    console.log("Installed PageLens TikTok MX draft workflow");
  } else if (mode === "create" && arg) await createDraft(arg, Number(process.argv[4]));
  else if (mode === "replay" && arg) {
    const source = await read(path.join(path.resolve(arg), "source.json"));
    const { matchingPlan, generateListing, flowRoot } = await import("./tiktok-mx-ptc.mjs");
    const rate = Number(process.argv[4]);
    if (!(rate > 0 && Number.isFinite(rate))) throw Error("A positive JPY to MXN rate is required");
    const previous = process.argv.slice(5).includes("--fresh") ? null : await matchingPlan(source);
    const started = Date.now();
    const generated = await generateListing(source, previous, rate, undefined, Boolean(previous));
    const runs = path.join(flowRoot(), "replays");
    await fs.mkdir(runs, { recursive: true, mode: 0o700 });
    const file = path.join(runs, source.id + "-" + randomUUID() + ".json");
    await write(file, { sourceId: source.id, started, finished: Date.now(), ...generated });
    console.log(JSON.stringify({ file, mode: generated.ptc.mode, milliseconds: Date.now() - started }));
  }
  else if (mode === "generate" && arg) {
    const dir = path.resolve(arg);
    const source = await read(path.join(dir, "source.json"));
    if (await lookup(sourceRecord(source.id)))
      throw Error("Existing source: use rerun");
    const { generateListing } = await import("./tiktok-mx-ptc.mjs");
    const generated = await generateListing(
      source,
      null,
      Number(process.argv[4]),
    );
    await write(path.join(dir, "listing.json"), generated.copy);
    await write(path.join(dir, "generation.json"), generated.ptc);
  } else if (mode === "rerun" && arg) await rerun(arg, Number(process.argv[4]));
  else if (["prepare", "recollect"].includes(mode) && arg)
    await prepare(arg, mode === "recollect");
  else if (["save", "verify", "resave"].includes(mode) && arg)
    await save(path.resolve(arg), mode === "verify", mode === "resave");
  else
    throw new Error(
      "Usage: tiktok-mx-draft.mjs prepare|recollect PRODUCT_URL | save|resave|verify RUN_DIRECTORY",
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (pendingPreflight) await pendingPreflight.catch(() => {});
  if (group) await group.close();
}
}
