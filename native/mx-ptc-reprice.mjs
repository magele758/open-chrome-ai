import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createPtcExecTool } from "@mage-ai-lab/agent-loop/ptc";
import { DraftTabs } from "../tools/tiktok-mx-tabs.mjs";
import {
  commerceScript, draftSkuEditorMode, locateSkuInput, readDraftSkuCeiling, readDraftSkuNumbers,
  setDraftSkuPrice, setDraftSkuStock,
} from "../tools/tiktok-mx-commerce.mjs";
import {
  attributeCode, matchAttributeValue, readFreshDocument, saveDraftCode, sellerVerification, snapshotCode,
} from "../tools/tiktok-mx-editor.mjs";
import { registeredListing } from "./mx-ptc-inspect.mjs";

const normalizeLabel = label => label.trim().replace(/\s+/g, " ").toLowerCase();
const sameSnapshotValue = (before, after) => JSON.stringify(before) === JSON.stringify(after);
const exactId = /^\d{12,22}$/;

function priceTargets(baseline, multiplier) {
  if (![10, 100].includes(multiplier) || !Array.isArray(baseline) || !baseline.length)
    throw Error("Expected existing SKU prices and a multiplier of 10 or 100");
  const labels = new Set();
  return baseline.map(({ label, priceMXN }) => {
    if (typeof label !== "string" || !label.trim() || labels.has(normalizeLabel(label)))
      throw Error("SKU baseline labels must be unique and nonempty");
    const cents = Math.round(priceMXN * 100);
    if (!Number.isFinite(priceMXN) || cents <= 0 || !Number.isSafeInteger(cents * multiplier) ||
        Math.abs(priceMXN * 100 - cents) > 1e-6)
      throw Error("Invalid MXN baseline price for " + label);
    labels.add(normalizeLabel(label));
    return { label, beforeMXN: cents / 100, afterMXN: cents * multiplier / 100 };
  });
}

function validateCap(row, maxPriceMXN) {
  const cents = Math.round(maxPriceMXN * 100);
  if (typeof maxPriceMXN !== "number" || !Number.isSafeInteger(cents) || cents / 100 !== maxPriceMXN ||
      maxPriceMXN < row.beforeMXN || maxPriceMXN >= row.requestedMXN)
    throw Error("Invalid seller price ceiling for " + row.label);
  return maxPriceMXN;
}

async function readPriceCaps(file, { sourceId, draftId, multiplier }, targets) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  if (saved.sourceId !== sourceId || saved.draftId !== draftId || saved.multiplier !== multiplier || !Array.isArray(saved.caps))
    throw Error("Unexpected saved test price plan");
  const caps = new Map();
  for (const { label, maxPriceMXN } of saved.caps) {
    const row = targets.find(target => target.label === label);
    if (!row || caps.has(label)) throw Error("Unexpected saved SKU ceiling");
    caps.set(label, validateCap({ ...row, requestedMXN: row.afterMXN }, maxPriceMXN));
  }
  return caps;
}

function bindPrices(commerce, targets) {
  if (!commerce || commerce.skus.length !== targets.length)
    throw Error("The baseline must cover every SKU in the draft");
  const used = new Set();
  return targets.map(target => {
    const matchingTags = commerce.options.filter(aliases =>
      aliases.some(label => normalizeLabel(label) === normalizeLabel(target.label)));
    if (matchingTags.length !== 1) throw Error("Cannot verify SKU option " + target.label);
    const aliases = matchingTags[0].map(normalizeLabel);
    const available = commerce.skus.filter(row => row.label && aliases.includes(normalizeLabel(row.label)));
    const row = available[0];
    if (available.length !== 1 || used.has(row) || !row.priceField || !Number.isInteger(row.stock) || row.stock < 0)
      throw Error("Cannot verify SKU row or stock for " + target.label);
    if (![target.beforeMXN, target.afterMXN].includes(row.priceMXN))
      throw Error("Current price for " + row.label + " differs from both the baseline and target");
    used.add(row);
    return { ...target, label: row.label, aliases, stock: row.stock, currentMXN: row.priceMXN };
  });
}

