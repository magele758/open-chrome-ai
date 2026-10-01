import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { htmlToPlainText, readClipboardRich, writeClipboardRich } from "../lib/clipboard.js";
import { getSelectionRich, pasteIntoPage } from "../lib/agent/page-fns.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

assert.equal(htmlToPlainText("<p>a&amp;b</p><p>c<br>d</p>"), "a&b\nc\nd");

class FakeItem {
  constructor(data) {
    this.data = data;
    this.types = Object.keys(data);
  }
  async getType(type) {
    return this.data[type];
  }
}
const blob = (body, type) => new Blob([body], { type });

const rich = await readClipboardRich({
  clipboard: {
    read: async () => [
      new FakeItem({
        "text/plain": blob("hello", "text/plain"),
        "text/html": blob("<b>hello</b>", "text/html"),
        "image/png": blob("png", "image/png"),
      }),
    ],
  },
  toDataUrl: async () => "data:image/png;base64,AAA",
});
assert.deepEqual(rich, { text: "hello", html: "<b>hello</b>", htmlTruncated: false, image: "data:image/png;base64,AAA" });

const textOnly = await readClipboardRich({ clipboard: { readText: async () => "plain" } });
assert.equal(textOnly.text, "plain", "falls back to readText");
const denied = await readClipboardRich({
  clipboard: {
    read: async () => {
      throw new Error("denied");
    },
    readText: async () => "still text",
  },
});
assert.equal(denied.text, "still text", "read() failure still returns text");
const big = await readClipboardRich({
  clipboard: { read: async () => [new FakeItem({ "text/html": blob("x".repeat(30000), "text/html") })] },
});
assert.equal(big.html.length, 20000);
assert.equal(big.htmlTruncated, true);

let written;
const clipboard = {
  writeText: async (t) => (written = { plain: t }),
  write: async (items) => (written = { items }),
};
await writeClipboardRich({ text: "t" }, { clipboard, ClipboardItemCtor: FakeItem });
assert.deepEqual(written, { plain: "t" }, "text only keeps using writeText");

const res = await writeClipboardRich({ html: "<h1>标题</h1><p>正文</p>" }, { clipboard, ClipboardItemCtor: FakeItem });
assert.equal(res.html > 0, true);
const item = written.items[0];
assert.deepEqual(item.types.sort(), ["text/html", "text/plain"], "rich write carries both formats");
assert.match(await item.data["text/plain"].text(), /标题\n正文/);
assert.match(await item.data["text/html"].text(), /<h1>标题<\/h1>/);

const withImage = await writeClipboardRich(
  { text: "cap", image: "data:image/png;base64,AAA" },
  {
    clipboard,
    ClipboardItemCtor: FakeItem,
    fetchImpl: async () => ({ blob: async () => blob("png", "image/png") }),
  },
);
assert.equal(withImage.image, true);
assert.ok(written.items[0].types.includes("image/png"));

const downgraded = await writeClipboardRich({ html: "<i>x</i>" }, { clipboard: { writeText: async (t) => (written = { plain: t }) } });
assert.equal(downgraded.downgraded, true);
assert.deepEqual(written, { plain: "x" });
await assert.rejects(writeClipboardRich({}), /没有可复制/);

// ---- 页面侧 ----
const dom = new JSDOM(
  `<body>
  <input id="in" value="ab">
  <div id="ce" contenteditable="true"></div>
  <div id="handled" contenteditable="true"></div>
  <p id="src">前 <a href="/x">链接</a> <b>粗体</b> 后<script>1</script></p>
  </body>`,
  { url: "https://page.example/dir/", runScripts: "outside-only" },
);
const { window } = dom;
const { document } = window;
Object.assign(globalThis, {
  window,
  document,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Event: window.Event,
  InputEvent: window.InputEvent,
});
for (const id of ["ce", "handled"]) Object.defineProperty(document.getElementById(id), "isContentEditable", { value: true });

const input = document.getElementById("in");
input.setSelectionRange(1, 1);
assert.equal(pasteIntoPage({ selector: "#in", text: "X" }).method, "value");
assert.equal(input.value, "aXb", "inserted at the caret");
assert.equal(pasteIntoPage({ selector: "#in", text: "Y", replace: true }).ok, true);
assert.equal(input.value, "Y");

assert.equal(pasteIntoPage({ selector: "#nope", text: "x" }).notFound, true);
assert.equal(pasteIntoPage({}).ok, false);
assert.equal(pasteIntoPage({ selector: "#src", text: "x" }).ok, false, "non-editable target is rejected");

let inserted = null;
document.execCommand = (cmd, _ui, value) => {
  if (cmd === "insertHTML") inserted = { cmd, value };
  return true;
};
const viaExec = pasteIntoPage({ selector: "#ce", html: "<b>粗</b>", text: "粗" });
assert.equal(viaExec.method, "insertHTML", "falls back when nobody handles the paste event");
assert.equal(inserted.value, "<b>粗</b>");

class FakeTransfer {
  data = {};
  setData(type, value) {
    this.data[type] = value;
  }
  getData(type) {
    return this.data[type] || "";
  }
}
globalThis.DataTransfer = FakeTransfer;
globalThis.ClipboardEvent = class extends window.Event {
  constructor(type, init) {
    super(type, init);
    this.clipboardData = init.clipboardData;
  }
};
let seen;
document.getElementById("handled").addEventListener("paste", (e) => {
  seen = { html: e.clipboardData.getData("text/html"), text: e.clipboardData.getData("text/plain") };
  e.preventDefault();
});
const viaEvent = pasteIntoPage({ selector: "#handled", html: "<i>斜</i>", text: "斜" });
assert.equal(viaEvent.method, "paste-event");
assert.deepEqual(seen, { html: "<i>斜</i>", text: "斜" }, "editors receive both formats");

const range = document.createRange();
range.selectNodeContents(document.getElementById("src"));
const selection = window.getSelection();
selection.removeAllRanges();
selection.addRange(range);
const picked = getSelectionRich();
assert.match(picked.html, /<a href="https:\/\/page\.example\/x">链接<\/a>/, "relative links become absolute");
assert.match(picked.html, /<b>粗体<\/b>/);
assert.doesNotMatch(picked.html, /<script/);
assert.match(picked.text, /前 链接 粗体 后/);
selection.removeAllRanges();
assert.deepEqual(getSelectionRich(), { text: "", html: "" });

console.log("test_clipboard_rich ok");
