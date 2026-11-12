#!/usr/bin/env node
/**
 * 构建生产发布版 Chrome 扩展产物（dist/extension）。
 *
 * 开发期仍保持零构建原生 ESM（直接加载 extension/）；
 * 发布打包时通过本脚本：
 * 1. 物理剔除 extension/tools/**、reload-dev.js、local-settings.json、apply-local.html、.dev-reload-stamp*、*.map；
 * 2. 通过 esbuild 注入 __PL_PROD_BUILD__ = true 执行常量折叠与死代码消除（DCE）并剥离注释，
 *    确保热重载、本地配置探测、local-mock 预设在产物层面彻底归零。
 */

import { transform } from "esbuild";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultSrcDir = resolve(root, "extension");
const defaultOutDir = resolve(root, "dist/extension");

const EXCLUDED_REL_PATHS = new Set([
  "tools",
  "local-settings.json",
  "apply-local.html",
  "lib/dev-reload.js",
  "lib/debug/reload-dev.js",
]);

function shouldExcludeRelPath(relPosix) {
  if (!relPosix) return false;
  if (EXCLUDED_REL_PATHS.has(relPosix)) return true;
  if (relPosix.startsWith("tools/")) return true;
  const base = relPosix.split("/").pop() || "";
  if (base === ".DS_Store") return true;
  if (base.startsWith(".dev-reload-stamp")) return true;
  if (base.endsWith(".map")) return true;
  return false;
}

function copyFilteredTree(srcRoot, dstRoot, curRel = "") {
  const curSrc = curRel ? join(srcRoot, curRel) : srcRoot;
  const entries = readdirSync(curSrc, { withFileTypes: true });
  for (const ent of entries) {
    const childRel = curRel ? `${curRel}/${ent.name}` : ent.name;
    if (shouldExcludeRelPath(childRel)) continue;
    const srcPath = join(srcRoot, childRel);
    const dstPath = join(dstRoot, childRel);
    if (ent.isDirectory()) {
      mkdirSync(dstPath, { recursive: true });
      copyFilteredTree(srcRoot, dstRoot, childRel);
    } else if (ent.isFile()) {
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
    }
  }
}

function collectJsFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "vendor") continue;
      collectJsFiles(full, out);
    } else if (ent.isFile() && extname(ent.name) === ".js") {
      out.push(full);
    }
  }
  return out;
}

export async function buildRelease({
  srcDir = defaultSrcDir,
  outDir = defaultOutDir,
} = {}) {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`Source extension directory not found: ${srcDir}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFilteredTree(srcDir, outDir);

  // 发布态剥离 reload-dev.js 后，将 SW 调试入口替换为纯 hooks 导出桩
  const swEntryOutPath = join(outDir, "lib/debug/sw-entry.js");
  if (existsSync(swEntryOutPath)) {
    writeFileSync(
      swEntryOutPath,
      'export { initSwDebugRuntime, syncSwDebugRuntime } from "./hooks.js";\n',
      "utf8",
    );
  }

  const jsFiles = collectJsFiles(outDir);
  for (const filePath of jsFiles) {
    const raw = readFileSync(filePath, "utf8");
    const prepped = raw.replace(
      /^\s*(?:export\s+)?const\s+__PL_PROD_BUILD__\s*=\s*(?:false|true)\s*;?\s*$/gm,
      "",
    );
    const result = await transform(prepped, {
      loader: "js",
      format: "esm",
      target: "es2022",
      minifySyntax: true,
      legalComments: "none",
      define: {
        __PL_PROD_BUILD__: "true",
      },
      sourcefile: relative(outDir, filePath),
    });
    writeFileSync(filePath, result.code, "utf8");
  }

  return {
    srcDir,
    outDir,
    transformedCount: jsFiles.length,
  };
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : defaultOutDir;
  const info = await buildRelease({ outDir });
  console.log(
    `[build-release] built ${info.outDir} (${info.transformedCount} JS modules transformed with __PL_PROD_BUILD__=true)`,
  );
}
