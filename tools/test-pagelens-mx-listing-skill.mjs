#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = path.join(REPO, ".agents/skills/pagelens-tiktok-mx-listing");
const SKILL_MD = path.join(SKILL_DIR, "SKILL.md");
const CONTRACTS_MD = path.join(SKILL_DIR, "references/inbox-contracts.md");
const CLI = path.join(SKILL_DIR, "scripts/mx-list.mjs");
const FAKE_EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

function runCli(args, env = {}, cwd = os.tmpdir()) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// 1. Validate SKILL.md structure, frontmatter, and contract markers
const skillText = await fs.readFile(SKILL_MD, "utf8");
const fmMatch = skillText.match(/^---\n([\s\S]*?)\n---/);
assert(fmMatch, "SKILL.md must have YAML frontmatter");
assert(/name:\s*pagelens-tiktok-mx-listing\b/.test(fmMatch[1]), "frontmatter name matches directory");
assert(/description:\s*.+/.test(fmMatch[1]), "frontmatter description present");
assert(!/[<>]/.test(fmMatch[1]), "frontmatter must not contain angle brackets");
for (const marker of [
  "mx-list.mjs",
  "ptc_create_mx_draft",
  "reprice_draft",
  "publish_draft",
  "1738630710999877196",
  "MAX_PARALLEL_MX_CREATES = 3",
  "references/inbox-contracts.md",
]) {
  assert(skillText.includes(marker), `SKILL.md includes ${marker}`);
}
const contractsText = await fs.readFile(CONTRACTS_MD, "utf8");
assert(contractsText.includes("ptc_mx_seller_action"), "inbox-contracts.md documents seller actions");

// 2. --help works without any environment setup
const helpOut = runCli(["--help"]);
assert(helpOut.includes("mx-list.mjs status"), "help lists status command");
assert(helpOut.includes("--dry-run"), "help lists --dry-run");

