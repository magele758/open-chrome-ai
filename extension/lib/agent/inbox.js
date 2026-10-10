/**
 * External-agent file inbox: poll ~/.pagelens/agent-inbox/*.json via Native Host,
 * execute actions (clipboard / trusted paste / WeChat draft / COSE), write outbox.
 * Zero new daemon — external agents drop jobs; the service worker picks them up.
 */

import { nativeFs, nativeSend } from "../native-host.js";
import { getCdp } from "../cdp.js";
import { keyEvents } from "../cdp-input.js";
import { inject, injectMain, restrictedUrl } from "../chrome.js";
import { pasteIntoPage } from "./page-fns.js";
import { cosePublish } from "./companions.js";
import { loadSettings } from "../storage.js";
import { getBridge } from "../bridge/index.js";
import { isUrlAllowed } from "../bridge/policy.js";
import {
  confirmSummary,
  createPollGate,
  missingScopes,
  needsConfirmation,
  pickAllowedTab,
  pollMinutesFor,
  redactJobToken,
} from "./inbox-policy.js";
import { getInboxConfirm } from "./inbox-confirm.js";
import { verifyToken } from "../bridge/auth.js";
import { loadAgentTokens } from "../bridge/token-store.js";
import { auditEntry, getAuditLog, originOfUrl } from "../bridge/audit.js";
import { enforceTokenGuards } from "../bridge/trust-guard.js";
import { chromeStorageAdapter, createApprovalQueue } from "./trust/approval-queue.js";
import { offscreenDoc } from "../offscreen-doc.js";
import { markJobStarted, recordJobFinished } from "./inbox-activity.js";
import { cancelAgentPrompt, startAgentPrompt, takeCompletion, takeExpired } from "./inbox-agent.js";

export const INBOX_ROOT = "~/.pagelens/agent-inbox";
export const OUTBOX_ROOT = "~/.pagelens/agent-outbox";
export const PROCESSED_REL = "processed";
export const ALARM_NAME = "pagelens-agent-inbox";

const cdp = getCdp();
const gate = createPollGate();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDirs() {
  if (gate.dirsReady()) return;
  for (const path of [INBOX_ROOT, OUTBOX_ROOT, `${INBOX_ROOT}/${PROCESSED_REL}`]) {
    const res = await nativeFs({ action: "ensureDir", path });
    if (!res?.ok) throw new Error(res?.error || `ensureDir failed: ${path}`);
  }
  gate.markDirsReady();
}

async function listInboxJobs() {
  const res = await nativeFs({ action: "readdir", root: INBOX_ROOT, rel: "" });
  if (!res?.ok) throw new Error(res?.error || "list inbox failed");
  return (res.entries || [])
    .filter((e) => e.kind === "file" && String(e.name).toLowerCase().endsWith(".json"))
    .map((e) => e.name)
    .sort();
}

async function readJson(root, rel) {
  const res = await nativeFs({ action: "readText", root, rel });
  if (!res?.ok) throw new Error(res?.error || `read failed: ${rel}`);
  if (res.truncated) throw new Error(`job too large (truncated): ${rel}`);
  return JSON.parse(res.text);
}

async function writeJson(root, rel, obj) {
  const text = JSON.stringify(obj, null, 2);
  const res = await nativeFs({ action: "writeText", root, rel, text });
  if (!res?.ok) throw new Error(res?.error || `write failed: ${rel}`);
}

async function deleteRel(root, rel) {
  const res = await nativeFs({ action: "deleteFile", root, rel });
  if (!res?.ok) throw new Error(res?.error || `delete failed: ${rel}`);
}

/** Move job to processed/ then write outbox result. */
async function finishJob(jobName, job, result) {
  const id = String(job?.id || jobName.replace(/\.json$/i, ""));
  const out = {
    id,
    ok: Boolean(result?.ok),
    finishedAt: new Date().toISOString(),
    action: job?.action || null,
    ...result,
  };
  await writeJson(INBOX_ROOT, `${PROCESSED_REL}/${jobName}`, redactJobToken(job));
  try {
    await deleteRel(INBOX_ROOT, jobName);
  } catch {
    /* already gone */
  }
  await writeJson(OUTBOX_ROOT, `${id}.json`, out);
  return out;
}

