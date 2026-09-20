import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { extractMathSegments, looksLikeLatex, formatAnswer, decorateInlines } from "../lib/markdown.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("../../.tmp/x-article-tests/node_modules/jsdom");

assert.equal(looksLikeLatex("E=mc^2"), true);
assert.equal(looksLikeLatex("\\frac{1}{2}"), true);
assert.equal(looksLikeLatex("x"), true);
assert.equal(looksLikeLatex("10"), false);
assert.equal(looksLikeLatex("99.99"), false);
assert.equal(looksLikeLatex("hello world"), false);

const currency = extractMathSegments("价格是 $10 和 $20。");
assert.equal(currency.maths.length, 0, "currency dollars stay text");
assert.equal(currency.text, "价格是 $10 和 $20。");

const inline = extractMathSegments("质能 $E=mc^2$ 与 $\\alpha$");
assert.equal(inline.maths.length, 2);
assert.equal(inline.maths[0].display, false);
assert.equal(inline.maths[0].tex, "E=mc^2");
assert.equal(inline.maths[1].tex, "\\alpha");

const display = extractMathSegments("见\n$$\\int_0^1 x^2\\,dx$$\n完");
assert.equal(display.maths.length, 1);
assert.equal(display.maths[0].display, true);
assert.match(display.maths[0].tex, /\\int_0\^1/);

const brackets = extractMathSegments("行内 \\(a+b\\) 和独立 \\[c=d\\]");
assert.equal(brackets.maths.length, 2);
assert.equal(brackets.maths[0].display, false);
assert.equal(brackets.maths[1].display, true);

const fenced = extractMathSegments("```js\nconst x = '$E=mc^2$';\n```\n还有 `$x$`");
assert.equal(fenced.maths.length, 0, "math inside code is left alone");
assert.match(fenced.text, /\$E=mc\^2\$/);
assert.match(fenced.text, /`\$x\$`/);

const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
for (const file of ["marked.min.js", "purify.min.js"]) {
  dom.window.eval(readFileSync(new URL("../vendor/" + file, import.meta.url), "utf8"));
}
dom.window.eval(readFileSync(new URL("../vendor/katex/katex.min.js", import.meta.url), "utf8"));
for (const name of ["document", "NodeFilter", "marked", "DOMPurify", "katex"]) {
  globalThis[name] = dom.window[name];
}

assert(globalThis.katex?.renderToString, "katex loaded");

const root = document.querySelector("main");
root.innerHTML = formatAnswer(
  [
    "行内 $E=mc^2$ 和 $\\frac{1}{2}$。",
    "",
    "$$\\sum_{n=1}^{N} n = \\frac{N(N+1)}{2}$$",
    "",
    "价格 $10 不是公式。",
    "",
    "时间 12:04 与 〔1〕。",
    "",
    "```text",
    "$x^2$",
    "```",
  ].join("\n"),
);
decorateInlines(root);

assert(root.querySelector(".katex"), "inline katex");
assert(root.querySelector(".katex-display"), "display katex");
assert(root.textContent.includes("价格 $10 不是公式。"), "currency intact");
assert(root.querySelector("pre")?.textContent.includes("$x^2$"), "fenced tex intact");
assert.equal(root.querySelectorAll(".katex-display").length, 1);
assert(root.querySelector(".ts")?.dataset.t === "12:04", "timestamp still works");
assert(root.querySelector(".ref")?.dataset.q === "1", "ref still works");
assert.equal(root.querySelectorAll(".katex .ts").length, 0, "do not turn katex into timestamps");

decorateInlines(root);
assert(root.querySelector(".katex-display"), "redecorate keeps katex");

dom.window.close();
console.log("PASS markdown latex");
