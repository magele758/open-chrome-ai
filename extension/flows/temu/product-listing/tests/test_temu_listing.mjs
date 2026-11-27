import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { replayTemuListing } from "../listing.flow.mjs";
import { createTemuListingToolCaller, isTemuDraftEditor } from "../tool-adapter.js";
import { temuApparelPage } from "../apparel-page.js";
import { temuControls } from "../controls.js";
import { temuDecorationPage } from "../decoration-page.js";
import { temuEditorPage } from "../editor-page.js";
import { temuMediaPage } from "../media-page.js";
import { temuSpecPage } from "../spec-page.js";

const category = "https://agentseller.temu.com/goods/create/category";
const editor = "https://agentseller.temu.com/goods/edit?productDraftId=9461&from=menu&st_time=10";
const title = { key: "productEnName", label: "英文商品名称", kind: "text", required: true, value: "" };
const material = { key: "productProperties[22]", label: "主体材质", kind: "select", required: true, options: [], value: "", locator: {} };
const price = {
  key: "productSkuMap.color-size.siteSupplierPriceMap.100", label: "申报价格（CNY）",
  skuGroup: "color-size", skuMember: "siteSupplierPriceMap.100", rowLabels: ["红色", "S"],
};
const images = ["/products/cup/photo.png"];
const input = {
  sites: ["美国站"], categoryPath: ["运动与户外用品", "运动与户外休闲用品", "运动杯"], title: "Water Bottle",
  skus: [{ options: { Color: "红色", Size: "Small" }, price: "19.80" }], mainImages: images,
};

{
  const calls = [];
  const fields = structuredClone([title, material, price]);
  const state = { ok: true, fields, uploads: [{ role: "main", key: "album", multiple: false }], issues: [] };
  const receipt = await replayTemuListing({
    tabId: 1, input,
    async call(tool, args) {
      calls.push([tool, args]);
      if (tool === "temu_category") return { ok: true, href: editor };
      if (tool === "temu_editor_state") return structuredClone(state);
      if (tool === "temu_field_options") return { ok: true, options: [{ label: "不锈钢", value: args.forceLive ? "metal" : "old-metal" }] };
      if (tool === "temu_select" && args.value === "old-metal") return { ok: false, code: "OPTION_MISSING" };
      if (tool === "temu_upload") return { ok: true, status: "verified" };
      if (/^temu_(write|select)$/u.test(tool)) {
        fields.find(field => field.key === args.key).value = args.value;
        return { ok: true, status: "filled" };
      }
      throw new Error("unexpected action: " + tool);
    },
    async suggestFields(product, schema) {
      assert.equal(product, input);
      assert.deepEqual(schema.fields.map(field => ({ key: field.key, options: field.options })), [
        { key: material.key, options: [{ label: "不锈钢", value: "old-metal" }] },
      ]);
      return { values: { [material.key]: "old-metal", unexpected: "discard" } };
    },
  });
  assert.equal(receipt.status, "ready-for-review");
  assert.equal(receipt.verificationComplete, true);
  assert.equal(receipt.draftUrl, editor);
  assert.deepEqual(calls.filter(([tool]) => tool === "temu_write").map(([, args]) => args.value), ["Water Bottle", "19.80"]);
  assert.deepEqual(calls.find(([tool]) => tool === "temu_upload")[1].paths, images);
  assert.deepEqual(calls.filter(([tool]) => tool === "temu_select").map(([, args]) => [args.value, args.query]),
    [["old-metal", "不锈钢"], ["metal", "不锈钢"]]);
  assert.ok(calls.some(([tool, args]) => tool === "temu_field_options" && args.forceLive));
  assert.ok(!calls.some(([tool]) => /save|publish|submit/u.test(tool)));
}

