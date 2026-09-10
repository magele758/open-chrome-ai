#!/usr/bin/env node
/**
 * Register com.pagelens.host for Chrome / Chromium on this machine.
 *
 *   node native/install-native-host.mjs
 *   node native/install-native-host.mjs --extension-id <id>
 *   node native/install-native-host.mjs --uninstall
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_NAME } from "./pagelens-host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const extensionDir = path.resolve(repoRoot, "extension");
const hostMjs = path.resolve(here, "pagelens-host.mjs");
const home = os.homedir();

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return "";
  return String(process.argv[i + 1] || "").trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function chromeUserDataDirs() {
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library/Application Support/Google/Chrome"),
      path.join(home, "Library/Application Support/Google/Chrome Canary"),
      path.join(home, "Library/Application Support/Google/Chrome Dev"),
      path.join(home, "Library/Application Support/Google/Chrome Beta"),
      path.join(home, "Library/Application Support/Chromium"),
    ];
  }
  if (process.platform === "linux") {
    return [
      path.join(home, ".config/google-chrome"),
      path.join(home, ".config/google-chrome-unstable"),
      path.join(home, ".config/chromium"),
    ];
  }
  throw new Error(`暂不支持 ${process.platform}。请在 macOS 或 Linux 上安装。`);
}

function nativeHostDirs() {
  return chromeUserDataDirs()
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.join(dir, "NativeMessagingHosts"));
}

function tryParseJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function idsFromSettings(settings, wantPath) {
  const ids = [];
  if (!settings || typeof settings !== "object") return ids;
  const resolved = path.resolve(wantPath);
  for (const [id, info] of Object.entries(settings)) {
    if (!/^[a-p]{32}$/.test(id)) continue;
    const p = info?.path;
    if (p && path.resolve(String(p)) === resolved) ids.push(id);
  }
  return ids;
}

function findExtensionIds(explicit) {
  if (explicit) {
    if (!/^[a-p]{32}$/.test(explicit)) {
      throw new Error(`扩展 ID 格式不对：${explicit}（应为 32 位 a-p）`);
    }
    return [explicit];
  }
  const found = new Set();
  for (const root of chromeUserDataDirs()) {
    if (!fs.existsSync(root)) continue;
    for (const profile of fs.readdirSync(root)) {
      const dir = path.join(root, profile);
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const name of ["Preferences", "Secure Preferences"]) {
        const json = tryParseJson(path.join(dir, name));
        for (const id of idsFromSettings(json?.extensions?.settings, extensionDir)) found.add(id);
      }
    }
  }
  return [...found];
}

function writeWrapper() {
  const dir = path.join(home, ".pagelens");
  fs.mkdirSync(dir, { recursive: true });
  const runner = path.join(dir, "pagelens-host");
  const nodePath = process.execPath;
  const pathEnv = process.env.PATH || "";
  const body = `#!/bin/sh
export PATH=${JSON.stringify(pathEnv)}
exec ${JSON.stringify(nodePath)} ${JSON.stringify(hostMjs)}
`;
  fs.writeFileSync(runner, body, { mode: 0o755 });
  fs.chmodSync(runner, 0o755);
  return runner;
}

function writeHostManifest(dir, runner, ids) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: "PageLens native host for local shell",
    path: runner,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
  fs.writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`);
  return dest;
}

function uninstall() {
  const removed = [];
  for (const dir of nativeHostDirs()) {
    const dest = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
      removed.push(dest);
    }
  }
  const runner = path.join(home, ".pagelens/pagelens-host");
  if (fs.existsSync(runner)) {
    fs.unlinkSync(runner);
    removed.push(runner);
  }
  return removed;
}

function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`Usage:
  node native/install-native-host.mjs [--extension-id <id>]
  node native/install-native-host.mjs --uninstall
`);
    return;
  }
  if (hasFlag("--uninstall")) {
    const removed = uninstall();
    console.log(removed.length ? `已删除：\n${removed.join("\n")}` : "没有已安装的 host。");
    return;
  }

  const ids = findExtensionIds(argValue("--extension-id"));
  if (!ids.length) {
    throw new Error(
      "找不到已加载的 PageLens 扩展 ID。先在 chrome://extensions 加载 extension/，再到设置复制扩展 ID，然后运行：\n  node native/install-native-host.mjs --extension-id <id>",
    );
  }

  const dirs = nativeHostDirs();
  if (!dirs.length) {
    throw new Error("没有找到 Chrome 用户数据目录，无法登记 Native Messaging。");
  }

  const runner = writeWrapper();
  const written = dirs.map((dir) => writeHostManifest(dir, runner, ids));
  console.log(`host: ${HOST_NAME}`);
  console.log(`runner: ${runner}`);
  console.log(`extension-id: ${ids.join(", ")}`);
  console.log(`manifest:\n${written.join("\n")}`);
  console.log("请到 chrome://extensions 重新加载 PageLens，再到设置点「测试 host」。");
}

try {
  if (hasFlag("--print-ids")) {
    console.log(findExtensionIds(argValue("--extension-id")).join("\n") || "(none)");
  } else {
    main();
  }
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
