import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readAmazonProduct } from "../page-state.js";

const main = "https://m.media-amazon.com/images/I/main._AC_SL1500_.jpg";
const second = "https://m.media-amazon.com/images/I/second._AC_SL1500_.jpg";
const detail = "https://m.media-amazon.com/images/S/aplus-media-library-service-media/detail.jpg";
const red = "https://m.media-amazon.com/images/I/red._SS64_.jpg";

function read(html, path = "/dp/B000000001?th=1") {
  const dom = new JSDOM(html, { url: "https://www.amazon.com" + path, runScripts: "outside-only" });
  try {
    return JSON.parse(JSON.stringify(dom.window.eval("(" + readAmazonProduct.toString() + ")()")));
  } finally {
    dom.window.close();
  }
}

function literal(value) {
  return JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

test("reads the current ASIN, ordered swatch tuple, gallery, price and descriptive facts", () => {
  const html = [
    '<h1 id="productTitle">Striped shirt</h1>',
    '<input id="ASIN" value="B000000001">',
    '<a id="bylineInfo">Visit the Example Store</a>',
    '<div id="wayfinding-breadcrumbs_feature_div"><a>Clothing</a><a>Shirts</a></div>',
    '<div id="productFactsDesktopExpander"><div class="a-fixed-left-grid-inner"><div class="a-col-left">Origin</div><div class="a-col-right">Imported</div></div>',
    '<ul><li><span class="a-list-item">Machine washable</span></li></ul></div>',
    '<div id="detailBullets_feature_div"><ul><li><span class="a-list-item"><span class="a-text-bold">ASIN ‏ : ‎</span><span>B000000099</span></span></li></ul></div>',
    '<img id="landingImage" data-old-hires="' + main + '">',
    '<div id="aplus"><img src="https://images-na.ssl-images-amazon.com/grey-pixel.gif" data-src="' + detail + '">',
    '<div id="comparison-table-container-5"><img src="https://m.media-amazon.com/images/I/other.jpg"></div>',
    '<img src="https://invalid.test/unsafe.jpg"></div>',
    '<div id="inline-twister-row-color_name"><div class="dimension-heading"><div class="dimension-text"><span class="a-color-secondary">Color:</span><span class="inline-twister-dim-title-value">Black</span></div></div>',
    '<ul><li data-asin="B000000002"><img alt="Red" src="' + red + '"></li></ul></div>',
    '<div id="inline-twister-row-size_name"><div class="dimension-heading"><div class="dimension-text"><span class="a-color-secondary">Size:</span><span class="inline-twister-dim-title-value">S</span></div></div></div>',
    '<script>var twister = {"dimensions":["size_name","color_name"],"dimensionValuesDisplayData":{"B000000001":["S","Black"],"B000000002":["M","Red"]}};</script>',
    '<script>register("ImageBlockATF", function(){return {\'colorImages\': {\'initial\': A.$.parseJSON(\'' + literal([{ hiRes: main }, { hiRes: second }]) + '\')}}});</script>',
    '<div id="corePriceDisplay_desktop_feature_div"><div class="a-price a-text-price"><span class="a-offscreen">TWD950.00</span></div>',
    '<div class="a-price"><span class="a-offscreen">TWD560.06</span></div></div>',
  ].join("");

  const result = read(html);
  assert.equal(result.productId, "B000000001");
  assert.equal(result.attributes.ASIN, "B000000099");
  assert.equal(result.attributes.Origin, "Imported");
  assert.equal(result.countryOfOrigin, undefined);
  assert.equal(result.title, "Striped shirt");
  assert.equal(result.brand, "Example");
  assert.equal(result.category, "Clothing > Shirts");
  assert.equal(result.description, "Machine washable");
  assert.deepEqual(result.images, [main, second]);
  assert.deepEqual(result.detailImages, [detail]);
  const price = { amount: "560.06", currency: "TWD", display: "TWD560.06" };
  assert.deepEqual(result.price, price);
  assert.deepEqual(result.variantGroups, [
    { name: "Color", options: [{ value: "Red", image: red }, { value: "Black" }] },
    { name: "Size", options: [{ value: "S" }, { value: "M" }] },
  ]);
  assert.deepEqual(result.skus, [
    { id: "B000000001", options: { Size: "S", Color: "Black" }, image: main, price },
    { id: "B000000002", options: { Size: "M", Color: "Red" }, image: red },
  ]);
});

test("uses matching Product JSON-LD and leaves a foreign Product out of an unreadable page", () => {
  const structured = '<script type="application/ld+json">' + JSON.stringify({
    "@graph": [
      { "@type": "Product", sku: "B000000099", name: "Recommended product" },
      { "@type": "Product", sku: "B000000001", name: "Gloves",
        countryOfOrigin: { name: "Canada" }, image: [main],
        offers: { price: 19.95, priceCurrency: "USD" } },
    ],
  }) + '</script>';
  const result = read(structured);
  assert.equal(result.title, "Gloves");
  assert.equal(result.countryOfOrigin, "Canada");
  assert.deepEqual(result.images, [main]);
  assert.deepEqual(result.skus, [{ id: "B000000001", options: {}, price: { amount: "19.95", currency: "USD" } }]);
  assert.equal(read(structured, "/dp/B000000098"), null);
  assert.equal(read("<h1>Search Amazon</h1>", "/s?k=gloves"), null);
});

test("does not invent two-dimensional variant combinations when only individual swatches exist", () => {
  const result = read([
    '<h1 id="productTitle">Plain jacket</h1>',
    '<section id="variation_size_name"><label class="a-form-label">Size:</label><span class="selection">S</span>',
    '<ul><li data-defaultasin="B000000002" data-variation-value="M"></li></ul></section>',
    '<section id="variation_color_name"><label class="a-form-label">Color:</label><span class="selection">Blue</span>',
    '<ul><li data-defaultasin="B000000003" data-variation-value="White"></li></ul></section>',
  ].join(""));
  assert.deepEqual(result.skus, [{ id: "B000000001", options: { Size: "S", Color: "Blue" } }]);
  assert.equal(result.price, undefined);
});