async function writeClipboardFromSw({ text = "", html = "", image = "" } = {}) {
  const payload = { text: String(text || ""), html: String(html || ""), image: String(image || "") };
  if (!payload.text && !payload.html && !payload.image) throw new Error("clipboard_write: empty payload");

  // Prefer Native Host (macOS pasteboard via JXA) — works from SW without DOM focus.
  if (!payload.image) {
    const native = await nativeSend({
      op: "clipboard_write",
      text: payload.text,
      html: payload.html,
    });
    if (native?.ok) return { ...native, via: "native" };
    // fall through to offscreen
  }

  // The audio document may be running interpretation; closing it would stop the dub.
  const docState = await offscreenDoc.state().catch(() => "none");
  if (docState === "audio") throw new Error("offscreen 文档被同传/录音占用，暂时无法写入富文本剪贴板");
  if (docState === "other") await chrome.offscreen.closeDocument().catch(() => {});
  await chrome.offscreen.createDocument({
    url: "offscreen/clipboard.html",
    reasons: ["CLIPBOARD"],
    justification: "Write rich clipboard for agent-inbox trusted paste",
  });
  try {
    let res = null;
    let lastErr = null;
    for (let i = 0; i < 8; i++) {
      await sleep(50 * (i + 1));
      try {
        res = await chrome.runtime.sendMessage({ type: "pl.clipboard.write", payload });
        if (res?.ok) break;
        lastErr = res?.error || "offscreen clipboard write failed";
      } catch (err) {
        lastErr = err?.message || String(err);
      }
    }
    if (!res?.ok) throw new Error(lastErr || "offscreen clipboard write failed");
    return { ...res, via: "offscreen" };
  } finally {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* ignore */
    }
  }
}

async function pressKeys(tabId, combos) {
  for (const combo of combos) {
    for (const event of keyEvents(combo)) {
      await cdp.send(tabId, "Input.dispatchKeyEvent", event);
    }
  }
}

async function pasteKeyCombo() {
  const info = await chrome.runtime.getPlatformInfo();
  return info.os === "mac" ? "Meta+V" : "Control+V";
}

async function findTab(spec, origins) {
  const tabs = await chrome.tabs.query({});
  const picked = pickAllowedTab(tabs, spec, origins, restrictedUrl);
  if (picked.error) throw new Error(picked.error);
  return picked.tab;
}

function setNativeValueFn(spec) {
  const o = spec || {};
  const sel = String(o.selector || "");
  const value = String(o.value ?? "");
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: `not found: ${sel}` };
  el.focus?.();
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value, length: String(el.value || "").length };
}

/** MAIN world: pick WeChat long-article body (COSE-style: ProseMirror not title). */
function wechatPickAndFocusBody() {
  const titleWrap = document.querySelector(".title-editor__input");
  const nodes = [...document.querySelectorAll(".ProseMirror")];
  const body = nodes.find((el) => {
    if (!el.isContentEditable && el.getAttribute("contenteditable") == null) return false;
    if (titleWrap && (titleWrap === el || titleWrap.contains(el) || el.closest?.(".title-editor__input"))) {
      return false;
    }
    return true;
  });
  if (!body) {
    return {
      ok: false,
      error: "WeChat body ProseMirror not found",
      candidates: nodes.map((n) => n.className),
    };
  }
  body.scrollIntoView?.({ block: "center", behavior: "auto" });
  body.focus?.();
  // Place caret inside so paste lands in the editor
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* ignore */
  }
  return { ok: true, tag: body.tagName, className: body.className };
}

function wechatVerify(spec) {
  const wantTitle = String(spec?.title || "");
  const minBody = Number(spec?.minBodyLength) || 500;
  const titleEl = document.querySelector("#title");
  const title = titleEl ? String(titleEl.value || titleEl.textContent || "").trim() : "";
  const titleWrap = document.querySelector(".title-editor__input");
  const nodes = [...document.querySelectorAll(".ProseMirror")];
  const body = nodes.find((el) => {
    if (titleWrap && (titleWrap === el || titleWrap.contains(el) || el.closest?.(".title-editor__input"))) {
      return false;
    }
    return true;
  });
  const bodyText = body ? String(body.innerText || "").trim() : "";
  return {
    ok: title === wantTitle && bodyText.length > minBody,
    title,
    titleMatch: title === wantTitle,
    bodyLength: bodyText.length,
    minBody,
  };
}