// 3. Test parse, dry-run, wave clamping, auto-discovery, protected guard, and report in isolated tmpdir
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-mx-skill-test-"));
try {
  const fakeHome = path.join(tmpDir, "pagelens-home");
  await fs.mkdir(path.join(fakeHome, "agent-inbox", FAKE_EXT_ID), { recursive: true });
  const testEnv = {
    PAGELENS_HOME: fakeHome,
    PAGELENS_EXTENSION_ID: "",
    PAGELENS_REPO: path.join(tmpDir, "no-repo"),
  };

  // 3a. Parse CSV with quoted comma, slug URL, query params, and duplicate sourceId
  const csvPath = path.join(tmpDir, "items.csv");
  await fs.writeFile(csvPath, [
    "idx,name,link",
    '1,"Cake, Slicer",https://shop.tiktok.com/jp/pdp/1735551813631117257?foo=1',
    '2,Duplicate,https://shop.tiktok.com/jp/pdp/dup-slug/1735551813631117257',
    '3,Cat Stopper,https://shop.tiktok.com/jp/pdp/cat-stopper/1735551813631117258',
  ].join("\n"));
  const parsed = JSON.parse(runCli(["parse", "--input", csvPath], testEnv));
  assert.equal(parsed.length, 2, "deduplicates by sourceId");
  assert.equal(parsed[0].name, "Cake, Slicer");
  assert.equal(parsed[0].url, "https://shop.tiktok.com/jp/pdp/1735551813631117257");
  assert.equal(parsed[1].sourceId, "1735551813631117258");

  // 3b. Dry-run auto-discovers extensionId from PAGELENS_HOME/agent-inbox and clamps --wave > 3
  const dryRunOut = runCli([
    "run", "--input", csvPath, "--stage", "publish", "--multiplier", "100",
    "--wave", "6", "--only", "2", "--dry-run",
  ], testEnv);
  const plan = JSON.parse(dryRunOut);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.extensionId, FAKE_EXT_ID);
  assert.equal(plan.waveSize, 3, "clamps wave > 3 to 3");
  assert.equal(plan.selectedCount, 1);
  assert.equal(plan.items[0].sourceId, "1735551813631117258");

  // 3c. Protected product guard blocks delist before writing any inbox file
  let blocked = false;
  try {
    runCli(["action", "--mode", "delist_listing", "--product-id", "1738630710999877196"], testEnv);
  } catch (err) {
    blocked = String(err.stderr || err.message).includes("Refusing to delist protected product");
  }
  assert(blocked, "must block protected product 1738630710999877196");
  const inboxEntries = await fs.readdir(path.join(fakeHome, "agent-inbox", FAKE_EXT_ID));
  assert.equal(inboxEntries.length, 0, "blocked action must not enqueue any job");

  // 3d. Report hides pending rows by default, shows all with --all, and sums tokens in --json
  const progPath = path.join(tmpDir, "progress.json");
  await fs.writeFile(progPath, JSON.stringify({
    startedAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:02:00Z",
    batchWallSec: 120,
    items: {
      1: { index: 1, name: "Untouched", sourceId: "1735551813631117257", status: "pending" },
      2: {
        index: 2, name: "Slicer", sourceId: "1735551813631117258", status: "published",
        draftId: "1738661648699655756", productId: "1738661648699655756", skuCount: 1,
        createElapsedSec: 60, repriceElapsedSec: 20, publishElapsedSec: 15, repriced: true,
        tokenUsage: { calls: 5, inputTokens: 1000, outputTokens: 2000, cacheCreationInputTokens: 0, cacheReadInputTokens: 500, totalTokens: 3500 },
      },
    },
  }));

  const mdDefault = runCli(["report", "--progress", progPath], testEnv);
  assert(mdDefault.includes("| 2 | Slicer | published |"), "default report includes executed row");
  assert(!mdDefault.includes("| 1 | Untouched |"), "default report omits pending rows");
  assert(mdDefault.includes("已省略 1 条"), "default report notes omitted pending count");

  const mdAll = runCli(["report", "--progress", progPath, "--all"], testEnv);
  assert(mdAll.includes("| 1 | Untouched | pending |"), "--all report includes pending rows");

  const reportJson = JSON.parse(runCli(["report", "--progress", progPath, "--json"], testEnv));
  assert.equal(reportJson.pluginTokenUsage.totalTokens, 3500);
  assert.equal(reportJson.timing.createAvgSec, 60);
  assert.equal(reportJson.timing.repriceAvgSec, 20);
  assert.equal(reportJson.timing.publishAvgSec, 15);

  // 3e. Stop immediately (exit code 3) on SELLER_LOGIN_REQUIRED without launching Wave 2
  const { spawn } = await import("node:child_process");
  const inboxDir = path.join(fakeHome, "agent-inbox", FAKE_EXT_ID);
  const outboxDir = path.join(fakeHome, "agent-outbox");
  await fs.mkdir(outboxDir, { recursive: true });
  const loginProg = path.join(tmpDir, "login-stop.json");
  const child = spawn(process.execPath, [
    CLI, "run", "--input", csvPath, "--wave", "1", "--stage", "publish", "--progress", loginProg,
  ], { cwd: tmpDir, env: { ...process.env, ...testEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  child.stderr.on("data", d => { stderrBuf += d.toString(); });
  const enqueuedIds = new Set();
  const responder = setInterval(async () => {
    const files = (await fs.readdir(inboxDir).catch(() => [])).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const id = f.replace(/\.json$/, "");
      if (enqueuedIds.has(id)) continue;
      enqueuedIds.add(id);
      await fs.writeFile(path.join(outboxDir, `${id}.json`), JSON.stringify({
        id,
        ok: false,
        error: "SELLER_LOGIN_REQUIRED: TikTok Seller Center is not logged in",
      }));
    }
  }, 50);
  const exitCode = await new Promise(resolve => child.on("close", resolve));
  clearInterval(responder);
  assert.equal(exitCode, 3, `expected exit code 3 on login required, got ${exitCode} (stderr=${stderrBuf})`);
  assert.equal(enqueuedIds.size, 1, "must stop after Wave 1 without enqueueing Wave 2");
  const savedLoginProg = JSON.parse(await fs.readFile(loginProg, "utf8"));
  assert.equal(savedLoginProg.items["1"].status, "create_failed");
  assert.equal(savedLoginProg.items["2"].status, "pending", "Wave 2 item must remain untouched pending");
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log("PASS pagelens-mx-listing-skill");
