import assert from "node:assert/strict";
import {
  createTemporaryMarkerWindow,
  focusOpenSavedGroup,
  requestFocusedNativeOpen,
  requestTemporaryMarker,
} from "../lib/agent/saved-group-focus.js";

const payload = { action: "open", guid: "g1" };

{
  const order = [];
  const chromeApi = {
    windows: {
      update: async (id, patch) => { order.push(["update", id, patch.focused]); },
    },
  };
  const response = await focusOpenSavedGroup(
    { windowId: 9, panelWindowId: 3, payload },
    { chromeApi, nativeCall: async (req) => { order.push(["native", req.guid]); return { ok: true, guid: req.guid }; } },
  );
  assert.deepEqual(order, [["update", 9, true], ["native", "g1"], ["update", 3, true]]);
  assert.equal(response.ok, true);
  assert.equal(response.result.guid, "g1");
}

{
  const order = [];
  const chromeApi = {
    windows: {
      update: async (id, patch) => { order.push(["update", id, patch.focused]); },
    },
  };
  const response = await focusOpenSavedGroup(
    { windowId: 9, panelWindowId: 3, payload },
    {
      chromeApi,
      nativeCall: async () => {
        order.push("throw");
        throw new Error("boom");
      },
    },
  );
  assert.deepEqual(order, [["update", 9, true], "throw", ["update", 3, true]]);
  assert.equal(response.ok, false);
  assert.equal(response.code, "OPEN_FAILED");
  assert.match(response.error, /boom/);
}

{
  let updates = 0;
  const response = await focusOpenSavedGroup(
    { windowId: 9, panelWindowId: 3, payload },
    {
      chromeApi: {
        windows: {
          update: async () => {
            updates += 1;
            if (updates === 1) throw new Error("focus failed");
          },
        },
      },
      nativeCall: async () => { throw new Error("native should not run"); },
    },
  );
  assert.equal(updates, 2);
  assert.equal(response.code, "OPEN_FAILED");
  assert.match(response.error, /focus failed/);
}

{
  const chromeApi = { windows: { update: async () => {} } };
  const response = await focusOpenSavedGroup(
    { windowId: 9, panelWindowId: 3, payload },
    { chromeApi, nativeCall: async () => ({ ok: false, code: "NOT_FOUND_IN_UI", error: "miss" }) },
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.code, "NOT_FOUND_IN_UI");
}

{
  const rejected = await focusOpenSavedGroup(
    { windowId: 0, panelWindowId: 3, payload },
    { chromeApi: { windows: { update: async () => { throw new Error("no update"); } } }, nativeCall: async () => ({ ok: true }) },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "OPEN_FAILED");
}

{
  const sent = [];
  const result = await requestFocusedNativeOpen({
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        return { ok: true, result: { ok: true, guid: "g1", via: "sw" } };
      },
    },
    windows: { update: async () => { throw new Error("panel must not focus"); } },
  }, async () => { throw new Error("direct"); }, payload, 9, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "pl.savedGroups.focusOpen");
  assert.equal(sent[0].windowId, 9);
  assert.equal(sent[0].panelWindowId, 3);
  assert.equal(result.via, "sw");
}

{
  let direct = 0;
  const result = await requestFocusedNativeOpen({
    runtime: { sendMessage: async () => { throw new Error("same window"); } },
  }, async () => { direct += 1; return { ok: true, via: "direct" }; }, payload, 3, 3);
  assert.equal(direct, 1);
  assert.equal(result.via, "direct");
}

{
  let direct = 0;
  const result = await requestFocusedNativeOpen(
    {},
    async () => { direct += 1; return { ok: true, via: "direct" }; },
    payload,
    9,
    3,
  );
  assert.equal(direct, 1);
  assert.equal(result.via, "direct");
}

{
  const order = [];
  await requestFocusedNativeOpen({
    windows: { update: async (id) => { order.push(id); } },
  }, async () => { order.push("native"); return { ok: true }; }, payload, 9, 3);
  assert.deepEqual(order, [9, "native"]);
}

{
  const result = await requestFocusedNativeOpen({
    runtime: { sendMessage: async () => ({ ok: false, code: "HELPER_TIMEOUT", error: "slow" }) },
  }, async () => { throw new Error("direct"); }, payload, 9, 3);
  assert.equal(result.ok, false);
  assert.equal(result.code, "HELPER_TIMEOUT");
  assert.equal(result.error, "slow");
}

const markerTitle = "PageLens-11111111-2222-3333-4444-555555555555";
const markerUrl = "data:text/html;charset=utf-8,marker";

