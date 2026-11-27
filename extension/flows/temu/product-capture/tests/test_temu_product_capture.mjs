import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readTemuProduct } from "../page-state.js";

const url = "https://www.temu.com/ca/winter-gloves-g-601105372380663.html";
const skuUrl = "https://img.kwcdn.com/product/open/black.jpeg";
const gallery = "https://img.kwcdn.com/product/open/gloves.jpeg";
const detail = "https://img.kwcdn.com/product/open/gloves-detail.jpeg";
const related = "https://img.kwcdn.com/product/open/related.jpeg";

function read(html, { href = url, rawData } = {}) {
  const dom = new JSDOM(html, { url: href, runScripts: "outside-only" });
  try {
    dom.window.rawData = rawData;
    // Chrome serializes the function before running it in the product page.
    return JSON.parse(JSON.stringify(dom.window.eval(`(${readTemuProduct})()`)));
  } finally {
    dom.window.close();
  }
}

test("reads the product gallery and details without selecting a SKU or mixing in unrelated images", () => {
  const result = read(`
    <meta property="og:description" content="Shop winter gloves.">
    <main>
      <div>
        <h1><button type="button">Free shipping</button><div>Winter gloves</div></h1>
        <div role="group" aria-label="Color">
          <button aria-label="Black"><img src="${skuUrl}"></button>
          <button>Blue</button>
        </div>
        <div role="group" aria-label="Size"><button>One-size</button><button>Size guide</button></div>
        <div><span>Color:</span><span>Red</span></div>
        <del><span>$15.23</span></del><strong>$4.57</strong>
        <button>Add to cart</button>
      </div>
      <button aria-label="Product image 1 of 9"><img src="${gallery}"></button>
      <section>
        <div>Product details</div>
        <div><span>Material</span><span>Wool</span></div>
        <div><span>Suitable types</span><span>Elasticity</span></div>
        <dl><dt>Country of origin</dt><dd>China</dd></dl>
        <img src="${detail}" alt="Winter gloves Product details 1">
      </section>
      <section><h2>Recommendations</h2><img src="${related}" alt="Other gloves"></section>
    </main>`);
  assert.equal(result.productId, "601105372380663");
  assert.equal(result.title, "Winter gloves");
  assert.equal(result.description, "Shop winter gloves.");
  assert.equal(result.descriptionSource, "metadata");
  assert.equal(result.countryOfOrigin, "China");
  assert.equal(result.priceText, "$4.57");
  assert.equal(result.currency, undefined);
  assert.deepEqual(result.attributes, { "Country of origin": "China", Material: "Wool", "Suitable types": "Elasticity" });
  assert.deepEqual(result.images, [gallery]);
  assert.deepEqual(result.detailImages, [detail]);
  assert.deepEqual(result.variantGroups, [
    { name: "Color", options: [{ value: "Black", image: skuUrl }, { value: "Blue" }, { value: "Red" }] },
    { name: "Size", options: [{ value: "One-size" }] },
  ]);
  assert.deepEqual(result.skus, []);
});

test("only collects SKU IDs and exact combinations supplied by the matching product", () => {
  const result = read(`<h1>Winter gloves</h1>`, { rawData: { store: {
    recommendation: { goodsId: "601105372380663", title: "Recommendation", goodsGallery: [related] },
    staleProduct: { goodsId: "601105372380661", goodsName: "Stale", gallery: [related] },
    data: {
      goodsId: "601105372380663",
      goodsName: "Winter gloves",
      description: "Insulated wool gloves",
      goodsGallery: [{ url: gallery }],
      skuList: [{ skuId: "601095857331012", specList: [
        { parentSpecName: "Color", specName: "Black" },
        { parentSpecName: "Size", specName: "One-size" },
      ], thumbUrl: skuUrl }],
    },
  } } });
  assert.equal(result.description, "Insulated wool gloves");
  assert.deepEqual(result.images, [gallery]);
  assert.deepEqual(result.skus, [
    { id: "601095857331012", options: { Color: "Black", Size: "One-size" }, image: skuUrl },
  ]);
});

test("reads matching standard product data and ignores mismatched listings", () => {
  const data = {
    "@graph": [
      { "@type": "Product", url: url.replace("601105372380663", "601105372380664"), name: "Wrong", image: related },
      { "@type": "ProductGroup", url, name: "Gloves", image: gallery, offers: { price: 4.57, priceCurrency: "CAD" },
        brand: { name: "Test brand" },
        additionalProperty: [{ name: "Upper material", value: "Wool" }],
        hasVariant: [{ "@type": "Product", sku: "blue-1", color: "Blue", size: "One-size" }],
      },
    ],
  };
  const result = read(`<script type="application/ld+json">${JSON.stringify(data)}</script>`);
  assert.equal(result.title, "Gloves");
  assert.equal(result.brand, "Test brand");
  assert.equal(result.price, "4.57");
  assert.equal(result.currency, "CAD");
  assert.deepEqual(result.attributes, { "Upper material": "Wool" });
  assert.deepEqual(result.images, [gallery]);
  assert.deepEqual(result.skus, [{ id: "blue-1", options: { Color: "Blue", Size: "One-size" } }]);
});

test("returns empty for merchant pages, unavailable titles and verification screens", () => {
  assert.equal(read("<h1>Fake</h1>", { href: url.replace("www.", "agentseller.") }), null);
  assert.equal(read("<h1>Item unavailable</h1>"), null);
  assert.equal(read(`<meta property="og:type" content="product"><meta property="og:title" content="Gloves">
    <body>Security Verification. Please complete the verification to continue.</body>`), null);
});
