import assert from "node:assert/strict";
import { allowCurrentSite, renderAllowCurrentSite } from "../sidepanel/allow-current-site.js";
import { modifySettings } from "../lib/storage.js";
import { saveUiTheme } from "../sidepanel/theme.js";

const button = { dataset: {} };
const origin = "https://jobs.example:8443";
const windowId = 7;
let tab = { active: true, url: origin + "/recommend?from=test" };
let settings = { agentBridgeEnabled: true, agentBridgeOrigins: ["https://*.allowed.example"] };
let writes = 0;
const queries = [];
globalThis.chrome = {
  tabs: { query: async (query) => { queries.push(query); return [tab]; } },
  storage: { local: {
    get: async () => ({ settings: JSON.parse(JSON.stringify(settings)) }),
    set: async (value) => { settings = value.settings; writes++; },
  } },
};
if (!navigator.locks) Object.defineProperty(navigator, "locks", { value: { request: (_, f) => f() } });

renderAllowCurrentSite(button, tab, settings);
assert.equal(button.hidden, false);
assert.equal(button.dataset.origin, origin);
await allowCurrentSite(button.dataset.origin, windowId);
await allowCurrentSite(origin, windowId);
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example", origin]);
assert.equal(writes, 1);
assert.deepEqual(queries[0], { active: true, windowId });
assert.equal(Object.hasOwn(queries[0], "currentWindow"), false);
for (const url of [tab.url, "chrome://settings", "https://x.allowed.example/jobs", "https://*.example/"]) {
  renderAllowCurrentSite(button, { active: true, url }, settings);
  assert.equal(button.hidden, true);
}
tab = { active: true, url: "https://other.example" };
await assert.rejects(allowCurrentSite(origin, windowId), /已切换/);
settings.agentBridgeEnabled = false;
await assert.rejects(allowCurrentSite(tab.url, windowId), /已关闭/);
assert.equal(writes, 1);

tab = { active: true, url: origin + "/recommend?from=test" };
settings = { agentBridgeEnabled: true, agentBridgeOrigins: ["https://*.allowed.example"], uiFont: "lg" };
chrome.tabs.query = async (query) => {
  queries.push(query);
  settings = {
    ...settings,
    uiFont: "xl",
    agentBridgeOrigins: [...settings.agentBridgeOrigins, "https://extra.example"],
  };
  return [tab];
};
const writesBeforeRace = writes;
await allowCurrentSite(origin, windowId);
assert.equal(settings.uiFont, "xl");
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example", "https://extra.example", origin]);
assert.equal(writes, writesBeforeRace + 1);
assert.deepEqual(queries.at(-1), { active: true, windowId });

settings = { agentBridgeEnabled: true, agentBridgeOrigins: ["https://*.allowed.example"], uiFont: "lg" };
chrome.tabs.query = async (query) => {
  queries.push(query);
  settings = {
    ...settings,
    uiFont: "xl",
    agentBridgeOrigins: ["https://*.allowed.example", origin, "https://extra.example"],
  };
  return [tab];
};
const writesBeforeAllowed = writes;
await allowCurrentSite(origin, windowId);
assert.equal(writes, writesBeforeAllowed);
assert.equal(settings.uiFont, "xl");
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example", origin, "https://extra.example"]);

settings = { agentBridgeEnabled: true, agentBridgeOrigins: ["https://*.allowed.example"], uiFont: "lg" };
chrome.tabs.query = async () => {
  settings = { ...settings, agentBridgeEnabled: false, uiFont: "xl" };
  return [tab];
};
const writesBeforeDisable = writes;
await assert.rejects(allowCurrentSite(origin, windowId), /已关闭/);
assert.equal(writes, writesBeforeDisable);
assert.equal(settings.agentBridgeEnabled, false);
assert.equal(settings.uiFont, "xl");
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example"]);

