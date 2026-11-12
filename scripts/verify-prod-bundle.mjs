#!/usr/bin/env node
/**
 * 生产发布包静态门禁校验（CI 红线检查）。
 *
 * 校验项：
 * 1. 目录与测试/热重载文件禁令：tools/、reload-dev.js、dev-reload.js、local-settings.json、apply-local.html、.dev-reload-stamp*、*.map 必须不存在；
 * 2. 特征子串扫描禁令：非 vendor 代码与资源中禁止出现 pagelens-dev-reload、.dev-reload-stamp、
 *    sw-startup-latest.json、local-settings.json、127.0.0.1:18787、reload-dev.js、dev-reload.js；
 * 3. Manifest 最小权限合规：permissions 禁止包含 downloads / management / <all_urls>，downloads 必须留在 optional_permissions，禁止出现 externally_connectable；
 * 4. 全量 JS 语法可解析性校验。
 */

import { transform } from "esbuild";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultDistDir = resolve(root, "dist/extension");

export const FORBIDDEN_PATHS = [
  "tools",
  "lib/dev-reload.js",
  "lib/debug/reload-dev.js",
  "local-settings.json",
  "apply-local.html",
  ".dev-reload-stamp",
  ".dev-reload-stamp.tmp",
];

export const FORBIDDEN_SUBSTRINGS = [
  "pagelens-dev-reload",
  ".dev-reload-stamp",
  "sw-startup-latest.json",
  "local-settings.json",
  "127.0.0.1:18787",
  "reload-dev.js",
  "dev-reload.js",
];

function walkFiles(dir, curRel = "", out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = curRel ? `${curRel}/${ent.name}` : ent.name;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, rel, out);
    } else if (ent.isFile()) {
      out.push({ rel, full });
    }
  }
  return out;
}

export async function verifyProdBundle(distDir = defaultDistDir) {
  const errors = [];

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return {
      ok: false,
      errors: [`Release directory does not exist: ${distDir}`],
      scannedFiles: 0,
    };
  }

  for (const reqFile of ["manifest.json", "sw.js", "sidepanel/index.html"]) {
    if (!existsSync(join(distDir, reqFile))) {
      errors.push(`Missing required extension entry: ${reqFile}`);
    }
  }

  for (const forbidden of FORBIDDEN_PATHS) {
    if (existsSync(join(distDir, forbidden))) {
      errors.push(`Forbidden file/directory present in release bundle: ${forbidden}`);
    }
  }

  const allFiles = walkFiles(distDir);
  for (const { rel, full } of allFiles) {
    const base = rel.split("/").pop() || "";
    if (base.startsWith(".dev-reload-stamp")) {
      errors.push(`Forbidden stamp file present: ${rel}`);
    }
    if (base.endsWith(".map")) {
      errors.push(`Source map file must not ship in release bundle: ${rel}`);
    }
    if (/^test_.*\.(m?js|py)$/.test(base)) {
      errors.push(`Test file must not ship in release bundle: ${rel}`);
    }

    if (rel.startsWith("vendor/")) continue;
    const ext = extname(base);
    if (![".js", ".mjs", ".html", ".json", ".css"].includes(ext)) continue;

    const text = readFileSync(full, "utf8");
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      if (text.includes(needle)) {
        errors.push(`Forbidden token "${needle}" found in ${rel}`);
      }
    }

    if (ext === ".js" || ext === ".mjs") {
      try {
        await transform(text, {
          loader: "js",
          format: "esm",
          target: "es2022",
          sourcefile: rel,
        });
      } catch (err) {
        errors.push(`Syntax validation failed for ${rel}: ${err?.message || String(err)}`);
      }
    }
  }

  const manifestPath = join(distDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      const optPerms = Array.isArray(manifest.optional_permissions)
        ? manifest.optional_permissions
        : [];
      for (const bannedPerm of ["downloads", "management", "<all_urls>", "http://*/*", "https://*/*"]) {
        if (perms.includes(bannedPerm)) {
          errors.push(`manifest.json permissions must NOT include "${bannedPerm}"`);
        }
      }
      if (!optPerms.includes("downloads")) {
        errors.push(`manifest.json optional_permissions must retain "downloads"`);
      }
      if ("externally_connectable" in manifest) {
        errors.push(`manifest.json must NOT expose externally_connectable`);
      }
    } catch (err) {
      errors.push(`Invalid manifest.json: ${err?.message || String(err)}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    scannedFiles: allFiles.length,
    distDir,
  };
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const distDir = dirIdx >= 0 && args[dirIdx + 1] ? resolve(args[dirIdx + 1]) : defaultDistDir;
  const res = await verifyProdBundle(distDir);
  if (!res.ok) {
    console.error(`[verify-prod-bundle] FAILED (${res.errors.length} violation(s)) in ${relative(root, distDir) || distDir}:`);
    for (const err of res.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log(
    `[verify-prod-bundle] PASS (${res.scannedFiles} files verified, zero dev/reload/test artifacts or forbidden permissions)`,
  );
}
