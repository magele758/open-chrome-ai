#!/usr/bin/env node
/**
 * Bundle @mage-ai-lab/agent-loop mini assembly for the Chrome extension.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const workspace = resolve(root, "..");
const entry = resolve(here, "agent-loop-mini-entry.js");
const outfile = resolve(root, "extension/vendor/agent-loop-mini.mjs");
const localEsbuild = resolve(workspace, "ppeng-agent-core/node_modules/.bin/esbuild");

mkdirSync(dirname(outfile), { recursive: true });

const cmd = existsSync(localEsbuild) ? localEsbuild : "npx";
const args = existsSync(localEsbuild) ? [] : ["--yes", "esbuild"];
args.push(
  entry,
  "--bundle",
  "--format=esm",
  "--platform=neutral",
  "--target=es2022",
  `--outfile=${outfile}`,
  "--legal-comments=none",
  "--tree-shaking=true",
  "--define:process.env={}"
);

const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);

const bundled = readFileSync(outfile, "utf8");
if (/["']node:(fs|path|sqlite|vm|crypto|async_hooks)/.test(bundled)) {
  console.error("bundle still contains Node builtins; refuse to ship");
  process.exit(1);
}
console.log(`bundled ${outfile} from @mage-ai-lab/agent-loop/mini`);
