import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createPtcExecTool } from "@mage-ai-lab/agent-loop/ptc";
import { SELLER_LOGIN_ERROR, isSellerLoginUrl, mxDraftUrl, mxManageUrl, mxSellerRequest } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";
import { attributeCode, readFreshDocument, snapshotCode, titleSelector } from "../tools/tiktok-mx-editor.mjs";
import { DraftTabs } from "../tools/tiktok-mx-tabs.mjs";
import { inspectWithPtc } from "./mx-ptc-inspect.mjs";
import { runMxDraftReprice } from "./mx-ptc-reprice.mjs";
import { readMxOrders } from "./mx-ptc-orders.mjs";
import { editorSubmitCode, editorAdvisoryConfirmCode, sellerListCode } from "./mx-seller-page.mjs";

const sellerHome = () => process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");

async function ptcVerify(verify) {
  const executor = createPtcExecTool({ getAuthorizedTools: () => [{
    name: "verify_seller_readback", ptc: { kind: "read" },
    async execute() {
      await verify();
      return { ok: true, content: "verified" };
    },
  }] });
  const reply = await executor.execute(
    { session: { id: randomUUID(), metadata: { orchestrationEngine: "ptc" } } },
    { code: "return (await verify_seller_readback({})).content;", timeoutMs: 10000 },
  );
  if (!reply.ok || JSON.parse(reply.content).result !== "verified") throw Error(reply.content);
  return executor.name;
}

async function withSellerTab(send, url, run, active = false) {
  const { tabId } = await send("open_tab", { url, active });
  if (!Number.isInteger(tabId)) throw Error("Seller Center did not open a task tab");
  const call = (tool, args) => send(tool, { tabId, ...args });
  let keep = false;
  try {
    const deadline = Date.now() + 15000;
    do {
      const tabs = await send("list_tabs", {});
      const tab = tabs.find(t => t.id === tabId);
      if (isSellerLoginUrl(tab?.url)) throw Error(SELLER_LOGIN_ERROR);
      if (tab?.url === url)
        return await run(call, () => { keep = true; return tabId; }, tabId);
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw Error("The expected Seller Center page did not open");
  } finally {
    if (!keep) {
      try { await call("close_tab", {}); }
      catch (error) { if (!String(error.message).includes("TAB_NOT_FOUND")) throw error; }
    }
  }
}

function refreshedProduct(send, productId, tab = "all", active = false) {
  const url = mxManageUrl + "&tab=" + tab;
  return withSellerTab(send, url, call => readFreshDocument(url, call, sellerListCode(url, productId)), active);
}

function compareOffer(saved, offer) {
  for (const field of ["brand", "packagedWeightGrams"]) {
    if (saved[field] !== offer[field]) throw Error("The saved seller " + field + " differs from the confirmed offer");
  }
  for (const field of ["length", "width", "height"]) {
    if (saved.packageCm[field] !== offer.packageCm[field]) throw Error("The saved package " + field + " differs from the confirmed offer");
  }
  if (saved.skus.length !== offer.skus.length) throw Error("The saved SKU count differs from the confirmed offer");
  for (const { label, priceMXN, stock } of offer.skus) {
    const rows = saved.skus.filter(row => row.label === label);
    if (rows.length !== 1 || rows[0].priceMXN !== priceMXN || rows[0].stock !== stock)
      throw Error("The saved unit price or fulfillable stock differs for SKU " + label);
  }
}

async function writeState(file, state) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}

const releasedStatus = status => ["active", "under_review", "inactive", "attention"].includes(status);

function returnedProductId(signal, draftId) {
  const ids = new Set((signal?.productLinks || []).flatMap(link => {
    const url = new URL(link);
    const match = /^\/product\/edit\/(\d{12,22})$/.exec(url.pathname);
    return match && url.origin === new URL(mxManageUrl).origin && url.searchParams.get("shop_region") === "MX" ? [match[1]] : [];
  }));
  return ids.size === 1 ? [...ids][0] : draftId;
}

