import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { settingsFixture } from "../../scripts/bombadil/settings-fixture.mjs";
import { bindMxApprovalPanel } from "../sidepanel/mx-approval-panel.js";

const dom = new JSDOM(await settingsFixture(), { url: "https://fixture.invalid", runScripts: "dangerously" });
const { document } = dom.window;
const get = id => document.getElementById("mx-approval-" + id);
const group = document.getElementById("settings-group-mx-approval");
const toggle = get("enabled");
const calls = [];
let state = { enabled: false, watches: [] };
let onChanged, failNext, holdNextRead;
const announce = () => onChanged({ agentMxApprovalWatch: { newValue: structuredClone(state) } }, "local");
async function disclose(open) {
  const event = new Promise(resolve => group.addEventListener("toggle", resolve, { once: true }));
  group.open = open;
  await event;
}
const api = {
  runtime: {
    async sendMessage(message) {
      calls.push(message);
      if (failNext && message.type === "pl.mxApproval.setEnabled") {
        failNext = false;
        return { ok: false, error: "设置未保存" };
      }
      if (holdNextRead && message.type === "pl.mxApproval.get") {
        const pendingRead = holdNextRead;
        holdNextRead = null;
        return pendingRead;
      }
      if (message.type === "pl.mxApproval.setEnabled") state.enabled = message.enabled;
      if (message.type === "pl.mxApproval.cancel") {
        const watch = state.watches.find(entry => entry.key === message.key);
        watch.state = "cancelled";
        watch.finishedAt = Date.now();
      }
      return { ok: true, state: structuredClone(state) };
    },
  },
  storage: { onChanged: { addListener: callback => { onChanged = callback; } } },
};

try {
  bindMxApprovalPanel(group, api);
  assert.equal(calls.length, 0, "opening the basic settings must not read approval tracking");
  document.getElementById("settings-tab-advanced").click();
  assert.equal(group.closest('[role="tabpanel"]').hidden, false);
  await disclose(true);
  await setImmediate();
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, false);
  assert.equal(get("summary").textContent, "已关闭");
  assert.equal(get("empty").hidden, false);
  assert.equal(get("history").hidden, true);
  assert.equal(calls.every(m => m.type === "pl.mxApproval.get"), true, "viewing status must only read");

  const saveStatus = document.getElementById("save-status");
  saveStatus.textContent = "";
  failNext = true;
  toggle.click();
  await setImmediate();
  assert.equal(toggle.checked, false, "failed writes must restore confirmed state");
  assert.match(get("error").textContent, /设置未保存/);
  assert.equal(saveStatus.textContent, "", "immediate actions do not dirty the settings form");

  toggle.click();
  await setImmediate();
  assert.equal(toggle.checked, true);
  assert.equal(get("error").textContent, "");
  assert.deepEqual(calls.at(-1), { type: "pl.mxApproval.setEnabled", enabled: true });

  const now = Date.now();
  state.watches = [
    { key: "new", mode: "publish_draft", productId: "1234", title: "<img>", state: "watching",
      lastStatus: "no_page", lastCheckedAt: now, expiresAt: now + 3600000 },
    { key: "title", mode: "optimize_listing", productId: "5678", state: "watching", lastStatus: "not_found" },
    { key: "old", mode: "publish_draft", productId: "9999", state: "approved" },
  ];
  const beforeRefresh = calls.length;
  onChanged({ unrelated: {} }, "local");
  onChanged({ agentMxApprovalWatch: {} }, "sync");
  assert.equal(calls.length, beforeRefresh);
  // A previous status read cannot replace a newer update from storage.
  let finishStale;
  holdNextRead = new Promise(resolve => { finishStale = resolve; });
  onChanged({ agentMxApprovalWatch: {} }, "local");
  announce();
  finishStale({ ok: true, state: { enabled: false, watches: [] } });
  await setImmediate();
  assert.equal(toggle.checked, true);
  assert.equal(get("summary").textContent, "2 条跟踪中");
  const first = get("pending").firstElementChild;
  assert.match(first.textContent, /<img>1234 · 商品上架 · 等待打开墨西哥商品管理 → 全部/);
  assert.equal(first.querySelector("img"), null);
  assert.match(first.textContent, /最近检查.+截止/);
  assert.match(get("pending").lastElementChild.textContent, /标题审核 · 当前列表未找到商品/);
  assert.equal(get("history").hidden, false);
  assert.equal(get("history").open, false);
  assert.match(get("finished").textContent, /9999.*已通过审核/);
  assert.equal(get("finished").querySelector("button"), null);

  first.querySelector("button").click();
  await setImmediate();
  assert.deepEqual(calls.at(-1), { type: "pl.mxApproval.cancel", key: "new" });
  assert.equal(get("pending").children.length, 1);
  assert.match(get("finished").firstElementChild.textContent, /1234.*已手动停止.*结束/);
  const pendingBefore = get("pending").firstElementChild;
  const requests = calls.length;
  await disclose(false);
  state.watches.find(w => w.state === "watching").lastStatus = "stale_page";
  announce();
  assert.equal(get("pending").firstElementChild, pendingBefore, "closed accordion skips list updates");
  assert.equal(calls.length, requests);
  await disclose(true);
  assert.match(get("pending").textContent, /当前列表早于本次提审，可手动刷新列表/);

  document.getElementById("settings-tab-basic").click();
  const hiddenRow = get("pending").firstElementChild;
  state.watches.find(w => w.state === "watching").lastStatus = "unreadable";
  announce();
  assert.equal(get("pending").firstElementChild, hiddenRow, "hidden settings tab skips list updates");
  document.getElementById("settings-tab-advanced").click();
  await setImmediate();
  assert.match(get("pending").textContent, /已打开的商品列表暂时无法读取/);
  assert.equal(calls.length, requests, "storage updates and navigation reuse confirmed state");

  toggle.click();
  await setImmediate();
  assert.deepEqual(calls.at(-1), { type: "pl.mxApproval.setEnabled", enabled: false });
  assert.equal(get("summary").textContent, "已关闭");
  console.log("TikTok MX approval settings, status updates, and per-product cancellation passed");
} finally {
  dom.window.close();
}
