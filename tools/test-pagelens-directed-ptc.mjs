// The real CLI, inbox, native framing and PTC verifier run against a local DOM fixture.
// This test does not launch Chrome or exercise live Seller Center, listing creation, or saves.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { encodeMessage, HOST_NAME, tryReadMessage } from "../native/pagelens-host.mjs";

const cliPath = fileURLToPath(new URL("./agent-inbox.mjs", import.meta.url));
const hostPath = fileURLToPath(new URL("../native/pagelens-host.mjs", import.meta.url));
const execute = promisify(execFile);
const extensionId = "a".repeat(32);
const otherId = "b".repeat(32);
const sourceId = "1700000000000000001";
const draftId = "1700000000000000002";
const origin = "https://seller.tiktokshopglobalselling.com";
const link = `${origin}/product/edit-draft/${draftId}?shop_region=MX`;
const skus = [
  { sourceSkuId: "1", option: "Una pieza", stock: 5, priceMXN: 100 },
  { sourceSkuId: "2", option: "Dos piezas", stock: 7, priceMXN: 180 },
];
const listing = {
  title: "Molde",
  description: "Molde de silicona",
  enTitle: "Mold",
  enDescription: "Silicone mold",
  gallery: ["image-01.jpg"],
  details: [],
  category: { label: "Cocina" },
  salesAndShipping: {
    brand: "无品牌",
    axis: "Modelo",
    skus,
    packagedWeightGrams: 500,
    packageCm: { length: 10, width: 8, height: 7 },
    origins: Object.fromEntries([
      "brand", "packagedWeightGrams", "packageCm.length", "packageCm.width", "packageCm.height",
      ...skus.flatMap(({ option }) => ["option", "stock", "priceMXN"].map(field => `${option}.${field}`)),
    ].map(key => [key, { kind: "estimated", basis: "fixture" }])),
  },
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `pagelens-mx-${sourceId}-directed-test-`));
const fixtureHome = path.join(tmp, ".pagelens");
const env = { ...process.env, PAGELENS_HOME: fixtureHome, PAGELENS_SOCKET: path.join(tmp, "bridge.sock") };
delete env.PAGELENS_MCP;
delete env.PAGELENS_TOKEN;
const processes = new Set();
const responses = [];

function connectNative(name) {
  assert.equal(name, HOST_NAME);
  const child = spawn(process.execPath, [hostPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = new Set();
  const disconnections = new Set();
  let buffer = Buffer.alloc(0);
  let stderr = "";
  let disconnected = false;
  const closed = new Promise(resolve => child.once("close", resolve));
  const connection = { child, closed };
  processes.add(connection);
  function fail(error) {
    if (disconnected) return;
    disconnected = true;
    globalThis.chrome.runtime.lastError = { message: error.message };
    for (const listener of disconnections) listener();
    delete globalThis.chrome.runtime.lastError;
    child.kill();
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.on("close", code => {
    processes.delete(connection);
    fail(new Error(`Native Host exited (${code})${stderr ? `\n${stderr}` : ""}`));
  });
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      for (let frame; (frame = tryReadMessage(buffer));) {
        buffer = frame.rest;
        responses.push(frame.msg.type || frame.msg.action || frame.msg.op);
        for (const listener of messages) listener(frame.msg);
      }
    } catch (error) { fail(error); }
  });
  return {
    onMessage: { addListener: listener => messages.add(listener) },
    onDisconnect: { addListener: listener => disconnections.add(listener) },
    postMessage(message) { child.stdin.write(encodeMessage(message)); },
    disconnect() {
      disconnected = true;
      child.stdin.end();
    },
  };
}

function sendNativeMessage(name, message) {
  assert.equal(message.op, "fs");
  const request = { ...message };
  assert.ok(request.path || request.root, "native filesystem operations must stay inside the fixture");
  for (const key of ["root", "path"]) {
    if (request[key] == null) continue;
    assert.match(request[key], /^~\/\.pagelens\/agent-(?:inbox|outbox)(?:\/|$)/);
    const absolute = path.resolve(request[key].replace("~/.pagelens", fixtureHome));
    assert.ok(absolute.startsWith(fixtureHome + path.sep), "fixture path traversal");
    request[key] = absolute;
  }
  return new Promise((resolve, reject) => {
    const port = connectNative(name);
    port.onDisconnect.addListener(() => reject(new Error(globalThis.chrome.runtime.lastError.message)));
    port.onMessage.addListener(reply => {
      port.disconnect();
      resolve(reply);
    });
    port.postMessage(request);
  });
}

const settings = {
  agentInboxEnabled: true,
  agentInboxVersion: 1,
  agentBridgeEnabled: true,
  agentBridgeOrigins: [origin],
};
const storage = { settings };
const pages = new Map();
const browserCalls = [];
let observedSecondSkuPrice = skus[1].priceMXN;
let timeOrigin = 100;
let nextTabId = 0;

