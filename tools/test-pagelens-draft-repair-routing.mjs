import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDraftTransport, runNativeDraft } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";
import { createHostMessageHandler } from "../native/pagelens-host.mjs";

const action = "ptc_repair_mx_draft";
const sourceId = "1700000000000000001";
const draftId = "1700000000000000002";
const seller = "https://seller.tiktokshopglobalselling.com";
const target = `${seller}/product/edit-draft/${draftId}?shop_region=MX`;
const otherDraft = `${seller}/product/edit-draft/${sourceId}?shop_region=MX`;
const manage = `${seller}/product/manage?tab=draft&shop_region=MX`;
const parameters = { sourceId, draftId, repair: "category", queries: ["Sábanas"] };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-repair-routing-"));
try {
  const cli = fileURLToPath(new URL("./agent-inbox.mjs", import.meta.url));
  const env = { ...process.env, PAGELENS_HOME: tmp, PAGELENS_TOKEN: "ignored-local-token" };
  delete env.PAGELENS_EXTENSION_ID;
  const args = [cli, "enqueue", "--action", action, "--source-id", sourceId, "--draft-id", draftId,
    "--repair", parameters.repair, "--queries-json", JSON.stringify(parameters.queries)];
  assert.throws(() => execFileSync(process.execPath, args, { env, stdio: "pipe" }), /requires --extension-id/);
  const extensionId = "a".repeat(32);
  assert.throws(() => execFileSync(process.execPath, [...args, "--extension-id", extensionId, "--repair", "attributes"],
    { env, stdio: "pipe" }), /Category queries must contain/);
  const written = JSON.parse(execFileSync(process.execPath, [...args, "--extension-id", extensionId], { env }));
  assert.equal(path.dirname(written.jobPath), path.join(tmp, "agent-inbox", extensionId));
  const job = JSON.parse(await fs.readFile(written.jobPath));
  const { id, createdAt, ...body } = job;
  assert.equal(id, written.id);
  assert.ok(Number.isFinite(Date.parse(createdAt)));
  assert.deepEqual(body, { action, ...parameters });

  let openedWith;
  let handleMessage;
  const directReceipt = { verified: true, draftId, repaired: "category" };
  globalThis.chrome = { runtime: { connectNative() {
    return {
      onMessage: { addListener(listener) { handleMessage = listener; } },
      onDisconnect: { addListener() {} },
      postMessage(msg) {
        openedWith = msg;
        queueMicrotask(() => handleMessage({ type: "mx.done", ok: true, result: directReceipt }));
      },
      disconnect() {},
    };
  } } };
  const { executeJob } = await import("../extension/lib/agent/inbox.js");
  assert.deepEqual(await executeJob({ ...job, directed: true }), {
    ok: false,
    error: "TikTok draft repair requires a directed inbox request without a token",
  });
  const unexpectedBridge = { call: () => assert.fail("did not request a browser tool") };
  await assert.rejects(runNativeDraft({ ...job, token: "forbidden" }, unexpectedBridge), /does not accept a token/);
  assert.equal(await runNativeDraft({ ...job, action: ` ${action} ` }, unexpectedBridge), directReceipt);
  assert.deepEqual(openedWith, { type: "mx.repair", ...parameters });

  const responses = [];
  const native = createHostMessageHandler({ write: msg => responses.push(msg), socketPath: path.join(tmp, "bridge.sock") });
  await native.onMessage({ type: "mx.repair", ...parameters, draftId: "../unregistered" });
  await native.close();
  assert.equal(responses[0].type, "mx.done");
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /Expected numeric source and draft IDs/);
} finally {
  delete globalThis.chrome;
  await fs.rm(tmp, { recursive: true, force: true });
}

let currentUrl = target;
const calls = [];
const ownedId = 21;
const dispatch = createDraftTransport(sourceId, async (tool, args) => {
  calls.push(tool);
  if (tool === "open_tab") return { ok: true, result: { tabId: ownedId } };
  if (tool === "list_tabs") return { ok: true, result: [{ id: ownedId, url: currentUrl }, { id: 7, url: target }] };
  if (tool === "navigate_tab") currentUrl = args.url;
  return { ok: true, result: {} };
}, () => currentUrl, { draftId });
const call = (tool, args) => dispatch({ action: "bridge_call", request: { tool, args } });
for (const url of [otherDraft, `${seller}/product/create?shop_region=MX`, manage, `https://shop.tiktok.com/jp/pdp/${sourceId}`])
  await assert.rejects(call("open_tab", { url }), /Unexpected draft destination/);
await assert.rejects(call("open_tab", { url: target, backgroundUrls: [target] }), /Unexpected draft destination/);
await assert.rejects(call("run_js", { tabId: 7 }), /Tab outside draft task/);
assert.deepEqual(calls, [], "disallowed requests never reach Chrome");
await call("open_tab", { url: target });
assert.deepEqual(await call("list_tabs", {}), [{ id: ownedId, url: target }]);
await assert.rejects(dispatch({ action: "fill_mx_draft", tabId: ownedId, url: target }), /Unexpected repair action/);
await assert.rejects(dispatch({ action: "read_mx_draft", tabId: ownedId, url: otherDraft }), /Unexpected repair action/);
await assert.rejects(call("upload_file", { tabId: ownedId }), /Unexpected draft tool/);
currentUrl = otherDraft;
assert.deepEqual(await call("list_tabs", {}), []);
await assert.rejects(call("close_tab", { tabId: ownedId }), /outside draft workflow/);
currentUrl = manage;
await assert.rejects(call("run_js", { tabId: ownedId }), /outside draft workflow/);
await assert.rejects(call("navigate_tab", { tabId: ownedId, url: otherDraft }), /Unexpected draft destination/);
await call("navigate_tab", { tabId: ownedId, url: target });
assert.equal(currentUrl, target);
currentUrl = `${seller}/account/login?redirect_url=${encodeURIComponent(target)}`;
await assert.rejects(call("list_tabs", {}), /SELLER_LOGIN_REQUIRED/);
await assert.rejects(call("run_js", { tabId: ownedId }), /SELLER_LOGIN_REQUIRED/);
await call("close_tab", { tabId: ownedId });
assert.deepEqual(calls, ["open_tab", "list_tabs", "list_tabs", "navigate_tab", "list_tabs", "close_tab"]);
console.log("TikTok MX repair routing accepts only directed requests and the exact repair editor");
