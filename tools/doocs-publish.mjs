#!/usr/bin/env node
/**
 * Deterministic Doocs → COSE multi-platform publish, no LLM involved.
 * Drives the extension through agent-inbox `bridge_call` jobs (needs Native Host,
 * agentBridgeEnabled, and localhost:* in agentBridgeOrigins; no CDP / 9222).
 *
 *   node tools/doocs-publish.mjs --platforms 微信公众号,知乎,B站,小红书,抖音          # dry run: stops before 确定
 *   node tools/doocs-publish.mjs --platforms ... --confirm [--wait 20]              # really click 确定
 *
 * Platform names are label prefixes in the COSE dialog. Every other platform that is
 * currently checked gets unchecked, so the selection is exactly --platforms.
 * Output is JSON facts only (selection state, dialog text, toast text after confirm).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INBOX = path.join(os.homedir(), ".pagelens", "agent-inbox");
const OUTBOX = path.join(os.homedir(), ".pagelens", "agent-outbox");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridgeCall(tool, args = {}, timeoutMs = 60000) {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(OUTBOX, { recursive: true });
  const id = crypto.randomUUID();
  const job = { id, createdAt: new Date().toISOString(), action: "bridge_call", request: { tool, args } };
  fs.writeFileSync(path.join(INBOX, `${id}.json`), JSON.stringify(job), "utf8");
  const outPath = path.join(OUTBOX, `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(outPath)) {
      const res = JSON.parse(fs.readFileSync(outPath, "utf8"));
      if (!res.ok) {
        const e = res.error;
        throw new Error(`${tool} 失败: ${typeof e === "string" ? e : `${e?.code || ""} ${e?.message || ""}`}`.trim());
      }
      return res.result;
    }
    await sleep(700);
  }
  throw new Error(`${tool}: 等待 outbox 超时（inbox 轮询约 6s；确认浏览器和扩展在运行）`);
}

const DIALOG = "[role='dialog'], [aria-modal='true'], dialog[open]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wanted = String(args.platforms || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) throw new Error("--platforms 必填，如 微信公众号,知乎,B站,小红书,抖音");
  const confirm = args.confirm === true;
  const waitSec = Number(args.wait || 20);
  const urlPart = String(args["tab-url-includes"] || "localhost:8080");

  const tabs = await bridgeCall("list_tabs", { query: urlPart });
  const tab = tabs.find((t) => String(t.url).includes(urlPart));
  if (!tab) throw new Error(`没有找到 URL 含 ${urlPart} 的标签页`);
  const tabId = tab.id;

  const runJs = async (code) => (await bridgeCall("run_js", { tabId, code }))?.result;
  const dialogOpen = () =>
    runJs(`return [...document.querySelectorAll(${JSON.stringify(DIALOG)})].some(e => e.getBoundingClientRect().width > 0)`);

  if (!(await dialogOpen())) {
    await bridgeCall("trusted_click", { tabId, text: "发布" });
    await bridgeCall("wait_for", { tabId, selector: "[role='dialog'] button[role='checkbox']", timeoutMs: 15000 });
  }

  await bridgeCall("set_checks", { tabId, labels: wanted, checked: true });

  const listed = await bridgeCall("set_checks", { tabId });
  const lower = (s) => s.toLowerCase();
  const isWanted = (label) => wanted.some((w) => lower(label).startsWith(lower(w)));
  const extras = listed.items
    .filter((it) => it.checked && it.label && it.label !== "全选" && !isWanted(it.label))
    .map((it) => it.label);
  if (extras.length) await bridgeCall("set_checks", { tabId, labels: extras, checked: false, exact: true });

  const finalItems = (await bridgeCall("set_checks", { tabId })).items;
  const checked = finalItems.filter((it) => it.checked && it.label !== "全选").map((it) => it.label);
  const missing = wanted.filter((w) => !checked.some((c) => lower(c).startsWith(lower(w))));
  const unexpected = checked.filter((c) => !isWanted(c));
  const report = { tabId, wanted, checked, missing, unexpected, confirmed: false };

  if (missing.length || unexpected.length) {
    console.log(JSON.stringify({ ...report, error: "勾选结果与期望不一致，未点击确定" }, null, 2));
    process.exit(2);
  }
  if (!confirm) {
    console.log(JSON.stringify({ ...report, note: "dry-run：未点击确定，加 --confirm 才会发布" }, null, 2));
    return;
  }

  await bridgeCall("trusted_click", { tabId, text: "确定" });
  report.confirmed = true;
  const deadline = Date.now() + waitSec * 1000;
  let snapshot = null;
  while (Date.now() < deadline) {
    await sleep(2500);
    snapshot = await runJs(
      `const t = s => [...document.querySelectorAll(s)].map(e => (e.innerText || '').trim()).filter(Boolean);
return { dialogOpen: [...document.querySelectorAll(${JSON.stringify(DIALOG)})].some(e => e.getBoundingClientRect().width > 0),
  dialogText: t(${JSON.stringify(DIALOG)}).join('\\n').slice(0, 1500),
  toasts: t("[data-sonner-toast], [role='status'], [role='alert'], .toast, .el-message, .ant-message").slice(0, 10) }`,
    );
  }
  console.log(JSON.stringify({ ...report, after: snapshot }, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