function savedDraftDocument() {
  const field = (key, body) => `<div data-id="product.publish.${key}">${body}</div>`;
  const number = value => `<input role="spinbutton" value="${value}">`;
  const rows = [...skus].reverse().map(({ sourceSkuId: id, option, stock, priceMXN }) => `<tr><td>${option}</td>
    <td>${field(`skus.stock.${id}`, number(stock))}</td>
    <td>${field(`skus.sale_price.${id}`, number(id === "2" ? observedSecondSkuPrice : priceMXN))}</td></tr>`).join("");
  const dom = new JSDOM(`<!doctype html>
    <input data-id="product.publish.product_name" value="${listing.title}">
    <input data-id="product.publish.title.input_lang" value="${listing.enTitle}">
    ${field("description.local_lang", `<div class="ProseMirror">${listing.description}</div>`)}
    ${field("description.input_lang", `<div class="ProseMirror">${listing.enDescription}</div>`)}
    <div id="product-cascader-select-view">${listing.category.label}</div>
    <div data-id="product.widget.main_image.0"><img src="https://fixture.invalid/image.jpg"></div>
    ${field("brand", '<div class="core-select-view-value">无品牌</div>')}
    ${field("sale_property.name.1", '<div class="core-cascader-view-value">Modelo</div>')}
    ${skus.map(({ option }, index) => field(`sale_property.value.name.${index}`, `<span class="pulse-input-tag-item">${option}</span>`)).join("")}
    <table>${rows}</table>
    ${field("package_weight", `<div role="combobox">千克 (kg)</div>${number(0.5)}`)}
    ${Object.entries(listing.salesAndShipping.packageCm).map(([name, value]) => field(`package_${name}`, `厘米${number(value)}`)).join("")}`, {
    url: link, runScripts: "outside-only",
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  Object.defineProperty(dom.window.performance, "timeOrigin", { value: ++timeOrigin });
  return dom;
}

const tabs = {
  async get(id) {
    return pages.get(id)?.tab;
  },
  async create({ url, active }) {
    assert.equal(url, link);
    assert.equal(active, false);
    browserCalls.push("open");
    const tab = { id: ++nextTabId, url, active, windowId: 1, groupId: -1 };
    pages.set(tab.id, { tab, dom: savedDraftDocument() });
    return tab;
  },
  async reload(id) {
    browserCalls.push("reload");
    const page = pages.get(id);
    page.dom.window.close();
    page.dom = savedDraftDocument();
  },
  async remove(id) {
    browserCalls.push("close");
    pages.get(id).dom.window.close();
    pages.delete(id);
  },
};

async function cli(...args) {
  const reply = await execute(process.execPath, [cliPath, ...args], { env, timeout: 10000 });
  return JSON.parse(reply.stdout);
}

try {
  const recordDir = path.join(fixtureHome, "mx-draft-sources");
  await fs.mkdir(recordDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(recordDir, `${sourceId}.json`), JSON.stringify({ dir: tmp, id: draftId, title: listing.title })),
    fs.writeFile(path.join(tmp, "listing.json"), JSON.stringify(listing)),
    fs.writeFile(path.join(tmp, "source.json"), JSON.stringify({ id: sourceId, skus: skus.map(({ sourceSkuId: id }) => ({ id })) })),
  ]);

  globalThis.chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener() {} },
      connectNative,
      sendNativeMessage,
    },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(patch) { Object.assign(storage, patch); },
    } },
    tabs,
  };
  const { installBridge } = await import("../extension/lib/bridge/index.js");
  installBridge({
    now: Date.now,
    getSettings: async () => settings,
    tabs,
    tabGroups: {
      async group(ids) {
        for (const id of ids) pages.get(id).tab.groupId = 10;
        return 10;
      },
      async update() {},
    },
    async runJs(id, fn, code) {
      browserCalls.push("read");
      const { window } = pages.get(id).dom;
      const result = await window.eval(`(${fn.toString()})(${JSON.stringify(code)})`);
      return JSON.parse(JSON.stringify(result));
    },
  });
  const { pollAgentInboxOnce, manageMxApproval } = await import("../extension/lib/agent/inbox.js");
  const enqueue = () => cli("enqueue", "--extension-id", extensionId, "--action", "ptc_inspect_mx_draft",
    "--source-id", sourceId, "--draft-id", draftId);
  const wait = (id, target = extensionId) => cli("wait", id, "--extension-id", target, "--timeout-ms", "3000");
  const request = await enqueue();
  assert.equal(path.dirname(request.jobPath), path.join(fixtureHome, "agent-inbox", extensionId));
  chrome.runtime.id = otherId;
  assert.equal((await pollAgentInboxOnce()).processed, 0, "another extension cannot claim a directed request");
  assert.deepEqual(browserCalls, []);
  chrome.runtime.id = extensionId;
  const poll = await pollAgentInboxOnce();
  assert.equal(poll.processed, 1, JSON.stringify(poll));
  assert.equal(poll.results[0].ok, true, JSON.stringify(poll.results[0]));
  const outbox = await wait(request.id);
  assert.equal(outbox.consumerExtensionId, extensionId);
  assert.equal(outbox.id, request.id);
  assert.equal(outbox.action, "ptc_inspect_mx_draft");
  assert.equal(outbox.result.executor, "ptc_exec");
  assert.equal(outbox.result.verified, true);
  assert.equal(outbox.result.draftId, draftId);
  assert.equal(outbox.result.link, link);
  assert.equal(outbox.result.gallery, 1);
  assert.equal(outbox.result.enTitle, listing.enTitle);
  assert.equal(outbox.result.packagedWeightGrams, 500);
  assert.deepEqual(outbox.result.skus, [...skus].reverse().map(({ option: label, stock, priceMXN }) => ({ label, stock, priceMXN })));
  assert.deepEqual(browserCalls, ["open", "read", "reload", "read", "close"]);
  assert.ok(responses.includes("ptc.read_saved") && responses.includes("ptc.done"));
  assert.deepEqual(await fs.readdir(path.join(path.dirname(request.jobPath), "processing")), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(request.jobPath), "processed", `${request.id}.json`))).id, request.id);
  await assert.rejects(wait(request.id, otherId), /handled by a different extension/);

  observedSecondSkuPrice += 1;
  const mismatch = await enqueue();
  assert.equal((await pollAgentInboxOnce()).processed, 1);
  await assert.rejects(wait(mismatch.id), error => {
    if (error.code !== 2) throw error;
    const receipt = JSON.parse(error.stdout);
    assert.equal(receipt.consumerExtensionId, extensionId);
    assert.equal(receipt.ok, false);
    assert.match(receipt.error, /Dos piezas priceMXN/);
    return true;
  });
  assert.equal(pages.size, 0);

  // Reproduce an idle Inbox with a persisted watch after the seller has closed the list.
  const key = "agentMxApprovalWatch";
  const oldWatch = { key: "publish:" + draftId, mode: "publish_draft", productId: draftId,
    jobId: "old-receipt", nextCheckAt: 0 };
  storage[key] = { nextPollAt: 0, watches: [oldWatch] };
  let queries = 0;
  tabs.query = async () => { queries++; return []; };
  const before = [...browserCalls];
  const nativeSellerCalls = () => responses.filter(type => type === "mx.tool").length;
  const sellerCallsBefore = nativeSellerCalls();
  assert.equal((await pollAgentInboxOnce()).processed, 0);
  assert.equal(storage[key].enabled, false);
  assert.equal(storage[key].watches[0].state, "disabled");
  await manageMxApproval({ type: "pl.mxApproval.setEnabled", enabled: true });
  assert.equal((await pollAgentInboxOnce()).processed, 0);
  assert.equal(queries, 0, "opt-in cannot restart a pre-upgrade watch");

  const fresh = { ...oldWatch, key: "publish:" + sourceId, productId: sourceId, jobId: "new-receipt",
    state: "watching", startedAt: Date.now(), expiresAt: Date.now() + 86400000, nextCheckAt: 0 };
  storage[key].watches.push(fresh);
  let reading, release;
  const readStarted = new Promise(resolve => { reading = resolve; });
  tabs.query = () => {
    queries++;
    reading();
    return new Promise(resolve => { release = resolve; });
  };
  const slowCheck = pollAgentInboxOnce();
  await readStarted;
  try {
    assert.equal((await pollAgentInboxOnce()).processed, 0, "waiting for Chrome cannot hold the Inbox lock");
  } finally {
    release([]);
    await slowCheck;
  }
  assert.equal(storage[key].watches.at(-1).lastStatus, "no_page");
  assert.equal(queries, 1, "inspect only existing tabs");
  settings.agentBridgeOrigins = [];
  storage[key].nextPollAt = storage[key].watches.at(-1).nextCheckAt = 0;
  await pollAgentInboxOnce();
  assert.equal(storage[key].watches.at(-1).lastStatus, "access_disabled");
  assert.equal(queries, 1, "revoking site access stops looking for seller tabs");
  await manageMxApproval({ type: "pl.mxApproval.setEnabled", enabled: false });
  await pollAgentInboxOnce();
  assert.equal(queries, 1);
  assert.deepEqual(browserCalls, before, "automatic approval checks never open, refresh or close a tab");
  assert.equal(nativeSellerCalls(), sellerCallsBefore, "an empty Inbox cannot dispatch a seller action");
  const { readActivity, recordJobFinished } = await import("../extension/lib/agent/inbox-activity.js");
  const ids = ["new-approval", "new-inbox-job"];
  await Promise.all(ids.map(id => recordJobFinished({ id }, { ok: true }, Date.now())));
  assert.deepEqual((await readActivity()).slice(0, 2).map(entry => entry.id).sort(), ids,
    "a concurrent job and approval must both appear in activity");
  console.log("Directed inbox, Native Host, and PTC verified the reloaded fixture draft and rejected an altered SKU");
} finally {
  for (const { dom } of pages.values()) dom.window.close();
  const cleanup = [...processes];
  for (const { child } of cleanup) child.kill();
  await Promise.all(cleanup.map(({ closed }) => closed));
  await fs.rm(tmp, { recursive: true, force: true });
}