/** MAIN world: last-resort insertHTML into WeChat body (only when job allows). */
function wechatInsertHtml(spec) {
  const html = String(spec?.html || "");
  if (!html) return { ok: false, error: "no html" };
  const titleWrap = document.querySelector(".title-editor__input");
  const body = [...document.querySelectorAll(".ProseMirror")].find((el) => {
    if (titleWrap && (titleWrap === el || titleWrap.contains(el) || el.closest?.(".title-editor__input"))) {
      return false;
    }
    return true;
  });
  if (!body) return { ok: false, error: "body not found" };
  body.focus();
  document.execCommand?.("selectAll", false);
  document.execCommand?.("delete", false);
  const ok = Boolean(document.execCommand?.("insertHTML", false, html));
  return { ok, method: "insertHTML", length: String(body.innerText || "").trim().length };
}

async function resolveHtml(job) {
  let html = String(job.html || "");
  let text = String(job.text || "");
  if (job.htmlFile) {
    const raw = String(job.htmlFile).trim();
    const norm = raw.replace(/\\/g, "/");
    const slash = norm.lastIndexOf("/");
    const dir = slash >= 0 ? norm.slice(0, slash) : ".";
    const base = slash >= 0 ? norm.slice(slash + 1) : norm;
    const res = await nativeFs({ action: "readText", root: dir || ".", rel: base });
    if (!res?.ok) throw new Error(res?.error || `htmlFile read failed: ${raw}`);
    if (res.truncated) throw new Error(`htmlFile truncated: ${raw}`);
    html = res.text;
  }
  return { html, text };
}

async function runClipboardWrite(job) {
  const { html, text } = await resolveHtml(job);
  const clip = await writeClipboardFromSw({ text, html, image: job.image || "" });
  return { ok: true, method: "clipboard_write", clipboard: clip };
}

async function runPasteHtml(job, tab, { html, text }, settings) {
  const preferTrusted = job.preferTrustedPaste !== false;
  const allowInsert = job.allowInsertHtmlFallback === true;
  const methods = [];

  await writeClipboardFromSw({ text, html });
  methods.push("clipboard_write");

  const selector = job.selector ? String(job.selector) : "";
  if (selector) {
    await inject(tab.id, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false };
      el.focus?.();
      return { ok: true };
    }, [selector]);
  }

  let used = null;
  if (preferTrusted && settings.cdpInput !== false) {
    try {
      const combo = await pasteKeyCombo();
      await pressKeys(tab.id, [combo]);
      await sleep(400);
      used = "trusted_paste";
      methods.push(used);
      return { ok: true, method: used, methods, tabId: tab.id, tabUrl: tab.url };
    } catch (err) {
      methods.push(`trusted_paste_failed:${err?.message || err}`);
    }
  }

  const pasteRes = await injectMain(tab.id, pasteIntoPage, [
    { selector: selector || undefined, text, html, replace: job.replace === true },
  ]);
  const method = pasteRes?.method || "unknown";
  methods.push(method);
  if (!pasteRes?.ok) {
    return { ok: false, error: pasteRes?.error || "paste failed", methods, tabId: tab.id };
  }
  if (method === "insertHTML" && !allowInsert) {
    return {
      ok: false,
      error: "paste fell back to insertHTML only; set allowInsertHtmlFallback:true to accept",
      method,
      methods,
      tabId: tab.id,
      failCriteria: "insertHTML_only",
    };
  }
  return { ok: true, method, methods, paste: pasteRes, tabId: tab.id, tabUrl: tab.url };
}

