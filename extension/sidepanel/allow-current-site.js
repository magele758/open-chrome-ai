import { isUrlAllowed, isValidOriginPattern } from "../lib/bridge/policy.js";
import { restrictedUrl } from "../lib/chrome.js";
import { modifySettings } from "../lib/storage.js";

function currentOrigin(tab) {
  if (!tab?.active || !/^https?:\/\//i.test(tab.url) || restrictedUrl(tab.url)) return "";
  const origin = new URL(tab.url).origin;
  return !origin.includes("*") && isValidOriginPattern(origin) ? origin : "";
}

export function renderAllowCurrentSite(button, tab, settings) {
  const origin = currentOrigin(tab);
  const show = origin && settings?.agentBridgeEnabled && !isUrlAllowed(origin, settings.agentBridgeOrigins);
  button.hidden = !show;
  button.dataset.origin = show ? origin : "";
  if (show) button.textContent = `允许外部 Agent 操作 ${origin}（加入白名单）`;
}

export async function allowCurrentSite(origin, windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!origin || currentOrigin(tab) !== origin) throw new Error("当前网站已切换，请在目标网页重新点击。");
  return modifySettings(async (latest) => {
    if (!latest.agentBridgeEnabled) throw new Error("外部 Agent 控制已关闭。");
    if (isUrlAllowed(origin, latest.agentBridgeOrigins)) return null;
    return { ...latest, agentBridgeOrigins: [...latest.agentBridgeOrigins, origin] };
  });
}