{
  const style = { key: "productProperties[43]", label: "款式", kind: "select", required: true, options: [], locator: {} };
  const unverifiedFacts = { key: "productProperties[45]", label: "副材质", kind: "select", required: true, options: [], locator: {} };
  const sameLabel = { ...style, key: "productProperties[44]", required: false, value: "运动" };
  const fields = structuredClone([title, { ...material, value: "旧材质" }, price, sameLabel]);
  const state = { ok: true, fields, uploads: [{ role: "main", key: "album" }], issues: [], validation: [] };
  const calls = [];
  let modelCalls = 0;
  let uploaded = false;
  const receipt = await replayTemuListing({
    tabId: 1,
    input: { ...input, listingAttributes: { [material.key]: "不锈钢" }, skus: [{ options: { Color: "红色", Size: "Small" } }] },
    async call(tool, args) {
      calls.push([tool, args]);
      if (tool === "temu_category") return { ok: true, href: editor };
      if (tool === "temu_editor_state") return structuredClone(state);
      if (tool === "temu_write" && args.key === title.key) {
        fields[0].value = args.value;
        return { ok: true, status: "filled" };
      }
      if (tool === "temu_select" && args.key === material.key && !uploaded) {
        return { ok: false, code: "READBACK_MISMATCH", message: "旧材质未通过校验" };
      }
      if (tool === "temu_upload") {
        uploaded = true;
        fields.push({ ...style, value: "" }, { ...unverifiedFacts, value: "" });
        state.validation = [{ key: material.key, kind: "select", message: "旧材质未通过校验" },
          { key: price.key, kind: "text", message: "请输入申报价" }];
        return { ok: true, status: "verified" };
      }
      assert.ok(uploaded, "the recovery pass starts after media");
      if (tool === "temu_field_options") {
        assert.equal(args.forceLive, true);
        const approved = new Map([[material.key, { value: "m1", label: "不锈钢" }], [style.key, { value: "s1", label: "休闲" }]]);
        assert.ok(approved.has(args.key), "protect price and unknown material from recovery");
        return { ok: true, options: [approved.get(args.key)] };
      }
      if (tool === "temu_select" && [material.key, style.key].includes(args.key)) {
        const field = fields.find(field => field.key === args.key);
        field.value = args.query;
        state.validation = state.validation.filter(row => row.key !== args.key);
        return { ok: true, status: "filled" };
      }
      throw new Error("unexpected action: " + tool);
    },
    async suggestFields(_product, { fields }) {
      modelCalls++;
      assert.ok(uploaded);
      assert.deepEqual(fields.map(field => field.key), [style.key]);
      return { values: { [style.key]: "s1", [price.key]: "999", [unverifiedFacts.key]: "金属" } };
    },
  });
  assert.equal(modelCalls, 1);
  assert.equal(receipt.status, "needs-review");
  assert.ok(receipt.items.some(item => item.key === style.key && item.status === "filled"));
  assert.ok(!receipt.items.some(item => item.key === material.key && item.status === "needs-review"));
  assert.ok(!receipt.issues.some(issue => issue.key === material.key));
  assert.ok(receipt.issues.some(issue => issue.key === price.key && issue.code === "VALIDATION"));
  assert.ok(receipt.missing.some(field => field.key === unverifiedFacts.key));
  assert.deepEqual(calls.filter(([tool, args]) => tool === "temu_select" && args.key === material.key)
    .map(([, args]) => args.value), ["不锈钢", "m1"]);
}

