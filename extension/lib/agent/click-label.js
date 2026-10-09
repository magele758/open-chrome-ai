/**
 * 点击类工具在做不可逆判断前，解析目标控件的可见文字。
 * 按编号来自快照；只有 CSS 选择器时注入 locateElement({ labelOnly })，不滚动、不点击。
 */

import { locateElement } from "./page-snapshot.js";

const CLICK_TOOLS = new Set(["click", "trusted_click", "act_element"]);

export async function readSelectorLabel(tabId, spec, { inject, injectFrames } = {}) {
  if (!spec?.selector || typeof inject !== "function") return "";
  const target = { selector: spec.selector, nth: spec.nth, labelOnly: true };
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
  if (typeof args.text === "string" && args.text.trim()) return "";
  if (!args.selector || !tabId) return "";
  return readSelectorLabel(tabId, args, { inject, injectFrames });
}
