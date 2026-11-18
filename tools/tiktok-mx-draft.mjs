#!/usr/bin/env node
// Browser operations run in the signed-in Chrome profile through PageLens.
import { DraftTabs } from "./tiktok-mx-tabs.mjs";
import fs from "node:fs/promises";
import { commercialDifferences, commercialPlan } from "./tiktok-mx-commerce.mjs";
export { normDraftTitle, draftTitleOf, draftIdOf, selectDraftRows, draftListReady } from "./tiktok-mx-editor.mjs";
import { attributeCode, checkAttributes, checkDraftAttributes, matchAttributeValue, draftListCode, mxEditor, formState, readFreshDocument, snapshotCode, sameText, check, titleSelector } from "./tiktok-mx-editor.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
const compactOutput = invokedDirectly() && process.argv.includes("--summary");
const home = process.env.PAGELENS_HOME
  ? path.resolve(process.env.PAGELENS_HOME)
  : path.join(os.homedir(), ".pagelens");
let bridgeOverride = null;
let nativeDispatch = null;
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
const saveSignals = [];
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
  const { title, description, enTitle, enDescription, category } = copy;
  const content = { title, description, enTitle, enDescription, category, gallery: copy.gallery, details: copy.details };
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
  formRuns.push({ url, transport: "page", steps: result.steps, phases: result.phases, enTitle: result.state?.enTitle, skus: result.commerce?.state.skus });
  skuWrites.push(...result.skuWrites);
  if (result.fillError) throw Error(result.fillError);
  return result;
}
async function inbox(tool, job, timeoutMs = 75000) {
  const id = randomUUID();
  if (nativeDispatch) {
    const start = Date.now();
    calls++;
    try { return await nativeDispatch(job); }
    finally { bridgeCalls.push({ tool, start, end: Date.now() }); }
  }
  const queue = path.join(home, "agent-inbox");
  const start = Date.now();
  calls++;
  await write(path.join(queue, id + ".json"), {
    id,
    createdAt: new Date().toISOString(),
    followUp: true,
    ...job,
  });
  while (Date.now() - start < timeoutMs) {
    try {
      const reply = await read(path.join(home, "agent-outbox", id + ".json"));
      bridgeCalls.push({ tool, start, end: Date.now(), executionMs: reply.meta?.ms });
      if (!reply.ok) throw new Error(tool + ": " + JSON.stringify(reply.error));
      return reply.result;
    } catch (e) {
      if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
    }
    await sleep(65);
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
  if (u.origin !== "https://shop.tiktok.com" || u.username || u.password)
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
// Chrome may return a new tab while its visible URL is still empty. The bridge
// can authorize that tab (including as a group anchor) only after navigation.
export async function waitForSourceTab(tab, url, list = () => bridge("list_tabs", { query: new URL(url).hostname })) {
  const expected = new URL(url);
  const id = sourceId(url);
  const deadline = Date.now() + 30000;
  do {
    const live = (await list()).find(entry => entry.id === tab);
    if (live?.url) {
      const page = new URL(live.url);
      if (page.origin === expected.origin && page.pathname.split("/")[1] === expected.pathname.split("/")[1] &&
          sourceId(page.href) === id) return;
      throw Error("Source tab navigated to another product");
    }
    await sleep(150);
  } while (Date.now() < deadline);
  throw Error("Source tab did not finish navigating to the requested product");
}
async function prepare(url, fresh = false, afterOpening, onFactsReady, preloadCreate = false) {
  const previousRun = await lookup(sourceRecord(sourceId(url)));
  if (previousRun && !fresh) {
    if (!nativeDispatch) console.log(JSON.stringify({ existing: true, ...previousRun }));
    return;
  }
  const id = sourceId(url),
    start = Date.now();
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pagelens-mx-" + id + "-"),
  );
  group = new DraftTabs(id, bridge);
  if (preloadCreate) await group.open(createUrl, [url, drafts]);
  const tab = group.tabs.get(url) ?? await open(url);
  if (preloadCreate) afterOpening?.();
  await waitForSourceTab(tab, url);
  if (!preloadCreate) afterOpening?.();
  let data;
  try {
    data = await js(tab, extract, id);
  } catch (error) {
    if (!/Frame with ID 0 is showing error page/i.test(error.message)) throw error;
    mark("sourceReload");
    await bridge("reload_tab", { tabId: tab });
    data = await js(tab, extract, id);
  }
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
  const { flowRoot } = await import("./tiktok-mx-ptc.mjs");
  const cacheDir = path.join(flowRoot(), "images", id);
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const assetKey = url => createHash("sha256").update(url).digest("hex");
  const assets = images.map((url, i) => ({
    name: "image-" + String(i + 1).padStart(2, "0") + ".jpg", url, reused: false,
  }));
  const downloadImages = async () => {
    for (let i = 0; i < assets.length; i += 5) {
      await Promise.all(assets.slice(i, i + 5).map(async asset => {
        const file = path.join(dir, asset.name);
        const cacheFile = path.join(cacheDir, assetKey(asset.url) + ".jpg");
        const previous = priorSource?.assets.find(a => a.url === asset.url);
        for (const candidate of [cacheFile, ...(previous ? [path.join(previousRun.dir, previous.name)] : [])]) {
          try {
            await fs.copyFile(candidate, file);
            asset.reused = true;
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (!asset.reused) await imageFile(asset.url, file);
        const tmp = cacheFile + "." + randomUUID();
        await fs.copyFile(file, tmp);
        await fs.rename(tmp, cacheFile);
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
  if (!nativeDispatch && (!onFactsReady || !compactOutput)) console.log(
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

async function createDraft(url, rate) {
  if (await lookup(sourceRecord(sourceId(url)))) throw Error("Source already registered; use rerun");
  const { generateListing, matchingPlan } = await import("./tiktok-mx-ptc.mjs");
  let generated, initialList;
  const dir = await prepare(url, false, () => {
    pendingPreflight = openCreateForm();
    pendingPreflight.catch(() => {});
  }, async (facts, dir) => {
    const previous = await matchingPlan(facts);
    mark("generationStarted");
    generated = await generateListing(facts, previous, rate, undefined, Boolean(previous));
    mark("generationReady");
    initialList = listDrafts(group.tabs.get(drafts), generated.copy.title, null);
    initialList.catch(() => {});
    await write(path.join(dir, "generation.json"), generated.ptc);
  }, true);
  const data = await read(path.join(dir, "source.json"));
  const tab = await pendingPreflight;
  commercialPlan(generated.copy, data);
  await write(path.join(dir, "listing.json"), generated.copy);
  mark("planReady");
  await save(dir, false, false, null, null, null, tab, false, initialList);
  return dir;
}

// Native Messaging gives each workflow its own host process and private port.
export async function createHostedDraft(sourceId, rate, dispatch) {
  if (nativeDispatch || !/^\d{12,22}$/.test(sourceId) || !Number.isFinite(rate) || rate <= 0)
    throw Error("Invalid native draft task");
  nativeDispatch = dispatch;
  try {
    const dir = await createDraft("https://shop.tiktok.com/jp/pdp/" + sourceId, rate);
    return { dir, receipt: await read(path.join(dir, "receipt.json")) };
  } finally {
    if (pendingPreflight) await pendingPreflight.catch(() => {});
    try { await group?.close(); } finally { nativeDispatch = null; }
  }
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
  return runCode(tab, snapshotCode(withCommerce, allowEmptyDescription));
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
async function listDrafts(list, title, draftId = null, waitForMatch = false) {
  return runCode(list, draftListCode(title, draftId, waitForMatch));
}
async function refreshDraftList(list, title, waitForMatch = false) {
  if (!bridgeOverride) {
    try {
      return await inbox("refresh_mx_draft_list", { action: "refresh_mx_draft_list",
        tabId: list, url: drafts, title, waitForMatch });
    } catch (error) {
      if (!error.message.includes("unknown action: refresh_mx_draft_list")) throw error;
    }
  }
  await bridge("reload_tab", { tabId: list });
  return listDrafts(list, title, null, waitForMatch);
}

// Keep IDs seen before the refresh excluded from post-save identification, even
// when a deleted row disappears and later resurfaces on a stale seller replica.
export async function confirmCreateList(snapshot, refresh) {
  if (!snapshot.matches.length) return snapshot;
  const current = await refresh();
  return { ...current, ids: [...new Set([...snapshot.ids, ...current.ids])] };
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
  const signal = await js(tab, async () => {
    const button = [...document.querySelectorAll("button")].find(
      (e) => e.textContent.trim() === "另存为草稿",
    );
    if (!button || button.disabled)
      throw new Error("Draft save control not available");
    let result = "", savedLink = "";
    const observer = new MutationObserver(() => {
      for (const e of document.querySelectorAll(
        "[class*=message-content],[role=alert]",
      )) {
        if (/提交失败|保存失败|草稿保存成功/.test(e.innerText)) {
          result = e.innerText.trim();
          savedLink = result.includes("草稿保存成功") ? e.querySelector('a[href*="/product/edit-draft/"]')?.href || "" : "";
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      button.click();
      for (let i = 0; i < 18 && !result; i++)
        await new Promise((r) => setTimeout(r, 150));
      return { message: result, url: savedLink || location.href };
    } finally {
      observer.disconnect();
    }
  });
  const message = signal?.message ?? signal;
  let draftId = null;
  if (signal?.url && message?.includes("草稿保存成功")) {
    const page = new URL(signal.url);
    if (page.origin === seller && page.searchParams.get("shop_region") === "MX")
      draftId = page.pathname.match(/^\/product\/edit-draft\/(\d+)$/)?.[1] ?? null;
  }
  saveSignals.push({ tab, message, draftId, at: Date.now() });
  return message === "草稿保存成功";
}
// Read the same draft after a save. Seller Center can expose an older snapshot
// while an acknowledged or apparently failed write is still propagating.
function matchesDraft(state, copy, plan) {
  const normalizeCategory = value => value?.trim().replace(/\s*[-/>]\s*/g, "/");
  if (!state.category || normalizeCategory(state.category) !== normalizeCategory(copy.category?.label)) return false;
  if (commercialDifferences(state.salesAndShipping, plan).length) return false;
  try {
    check(state, copy);
    checkDraftAttributes(copy, state);
    return true;
  } catch {
    return false;
  }
}

async function reconcileDraft({ link, copy, plan, readFresh, attempts = 3, repairProse = false }) {
  let state;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(i === 1 ? 1000 : 4000);
    state = await readFresh();
    if (state.url !== link || state.captcha) throw Error("Unexpected draft URL or verification during readback");
    const matched = matchesDraft(state, copy, plan);
    refreshReads.push({ at: Date.now(), matched, title: state.enTitle, gallery: state.gallery,
      detailImages: state.detailImages, skus: state.salesAndShipping?.skus });
    if (matched || (repairProse && state.description?.trim() &&
        matchesDraft({ ...state, description: copy.description }, copy, plan))) break;
  }
  return state;
}

let supportsDraftRead = true;
const refreshReads = [];
async function readSaved(tab, link, copy, plan, attempts, repairProse = false) {
  return reconcileDraft({ link, copy, plan, attempts, repairProse, readFresh: async () => {
    if (supportsDraftRead && !bridgeOverride) {
      try {
        return await inbox("read_mx_draft", { action: "read_mx_draft", tabId: tab, url: link, expectedDetails: copy.details?.length || 0 });
      } catch (error) {
        if (!error.message.includes("unknown action: read_mx_draft")) throw error;
        supportsDraftRead = false;
      }
    }
    return readFreshDocument(link, async (tool, args) => {
      const result = await bridge(tool, { ...args, tabId: tab });
      if (result?.ok === false) throw Error(result.error || "PageLens draft read failed");
      return result;
    });
  } });
}
async function resolveCategory(tab, url, source, copy, dir) {
  const candidates = await js(tab, expected => {
    if (location.href !== expected) throw Error("Draft changed during category selection");
    return [...new Set([...document.querySelectorAll("button")].filter(b => b.innerText.trim() === "应用" &&
      !b.disabled && b.getClientRects().length).map(b => b.parentElement.parentElement.innerText.replace(/\s*应用\s*$/, "").trim())
      .filter(path => path.split(/\s+[>/-]\s+/).length >= 3))];
  }, url);
  const { chooseCategory } = await import("./tiktok-mx-ptc.mjs");
  const { choice, ptc } = await chooseCategory(source, candidates);
  const selected = await category(tab, choice);
  if (!selected.selected) throw Error("Recommended category did not persist: " + choice.label);
  copy.category = choice;
  await write(path.join(dir, "listing.json"), copy);
  await write(path.join(dir, "category-generation.json"), ptc);
  return selected;
}

export function compatibleAttributePlan(binding, category, catalog) {
  const path = value => value?.trim().replace(/\s+[-/>]\s+|\s*[>/]\s*/g, "/");
  if (!binding?.category || path(binding.category) !== path(category) || !binding.values ||
      catalog.length !== Object.keys(binding.values).length) return false;
  return catalog.every(field => {
    const values = binding.values[field.name];
    return Array.isArray(values) && (field.multiple || values.length <= 1) &&
      values.every(value => typeof value === "string" && matchAttributeValue(field.options, value));
  });
}

async function ensureAttributes(tab, url, state, source, copy, dir) {
  if (!state.hasCategoryAttributes && !copy.attributePlan) return false;
  const catalog = state.attributeCatalog ?? await runCode(tab, attributeCode(url));
  let binding = copy.attributePlan;
  if (!catalog.length && (state.hasCategoryAttributes || binding && Object.keys(binding.values).length)) throw Error("Category attributes disappeared");
  const fits = compatibleAttributePlan(binding, state.category, catalog);
  if (!fits) {
    const { chooseAttributes } = await import("./tiktok-mx-ptc.mjs");
    const { values, ptc } = await chooseAttributes(source, catalog, undefined, copy.attributes);
    binding = { category: state.category, values };
    copy.attributePlan = binding;
    await write(path.join(dir, "attribute-generation.json"), ptc);
    await write(path.join(dir, "listing.json"), copy);
  }
  if (fits) mark("attributePlanReused");
  if (catalog.every(f => binding.values[f.name].every(value => f.selected.includes(matchAttributeValue(f.options, value))))) {
    state.attributeCatalog = catalog;
    return false;
  }
  state.attributeCatalog = await runCode(tab, attributeCode(url, binding.values));
  checkAttributes(binding.values, state.attributeCatalog);
  return true;
}

async function sellerTab(url, forceReload = false) {
  const existing = group.tabs.get(url);
  if (!existing) return open(url);
  if (forceReload) await bridge("reload_tab", { tabId: existing });
  return existing;
}
async function openCreateForm() {
  const tab = group.tabs.get(createUrl) ?? await open(createUrl);
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
  replaceClosed = false,
  initialList = null,
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
    const registeredLink = seller + "/product/edit-draft/" + knownId + "?shop_region=MX";
    const verifiedRecord = readOnly && previous.verified && previous.id === registered?.id &&
      previous.link === registeredLink && registered?.link === registeredLink;
    const skipList = target || verifiedRecord;
    const list = skipList ? null : await sellerTab(drafts, preparedForm == null);
    let listState = skipList ? { matches: [], ids: [] } : await (initialList && !knownId ? initialList : listDrafts(list, copy.title, knownId));
    if (!skipList && !knownId && !previous.startedTab && !previous.saving && !previous.stagedTab)
      listState = await confirmCreateList(listState, () => refreshDraftList(list, copy.title));
    const seenIds = [...new Set((listState.ids || []).map(String))];
    if (!skipList) mark("listRead");
    const claimed = Boolean(previous.saving || previous.startedTab || previous.stagedTab);
    const beforeIds = new Set((previous.draftIdsBefore || []).map(String));
    const matches = !knownId && claimed
      ? listState.matches.filter((row) => row.id && Array.isArray(previous.draftIdsBefore) && !beforeIds.has(String(row.id)))
      : listState.matches;
    let id = skipList ? knownId : writableDraftId({ matches, knownId, previous });
    let replacing = false;
    if (!readOnly && previous.groupOwned && Number.isInteger(previous.startedGroup) && previous.startedTab) {
      const live = (await bridge("list_tabs", {})).find(t => t.id === previous.startedTab);
      if (live?.groupId === previous.startedGroup && live.url === createUrl) {
        group.owned.add(live.id);
        if (!id) group.pendingForm = live.id;
      } else if (!live && !id && replaceClosed && previous.saving && ["提交失败", "保存失败"].includes(previous.saveMessage) &&
          previous.title === copy.title && !listState.matches.length && Array.isArray(previous.draftIdsBefore) &&
          seenIds.every(seen => beforeIds.has(seen)) && registered?.dir === dir) {
        replacing = true;
      } else if (!id) throw Error("Recorded create form is no longer available; reconcile the draft list before retrying");
    }
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
        draftIdsBefore: previous.draftIdsBefore ?? seenIds,
      });
    }
    let cat = previous.category;
    let initialAcknowledged = true;
    if (!id) {
      if (readOnly) throw new Error("No existing draft ID to verify");
      const retryRejectedCheckpoint = previous.partial && previous.saving &&
        ["提交失败", "保存失败"].includes(previous.saveMessage) && group.pendingForm === previous.startedTab &&
        Number.isInteger(previous.startedGroup);
      if ((previous.saving && !retryRejectedCheckpoint && !replacing) || previous.id)
        throw new Error(
          "Previous save pending or draft missing. Reconcile the draft list before retrying.",
        );
      // A create tab already exists. Reuse it; never open a second form.
      let tab = preparedForm ?? null;
      if (previous.startedTab && !replacing) {
        const sameForm = preparedForm == null || preparedForm === previous.startedTab;
        if (!previous.groupOwned || !sameForm)
          throw new Error(
            "Previous save pending or draft missing. Reconcile the draft list before retrying.",
          );
        tab = previous.startedTab;
      } else if (tab == null) tab = await openCreateForm();
      group.pendingForm = tab;
      const pending = {
        groupOwned: true,
        startedGroup: previous.startedTab && !replacing ? previous.startedGroup : group.groupId,
        draftIdsBefore: previous.draftIdsBefore ?? seenIds,
        startedTab: tab,
        galleryOrder: copy.gallery,
        title: copy.title,
        verified: false,
      };
      await write(resultFile, pending);
      // On retry the existing form can already contain uploaded media. Checkpoint
      // those fields and finish on the identified draft instead of uploading again.
      let checkpoint = previous.startedTab && !replacing ? await js(tab, formState) : null;
      if (checkpoint && checkpoint.url !== createUrl) throw Error("Unexpected retained form URL");
      if (!checkpoint?.gallery && !checkpoint?.detailImages) {
        try {
          const result = await fillPage(tab, createUrl, copy, plan, gallery, details);
          cat = result.category;
          if (!cat?.selected && copy.category) {
            cat = await resolveCategory(tab, createUrl, data, copy, dir);
            await supplement(tab, { attributes: {} });
            await commercialState(tab, plan, true);
            result.state = await js(tab, formState);
          }
          if (cat?.selected) await ensureAttributes(tab, createUrl, result.state, data, copy, dir);
          checkpoint = null;
        } catch (error) {
          await write(resultFile, { ...pending, skuWrites, formRuns, fillError: error.message });
          const mounting = error.message.includes("Select an available product category first");
          if (!mounting && !/Seller control not ready: committed option |Variant slot changed before retry:/.test(error.message)) throw error;
          if (mounting) {
            const code = "const read=" + formState.toString() + ";const until=Date.now()+20000;" +
              "do { const s=read(); if (s.url!==" + JSON.stringify(createUrl) +
              " || s.captcha || (s.category && s.gallery===" + gallery.length +
              " && s.detailImages>=" + details.length + ")) return s;" +
              "await new Promise(r=>setTimeout(r,200)); } while(Date.now()<until); return read()";
            checkpoint = await runCode(tab, code);
          } else checkpoint = await readyForm(tab, false, true);
          if (!checkpoint.category) throw error;
        }
      }
      if (checkpoint) {
        if (checkpoint.url !== createUrl) throw Error("Unexpected draft checkpoint URL");
        check(checkpoint, copy);
        cat = { selected: Boolean(checkpoint.category), shown: checkpoint.category };
        if (checkpoint.category) {
          if (checkpoint.category?.replace(/\s*[-/>]\s*/g, "/") !== copy.category?.label?.replace(/\s*[-/>]\s*/g, "/"))
            throw Error("Retained draft category changed");
          await supplement(tab, { attributes: {} });
          await ensureAttributes(tab, createUrl, checkpoint, data, copy, dir);
          await commercialState(tab, plan, true);
          checkpoint = null;
        }
      }
      if (checkpoint) {
        mark("partialFieldsReady");
      } else mark("initialFieldsReady");
      let beforeSave;
      try {
        beforeSave = await js(tab, formState);
        if (beforeSave.url !== createUrl) throw Error("Unexpected editor before first save");
        check(beforeSave, copy);
      } catch (error) {
        await write(resultFile, { ...pending, skuWrites, formRuns, fillError: error.message });
        throw error;
      }
      const submitting = {
        ...pending,
        skuWrites, formRuns, firstSaveGallery: beforeSave.gallery,
        saving: true,
        partial: Boolean(checkpoint),
        tab,
        category: cat,
      };
      await write(resultFile, submitting);
      initialAcknowledged = await draftButton(tab, true);
      await write(resultFile, { ...submitting, saveMessage: saveSignals.at(-1).message });
      mark("initialSave");
      const signalId = saveSignals.at(-1).draftId;
      if (signalId && !seenIds.includes(signalId)) id = signalId;
      // Reload the existing list immediately. A second fresh read is cheaper
      // than waiting on a list document that cannot see the new row yet.
      const identifyUntil = Date.now() + 60000;
      for (let i = 0; i < 24 && Date.now() < identifyUntil && !id; i++) {
        const saved = await refreshDraftList(list, copy.title, i >= 2);
        const fresh = (saved.matches || []).filter((row) => row.id && !seenIds.includes(String(row.id)));
        if (fresh.length > 1) throw new Error("Ambiguous draft match");
        if (fresh.length === 1) id = fresh[0].id;
      }
      if (!id)
        throw new Error(
          "Save sent; draft ID not yet confirmed. Check before retrying.",
        );
      await write(resultFile, { ...submitting, id, saveMessage: saveSignals.at(-1).message });
      await write(recordFile, { dir, id, title: copy.title, link: seller + "/product/edit-draft/" + id + "?shop_region=MX" });
      group.pendingForm = null;
    }
    if (!knownId) mark("draftIdentified");
    const link = seller + "/product/edit-draft/" + id + "?shop_region=MX";
    let edit = target?.edit ?? (await sellerTab(link, Boolean(knownId && !readOnly)));
    // One read waits for the editor and captures bilingual text, media and every SKU.
    // Reload explicitly after the initial save, then reuse this persisted snapshot.
    let state = target?.original;
    if (!state && (!knownId || readOnly)) {
      const attempts = readOnly || cat?.selected || !initialAcknowledged ? 3 : 1;
      state = await readSaved(edit, link, copy, plan, attempts, !readOnly);
    }
    state ??= await readyForm(edit, true, true);
    if (state.url !== link) throw Error("Draft URL changed before readback");
    const firstPersisted = refreshReads[0] ?? { at: Date.now(), matched: matchesDraft(state, copy, plan), title: state.enTitle, skus: state.salesAndShipping.skus };
    let changed = false;
    if (!state.category && copy.category && !readOnly) {
      cat = await category(edit, copy.category);
      if (!cat.selected && ["Exact category not offered", "Option disabled by seller center"].includes(cat.reason)) {
        cat = await resolveCategory(edit, link, data, copy, dir);
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
      await supplement(edit, { attributes: {} });
      state = await js(edit, formState);
      changed = true;
    }
    const checkpoint = !readOnly && state.gallery < gallery.length &&
      await lookup(path.join(dir, "gallery-checkpoint.json"));
    const ownedRun = checkpoint && await read(resultFile);
    if (checkpoint && ownedRun.startedTab === checkpoint.tab && ownedRun.groupOwned &&
        checkpoint.title === copy.title && state.title === copy.title && !state.captcha &&
        state.gallery === checkpoint.confirmedPrefix && JSON.stringify(checkpoint.gallery) === JSON.stringify(copy.gallery)) {
      for (let i = state.gallery; i < gallery.length; i++) {
        await bridge("upload_file", { tabId: edit, selector: 'input[type=file][accept=".jpg,.png,.jpeg"]', paths: [gallery[i]] });
        await runCode(edit, "const until=Date.now()+25000;do{const s=(" + formState.toString() +
          ")();if(s.url!==" + JSON.stringify(link) + "||s.captcha)throw Error('Unexpected draft or verification');if(s.gallery===" +
          (i + 1) + ")return true;await new Promise(r=>setTimeout(r,200))}while(Date.now()<until);throw Error('Gallery upload pending')");
      }
      state = await readyForm(edit, true, true);
      changed = true;
    }
    let filled;
    // A form can already exist as a draft after a previous run stopped. Use the
    // same single-job editor as the normal rewrite when its content identifies it.
    const expectedPath = copy.category?.label?.replace(/\s+[-/>]\s+/g, "/");
    const incompleteRows = !readOnly && !target && state.salesAndShipping &&
      commercialDifferences(state.salesAndShipping, plan).length > 0 &&
      state.title === copy.title && state.category && state.category.replace(/\s+[-/>]\s+/g, "/") === expectedPath && state.gallery === gallery.length &&
      (!state.detailImages || state.detailImages === details.length);
    if (target || incompleteRows) {
      mark("copyStarted");
      filled = await fillPage(edit, link, copy, plan, gallery, details, resave);
      state = filled.state;
      stages.copyRead = filled.phases.copyRead;
      changed = true;
    }
    if (!target && !readOnly && !state.captcha && state.title === copy.title &&
        state.gallery === gallery.length) {
      const differentProse = !sameText(state.description, copy.description) ||
        (copy.enDescription && !sameText(state.enDescription || "", copy.enDescription));
      if (differentProse) {
        state = await setCopy(edit, { title: copy.title, description: copy.description,
          enTitle: copy.enTitle, enDescription: copy.enDescription, preserveImages: true });
        changed = true;
      }
      if (!state.detailImages && details.length) {
        state = await restoreDetails(edit, state, copy, details);
        changed = true;
      }
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
    if (!readOnly && await ensureAttributes(edit, link, state, data, copy, dir)) changed = true;
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
      const acknowledged = await draftButton(edit, !!target);
      mark("saved");
      // A successful save can navigate the editor back to the product list.
      edit = await open(link);
      state = await readSaved(edit, link, copy, plan);
      // A forced rewrite of identical values needs a positive save indication.
      if (resave && !acknowledged && target && matchesDraft(target.original, copy, plan))
        throw Error("Original values match but the requested resave was not acknowledged");
      if (await recoverTitle(edit, link, state, copy, dir)) {
        mark("titleRepair");
        await draftButton(edit, true);
        edit = await open(link);
        state = await readSaved(edit, link, copy, plan);
      } else if (target && state.url === link && state.gallery === gallery.length &&
                 state.detailImages >= details.length && !state.captcha) {
        try {
          check(state, copy);
        } catch {
          await repairSavedCopy(edit, state, copy, details);
          await draftButton(edit, true);
          edit = await open(link);
          state = await readSaved(edit, link, copy, plan);
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
    if (copy.attributePlan || state.hasCategoryAttributes) {
      state.attributeCatalog ??= await runCode(edit, attributeCode(link));
      checkDraftAttributes(copy, state);
    }
    mark("verified");
    const started =
      (knownId && !resave) || previous.startedTab || readOnly ? invocationStarted : data.start;
    const receipt = {
      id,
      link,
      title: copy.title,
      verified: true,
      formRuns,
      skuWrites,
      firstPersisted,
      refreshReads,
      saveSignals,
      bridgeCalls,
      firstSaveGallery: (await lookup(resultFile))?.firstSaveGallery,
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
      const generation = target?.ptc ?? await lookup(path.join(dir, "generation.json"));
      await rememberPlan(data, copy, receipt, generation?.versions);
    }
    if (!nativeDispatch) printReceipt(receipt, resultFile);

  } finally {
    await fs.rmdir(lock);
  }
}
function printReceipt(receipt, resultFile) {
  const { readback, id, link, origins, skuWrites, stages, elapsedSeconds, verified } = receipt;
  const { brand, packagedWeightGrams, packageCm, skus, options } = readback.salesAndShipping;
  const rows = skus.map(({ label, stock, priceMXN }) => {
    const aliases = options.find(labels => labels.includes(label)) || [label];
    const option = aliases.find(value => Object.hasOwn(origins, value + ".priceMXN"));
    const writes = skuWrites.filter(write => write.option === option);
    return { label, stock, priceMXN, priceBasis: origins[option + ".priceMXN"]?.basis,
      attempts: writes.reduce((count, write) => count + write.attempts.length, 0) };
  });
  console.log(JSON.stringify(compactOutput ? {
    verified, id, link, enTitle: readback.enTitle,
    attributes: readback.attributeCatalog?.map(({ name, selected }) => ({ name, selected })), gallery: readback.gallery, detailImages: readback.detailImages,
    rows, brand, packagedWeightGrams, packageCm, estimatedFields: Object.keys(receipt.estimates),
    elapsedSeconds, stages, receiptFile: resultFile, firstRefreshMatched: receipt.firstPersisted.matched,
  } : receipt));
}

async function submitCreate(url, rate) {
  const id = sourceId(url);
  // The native transport currently serves Japanese product URLs.
  if (!new URL(url).pathname.startsWith("/jp/")) return createDraft(url, rate);
  if (!Number.isFinite(rate) || rate <= 0) throw Error("A positive JPY to MXN rate is required");
  const result = await inbox("ptc_create_mx_draft", { action: "ptc_create_mx_draft", sourceId: id, rate }, 315000);
  const record = await read(sourceRecord(id));
  if (!result.verified || result.draftId !== record.id) throw Error("Registered draft differs from the PTC result");
  const file = path.join(record.dir, "receipt.json");
  const receipt = await read(file);
  if (!receipt.verified || receipt.id !== result.draftId) throw Error("Saved receipt differs from the PTC result");
  printReceipt(receipt, file);
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
    for (const name of ["tiktok-mx-commerce.mjs", "tiktok-mx-editor.mjs", "tiktok-mx-list.mjs", "tiktok-mx-attributes.mjs"])
      await fs.copyFile(new URL("../extension/skills/tiktok-mx-draft/" + name, import.meta.url), path.join(home, name));
    for (const name of ["listing.ptc.js", "listing-workers.ptc.js"])
      await fs.copyFile(new URL("./" + name, import.meta.url), path.join(home, name));
    const { build } = await import("esbuild");
    await build({
      entryPoints: [fileURLToPath(new URL("./tiktok-mx-ptc.mjs", import.meta.url))],
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
  } else if (mode === "create" && arg) await submitCreate(arg, Number(process.argv[4]));
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
    await save(path.resolve(arg), mode === "verify", mode === "resave", null, null, null, null,
      mode === "save" && process.argv.includes("--replace-closed"));
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