{
  const order = [];
  const chromeApi = {
    windows: {
      create: async (opts) => {
        order.push(["create", opts.focused, opts.url]);
        return { id: 9, tabs: [{ id: 41, windowId: 9 }] };
      },
      update: async (id, patch) => { order.push(["focus", id, patch.focused]); },
      remove: async () => { throw new Error("should not remove"); },
    },
    tabs: {
      update: async (id, patch) => {
        order.push(["tab", id, patch.url.startsWith("data:text/html"), patch.active]);
        return { id, windowId: 9, url: patch.url, active: true, title: markerTitle };
      },
    },
  };
  const response = await createTemporaryMarkerWindow(
    { title: markerTitle, url: markerUrl, panelWindowId: 3 },
    { chromeApi },
  );
  assert.deepEqual(order, [
    ["create", false, "about:blank"],
    ["tab", 41, true, true],
    ["focus", 3, true],
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.tab.id, 41);
  assert.equal(response.tab.windowId, 9);
  assert.equal(response.tab.url, markerUrl);
}

{
  const order = [];
  const response = await createTemporaryMarkerWindow(
    { title: markerTitle, url: markerUrl, panelWindowId: 3 },
    {
      chromeApi: {
        windows: {
          create: async () => { order.push("create"); return { id: 9, tabs: [{ id: 41, windowId: 9 }] }; },
          update: async (id) => { order.push(["focus", id]); },
          remove: async (id) => { order.push(["remove", id]); },
        },
        tabs: { update: async () => { order.push("tab"); throw new Error("navigate failed"); } },
      },
    },
  );
  assert.deepEqual(order, ["create", "tab", ["remove", 9], ["focus", 3]]);
  assert.equal(response.ok, false);
  assert.equal(response.code, "WINDOW_NOT_FOUND");
  assert.match(response.error, /navigate failed/);
}

{
  const order = [];
  const response = await createTemporaryMarkerWindow(
    { title: markerTitle, url: markerUrl, panelWindowId: 3 },
    {
      chromeApi: {
        windows: {
          create: async () => { order.push("create"); return { id: 9, tabs: [] }; },
          update: async (id) => { order.push(["focus", id]); },
          remove: async (id) => { order.push(["remove", id]); },
        },
        tabs: { query: async () => { order.push("query"); return []; } },
      },
    },
  );
  assert.deepEqual(order, ["create", "query", ["remove", 9], ["focus", 3]]);
  assert.equal(response.ok, false);
  assert.equal(response.code, "WINDOW_NOT_FOUND");
}

{
  let created = 0;
  const order = [];
  const response = await createTemporaryMarkerWindow(
    { title: "PageLens-not-a-uuid", url: markerUrl, panelWindowId: 3 },
    {
      chromeApi: {
        windows: {
          create: async () => { created += 1; },
          update: async (id) => { order.push(id); },
        },
      },
    },
  );
  assert.equal(created, 0);
  assert.deepEqual(order, [3]);
  assert.equal(response.ok, false);
  assert.equal(response.code, "WINDOW_NOT_FOUND");
}

{
  let created = 0;
  const response = await createTemporaryMarkerWindow(
    { title: markerTitle, url: "https://example.invalid/marker", panelWindowId: 3 },
    { chromeApi: { windows: { create: async () => { created += 1; }, update: async () => {} } } },
  );
  assert.equal(created, 0);
  assert.equal(response.ok, false);
}

{
  const sent = [];
  const result = await requestTemporaryMarker({
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        return { ok: true, tab: { id: 41, windowId: 9 } };
      },
    },
    windows: { create: async () => { throw new Error("panel must not create"); } },
  }, { title: markerTitle, url: markerUrl, panelWindowId: 3 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "pl.savedGroups.createMarker");
  assert.equal(sent[0].title, markerTitle);
  assert.equal(sent[0].panelWindowId, 3);
  assert.equal(result.tab.id, 41);
}

{
  const result = await requestTemporaryMarker(
    { windows: { create: async () => { throw new Error("no send"); } } },
    { title: markerTitle, url: markerUrl, panelWindowId: 3 },
  );
  assert.equal(result, null);
}

{
  const result = await requestTemporaryMarker({
    runtime: { sendMessage: async () => { throw new Error("sw down"); } },
  }, { title: markerTitle, url: markerUrl, panelWindowId: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WINDOW_NOT_FOUND");
  assert.match(result.error, /sw down/);
}

console.log("PASS saved group focus open");
