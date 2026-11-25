#!/usr/bin/env node
/**
 * PageLens -> TikTok Shop México (MX) product listing orchestrator.
 * Zero npm dependencies; talks to the PageLens Chrome extension strictly via
 * ~/.pagelens/agent-inbox/<extensionId>/ and ~/.pagelens/agent-outbox/.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGELENS_HOME = process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");
const OUTBOX_DIR = path.join(PAGELENS_HOME, "agent-outbox");
const SOURCES_DIR = path.join(PAGELENS_HOME, "mx-draft-sources");
const PROTECTED_PRODUCT_IDS = new Set(["1738630710999877196"]);

const DEFAULT_RATE = 0.1161;
const MAX_WAVE = 3;
const DEFAULT_WAIT_MS = 1800000; // 30 minutes per job

const CAPTCHA_RE = /"captcha"\s*:\s*true|拖动完成上方拼图|请完成下列验证|Verify to continue|seller verification|TikTok verification is open/i;
const LOGIN_REQUIRED_RE = /SELLER_LOGIN_REQUIRED|seller login required|not logged in|account\/login|请先登录|店铺未登录|需要重新登录/i;
const NAV_FAIL_RE = /Task tab did not finish navigating|The expected Seller Center page did not open|Draft list not ready or seller login required/i;
const UNCERTAIN_PUBLISH_RE = /Timeout waiting for outbox|submission_unconfirmed|reconcile|indeterminate/i;
const JP_PDP_URL_RE = /https?:\/\/shop\.tiktok\.com\/jp\/pdp\/(?:[^/\s"'<>?#]+\/)?(\d{12,22})\/?(?:\?[^\s"'<>#]*)?/g;
const NUMERIC_ID_RE = /^\d{12,22}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isCaptchaError(msg) {
  return CAPTCHA_RE.test(String(msg || ""));
}

function isLoginRequiredError(msg) {
  return LOGIN_REQUIRED_RE.test(String(msg || ""));
}

function roundCents(n) {
  return Math.round(Number(n) * 100) / 100;
}

function extractJapaneseSource(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Empty TikTok JP URL or sourceId");
  if (NUMERIC_ID_RE.test(raw)) {
    return { sourceId: raw, url: `https://shop.tiktok.com/jp/pdp/${raw}` };
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  const m = u.pathname.match(/^\/jp\/pdp\/(?:[^/]+\/)?(\d{12,22})\/?$/);
  if (u.origin !== "https://shop.tiktok.com" || !m) {
    throw new Error(`Not a TikTok Shop Japan PDP URL: ${raw}`);
  }
  return { sourceId: m[1], url: `https://shop.tiktok.com/jp/pdp/${m[1]}` };
}

function resolveExtensionId(flagValue) {
  const explicit = [flagValue, process.env.PAGELENS_EXTENSION_ID].filter(Boolean);
  for (const c of explicit) {
    const clean = String(c).trim();
    if (/^[a-p]{32}$/.test(clean)) return clean;
  }

  const repoCandidates = process.env.PAGELENS_REPO
    ? [process.env.PAGELENS_REPO]
    : [path.resolve(SCRIPT_DIR, "../../../.."), process.cwd()];

  for (const repo of repoCandidates) {
    const localDevPath = path.join(repo, "extension", "local-development.json");
    try {
      const dev = JSON.parse(fsSync.readFileSync(localDevPath, "utf8"));
      if (dev?.extensionId && /^[a-p]{32}$/.test(dev.extensionId)) return dev.extensionId;
    } catch {}
  }

  const inboxRoot = path.join(PAGELENS_HOME, "agent-inbox");
  try {
    const dirs = fsSync.readdirSync(inboxRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-p]{32}$/.test(d.name))
      .map(d => d.name);
    if (dirs.length === 1) return dirs[0];
    if (dirs.length > 1) {
      throw new Error(`Multiple extension inbox dirs found (${dirs.join(", ")}); specify --extension-id or PAGELENS_EXTENSION_ID.`);
    }
  } catch (e) {
    if (e.message?.includes("Multiple extension")) throw e;
  }
  throw new Error("Could not resolve PageLens extension ID. Pass --extension-id <id>, set PAGELENS_EXTENSION_ID, or set PAGELENS_REPO.");
}

function parseCliArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const rest = cmd ? argv.slice(1) : argv;
  const opts = { _: [], urls: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        opts[key] = true;
      } else {
        if (key === "url") opts.urls.push(next);
        else opts[key] = next;
        i++;
      }
    } else {
      opts._.push(a);
    }
  }
  return { cmd, opts };
}

function printHelp() {
  console.log(`PageLens -> TikTok Shop MX Listing CLI

Usage:
  mx-list.mjs status [--extension-id <id>] [--timeout-ms <ms>]
  mx-list.mjs parse  --input <file> [--out <json>]
  mx-list.mjs run    (--url <jpUrl>... | --input <file>) [options]
  mx-list.mjs action --mode <mode> [mode options]
  mx-list.mjs report --progress <file> [--all] [--json]

Run options:
  --url <jpUrl>           TikTok Shop JP product URL or numeric sourceId (repeatable)
  --input <file>          Product list file (.numbers, .csv, .tsv, .txt, .md, .json)
  --rate <number>         JPY -> MXN exchange rate (default: ${DEFAULT_RATE})
  --stage <stage>         Target stage: draft | reprice | publish (default: draft)
  --multiplier <10|100>   Test price multiplier for reprice_draft (default: 100)
  --no-reprice            With --stage publish, skip reprice_draft and publish at 1x price
  --max-total-stock <10>  Total test stock cap for reprice_draft (default: 10; only 10 is allowed by PageLens)
  --no-stock-cap          Omit maxTotalStock during reprice_draft
  --wave <1-3>            Concurrent window wave size (default: 3, max: 3)
  --from <n> --to <n>     1-based item index range filter
  --only <1,4,17>         Comma-separated 1-based indices to run
  --retry-failed          Only retry items in failed states (never blindly re-submits publish_unconfirmed)
  --progress <file>       Resumable checkpoint JSON file
  --timeout-ms <ms>       Per-job outbox wait timeout in ms (default: ${DEFAULT_WAIT_MS})
  --extension-id <id>     Override auto-discovered PageLens Chrome extension ID
  --dry-run               Parse & validate plan without sending any inbox jobs

Action modes (--mode):
  listing_status          --product-id <id>
  delist_listing          --product-id <id> [--no-verify]
  optimize_listing        --product-id <id> --editor-url <url> --before-title <old> --after-title <new>
  read_orders             [--order-status all|to_ship|shipped|completed|cancelled]
  inspect                 --source-id <id> --draft-id <id>
  repair                  --source-id <id> --draft-id <id> --repair attributes|category [--queries "q1,q2"]

Exit codes:
  0  Success
  1  Error or one or more items failed
  2  CAPTCHA / seller verification detected (STOP and ask user to verify in Chrome)
  3  TikTok Seller Center not logged in (STOP immediately and ask user to sign in)
`);
}

async function enqueueAtomic(extId, job) {
  const inboxDir = path.join(PAGELENS_HOME, "agent-inbox", extId);
  await fs.mkdir(inboxDir, { recursive: true, mode: 0o700 });
  const id = job.id || randomUUID();
  const payload = { id, createdAt: new Date().toISOString(), followUp: true, ...job };
  const tmp = path.join(inboxDir, `.${id}.tmp`);
  const dest = path.join(inboxDir, `${id}.json`);
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, dest);
  return { id, outboxFile: path.join(OUTBOX_DIR, `${id}.json`) };
}

async function waitOutbox(id, timeoutMs = DEFAULT_WAIT_MS) {
  const target = path.join(OUTBOX_DIR, `${id}.json`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const raw = await fs.readFile(target, "utf8");
      const reply = JSON.parse(raw);
      return { wallSec: +((Date.now() - t0) / 1000).toFixed(2), reply, outboxFile: target };
    } catch {}
    await sleep(300);
  }
  return {
    wallSec: +((Date.now() - t0) / 1000).toFixed(2),
    reply: { ok: false, error: `Timeout waiting for outbox ${id} after ${timeoutMs}ms` },
    outboxFile: target,
  };
}

async function readDraftReceipt(sourceId, receiptFile) {
  let rec = null;
  try {
    rec = JSON.parse(await fs.readFile(path.join(SOURCES_DIR, `${sourceId}.json`), "utf8"));
  } catch {}
  const candidate = receiptFile || (rec?.dir ? path.join(rec.dir, "receipt.json") : null);
  if (!candidate) throw new Error(`No receipt.json found for sourceId ${sourceId}`);
  const receipt = JSON.parse(await fs.readFile(candidate, "utf8"));
  return { rec, receipt, receiptFile: candidate };
}

function parseCsvLine(line, delimiter = ",") {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function dedupeItems(rawItems) {
  const seen = new Set();
  const out = [];
  for (const entry of rawItems) {
    const { sourceId, url } = extractJapaneseSource(entry.url || entry.sourceId);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({
      index: out.length + 1,
      name: String(entry.name || `Item ${sourceId}`).trim(),
      sourceId,
      url,
    });
  }
  return out;
}

function parseNumbersFile(filePath) {
  const py = `
import json, re, sys
from numbers_parser import Document
doc = Document(sys.argv[1])
url_re = re.compile(r"https?://shop\\.tiktok\\.com/jp/pdp/(?:[^/\\s]+/)?(\\d{12,22})/?")
items = []
for sheet in doc.sheets:
    for table in sheet.tables:
        for r in range(table.num_rows):
            vals = []
            url = None
            url_col = -1
            for c in range(table.num_cols):
                cell = table.cell(r, c)
                v = "" if cell.value is None else str(cell.value).strip()
                vals.append(v)
                if url is None:
                    m = url_re.search(v)
                    if m:
                        url = m.group(0)
                        url_col = c
                    else:
                        for _, href in (getattr(cell, "hyperlinks", None) or []):
                            hm = url_re.search(str(href or ""))
                            if hm:
                                url = hm.group(0)
                                url_col = c
                                break
            if not url:
                continue
            name = ""
            for ci, v in enumerate(vals):
                if ci == url_col or not v:
                    continue
                if re.fullmatch(r"\\d+(\\.\\d+)?", v):
                    continue
                if "http://" in v or "https://" in v:
                    continue
                name = v
                break
            items.append({"name": name, "url": url})
print(json.dumps(items, ensure_ascii=False))
`;
  try {
    const stdout = execFileSync("uv", ["run", "--with", "numbers-parser", "python3", "-c", py, filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return dedupeItems(JSON.parse(stdout));
  } catch (err) {
    throw new Error(`Failed to parse .numbers file via 'uv run --with numbers-parser': ${err.stderr || err.message}`);
  }
}

async function parseInputFile(filePath) {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".numbers") return parseNumbersFile(abs);
  const raw = await fs.readFile(abs, "utf8");
  if (ext === ".json") {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : Object.values(parsed.items || {}));
    return dedupeItems(arr.map(x => (typeof x === "string" ? { url: x } : x)));
  }
  if (ext === ".csv" || ext === ".tsv") {
    const delimiter = ext === ".tsv" ? "\t" : ",";
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cells = parseCsvLine(line, delimiter);
      let url = null;
      let urlCol = -1;
      for (let i = 0; i < cells.length; i++) {
        const m = cells[i].match(/https?:\/\/shop\.tiktok\.com\/jp\/pdp\/(?:[^/\s]+\/)?(\d{12,22})\/?/);
        if (m) {
          url = m[0];
          urlCol = i;
          break;
        }
      }
      if (!url) continue;
      const name = cells.find((c, idx) => idx !== urlCol && c && !/^\d+(\.\d+)?$/.test(c) && !/^https?:\/\//.test(c)) || "";
      items.push({ name, url });
    }
    return dedupeItems(items);
  }
  const matches = [...raw.matchAll(JP_PDP_URL_RE)];
  return dedupeItems(matches.map(m => ({ url: m[0] })));
}

async function cmdStatus(opts) {
  const extId = resolveExtensionId(opts["extension-id"]);
  const timeoutMs = Number(opts["timeout-ms"] || 20000);
  const { id, outboxFile } = await enqueueAtomic(extId, { action: "dev_status" });
  const { wallSec, reply } = await waitOutbox(id, timeoutMs);
  const out = {
    ok: Boolean(reply?.ok),
    extensionId: extId,
    jobId: id,
    outboxFile,
    wallSec,
    result: reply?.result ?? null,
    error: reply?.ok ? undefined : (reply?.error || "Unknown error"),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

async function cmdParse(opts) {
  if (!opts.input) throw new Error("parse requires --input <file>");
  const items = await parseInputFile(opts.input);
  if (opts.out) {
    const dest = path.resolve(opts.out);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(items, null, 2));
    console.log(JSON.stringify({ ok: true, count: items.length, out: dest }, null, 2));
  } else {
    console.log(JSON.stringify(items, null, 2));
  }
}

async function loadSalesAndShipping(extId, sourceId, draftId, receiptFile, timeoutMs) {
  try {
    const { receipt } = await readDraftReceipt(sourceId, receiptFile);
    if (receipt?.readback?.salesAndShipping?.skus?.length) {
      return { sales: receipt.readback.salesAndShipping, receipt };
    }
  } catch {}
  // Fallback: live readback via ptc_inspect_mx_draft
  const { id } = await enqueueAtomic(extId, { action: "ptc_inspect_mx_draft", sourceId, draftId });
  const { reply } = await waitOutbox(id, timeoutMs);
  if (!reply?.ok) throw new Error(`Fallback ptc_inspect_mx_draft failed: ${reply?.error || JSON.stringify(reply)}`);
  const sales = reply.result?.readback?.salesAndShipping || reply.result?.salesAndShipping;
  if (!sales?.skus?.length) throw new Error("Could not read SKU baseline prices from receipt or live inspect");
  return { sales, receipt: reply.result };
}

function buildReportData(progress) {
  const items = Object.values(progress.items || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const counts = {};
  let sumCreate = 0, nCreate = 0;
  let sumReprice = 0, nReprice = 0;
  let sumPublish = 0, nPublish = 0;
  const tok = { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0, itemsWithTokens: 0 };
  const failures = [];

  for (const it of items) {
    counts[it.status] = (counts[it.status] || 0) + 1;
    const cSec = it.createElapsedSec ?? it.createWallSec;
    if (typeof cSec === "number" && it.draftId) { sumCreate += cSec; nCreate++; }
    const rSec = it.repriceElapsedSec ?? it.repriceWallSec;
    if (typeof rSec === "number" && it.repriced) { sumReprice += rSec; nReprice++; }
    const pSec = it.publishElapsedSec ?? it.publishWallSec;
    if (typeof pSec === "number" && it.status === "published") { sumPublish += pSec; nPublish++; }
    if (it.tokenUsage) {
      tok.itemsWithTokens++;
      tok.calls += Number(it.tokenUsage.calls || 0);
      tok.inputTokens += Number(it.tokenUsage.inputTokens || 0);
      tok.outputTokens += Number(it.tokenUsage.outputTokens || 0);
      tok.cacheCreationInputTokens += Number(it.tokenUsage.cacheCreationInputTokens || 0);
      tok.cacheReadInputTokens += Number(it.tokenUsage.cacheReadInputTokens || 0);
      tok.totalTokens += Number(it.tokenUsage.totalTokens || 0);
    }
    if (String(it.status || "").includes("failed") || it.status === "publish_unconfirmed") {
      failures.push({ index: it.index, name: it.name, sourceId: it.sourceId, status: it.status, draftId: it.draftId || null, error: it.error || "" });
    }
  }

  return {
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    batchWallSec: progress.batchWallSec ?? null,
    totalItems: items.length,
    counts,
    timing: {
      createAvgSec: nCreate ? +(sumCreate / nCreate).toFixed(2) : null,
      createSumSec: +sumCreate.toFixed(2),
      repriceAvgSec: nReprice ? +(sumReprice / nReprice).toFixed(2) : null,
      publishAvgSec: nPublish ? +(sumPublish / nPublish).toFixed(2) : null,
    },
    pluginTokenUsage: {
      ...tok,
      avgTotalTokensPerItem: tok.itemsWithTokens ? Math.round(tok.totalTokens / tok.itemsWithTokens) : 0,
      note: "reprice_draft and publish_draft are deterministic ptc_exec actions and consume 0 LLM tokens.",
    },
    items,
    failures,
  };
}

function formatReportMarkdown(data, { includePending = false } = {}) {
  const lines = [];
  const shown = includePending ? data.items : data.items.filter(it => it.status !== "pending");
  const rows = shown.length ? shown : data.items;
  const skippedPending = data.items.length - rows.length;
  lines.push("## TikTok MX 上架汇总报告");
  lines.push("");
  lines.push(`- **商品总数**: ${data.totalItems} | **状态分布**: ${Object.entries(data.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (data.batchWallSec != null) lines.push(`- **整体墙钟耗时**: ${data.batchWallSec}s (${(data.batchWallSec / 60).toFixed(1)} min)`);
  lines.push(`- **分阶段平均耗时**: 建草稿 ${data.timing.createAvgSec ?? "-"}s | 改测试价 ${data.timing.repriceAvgSec ?? "-"}s | 提审 ${data.timing.publishAvgSec ?? "-"}s`);
  const t = data.pluginTokenUsage;
  lines.push(`- **插件 PTC Token 消耗** (${t.itemsWithTokens} 件已计费): 总计 **${t.totalTokens.toLocaleString()}** tokens（Calls: ${t.calls}, Input: ${t.inputTokens.toLocaleString()}, Output: ${t.outputTokens.toLocaleString()}, CacheRead: ${t.cacheReadInputTokens.toLocaleString()}），单品均值 **${t.avgTotalTokensPerItem.toLocaleString()}** tokens（改价与提审为确定性执行，消耗 0 tokens）`);
  lines.push("");
  lines.push("| # | 商品名 | 状态 | Draft/Product ID | SKU数 | 建草稿(s) | 改价(s) | 提审(s) | PTC Calls | Total Tokens |");
  lines.push("|---:|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const it of rows) {
    const idCol = it.productId || it.draftId || "-";
    const cSec = it.createElapsedSec ?? it.createWallSec ?? "-";
    const rSec = it.repriceElapsedSec ?? it.repriceWallSec ?? "-";
    const pSec = it.publishElapsedSec ?? it.publishWallSec ?? "-";
    const calls = it.tokenUsage?.calls ?? "-";
    const tot = it.tokenUsage?.totalTokens != null ? it.tokenUsage.totalTokens.toLocaleString() : "-";
    const safeName = String(it.name || it.sourceId).replace(/\|/g, "/").slice(0, 36);
    lines.push(`| ${it.index} | ${safeName} | ${it.status} | ${idCol} | ${it.skuCount ?? "-"} | ${cSec} | ${rSec} | ${pSec} | ${calls} | ${tot} |`);
  }
  if (skippedPending > 0) {
    lines.push("");
    lines.push(`_（已省略 ${skippedPending} 条未运行的 \`pending\` 商品；传入 \`--all\` 可显示全部）_`);
  }
  if (data.failures.length) {
    lines.push("");
    lines.push("### 异常 / 待处理项");
    for (const f of data.failures) {
      lines.push(`- **#${f.index} ${f.name}** (\`${f.status}\`, sourceId=\`${f.sourceId}\`${f.draftId ? `, draftId=\`${f.draftId}\`` : ""}): ${String(f.error).slice(0, 220)}`);
    }
  }
  return lines.join("\n");
}

async function cmdReport(opts) {
  if (!opts.progress) throw new Error("report requires --progress <file>");
  const progress = JSON.parse(await fs.readFile(path.resolve(opts.progress), "utf8"));
  const data = buildReportData(progress);
  if (opts.json) console.log(JSON.stringify(data, null, 2));
  else console.log(formatReportMarkdown(data, { includePending: Boolean(opts.all) }));
}

async function cmdAction(opts) {
  const mode = String(opts.mode || "").trim();
  if (!mode) throw new Error("action requires --mode <listing_status|delist_listing|optimize_listing|read_orders|inspect|repair>");
  const extId = resolveExtensionId(opts["extension-id"]);
  const timeoutMs = Number(opts["timeout-ms"] || 300000);

  let job;
  if (mode === "listing_status" || mode === "delist_listing") {
    const productId = String(opts["product-id"] || "").trim();
    if (!NUMERIC_ID_RE.test(productId)) throw new Error(`${mode} requires numeric --product-id`);
    if (mode === "delist_listing" && PROTECTED_PRODUCT_IDS.has(productId)) {
      throw new Error(`Refusing to delist protected product ${productId}`);
    }
    job = { action: "ptc_mx_seller_action", request: { mode, productId } };
  } else if (mode === "optimize_listing") {
    const productId = String(opts["product-id"] || "").trim();
    if (!NUMERIC_ID_RE.test(productId)) throw new Error("optimize_listing requires numeric --product-id");
    if (PROTECTED_PRODUCT_IDS.has(productId)) throw new Error(`Refusing to modify protected product ${productId}`);
    const editorUrl = String(opts["editor-url"] || "").trim();
    const beforeTitle = String(opts["before-title"] || "").trim();
    const afterTitle = String(opts["after-title"] || "").trim();
    if (!editorUrl || !beforeTitle || !afterTitle) {
      throw new Error("optimize_listing requires --product-id, --editor-url, --before-title, and --after-title");
    }
    job = { action: "ptc_mx_seller_action", request: { mode, productId, editorUrl, beforeTitle, afterTitle } };
  } else if (mode === "read_orders") {
    const orderStatus = opts["order-status"] ? String(opts["order-status"]).trim() : undefined;
    const allowed = ["all", "to_ship", "shipped", "completed", "cancelled"];
    if (orderStatus && !allowed.includes(orderStatus)) {
      throw new Error(`Invalid --order-status (expected one of: ${allowed.join(", ")})`);
    }
    job = { action: "ptc_mx_seller_action", request: { mode, ...(orderStatus ? { orderStatus } : {}) } };
  } else if (mode === "inspect") {
    const sourceId = String(opts["source-id"] || "").trim();
    const draftId = String(opts["draft-id"] || "").trim();
    if (!NUMERIC_ID_RE.test(sourceId) || !NUMERIC_ID_RE.test(draftId)) {
      throw new Error("inspect requires numeric --source-id and --draft-id");
    }
    job = { action: "ptc_inspect_mx_draft", sourceId, draftId };
  } else if (mode === "repair") {
    const sourceId = String(opts["source-id"] || "").trim();
    const draftId = String(opts["draft-id"] || "").trim();
    const repair = String(opts.repair || "").trim();
    if (!NUMERIC_ID_RE.test(sourceId) || !NUMERIC_ID_RE.test(draftId)) {
      throw new Error("repair requires numeric --source-id and --draft-id");
    }
    if (!["attributes", "category"].includes(repair)) {
      throw new Error("repair requires --repair attributes|category");
    }
    const queries = opts.queries
      ? String(opts.queries).split(",").map(s => s.trim()).filter(Boolean)
      : undefined;
    job = { action: "ptc_repair_mx_draft", sourceId, draftId, repair, ...(queries ? { queries } : {}) };
  } else {
    throw new Error(`Unsupported action mode: ${mode}`);
  }

  const { id, outboxFile } = await enqueueAtomic(extId, job);
  const { wallSec, reply } = await waitOutbox(id, timeoutMs);
  const result = { ok: Boolean(reply?.ok), mode, jobId: id, outboxFile, wallSec, reply };

  if (mode === "delist_listing" && reply?.ok && !opts["no-verify"]) {
    const verifyEnqueue = await enqueueAtomic(extId, {
      action: "ptc_mx_seller_action",
      request: { mode: "listing_status", productId: job.request.productId },
    });
    const verifyRes = await waitOutbox(verifyEnqueue.id, timeoutMs);
    result.verification = {
      jobId: verifyEnqueue.id,
      outboxFile: verifyEnqueue.outboxFile,
      wallSec: verifyRes.wallSec,
      reply: verifyRes.reply,
    };
    result.ok = Boolean(result.ok && verifyRes.reply?.ok && verifyRes.reply?.result?.status === "inactive");
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && isLoginRequiredError(reply?.error)) process.exit(3);
  if (!result.ok && isCaptchaError(reply?.error)) process.exit(2);
  process.exit(result.ok ? 0 : 1);
}

async function cmdRun(opts) {
  const stage = String(opts.stage || "draft").trim();
  if (!["draft", "reprice", "publish"].includes(stage)) {
    throw new Error(`Invalid --stage '${stage}' (expected draft | reprice | publish)`);
  }
  const rate = Number(opts.rate ?? DEFAULT_RATE);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Expected a positive --rate");

  const skipReprice = Boolean(opts["no-reprice"]);
  const doReprice = (stage === "reprice" || stage === "publish") && !skipReprice;
  const doPublish = stage === "publish";

  const multiplier = Number(opts.multiplier ?? 100);
  if (doReprice && ![10, 100].includes(multiplier)) {
    throw new Error("--multiplier must be 10 or 100 (PageLens seller contract)");
  }
  const useStockCap = doReprice && !opts["no-stock-cap"];
  const maxTotalStock = useStockCap ? Number(opts["max-total-stock"] ?? 10) : undefined;
  if (useStockCap && maxTotalStock !== 10) {
    throw new Error("--max-total-stock must be 10 (or pass --no-stock-cap to omit)");
  }

  let waveSize = Number(opts.wave ?? MAX_WAVE);
  if (!Number.isInteger(waveSize) || waveSize < 1) throw new Error("--wave must be an integer between 1 and 3");
  if (waveSize > MAX_WAVE) {
    console.warn(`[warn] PageLens caps concurrent draft windows at ${MAX_WAVE}; clamping --wave ${waveSize} -> ${MAX_WAVE}`);
    waveSize = MAX_WAVE;
  }

  const timeoutMs = Number(opts["timeout-ms"] || DEFAULT_WAIT_MS);
  const extId = resolveExtensionId(opts["extension-id"]);

  let products = [];
  if (opts.input) {
    products.push(...(await parseInputFile(opts.input)));
  }
  if (opts.urls.length) {
    products.push(...dedupeItems(opts.urls.map(u => ({ url: u }))));
  }
  products = dedupeItems(products);
  if (!products.length) throw new Error("No valid TikTok Shop JP URLs found. Pass --url <jpUrl> or --input <file>.");

  const fromIdx = opts.from ? Number(opts.from) : 1;
  const toIdx = opts.to ? Number(opts.to) : products.length;
  const onlySet = opts.only
    ? new Set(String(opts.only).split(",").map(s => Number(s.trim())).filter(Number.isInteger))
    : null;
  const retryFailed = Boolean(opts["retry-failed"]);

  const progressFile = path.resolve(
    opts.progress || path.join(os.tmpdir(), `pagelens-mx-progress-${Date.now()}.json`),
  );

  if (opts["dry-run"]) {
    const selected = products.filter(p => (onlySet ? onlySet.has(p.index) : p.index >= fromIdx && p.index <= toIdx));
    console.log(JSON.stringify({
      dryRun: true,
      extensionId: extId,
      stage,
      rate,
      doReprice,
      multiplier: doReprice ? multiplier : null,
      maxTotalStock: useStockCap ? maxTotalStock : null,
      doPublish,
      waveSize,
      progressFile,
      selectedCount: selected.length,
      items: selected,
    }, null, 2));
    return;
  }

  let progress;
  try {
    progress = JSON.parse(await fs.readFile(progressFile, "utf8"));
  } catch {
    progress = { startedAt: new Date().toISOString(), config: { stage, rate, multiplier: doReprice ? multiplier : null, maxTotalStock: maxTotalStock ?? null, waveSize }, items: {} };
  }
  for (const p of products) {
    progress.items[p.index] ??= {
      index: p.index,
      name: p.name,
      sourceId: p.sourceId,
      url: p.url,
      status: "pending",
      jobIds: {},
      outboxFiles: {},
    };
  }

  let saveChain = Promise.resolve();
  function saveProgress() {
    progress.updatedAt = new Date().toISOString();
    saveChain = saveChain.then(async () => {
      await fs.mkdir(path.dirname(progressFile), { recursive: true });
      const tmp = `${progressFile}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(progress, null, 2));
      await fs.rename(tmp, progressFile);
    });
    return saveChain;
  }
  await saveProgress();

  const isTargetDone = item => {
    if (!item) return false;
    if (stage === "draft") return Boolean(item.draftId);
    if (stage === "reprice") return Boolean(item.repriced);
    return item.status === "published";
  };

  const slice = products.filter(p => {
    const inRange = onlySet ? onlySet.has(p.index) : (p.index >= fromIdx && p.index <= toIdx);
    if (!inRange) return false;
    const item = progress.items[p.index];
    if (isTargetDone(item)) return false;
    if (item.status === "publish_unconfirmed") {
      console.warn(`[skip #${p.index}] status is publish_unconfirmed (draftId=${item.draftId}); check listing_status before retrying to prevent duplicate submission.`);
      return false;
    }
    if (retryFailed) return String(item.status || "").includes("failed");
    return true;
  });

  console.log(`[pagelens-mx] ext=${extId} | stage=${stage} | rate=${rate} | wave=${waveSize} | items=${slice.length}/${products.length} | progress=${progressFile}`);
  if (!slice.length) {
    console.log(formatReportMarkdown(buildReportData(progress)));
    return;
  }

  const batchT0 = Date.now();
  let captchaHit = false;
  let loginRequired = false;
  let waveAborted = false;

  for (let offset = 0; offset < slice.length; offset += waveSize) {
    if (captchaHit || loginRequired || waveAborted) break;
    const wave = slice.slice(offset, offset + waveSize);
    console.log(`\n=== WAVE [${wave.map(w => `#${w.index}`).join(", ")}] ===`);

    // STAGE 1: ptc_create_mx_draft
    const needCreate = wave.filter(w => !progress.items[w.index].draftId);
    if (needCreate.length) {
      console.log(`[create] Enqueueing ${needCreate.length} concurrent window(s): ${needCreate.map(w => `#${w.index}`).join(", ")}`);
      const createJobs = [];
      for (const w of needCreate) {
        const { id, outboxFile } = await enqueueAtomic(extId, {
          action: "ptc_create_mx_draft",
          sourceId: w.sourceId,
          rate,
        });
        const item = progress.items[w.index];
        item.status = "creating";
        item.jobIds.create = id;
        item.outboxFiles.create = outboxFile;
        createJobs.push({ w, id });
      }
      await saveProgress();

      await Promise.all(createJobs.map(async ({ w, id }) => {
        const { wallSec, reply } = await waitOutbox(id, timeoutMs);
        const item = progress.items[w.index];
        item.createWallSec = wallSec;
        if (reply?.ok && reply.result?.verified && reply.result?.draftId) {
          item.draftId = String(reply.result.draftId);
          item.receiptFile = reply.result.receiptFile || null;
          item.createElapsedSec = reply.result.elapsedSeconds ?? wallSec;
          item.status = "draft_created";
          item.error = undefined;
          try {
            const { receipt } = await readDraftReceipt(w.sourceId, item.receiptFile);
            item.title = receipt.title;
            item.category = receipt.readback?.category;
            item.skuCount = receipt.readback?.salesAndShipping?.skus?.length || 0;
            item.tokenUsage = receipt.tokenUsage || null;
            item.stages = receipt.stages || null;
          } catch {}
          const tokStr = item.tokenUsage ? `, tokens=${item.tokenUsage.totalTokens} (calls=${item.tokenUsage.calls})` : "";
          console.log(`  ✓ [create #${w.index}] ${w.name} -> draftId=${item.draftId} (${item.createElapsedSec}s${tokStr})`);
        } else {
          const err = reply?.error || JSON.stringify(reply);
          item.status = "create_failed";
          item.error = err;
          if (isLoginRequiredError(err)) {
            loginRequired = true;
          }
          if (isCaptchaError(err)) {
            captchaHit = true;
          } else {
            try {
              const p = path.join(SOURCES_DIR, `${w.sourceId}.json`);
              const rec = JSON.parse(await fs.readFile(p, "utf8"));
              if (!rec?.id) await fs.rm(p, { force: true });
            } catch {}
          }
          console.error(`  ✗ [create #${w.index}] ${w.name} FAILED (${wallSec}s): ${String(err).slice(0, 220)}`);
        }
        await saveProgress();
      }));

      if (!loginRequired && !captchaHit && needCreate.length >= 2 &&
          needCreate.every(w => progress.items[w.index].status === "create_failed" && NAV_FAIL_RE.test(String(progress.items[w.index].error || "")))) {
        waveAborted = true;
        console.error("[STOP] Entire wave failed to load Seller Center pages (check if the MX shop is logged in). Stopping automation without launching further waves.");
      }
    }

    if (loginRequired) {
      console.error("[STOP] TikTok Seller Center is not logged in! Stopping automation immediately. Sign in to the MX Seller Center in Chrome, then resume with the same --progress file.");
      break;
    }
    if (captchaHit) {
      console.error("[STOP] CAPTCHA / seller verification detected during create. Complete verification in Chrome, then re-run with the same --progress file.");
      break;
    }
    if (waveAborted) break;

    // STAGE 2: reprice_draft (optional)
    if (doReprice) {
      const needReprice = wave.filter(w => progress.items[w.index].draftId && !progress.items[w.index].repriced);
      if (needReprice.length) {
        console.log(`[reprice] Enqueueing ${needReprice.length} reprice_draft job(s) (${multiplier}x + dynamic ceiling)...`);
        const repriceJobs = [];
        for (const w of needReprice) {
          const item = progress.items[w.index];
          if (PROTECTED_PRODUCT_IDS.has(item.draftId)) {
            item.status = "reprice_failed";
            item.error = `Refusing to modify protected product ${item.draftId}`;
            continue;
          }
          try {
            const { sales } = await loadSalesAndShipping(extId, w.sourceId, item.draftId, item.receiptFile, timeoutMs);
            const baselinePricesMXN = sales.skus.map(s => ({ label: String(s.label).trim(), priceMXN: roundCents(s.priceMXN) }));
            const req = {
              mode: "reprice_draft",
              sourceId: w.sourceId,
              draftId: item.draftId,
              baselinePricesMXN,
              multiplier,
              ...(useStockCap ? { maxTotalStock } : {}),
            };
            const { id, outboxFile } = await enqueueAtomic(extId, { action: "ptc_mx_seller_action", request: req });
            item.status = "repricing";
            item.jobIds.reprice = id;
            item.outboxFiles.reprice = outboxFile;
            item.offerMeta = {
              brand: sales.brand || "无品牌",
              packagedWeightGrams: sales.packagedWeightGrams,
              packageCm: sales.packageCm,
            };
            repriceJobs.push({ w, id });
          } catch (e) {
            item.status = "reprice_failed";
            item.error = String(e.message || e);
            if (isLoginRequiredError(item.error)) loginRequired = true;
            console.error(`  ✗ [reprice prep #${w.index}] ${item.error}`);
          }
        }
        await saveProgress();

        await Promise.all(repriceJobs.map(async ({ w, id }) => {
          const { wallSec, reply } = await waitOutbox(id, timeoutMs);
          const item = progress.items[w.index];
          item.repriceWallSec = wallSec;
          if (reply?.ok && reply.result?.verified) {
            item.repriced = true;
            item.repriceElapsedSec = reply.result.elapsedSeconds ?? wallSec;
            item.prices = reply.result.prices;
            item.status = "repriced";
            item.error = undefined;
            const summary = (item.prices || []).map(p => `${p.beforeMXN}->${p.afterMXN}${p.maxPriceMXN ? "(cap)" : ""}`).join(", ");
            console.log(`  ✓ [reprice #${w.index}] ${w.name} -> [${summary}] (${item.repriceElapsedSec}s)`);
          } else {
            const err = reply?.error || JSON.stringify(reply);
            item.status = "reprice_failed";
            item.error = err;
            if (isLoginRequiredError(err)) loginRequired = true;
            if (isCaptchaError(err)) captchaHit = true;
            console.error(`  ✗ [reprice #${w.index}] ${w.name} FAILED: ${String(err).slice(0, 220)}`);
          }
          await saveProgress();
        }));
      }
    }

    if (loginRequired) {
      console.error("[STOP] TikTok Seller Center is not logged in during reprice! Stopping automation immediately.");
      break;
    }
    if (captchaHit) {
      console.error("[STOP] CAPTCHA / seller verification detected during reprice. Complete verification in Chrome, then re-run with the same --progress file.");
      break;
    }

    // STAGE 3: publish_draft (optional)
    if (doPublish) {
      const needPublish = wave.filter(w => {
        const item = progress.items[w.index];
        if (!item.draftId || item.status === "published" || item.status === "publish_unconfirmed") return false;
        return skipReprice ? true : Boolean(item.repriced);
      });
      if (needPublish.length) {
        console.log(`[publish] Enqueueing ${needPublish.length} publish_draft job(s)...`);
        const publishJobs = [];
        for (const w of needPublish) {
          const item = progress.items[w.index];
          if (PROTECTED_PRODUCT_IDS.has(item.draftId)) {
            item.status = "publish_failed";
            item.error = `Refusing to publish protected product ${item.draftId}`;
            continue;
          }
          try {
            let meta = item.offerMeta;
            let skus;
            if (skipReprice || !item.prices?.length || !meta) {
              const { sales } = await loadSalesAndShipping(extId, w.sourceId, item.draftId, item.receiptFile, timeoutMs);
              meta = {
                brand: sales.brand || "无品牌",
                packagedWeightGrams: sales.packagedWeightGrams,
                packageCm: sales.packageCm,
              };
              item.offerMeta = meta;
              skus = skipReprice
                ? sales.skus.map(s => ({ label: String(s.label).trim(), priceMXN: roundCents(s.priceMXN), stock: s.stock }))
                : (item.prices || []).map(p => ({ label: String(p.label).trim(), priceMXN: roundCents(p.afterMXN), stock: p.stock }));
            } else {
              skus = item.prices.map(p => ({ label: String(p.label).trim(), priceMXN: roundCents(p.afterMXN), stock: p.stock }));
            }
            const { id, outboxFile } = await enqueueAtomic(extId, {
              action: "ptc_mx_seller_action",
              request: {
                mode: "publish_draft",
                sourceId: w.sourceId,
                draftId: item.draftId,
                offer: {
                  brand: meta.brand,
                  packagedWeightGrams: meta.packagedWeightGrams,
                  packageCm: meta.packageCm,
                  skus,
                },
              },
            });
            item.status = "publishing";
            item.jobIds.publish = id;
            item.outboxFiles.publish = outboxFile;
            publishJobs.push({ w, id });
          } catch (e) {
            item.status = "publish_failed";
            item.error = String(e.message || e);
            if (isLoginRequiredError(item.error)) loginRequired = true;
            console.error(`  ✗ [publish prep #${w.index}] ${item.error}`);
          }
        }
        await saveProgress();

        await Promise.all(publishJobs.map(async ({ w, id }) => {
          const { wallSec, reply } = await waitOutbox(id, timeoutMs);
          const item = progress.items[w.index];
          item.publishWallSec = wallSec;
          if (reply?.ok && reply.result?.verified && reply.result?.submitted) {
            item.status = "published";
            item.productId = String(reply.result.productId || item.draftId);
            item.sellerStatus = reply.result.status;
            item.publishElapsedSec = reply.result.elapsedSeconds ?? wallSec;
            item.error = undefined;
            console.log(`  ✓ [publish #${w.index}] ${w.name} -> productId=${item.productId}, status=${item.sellerStatus} (${item.publishElapsedSec}s)`);
          } else {
            const err = reply?.error || JSON.stringify(reply);
            item.status = UNCERTAIN_PUBLISH_RE.test(err) ? "publish_unconfirmed" : "publish_failed";
            item.error = err;
            if (isLoginRequiredError(err)) loginRequired = true;
            if (isCaptchaError(err)) captchaHit = true;
            console.error(`  ✗ [publish #${w.index}] ${w.name} ${item.status.toUpperCase()}: ${String(err).slice(0, 220)}`);
          }
          await saveProgress();
        }));
      }
    }

    if (loginRequired) {
      console.error("[STOP] TikTok Seller Center is not logged in during publish! Stopping automation immediately.");
      break;
    }
    if (captchaHit) {
      console.error("[STOP] CAPTCHA / seller verification detected during publish. Complete verification in Chrome, then check listing_status / resume.");
      break;
    }
  }

  progress.batchWallSec = +((progress.batchWallSec || 0) + (Date.now() - batchT0) / 1000).toFixed(2);
  await saveProgress();

  const reportData = buildReportData(progress);
  console.log("\n" + formatReportMarkdown(reportData));
  console.log(`\n[progress] ${progressFile}`);

  if (loginRequired) process.exit(3);
  if (captchaHit) process.exit(2);
  const unfinished = slice.filter(p => !isTargetDone(progress.items[p.index]));
  process.exit(unfinished.length ? 1 : 0);
}

async function main() {
  const { cmd, opts } = parseCliArgs(process.argv.slice(2));
  if (!cmd || opts.help || cmd === "help") {
    printHelp();
    process.exit(0);
  }
  if (cmd === "status") return cmdStatus(opts);
  if (cmd === "parse") return cmdParse(opts);
  if (cmd === "run") return cmdRun(opts);
  if (cmd === "action") return cmdAction(opts);
  if (cmd === "report") return cmdReport(opts);
  throw new Error(`Unknown command: ${cmd}. Run with --help for usage.`);
}

main().catch(err => {
  console.error(`[error] ${err.message || err}`);
  process.exit(1);
});