async function runWechatFillDraft(job, tab, { html, text }, settings) {
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await sleep(300);

  const title = String(job.title || "").trim();

  const titleRes = await inject(tab.id, setNativeValueFn, [{ selector: "#title", value: title }]);
  if (!titleRes?.ok) throw new Error(titleRes?.error || "failed to set #title");

  const pick = await inject(tab.id, wechatPickAndFocusBody);
  if (!pick?.ok) throw new Error(pick?.error || "failed to focus WeChat body");

  await writeClipboardFromSw({ text: text || "", html });
  const methods = ["clipboard_write", "title_native_setter", "focus_body"];
  const allowInsert = job.allowInsertHtmlFallback === true;
  const preferTrusted = job.preferTrustedPaste !== false;
  const minBody = Number(job.minBodyLength) || 500;

  // Trusted click on body center before paste (helps editors that ignore focus-only).
  try {
    const point = await inject(tab.id, () => {
      const titleWrap = document.querySelector(".title-editor__input");
      const body = [...document.querySelectorAll(".ProseMirror")].find((el) => {
        if (titleWrap && (titleWrap === el || titleWrap.contains(el) || el.closest?.(".title-editor__input"))) {
          return false;
        }
        return true;
      });
      if (!body) return null;
      const r = body.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(80, r.height / 3)) };
    });
    if (point && settings.cdpInput !== false) {
      await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
      await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      methods.push("cdp_click_body");
    }
  } catch (err) {
    methods.push(`cdp_click_failed:${err?.message || err}`);
  }

  let method = null;
  if (preferTrusted && settings.cdpInput !== false) {
    try {
      const combo = await pasteKeyCombo();
      await pressKeys(tab.id, [combo]);
      await sleep(900);
      methods.push("trusted_paste");
      const v1 = await inject(tab.id, wechatVerify, [{ title, minBodyLength: minBody }]);
      if (v1?.ok) {
        method = "trusted_paste";
        return {
          ok: true,
          method,
          methods,
          verify: v1,
          titleSet: titleRes,
          tabId: tab.id,
          tabUrl: tab.url,
          note: "did not click 发表",
        };
      }
      methods.push(`trusted_paste_verify_failed:body=${v1?.bodyLength ?? "?"}`);
    } catch (err) {
      methods.push(`trusted_paste_failed:${err?.message || err}`);
    }
  }

  // paste-event path (ProseMirror often handles this)
  await inject(tab.id, wechatPickAndFocusBody);
  const pasteRes = await injectMain(tab.id, pasteIntoPage, [{ text, html, replace: true }]);
  methods.push(pasteRes?.method || "paste_unknown");
  if (pasteRes?.ok && pasteRes.method && pasteRes.method !== "insertHTML") {
    const v2 = await inject(tab.id, wechatVerify, [{ title, minBodyLength: minBody }]);
    if (v2?.ok) {
      return {
        ok: true,
        method: pasteRes.method,
        methods,
        verify: v2,
        titleSet: titleRes,
        tabId: tab.id,
        tabUrl: tab.url,
        note: "did not click 发表",
      };
    }
    methods.push(`paste_event_verify_failed:body=${v2?.bodyLength ?? "?"}`);
  }

  if (allowInsert) {
    const ins = await inject(tab.id, wechatInsertHtml, [{ html }]);
    methods.push(ins?.method || "insertHTML");
    const v3 = await inject(tab.id, wechatVerify, [{ title, minBodyLength: minBody }]);
    return {
      ok: Boolean(v3?.ok),
      method: "insertHTML",
      methods,
      verify: v3,
      titleSet: titleRes,
      tabId: tab.id,
      tabUrl: tab.url,
      note: "did not click 发表; insertHTML fallback allowed by job",
      error: v3?.ok ? undefined : "verify failed after insertHTML fallback",
    };
  }

  const verify = await inject(tab.id, wechatVerify, [{ title, minBodyLength: minBody }]);
  return {
    ok: false,
    method: method || pasteRes?.method || "none",
    methods,
    verify: verify,
    titleSet: titleRes,
    tabId: tab.id,
    tabUrl: tab.url,
    note: "did not click 发表",
    failCriteria: "trusted_paste_unavailable",
    error:
      "WeChat body did not accept trusted paste / paste-event; insertHTML works but allowInsertHtmlFallback is false",
  };
}

async function pickCoseTab(job, origins) {
  if (job.tabUrlIncludes) return findTab({ tabUrlIncludes: job.tabUrlIncludes, requireHttps: true }, origins);
  const tabs = await chrome.tabs.query({});
  const allowed = tabs.filter((t) => {
    const url = String(t.url || "");
    return /^https:\/\//i.test(url) && !restrictedUrl(url) && isUrlAllowed(url, origins);
  });
  for (const candidate of allowed) {
    try {
      const probe = await injectMain(candidate.id, () => Boolean(globalThis.$cose && typeof globalThis.$cose.addTask === "function"));
      if (probe) return candidate;
    } catch {
      /* try next */
    }
  }
  if (!allowed.length) throw new Error("cose_publish 需要一个白名单 origin 内、带 $cose 的 https 标签");
  return allowed[0];
}

