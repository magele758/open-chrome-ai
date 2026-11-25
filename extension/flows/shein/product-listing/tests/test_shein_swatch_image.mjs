import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareSheinSwatch } from "../swatch-image.js";

const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const jpeg = Uint8Array.of(255, 216, 255);
const imageFile = (bytes = png, name = "color.png", type = "image/png") => new File([bytes], name, { type });

function browser(t, { width = 80, height = 80, decodeError = false } = {}) {
  const calls = [];
  const bitmap = { width, height, close() { calls.push("close"); } };
  const globals = {
    createImageBitmap: async file => {
      calls.push(["decode", file.name]);
      if (decodeError) throw new TypeError("decode failed");
      return bitmap;
    },
    OffscreenCanvas: class {
      constructor(width, height) { calls.push(["canvas", width, height]); }
      getContext(type) {
        assert.equal(type, "2d");
        return { drawImage: (image, ...crop) => {
          assert.equal(image, bitmap);
          calls.push(["crop", ...crop]);
        } };
      }
      async convertToBlob(options) {
        assert.deepEqual(options, { type: "image/png" });
        return new Blob([png], options);
      }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  return calls;
}

test("uses a compliant explicit 80px PNG or JPEG without changing its file", async t => {
  const calls = browser(t);
  for (const file of [imageFile(), imageFile(jpeg, "color.JPEG", "image/jpeg")]) {
    assert.equal(await prepareSheinSwatch(file), file);
  }
  assert.deepEqual(calls, [["decode", "color.png"], "close", ["decode", "color.JPEG"], "close"]);
});

test("rejects unsupported, mislabelled and oversized swatches before decoding", async t => {
  const calls = browser(t);
  await assert.rejects(prepareSheinSwatch(imageFile(png, "color.jpg", "image/jpeg")), /JPG、JPEG 或 PNG/u);
  await assert.rejects(prepareSheinSwatch(imageFile(png, "color.gif", "image/gif")), /JPG、JPEG 或 PNG/u);
  await assert.rejects(prepareSheinSwatch(imageFile(new Uint8Array(3 * 1024 * 1024 + 1))), /3 MB/u);
  assert.deepEqual(calls, []);
});

test("reports incorrect explicit dimensions and releases the bitmap", async t => {
  const calls = browser(t, { width: 1000, height: 1000 });
  await assert.rejects(prepareSheinSwatch(imageFile()), /80 × 80/u);
  assert.deepEqual(calls, [["decode", "color.png"], "close"]);
});

test("crops a small square at the center of that color's hero and encodes a new 80px PNG", async t => {
  const calls = browser(t, { width: 1000, height: 750 });
  const file = imageFile(jpeg, "pink-front.jpg", "image/jpeg");
  const swatch = await prepareSheinSwatch(file, { derive: true });
  assert.equal(swatch.name, "pink-front-swatch.png");
  assert.equal(swatch.type, "image/png");
  assert.deepEqual(calls, [["decode", "pink-front.jpg"], ["canvas", 80, 80], ["crop", 440, 315, 120, 120, 0, 0, 80, 80], "close"]);
});

test("reports a source decode error without generating a swatch", async t => {
  const calls = browser(t, { decodeError: true });
  await assert.rejects(prepareSheinSwatch(imageFile(), { derive: true }), /无法解码该颜色的主图/u);
  assert.deepEqual(calls, [["decode", "color.png"]]);
});
