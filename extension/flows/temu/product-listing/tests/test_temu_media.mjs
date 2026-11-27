import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuDecorationPage } from "../decoration-page.js";
import { temuMediaPage } from "../media-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=9461";

function fixture(html) {
  const dom = new JSDOM(`<main id="page_container_id">${html}</main>`, { url: href, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = () => [{}];
  return {
    dom, doc: dom.window.document,
    run: (page, request) => dom.window.eval(`(${page.toString()})(${JSON.stringify({ href, ...request })})`),
  };
}

{
  const key = "productSkcList[0].carouselImgsI18n.common";
  const filenames = ["red-main", "fabric", "fit"];
  const uploadList = '<div data-testid="beast-core-portal" class="PP_popover_test"><div class="PP_popoverContent_test"><div class="index-module_modalContainer__test"><header>上传列表</header></div></div></div>';
  const { dom, doc, run } = fixture(`
    <div id="${key}"><div class="upload-trigger_wrap__test"><span>素材中心</span></div></div>
    <div data-testid="beast-core-modal-mask" id="material-mask">
      <div data-testid="beast-core-modal"><div class="MDL_inner_picker" hidden><h2>素材中心</h2><a id="refresh-picker">刷新</a><div class="UPD_outerWrapper_test"><input type="file"></div>
        <div id="cards"></div><div id="count">已选 0 个，可选 10 个</div><button>确认</button></div>
      </div>
    </div>
    <div data-testid="beast-core-modal-mask" id="unrelated-mask">${uploadList}</div>
    <div class="MDL_inner_upload" hidden><h2>本地上传</h2><button id="upload-save">保存</button></div>
    <div class="MDL_inner_crop" hidden><h2>裁剪</h2><button id="crop-submit">确认裁剪</button></div>
    <div class="MDL_inner_unexpected" hidden><h2>其他弹窗</h2><button id="unrelated-save">保存</button></div>
    <button id="page-save">保存</button><a id="refresh-page">刷新</a>`);
  const picker = doc.querySelector(".MDL_inner_picker");
  const upload = doc.querySelector(".MDL_inner_upload");
  const crop = doc.querySelector(".MDL_inner_crop");
  const unrelated = doc.querySelector(".MDL_inner_unexpected");
  const mask = doc.querySelector("#material-mask");
  const cards = doc.querySelector("#cards");
  const count = doc.querySelector("#count");
  const events = [];
  const clicked = [];
  let file;

  function addCard(name, identity) {
    cards.insertAdjacentHTML("afterbegin", `
      <div class="index-module_itemContainer__test"><div class="index-module_cardContainer__test" data-material-id="${identity}">
        <div class="index-module_cover__test"><div class="index-module_imageContainer__test"><img width="144" src="https://cdn.invalid/${identity}?thumbnail=1"></div></div>
        <div class="index-module_itemContent__test">
          <div class="index-module_materialName__test"><div data-testid="beast-core-ellipsis"><div class="elli_outerWrapper_test">${name}.jpg</div></div></div>
          <img class="status-badge" src="https://cdn.invalid/status-${identity}.png">
        </div>
      </div></div>`);
    cards.firstElementChild.querySelector('[class*="index-module_imageContainer__"] > img').addEventListener("click", () => {
      clicked.push(identity);
      count.textContent = `已选 ${clicked.length} 个，可选 ${10 - clicked.length} 个`;
    });
  }
  addCard("red-main", "old-red");
  addCard("fabric-17", "old-fabric");
  doc.querySelector('[class^="upload-trigger_wrap__"] span').onclick = () => { picker.hidden = false; };
  picker.querySelector("button").onclick = () => { picker.hidden = true; };
  doc.querySelector("#crop-submit").onclick = () => { events.push("crop:" + file); crop.hidden = true; };
  doc.querySelector("#upload-save").onclick = () => {
    events.push("save:" + file);
    upload.hidden = true;
    if (file !== "fabric") addCard(file, file + "-new");
    mask.insertAdjacentHTML("beforeend", uploadList);
  };
  doc.querySelector("#refresh-picker").onclick = () => {
    events.push("refresh:" + file);
    addCard("fabric-9", "fabric-new");
  };
  picker.querySelector("h2").addEventListener("mousedown", () => {
    const portal = mask.querySelector('[data-testid="beast-core-portal"]');
    assert.ok(portal, "click away must be sent once for the active upload header");
    events.push("dismiss:" + file);
    dom.window.setTimeout(() => {
      if (file === "fit") {
        portal.style.opacity = "0";
        portal.style.pointerEvents = "none";
      } else portal.remove();
    }, 100);
  });
  doc.querySelector("#unrelated-save").onclick = () => events.push("unrelated-save");
  doc.querySelector("#page-save").onclick = () => events.push("page-save");
  doc.querySelector("#refresh-page").onclick = () => events.push("page-refresh");
  const media = args => run(temuMediaPage, { key, filenames, ...args });
  const opened = await media({ kind: "open" });
  assert.equal(opened.ordered, true);
  assert.equal(opened.multiple, false);
  assert.equal(opened.available, 10);
  assert.equal(doc.querySelector(opened.selector).type, "file");

  unrelated.hidden = false;
  assert.equal((await media({ kind: "settle-upload", name: filenames[0], previous: opened.knownMedia })).code, "MODAL_BLOCKED");
  unrelated.hidden = true;
  const expected = [];
  for (const name of filenames) {
    const before = await media({ kind: "inspect" });
    file = name;
    if (name === "red-main") {
      addCard(name, name + "-new");
      mask.insertAdjacentHTML("beforeend", uploadList);
    } else {
      upload.hidden = false;
      crop.hidden = false;
    }
    const result = await media({ kind: "settle-upload", name, previous: before.knownMedia });
    assert.equal(result.ok, true);
    assert.equal(result.card.identity, name + "-new");
    assert.equal(result.card.filename, name);
    assert.equal(result.card.libraryFilename, name === "fabric" ? "fabric-9" : name);
    const portal = mask.querySelector('[data-testid="beast-core-portal"]');
    if (name === "fit") assert.equal(portal.style.pointerEvents, "none");
    else assert.equal(portal, null);
    expected.push(result.card);
  }
  assert.ok(doc.querySelector('#unrelated-mask [data-testid="beast-core-portal"]'));
  assert.equal(cards.firstElementChild.firstElementChild.dataset.materialId, "fit-new");
  const selected = await media({ kind: "select-new", baseline: 0, previous: opened.knownMedia, expected });
  assert.equal(selected.ok, true);
  assert.deepEqual(Array.from(selected.media, item => item.src), filenames.map(name => `https://cdn.invalid/${name}-new`));
  assert.deepEqual(clicked, filenames.map(name => name + "-new"));
  assert.deepEqual(events, ["dismiss:red-main", "crop:fabric", "save:fabric", "dismiss:fabric", "refresh:fabric",
    "crop:fit", "save:fit", "dismiss:fit"]);
  assert.equal((await media({ kind: "confirm", baseline: 0, added: filenames.length })).ok, true);
  dom.window.close();
}

{
  function libraryTile(name, id) {
    return `<div class="index-module_itemContainer__test" id="material-${id}"><div class="index-module_cardContainer__test">
      <div class="index-module_cover__test"><div class="index-module_imageContainer__test"><img width="144" src="https://img.kwcdn.com/product/fancy/${id}.jpg?imageMogr2/thumbnail/144x"></div></div>
      <div class="index-module_itemContent__test"><div class="index-module_materialName__test"><div data-testid="beast-core-ellipsis"><div class="elli_outerWrapper_test">${name}</div></div></div></div>
    </div></div>`;
  }
  const { dom, doc, run } = fixture(`
    <div class="MDL_inner_picker"><h2>素材中心</h2><div class="UPD_outerWrapper_test"><input type="file"></div>
      <span id="count">已选 0 个，可选 10 个</span>
      ${libraryTile("original-shared", "123")}${libraryTile("another", "234")}
    </div>
    <div data-testid="beast-core-modal-container">
      <div class="MDL_inner_duplicate" data-testid="beast-core-modal-inner">
        <div class="MDL_noHeader_test" data-testid="beast-core-modal-body">
          <div class="index-module_container__test">
            <div class="index-module_title__test"><svg aria-hidden="true"></svg>素材中心已有如下素材，无需重复上传</div>
            <div class="index-module_materialContainer__test">
              <div class="index-module_materialItem__test"><div class="index-module_materialName__test">
                <span id="duplicate-filename">other-image.jpg</span>
              </div></div>
            </div>
          </div>
        </div>
        <div class="MDL_bottom_test"><button id="view-duplicate">在列表中查看</button><button id="close-duplicate">关闭</button></div>
      </div>
    </div>`);
  const duplicate = doc.querySelector(".MDL_inner_duplicate");
  const modal = duplicate.closest('[data-testid="beast-core-modal-container"]');
  const count = doc.querySelector("#count");
  const candidate = doc.querySelector("#material-123");
  const events = [];
  doc.querySelector("#view-duplicate").onclick = () => { events.push("list"); };
  doc.querySelector("#close-duplicate").onclick = () => {
    events.push("close");
    modal.hidden = true;
  };
  candidate.querySelector("img").onclick = () => {
    events.push("select");
    count.textContent = "已选 1 个，可选 9 个";
  };
  const media = args => run(temuMediaPage, { key: "productSkcList[1].carouselImgsI18n.common", filenames: ["renamed-copy"], ...args });
  const settle = { kind: "settle-upload", name: "renamed-copy", localFilename: "renamed-copy.jpg", baseline: 0 };
  assert.equal((await media(settle)).code, "UPLOAD_UNVERIFIED");
  assert.deepEqual(events, []);
  doc.querySelector("#duplicate-filename").textContent = "renamed-copy.jpg";
  const material = doc.querySelector('[class^="index-module_materialItem__"]');
  const additional = material.cloneNode(true);
  material.after(additional);
  assert.equal((await media(settle)).code, "UPLOAD_UNVERIFIED");
  additional.remove();
  assert.deepEqual(events, []);
  assert.equal((await media(settle)).code, "UPLOAD_DUPLICATE_UNVERIFIED");
  assert.deepEqual(events, ["close"]);
  assert.equal(modal.hidden, true);
  assert.equal((await media({ kind: "inspect" })).count, 0);
  modal.hidden = false;
  candidate.querySelector(".elli_outerWrapper_test").textContent = "renamed-copy";
  const result = await media(settle);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.card.filename, "renamed-copy");
  assert.equal(result.card.libraryFilename, "renamed-copy");
  assert.equal(result.card.src, "https://img.kwcdn.com/product/fancy/123.jpg");
  assert.deepEqual(events, ["close", "close"]);
  const snapshot = await media({ kind: "inspect", expected: [result.card] });
  assert.equal(snapshot.count, 0);
  assert.equal(snapshot.knownMedia[0].identity, result.card.identity);
  const select = await media({ kind: "select-new", baseline: 0, expected: [result.card] });
  assert.equal(select.count, 1);
  assert.deepEqual(events, ["close", "close", "select"]);
  dom.window.close();
}

for (const menuLocation of ["synthetic", "same-mask", "body-portal"]) {
  const trustedHover = menuLocation !== "synthetic";
  const { dom, doc, run } = fixture(`
    <div data-testid="beast-core-modal-mask" id="decoration-mask">
      <div data-testid="beast-core-modal"><div class="MDL_inner_decoration"><h2>详情页装修</h2>
        <div class="editor_editor__test"><div class="side-left_left__test"><div class="side-left_sectionBox__test">
          <div draggable="true"><div class="side-left_sectionItem__test" id="picture"><span>图片</span></div></div>
        </div></div></div>
        <div id="wrong-entry"><span>从素材中心添加</span></div>
      </div></div>
    </div>
    <div class="MDL_inner_picker" hidden><h2>素材中心</h2><div class="UPD_outerWrapper_test"><input type="file"></div>
      <span>已选 0 个，可选 10 个</span></div>`);
  const picker = doc.querySelector(".MDL_inner_picker");
  const picture = doc.querySelector("#picture");
  const activations = [];
  const reveal = () => {
    const owner = menuLocation === "body-portal" ? doc.body : doc.querySelector("#decoration-mask");
    owner.insertAdjacentHTML("beforeend", `
      <div data-testid="beast-core-portal"><div id="material-hint"><div id="material-title">从素材中心添加</div><p>快速选择已有素材</p></div></div>`);
    doc.querySelector("#material-hint").onclick = () => { activations.push("picker"); picker.hidden = false; };
  };
  picture.addEventListener("mouseover", event => {
    assert.equal(trustedHover, false, "with trusted hover the menu should already be present, with no extra synthetic gesture");
    assert.equal(event.relatedTarget, doc.documentElement);
    reveal();
  });
  doc.querySelector("#wrong-entry").onclick = () => activations.push("wrong-entry");
  const media = args => run(temuMediaPage, { key: "decoration-images", filenames: ["detail"], ...args });
  if (trustedHover) {
    doc.querySelector(".MDL_inner_decoration").getBoundingClientRect = () => ({ left: 20, top: 20, right: 800, bottom: 500 });
    picture.getBoundingClientRect = () => ({ left: 40, top: 100, right: 120, bottom: 200 });
    doc.elementFromPoint = () => doc.querySelector("#wrong-entry");
    assert.equal((await media({ kind: "detail-target" })).code, "DETAIL_HOVER_TARGET_BLOCKED");

    const sidebar = doc.querySelector('[class^="side-left_left__"]');
    sidebar.style.overflowY = "auto";
    sidebar.getBoundingClientRect = () => ({ left: 30, top: 20, right: 170, bottom: 300 });
    Object.defineProperties(sidebar, { scrollHeight: { value: 700 }, clientHeight: { value: 280 } });
    picture.getBoundingClientRect = () => ({ left: 40, top: 500 - sidebar.scrollTop, right: 120, bottom: 600 - sidebar.scrollTop });
    doc.elementFromPoint = (x, y) => x === 80 && y === 250 ? picture.querySelector("span") : null;
    doc.body.insertAdjacentHTML("beforeend", '<div class="MDL_inner_foreign" id="foreign-modal"><h2>其它弹窗</h2></div>');
    assert.equal((await media({ kind: "detail-target" })).code, "MODAL_BLOCKED");
    assert.equal(sidebar.scrollTop, 0);
    doc.querySelector("#foreign-modal").remove();
    const hit = await media({ kind: "detail-target" });
    assert.equal(hit.ok, true);
    assert.deepEqual([hit.x, hit.y], [80, 250]);
    assert.equal(sidebar.scrollTop, 300);
    assert.equal(doc.body.scrollTop, 0);
    reveal();
  }
  if (menuLocation === "body-portal") {
    doc.body.insertAdjacentHTML("beforeend", '<div id="distant-menu"><div id="distant-title">从素材中心添加</div><p>快速选择已有素材</p></div>');
    doc.querySelector("#distant-menu").onclick = () => activations.push("distant-menu");
    const title = doc.querySelector("#material-title");
    const distant = doc.querySelector("#distant-title");
    title.getBoundingClientRect = () => ({ left: 90, top: 318, width: 100, height: 20 });
    distant.getBoundingClientRect = () => ({ left: 610, top: 318, width: 100, height: 20 });
    doc.elementFromPoint = (x, y) => x === 140 && y === 328 ? title : distant;
  }
  const result = await media({ kind: "open", trustedHover });
  assert.equal(result.ok, true);
  assert.equal(doc.querySelector(result.selector).type, "file");
  assert.deepEqual(activations, ["picker"]);
  dom.window.close();
}

{
  const { dom, doc, run } = fixture(`
    <div class="decoration_operate__test"><button>开始装修</button></div>
    <div class="MDL_inner_decoration" hidden><h2>详情页装修</h2><div class="side-left_sectionItem__test"><span>文本</span></div>
      <div id="preview"></div><textarea placeholder="请输入" hidden></textarea><button id="save">保存</button></div>`);
  const dialog = doc.querySelector(".MDL_inner_decoration");
  const editor = dialog.querySelector("textarea");
  const description = "Item dimensions as pictured.";
  const images = ["https://cdn.invalid/gallery/detail.jpg"];
  const decorate = args => run(temuDecorationPage, { description, hasImages: true, ...args });
  let saved = "";
  doc.querySelector('[class^="decoration_operate__"] button').onclick = () => { dialog.hidden = false; };
  dialog.querySelector("span").onclick = () => { editor.hidden = false; };
  doc.querySelector("#save").onclick = () => { saved = editor.value; dialog.hidden = true; };

  assert.equal((await decorate({ kind: "begin" })).ok, true);
  assert.equal(editor.hidden, true);
  assert.equal((await decorate({ kind: "apply", images })).code, "DETAIL_IMAGE_REQUIRED");
  assert.equal(saved, "");
  doc.querySelector("#preview").innerHTML = `<img src="${images[0]}?width=600">`;
  const written = await decorate({ kind: "write", images });
  assert.equal(written.written, description);
  assert.equal((await decorate({ kind: "apply", images, description: written.written })).status, "verified");
  assert.equal(saved, description);
  dom.window.close();
}

console.log("Temu material picker crops and saves verified local images, and selects them in slot order before saving details.");
