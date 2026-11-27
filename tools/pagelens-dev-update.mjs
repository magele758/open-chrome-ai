#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { japaneseSourceId } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";

const exec = promisify(execFile);
const repoRoot = await fs.realpath(fileURLToPath(new URL("../", import.meta.url)));
const home = path.resolve(process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens"));
const descriptorPath = "extension/local-development.json";
const descriptor = path.join(repoRoot, descriptorPath);
const inboxCli = "tools/agent-inbox.mjs";
const revisionPattern = /^[0-9a-f]{40}$/;
const extensionPattern = /^[a-p]{32}$/;
const productPattern = /^\d{12,22}$/;
const tests = [
  "extension/tools/test_agent_inbox.mjs",
  "extension/tools/test_mx_approval_watch.mjs",
  "extension/tools/test_mx_approval_read.mjs",
  "extension/tools/test_mx_approval_panel.mjs",
  "extension/tools/test_inbox_development.mjs",
  "native/test_host.mjs",
  "tools/test-tiktok-mx-commerce.mjs",
  "tools/test-tiktok-mx-ptc.mjs",
  "tools/test-pagelens-directed-ptc.mjs",
  "tools/test-pagelens-draft-repair-routing.mjs",
  "tools/test-pagelens-mx-seller-routing.mjs",
  "tools/test-tiktok-mx-reprice.mjs",
  "tools/test-tiktok-mx-orders.mjs",
  "tools/test-tiktok-mx-seller.mjs",
  "tools/test-tiktok-mx-seller-delist.mjs",
];
const help = `Usage:
  node tools/pagelens-dev-update.mjs test
  node tools/pagelens-dev-update.mjs prepare --extension-id <id>
  node tools/pagelens-dev-update.mjs update --extension-id <id> --ref <local-ref>
      [--source-id <source-product-id> --draft-id <saved-draft-id>]
      [--source-url <Japanese product URL> --rate <JPY-to-MXN rate>]

Test runs the local inbox and TikTok PTC checks. Prepare tests a clean checkout
and records the development opt-in. Chrome must load that checkout once before
update can verify the target extension and Native Host through the directed inbox.
Update uses a local commit and verifies the reload receipt. For a smoke test,
choose read-only source and draft IDs, or supply a source URL with a positive
rate to create and verify one new draft. If that source already has a saved
record, update verifies the existing draft. The two smoke modes are exclusive.`;

async function git(...args) {
  return (await exec("git", args, { cwd: repoRoot })).stdout.trim();
}

async function runProcess(command, args, label, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot, env, stdio: ["ignore", process.stderr, "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal || code})`));
    });
  });
}

function runNode(script, args = [], env = process.env) {
  return runProcess(process.execPath, [script, ...args], script, env);
}

function installDependencies() {
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter) };
  return runProcess("npm", ["ci"], "npm ci", env);
}

async function runTests() {
  for (const script of tests) await runNode(script);
}

async function cleanHead() {
  if (await git("status", "--porcelain=v1", "--untracked-files=normal"))
    throw new Error("The checkout has local changes. Keep the installed checkout clean before updating.");
  const revision = await git("rev-parse", "HEAD");
  if (!revisionPattern.test(revision)) throw new Error("Expected a full Git revision");
  return revision;
}

async function requireCheckout(revision, checkout) {
  if (await cleanHead() !== revision || await git("rev-parse", "--symbolic-full-name", "HEAD") !== checkout)
    throw new Error("The checkout changed during the update.");
}