async function waitForListing(send, productId, expectedTitle = null) {
  const url = mxManageUrl + "&tab=all";
  const readCode = sellerListCode(url, productId);
  return withSellerTab(send, url, async call => {
    let current;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        current = attempt === 0
          ? (await call("run_js", { code: readCode })).result
          : await readFreshDocument(url, call, readCode);
      } catch (error) {
        current = { error: error.message };
      }
      if (releasedStatus(current?.status)) break;
      if (expectedTitle && attempt >= 1 && current?.status === "not_found") {
        const byTitle = await call("run_js", {
          code: `
            const want = ${JSON.stringify(expectedTitle)}.trim();
            for (const r of document.querySelectorAll("tbody tr")) {
              if (!r.getClientRects().length || !r.innerText.includes(want)) continue;
              const id = (r.innerText.match(/ID\\s*[:：]\\s*(\\d{12,22})/) || [])[1];
              const txt = r.innerText;
              const st = /在售|\\bActiva?\\b/i.test(txt) ? "active" : /审核中|En revisi/i.test(txt) ? "under_review" : "";
              if (id && st) return { productId: id, status: st, title: want, url: location.href };
            }
            return null;
          `,
        }).catch(() => null);
        if (releasedStatus(byTitle?.result?.status)) {
          current = byTitle.result;
          break;
        }
      }
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return current;
  }, true).catch(error => ({ error: error.message }));
}

async function waitForDelisted(send, productId) {
  const url = mxManageUrl + "&tab=deactivate";
  const readCode = sellerListCode(url, productId);
  const current = await withSellerTab(send, url, async call => {
    let observed;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        observed = attempt === 0
          ? (await call("run_js", { code: readCode })).result
          : await readFreshDocument(url, call, readCode);
      } catch (error) {
        observed = { error: error.message };
      }
      if (observed?.status === "inactive") break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800));
    }
    return observed;
  }, true).catch(error => ({ error: error.message }));
  if (current?.status === "inactive") return current;
  return refreshedProduct(send, productId, "all", true).catch(error => ({ error: error.message }));
}

