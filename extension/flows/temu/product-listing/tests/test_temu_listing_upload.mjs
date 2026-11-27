import assert from "node:assert/strict";
import { temuDecorationPage } from "../decoration-page.js";
import { temuEditorPage } from "../editor-page.js";
import { temuMediaPage } from "../media-page.js";
import { temuStagePage } from "../stage1.js";
import { createTemuListingToolCaller } from "../tool-adapter.js";

const tabId = 7;
const category = "https://agentseller.temu.com/goods/create/category";
const editor = "https://agentseller.temu.com/goods/edit?productDraftId=9461";
const redGallery = "productSkcList[0].carouselImgsI18n.common";
const blueGallery = "productSkcList[1].carouselImgsI18n.common";
const red = "/products/shirt/red/main.jpg";
const blue = "/products/shirt/blue/main.jpg";
const fabric = "/products/shirt/shared/fabric.jpg";
const fit = "/products/shirt/shared/fit.jpg";
const detail = "/products/shirt/details/front.jpg";
const filename = path => path.split("/").at(-1).replace(/\.jpg$/u, "");

async function listingFixture({ uploadError, writeError, permitted = true, automaticSelection = false } = {}) {
  let url = category;
  let documentId = "category-document";
  let selectedFile;
  let selected = [];
  const events = [];
  const approvals = [];
  const actualUploads = [];
  const assets = new Map();
  const slots = new Map();
  const api = { tabs: { get: async () => ({ url }) }, scripting: { async executeScript({ target, func, args: [request] }) {
    assert.equal(target.tabId, tabId);
    const replyDocument = documentId;
    let result;
    if (func === temuStagePage) {
      if (request.kind === "next") {
        url = editor;
        documentId = "new-draft-document";
      }
      result = { ok: true };
    } else if (func === temuEditorPage) {
      events.push(["editor", request.kind]);
      assert.equal(request.href, editor);
      assert.equal(request.kind, "upload-target");
      const gallery = slots.get(request.key) || [];
      result = { ok: true, mode: "material", markers: gallery.length, images: gallery.map(card => card.src) };
    } else if (func === temuDecorationPage) {
      events.push(["decoration", request.kind, request]);
      assert.equal(request.href, editor);
      if (request.kind === "write") {
        result = writeError ? { ok: false, code: writeError } : { ok: true, written: "Verified detail description" };
      } else result = { ok: true };
    } else if (func === temuMediaPage) {
      const { kind, key, filenames, previous, expected, name, baseline, added } = request;
      events.push(["media", kind, request]);
      assert.equal(request.href, editor);
      const knownMedia = [...assets.values()].filter(card => filenames.includes(card.filename));
      const snapshot = () => ({ ok: true, count: selected.length, available: 10 - selected.length,
        ordered: key.startsWith("productSkcList["), selector: "#picker input[type=file]", knownMedia });
      switch (kind) {
        case "detail-target":
          assert.equal(key, "decoration-images");
          result = { ok: true, x: 103, y: 219 };
          break;
        case "open":
          assert.equal(request.trustedHover, key === "decoration-images");
          selected = [];
          result = snapshot();
          break;
        case "inspect":
          result = snapshot();
          break;
        case "settle-upload": {
          assert.equal(name, filename(selectedFile));
          assert.deepEqual(previous, knownMedia);
          if (uploadError) {
            result = { ok: false, code: uploadError };
            break;
          }
          const identity = `material-${actualUploads.length}`;
          const card = { filename: name, identity, src: `https://cdn.invalid/${identity}.jpg` };
          assets.set(selectedFile, card);
          if (automaticSelection) selected.push(card);
          result = { ok: true, card };
          break;
        }
        case "select-new":
          assert.equal(baseline, selected.length);
          assert.deepEqual(expected.map(card => card.filename), filenames);
          selected.push(...expected);
          result = { ok: true, media: expected };
          break;
        case "confirm":
          assert.equal(selected.length, baseline + added);
          slots.set(key, selected);
          result = { ok: true };
          break;
        case "cancel":
          selected = [];
          result = { ok: true };
          break;
        default:
          throw new Error("Unexpected material command " + kind);
      }
    } else throw new Error("Unexpected page function");
    return [{ frameId: 0, documentId: replyDocument, result }];
  } } };
  const cdp = { async send(target, command, params) {
    assert.equal(target, tabId);
    if (command === "Input.dispatchMouseEvent") {
      assert.deepEqual(params, { type: "mouseMoved", x: 103, y: 219 });
      return {};
    }
    if (command === "Runtime.evaluate") return { result: { objectId: "current-file-input" } };
    if (command === "DOM.setFileInputFiles") {
      assert.equal(params.objectId, "current-file-input");
      assert.equal(params.files.length, 1);
      [selectedFile] = params.files;
      actualUploads.push(selectedFile);
      events.push(["cdp", "files"]);
    } else assert.equal(command, "Runtime.releaseObject");
    return {};
  } };
  const invoke = createTemuListingToolCaller({ tabId, url, api, cdp, confirmUpload: async request => {
    approvals.push(request);
    return permitted;
  } });
  const call = (tool, args) => invoke(tool, { tabId, ...args });
  assert.equal((await call("temu_category", { site: "美国站", categoryPath: ["女装T恤"] })).href, editor);
  return { call, events, approvals, actualUploads, assets, slots };
}