async function writeDescriptor(extensionId, revision) {
  await git("check-ignore", "--quiet", "--", descriptorPath);
  const tmp = `${descriptor}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ enabled: true, extensionId, revision }, null, 2) + "\n", {
      flag: "wx", mode: 0o600,
    });
    await fs.rename(tmp, descriptor);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function verifyDescriptor(extensionId, revision) {
  let current;
  try { current = JSON.parse(await fs.readFile(descriptor, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current?.enabled !== true || current.extensionId !== extensionId || current.revision !== revision)
    throw new Error("The development descriptor, extension ID, and checkout revision must match the installed build.");
}

async function inbox(extensionId, command, args, timeoutMs = 15000) {
  const env = { ...process.env, PAGELENS_HOME: home, PAGELENS_TOKEN: "" };
  const argv = [inboxCli, command, "--extension-id", extensionId, ...args];
  try {
    return JSON.parse((await exec(process.execPath, argv, { cwd: repoRoot, env, timeout: timeoutMs })).stdout);
  } catch (error) {
    if (error.code === 2 && error.stdout) {
      const receipt = JSON.parse(error.stdout);
      const message = receipt.error?.message || receipt.error || receipt.errorCode || "request rejected";
      throw Object.assign(new Error(`${receipt.action}: ${message}`), { code: receipt.errorCode });
    }
    throw new Error(error.stderr?.trim() || error.message);
  }
}

async function request(extensionId, action, args = [], timeoutMs = 60000) {
  const id = randomUUID();
  await inbox(extensionId, "enqueue", ["--action", action, "--id", id, ...args]);
  try {
    const reply = await inbox(extensionId, "wait", [id, "--timeout", String(timeoutMs)], timeoutMs + 10000);
    if (reply?.ok !== true || reply.id !== id || reply.action !== action || reply.consumerExtensionId !== extensionId)
      throw new Error("Unexpected directed inbox reply");
    return { id, result: reply.result };
  } catch (error) {
    throw Object.assign(new Error(`${action} ${id}: ${error.message}`), { code: error.code });
  }
}

async function getStatus(extensionId, timeoutMs) {
  const { result } = await request(extensionId, "dev_status", [], timeoutMs);
  if (!revisionPattern.test(result?.revision) || typeof result.bootId !== "string" || !result.bootId ||
      typeof result.version !== "string" || !result.version || typeof result.busy !== "boolean" ||
      typeof result.host?.version !== "string" || !result.host.version || typeof result.host.repoRoot !== "string" ||
      await fs.realpath(result.host.repoRoot).catch(() => null) !== repoRoot)
    throw new Error("The directed extension must report a Native Host for this checkout.");
  return result;
}

async function requireRunningRevision(extensionId, revision) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const timeout = Math.max(1000, deadline - Date.now());
    const state = await getStatus(extensionId, timeout);
    if (state.revision !== revision)
      throw new Error(`Chrome is running ${state.revision}, but the expected installed revision is ${revision}.`);
    if (!state.busy) return state;
    await sleep(2000);
  }
  throw new Error("Chrome still has a PageLens task in progress after waiting for 90 seconds.");
}

async function waitForReload(extensionId, requestId, revision, previousBootId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const status = await getStatus(extensionId, Math.max(1000, deadline - Date.now()));
    if (status.revision === revision && status.bootId !== previousBootId &&
        status.lastReload?.id === requestId && status.lastReload.revision === revision &&
        status.lastReload.previousBootId === previousBootId) return status;
    await sleep(1500);
  }
  throw new Error(`Chrome did not confirm reload ${requestId} for ${revision}`);
}

function verifyDraft(result, draftId) {
  const expectedLink = `https://seller.tiktokshopglobalselling.com/product/edit-draft/${draftId}?shop_region=MX`;
  if (result?.verified !== true || typeof draftId !== "string" || !productPattern.test(draftId) ||
      result.draftId !== draftId || result.link !== expectedLink)
    throw new Error("PTC did not verify the requested draft after the update");
}

async function inspectDraft(extensionId, sourceId, draftId) {
  const action = "ptc_inspect_mx_draft";
  const { result } = await request(extensionId, action, ["--source-id", sourceId, "--draft-id", draftId], 90000);
  verifyDraft(result, draftId);
  return { ...result, action };
}

async function readSourceRecord(sourceId) {
  const file = path.join(home, "mx-draft-sources", `${sourceId}.json`);
  try { return { file, record: JSON.parse(await fs.readFile(file, "utf8")) }; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { file };
}

async function rejectOutstandingCreate(extensionId, sourceId) {
  const shared = path.join(home, "agent-inbox");
  const directed = path.join(shared, extensionId);
  for (const dir of [directed, path.join(directed, "processing"), shared, path.join(shared, "processing")]) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let job;
      try { job = JSON.parse(await fs.readFile(path.join(dir, entry.name), "utf8")); }
      catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) continue; throw error; }
      if (job?.action !== "ptc_create_mx_draft") continue;
      let id = job.sourceId;
      if (!id && job.sourceUrl) {
        try { id = japaneseSourceId(job.sourceUrl); } catch { /* The source is not a supported TikTok product. */ }
      }
      if (id === sourceId) throw new Error(`Source ${sourceId} already has a pending inbox request (${entry.name}).`);
    }
  }
}

async function runPtcSmoke(extensionId, { sourceId, draftId, sourceUrl, rate }) {
  if (sourceId) return inspectDraft(extensionId, sourceId, draftId);
  if (!sourceUrl) return;
  const id = japaneseSourceId(sourceUrl);
  const existing = await readSourceRecord(id);
  if (Object.hasOwn(existing, "record")) {
    const savedId = existing.record?.id;
    if (typeof savedId !== "string" || !productPattern.test(savedId))
      throw new Error(`Source ${id} has an unfinished run in ${existing.file}. Reconcile that run before creating a draft.`);
    return inspectDraft(extensionId, id, savedId);
  }
  await rejectOutstandingCreate(extensionId, id);
  const action = "ptc_create_mx_draft";
  const { result } = await request(extensionId, action, ["--source-url", sourceUrl, "--rate", rate], 330000);
  const { record } = await readSourceRecord(id);
  verifyDraft(result, record?.id);
  return { ...result, action };
}

function installTikTokTools(directory) {
  return runNode("tools/tiktok-mx-draft.mjs", ["install"], { ...process.env, PAGELENS_HOME: directory });
}

