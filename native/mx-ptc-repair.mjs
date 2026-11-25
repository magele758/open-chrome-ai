import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPtcExecTool } from "@mage-ai-lab/agent-loop/ptc";
import { repairDraftRequest } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";
import { DraftTabs } from "../tools/tiktok-mx-tabs.mjs";
import {
  attributeCode, matchAttributeValue, readFreshDocument, repairCategoryOptionsCode,
  repairCategorySearchCode, saveDraftCode, sellerVerification, shopAllowedCategoriesCode, snapshotCode,
} from "../tools/tiktok-mx-editor.mjs";
import { chooseAttributes, chooseCategory } from "../tools/tiktok-mx-ptc.mjs";
import { registeredListing } from "./mx-ptc-inspect.mjs";

const categoryPath = value => (value || "").trim().split(/\s*>\s*|\s+[-/]\s+/).filter(Boolean);
const categoryMatches = (a, b) => categoryPath(a).join("/") === categoryPath(b).join("/");
const selection = catalog => Object.fromEntries(catalog.map(field => [field.name, field.selected]));

function checkPreserved(before, after) {
  for (const key of ["title", "description", "enTitle", "enDescription", "gallery", "detailImages"])
    if (before[key] !== after[key]) throw Error("Unexpected change to draft " + key);
  const commerce = before.salesAndShipping;
  const saved = after.salesAndShipping;
  for (const key of ["brand", "packagedWeightGrams"])
    if (commerce[key] != null && commerce[key] !== "" && commerce[key] !== saved[key])
      throw Error("Unexpected change to draft " + key);
  for (const [name, value] of Object.entries(commerce.packageCm))
    if (Number.isFinite(value) && value !== saved.packageCm[name])
      throw Error("Unexpected change to draft package " + name);
  const skuValues = rows => rows.filter(row => row.label || Number.isFinite(row.priceMXN) || Number.isFinite(row.stock))
    .map(({ label, priceMXN, stock }) => ({ label, priceMXN, stock }));
  const expectedSkus = skuValues(commerce.skus);
  if (expectedSkus.length && JSON.stringify(expectedSkus) !== JSON.stringify(skuValues(saved.skus)))
    throw Error("Unexpected change to draft SKUs");
}

function checkSelection(plan, catalog) {
  if (catalog.length !== Object.keys(plan).length) throw Error("Draft attribute controls changed");
  for (const field of catalog) {
    const terms = plan[field.name];
    if (!terms || terms.length !== field.selected.length ||
        !terms.every(term => field.selected.includes(matchAttributeValue(field.options, term))))
      throw Error("Draft attribute selection differs: " + field.name);
  }
}

async function checkWithPtc(compare) {
  const executor = createPtcExecTool({ getAuthorizedTools: () => [{
    name: "verify_saved_repair", ptc: { kind: "read" },
    async execute() {
      compare();
      return { ok: true, content: "verified" };
    },
  }] });
  const result = await executor.execute({ session: { id: randomUUID(), metadata: { orchestrationEngine: "ptc" } } },
    { code: "return (await verify_saved_repair({})).content;", timeoutMs: 10000 });
  if (!result.ok || JSON.parse(result.content).result !== "verified") throw Error(result.content);
}

async function writeJson(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}

