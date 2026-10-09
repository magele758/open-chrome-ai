import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const json = (path) => JSON.parse(read(path));

const pkg = json("package.json");
const manifest = json("extension/manifest.json");
const lock = json("package-lock.json");
assert.equal(pkg.version, manifest.version, "package.json and manifest.json versions match");
assert.equal(lock.version, pkg.version, "package-lock.json version matches");
assert.equal(lock.packages[""].version, pkg.version, "package-lock.json root package version matches");

const { libraries } = json("extension/vendor/VERSIONS.json");
for (const [name, lib] of Object.entries(libraries)) {
  for (const file of lib.files) {
    assert(existsSync(new URL(`extension/vendor/${file}`, root)), `${name}: ${file} exists`);
  }
}

const markers = {
  marked: ["marked.min.js", (v) => `marked v${v}`],
  dompurify: ["purify.min.js", (v) => `DOMPurify ${v}`],
  mermaid: ["mermaid.min.js", (v) => `"${v}"`],
  katex: ["katex/katex.min.js", (v) => `version:"${v}"`],
  "pdfjs-dist": ["pdfjs/pdf.min.mjs", (v) => `"${v}"`],
};
for (const [name, [file, marker]] of Object.entries(markers)) {
  const { version } = libraries[name];
  assert(read(`extension/vendor/${file}`).includes(marker(version)), `${name} ${version} matches ${file}`);
}

assert.equal(
  libraries["@mage-ai-lab/agent-loop"].version,
  pkg.dependencies["@mage-ai-lab/agent-loop"],
  "agent-loop bundle version matches package.json",
);

console.log("PASS vendor versions");
