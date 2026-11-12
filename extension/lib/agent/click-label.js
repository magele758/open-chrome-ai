/**
 * 点击类工具在做不可逆判断前，解析目标控件的可见文字。
 * 按编号来自快照；只有 CSS 选择器时注入 locateElement({ labelOnly })，纯坐标时注入 locatePointLabel，不滚动、不点击。
 */

import { locateElement } from "./page-snapshot.js";

const CLICK_TOOLS = new Set(["click", "trusted_click", "act_element"]);

/** 自包含只读函数：按视口坐标读取命中控件文案（穿透 shadowRoot，不滚动、不点击）。 */
export function locatePointLabel(pt) {
  const x = Number(pt?.x);
  const y = Number(pt?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, text: "" };
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === "function") {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || hit.nodeType !== 1 || hit === document.body || hit === document.documentElement) {
    return { ok: false, text: "" };
  }
  const matchedControl = hit.closest?.(
    "button, a, [role='button'], label, [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='treeitem'], [role='tab'], input, summary",
  );
  const el = matchedControl || hit;
  const bits = [];
  const aria = el.getAttribute?.("aria-label");
  const title = el.getAttribute?.("title");
  const alt = el.getAttribute?.("alt");
  if (aria) bits.push(aria);
  if (title) bits.push(title);
  if (alt) bits.push(alt);
  if (
    el.tagName === "INPUT" &&
    ["button", "submit", "reset", "image"].includes(String(el.type || "").toLowerCase()) &&
    el.value
  ) {
    bits.push(el.value);
  } else if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
    if (matchedControl || !el.querySelector?.("button, a, input, select, textarea, table")) {
      const text = el.innerText ?? el.textContent ?? "";
      if (text) bits.push(text);
    }
  }
  return { ok: true, tag: el.tagName.toLowerCase(), text: clean(bits.join(" ")).slice(0, 200) };
}

export async function readSelectorLabel(tabId, spec, { inject, injectFrames } = {}) {
  if (!spec?.selector || typeof inject !== "function") return "";
  const target = {
    selector: spec.selector,
    ...(typeof spec.text === "string" && spec.text.trim() ? { text: spec.text } : {}),
    nth: spec.nth,
    labelOnly: true,
  };
  let hit;
  try {
    hit = await inject(tabId, locateElement, [target]);
  } catch {
    return "";
  }
  if (!hit?.ok && hit?.notFound && typeof injectFrames === "function") {
    try {
      const frames = await injectFrames(tabId, locateElement, [target]);
      const found = (frames || []).find((frame) => frame.frameId > 0 && frame.result?.ok);
      if (found) hit = found.result;
    } catch {
      /* 顶层没命中且 iframe 探测失败时，当没有文案 */
    }
  }
  return String(hit?.text || "").trim();
}

export async function readPointLabel(tabId, pt, { inject } = {}) {
  const x = Number(pt?.x);
  const y = Number(pt?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || typeof inject !== "function") return "";
  try {
    const hit = await inject(tabId, locatePointLabel, [{ x, y }]);
    return String(hit?.text || "").trim();
  } catch {
    return "";
  }
}

/**
 * 给 matchIrreversible / decideToolCall 的 elementText。
 * args.text 已经由清单自己读取，这里不再重复。
 */
export async function resolveClickElementText({ toolName, args = {}, tabId, refLabel, inject, injectFrames } = {}) {
  if (!CLICK_TOOLS.has(toolName)) return "";
  if (toolName === "act_element" && String(args.action || "") !== "click") return "";
  const index = args.index ?? args.ref;
  if (index != null && typeof refLabel === "function") {
    const label = String(refLabel(tabId, index) || "").trim();
    if (label) return label;
  }
  if (args.selector) {
    if (!tabId) return "";
    return readSelectorLabel(tabId, args, { inject, injectFrames });
  }
  if (typeof args.text === "string" && args.text.trim()) return "";
  if (
    args.x != null &&
    args.y != null &&
    args.x !== "" &&
    args.y !== "" &&
    Number.isFinite(Number(args.x)) &&
    Number.isFinite(Number(args.y)) &&
    tabId
  ) {
    return readPointLabel(tabId, { x: Number(args.x), y: Number(args.y) }, { inject });
  }
  return "";
}
