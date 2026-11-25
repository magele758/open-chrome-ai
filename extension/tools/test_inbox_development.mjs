import assert from "node:assert/strict";
import { setDelegateManager, TASK_STATUS } from "../lib/agent/delegate.js";

const extensionId = "a".repeat(32);
const firstRevision = "1".repeat(40);
const nextRevision = "2".repeat(40);
let descriptor = { enabled: true, extensionId, revision: firstRevision };
let installType = "development";
let activePrompt = false;
let heldLocks = [];
const local = {};
const descriptorUrl = `chrome-extension://${extensionId}/local-development.json`;

Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  locks: { query: async () => ({ held: heldLocks, pending: [] }) },
} });
globalThis.fetch = async (url, options) => {
  assert.equal(url, descriptorUrl);
  assert.equal(options.cache, "no-store");
  return { ok: !!descriptor, json: async () => descriptor };
};
globalThis.chrome = {
  management: { getSelf: async () => ({ installType }) },
  permissions: { contains: async () => true },
  runtime: {
    id: extensionId,
    getURL: relative => `chrome-extension://${extensionId}/${relative}`,
    getManifest: () => ({ version: "0.12.1", permissions: ["nativeMessaging"] }),
    reload: () => assert.fail("Only the inbox calls reload, after recording the receipt"),
    getContexts: async () => [],
    sendNativeMessage: async (_host, request) => {
      assert.deepEqual(request, { op: "ping" });
      return { ok: true, version: "1.5.0", repoRoot: "/test-checkout", extra: "private" };
    },
  },
  storage: {
    local: {
      get: async key => ({ [key]: local[key] }),
      set: async values => Object.assign(local, values),
    },
    session: { get: async key => ({ [key]: activePrompt }) },
  },
};

const first = await import("../lib/agent/inbox-development.js?before");
const directed = { directed: true, queued: false };
const status = { id: "status", action: "dev_status" };
const request = { id: "update", action: "dev_reload", createdAt: new Date().toISOString(), expectedRevision: nextRevision };

await assert.rejects(first.developmentInboxJob(request, { directed: false }), /direct local inbox/);
await assert.rejects(first.developmentInboxJob({ ...request, token: "token" }, directed), /direct local inbox/);
installType = "normal";
await assert.rejects(first.developmentInboxJob(status, directed), /only support unpacked/);
installType = "development";
descriptor.enabled = false;
await assert.rejects(first.developmentInboxJob(status, directed), /have not been enabled/);
descriptor.enabled = true;
await assert.rejects(first.developmentInboxJob(status, directed), /not loaded a prepared/);
await first.confirmDevelopmentUpdate({ reason: "install" });
const before = await first.developmentInboxJob(status, directed);
assert.equal(before.revision, firstRevision);
assert.equal(before.lastReload, null);
assert.deepEqual(before.host, { version: "1.5.0", repoRoot: "/test-checkout" });
await assert.rejects(first.developmentInboxJob(request, directed), /revision does not match/);

descriptor.revision = nextRevision;
assert.equal((await first.developmentInboxJob(status, directed)).revision, firstRevision,
  "staging files does not change the loaded revision");
await assert.rejects(first.developmentInboxJob({ ...request, createdAt: new Date(Date.now() - 91_000).toISOString() }, directed), /expired/);
await assert.rejects(first.developmentInboxJob(request, { ...directed, queued: true }), { code: "DEVELOPMENT_BUSY" });
heldLocks = [{ name: "pagelens-agent-window-91" }];
assert.equal((await first.developmentInboxJob(status, directed)).busy, true);
await assert.rejects(first.developmentInboxJob(request, directed), /task in progress/);
heldLocks = [];
activePrompt = true;
await assert.rejects(first.developmentInboxJob(request, directed), /task in progress/);
activePrompt = false;
setDelegateManager({ list: async () => [{ status: TASK_STATUS.NEEDS_APPROVAL }] });
await assert.rejects(first.developmentInboxJob(request, directed), /task in progress/);
setDelegateManager(null);

const accepted = await first.developmentInboxJob(request, directed);
assert.deepEqual(accepted, { accepted: true, revision: nextRevision, bootId: before.bootId });
await assert.rejects(first.developmentInboxJob({ ...request, id: "duplicate" }, directed), /already pending/);
await first.confirmDevelopmentUpdate({ reason: "update" });
assert.equal((await first.developmentInboxJob(status, directed)).lastReload, null, "the same worker cannot confirm an update");

const second = await import("../lib/agent/inbox-development.js?after");
await second.confirmDevelopmentUpdate({ reason: "chrome_update" });
const unrestored = await second.developmentInboxJob(status, directed);
assert.equal(unrestored.revision, firstRevision, "an ordinary worker restart keeps the installed revision");
assert.equal(unrestored.lastReload, null, "an unrelated startup is not a reload receipt");
await second.confirmDevelopmentUpdate({ reason: "update" });
const after = await second.developmentInboxJob(status, directed);
assert.notEqual(after.bootId, before.bootId);
assert.equal(after.revision, nextRevision);
assert.deepEqual(after.lastReload, { id: request.id, revision: nextRevision, previousBootId: before.bootId });
const target = `~/.pagelens/agent-inbox/${extensionId}`;
const outbox = "~/.pagelens/agent-outbox";
const finalRequest = { ...request, id: "reload-order" };
const files = new Map([[`${target}/${finalRequest.id}.json`, JSON.stringify(finalRequest)]]);
let reloads = 0;
local.settings = { agentInboxEnabled: true, agentInboxVersion: 1 };
chrome.runtime.reload = () => {
  reloads++;
  const saved = JSON.parse(files.get(`${outbox}/${finalRequest.id}.json`));
  assert.equal(saved.ok, true);
  assert.equal(saved.consumerExtensionId, extensionId);
  assert.equal(saved.result.accepted, true);
  assert.equal(files.has(`${target}/processing/${finalRequest.id}.json`), false);
};
chrome.runtime.sendNativeMessage = async (_host, message) => {
  const file = `${message.root}/${message.rel}`;
  if (message.action === "ensureDir") return { ok: true };
  if (message.action === "readdir") {
    const directedEntries = files.has(`${target}/${finalRequest.id}.json`)
      ? [{ name: `${finalRequest.id}.json`, kind: "file" }] : [];
    return { ok: true, entries: [], directedEntries };
  }
  if (message.action === "claimInboxJob") {
    const rel = `processing/${message.rel}`;
    files.set(`${message.root}/${rel}`, files.get(file));
    files.delete(file);
    return { ok: true, claimed: true, rel };
  }
  if (message.action === "readText") return { ok: true, text: files.get(file) };
  if (message.action === "deleteFile") files.delete(file);
  else if (message.action === "writeText") files.set(file, message.text);
  else assert.fail(`Unexpected Native Host action ${message.action}`);
  return { ok: true };
};
const { pollAgentInboxOnce } = await import("../lib/agent/inbox.js");
assert.equal((await pollAgentInboxOnce()).processed, 1);
assert.equal(reloads, 1, "Chrome reloads once, after the accepted receipt is persisted");
assert.equal((await pollAgentInboxOnce()).processed, 0);
console.log("inbox development reload scope, idle guards, receipt ordering, and new worker confirmation passed");