async function verifyToolInstall() {
  const staging = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pagelens-tool-check-"));
  try { await installTikTokTools(staging); }
  finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function advanceAndReload(extensionId, current, target, checkout) {
  await requireCheckout(current, checkout);
  const dependenciesChanged = Boolean(await git("diff", "--name-only", current, target, "--", "package.json", "package-lock.json"));
  await git("merge", "--ff-only", "--no-edit", target);
  let staged = false;
  let reloadMayBePending = false;
  try {
    if (dependenciesChanged) await installDependencies();
    await runTests();
    await verifyToolInstall();
    await requireRunningRevision(extensionId, current);
    await requireCheckout(target, checkout);
    await verifyDescriptor(extensionId, current);
    await writeDescriptor(extensionId, target);
    staged = true;
    for (let attempt = 0; ; attempt++) {
      let reload;
      reloadMayBePending = true;
      try {
        reload = await request(extensionId, "dev_reload", ["--revision", target], 100000);
      } catch (error) {
        if (error.code !== "DEVELOPMENT_BUSY") throw error;
        // This receipt explicitly refused the action. A missing receipt is ambiguous.
        reloadMayBePending = false;
        if (attempt) throw error;
        await verifyDescriptor(extensionId, target);
        await requireRunningRevision(extensionId, current);
        continue;
      }
      const accepted = reload.result;
      if (accepted?.accepted !== true || accepted.revision !== target || !accepted.bootId || typeof accepted.bootId !== "string")
        throw new Error("The target extension did not acknowledge the requested revision");
      return await waitForReload(extensionId, reload.id, target, accepted.bootId);
    }
  } catch (error) {
    if (reloadMayBePending)
      throw new Error(`The checkout is staged at ${target}. Verify Chrome's reload receipt before another update. ${error.message}`);
    try {
      await requireCheckout(target, checkout);
      if (staged) {
        await verifyDescriptor(extensionId, target);
        await writeDescriptor(extensionId, current);
      }
      await git("reset", "--keep", current);
      if (dependenciesChanged) await installDependencies();
    } catch (rollbackError) {
      throw new Error(`${error.message}. Automatic rollback stopped: ${rollbackError.message}`);
    }
    throw error;
  }
}

async function update({ extensionId, ref, smoke }) {
  const checkout = await git("rev-parse", "--symbolic-full-name", "HEAD");
  const current = await cleanHead();
  const target = await git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  if (!revisionPattern.test(target)) throw new Error("Expected a locally available Git commit");
  await git("merge-base", "--is-ancestor", current, target).catch(() => {
    throw new Error("The target ref must be a fast-forward of the installed checkout.");
  });
  await verifyDescriptor(extensionId, current);
  const running = await requireRunningRevision(extensionId, current);
  const status = target === current ? running : await advanceAndReload(extensionId, current, target, checkout);
  await requireCheckout(target, checkout);
  await installTikTokTools(home);
  return { status, smoke: await runPtcSmoke(extensionId, smoke) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command == null || command === "help" || command === "--help" || args.includes("--help")) {
    console.log(help);
    return;
  }
  const { values } = parseArgs({ args, options: {
    "extension-id": { type: "string" }, ref: { type: "string" },
    "source-id": { type: "string" }, "draft-id": { type: "string" },
    "source-url": { type: "string" }, rate: { type: "string" },
  } });
  if (command === "test" && !args.length) return runTests();
  if (!["prepare", "update"].includes(command)) throw new Error("Run with --help for available commands");
  const { "extension-id": extensionId, ref, "source-id": sourceId, "draft-id": draftId,
    "source-url": sourceUrl, rate } = values;
  const inspect = sourceId !== undefined || draftId !== undefined;
  const create = sourceUrl !== undefined || rate !== undefined;
  if (!extensionPattern.test(extensionId || "")) throw new Error("Expected a Chrome extension ID for --extension-id");
  if (command === "prepare" && (ref !== undefined || inspect || create)) throw new Error("prepare accepts only --extension-id");
  if (command === "update" && !ref?.trim()) throw new Error("update requires --ref");
  if (inspect && create) throw new Error("Choose either draft IDs or a source URL and rate for the smoke test");
  if (inspect && ![sourceId, draftId].every(id => productPattern.test(id || "")))
    throw new Error("Provide a valid --source-id and --draft-id together");
  if (create) {
    if (!sourceUrl || !Number.isFinite(Number(rate)) || Number(rate) <= 0)
      throw new Error("Provide --source-url and a positive --rate together");
    japaneseSourceId(sourceUrl);
  }

  const lock = await git("rev-parse", "--path-format=absolute", "--git-path", "pagelens-dev-update.lock");
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another PageLens developer operation holds ${lock}`);
    throw error;
  }
  try {
    if (command === "prepare") {
      const revision = await cleanHead();
      await runTests();
      if (await cleanHead() !== revision) throw new Error("The checkout changed during tests");
      await writeDescriptor(extensionId, revision);
      console.log(JSON.stringify({ extensionId, revision, descriptor }, null, 2));
    } else {
      console.log(JSON.stringify(await update({ extensionId, ref, smoke: { sourceId, draftId, sourceUrl, rate } }), null, 2));
    }
  } finally {
    await fs.rmdir(lock);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
