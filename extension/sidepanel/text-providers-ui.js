import { $ } from "./dom.js";
import { renderModelLine } from "./model-line.js";
import { settingsPage } from "./panel-refs.js";
import { state } from "./state.js";
import { listRemoteModels } from "../lib/openai.js";
import { presetsFor, saveSettings } from "../lib/storage.js";
import {
  addProviderModel,
  hydrateTextCatalog,
  invertProviderModelsEnabled,
  mergeScannedModels,
  newProviderId,
  normalizeProvider,
  setAllProviderModelsEnabled,
  setProviderModelEnabled,
  suggestProviderName,
} from "../lib/text-providers.js";

function fieldBlock(prefix, model, hints = {}) {
  const presetOpts = presetsFor(prefix).map(
    (p) => `<option value="${p.id}" ${p.id === model.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  return `
    <label class="field">预设
      <select data-k="${prefix}.preset">${presetOpts}</select>
    </label>
    <label class="field">base_url
      <input data-k="${prefix}.baseUrl" value="${escapeAttr(model.baseUrl)}" placeholder="${escapeAttr(hints.baseUrl || "https://api.example.com/v1")}" />
    </label>
    <label class="field">model_name
      <input data-k="${prefix}.model" value="${escapeAttr(model.model)}" placeholder="${escapeAttr(hints.model || "gpt-4o-mini")}" />
    </label>
    <label class="field">api_key
      <input data-k="${prefix}.apiKey" type="password" value="${escapeAttr(model.apiKey)}" placeholder="${escapeAttr(hints.key || "sk-…")}" autocomplete="off" />
    </label>
    ${prefix === 'text' ? `<label class="field">视频总结：单次正文上限（token）
      <input data-k="text.summaryInputTokens" type="number" min="1000" max="2000000" step="1000" value="${Number(model.summaryInputTokens) || 200000}" />
      <small>默认 200,000；超过才分段。按中英文估算，不含提示词和输出。</small>
    </label>` : ''}
    <div class="row-btns">
      <button class="secondary" type="button" data-test="${prefix}">测试连接</button>
      <span class="status" data-test-status="${prefix}"></span>
    </div>
  `;
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function syncTextCatalog() {
  const tokens = state.settings.text?.summaryInputTokens;
  const catalog = hydrateTextCatalog(state.settings, state.settings.text);
  state.settings.textProviders = catalog.textProviders;
  state.settings.textRef = catalog.textRef;
  state.settings.text = { ...catalog.text, summaryInputTokens: tokens };
}

function persistTextCatalog() {
  syncTextCatalog();
  return saveSettings(state.settings).then((saved) => {
    state.settings = saved;
    renderTextProviders();
    renderModelLine();
    return saved;
  });
}

function providerById(id) {
  return (state.settings.textProviders || []).find((p) => p.id === id);
}

function replaceProvider(next) {
  state.settings.textProviders = (state.settings.textProviders || []).map((p) => (p.id === next.id ? next : p));
}

function visibleProviderModelIds(provider) {
  const q = String(state.textProviderUi?.query || "").trim().toLowerCase();
  return (provider.models || [])
    .filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.ownedBy || "").toLowerCase().includes(q))
    .map((m) => m.id);
}

function renderTextProviders() {
  const root = $("text-providers");
  if (!root) return;
  bindTextProvidersOnce();
  syncTextCatalog();
  const providers = state.settings.textProviders || [];
  const ui = state.textProviderUi;
  const current = state.settings.textRef;
  const presetOpts = presetsFor("text").map((p) => `<option value="${escapeAttr(p.id)}">${escapeAttr(p.name)}</option>`).join("");
  const q = String(ui.query || "").trim().toLowerCase();
  const cards = providers.map((p) => {
    const models = q
      ? p.models.filter((m) => m.id.toLowerCase().includes(q) || String(m.ownedBy || "").toLowerCase().includes(q))
      : p.models;
    const editing = ui.editingId === p.id;
    const modelRows = models.map((m) => {
      const isCurrent = current?.providerId === p.id && current?.modelId === m.id;
      return `<li>
        <label class="check">
          <input type="checkbox" data-tp="toggle" data-id="${escapeAttr(p.id)}" data-model="${escapeAttr(m.id)}" ${m.enabled ? "checked" : ""} />
          <span><code>${escapeAttr(m.id)}</code>${m.ownedBy ? ` <span class="muted">· ${escapeAttr(m.ownedBy)}</span>` : ""}${isCurrent ? " · 当前" : ""}</span>
        </label>
        <button type="button" class="secondary" data-tp="current" data-id="${escapeAttr(p.id)}" data-model="${escapeAttr(m.id)}" ${m.enabled ? "" : "disabled"}>设为当前</button>
      </li>`;
    }).join("");
    return `<article class="provider-card">
      <div class="provider-head">
        <strong>${escapeAttr(p.name)}</strong>
        <span class="muted">${escapeAttr(p.preset)} · ${p.apiKey ? "已填密钥" : "无密钥"}</span>
      </div>
      <div class="muted provider-url">${escapeAttr(p.baseUrl || "—")}${p.scannedAt ? ` · 扫描于 ${escapeAttr(p.scannedAt.slice(0, 19).replace("T", " "))}` : ""}</div>
      ${p.scanError ? `<div class="status bad">${escapeAttr(p.scanError)}</div>` : ""}
      <div class="row-btns">
        <button type="button" class="secondary" data-tp="scan" data-id="${escapeAttr(p.id)}">扫描模型</button>
        <button type="button" class="secondary" data-tp="edit" data-id="${escapeAttr(p.id)}">${editing ? "取消编辑" : "改地址/密钥"}</button>
        <button type="button" class="secondary" data-tp="delete" data-id="${escapeAttr(p.id)}">删除</button>
      </div>
      ${editing ? `<div class="provider-edit">
        <label class="field">base_url<input data-tp-edit="baseUrl" data-id="${escapeAttr(p.id)}" value="${escapeAttr(p.baseUrl)}" /></label>
        <label class="field">api_key<input data-tp-edit="apiKey" data-id="${escapeAttr(p.id)}" type="password" value="" placeholder="留空则不改" autocomplete="off" /></label>
        <button type="button" class="secondary" data-tp="save-edit" data-id="${escapeAttr(p.id)}">保存并扫描</button>
      </div>` : ""}
      <div class="path-row">
        <input data-tp-add-model="${escapeAttr(p.id)}" value="${escapeAttr(ui.addModel[p.id] || "")}" placeholder="手填模型名后添加" />
        <button type="button" class="secondary" data-tp="add-model" data-id="${escapeAttr(p.id)}">添加</button>
      </div>
      ${p.models.length > 8 ? `<label class="field">筛选模型<input data-tp-query="1" value="${escapeAttr(ui.query)}" placeholder="搜索模型名" /></label>` : ""}
      ${modelRows ? `<div class="row-btns model-bulk">
        <button type="button" class="secondary" data-tp="select-all" data-id="${escapeAttr(p.id)}">全选</button>
        <button type="button" class="secondary" data-tp="invert" data-id="${escapeAttr(p.id)}">反选</button>
        <span class="muted">${models.filter((m) => m.enabled).length}/${models.length}${q ? "（当前筛选）" : ""}</span>
      </div>
      <ul class="model-scan-list">${modelRows}</ul>` : `<p class="muted">尚未发现模型，可扫描或手填。</p>`}
    </article>`;
  }).join("");
  root.innerHTML = `
    <div class="row-btns">
      <button type="button" class="secondary" data-tp="toggle-add">${ui.adding ? "收起新增" : "新增服务商"}</button>
      <span class="muted">已有 ${providers.length} 条</span>
    </div>
    ${ui.msg ? `<p class="status ok">${escapeAttr(ui.msg)}</p>` : ""}
    ${ui.err ? `<p class="status bad">${escapeAttr(ui.err)}</p>` : ""}
    ${ui.adding ? `<div class="provider-add">
      <label class="field">预设<select data-tp-draft="preset">${presetOpts}</select></label>
      <label class="field">名称<input data-tp-draft="name" placeholder="可空，自动从地址生成" /></label>
      <label class="field">base_url<input data-tp-draft="baseUrl" placeholder="https://api.example.com/v1" /></label>
      <label class="field">api_key<input data-tp-draft="apiKey" type="password" placeholder="sk-…" autocomplete="off" /></label>
      <label class="field">先手填一个模型（可选）<input data-tp-draft="model" placeholder="gpt-4o-mini" /></label>
      <div class="row-btns">
        <button type="button" class="primary" data-tp="add">添加并扫描</button>
      </div>
    </div>` : ""}
    ${cards || `<p class="muted">还没有服务商。点「新增服务商」加入 OpenAI / OpenRouter / 本地 Ollama 等。</p>`}
  `;
  const draftPreset = root.querySelector("[data-tp-draft=preset]");
  if (draftPreset && ui.draftPreset) draftPreset.value = ui.draftPreset;
  settingsPage?.refreshModels();
}

function bindTextProvidersOnce() {
  const root = $("text-providers");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "1";
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tp]");
    if (!btn) return;
    handleTextProviderAction(btn.dataset.tp, btn.dataset.id, btn.dataset.model).catch((err) => {
      state.textProviderUi.err = err.message || String(err);
      renderTextProviders();
    });
  });
  root.addEventListener("change", (e) => {
    const box = e.target.closest("[data-tp=toggle]");
    if (box) {
      handleTextProviderAction("toggle", box.dataset.id, box.dataset.model, box.checked).catch((err) => {
        state.textProviderUi.err = err.message || String(err);
        renderTextProviders();
      });
    }
    const draft = e.target.closest("[data-tp-draft=preset]");
    if (draft) {
      const preset = presetsFor("text").find((p) => p.id === draft.value);
      state.textProviderUi.draftPreset = draft.value;
      if (preset) {
        const url = root.querySelector("[data-tp-draft=baseUrl]");
        if (url) url.value = preset.baseUrl || "";
      }
    }
  });
  root.addEventListener("input", (e) => {
    const add = e.target.closest("[data-tp-add-model]");
    if (add) state.textProviderUi.addModel[add.getAttribute("data-tp-add-model")] = add.value;
    if (e.target.closest("[data-tp-query]")) state.textProviderUi.query = e.target.value;
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const add = e.target.closest("[data-tp-add-model]");
    if (!add) return;
    e.preventDefault();
    handleTextProviderAction("add-model", add.getAttribute("data-tp-add-model")).catch((err) => {
      state.textProviderUi.err = err.message || String(err);
      renderTextProviders();
    });
  });
}

async function scanTextProvider(id) {
  const provider = providerById(id);
  if (!provider) throw new Error("找不到服务商");
  if (!provider.baseUrl.trim()) throw new Error("请先填 base_url");
  const result = await listRemoteModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  replaceProvider({
    ...provider,
    models: mergeScannedModels(provider.models, result.models),
    scannedAt: new Date().toISOString(),
    scanError: "",
  });
  state.textProviderUi.msg = `已扫描 ${result.models.length} 个模型`;
  state.textProviderUi.err = "";
}

async function handleTextProviderAction(action, id, modelId, enabled) {
  const ui = state.textProviderUi;
  const root = $("text-providers");
  if (action === "toggle-add") {
    ui.adding = !ui.adding;
    ui.err = "";
    renderTextProviders();
    return;
  }
  if (action === "add") {
    const preset = root.querySelector("[data-tp-draft=preset]")?.value || "custom";
    const baseUrl = root.querySelector("[data-tp-draft=baseUrl]")?.value.trim() || "";
    const apiKey = root.querySelector("[data-tp-draft=apiKey]")?.value || "";
    const model = root.querySelector("[data-tp-draft=model]")?.value.trim() || "";
    const name = root.querySelector("[data-tp-draft=name]")?.value.trim() || suggestProviderName(baseUrl, preset);
    if (!baseUrl) throw new Error("请填写 base_url");
    const provider = normalizeProvider({
      id: newProviderId(),
      name,
      preset,
      baseUrl,
      apiKey,
      models: model ? [{ id: model, enabled: true }] : [],
    });
    state.settings.textProviders = [...(state.settings.textProviders || []), provider];
    if (model) state.settings.textRef = { providerId: provider.id, modelId: model };
    ui.adding = false;
    ui.msg = `已新增「${provider.name}」`;
    ui.err = "";
    if (baseUrl) {
      try {
        await scanTextProvider(provider.id);
      } catch (err) {
        const cur = providerById(provider.id);
        if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
        ui.err = err.message || String(err);
      }
    }
    await persistTextCatalog();
    return;
  }
  if (action === "edit") {
    ui.editingId = ui.editingId === id ? "" : id;
    renderTextProviders();
    return;
  }
  if (action === "save-edit") {
    const provider = providerById(id);
    if (!provider) return;
    const baseUrl = root.querySelector(`[data-tp-edit=baseUrl][data-id="${CSS.escape(id)}"]`)?.value.trim() || provider.baseUrl;
    const apiKeyRaw = root.querySelector(`[data-tp-edit=apiKey][data-id="${CSS.escape(id)}"]`)?.value || "";
    replaceProvider({
      ...provider,
      baseUrl,
      apiKey: apiKeyRaw.trim() ? apiKeyRaw : provider.apiKey,
      name: provider.name || suggestProviderName(baseUrl, provider.preset),
    });
    ui.editingId = "";
    try {
      await scanTextProvider(id);
    } catch (err) {
      const cur = providerById(id);
      if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
      ui.err = err.message || String(err);
    }
    await persistTextCatalog();
    return;
  }
  if (action === "delete") {
    state.settings.textProviders = (state.settings.textProviders || []).filter((p) => p.id !== id);
    if (state.settings.textRef?.providerId === id) state.settings.textRef = null;
    ui.msg = "已删除";
    ui.err = "";
    await persistTextCatalog();
    return;
  }
  if (action === "scan") {
    ui.err = "";
    try {
      await scanTextProvider(id);
    } catch (err) {
      const cur = providerById(id);
      if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
      throw err;
    }
    await persistTextCatalog();
    return;
  }
  if (action === "toggle") {
    const provider = providerById(id);
    if (!provider) return;
    replaceProvider(setProviderModelEnabled(provider, modelId, enabled));
    await persistTextCatalog();
    return;
  }
  if (action === "select-all" || action === "invert") {
    const provider = providerById(id);
    if (!provider) return;
    const visibleIds = visibleProviderModelIds(provider);
    replaceProvider(action === "select-all"
      ? setAllProviderModelsEnabled(provider, true, visibleIds)
      : invertProviderModelsEnabled(provider, visibleIds));
    ui.msg = action === "select-all" ? "已全选当前列表" : "已反选当前列表";
    await persistTextCatalog();
    return;
  }
  if (action === "current") {
    state.settings.textRef = { providerId: id, modelId };
    ui.msg = `已设为当前：${modelId}`;
    await persistTextCatalog();
    return;
  }
  if (action === "add-model") {
    const provider = providerById(id);
    if (!provider) return;
    const raw = String(ui.addModel[id] || root.querySelector(`[data-tp-add-model="${CSS.escape(id)}"]`)?.value || "").trim();
    if (!raw) throw new Error("请填写模型 ID");
    replaceProvider(addProviderModel(provider, raw));
    ui.addModel[id] = "";
    ui.msg = `已加入 ${raw}`;
    if (!state.settings.textRef) state.settings.textRef = { providerId: id, modelId: raw };
    await persistTextCatalog();
  }
}


export {
  fieldBlock,
  escapeAttr,
  syncTextCatalog,
  persistTextCatalog,
  providerById,
  replaceProvider,
  visibleProviderModelIds,
  renderTextProviders,
  bindTextProvidersOnce,
  scanTextProvider,
  handleTextProviderAction,
};
