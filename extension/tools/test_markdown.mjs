import { resolveLinkHref } from "../lib/markdown.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(resolveLinkHref("https://example.com/a") === "https://example.com/a", "https");
assert(resolveLinkHref("http://example.com") === "http://example.com/", "http");
assert(resolveLinkHref("/docs", "https://example.com/page") === "https://example.com/docs", "relative");
assert(resolveLinkHref("javascript:alert(1)") === "", "js");
assert(resolveLinkHref("chrome://settings") === "", "chrome");
assert(resolveLinkHref("#section") === "", "hash");
assert(resolveLinkHref("data:text/html,x") === "", "data");

console.log("PASS markdown links");