async function publishDraft(send, { sourceId, draftId, offer }) {
  const link = mxDraftUrl(draftId);
  const home = sellerHome();
  const stateDir = path.join(home, "mx-seller-submissions");
  const statePath = path.join(stateDir, draftId + ".json");
  const lock = path.join(home, "tiktok-mx-" + sourceId + ".lock");
  const tabs = new DraftTabs(sourceId, send);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(lock);
  try {
    let previous;
    try { previous = JSON.parse(await fs.readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous?.sourceId && previous.sourceId !== sourceId)
      throw Error("An existing submission bound this draft to another source");
    if (previous) {
      const current = await waitForListing(send, previous.productId || previous.productCandidateId || draftId);
      if (releasedStatus(current.status))
        return { ...previous, ...current, submitted: true, verified: true, changed: false };
      // An attempt that stopped at a seller dialog never dispatched, so the
      // same draft can be submitted again; anything else stays reconciled.
      if (previous.submitted || !previous.signal?.dialog)
        return { ...previous, status: "submission_unconfirmed", verified: false, changed: false };
    }
    const tab = await tabs.open(link, [], true);
    await tabs.waitForUrl(tab, link);
    const call = (tool, args) => send(tool, { tabId: tab, ...args });
    const inspected = await inspectWithPtc({ sourceId, draftId }, async () => {
      const saved = (await call("run_js", { code: snapshotCode(true, true, true) })).result;
      if (saved.hasCategoryAttributes) {
        for (let a = 0; a < 5; a++) {
          saved.attributeCatalog = (await call("run_js", { code: attributeCode(link) })).result;
          if (saved.attributeCatalog?.some(f => f.selected?.length) || a === 4) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      return saved;
    });
    const executor = await ptcVerify(() => compareOffer(inspected, offer));
    const state = { sourceId, draftId, link, executor, intentAt: new Date().toISOString() };
    // Write the intent before submitting so interruption cannot submit twice.
    await writeState(statePath, state);
    tabs.pendingForm = tab;
    let signal;
    try { signal = (await call("run_js", { code: editorSubmitCode(link, ["提交审核"]) })).result; }
    catch (error) { signal = { error: error.message }; }
    const advisories = [];
    const advisoryDialog = candidate => candidate?.dialog &&
      candidate.dialog.includes("建议") && candidate.dialog.includes("返回编辑");
    for (let round = 0; round < 2 && advisoryDialog(signal); round++) {
      let confirmed;
      try { confirmed = (await call("run_js", { code: editorAdvisoryConfirmCode(link) })).result; }
      catch (error) { signal = { ...signal, advisoryError: error.message }; break; }
      advisories.push(signal.dialog);
      signal = { ...confirmed, advisoryConfirmed: advisories };
    }
    const productCandidateId = returnedProductId(signal, draftId);
    if (productCandidateId !== draftId) await writeState(statePath, { ...state, productCandidateId, signal });
    const current = await waitForListing(send, productCandidateId, inspected.saved?.title || null);
    const verified = releasedStatus(current.status);
    const result = { ...state, status: verified ? current.status : "submission_unconfirmed", verified,
      submitted: verified, productCandidateId, ...(verified && { productId: current.productId }), signal, readback: current };
    await writeState(statePath, result);
    if (verified) tabs.pendingForm = null;
    return result;
  } finally {
    try { await tabs.close(); }
    finally { await fs.rmdir(lock); }
  }
}

async function delistProduct(send, { productId }) {
  const current = await refreshedProduct(send, productId, "deactivate", true);
  if (current.status === "inactive") return { ...current, verified: true, changed: false };
  const url = mxManageUrl + "&tab=active";
  return withSellerTab(send, url, async (call, keepOpen) => {
    const before = await readFreshDocument(url, call, sellerListCode(url, productId));
    if (before.status !== "active") throw Error("Could not verify this exact product as active");
    const marker = randomUUID();
    const run = async operation => (await call("run_js", { code: sellerListCode(url, productId, operation, marker) })).result;
    let signal = await run("prepare_delist");
    if (signal?.selector) {
      const hover = await call("hover", { selector: signal.selector });
      if (!hover?.ok) throw Error("Seller product actions did not open");
      signal = await run("click_delist");
    }
    if (signal?.confirmationReady === true) {
      try { signal = await run("confirm_delist"); }
      catch (error) {
        return { productId, status: "delist_unconfirmed", verified: false, tabId: keepOpen(), signal, error: error.message };
      }
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    const saved = await waitForDelisted(send, productId);
    if (saved.status !== "inactive") return { productId, status: "delist_unconfirmed", verified: false,
      tabId: keepOpen(), signal, readback: saved };
    return { ...saved, changed: true, verified: true, executor: await ptcVerify(() => {
      if (saved.productId !== productId || saved.status !== "inactive") throw Error("Delist readback did not match");
    }) };
  }, true);
}

function comparable(form) {
  const { enTitle, description, enDescription, gallery, detailImages, category, salesAndShipping } = form;
  const { brand, packagedWeightGrams, packageCm, axes, options, skus } = salesAndShipping;
  return { enTitle, description, enDescription, gallery, detailImages, category,
    brand, packagedWeightGrams, packageCm, axes, options, skus: skus.map(({ label, priceMXN, stock }) => ({ label, priceMXN, stock })) };
}

async function optimizeProduct(send, { productId, editorUrl, beforeTitle, afterTitle }) {
  let current = await refreshedProduct(send, productId, "all", true);
  if (["active", "inactive"].includes(current.status) && !current.editLinks.includes(editorUrl) && !current.canEdit) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    current = await refreshedProduct(send, productId, "all", true);
  }
  if (!["active", "inactive"].includes(current.status) || (!current.editLinks.includes(editorUrl) && !current.canEdit))
    throw Error("Seller Center did not expose an edit control on the exact product row");
  return withSellerTab(send, editorUrl, async (call, keepOpen, tabId) => {
    async function settledSnapshot(inEditor, minGallery = 0, minDetails = 0) {
      let prev = null;
      for (let i = 0; i < 10; i++) {
        const snap = (await inEditor("run_js", { code: snapshotCode(true, true, true, minDetails) })).result;
        if (prev && snap.gallery === prev.gallery && snap.detailImages === prev.detailImages &&
            snap.gallery >= minGallery && snap.detailImages >= minDetails) return snap;
        prev = snap;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return prev;
    }
    await readFreshDocument(editorUrl, call);
    const before = await settledSnapshot(call);
    if (before.captcha || ![beforeTitle, afterTitle].includes(before.title)) throw Error("The saved product title or verification state changed");
    if (before.title === afterTitle) return { productId, title: afterTitle, verified: true, changed: false };
    async function selectedAttributes(form, inEditor = call, expectedJson = null) {
      if (!form.hasCategoryAttributes) return [];
      let normalized = [];
      for (let attempt = 0; attempt < (expectedJson ? 6 : 2); attempt++) {
        const { result } = await inEditor("run_js", { code: attributeCode(editorUrl) });
        normalized = result.map(({ name, selected }) => [name, [...selected].sort()]).sort((a, b) => a[0].localeCompare(b[0]));
        if (expectedJson ? JSON.stringify(normalized) === expectedJson : !normalized.some(([, sel]) => !sel.length)) break;
        if (attempt + 1 < (expectedJson ? 6 : 2)) await new Promise(resolve => setTimeout(resolve, 250));
      }
      return normalized;
    }
    const attributes = await selectedAttributes(before);
    const attributesJson = JSON.stringify(attributes);
    await call("activate_tab", {});
    const field = await call("run_js", { code:
      "return document.querySelectorAll(" + JSON.stringify(titleSelector) + ").length;" });
    if (field.result !== 1) throw Error("The title input could not be located uniquely");
    const write = await call("trusted_type", { selector: titleSelector, value: afterTitle, clear: true });
    if (!write.ok) throw Error(write.error || "Title input was not written");
    await call("press_keys", { selector: titleSelector, keys: ["Tab"] });
    const staged = await settledSnapshot(call, before.gallery, before.detailImages);
    const beforeComparable = comparable(before);
    const compare = async (form, inEditor) => {
      const formComparable = comparable(form);
      const diffs = Object.keys(beforeComparable).filter(k => JSON.stringify(beforeComparable[k]) !== JSON.stringify(formComparable[k]));
      const formAttrs = JSON.stringify(await selectedAttributes(form, inEditor, attributesJson));
      if (form.url !== editorUrl || form.captcha || form.title !== afterTitle || diffs.length || attributesJson !== formAttrs)
        throw Error("The exact title and other product fields did not match (" +
          [form.title !== afterTitle && "title=" + form.title, ...diffs, attributesJson !== formAttrs && "attributes"].filter(Boolean).join(",") + ")");
    };
    await ptcVerify(() => compare(staged, call));
    let signal = (await call("run_js", { code: editorSubmitCode(editorUrl, ["更新", "保存", "提交审核"]) })).result;
    const advisories = [];
    const advisoryDialog = candidate => candidate?.dialog &&
      candidate.dialog.includes("建议") && candidate.dialog.includes("返回编辑");
    for (let round = 0; round < 2 && advisoryDialog(signal); round++) {
      const confirmed = (await call("run_js", { code: editorAdvisoryConfirmCode(editorUrl) })).result;
      advisories.push(signal.dialog);
      signal = { ...confirmed, advisoryConfirmed: advisories };
    }
    if (signal.dialog || signal.verificationRequired || signal.messages?.some(message => /失败/.test(message)))
      return { productId, status: "optimization_unconfirmed", verified: false, tabId: keepOpen(), signal };
    try {
      const review = await refreshedProduct(send, productId, "reviewing", true);
      if (review.title === afterTitle && review.status === "under_review")
        return { productId, title: afterTitle, status: "optimization_under_review", submitted: true, verified: false, signal, review };
      const allUrl = mxManageUrl + "&tab=all";
      const readAll = sellerListCode(allUrl, productId);
      const listing = await withSellerTab(send, allUrl, async inList => {
        let observed;
        for (let attempt = 0; attempt < 14; attempt++) {
          observed = attempt === 0
            ? (await inList("run_js", { code: readAll })).result
            : await readFreshDocument(allUrl, inList, readAll);
          if (observed.status === "under_review" && observed.title === afterTitle) break;
          if (observed.title === afterTitle && observed.canEdit) break;
          if (observed.title && observed.title !== beforeTitle && observed.title !== afterTitle) break;
          if (attempt < 13) await new Promise(resolve => setTimeout(resolve, 2500));
        }
        return observed;
      }, true);
      if (listing.status === "under_review" && listing.title === afterTitle)
        return { productId, title: afterTitle, status: "optimization_under_review", submitted: true, verified: false, signal, review: listing };
      if ((listing.title === beforeTitle || !listing.canEdit) && signal.messages?.some(m => /提交成功|更新成功|发布成功/.test(m)) && listing.title !== afterTitle)
        return { productId, title: afterTitle, status: "optimization_under_review", submitted: true, verified: false, signal, review: listing };
      if (listing.title !== afterTitle) throw Error("The updated title did not appear on the exact listing");
      const verifyEditor = async inEditor => {
        let saved;
        for (let attempt = 0; attempt < 3; attempt++) {
          await readFreshDocument(editorUrl, inEditor);
          saved = await settledSnapshot(inEditor, before.gallery, before.detailImages);
          if (saved.title === afterTitle) break;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return ptcVerify(() => compare(saved, inEditor));
      };
      const tabs = await send("list_tabs", {});
      const executor = tabs.some(tab => tab.id === tabId && tab.url === editorUrl) ? await verifyEditor(call) :
        await withSellerTab(send, editorUrl, verifyEditor, true);
      return { productId, title: afterTitle, status: listing.status, verified: true, changed: true, executor, signal };
    } catch (error) {
      return { productId, status: "optimization_unconfirmed", verified: false, tabId: keepOpen(), signal, error: error.message };
    }
  }, true);
}

export async function runMxSellerAction(parameters, request) {
  const args = mxSellerRequest(parameters);
  const start = Date.now();
  const send = (tool, payload) => request({ action: "bridge_call", request: { tool, args: payload } });
  let result;
  switch (args.mode) {
    case "reprice_draft": result = await runMxDraftReprice(args, { request }); break;
    case "publish_draft": result = await publishDraft(send, args); break;
    case "listing_status": {
      const current = await refreshedProduct(send, args.productId);
      result = { ...current, verified: !["not_found", "unrecognized"].includes(current.status) };
      break;
    }
    case "delist_listing": result = await delistProduct(send, args); break;
    case "optimize_listing": result = await optimizeProduct(send, args); break;
    case "read_orders": {
      const orders = await readMxOrders(send, args);
      result = { ...orders, executor: await ptcVerify(() => {
        if (!orders.verified || (args.orderStatus && args.orderStatus !== orders.orderStatus) ||
            !Number.isSafeInteger(orders.count) || orders.count < 0) throw Error("Order count or filter could not be verified");
      }) };
      break;
    }
  }
  return { ...result, mode: args.mode, runtime: "pagelens-native", elapsedSeconds: (Date.now() - start) / 1000 };
}
