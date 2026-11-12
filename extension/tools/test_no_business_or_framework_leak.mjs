import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_AUTO_RELOAD_DEFAULT } from "../lib/dev-reload.js";
import { isAllowedPermissionQuery } from "../lib/optional-permissions.js";
import { AUTO_EXPORT_RUN_BUNDLE_DEFAULT } from "../lib/run-recorder.js";
import { defaultSettings } from "../lib/storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const TEXT_EXTS = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md"]);

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const rel = relative(EXT_ROOT, full).replace(/\\/g, "/");
    if (rel === "vendor" || rel.startsWith("vendor/")) continue;
    if (rel === "local-settings.json" || rel === ".dev-reload-stamp") continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(full, out);
    } else if (TEXT_EXTS.has(extname(entry))) {
      out.push({ full, rel });
    }
  }
  return out;
}

const allFiles = collectFiles(EXT_ROOT);
assert.ok(allFiles.length >= 40, "expected extension source files to be scanned");

// ── 0. 禁止遗留轮次调试命名的测试文件（test_round01..07） ──
{
  const toolFiles = readdirSync(__dirname);
  const roundNamed = toolFiles.filter((f) => /^test_round\d+/i.test(f));
  assert.deepEqual(roundNamed, [], `round-numbered test files must be replaced by semantic tests: ${roundNamed.join(", ")}`);
}

// ── 1. 核心层与非适配层零第三方组件库私有类名门禁（对齐审查报告 §7.3 Gate 1） ──
{
  const pAnt = ["an", "t"].join("");
  const pEl = ["e", "l"].join("");
  const pRc = ["r", "c"].join("");
  const fwLeakRe = new RegExp(
    [
      `\\.(?:${pAnt}-|${pEl}-|${pRc}-virtual-list)`,
      `${pAnt}-select`,
      `${pAnt}-modal`,
      `${pAnt}-cascader`,
      `${pAnt}-form`,
      `${pAnt}-upload`,
      `${pAnt}-spin`,
    ].join("|"),
  );
  const strictRuntimeFwRe = new RegExp(`\\b(?:${pAnt}-|${pEl}-|${pRc}-)[a-z0-9_-]+`);

  const violations = [];
  for (const { full, rel } of allFiles) {
    if (rel.startsWith("lib/agent/ui-adapters/")) continue;
    const content = readFileSync(full, "utf8");
    const lines = content.split("\n");
    const isRuntimeCore = !rel.startsWith("tools/");
    lines.forEach((line, idx) => {
      const m = fwLeakRe.exec(line) || (isRuntimeCore ? strictRuntimeFwRe.exec(line) : null);
      if (m) {
        violations.push(`${rel}:${idx + 1}: matched "${m[0]}"`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `framework class leak detected outside lib/agent/ui-adapters/:\n${violations.slice(0, 20).join("\n")}`,
  );
}

// ── 2. 全仓（含测试）零业务词汇、零真实内网 IP、零跨仓文件引用门禁（对齐审查报告 §7.3 Gate 2） ──
{
  const forbiddenLiterals = [
    ["采", "集箱"].join(""),
    ["妙", "手"].join(""),
    ["探", "果"].join(""),
    ["agent", "seller"].join(""),
    ["te", "mu"].join(""),
    ["Zol", "va"].join(""),
    ["套头", "毛衣"].join(""),
    ["SPU", "10086"].join("-"),
    ["确认", "分配"].join(""),
    ["运输", "模板"].join(""),
    ["材质", "成分"].join(""),
    ["所有比例", "之和"].join(""),
    ["尺码", "表"].join(""),
    ["collection", "create", "modal"].join("-"),
    ["10", "2", "31", "12"].join("."),
    ["..", "..", "..", ["te", "mu"].join("") + "-e2e-loop"].join("/"),
    ["Standard", "Fashion", "Item"].join(" "),
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bizLeakRe = new RegExp(forbiddenLiterals.map(escapeRe).join("|"), "i");

  const violations = [];
  for (const { full, rel } of allFiles) {
    const content = readFileSync(full, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      const m = bizLeakRe.exec(line);
      if (m) {
        violations.push(`${rel}:${idx + 1}: matched "${m[0]}"`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `business / intranet / cross-repo leak detected under extension/:\n${violations.slice(0, 20).join("\n")}`,
  );
}

// ── 3. 安装期权限与开发/评测自动导出默认值门禁（对齐审查报告 §7.3 Gate 3） ──
{
  const manifest = JSON.parse(readFileSync(resolve(EXT_ROOT, "manifest.json"), "utf8"));
  assert.ok(
    !manifest.permissions.includes("downloads"),
    "manifest.json required permissions must NOT include 'downloads'",
  );
  assert.ok(
    Array.isArray(manifest.optional_permissions) && manifest.optional_permissions.includes("downloads"),
    "manifest.json optional_permissions MUST include 'downloads'",
  );
  assert.equal(
    isAllowedPermissionQuery({ permissions: ["downloads"] }),
    true,
    "optional-permissions must treat 'downloads' as optional queryable API",
  );
  assert.equal(DEV_AUTO_RELOAD_DEFAULT, false, "DEV_AUTO_RELOAD_DEFAULT must be false");
  assert.equal(AUTO_EXPORT_RUN_BUNDLE_DEFAULT, false, "AUTO_EXPORT_RUN_BUNDLE_DEFAULT must be false");

  const defaults = defaultSettings();
  assert.equal(defaults.dev?.autoReload, false, "defaultSettings().dev.autoReload must be false");
  assert.equal(
    defaults.diagnostics?.autoExportRunBundle,
    false,
    "defaultSettings().diagnostics.autoExportRunBundle must be false",
  );
}

console.log("PASS test_no_business_or_framework_leak.mjs (0 framework leaks, 0 business leaks, safe defaults)");
