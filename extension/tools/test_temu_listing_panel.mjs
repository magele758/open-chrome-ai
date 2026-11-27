import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { bindTemuListingPanel } from "../sidepanel/temu-listing-panel.js";
import { normalizeTemuListingInput } from "../flows/temu/product-listing/input.js";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "https://pagelens.test/sidepanel/",
  pretendToBeVisual: true,
});
globalThis.document = dom.window.document;
Object.assign(dom.window.HTMLDialogElement.prototype, {
  showModal() { this.open = true; },
  close() {
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  },
});
globalThis.chrome = { permissions: { contains: async () => true, request: async () => true } };
const fetchImpl = async url => new Response(await readFile(url));
const get = selector => document.querySelector(selector);
const inputText = (field, text) => {
  field.value = text;
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const clickChoice = (id, label) => {
  const option = [...get(`#temu-${id}`).querySelectorAll(".temu-select-option")].find(row => row.textContent === label);
  assert.ok(option, label);
  option.click();
};
const value = id => get(`#temu-${id}-value`).textContent;
const openSelect = id => get(`#temu-${id} .temu-select-trigger`).click();
const category = { id: "cup", ids: ["sport", "outdoors", "cup"], path: ["运动与户外用品", "运动与户外休闲用品", "运动杯"] };
const product = { title: "Water Bottle", input: normalizeTemuListingInput({ title: "Water Bottle" }) };
let navigation;
let replayed;
let recommended = [];
let picked = 0;
let back = 0;
const open = bindTemuListingPanel({
  getTargetTab: async () => ({ id: 4, url: "https://agentseller.temu.com/goods/list" }),
  onBack: () => back++,
  fetchImpl,
  chooseDirectory: async () => ++picked === 1
    ? { directoryName: "跨境", products: [product], issues: [] } : null,
  suggestCategory: async ({ title, operatorNotes }, { useModel }) => {
    recommended.push([title, operatorNotes, useModel]);
    return { category, source: useModel ? "model" : "local" };
  },
  openTab: async options => {
    navigation = options;
    return { id: 5, url: options.href };
  },
  replay: async args => {
    replayed = args;
    return { status: "verified", items: [{ status: "verified" }], issues: [], missing: [] };
  },
});
await open();
assert.equal(value("listing-site"), "美国站");
assert.equal(value("listing-origin"), "中国大陆");
assert.equal(value("listing-region"), "浙江省");
assert.equal(get(".temu-listing-dialog datalist, .temu-listing-dialog input[type=text]"), null);
assert.equal(get(".temu-listing-header").firstElementChild.getAttribute("aria-label"), "返回工作流");
assert.equal(get(".temu-listing-header").lastElementChild.getAttribute("aria-label"), "关闭");
assert.equal(navigation, undefined);

openSelect("listing-site");
clickChoice("listing-site", "加拿大站");
assert.equal(dom.window.localStorage.getItem("pagelens.temu.listingSite"), "加拿大站");

get('[data-action="choose"]').click();
await delay(15);
assert.equal(get("#temu-directory-summary").textContent, "Water Bottle");
assert.deepEqual(recommended, [["Water Bottle", "", false]]);
assert.match(value("listing-category"), /运动杯/);
assert.match(get("#temu-category-hint").textContent, /已按商品资料匹配/);
assert.equal(value("listing-site"), "加拿大站");
get('[data-action="choose"]').click();
await delay(10);
assert.equal(get("#temu-directory-summary").textContent, "Water Bottle");

assert.equal(get("#temu-product-json"), null);
const notes = get("#temu-product-notes");
inputText(notes, "附带蓝色盖子");
assert.equal(value("listing-category"), "选择类目");
await delay(440);
assert.deepEqual(recommended, [["Water Bottle", "", false], ["Water Bottle", "附带蓝色盖子", false]]);

openSelect("listing-origin");
await delay(20);
clickChoice("listing-origin", "中国大陆");
openSelect("listing-region");
await delay(20);
clickChoice("listing-region", "广东省");
assert.equal(value("listing-region"), "广东省");

assert.equal(get('[data-action="run"]').textContent, "开始上品");
get('[data-action="run"]').click();
await delay(10);
assert.equal(navigation.href, "https://agentseller.temu.com/goods/create/category");
assert.equal(navigation.tab.id, 4);
assert.equal(navigation.accepts(navigation.href), true);
assert.equal(replayed.tabId, 5);
assert.deepEqual(replayed.input.sites, ["加拿大站"]);
assert.deepEqual(replayed.input.categoryPath, category.path);
assert.deepEqual(replayed.input.origin, { country: "中国大陆", region: "广东省" });
assert.equal(replayed.input.operatorNotes, "附带蓝色盖子");

openSelect("listing-category");
await delay(25);
const search = get("#temu-listing-category-menu input");
inputText(search, "运动杯");
await delay(360);
clickChoice("listing-category", category.path.join(" › "));
assert.match(value("listing-category"), /运动杯/);
assert.equal(get("#temu-listing-category-menu").hidden, true);
assert.equal(get("#temu-category-hint").textContent, "");

get('[data-action="back"]').click();
assert.equal(back, 1);
assert.equal(get(".temu-listing-dialog").open, false);
await open();
assert.equal(value("listing-site"), "加拿大站");
dom.window.close();
console.log("Temu listing selector, directory, recommendation, and auto-navigation verified.");
