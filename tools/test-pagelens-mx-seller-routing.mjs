import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMxSellerTransport, runNativeDraft } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";
import { mxSellerRequest } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";
import { createHostMessageHandler } from "../native/pagelens-host.mjs";

const action = "ptc_mx_seller_action";
const extensionId = "a".repeat(32);
const sourceId = "1700000000000000001";
const draftId = "1700000000000000002";
const seller = "https://seller.tiktokshopglobalselling.com";
const draftUrl = `${seller}/product/edit-draft/${draftId}?shop_region=MX`;
const prices = [{ label: "Único", priceMXN: 25 }];
const request = mxSellerRequest({ mode: "reprice_draft", sourceId, draftId, baselinePricesMXN: prices, multiplier: 10 });

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-seller-routing-"));
try {
  const cli = fileURLToPath(new URL("./agent-inbox.mjs", import.meta.url));
  const env = { ...process.env, PAGELENS_HOME: tmp, PAGELENS_TOKEN: "ignored-local-token" };
  delete env.PAGELENS_EXTENSION_ID;
  const args = [cli, "enqueue", "--action", action];
  const directed = [...args, "--extension-id", extensionId];
  const requestArgs = ["--request-json", JSON.stringify(request)];
  assert.throws(() => execFileSync(process.execPath, [...args, ...requestArgs], { env, stdio: "pipe" }), /requires --extension-id/);
  assert.throws(() => execFileSync(process.execPath, directed, { env, stdio: "pipe" }), /requires --request-json/);
  assert.throws(() => execFileSync(process.execPath, [...directed, ...requestArgs, "--token-file", "/unused"],
    { env, stdio: "pipe" }), /does not accept a token/);
  const written = JSON.parse(execFileSync(process.execPath, [...directed, ...requestArgs], { env }));
  assert.equal(path.dirname(written.jobPath), path.join(tmp, "agent-inbox", extensionId));
  const job = JSON.parse(await fs.readFile(written.jobPath));
  const { id, createdAt, ...body } = job;
  assert.equal(id, written.id);
  assert.ok(Number.isFinite(Date.parse(createdAt)));
  assert.deepEqual(body, { action, request }, "CLI sends only the typed request and drops the inherited token");

  let handleMessage, opening;
  const receipt = { mode: request.mode, draftId, verified: true, priceMXN: 250 };
  globalThis.chrome = { runtime: { connectNative() { return {
    onMessage: { addListener(listener) { handleMessage = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(msg) {
      opening = msg;
      queueMicrotask(() => handleMessage({ type: "mx.done", ok: true, result: receipt }));
    },
    disconnect() {},
  }; } } };
  const { executeJob } = await import("../extension/lib/agent/inbox.js");
  const refusal = { ok: false, error: "TikTok MX seller action requires a directed inbox request without a token" };
  assert.deepEqual(await executeJob({ ...job, directed: true }), refusal);
  assert.deepEqual(await executeJob({ ...job, token: "forbidden" }, { directed: true }), refusal);
  const anonymousStatus = { action, request: { mode: "listing_status", productId: draftId } };
  assert.deepEqual(await executeJob(anonymousStatus, { directed: true }), {
    ok: false, error: "TikTok MX tasks require a job ID",
  });
  const bridge = { call: () => assert.fail("the mocked native port sent no tool calls") };
  await assert.rejects(runNativeDraft({ ...job, token: "forbidden" }, bridge), /does not accept a token/);
  assert.equal(await runNativeDraft({ ...job, action: ` ${action} ` }, bridge), receipt);
  assert.deepEqual(opening, { type: "mx.seller", request });

  const responses = [];
  const native = createHostMessageHandler({ write: msg => responses.push(msg), socketPath: path.join(tmp, "bridge.sock") });
  await native.onMessage({ type: "mx.seller", request: { ...request, draftId: "../other" } });
  await native.close();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, "mx.done");
  assert.equal(responses[0].ok, false);
  assert.equal(typeof responses[0].error, "string");

  let receive;
  const first = new Promise(resolve => { receive = resolve; });
  const hostResponses = [];
  const orderPort = createHostMessageHandler({ write(msg) { hostResponses.push(msg); receive(msg); },
    socketPath: path.join(tmp, "unused-order-bridge.sock") });
  const hosted = orderPort.onMessage({ type: "mx.seller", request: { mode: "read_orders" } });
  try {
    const tool = await first;
    assert.equal(tool.type, "mx.tool", JSON.stringify(tool));
    assert.deepEqual(tool.job, { action: "bridge_call", request: { tool: "open_tab",
      args: { url: `${seller}/order?shop_region=MX`, active: false } } });
    await orderPort.onMessage({ type: "mx.tool_result", seq: tool.seq, ok: false, error: "fixture stopped before opening Chrome" });
    await hosted;
    assert.equal(hostResponses.at(-1).type, "mx.done");
    assert.equal(hostResponses.at(-1).ok, false);
    assert.match(hostResponses.at(-1).error, /fixture stopped before opening Chrome/);
  } finally {
    await orderPort.close();
  }
} finally {
  delete globalThis.chrome;
  await fs.rm(tmp, { recursive: true, force: true });
}

const ownedId = 21;
const calls = [];
let currentUrl = draftUrl;
const bridge = async (tool, args) => {
  calls.push(tool);
  if (tool === "open_tab") return { ok: true, result: { tabId: ownedId } };
  if (tool === "list_tabs") return { ok: true, result: [{ id: ownedId, url: currentUrl }, { id: 7, url: draftUrl }] };
  if (tool === "navigate_tab") currentUrl = args.url;
  return { ok: true, result: {} };
};
const dispatch = createMxSellerTransport(request, bridge, async () => {
  if (currentUrl === null) throw Error("No tab with id: 21.");
  return currentUrl;
});
const exec = (tool, args) => dispatch({ action: "bridge_call", request: { tool, args } });
const otherDraft = `${seller}/product/edit-draft/${sourceId}?shop_region=MX`;
for (const url of [otherDraft, `${seller}/product/create?shop_region=MX`, draftUrl.replace("MX", "US"),
  `${seller}/order?shop_region=MX`, `https://shop.tiktok.com/jp/pdp/${sourceId}`])
  await assert.rejects(exec("open_tab", { url }), /Unexpected TikTok MX seller destination/);
await assert.rejects(exec("open_tab", { url: draftUrl, backgroundUrls: [draftUrl] }), /Unexpected TikTok MX seller destination/);
await assert.rejects(exec("run_js", { tabId: 7 }), /outside TikTok MX seller task/);
assert.deepEqual(calls, [], "rejected scopes never reach Chrome");
await exec("open_tab", { url: draftUrl });
assert.deepEqual(await exec("list_tabs", {}), [{ id: ownedId, url: draftUrl }]);
await assert.rejects(dispatch({ action: "fill_mx_draft", tabId: ownedId, url: draftUrl }), /Unexpected TikTok MX seller action/);
await assert.rejects(exec("upload_file", { tabId: ownedId }), /Unexpected TikTok MX seller action/);
await assert.rejects(exec("navigate_tab", { tabId: ownedId, url: otherDraft }), /Unexpected TikTok MX seller destination/);
currentUrl = otherDraft;
assert.deepEqual(await exec("list_tabs", {}), []);
await assert.rejects(exec("run_js", { tabId: ownedId }), /outside the TikTok MX seller scope/);
currentUrl = null;
await assert.rejects(exec("close_tab", { tabId: ownedId }), /TAB_NOT_FOUND/);
currentUrl = draftUrl;
await exec("open_tab", { url: draftUrl });
await exec("close_tab", { tabId: ownedId });
assert.deepEqual(calls, ["open_tab", "list_tabs", "list_tabs", "open_tab", "close_tab"]);

const orderUrl = `${seller}/order?shop_region=MX`;
const orders = createMxSellerTransport(mxSellerRequest({ mode: "read_orders" }), bridge, async () => currentUrl);
const orderCall = (tool, args) => orders({ action: "bridge_call", request: { tool, args } });
await orderCall("open_tab", { url: orderUrl });
currentUrl = `${seller}/order?order_status%5B%5D=1&selected_sort=1&tab=to_ship`;
await orderCall("run_js", { tabId: ownedId, code: "return document.title" });
await assert.rejects(orderCall("trusted_type", { tabId: ownedId, value: "unrequested" }), /Unexpected TikTok MX seller action/);
await assert.rejects(orderCall("open_tab", { url: currentUrl }), /Unexpected TikTok MX seller destination/);
currentUrl = `${seller}/order/another-path?shop_region=MX`;
await assert.rejects(orderCall("run_js", { tabId: ownedId }), /outside the TikTok MX seller scope/);
currentUrl = `${seller}/account/login?redirect_url=https%3A%2F%2Fseller.tiktokshopglobalselling.com%2Forder`;
await assert.rejects(orderCall("list_tabs", {}), /SELLER_LOGIN_REQUIRED/);
await assert.rejects(orderCall("run_js", { tabId: ownedId }), /SELLER_LOGIN_REQUIRED/);
currentUrl = "https://accounts.tiktok.com/login";
await assert.rejects(orderCall("list_tabs", {}), /SELLER_LOGIN_REQUIRED/);
console.log("TikTok MX seller routing validates directed requests and scopes native tools to owned seller pages");