// Reduce existing stock proportionally and assign the remaining whole units by
// largest remainder. A zero-stock SKU stays at zero and no SKU gains units.
function capInventory(rows, limit) {
  const total = rows.reduce((sum, row) => sum + row.stock, 0);
  if (!limit || total <= limit) return rows.map(row => ({ ...row, afterStock: row.stock }));
  const scaled = rows.map(row => {
    const share = row.stock * limit / total;
    const whole = Math.floor(share);
    return { ...row, afterStock: whole, remainder: share - whole };
  });
  const spare = limit - scaled.reduce((sum, row) => sum + row.afterStock, 0);
  const ranked = [...scaled].sort((a, b) => b.remainder - a.remainder || a.label.localeCompare(b.label));
  for (const row of ranked.slice(0, spare)) row.afterStock++;
  return scaled;
}

function verifyPreserved(before, state, targets, stage) {
  if (state.url !== before.url || state.captcha) throw Error("Wrong draft or seller verification " + stage);
  for (const field of ["title", "description", "enTitle", "enDescription", "gallery", "detailImages", "category"])
    if (!sameSnapshotValue(before[field], state[field])) throw Error("Unexpected change to draft " + field + " " + stage);
  for (const field of ["brand", "axes", "axisLabels", "options", "weightUnit", "dimensionsInCm", "packagedWeightGrams", "packageCm"])
    if (!sameSnapshotValue(before.salesAndShipping[field], state.salesAndShipping?.[field]))
      throw Error("Unexpected change to draft " + field + " " + stage);
  const rows = bindPrices(state.salesAndShipping, targets);
  for (const [index, row] of rows.entries())
    if (row.stock !== targets[index].afterStock) throw Error("Unexpected stock change for " + row.label + " " + stage);
  return rows.every(row => row.currentMXN === row.afterMXN);
}

function verifyAttributeSelections(before, observed, stage) {
  const byName = new Map(observed.map(field => [field.name, field]));
  if (byName.size !== observed.length || before.length !== observed.length)
    throw Error("Category attribute fields changed " + stage);
  for (const { name, selected } of before) {
    const field = byName.get(name);
    if (!field || field.selected.length !== selected.length)
      throw Error("Category attribute " + name + " changed " + stage);
    const matched = new Set(selected.map(value => matchAttributeValue(field.options, value)));
    if (matched.size !== selected.length || [...matched].some(value => !field.selected.includes(value)))
      throw Error("Category attribute " + name + " changed " + stage);
  }
}

function expectedPriceUpdate(copy, prices, multiplier, maxTotalStock) {
  if (copy.salesAndShipping?.skus?.length !== prices.length || !copy.salesAndShipping.origins) return null;
  const next = structuredClone(copy);
  const used = new Set();
  for (const sku of next.salesAndShipping.skus) {
    if (typeof sku.option !== "string") return null;
    const matched = prices.filter(row => row.aliases.includes(normalizeLabel(sku.option)));
    const row = matched[0];
    if (matched.length !== 1 || used.has(row) || ![row.beforeMXN, row.afterMXN].includes(sku.priceMXN)) return null;
    used.add(row);
    if (sku.priceMXN !== row.afterMXN) {
      sku.priceMXN = row.afterMXN;
      next.salesAndShipping.origins[sku.option + ".priceMXN"] = {
        kind: "seller", verified: true,
        basis: `用户指定卖家草稿售价 MXN ${row.beforeMXN} × ${multiplier}。` +
          (row.maxPriceMXN === undefined ? "" : `采用卖家页面对应 SKU 上限 MXN ${row.maxPriceMXN}。`) +
          `已刷新核对 MXN ${row.afterMXN}`,
      };
    }
    if (maxTotalStock && sku.stock !== row.afterStock) {
      sku.stock = row.afterStock;
      next.salesAndShipping.origins[sku.option + ".stock"] = {
        kind: "seller", verified: true, basis: `测试期每个商品可售库存合计最多 ${maxTotalStock} 件。已刷新核对该 SKU 为 ${row.afterStock} 件。`,
      };
    }
  }
  return next;
}