async function resolveMarkdown(job) {
  let markdown = String(job.markdown || job.content || "");
  if (!markdown && job.markdownFile) {
    const raw = String(job.markdownFile).trim().replace(/\\/g, "/");
    const slash = raw.lastIndexOf("/");
    const dir = slash >= 0 ? raw.slice(0, slash) : ".";
    const base = slash >= 0 ? raw.slice(slash + 1) : raw;
    const file = await nativeFs({ action: "readText", root: dir || ".", rel: base });
    if (!file?.ok) throw new Error(file?.error || `markdownFile read failed: ${raw}`);
    if (file.truncated) throw new Error(`markdownFile truncated: ${raw}`);
    markdown = file.text;
  }
  return markdown;
}

async function runCosePublish(job, tab, markdown) {
  const res = await injectMain(tab.id, cosePublish, [
    {
      title: job.title,
      markdown,
      platforms: job.platforms || ["wechat"],
      desc: job.desc,
    },
  ]);
  return {
    ok: Boolean(res?.ok),
    cose: res,
    tabId: tab.id,
    tabUrl: tab.url,
    method: "cose_publish",
    platforms: job.platforms || ["wechat"],
    title: job.title,
    markdownChars: markdown.length,
    error: res?.error,
  };
}

/** 选标签（白名单内）并读出正文；只做准备，不改动页面。 */
async function preparePageAction(action, job, origins) {
  if (action === "paste_html") {
    const tab = await findTab({ tabUrlIncludes: job.tabUrlIncludes }, origins);
    return { tab, content: await resolveHtml(job) };
  }
  if (action === "wechat_fill_draft") {
    const tab = await findTab({ tabUrlIncludes: job.tabUrlIncludes || "mp.weixin.qq.com", preferType77: true }, origins);
    if (!String(job.title || "").trim()) throw new Error("wechat_fill_draft requires title");
    const content = await resolveHtml(job);
    if (!content.html && !content.text) throw new Error("wechat_fill_draft requires html or text");
    return { tab, content };
  }
  const tab = await pickCoseTab(job, origins);
  const markdown = await resolveMarkdown(job);
  if (!String(job.title || "").trim() || !markdown.trim()) {
    throw new Error("cose_publish requires title and markdown");
  }
  return { tab, content: { markdown } };
}

let sharedApprovals = null;
function defaultApprovals() {
  sharedApprovals ||= createApprovalQueue({ storage: chromeStorageAdapter() });
  return sharedApprovals;
}

/** 批准匹配用的“参数”：job 正文去掉 id / token，重投同一 job（新 id）即可消费批准 */
function jobApprovalArgs(job) {
  const { id: _id, token: _token, ...rest } = job || {};
  return rest;
}

async function defaultConfirm(summary) {
  const broker = getInboxConfirm();
  if (!broker) return { approved: false, reason: "确认通道不可用" };
  return broker.request(summary);
}

async function authorizeJobToken(job, action, loadTokens, now) {
  let record;
  try {
    record = await verifyToken(await loadTokens(), job.token, now());
  } catch (err) {
    return { error: { ok: false, code: err?.code || "UNAUTHORIZED", error: err?.message || String(err), failCriteria: "unauthorized" } };
  }
  const missing = missingScopes(record, action);
  if (missing.length) {
    return {
      error: {
        ok: false,
        code: "SCOPE_DENIED",
        error: `token「${record.name}」缺少 ${missing.join("、")} 权限，不能执行 ${action}`,
        failCriteria: "scope_denied",
      },
    };
  }
  return { record };
}

async function runPageAction(action, job, tab, content, s) {
  if (action === "paste_html") {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    return runPasteHtml(job, tab, content, s);
  }
  if (action === "wechat_fill_draft") return runWechatFillDraft(job, tab, content, s);
  return runCosePublish(job, tab, content.markdown);
}

/**
 * 无 token 的页面动作：agentBridgeOrigins 白名单 + 每次弹窗确认。
 * 带有效 token 且 scope 覆盖的：用 token 的 origin 范围挑标签，不弹窗，写持久审计；
 * 命中不可逆清单（如 cose_publish）且 token 未免清单 → 进待批准队列，返回 CONFIRMATION_REQUIRED + pendingId。
 */
