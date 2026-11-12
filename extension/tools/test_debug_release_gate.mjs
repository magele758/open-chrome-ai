import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease } from "../../scripts/build-release.mjs";
import { verifyProdBundle } from "../../scripts/verify-prod-bundle.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "pagelens-release-gate-"));
const outDir = join(tempRoot, "extension");

try {
  // 1. 正向构建 + 静态门禁全绿
  const built = await buildRelease({ outDir });
  assert.ok(built.transformedCount >= 100, `expected >=100 transformed JS files, got ${built.transformedCount}`);

  const cleanCheck = await verifyProdBundle(outDir);
  assert.equal(cleanCheck.ok, true, `expected clean release bundle, got errors: ${cleanCheck.errors.join("; ")}`);

  // 验证产物内 policy.js 的生产锁死：isProdBuild() 返回 true，installType 恒为 normal
  const prodPolicyMod = await import(`file://${join(outDir, "lib/debug/policy.js")}`);
  assert.equal(prodPolicyMod.isProdBuild(), true);
  assert.equal(
    await prodPolicyMod.detectInstallType({
      chromeRef: { management: { getSelf: async () => ({ installType: "development" }) } },
    }),
    "normal",
    "production bundle hard-locks detectInstallType() to normal",
  );
  const prodEff = prodPolicyMod.resolveEffectiveDebugPolicy({
    debug: { enabled: true, traceLevel: "full", devAutoReload: true, showLocalMockPreset: true },
  });
  assert.equal(prodEff.canUseDevReload, false);
  assert.equal(prodEff.showLocalMockPreset, false);
  console.log("PASS 1: buildRelease + verifyProdBundle pass cleanly and hard-lock production policy");

  // 2. 负向注入测试：注入违禁特征子串或违禁权限必须被 verifyProdBundle 拦截
  const swPath = join(outDir, "sw.js");
  const origSw = readFileSync(swPath, "utf8");
  writeFileSync(swPath, `${origSw}\nconst leaked = ".dev-reload-stamp";\n`, "utf8");
  const stampLeakCheck = await verifyProdBundle(outDir);
  assert.equal(stampLeakCheck.ok, false, "must fail when .dev-reload-stamp token is present");
  assert.ok(stampLeakCheck.errors.some((e) => e.includes(".dev-reload-stamp")));
  writeFileSync(swPath, origSw, "utf8");

  // 注入违禁 manifest.permissions: ["downloads"] -> 必须拦截
  const manifestPath = join(outDir, "manifest.json");
  const origManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...origManifest,
      permissions: [...origManifest.permissions, "downloads"],
    }),
    "utf8",
  );
  const permLeakCheck = await verifyProdBundle(outDir);
  assert.equal(permLeakCheck.ok, false, "must fail when downloads is promoted to mandatory permissions");
  assert.ok(permLeakCheck.errors.some((e) => e.includes('"downloads"')));
  writeFileSync(manifestPath, JSON.stringify(origManifest, null, 2), "utf8");

  console.log("PASS 2: verifyProdBundle accurately catches injected dev tokens and manifest permission violations");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ALL PASS test_debug_release_gate.mjs");