{
  const { call, assets, slots, actualUploads, approvals } = await listingFixture();
  const gallery = (key, paths) => call("temu_upload", { role: "variant", key, paths });
  assert.equal((await gallery(redGallery, [red, fabric, fit])).status, "verified");
  assert.equal((await gallery(blueGallery, [blue, fabric, fit])).status, "verified");
  assert.deepEqual(actualUploads, [red, fabric, fit, blue]);
  assert.deepEqual(slots.get(redGallery), [red, fabric, fit].map(path => assets.get(path)));
  assert.deepEqual(slots.get(blueGallery), [blue, fabric, fit].map(path => assets.get(path)));
  assert.notEqual(assets.get(red).identity, assets.get(blue).identity, "equal file basenames must not share the source receipt");
  assert.deepEqual(approvals.map(entry => entry.paths), [[red, fabric, fit], [blue, fabric, fit]]);
}

{
  const { call, events, approvals } = await listingFixture();
  const result = await call("temu_description", { description: "Text without images", paths: [] });
  assert.equal(result.code, "DETAIL_IMAGE_REQUIRED");
  assert.deepEqual(events, []);
  assert.deepEqual(approvals, []);
}

{
  const { call, events } = await listingFixture({ permitted: false });
  assert.equal((await call("temu_description", { description: "Never opened", paths: [detail] })).code, "UPLOAD_DENIED");
  assert.deepEqual(events, []);
}

{
  const { call, events } = await listingFixture({ uploadError: "UPLOAD_REJECTED" });
  assert.equal((await call("temu_description", { description: "Never saved", paths: [detail] })).code, "UPLOAD_REJECTED");
  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ["decoration", "begin"], ["media", "detail-target"], ["media", "open"], ["cdp", "files"],
    ["media", "settle-upload"], ["media", "cancel"], ["decoration", "cancel"],
  ]);
}

{
  const { call, events } = await listingFixture({ writeError: "DETAIL_IMAGE_REQUIRED" });
  assert.equal((await call("temu_description", { description: "Image absent from preview", paths: [detail] })).code, "DETAIL_IMAGE_REQUIRED");
  assert.deepEqual(events.filter(([type]) => type === "decoration").map(([, kind]) => kind), ["begin", "write", "cancel"]);
}

for (const automaticSelection of [false, true]) {
  const { call, events, assets } = await listingFixture({ automaticSelection });
  assert.equal((await call("temu_description", { description: "Input detail description", paths: [detail] })).uploaded, 1);
  const edits = events.filter(([type]) => type === "decoration");
  assert.deepEqual(edits.map(([, kind]) => kind), ["begin", "write", "apply"]);
  assert.deepEqual(edits.slice(1).map(([, , request]) => request.images), [[assets.get(detail).src], [assets.get(detail).src]]);
  assert.equal(edits.at(-1)[2].description, "Verified detail description");
  assert.equal(events.some(([, kind]) => kind === "select-new"), !automaticSelection);
}

console.log("Temu upload adapter preserves gallery asset lineage and only saves decoration after image verification.");