export async function executeJob(
  job,
  {
    confirm = defaultConfirm,
    settings = null,
    loadTokens = loadAgentTokens,
    now = () => Date.now(),
    auditLog = getAuditLog(),
    approvals = null,
  } = {},
) {
  const action = String(job?.action || "").trim();
  let auth = null;
  if (job?.token != null && action !== "bridge_call") {
    const res = await authorizeJobToken(job, action, loadTokens, now);
    if (res.error) return res.error;
    auth = res.record;
  }
  if (action === "clipboard_write") return runClipboardWrite(job);
  if (needsConfirmation(action)) {
    const s = settings || (await loadSettings());
    const { tab, content } = await preparePageAction(action, job, auth ? auth.origins : s.agentBridgeOrigins);
    if (!auth) {
      const decision = await confirm(confirmSummary(job, tab, content));
      if (decision?.approved !== true) {
        return {
          ok: false,
          error: `用户未确认（${decision?.reason || "rejected"}）`,
          failCriteria: "not_confirmed",
          tabId: tab.id,
          tabUrl: tab.url,
        };
      }
      return runPageAction(action, job, tab, content, s);
    }
    const started = now();
    let result;
    let trust = null;
    try {
      trust = await enforceTokenGuards(`inbox.${action}`, jobApprovalArgs(job), {
        record: auth,
        settings: s,
        targetUrl: tab.url,
        approvals: approvals || defaultApprovals(),
        sessionId: `inbox:${String(job.id || "")}`,
      });
    } catch (err) {
      result = {
        ok: false,
        code: err?.code || "ERROR",
        error: err?.message || String(err),
        failCriteria: String(err?.code || "error").toLowerCase(),
        ...(err?.details?.pendingId ? { pendingId: err.details.pendingId } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
        tabId: tab.id,
        tabUrl: tab.url,
      };
    }
    try {
      if (!result) result = await runPageAction(action, job, tab, content, s);
      return result;
    } finally {
      auditLog
        ?.append(
          auditEntry({
            ts: started,
            agent: auth.name,
            agentId: auth.id,
            sessionId: `inbox:${String(job.id || "")}`,
            tool: `inbox.${action}`,
            origin: originOfUrl(tab.url),
            args: { tabId: tab.id, title: job.title, html: job.html, text: job.text, markdown: job.markdown },
            ok: result?.ok === true,
            code: result?.ok === true ? null : result?.code || (result ? "TOOL_FAILED" : "ERROR"),
            ms: now() - started,
            ...trust,
          }),
        )
        .catch(() => {});
    }
  }
  if (action === "agent_cancel") {
    const { result, output } = await cancelAgentPrompt(job.targetId);
    if (output) await writeAgentPromptOutput(output);
    return result;
  }
  if (action === "bridge_call") {
    const bridge = getBridge();
    if (!bridge) return { ok: false, error: "bridge 未安装" };
    const session =
      job?.token != null ? { token: String(job.token), sessionId: `inbox:${String(job.id || "")}`, agentName: "inbox" } : undefined;
    const res = await bridge.call({ id: String(job.id || `inbox-${Date.now()}`), ...(job.request || {}) }, { session });
    return { ...res, ok: res.ok === true };
  }
  return { ok: false, error: `unknown action: ${action || "(empty)"}` };
}

let polling = false;

async function claimJob(jobName, job) {
  await writeJson(INBOX_ROOT, `${PROCESSED_REL}/${jobName}`, redactJobToken(job));
  await deleteRel(INBOX_ROOT, jobName).catch(() => {});
}

async function writeAgentPromptOutput(out) {
  await writeJson(OUTBOX_ROOT, `${out.id}.json`, out);
  await recordJobFinished(
    { id: out.id, action: "agent_prompt" },
    out,
    Date.now() - (out.meta?.ms || 0),
  );
}

/** Returns the finished outbox payload, or null when the job started (async) or stays queued. */
async function dispatchAgentPrompt(jobName, job) {
  const jobId = String(job.id || jobName.replace(/\.json$/i, ""));
  let started;
  try {
    if (job?.token != null) {
      const auth = await authorizeJobToken(job, "agent_prompt", loadAgentTokens, () => Date.now());
      if (auth.error) {
        started = {
          done: {
            ok: false,
            errorCode: auth.error.code || "UNAUTHORIZED",
            error: auth.error.error || "unauthorized",
          },
        };
      }
    }
    if (!started) started = await startAgentPrompt(job, jobId);
  } catch (err) {
    started = { done: { ok: false, errorCode: "DISPATCH_FAILED", error: err?.message || String(err) } };
  }
  if (started.queued) return null;
  if (started.started) {
    markJobStarted();
    await claimJob(jobName, job);
    return null;
  }
  const out = {
    id: jobId,
    ...started.done,
    finishedAt: new Date().toISOString(),
    action: "agent_prompt",
    metadata: job.metadata ?? null,
    meta: { action: "agent_prompt", ms: 0 },
  };
  await claimJob(jobName, job);
  await writeAgentPromptOutput(out);
  return out;
}

/** Called when the side panel reports that an agent_prompt run finished. */
export async function completeAgentPrompt(msg) {
  const out = await takeCompletion(msg);
  if (!out) return { ok: false, error: "no matching active run" };
  await writeAgentPromptOutput(out);
  return { ok: true };
}

async function expireAgentPrompt() {
  if (!chrome.storage?.session) return;
  const out = await takeExpired();
  if (out) await writeAgentPromptOutput(out);
}

/**
 * 每轮只调一次 Native Host（readdir）；目录在首次成功后不再重复创建。
 * Host 不可用时指数退避（1 分钟起、最长 30 分钟），期间轮询直接跳过、不拉起进程。
 */
export async function pollAgentInboxOnce(deps = {}) {
  if (polling) return { skipped: true, reason: "busy" };
  polling = true;
  try {
    await expireAgentPrompt();
    const settings = await loadSettings();
    if (settings.agentInboxEnabled !== true) return { skipped: true, reason: "disabled" };
    if (!gate.canPoll()) return { skipped: true, reason: "backoff", retryInMs: gate.retryInMs() };

    let names;
    try {
      await ensureDirs();
      names = await listInboxJobs();
      gate.onSuccess();
    } catch (err) {
      gate.onFailure();
      return {
        ok: false,
        error: err?.message || String(err),
        retryInMs: gate.retryInMs(),
        hint: "node native/install-native-host.mjs --extension-id <id>",
      };
    }

    const results = [];
    for (const name of names) {
      let job;
      try {
        job = await readJson(INBOX_ROOT, name);
      } catch (err) {
        await finishJob(name, { id: name.replace(/\.json$/i, "") }, {
          ok: false,
          error: `invalid job json: ${err?.message || err}`,
        }).catch(() => {});
        continue;
      }
      if (job?.action === "agent_prompt") {
        const outcome = await dispatchAgentPrompt(name, job);
        if (outcome) results.push(outcome);
        continue;
      }
      const startedAt = Date.now();
      markJobStarted();
      let result;
      try {
        result = await executeJob(job, { ...deps, settings });
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      }
      await recordJobFinished(job, result, startedAt);
      results.push(await finishJob(name, job, result));
    }
    return { ok: true, processed: results.length, results };
  } finally {
    polling = false;
  }
}

export async function isPackagedInstall() {
  try {
    const self = await chrome.management?.getSelf?.();
    if (self?.installType) return self.installType !== "development";
  } catch {
    /* fall back to manifest */
  }
  return Boolean(chrome.runtime.getManifest?.()?.update_url);
}

/** 关闭时清掉 alarm（零进程）；开启时按安装方式设周期：打包 30s，解包 6s。 */
export async function syncAgentInboxAlarm() {
  const settings = await loadSettings();
  const existing = await chrome.alarms.get(ALARM_NAME).catch(() => null);
  if (settings.agentInboxEnabled !== true) {
    if (existing) await chrome.alarms.clear(ALARM_NAME);
    gate.reset();
    return { enabled: false };
  }
  const periodInMinutes = pollMinutesFor({ packaged: await isPackagedInstall() });
  if (existing?.periodInMinutes !== periodInMinutes) {
    if (existing) await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes });
  }
  return { enabled: true, periodInMinutes, created: !existing };
}

export function wireAgentInboxAlarm() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== ALARM_NAME) return;
    pollAgentInboxOnce().catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    syncAgentInboxAlarm()
      .then((res) => (res.created ? pollAgentInboxOnce() : null))
      .catch(() => {});
  });
}

