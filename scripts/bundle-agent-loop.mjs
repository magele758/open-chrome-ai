#!/usr/bin/env node
/**
 * Bundle @mage-ai-lab/agent-loop mini assembly for the Chrome extension.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entry = resolve(here, "agent-loop-mini-entry.js");
const outfile = resolve(root, "extension/vendor/agent-loop-mini.mjs");

mkdirSync(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile,
  legalComments: "none",
  treeShaking: true,
  define: { "process.env": "{}" },
  logLevel: "warning",
});

const bundled = readFileSync(outfile, "utf8");
if (/["']node:(fs|path|sqlite|vm|crypto|async_hooks)/.test(bundled)) {
  console.error("bundle still contains Node builtins; refuse to ship");
  process.exit(1);
}
console.log(`bundled ${outfile} from @mage-ai-lab/agent-loop/mini`);