{
  const field = { key: "productProperties[12]", label: "风格", kind: "text", required: true, value: "" };
  const state = { ok: true, fields: [{ ...title, value: "Water Bottle" }], uploads: [{ role: "main", key: "album" }], issues: [], validation: [] };
  let repairs = 0;
  const receipt = await replayTemuListing({
    tabId: 1, input: { ...input, skus: [], listingAttributes: { [field.key]: "休闲" } },
    async call(tool, args) {
      if (tool === "temu_category") return { ok: true, href: editor };
      if (tool === "temu_editor_state") return structuredClone(state);
      if (tool === "temu_upload") {
        state.fields.push(field);
        state.validation = [{ key: field.key, kind: "text", message: "属性仍需核对" }];
        return { ok: true, status: "verified" };
      }
      if (tool === "temu_write" && args.key === title.key) return { ok: true, status: "unchanged" };
      if (tool === "temu_write" && args.key === field.key) {
        repairs++;
        assert.equal(args.value, "休闲");
        field.value = args.value;
        return { ok: true, status: "filled" };
      }
      throw new Error("unexpected action: " + tool);
    },
  });
  assert.equal(repairs, 1);
  assert.equal(receipt.status, "needs-review");
  assert.ok(receipt.issues.some(issue => issue.key === field.key && issue.message === "属性仍需核对"));
  assert.ok(receipt.items.some(item => item.key === field.key && item.status === "needs-review"));
}

{
  let failed = false;
  const result = await replayTemuListing({
    tabId: 1, input,
    async call(tool) {
      assert.equal(failed, false, "the flow must stop when the page changes");
      if (tool === "temu_category") return { ok: true, href: editor };
      if (tool === "temu_editor_state") return { ok: true, fields: [title], uploads: [], issues: [] };
      failed = true;
      return { ok: false, code: "PAGE_CHANGED" };
    },
  });
  assert.equal(result.status, "needs-review");
  assert.equal(result.code, "PAGE_CHANGED");
  assert.equal(result.verificationComplete, false);
}

{
  assert.ok(isTemuDraftEditor(editor));
  assert.ok(!isTemuDraftEditor(editor + "&productDraftId=2"));
  assert.ok(!isTemuDraftEditor(editor + "&productId=2"));
  assert.ok(!isTemuDraftEditor(editor.replace("agentseller.temu.com", "agentseller.temu.com.attacker.invalid")));
  let url = editor;
  const api = { tabs: { get: async () => ({ url }) }, scripting: { executeScript: async () => {
    throw new Error("Must not touch an existing draft.");
  } } };
  const call = createTemuListingToolCaller({ tabId: 7, url, api, cdp: {} });
  assert.equal((await call("temu_write", { tabId: 7, key: title.key, value: input.title })).code, "ACTION_UNSUPPORTED");
  assert.equal((await call("temu_category", { tabId: 7 })).code, "PAGE_CHANGED");
  const original = createTemuListingToolCaller({ tabId: 7, url: category, api, cdp: {} });
  url = "https://agentseller.temu.com/login";
  assert.equal((await original("temu_category", { tabId: 7 })).code, "PAGE_CHANGED");
}