async function writeJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function ptcVerify(before, saved, prices) {
  const executor = createPtcExecTool({ getAuthorizedTools: () => [{
    name: "verify_draft_prices", ptc: { kind: "read" },
    async execute() {
      if (!verifyPreserved(before, saved, prices, "after refresh"))
        throw Error("Saved SKU prices did not reach their targets after refreshing the draft");
      verifyAttributeSelections(before.attributeCatalog, saved.attributeCatalog, "after refresh");
      return { ok: true, content: "verified" };
    },
  }] });
  const result = await executor.execute({ session: { id: randomUUID(), metadata: { orchestrationEngine: "ptc" } } },
    { code: "return (await verify_draft_prices({})).content;", timeoutMs: 10000 });
  if (!result.ok || JSON.parse(result.content).result !== "verified") throw Error(result.content);
}

export async function runMxDraftReprice({ sourceId, draftId, baselinePricesMXN, multiplier, maxTotalStock }, hooks) {
  if (![sourceId, draftId].every(id => typeof id === "string" && exactId.test(id)))
    throw Error("Expected exact TikTok source and draft IDs");
  if (maxTotalStock !== undefined && maxTotalStock !== 10) throw Error("Expected the approved total test stock limit of 10");
  const targets = priceTargets(baselinePricesMXN, multiplier);
  const start = Date.now();
  const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
  const home = process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");
  const lock = path.join(home, "tiktok-mx-" + sourceId + ".lock");
  const send = (tool, args) => hooks.request({ action: "bridge_call", request: { tool, args } });
  const group = new DraftTabs(sourceId, send);
  const guard = "if(location.href!==" + JSON.stringify(link) + ")throw Error('Wrong draft editor');";
  const verification = sellerVerification.toString() + "\nif(sellerVerification())throw Error('Seller verification is required');";
  const snapshot = snapshotCode(true, true, true);
  let tab;
  const inEditor = (tool, args) => send(tool, { ...args, tabId: tab });
  async function runCode(tabId, code) {
    if (tabId !== tab) throw Error("Wrong tab for draft prices");
    const reply = await inEditor("run_js", { code: guard + code });
    if (!reply?.ok) throw Error(reply?.error || "Draft price editor did not respond");
    return reply.result;
  }
  async function readAttributeSelections(state, stage, expectedValues = null) {
    if (!state.hasCategoryAttributes) return [];
    let catalog;
    const maxAttempts = expectedValues ? 10 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      catalog = await runCode(tab, attributeCode(link));
      if (!Array.isArray(catalog) || !catalog.length) throw Error("Category attribute controls unavailable " + stage);
      if (!expectedValues) return catalog;
      const hydrated = catalog.every(field => {
        const want = expectedValues[field.name];
        return !Array.isArray(want) || !want.length || field.selected.length >= want.length;
      });
      if (hydrated || attempt === maxAttempts - 1) return catalog;
      await sleep(250);
    }
    return catalog;
  }
  await fs.mkdir(lock);
  try {
    const { copy, dir } = await (hooks.registeredListing ?? registeredListing)(sourceId, draftId);
    const digest = createHash("sha256").update(JSON.stringify([...targets].sort((a, b) => a.label.localeCompare(b.label)))).digest("hex").slice(0, 16);
    const planPath = path.join(dir, "test-price-" + multiplier + "-" + digest + ".json");
    const identity = { sourceId, draftId, multiplier };
    const caps = multiplier === 100 ? await readPriceCaps(planPath, identity, targets) : new Map();
    const requested = targets.map(row => {
      const maxPriceMXN = caps.get(row.label);
      return { ...row, planLabel: row.label, requestedMXN: row.afterMXN, afterMXN: maxPriceMXN ?? row.afterMXN, maxPriceMXN };
    });
    tab = await group.open(link, [], true);
    await group.waitForUrl(tab, link);
    const before = await readFreshDocument(link, inEditor, snapshot);
    if (before.url !== link || before.captcha || before.title !== copy.title)
      throw Error("Draft differs from its source registration or requires seller verification");
    const prices = capInventory(bindPrices(before.salesAndShipping, requested), maxTotalStock);
    const changes = prices.filter(row => row.currentMXN !== row.afterMXN || row.stock !== row.afterStock);
    if (changes.length) await inEditor("activate_tab", {});
    before.attributeCatalog = await readAttributeSelections(before, "before editing", copy.attributePlan?.values);
    let saved = before, signal = null;
    if (changes.length) {
      group.pendingForm = tab;
      const editorMode = await runCode(tab, verification + commerceScript(draftSkuEditorMode));
      if (editorMode !== "batch" && editorMode !== "row") throw Error("Unexpected SKU editor");
      async function commitField(label, field, value) {
        const selector = await runCode(tab, verification + commerceScript(locateSkuInput, label, field, value, true));
        if (!selector) return;
        const typed = await inEditor("trusted_type", { selector, clear: true, value: String(value) });
        if (!typed?.ok) throw Error("Trusted SKU input failed for " + label);
        const committed = await inEditor("press_keys", { keys: ["Tab"] });
        if (!committed?.ok) throw Error("SKU input could not commit for " + label);
      }
      for (const row of changes) {
        const inventory = row.stock !== row.afterStock ? { before: row.stock, after: row.afterStock } : null;
        if (editorMode === "row") {
          const live = await runCode(tab, verification + commerceScript(readDraftSkuNumbers, row.label));
          if (![row.beforeMXN, row.afterMXN].includes(live.priceMXN))
            throw Error("SKU price changed before editing " + row.label);
          let target = row.maxPriceMXN ?? row.requestedMXN;
          if (multiplier === 100 && live.priceMXN !== target) {
            const ceiling = await runCode(tab, verification + commerceScript(readDraftSkuCeiling, row.label));
            if (ceiling !== null && ceiling >= row.beforeMXN && ceiling < row.requestedMXN) {
              row.maxPriceMXN = validateCap(row, ceiling);
              caps.set(row.planLabel, row.maxPriceMXN);
              target = row.maxPriceMXN;
            } else {
              row.maxPriceMXN = undefined;
              caps.delete(row.planLabel);
              target = row.requestedMXN;
            }
          }
          if (live.priceMXN !== target) await commitField(row.label, "price", target);
          row.afterMXN = row.maxPriceMXN ?? row.requestedMXN;
          const priced = await runCode(tab, verification + commerceScript(readDraftSkuNumbers, row.label));
          if (priced.priceMXN !== row.afterMXN) throw Error("Seller price result differs for " + row.label);
          if (inventory) {
            if (priced.stock !== inventory.before && priced.stock !== inventory.after)
              throw Error("Seller stock result differs for " + row.label);
            if (priced.stock !== inventory.after) await commitField(row.label, "stock", row.afterStock);
          }
          continue;
        }
        if (row.currentMXN === row.afterMXN) {
          await runCode(tab, verification + commerceScript(setDraftSkuStock, row.label, row.stock, row.afterStock));
          continue;
        }
        let target = row.requestedMXN, configuredCap = null;
        if (multiplier === 100) {
          // The ceiling hint may never render while the price settles. The
          // price control's own configuration carries the same sale price limit.
          const ceiling = await runCode(tab, commerceScript(readDraftSkuCeiling, row.label));
          if (ceiling !== null && ceiling >= row.beforeMXN && ceiling < target) {
            configuredCap = validateCap(row, ceiling);
            row.maxPriceMXN = configuredCap;
            caps.set(row.planLabel, configuredCap);
            target = configuredCap;
          }
        }
        const result = await runCode(tab, verification +
          commerceScript(setDraftSkuPrice, row.label, row.beforeMXN, target, multiplier === 100, inventory));
        if (!result || result.priceMXN === undefined) throw Error("Seller price adjustment gave no readback for " + row.label);
        if (result.maxPriceMXN !== undefined && multiplier === 100) {
          row.maxPriceMXN = validateCap(row, result.maxPriceMXN);
          caps.set(row.planLabel, row.maxPriceMXN);
        } else {
          if (result.maxPriceMXN !== undefined) throw Error("Unexpected seller price ceiling for " + row.label);
          if (configuredCap === null) {
            row.maxPriceMXN = undefined;
            caps.delete(row.planLabel);
          }
        }
        row.afterMXN = row.maxPriceMXN ?? row.requestedMXN;
        if (result.priceMXN !== row.afterMXN) throw Error("Seller price result differs for " + row.label);
        if (inventory && result.stock !== inventory.after) {
          if (result.stock !== inventory.before) throw Error("Seller stock result differs for " + row.label);
          await runCode(tab, verification + commerceScript(setDraftSkuStock, row.label, row.stock, row.afterStock));
        }
      }
      const staged = await runCode(tab, snapshot);
      if (!verifyPreserved(before, staged, prices, "before saving")) throw Error("Draft prices differ before saving");
      verifyAttributeSelections(before.attributeCatalog, await readAttributeSelections(staged, "before saving", copy.attributePlan?.values), "before saving");
      if (multiplier === 100) await writeJson(planPath, {
        ...identity, caps: [...caps].map(([label, maxPriceMXN]) => ({ label, maxPriceMXN })),
      });
      signal = await runCode(tab, verification + saveDraftCode(link));
      if (/提交失败|保存失败/.test(signal?.message || "")) throw Error(signal.message);
      if (signal?.message?.includes("草稿保存成功") && /\/product\/edit-draft\//.test(signal.url || "") && signal.url !== link)
        throw Error("Seller acknowledged a different draft");
      tab = await group.reopenSavedDraft(tab, link);
      group.pendingForm = tab;
      for (const delay of [0, 1000, 4000]) {
        if (delay) await sleep(delay);
        saved = await readFreshDocument(link, inEditor, snapshot);
        if (verifyPreserved(before, saved, prices, "after refresh")) {
          saved.attributeCatalog = await readAttributeSelections(saved, "after refresh", copy.attributePlan?.values);
          break;
        }
      }
    }
    await ptcVerify(before, saved, prices);
    const expected = expectedPriceUpdate(copy, prices, multiplier, maxTotalStock);
    const expectedPlanUpdated = Boolean(expected && !isDeepStrictEqual(copy, expected));
    const receiptFile = path.join(dir, "reprice-" + randomUUID() + "-receipt.json");
    const receipt = {
      verified: true, changed: Boolean(changes.length), sourceId, draftId, link, multiplier,
      ...(maxTotalStock !== undefined && { maxTotalStock, savedTotalStock: prices.reduce((sum, row) => sum + row.afterStock, 0) }),
      prices: prices.map(({ label, stock, afterStock, beforeMXN, afterMXN, requestedMXN, maxPriceMXN }) => ({
        label, stock: afterStock, beforeMXN, afterMXN, ...(stock !== afterStock && { beforeStock: stock }),
        ...(maxPriceMXN !== undefined && { requestedMXN, maxPriceMXN }),
      })),
      expectedPlanUpdated, signal: signal?.message || null, receiptFile,
      elapsedSeconds: (Date.now() - start) / 1000,
    };
    if (expectedPlanUpdated) await writeJson(path.join(dir, "listing.json"), expected);
    await writeJson(receiptFile, receipt);
    group.pendingForm = null;
    return receipt;
  } finally {
    try { await group.close(); }
    finally { await fs.rmdir(lock); }
  }
}
