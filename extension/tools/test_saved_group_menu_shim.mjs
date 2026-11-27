import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("SKIP macOS saved-group menu shim");
  process.exit(0);
}

const run = promisify(execFile);
const homeDir = await mkdtemp(path.join(os.tmpdir(), "pagelens-menu-shim-"));
const probeSrc = fileURLToPath(new URL("./fixtures/saved-group-menu-shim-probe.m", import.meta.url));
const shimSrc = fileURLToPath(new URL("../../native/macos/pagelens-ax-menu-shim.m", import.meta.url));
const probeBin = path.join(homeDir, "menu-shim-probe");
const shimLib = path.join(homeDir, "pagelens-ax-menu-shim.dylib");

function verdicts(stdout) {
  return Object.fromEntries(String(stdout).trim().split("\n").map((line) => line.split(" ")));
}

try {
  await run("/usr/bin/clang", ["-fno-objc-arc", "-framework", "Foundation", probeSrc, "-o", probeBin]);
  await run("/usr/bin/clang", ["-O2", "-fno-objc-arc", "-dynamiclib", "-framework", "Foundation", shimSrc, "-o", shimLib]);
  const plain = verdicts((await run(probeBin)).stdout);
  const injected = verdicts((await run(probeBin, [], { env: { ...process.env, DYLD_INSERT_LIBRARIES: shimLib } })).stdout);

  assert.equal(plain.zh_exact, "MATCH");
  assert.equal(plain.zh_shortcut, "MISS");
  assert.equal(plain.en_shortcut, "MISS");
  assert.equal(injected.zh_exact, "MATCH");
  assert.equal(injected.zh_shortcut, "MATCH");
  assert.equal(injected.en_shortcut, "MATCH");
  for (const key of ["label", "partial", "empty", "nil_text", "marker_extra"]) {
    assert.equal(plain[key], "MISS", key);
    assert.equal(injected[key], "MISS", key);
  }
  assert.equal(plain.marker, "MATCH");
  assert.equal(injected.marker, "MATCH");
  console.log("PASS menu shim widens only the granted helper's create-row pattern");
} finally {
  await rm(homeDir, { recursive: true, force: true });
}
