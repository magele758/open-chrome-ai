import { workflowPlatforms } from "../flows/catalog.js";
import { $ } from "./dom.js";

const PLATFORM_PREFERENCE = "pagelens.workflowPlatformId";

export async function launchWorkflowFeature(feature, platform, handlers) {
  const launch = {
    "product-listing": handlers.openProductListing,
    "shein-product-listing": handlers.openSheinListing,
    "temu-product-listing": handlers.openTemuListing,
    "product-capture": handlers.openProductCapture,
    "tiktok-mx-draft": handlers.openTiktokDraft,
  };
  const opened = Object.hasOwn(launch, feature.id)
    ? await launch[feature.id]?.(feature, platform)
    : platform === "temu" ? await handlers.openTemuOperations({ mode: feature.id })
    : await handlers.openMarketing({ mode: feature.id, force: true });
  if (!opened) throw new Error("暂时无法打开此工作流。");
}

export function bindWorkflowCatalog(handlers) {
  const entry = $("btn-ptc-flow");
  const dialog = $("workflow-catalog-dialog");
  const platform = $("workflow-platform");
  const list = $("workflow-feature-list");
  const empty = $("workflow-feature-empty");
  const close = $("workflow-catalog-close");
  const library = $("workflow-catalog-library");
  const status = $("workflow-catalog-status");
  const buttons = new Map();
  let current = workflowPlatforms[0];
  let opening = false;

  function open() {
    if (dialog.open) return;
    restorePlatform();
    dialog.showModal();
    buttons.get(current.id).focus({ preventScroll: true });
  }

  async function choose(feature) {
    if (opening) return;
    opening = true;
    dialog.close();
    try {
      await launchWorkflowFeature(feature, current.id, handlers);
    } catch (error) {
      open();
      status.textContent = error?.message || "暂时无法打开此工作流。";
    } finally {
      opening = false;
    }
  }

  function renderFeatures() {
    const { features } = current;
    list.replaceChildren(...features.map(feature => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workflow-feature";
      button.dataset.workflow = feature.id;
      const name = document.createElement("strong");
      name.id = `workflow-name-${current.id}-${feature.id}`;
      name.textContent = feature.name;
      const description = document.createElement("span");
      description.id = `${name.id}-description`;
      description.textContent = feature.description;
      button.setAttribute("aria-labelledby", name.id);
      button.setAttribute("aria-describedby", description.id);
      button.append(name, description);
      button.addEventListener("click", () => void choose(feature));
      row.append(button);
      return row;
    }));
    empty.hidden = Boolean(features.length);
    empty.textContent = features.length ? "" : `${current.name} 暂无可执行的工作流。`;
    status.textContent = "";
  }

  function selectPlatform(item) {
    current = item;
    for (const [id, button] of buttons) {
      button.setAttribute("aria-pressed", String(id === current.id));
    }
    renderFeatures();
  }

  function restorePlatform() {
    try {
      const saved = document.defaultView.localStorage.getItem(PLATFORM_PREFERENCE);
      current = workflowPlatforms.find(item => item.id === saved) ?? workflowPlatforms[0];
    } catch { /* 页面存储不可用时沿用当前侧栏的选择。 */ }
    selectPlatform(current);
  }

  for (const item of workflowPlatforms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-platform-chip";
    button.dataset.platform = item.id;
    const icon = document.createElement("img");
    icon.src = `../flows/icons/${item.icon}`;
    icon.alt = "";
    icon.width = icon.height = 16;
    button.append(icon, item.name);
    button.addEventListener("click", () => {
      selectPlatform(item);
      try {
        document.defaultView.localStorage.setItem(PLATFORM_PREFERENCE, item.id);
      } catch { /* 页面存储不可用时仍可切换平台。 */ }
    });
    buttons.set(item.id, button);
    platform.append(button);
  }
  restorePlatform();
  entry.addEventListener("click", open);
  close.addEventListener("click", () => dialog.close());
  library?.addEventListener("click", () => {
    dialog.close();
    void handlers.openProductLibrary?.();
  });
  return open;
}
