import { enabledModelOptions } from "../lib/text-providers.js";
import { isModelReady, isAsrReady, isTtsReady } from "../lib/storage.js";
import { normalizeJevSettings, isJevConfigured, testJevConnection } from "../lib/jev.js";

/** Grouping is presentational: never recreate forms when switching tabs. */
export function createSettingsPage({ root, getSettings, onModelChange }) {
  const find = (id) => root.querySelector(`#${id}`);
  const tabs = [...root.querySelectorAll("[data-settings-tab]")];
  const scroll = find("settings-scroll");
  const positions = { basic: 0, advanced: 0 };
  let active = "basic";
  const setText = (id, text) => { find(id).textContent = text; };

  function showTab(name, focus = false) {
    if (!["basic", "advanced"].includes(name)) return;
    positions[active] = scroll.scrollTop;
    active = name;
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      find(tab.getAttribute("aria-controls")).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    scroll.scrollTop = positions[name];
  }

  function reveal(id) {
    const target = find(id);
    if (!target) return;
    const panel = target.closest('[role="tabpanel"]');
    if (panel) showTab(panel.id === "settings-basic" ? "basic" : "advanced");
    for (let node = target; node && node !== root; node = node.parentElement) {
      if (node.tagName === "DETAILS") node.open = true;
    }
    target.scrollIntoView({ block: "nearest" });
  }

  function refreshSummary() {
    const settings = getSettings();
    setText("settings-model-state", isModelReady(settings.text) ? "已配置" : "待配置");
    const asrReady = isAsrReady(settings.asr), ttsReady = isTtsReady(settings.tts);
    setText("settings-state-audio", asrReady && ttsReady ? "已配置" : asrReady ? "仅转写" : ttsReady ? "仅配音" : "未配置");
    setText("settings-state-parameters", Number(settings.text?.summaryInputTokens) === 200000 ? "默认" : "自定义");
    setText("settings-state-skills", settings.skillsEnabled ? "已启用" : "未启用");
    setText("settings-state-native", settings.nativeShell === false ? "命令已关闭" : ({ strict: "严格", balanced: "智能审查", autonomous: "全自动" }[settings.hitlMode] || "智能审查"));
    setText("settings-state-trace", settings.langfuse?.enabled ? "已启用" : "未启用");
    setText("settings-state-colors", Object.keys(settings.uiThemeColors?.[settings.uiTheme] || {}).length ? "自定义" : "默认");
    setText("settings-state-shortcuts", `${settings.shortcuts?.length || 0} 条　›`);
    setText("jev-toggle-label", settings.jev?.enabled ? "已开启" : "已关闭");
    setText("settings-state-jev", isJevConfigured(settings.jev) ? "已填写" : "待配置");
  }

  function refreshModels() {
    const settings = getSettings();
    const select = find("settings-text-model");
    const options = enabledModelOptions(settings.textProviders);
    select.replaceChildren();
    if (!options.length) select.append(new Option("请先添加服务商和模型", ""));
    for (const option of options) {
      select.append(new Option(`${option.providerName} · ${option.modelId}`, `${option.providerId}::${option.modelId}`));
    }
    select.disabled = !options.length;
    if (settings.textRef) select.value = `${settings.textRef.providerId}::${settings.textRef.modelId}`;
    if (!options.length) find("settings-provider-manager").open = true;

    // Update model-top provider preview info
    const activeProvider = (settings.textRef && settings.textProviders?.find((p) => p.id === settings.textRef.providerId))
      || settings.textProviders?.[0];
    if (find("settings-provider-name")) {
      find("settings-provider-name").textContent = activeProvider?.name || "我的模型服务";
    }
    if (find("settings-provider-type")) {
      find("settings-provider-type").textContent = isModelReady(settings.text)
        ? (activeProvider?.preset === "custom" ? "OpenAI 兼容服务" : (activeProvider?.name ? `${activeProvider.name} · 服务` : "OpenAI 兼容服务"))
        : "尚未配置模型服务";
    }

    refreshSummary();
  }

  function render() {
    const settings = getSettings();
    const jev = normalizeJevSettings(settings.jev);
    find("jev-enabled").checked = jev.enabled;
    find("jev-model").value = jev.model;
    find("jev-api-key").value = jev.apiKey;
    find("jev-url").value = jev.baseUrl;
    root.querySelector('[data-k="text.summaryInputTokens"]').value = settings.text?.summaryInputTokens || 200000;
    refreshModels();
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => showTab(tab.dataset.settingsTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      showTab(event.key === "Home" ? "basic" : event.key === "End" ? "advanced" : active === "basic" ? "advanced" : "basic", true);
    });
  }
  root.querySelectorAll("[data-settings-link]").forEach(button => {
    button.addEventListener("click", () => reveal(button.dataset.settingsLink));
  });
  find("settings-text-model").addEventListener("change", (event) => onModelChange(event.target.value));

  const toggleBtn = find("btn-toggle-provider-manager");
  const mgr = find("settings-provider-manager");
  if (toggleBtn && mgr) {
    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      mgr.open = !mgr.open;
      toggleBtn.setAttribute("aria-expanded", String(mgr.open));
      toggleBtn.textContent = mgr.open ? "收起" : "管理";
    });
    mgr.addEventListener("toggle", () => {
      toggleBtn.setAttribute("aria-expanded", String(mgr.open));
      toggleBtn.textContent = mgr.open ? "收起" : "管理";
    });
  }

  function writeJev() {
    const settings = getSettings();
    settings.jev = {
      ...normalizeJevSettings(settings.jev),
      enabled: find("jev-enabled").checked,
      model: find("jev-model").value.trim(),
      apiKey: find("jev-api-key").value.trim(),
      baseUrl: find("jev-url").value.trim(),
    };
    setText("jev-test-status", "");
    refreshSummary();
  }
  find("jev-enabled").addEventListener("change", () => {
    writeJev();
    if (find("jev-enabled").checked) find("jev-connection").open = true;
  });
  for (const id of ["jev-model", "jev-api-key", "jev-url"]) find(id).addEventListener("input", writeJev);
  find("btn-jev-test").addEventListener("click", async () => {
    writeJev();
    const config = { ...getSettings().jev };
    const button = find("btn-jev-test");
    const status = find("jev-test-status");
    button.disabled = true;
    status.textContent = "连接测试中…";
    status.className = "status";
    try {
      const result = await testJevConnection(config);
      if (JSON.stringify(config) !== JSON.stringify(getSettings().jev)) {
        status.textContent = "配置已更改，请重新测试。";
      } else {
        status.textContent = `连接可用 · ${result.ms}ms（循环待接入）`;
        status.className = "status ok";
      }
    } catch (error) {
      status.textContent = error.message;
      status.className = "status bad";
    } finally { button.disabled = false; }
  });
  root.addEventListener("input", (event) => {
    if (!event.target.matches("[data-theme-color]")) {
      setText("save-status", "有未保存的更改");
      find("save-status").className = "status";
    }
    queueMicrotask(refreshSummary);
  });
  root.addEventListener("change", () => queueMicrotask(refreshSummary));
  root.addEventListener("click", (event) => {
    if (event.target.closest('[data-ui-theme],#btn-theme-reset,#btn-add-shortcut,[data-del]')) queueMicrotask(refreshSummary);
  });
  render();
  return { render, refreshModels, refreshSummary, showTab, reveal };
}
