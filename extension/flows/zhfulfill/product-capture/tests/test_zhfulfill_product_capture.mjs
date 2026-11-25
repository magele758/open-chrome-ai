import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readZhFulfillProduct } from "../page-state.js";

const productId = "2121853980010233856";
const origin = "https://erp.zhfulfill.com";
const prefix = "https://zh-img-com.oss-accelerate.aliyuncs.com/";
const url = `${origin}/#/catalog/detail/?id=${productId}`;
const html = `
  <div id="detail-root">
    <div class="detailPage">
      <div class="productInfo">
        <div class="leftWrap"><img src="${prefix}main.jpg"></div>
        <div class="rightWrap">
          <p class="detailTitle"><span class="el-tag">POD</span> 260082</p>
          <div class="detailSku">
            <div class="skuItem"><p class="text">Size</p><div class="listSku"><span class="sku">S</span><span class="sku">M</span></div></div>
            <div class="skuItem"><p class="text">Color</p><div class="listSku"><span class="sku">LB</span></div></div>
            <div class="skuItem"><p class="text">发货地(数量)</p><div class="listSku"><span class="sku">美国(14)</span></div></div>
          </div>
          <div class="detailData"><strong class="label">价格:</strong><span class="price">$14</span></div>
        </div>
      </div>
      <div class="productDetail">
        <div id="pane-first" style="display:none">
          <div class="description"><p>260082</p><p>牛仔裤<br>冷水洗涤</p><img src="${prefix}detail.jpg"><img src="data:image/svg+xml,invalid"></div>
        </div>
        <div id="pane-second">
          <table><tr><th class="el-descriptions-item__label desc-label">材质</th><td class="el-descriptions-item__content">棉</td></tr></table>
        </div>
        <div id="pane-third" style="display:none"><img src="${prefix}size.png"></div>
        <div class="relatedProducts"><img src="${prefix}unrelated.jpg"></div>
      </div>
    </div>
  </div>`;

function capture({ source = url, mark, markup = html } = {}) {
  const { window } = new JSDOM(markup, { url: source, runScripts: "outside-only" });
  try {
    if (mark) window.document.getElementById("detail-root").__vue__ = mark;
    return JSON.parse(JSON.stringify(window.eval(`(${readZhFulfillProduct})()`)));
  } finally {
    window.close();
  }
}

const component = {
  $options: { name: "CatalogDetail" },
  $route: { query: { id: productId } },
  title: "260082",
  aliImgPrefix: prefix,
  detail: {
    id: productId,
    images: [{ uri: "main.jpg" }, { uri: "front.jpg" }, { uri: "front.jpg" }],
    sizeChart: "size.png",
    variants: [
      { name: "Size", values: [{ id: 11, name: "S" }, { id: 12, name: "M" }] },
      { name: "Color", values: [{ id: 22, name: "LB", image: { uri: "blue.jpg" } }] },
    ],
    inventories: [
      { id: "1909876543210987654", variantSku: "SKU-S-LB", spec: "11,22", contactsCountry: "US",
        shareQuantity: 18, shareFreezeQuantity: 4, image: { uri: "blue.jpg" } },
      { id: "1909876543210987655", variantSku: "SKU-S-LB", spec: "11,22", contactsCountry: "CA",
        shareQuantity: 5, shareFreezeQuantity: 1 },
      { id: "1909876543210987656", variantSku: "SKU-M-LB", spec: "12,22", contactsCountry: "US" },
      { id: "broken-spec", variantSku: "NO_OPTIONS", spec: "99,22", contactsCountry: "US" },
    ],
    delivers: [{ code: "US", chineseName: "美国" }, { code: "CA", englishName: "Canada" }],
    customAttributes: [{ attributeName: "产地", attributeValue: "越南" }, { attributeName: "品牌", attributeValue: "示例品牌" }],
  },
};

const loaded = capture({ mark: component });
assert.equal(loaded.productId, productId, "preserves the exact 19-digit product identifier");
assert.equal(loaded.title, "260082");
assert.equal(loaded.description, "260082\n牛仔裤\n冷水洗涤");
assert.equal(loaded.countryOfOrigin, "越南");
assert.equal(loaded.brand, "示例品牌");
assert.equal(loaded.price, "14");
assert.equal(loaded.priceText, "$14");
assert.equal(loaded.currency, undefined, "does not infer a currency from a dollar sign");
assert.deepEqual(loaded.images, [prefix + "main.jpg", prefix + "front.jpg"]);
assert.deepEqual(loaded.detailImages, [prefix + "detail.jpg"]);
assert.equal(loaded.sizeChartImage, prefix + "size.png");
assert.deepEqual(loaded.variantGroups, [
  { name: "Size", options: [{ value: "S" }, { value: "M" }] },
  { name: "Color", options: [{ value: "LB", image: prefix + "blue.jpg" }] },
]);
assert.deepEqual(loaded.skus, [
  { id: "SKU-S-LB", options: { Size: "S", Color: "LB" }, image: prefix + "blue.jpg", inventory: [
    { shipFrom: "美国", inventoryId: "1909876543210987654", quantity: 14 },
    { shipFrom: "Canada", inventoryId: "1909876543210987655", quantity: 4 },
  ] },
  { id: "SKU-M-LB", options: { Size: "M", Color: "LB" }, inventory: [
    { shipFrom: "美国", inventoryId: "1909876543210987656" },
  ] },
]);

const fallback = capture();
assert.equal(fallback.title, "260082", "excludes the POD label in the rendered title");
assert.deepEqual(fallback.attributes, { 材质: "棉" });
assert.deepEqual(fallback.skus, [], "visible option chips do not imply SKU combinations");
assert.deepEqual(fallback.variantGroups.map((group) => group.name), ["Size", "Color"]);
assert.equal(fallback.countryOfOrigin, undefined, "shipping origin is not a manufacturing country");
assert.equal(capture({ source: `${origin}/#/login?redirect=%2Fcatalog%2Fdetail` }), null);
assert.equal(capture({ source: `https://unrelated.example/#/catalog/detail/?id=${productId}` }), null);
assert.equal(capture({ mark: { ...component, loading: true } }), null);
assert.equal(capture({ mark: { ...component, detail: { ...component.detail, id: "2031618175107534848" } } }), null);
console.log("Zhifulfill product capture reads catalog details, original media and real stocked SKU combinations.");
