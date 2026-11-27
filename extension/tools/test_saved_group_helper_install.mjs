import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureMacAxHelper } from "../../native/saved-tab-groups.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP macOS Helper installation");
  process.exit(0);
}

const run = promisify(execFile);
const homeDir = await mkdtemp(path.join(os.tmpdir(), "pagelens-helper-install-"));
try {
  // Each sendNativeMessage starts its own process, including the status probe.
  const program = `
    const { ensureMacAxHelper } = await import(process.argv[1]);
    const result = await ensureMacAxHelper({ homeDir: process.argv[2] });
    process.stdout.write(JSON.stringify(result));
  `;
  const module = new URL("../../native/saved-tab-groups.mjs", import.meta.url).href;
  const build = async () => JSON.parse((await run(process.execPath, ["--input-type=module", "-e", program, module, homeDir])).stdout);
  const results = await Promise.all([build(), build(), build()]);
  for (const result of results) assert.equal(result.ok, true, result.error);
  assert.equal(results.filter(result => result.built).length, 1);
  const app = results[0].appPath;
  const executable = path.join(app, "Contents", "MacOS", "PageLensHelper");
  await rm(executable);
  const repaired = await ensureMacAxHelper({ homeDir });
  assert.equal(repaired.ok, true, repaired.error);
  assert.ok((await stat(executable)).mode & 0o111);
  const prepared = await ensureMacAxHelper({ homeDir, force: true });
  assert.equal(prepared.ok, true, prepared.error);
  await run("/usr/bin/codesign", ["--verify", "--strict", app]);

  const fixture = fileURLToPath(new URL("./fixtures/saved-group-menu.m", import.meta.url));
  const menuTest = path.join(homeDir, "menu-test");
  await run("/usr/bin/clang", ["-fobjc-arc", fixture, "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "Foundation", "-o", menuTest]);
  await run(menuTest);
  console.log("PASS concurrent macOS Helper installation, repair, signed rebuild and group menu commands");
} finally {
  await rm(homeDir, { recursive: true, force: true });
}