// Another modifySettings call already changed unrelated fields and origins inside the lock.
// allowCurrentSite must append to that list, not write back a snapshot from before the lock.
tab = { active: true, url: origin + "/recommend?from=test" };
settings = {
  agentBridgeEnabled: true,
  agentBridgeOrigins: ["https://*.allowed.example"],
  uiFont: "lg",
  answerLanguage: "zh-CN",
};
chrome.tabs.query = async (query) => {
  queries.push(query);
  return [tab];
};
let releaseHold;
let markEntered;
const entered = new Promise((resolve) => { markEntered = resolve; });
const hold = modifySettings(async (latest) => {
  markEntered();
  await new Promise((resolve) => { releaseHold = resolve; });
  return {
    ...latest,
    uiFont: "xl",
    answerLanguage: "en",
    agentBridgeOrigins: [...latest.agentBridgeOrigins, "https://from-lock.example"],
  };
});
await entered;
const writesBeforeLock = writes;
const pendingAllow = allowCurrentSite(origin, windowId);
const deadline = Date.now() + 1000;
let queued = false;
while (Date.now() < deadline) {
  const snap = await navigator.locks.query();
  if (snap.pending?.some((item) => item.name === "pagelens-settings")) {
    queued = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(queued, true, "allowCurrentSite waits on pagelens-settings");
assert.equal(settings.uiFont, "lg", "holder has not written yet");
releaseHold();
await hold;
await pendingAllow;
assert.equal(settings.uiFont, "xl");
assert.equal(settings.answerLanguage, "en");
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example", "https://from-lock.example", origin]);
assert.equal(writes, writesBeforeLock + 2);

async function waitForSettingsLock() {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const snap = await navigator.locks.query();
    if (snap.pending?.some((item) => item.name === "pagelens-settings")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("did not wait on pagelens-settings");
}

settings = {
  agentBridgeEnabled: true,
  agentBridgeOrigins: ["https://*.allowed.example"],
  uiFont: "lg",
  uiTheme: "default",
  answerLanguage: "zh-CN",
  text: { apiKey: "test-only", model: "keep-me", summaryInputTokens: 111000 },
  custom: "preserve",
};
await saveUiTheme("warm");
assert.equal(settings.uiTheme, "warm");
assert.equal(settings.uiFont, "lg");
assert.equal(settings.text.apiKey, "test-only");
assert.equal(settings.text.model, "keep-me");
assert.equal(settings.custom, "preserve");
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example"]);
let releaseTheme;
let markTheme;
const themeEntered = new Promise((resolve) => { markTheme = resolve; });
const themeHold = modifySettings(async (latest) => {
  markTheme();
  await new Promise((resolve) => { releaseTheme = resolve; });
  return {
    ...latest,
    uiFont: "xl",
    answerLanguage: "en",
    agentBridgeOrigins: [...latest.agentBridgeOrigins, "https://from-lock.example"],
  };
});
await themeEntered;
const pendingTheme = saveUiTheme("mint", { mint: { accent: "#6B8022" } });
await waitForSettingsLock();
releaseTheme();
await themeHold;
await pendingTheme;
assert.equal(settings.uiTheme, "mint");
assert.equal(settings.uiThemeColors.mint.accent, "#6b8022");
assert.equal(settings.uiFont, "xl");
assert.equal(settings.answerLanguage, "en");
assert.equal(settings.text.apiKey, "test-only");
assert.equal(settings.text.model, "keep-me");
assert.equal(settings.text.summaryInputTokens, 111000);
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example", "https://from-lock.example"]);
await saveUiTheme("cyber");
assert.equal(settings.uiTheme, "cyber");
assert.equal(settings.uiThemeColors.mint.accent, "#6b8022");
assert.equal(settings.uiFont, "xl");
assert.equal(settings.text.apiKey, "test-only");

globalThis.document = { getElementById() { return null; } };
const { state } = await import("../sidepanel/state.js");
const { persistTextCatalog } = await import("../sidepanel/text-providers-ui.js");
const baseRef = { providerId: "p1", modelId: "a" };
settings = {
  agentBridgeEnabled: true,
  agentBridgeOrigins: ["https://*.allowed.example"],
  uiFont: "lg",
  uiTheme: "mint",
  textProviders: [{
    id: "p1", name: "One", preset: "custom", baseUrl: "https://models.example/v1", apiKey: "k",
    models: [{ id: "a", enabled: true }, { id: "b", enabled: true }, { id: "remote", enabled: true }],
  }],
  textRef: baseRef,
  text: { preset: "custom", baseUrl: "https://models.example/v1", apiKey: "k", model: "a", summaryInputTokens: 111000 },
};
state.settings = {
  textProviders: [
    ...settings.textProviders,
    { id: "p2", name: "Two", preset: "custom", baseUrl: "https://extra-models.example/v1", apiKey: "k2", models: [{ id: "m2", enabled: true }] },
  ],
  textRef: { providerId: "p1", modelId: "b" },
  text: { preset: "custom", baseUrl: "https://models.example/v1", apiKey: "k", model: "b", summaryInputTokens: 111000 },
};
let releaseCatalog;
let markCatalog;
const catalogEntered = new Promise((resolve) => { markCatalog = resolve; });
const catalogHold = modifySettings(async (latest) => {
  markCatalog();
  await new Promise((resolve) => { releaseCatalog = resolve; });
  return {
    ...latest,
    uiFont: "xl",
    answerLanguage: "en",
    agentBridgeOrigins: [...latest.agentBridgeOrigins, "https://from-lock.example"],
    textRef: { providerId: "p1", modelId: "remote" },
    text: { ...latest.text, summaryInputTokens: 222000 },
  };
});
await catalogEntered;
const pendingCatalog = persistTextCatalog(baseRef);
await waitForSettingsLock();
releaseCatalog();
await catalogHold;
await pendingCatalog;
assert.equal(settings.uiFont, "xl");
assert.equal(settings.uiTheme, "mint");
assert.equal(settings.answerLanguage, "en");
assert.deepEqual(settings.textRef, { providerId: "p1", modelId: "remote" });
assert.equal(settings.text.summaryInputTokens, 222000);
assert.equal(settings.text.model, "remote");
assert.equal(settings.text.baseUrl, "https://models.example/v1");
assert.ok(settings.textProviders.some((provider) => provider.id === "p2"), "catalog edit keeps the new provider");
assert.deepEqual(settings.agentBridgeOrigins, ["https://*.allowed.example", "https://from-lock.example"]);

// Real saveSettings normalizes through hydrateTextCatalog. A's scan omits B's provider;
// the saved catalog must still contain that provider or pickDefaultRef rewrites textRef.
const scanBase = { providerId: "p1", modelId: "a" };
settings = {
  agentBridgeEnabled: true,
  agentBridgeOrigins: ["https://*.allowed.example"],
  uiFont: "lg",
  textProviders: [
    { id: "p1", name: "One", preset: "custom", baseUrl: "https://old-models.example/v1", apiKey: "old-key", models: [{ id: "a", enabled: true }] },
    { id: "p-old", name: "Stored", preset: "custom", baseUrl: "https://stored.example/v1", apiKey: "stored-key", models: [{ id: "stored-m", enabled: true }] },
  ],
  textRef: scanBase,
  text: { preset: "custom", baseUrl: "https://old-models.example/v1", apiKey: "old-key", model: "a", summaryInputTokens: 111000 },
};
state.settings = {
  textProviders: [
    { id: "p1", name: "One", preset: "custom", baseUrl: "https://scanned.example/v1", apiKey: "scan-key", models: [{ id: "a", enabled: true }, { id: "scanned", enabled: true }] },
    { id: "p-scan", name: "Scan", preset: "custom", baseUrl: "https://scan-host.example/v1", apiKey: "scan-host-key", models: [{ id: "s1", enabled: true }] },
  ],
  textRef: scanBase,
  text: { preset: "custom", baseUrl: "https://scanned.example/v1", apiKey: "scan-key", model: "a", summaryInputTokens: 111000 },
};
let releaseForeign;
let markForeign;
const foreignEntered = new Promise((resolve) => { markForeign = resolve; });
const foreignHold = modifySettings(async (latest) => {
  markForeign();
  await new Promise((resolve) => { releaseForeign = resolve; });
  return {
    ...latest,
    textProviders: [
      ...latest.textProviders,
      { id: "p-new", name: "New", preset: "openai", baseUrl: "https://new.example/v1", apiKey: "new-key", models: [{ id: "new-m", enabled: true }] },
    ],
    textRef: { providerId: "p-new", modelId: "new-m" },
    text: { ...latest.text, baseUrl: "https://new.example/v1", apiKey: "new-key", model: "new-m", summaryInputTokens: 333000 },
  };
});
await foreignEntered;
const pendingForeign = persistTextCatalog(scanBase);
await waitForSettingsLock();
releaseForeign();
await foreignHold;
await pendingForeign;
assert.deepEqual(settings.textRef, { providerId: "p-new", modelId: "new-m" });
assert.equal(settings.text.baseUrl, "https://new.example/v1");
assert.equal(settings.text.apiKey, "new-key");
assert.equal(settings.text.model, "new-m");
assert.equal(settings.text.summaryInputTokens, 333000);
assert.ok(settings.textProviders.some((provider) => provider.id === "p-scan"), "scan keeps its other provider");
assert.ok(settings.textProviders.some((provider) => provider.id === "p1" && provider.apiKey === "scan-key"), "scan keeps its own provider fields");
assert.ok(!settings.textProviders.some((provider) => provider.id === "p-old"), "latest catalog is not written back whole");
console.log("allow current site tests passed");
