/**
 * External-agent file inbox: poll ~/.pagelens/agent-inbox/*.json via Native Host,
 * execute actions (clipboard / trusted paste / WeChat draft / COSE), write outbox.
 * Zero new daemon — external agents drop jobs; the service worker picks them up.
 */

import { nativeFs, nativeSend, pingNativeHost } from "../native-host.js";
import { getCdp } from "../cdp.js";
import { keyEvents } from "../cdp-input.js";
import { inject, injectMain } from "../chrome.js";
import { pasteIntoPage } from "./page-fns.js";
import { cosePublish } from "./companions.js";
import { loadSettings } from "../storage.js";
import { getBridge } from "../bridge/index.js";

export const INBOX_ROOT = "~/.pagelens/agent-inbox";
export const OUTBOX_ROOT = "~/.pagelens/agent-outbox";
export const PROCESSED_REL = "processed";
export const ALARM_NAME = "pagelens-agent-inbox";
export const POLL_MINUTES = 0.1; // ~6s (Chrome alarms minimum practical slice)

const cdp = getCdp();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDirs() {
  for (const path of [INBOX_ROOT, OUTBOX_ROOT, `${INBOX_ROOT}/${PROCESSED_REL}`]) {
    const res = await nativeFs({ action: "ensureDir", path });
    if (!res?.ok) throw new Error(res?.error || `ensureDir failed: ${path}`);
  }
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
  await writeJson(INBOX_ROOT, `${PROCESSED_REL}/${jobName}`, job);
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

  const hasDoc = await chrome.offscreen?.hasDocument?.().catch(() => false);
  if (hasDoc) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* ignore */
    }
  }
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

async function findTab(job) {
  const needle = String(job.tabUrlIncludes || "").trim();
  const tabs = await chrome.tabs.query({});
  const match = (t) => {
    const url = String(t.url || "");
    if (needle && !url.includes(needle)) return false;
    if (job.tabUrlIncludesType77 && !/[?&]type=77\b/.test(url)) return false;
    return true;
  };
  let candidates = tabs.filter(match);
  if (job.preferType77) {
    const typed = candidates.filter((t) => /[?&]type=77\b/.test(String(t.url || "")));
    if (typed.length) candidates = typed;
  }
  // Prefer most recently accessed / highest id among matches
  candidates.sort((a, b) => (b.id || 0) - (a.id || 0));
  if (!candidates.length) {
    throw new Error(
      needle
        ? `no tab matching url includes "${needle}"`
        : "no tabUrlIncludes provided and no matching tab",
    );
  }
  return candidates[0];
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

async function runPasteHtml(job, tab) {
  const preferTrusted = job.preferTrustedPaste !== false;
  const allowInsert = job.allowInsertHtmlFallback === true;
  const { html, text } = await resolveHtml(job);
  const settings = await loadSettings();
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

async function runWechatFillDraft(job) {
  const tab = await findTab({
    ...job,
    tabUrlIncludes: job.tabUrlIncludes || "mp.weixin.qq.com",
    preferType77: true,
  });
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await sleep(300);

  const title = String(job.title || "").trim();
  if (!title) throw new Error("wechat_fill_draft requires title");
  const { html, text } = await resolveHtml(job);
  if (!html && !text) throw new Error("wechat_fill_draft requires html or text");

  const titleRes = await inject(tab.id, setNativeValueFn, [{ selector: "#title", value: title }]);
  if (!titleRes?.ok) throw new Error(titleRes?.error || "failed to set #title");

  const pick = await inject(tab.id, wechatPickAndFocusBody);
  if (!pick?.ok) throw new Error(pick?.error || "failed to focus WeChat body");

  await writeClipboardFromSw({ text: text || "", html });
  const methods = ["clipboard_write", "title_native_setter", "focus_body"];
  const settings = await loadSettings();
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

async function runCosePublish(job) {
  const tabs = await chrome.tabs.query({});
  const httpsTabs = tabs.filter((t) => /^https:\/\//i.test(String(t.url || "")));
  let tab = null;
  if (job.tabUrlIncludes) {
    tab = httpsTabs.find((t) => String(t.url || "").includes(String(job.tabUrlIncludes)));
  }
  // Prefer a tab where window.$cose is already present
  if (!tab) {
    for (const candidate of httpsTabs) {
      try {
        const probe = await injectMain(candidate.id, () => Boolean(globalThis.$cose && typeof globalThis.$cose.addTask === "function"));
        if (probe) {
          tab = candidate;
          break;
        }
      } catch {
        /* try next */
      }
    }
  }
  if (!tab) tab = httpsTabs[0];
  if (!tab) throw new Error("cose_publish needs an https tab with $cose");

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
  if (!String(job.title || "").trim() || !markdown.trim()) {
    throw new Error("cose_publish requires title and markdown");
  }

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

export async function executeJob(job) {
  const action = String(job?.action || "").trim();
  if (action === "clipboard_write") return runClipboardWrite(job);
  if (action === "paste_html") {
    const tab = await findTab(job);
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    return runPasteHtml(job, tab);
  }
  if (action === "wechat_fill_draft") return runWechatFillDraft(job);
  if (action === "cose_publish") return runCosePublish(job);
  if (action === "bridge_call") {
    const bridge = getBridge();
    if (!bridge) return { ok: false, error: "bridge 未安装" };
    const res = await bridge.call({ id: String(job.id || `inbox-${Date.now()}`), ...(job.request || {}) });
    return { ...res, ok: res.ok === true };
  }
  return { ok: false, error: `unknown action: ${action || "(empty)"}` };
}

let polling = false;

export async function pollAgentInboxOnce() {
  if (polling) return { skipped: true, reason: "busy" };
  polling = true;
  try {
    const settings = await loadSettings();
    if (settings.agentInboxEnabled === false) return { skipped: true, reason: "disabled" };

    const ping = await pingNativeHost();
    if (!ping?.ok) {
      return {
        ok: false,
        error: ping?.error || "Native Host not available",
        hint: "node native/install-native-host.mjs --extension-id <id>",
      };
    }

    await ensureDirs();
    const names = await listInboxJobs();
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
      try {
        const result = await executeJob(job);
        results.push(await finishJob(name, job, result));
      } catch (err) {
        results.push(
          await finishJob(name, job, { ok: false, error: err?.message || String(err) }),
        );
      }
    }
    return { ok: true, processed: results.length, results };
  } finally {
    polling = false;
  }
}

export async function setupAgentInboxAlarm() {
  try {
    await chrome.alarms.clear(ALARM_NAME);
  } catch {
    /* ignore */
  }
  // periodInMinutes: Chrome accepts fractional values (>= ~0.05 in practice → ~3–6s)
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
}

export function wireAgentInboxAlarm() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== ALARM_NAME) return;
    pollAgentInboxOnce().catch(() => {});
  });
}
