#!/usr/bin/env node
/**
 * PageLens agent-inbox CLI — drop jobs for the extension SW to pick up.
 *
 *   node tools/agent-inbox.mjs enqueue --action clipboard_write --text 'hi'
 *   node tools/agent-inbox.mjs enqueue --action wechat_fill_draft --title '...' --html-file ./body.html
 *   node tools/agent-inbox.mjs enqueue --action agent_prompt --prompt-file ./task.txt [--tab-url-includes localhost:8080] [--timeout-ms 300000]
 *   node tools/agent-inbox.mjs cancel [<promptId>] [--all]   # stop running agent_prompt / drop queued ones
 *   node tools/agent-inbox.mjs enqueue --action paste_html --html-file ./a.html --token-file ~/.pagelens/agents/cli.token
 *   node tools/agent-inbox.mjs wait <id>
 *   node tools/agent-inbox.mjs status
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOME = os.homedir();
const INBOX = path.join(HOME, ".pagelens", "agent-inbox");
const OUTBOX = path.join(HOME, ".pagelens", "agent-outbox");
const PROCESSED = path.join(INBOX, "processed");
const PAYLOADS = path.join(HOME, ".pagelens", "agent-payloads");

function ensureDirs() {
  for (const d of [INBOX, OUTBOX, PROCESSED, PAYLOADS]) fs.mkdirSync(d, { recursive: true });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function readMaybeFile(p) {
  if (!p) return "";
  return fs.readFileSync(path.resolve(String(p)), "utf8");
}

function enqueue(opts) {
  ensureDirs();
  const id = String(opts.id || crypto.randomUUID());
  const action = String(opts.action || "").trim();
  if (!action) throw new Error("--action required");

  const job = {
    id,
    createdAt: new Date().toISOString(),
    action,
  };

  if (opts["tab-url-includes"] || opts.tabUrlIncludes) {
    job.tabUrlIncludes = String(opts["tab-url-includes"] || opts.tabUrlIncludes);
  }
  if (opts["request-json"]) job.request = JSON.parse(String(opts["request-json"]));
  if (opts.prompt && opts.prompt !== true) job.prompt = String(opts.prompt);
  if (opts["prompt-file"]) job.prompt = readMaybeFile(opts["prompt-file"]);
  if (action === "agent_prompt" && !String(job.prompt || "").trim()) {
    throw new Error("agent_prompt requires --prompt or --prompt-file");
  }
  if (opts["tab-id"]) job.tabId = Number(opts["tab-id"]);
  if (opts.url && opts.url !== true) job.url = String(opts.url);
  if (opts["timeout-ms"]) job.timeoutMs = Number(opts["timeout-ms"]);
  if (opts["metadata-json"]) job.metadata = JSON.parse(String(opts["metadata-json"]));
  if (opts.title) job.title = String(opts.title);
  if (opts.text) job.text = String(opts.text);
  if (opts.markdown) job.markdown = String(opts.markdown);
  if (opts["markdown-file"]) {
    const md = readMaybeFile(opts["markdown-file"]);
    if (md.length > 80000) {
      const mdPath = path.join(PAYLOADS, `${id}.md`);
      fs.writeFileSync(mdPath, md, "utf8");
      job.markdownFile = mdPath;
    } else {
      job.markdown = md;
    }
  }
  if (opts.selector) job.selector = String(opts.selector);
  if (opts.desc) job.desc = String(opts.desc);
  if (opts.platforms) {
    job.platforms = String(opts.platforms)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (opts["prefer-trusted-paste"] === "false" || opts.preferTrustedPaste === "false") {
    job.preferTrustedPaste = false;
  } else if (opts["prefer-trusted-paste"] != null || opts.preferTrustedPaste != null) {
    job.preferTrustedPaste = true;
  }
  if (opts["allow-insert-html-fallback"] === true || opts["allow-insert-html-fallback"] === "true") {
    job.allowInsertHtmlFallback = true;
  }
  if (opts.replace === true || opts.replace === "true") job.replace = true;
  const token = opts["token-file"] ? readMaybeFile(opts["token-file"]).trim() : process.env.PAGELENS_TOKEN?.trim();
  if (token) job.token = token;

  let html = opts.html ? String(opts.html) : "";
  if (opts["html-file"]) html = readMaybeFile(opts["html-file"]);

  // Keep job JSON small: large HTML goes to payloads/
  if (html && html.length > 80000) {
    const bodyPath = path.join(PAYLOADS, `${id}.html`);
    fs.writeFileSync(bodyPath, html, "utf8");
    job.htmlFile = bodyPath;
    if (!job.text) {
      job.text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
    }
  } else if (html) {
    job.html = html;
  }

  const jobPath = path.join(INBOX, `${id}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, id, jobPath, outboxPath: path.join(OUTBOX, `${id}.json`) }, null, 2));
  return id;
}

function readOutbox(id) {
  const p = path.join(OUTBOX, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function waitId(id, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = readOutbox(id);
    if (res) {
      console.log(JSON.stringify(res, null, 2));
      return res;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for outbox ${id} after ${timeoutMs}ms`);
}

function status() {
  ensureDirs();
  const inbox = fs.readdirSync(INBOX).filter((n) => n.endsWith(".json"));
  const outbox = fs.readdirSync(OUTBOX).filter((n) => n.endsWith(".json"));
  const processed = fs.existsSync(PROCESSED)
    ? fs.readdirSync(PROCESSED).filter((n) => n.endsWith(".json"))
    : [];
  console.log(
    JSON.stringify(
      {
        inboxDir: INBOX,
        outboxDir: OUTBOX,
        inbox: inbox.length,
        outbox: outbox.length,
        processed: processed.length,
        pending: inbox,
        recentOutbox: outbox.slice(-10),
      },
      null,
      2,
    ),
  );
}

function dropPending(id, reason) {
  const jobPath = path.join(INBOX, `${id}.json`);
  if (!fs.existsSync(jobPath)) return false;
  fs.renameSync(jobPath, path.join(PROCESSED, `${id}.json`));
  fs.writeFileSync(
    path.join(OUTBOX, `${id}.json`),
    JSON.stringify({
      id,
      ok: false,
      finishedAt: new Date().toISOString(),
      action: "agent_prompt",
      errorCode: "CANCELLED",
      error: reason,
    }, null, 2),
    "utf8",
  );
  return true;
}

/** Stop a running agent_prompt (via agent_cancel job) and/or drop jobs still waiting in the inbox. */
function cancel(args) {
  ensureDirs();
  const targetId = args._[1] ? String(args._[1]) : "";
  const dropped = [];
  if (targetId) {
    if (dropPending(targetId, "排队中被取消")) dropped.push(targetId);
  } else if (args.all) {
    for (const name of fs.readdirSync(INBOX).filter((n) => n.endsWith(".json"))) {
      const file = path.join(INBOX, name);
      let job = null;
      try { job = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* skip */ }
      if (job?.action === "agent_prompt" && dropPending(name.replace(/\.json$/, ""), "排队中被取消")) {
        dropped.push(name.replace(/\.json$/, ""));
      }
    }
  }
  const needRunningCancel = !targetId || !dropped.includes(targetId);
  const cancelId = `cancel-${crypto.randomUUID()}`;
  if (needRunningCancel) {
    const job = { id: cancelId, createdAt: new Date().toISOString(), action: "agent_cancel" };
    if (targetId) job.targetId = targetId;
    fs.writeFileSync(path.join(INBOX, `${cancelId}.json`), JSON.stringify(job, null, 2), "utf8");
  }
  console.log(JSON.stringify({
    ok: true,
    droppedPending: dropped,
    cancelJobId: needRunningCancel ? cancelId : null,
    note: "运行中的任务约 6s 内被中止；用 wait <cancelJobId> 查看结果，原任务 outbox 为 errorCode=CANCELLED",
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "status";
  if (cmd === "enqueue") {
    enqueue(args);
    return;
  }
  if (cmd === "cancel") {
    cancel(args);
    return;
  }
  if (cmd === "wait") {
    const id = args._[1] || args.id;
    if (!id) throw new Error("usage: wait <id>");
    const timeoutMs = Number(args.timeout || args["timeout-ms"] || 60000);
    const res = await waitId(id, { timeoutMs });
    process.exit(res?.ok ? 0 : 2);
  }
  if (cmd === "status") {
    status();
    return;
  }
  if (cmd === "show") {
    const id = args._[1];
    if (!id) throw new Error("usage: show <id>");
    const res = readOutbox(id);
    if (!res) throw new Error(`no outbox for ${id}`);
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
