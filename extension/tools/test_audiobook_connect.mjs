import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
const entries = manifest.web_accessible_resources.filter((row) => row.resources.includes("audiobook-connect.html"));
assert.equal(entries.length, 1);
assert.deepEqual(entries[0].matches, ["http://127.0.0.1/*", "http://localhost/*"]);

const ticket = "a".repeat(64);
const slot = { id: "chosen", name: "Example", baseUrl: "https://model.example/v1",
  apiKey: "fixture-only", models: [{ id: "reader", enabled: true }] };
const settings = { textProviders: [slot], textRef: { providerId: "chosen", modelId: "reader" } };
const requests = [];
globalThis.chrome = {
  storage: { local: { get: async () => ({ settings }) } },
};
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return { ok: true };
};

let serial = 0;
async function open(hash, framed = false) {
  const elements = new Map();
  globalThis.document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      disabled: selector === "#connect", textContent: "", addEventListener(event, fn) { this[event] = fn; },
    });
    return elements.get(selector);
  } };
  globalThis.window = {};
  window.top = framed ? {} : window;
  globalThis.location = { hash, pathname: "/audiobook-connect.html" };
  globalThis.history = { replaceState(_state, _title, url) {
    assert.equal(url, location.pathname);
    location.hash = "";
  } };
  await import(`../audiobook-connect.js?test=${++serial}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(location.hash, "");
  return elements;
}

assert.equal((await open("#token=invalid")).get("#connect").disabled, true);
assert.equal((await open("#token=" + ticket, true)).get("#connect").disabled, true);
const ui = await open("#token=" + ticket + "&destination=https://other.example");
const button = ui.get("#connect");
assert.equal(ui.get("#provider").textContent, "model.example");
assert.equal(ui.get("#model").textContent, "reader");
assert.equal(button.disabled, false);
await button.click({ isTrusted: false });
assert.equal(requests.length, 0);
slot.baseUrl = "https://updated.example/v1";
await button.click({ isTrusted: true });
assert.equal(ui.get("#provider").textContent, "updated.example");
assert.equal(requests.length, 0);
await button.click({ isTrusted: true });
assert.equal(requests.length, 1);
const [{ url, options }] = requests;
assert.equal(url, "http://127.0.0.1:4173/api/translation/pagelens/complete");
assert.equal(options.redirect, "error");
assert.equal(options.mode, "cors");
assert.equal(options.credentials, "omit");
assert.deepEqual(JSON.parse(options.body), {
  token: ticket, model: "reader", baseUrl: slot.baseUrl, apiKey: slot.apiKey,
});
assert.ok([...ui.values()].every((el) => !el.textContent.includes(slot.apiKey)));
assert.equal(button.disabled, true);
console.log("PageLens audiobook connection checks passed");