{
  let url = category;
  let documentId = "category-document";
  const scopes = [];
  const api = { tabs: { get: async () => ({ url }) }, scripting: { async executeScript({ target, args: [request] }) {
    const executedOn = documentId;
    scopes.push(target);
    if (request.kind === "next") {
      url = editor;
      documentId = "editor-document";
    }
    return [{ frameId: 0, documentId: executedOn, result: { ok: true, selector: "#album input" } }];
  } } };
  const call = createTemuListingToolCaller({ tabId: 7, url, api,
    cdp: { async send() { throw new Error("A changed page must never reach the debugger uploader."); } },
    confirmUpload: async () => { url = editor.replace("9461", "1322"); return true; } });
  assert.equal((await call("temu_category", { tabId: 7, site: "美国站", categoryPath: input.categoryPath })).href, editor);
  assert.deepEqual(scopes[1], { tabId: 7, documentIds: ["category-document"] });
  const upload = await call("temu_upload", { tabId: 7, role: "main", key: "album", paths: images });
  assert.equal(upload.code, "PAGE_CHANGED");
  assert.deepEqual(scopes[2], { tabId: 7, frameIds: [0] });
  assert.equal(scopes.length, 3);
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div>运动与户外用品 &gt; 运动与户外休闲用品 &gt; 运动杯</div>
    <div id="productEnName"><textarea maxlength="80"></textarea></div>
    <div id="productAlbum"><div>商品轮播图</div><input type="file" accept="image/*" multiple></div>
    <table><tbody>
      <tr><td rowspan="2">红色</td><td>Small</td><td><div id="productSkuMap.x.siteSupplierPriceMap.1"><input></div></td></tr>
      <tr><td>Medium</td><td><div id="productSkuMap.y.siteSupplierPriceMap.1"><input></div></td></tr>
    </tbody></table>
    <button>创建</button><button>保存草稿</button>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  let submits = 0;
  for (const button of dom.window.document.querySelectorAll("button")) button.addEventListener("click", () => submits++);
  const run = request => dom.window.eval(`(${temuEditorPage.toString()})(${JSON.stringify({ href: editor, ...request })})`);
  const state = await run({ kind: "inspect" });
  assert.ok(state.ok);
  assert.deepEqual(Array.from(state.fields.find(field => field.skuGroup === "y").rowLabels), ["Medium", "红色"]);
  assert.equal(state.uploads[0].role, "main");
  assert.equal((await run({ kind: "write", key: title.key, value: "Water Bottle" })).status, "filled");
  assert.equal((await run({ kind: "write", key: title.key, value: "x".repeat(81) })).code, "VALUE_INVALID");
  assert.equal((await run({ kind: "add-parent-spec" })).code, "SPEC_ADD_MISSING");
  assert.equal((await run({ kind: "inspect", categoryPath: input.categoryPath })).ok, true);
  assert.equal((await run({ kind: "write", categoryPath: ["茶具"], key: title.key, value: "Incorrect" })).code, "EDITOR_LOADING");
  assert.equal(submits, 0);
  const otherScope = await run({ kind: "write", href: editor.replace("9461", "9462"), key: title.key, value: "Other" });
  assert.equal(otherScope.code, "PAGE_CHANGED");
  dom.window.close();
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div id="productEnName"><textarea></textarea></div>
    <div data-testid="beast-core-form-item"><label>风格</label><div id="productProperties[42]">
      <div class="ST_outerWrapper_1"><input aria-invalid="true" aria-describedby="first-error"></div>
      <span id="first-error" class="Form_error_1">请选择此规格的风格</span>
    </div></div>
    <div data-testid="beast-core-form-item"><label>风格</label><div id="productProperties[43]">
      <div class="ST_outerWrapper_2"><input></div>
    </div></div>
    <div id="noCostumeCarouselImgsI18n.common"><div class="upload-trigger_wrap__test">素材中心</div>
      <span class="Form_error_2">图片数量不足</span>
    </div>
  </main><div role="alert">提交失败</div>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const run = request => dom.window.eval(`(${temuEditorPage.toString()})(${JSON.stringify({ href: editor, ...request })})`);
  const state = JSON.parse(JSON.stringify(await run({ kind: "inspect" })));
  assert.deepEqual(state.validation, [
    { key: "productProperties[42]", label: "风格", kind: "select", message: "请选择此规格的风格" },
    { key: "noCostumeCarouselImgsI18n.common", label: "商品轮播图", kind: "upload", message: "图片数量不足" },
    { message: "提交失败" },
  ]);
  assert.deepEqual(state.issues, state.validation.map(finding => finding.message));
  dom.window.close();
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div class="decoration_operate__test"><button>开始装修</button></div>
    <button id="publish">创建</button><button id="save-draft">保存草稿</button>
    <div class="MDL_inner_test" hidden>
      <h2>详情页装修</h2><div class="side-left_sectionItem__test"><span>文本</span></div>
      <textarea placeholder="请输入" hidden></textarea>
      <div class="footer_footer__test"><button>保存</button></div>
    </div>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const doc = dom.window.document;
  const dialog = doc.querySelector(".MDL_inner_test");
  const textarea = dialog.querySelector("textarea");
  let localDescription = "";
  let listingWrites = 0;
  const disallowed = () => { listingWrites++; };
  doc.querySelector("#publish").addEventListener("click", disallowed);
  doc.querySelector("#save-draft").addEventListener("click", disallowed);
  doc.querySelector(".decoration_operate__test button").addEventListener("click", () => { dialog.hidden = false; });
  dialog.querySelector("span").addEventListener("click", () => { textarea.hidden = false; });
  dialog.querySelector("button").addEventListener("click", () => { localDescription = textarea.value; dialog.hidden = true; });
  const description = "A travel cup.\nLid is washable.";
  const receipt = await dom.window.eval(`(${temuDecorationPage.toString()})(${JSON.stringify({ href: editor, description })})`);
  assert.equal(receipt.status, "verified");
  assert.equal(localDescription, description);
  textarea.hidden = true;
  textarea.value = "";
  textarea.maxLength = 8;
  const prepare = await dom.window.eval(`(${temuDecorationPage.toString()})(${JSON.stringify({ href: editor, kind: "prepare", description })})`);
  assert.equal(prepare.ok, true);
  assert.equal(prepare.written, "A travel");
  assert.equal(prepare.detailIssue.code, "DESCRIPTION_TRUNCATED");
  const apply = await dom.window.eval(`(${temuDecorationPage.toString()})(${JSON.stringify({ href: editor, kind: "apply", description: prepare.written })})`);
  assert.equal(apply.status, "verified");
  assert.equal(localDescription, prepare.written);
  assert.equal(listingWrites, 0);
  dom.window.close();
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div><div id="minorSpec.0.selectedRootSpecId"><input></div>
    <table><thead><tr><th>* 颜色</th><th>操作</th></tr></thead><tbody><tr><td><input placeholder="请输入"></td>
      <td><button>+ 继续添加子规格</button></td></tr></tbody></table></div>
    <div id="noCostumeCarouselImgsI18n.common"><div class="upload-trigger_wrap__test"><span>素材中心</span></div></div>
    <div class="MDL_inner_test" hidden>
      <h2>素材中心</h2><div class="UPD_outerWrapper_test"><input type="file" multiple></div>
      <div class="cards"><div><img src="https://cdn.invalid/old"><span>main</span></div></div>
      <span class="selected">已选 0 个，可选 10 个</span><button>确认</button>
    </div>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const run = (script, request) => dom.window.eval(`(${script.toString()})(${JSON.stringify({ href: editor, ...request })})`);
  const doc = dom.window.document;
  const table = doc.querySelector("table");
  table.querySelector("button").addEventListener("click", () => { table.querySelector("tbody").insertAdjacentHTML("beforeend",
    '<tr><td><input placeholder="请输入"></td><td></td></tr>'); });
  const spec = await run(temuSpecPage, { parentIndex: 0, labels: ["颜色", "Color"], values: ["Sugar High", "Off the Grid"] });
  assert.equal(spec.ok, true);
  assert.deepEqual([...table.querySelectorAll("input")].map(input => input.value), ["Sugar High", "Off the Grid"]);
  const dialog = doc.querySelector(".MDL_inner_test");
  doc.querySelector("#page_container_id [class^=upload-trigger_wrap__] span").addEventListener("click", () => { dialog.hidden = false; });
  const action = args => run(temuMediaPage, { key: "noCostumeCarouselImgsI18n.common", filenames: ["main"], ...args });
  const opened = await action({ kind: "open" });
  assert.equal(opened.count, 0);
  let oldClicks = 0;
  dialog.querySelector("img").addEventListener("click", () => { oldClicks++; });
  assert.equal((await action({ kind: "select-new", previous: opened.knownMedia, baseline: 0 })).code, "UPLOAD_PENDING");
  dialog.querySelector(".cards").insertAdjacentHTML("afterbegin", '<div><img src="https://cdn.invalid/new"><span>main</span></div>');
  dialog.querySelector("img").addEventListener("click", () => { dialog.querySelector(".selected").textContent = "已选 1 个，可选 10 个"; });
  dialog.querySelector("button").addEventListener("click", () => { dialog.hidden = true; });
  assert.equal((await action({ kind: "select-new", previous: opened.knownMedia, baseline: 0 })).count, 1);
  assert.equal((await action({ kind: "confirm", baseline: 0, added: 1 })).ok, true);
  assert.equal(oldClicks, 0);
  dom.window.close();
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div id="productName"><textarea></textarea></div>
    <div class="clothing-colors">
      <div id="productSkcList[0].mainSpec[0]"><input placeholder="选择或自定义颜色"></div>
      <div id="productSkcList[0].carouselImgsI18n.common"><div class="upload-trigger_wrap__test">素材中心</div></div>
      <div class="product-skc_specItem__test"><a>+ 添加</a></div>
    </div>
    <div class="product-skc_specItem__size">
      <div data-testid="beast-core-form-item"><span>*尺码</span><span>建议发布精准信息</span>
        <div class="ST_outerWrapper_test"><div class="ST_head_test">
          <input data-testid="beast-core-select-htmlInput" placeholder="请选择" readonly>
          <span data-testid="beast-core-input-suffix"></span></div></div></div>
    </div>
    <div id="productProperties[15]">
      <table><tbody><tr><td><div class="ST_outerWrapper_test"><div class="ST_head_test"><input placeholder="请选择"></div></div></td>
      <td><input placeholder="请输入">%</td></tr></tbody></table><a>添加</a>
    </div>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const doc = dom.window.document;
  const run = (script, request) => dom.window.eval(`(${script.toString()})(${JSON.stringify({ scope: { href: editor }, href: editor, ...request })})`);
  const row = doc.querySelector(".clothing-colors");
  row.querySelector("a").addEventListener("click", () => {
    row.insertAdjacentHTML("afterbegin", '<div id="productSkcList[1].mainSpec[0]"><input placeholder="选择或自定义颜色"></div>');
  });
  assert.equal((await run(temuApparelPage, { kind: "inspect" })).rows.length, 1);
  const first = "productSkcList[0].mainSpec[0]";
  assert.equal((await run(temuApparelPage, { kind: "set-color", key: first, value: "黑白条纹" })).status, "filled");
  assert.equal((await run(temuApparelPage, { kind: "set-color", key: first, value: "橙色条纹" })).code, "SPEC_VALUES_OCCUPIED");
  assert.equal((await run(temuApparelPage, { kind: "add-color" })).rows.length, 2);
  const state = await run(temuEditorPage, { kind: "inspect" });
  assert.equal(state.uploads[0].variant, "黑白条纹");
  const fields = await run(temuControls, { kind: "inspect" });
  assert.ok(fields.fields.some(field => field.key === "apparel-size"));
  assert.ok(fields.fields.some(field => field.key === "composition-material-0"));
  const sizeHolder = doc.querySelector(".product-skc_specItem__size");
  sizeHolder.querySelector('[data-testid="beast-core-input-suffix"]').addEventListener("click", () => {
    sizeHolder.insertAdjacentHTML("beforeend", '<div role="option">欧美尺码</div>');
    const option = sizeHolder.querySelector('[role="option"]');
    option.addEventListener("click", () => {
      sizeHolder.querySelector("input").value = "欧美尺码";
      option.remove();
      sizeHolder.insertAdjacentHTML("beforeend", '<label><input type="checkbox">S<span>HOT</span></label>');
    });
  });
  const sizes = await run(temuApparelPage, { kind: "set-sizes", value: { system: "欧美尺码", sizes: ["S"] } });
  assert.equal(sizes.status, "verified");
  assert.equal(sizeHolder.querySelector('input[type="checkbox"]').checked, true);
  const pct = await run(temuApparelPage, { kind: "composition-percentage", key: 0, value: "95" });
  assert.equal(pct.status, "filled");
  assert.equal(doc.getElementById("productProperties[15]").querySelector('input[placeholder="请输入"]').value, "95");
  dom.window.close();
}

console.log("Temu listing flow applies and verifies only its pinned newly created draft.");