export async function repairHostedDraft(parameters, request, planners = {}) {
  const { sourceId, draftId, repair, queries } = repairDraftRequest(parameters);
  const start = Date.now();
  const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
  const home = process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");
  const lock = path.join(home, "tiktok-mx-" + sourceId + ".lock");
  const send = (tool, args) => request({ action: "bridge_call", request: { tool, args } });
  const group = new DraftTabs(sourceId, send);
  const steps = {};
  let tab;
  const inEditor = (tool, args) => send(tool, { tabId: tab, ...args });
  const browser = async code => {
    const reply = await inEditor("run_js", { code });
    if (!reply?.ok) throw Error(reply?.error || "Draft repair form operation failed");
    return reply.result;
  };
  const inspect = snapshotCode(true, true, repair === "attributes");
  const guarded = "if(location.href!==" + JSON.stringify(link) + ")throw Error('Wrong editor');";
  await fs.mkdir(lock);
  try {
    const { source, copy, dir } = await (planners.registeredListing ?? registeredListing)(sourceId, draftId);
    tab = await group.open(link, [], false);
    await group.waitForUrl(tab, link);
    const before = await browser(guarded + inspect);
    if (before.captcha || before.title !== copy.title) throw Error("Seller draft title differs from registration or verification is required");
    steps.opened = Date.now();
    let expectedCategory = before.category, plan, planned, candidates;
    if (repair === "attributes") {
      if (categoryPath(before.category).length < 3) throw Error("Attributes require a saved seller category");
      const catalog = await browser(attributeCode(link));
      if (!catalog.length) throw Error("Seller offered no category attributes");
      const missing = catalog.filter(field => !field.selected.length);
      const choose = planners.chooseAttributes ?? chooseAttributes;
      const decisions = await Promise.all(missing.map(field => choose(source, [field], undefined, copy.attributes, { repair: true })));
      planned = Object.assign({}, ...decisions.map(decision => decision.values));
      if (missing.length && !Object.values(planned).some(terms => terms.length)) throw Error("Source does not support any missing attribute");
      plan = { ...selection(catalog), ...planned };
      const toWrite = Object.fromEntries(Object.entries(planned).filter(([, terms]) => terms.length));
      steps.planned = Date.now();
      if (Object.keys(toWrite).length) checkSelection(plan, await browser(attributeCode(link, toWrite)));
    } else {
      if (!/^(?:|搜索|请选择(?:商品)?类目)$/.test(before.category.trim())) throw Error("Category repair requires an empty category");
      const terms = [...new Set((queries ?? [copy.category?.search]).filter(Boolean).map(term => term.trim()))];
      if (!terms.length) throw Error("A category search term is required");
      const paths = new Map();
      async function search(term) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await browser(repairCategorySearchCode(link));
          const reply = await inEditor("trusted_type", { value: term });
          if (!reply?.ok) throw Error(reply?.error || "Seller category search failed");
          try {
            return (await browser("await new Promise(resolve=>setTimeout(resolve,100));\n" + repairCategoryOptionsCode(link))).choices;
          } catch (error) {
            if (attempt === 1 || !/Search the current draft category before reading choices/.test(error.message)) throw error;
          }
        }
      }
      for (const term of terms)
        for (const label of await search(term)) if (!paths.has(label)) paths.set(label, term);
      candidates = [...paths.keys()];
      let flexible = false;
      if (!candidates.length) {
        const scope = await browser(shopAllowedCategoriesCode(link)).catch(() => ({ leaves: [] }));
        for (const label of scope?.leaves || []) {
          const leafTerm = label.split(/\s+[>/-]\s+/).at(-1);
          paths.set(label, leafTerm);
        }
        candidates = [...paths.keys()];
        flexible = Boolean(candidates.length);
      }
      const { choice } = await (planners.chooseCategory ?? chooseCategory)(source, candidates, undefined, { flexibleScope: flexible });
      const term = paths.get(choice.label);
      if (!term) throw Error("PTC selected a category outside the enabled seller results");
      expectedCategory = choice.label;
      steps.planned = Date.now();
      await search(term);
      const applied = await browser(repairCategoryOptionsCode(link, expectedCategory));
      if (!categoryMatches(applied.choice, expectedCategory)) throw Error("Selected seller category did not match");
      copy.category = { label: expectedCategory, search: term };
    }
    const changed = repair === "category" || Object.values(planned).some(terms => terms.length);
    const staged = await browser(guarded + inspect);
    checkPreserved(before, staged);
    if (!categoryMatches(staged.category, expectedCategory)) throw Error("Unexpected category before draft save");
    let signal = null;
    if (changed) {
      await inEditor("activate_tab", {});
      group.pendingForm = tab;
      const verification = sellerVerification.toString() + "\nif(sellerVerification())throw Error('Seller verification is required');";
      signal = await browser(verification + saveDraftCode(link));
      steps.saveSent = Date.now();
      if (/提交失败|保存失败/.test(signal?.message || "")) throw Error(signal.message);
      if (signal?.message?.includes("草稿保存成功") && /\/product\/edit-draft\//.test(signal.url || "") && signal.url !== link)
        throw Error("Seller acknowledged a different draft");
      tab = await group.reopenSavedDraft(tab, link);
      group.pendingForm = tab;
    }
    const saved = await readFreshDocument(link, inEditor, guarded + inspect);
    const attributes = plan ? await browser(attributeCode(link)) : null;
    await checkWithPtc(() => {
      checkPreserved(before, saved);
      if (saved.url !== link || saved.captcha || !categoryMatches(saved.category, expectedCategory))
        throw Error("Category did not match on refreshed draft");
      if (plan) checkSelection(plan, attributes);
    });
    steps.verified = Date.now();
    if (plan) copy.attributePlan = { category: saved.category, values: selection(attributes) };
    const receipt = {
      verified: true, sourceId, draftId, link, repair, changed, category: saved.category,
      ...(attributes && { attributes: selection(attributes), planned }),
      ...(candidates && { candidates }), signal: signal?.message || null, steps, elapsedSeconds: (steps.verified - start) / 1000,
    };
    await writeJson(path.join(dir, "listing.json"), copy);
    await writeJson(path.join(dir, "repair-" + repair + "-receipt.json"), receipt);
    group.pendingForm = null;
    return receipt;
  } finally {
    try { await group.close(); }
    finally { await fs.rmdir(lock); }
  }
}
