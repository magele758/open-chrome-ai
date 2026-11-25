import { shortcutsForPage } from "../flows/workflow-context.js";
import { requireOptionalFeature } from "../lib/optional-permissions.js";
import { $ } from "./dom.js";
import { launchWorkflowFeature } from "./workflow-catalog.js";

const IDENTIFY_TAB = "identify-tab";

export function renderWorkflowShortcuts(tab) {
  const root = $("workflow-shortcuts");
  if (!root) return;
  const { platform, page, features } = shortcutsForPage(tab?.url);
  const canIdentify = Number.isInteger(tab?.id) && !tab.url &&
    chrome.runtime.getManifest?.().optional_permissions?.includes("tabs");
  const visible = features.length > 0 || canIdentify;
  const key = canIdentify ? `${tab.id}:${IDENTIFY_TAB}` : visible
    ? `${tab.id}:${page.platform}:${page.productId || page.surface}:${features.map(item => item.id).join(",")}` : "";
  if (root.dataset.target === key) return;
  root.dataset.target = key;
  root.hidden = !visible;
  $("workflow-shortcut-status").textContent = "";
  const items = $("workflow-shortcut-items");
  items.replaceChildren();
  if (!visible) return;
  const name = $("workflow-shortcut-site");
  name.hidden = canIdentify;
  name.textContent = platform?.name || "";
  name.title = platform ? `${platform.name} ${page.surface === "seller" ? "商家后台" : "商品详情"}` : "";
  const shortcuts = canIdentify ? [{ id: IDENTIFY_TAB, name: "开启当前网页识别" }] : features;
  for (const feature of shortcuts) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.workflow = feature.id;
    button.textContent = feature.name;
    items.append(button);
  }
}

export function bindWorkflowShortcuts({ getTargetTab, handlers, onTabAccess }) {
  const root = $("workflow-shortcuts");
  const status = $("workflow-shortcut-status");
  let busy = false;
  root?.addEventListener("click", async event => {
    const button = event.target.closest("button[data-workflow]");
    if (!button || busy) return;
    busy = true;
    status.textContent = "";
    const target = root.dataset.target;
    try {
      if (button.dataset.workflow === IDENTIFY_TAB) {
        const denied = await requireOptionalFeature("tabs", { userGesture: true });
        if (denied) throw new Error(denied);
        await onTabAccess();
        return;
      }
      const tab = await getTargetTab();
      renderWorkflowShortcuts(tab);
      const { platform, features } = shortcutsForPage(tab?.url);
      const feature = features.find(item => item.id === button.dataset.workflow);
      if (root.dataset.target !== target || !feature) throw new Error("当前页面已切换，请从新的快捷入口打开。");
      await launchWorkflowFeature(feature, platform.id, handlers);
    } catch (error) {
      if (root.dataset.target === target) status.textContent = error?.message || "暂时无法打开此工作流。";
    } finally {
      busy = false;
    }
  });
}
