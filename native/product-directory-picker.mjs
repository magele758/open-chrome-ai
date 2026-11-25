import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const title = "选择商品目录";
const settings = { timeout: 120_000, maxBuffer: 16 * 1024, encoding: "utf8" };
const macPicker = `
ObjC.import('AppKit');
var app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
var panel = $.NSOpenPanel.openPanel;
panel.title = '${title}';
panel.canChooseFiles = false;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = false;
panel.canCreateDirectories = false;
panel.level = $.NSModalPanelWindowLevel;
panel.orderFrontRegardless;
app.activateIgnoringOtherApps(true);
JSON.stringify(String(panel.runModal) === String($.NSModalResponseOK) ? ObjC.unwrap(panel.URL.path) : null);
`;

export async function pickProductDirectory({ platform = process.platform, execute = run } = {}) {
  const dialogs = platform === "darwin" ? [
    ["/usr/bin/osascript", ["-l", "JavaScript", "-e", macPicker]],
  ] : platform === "linux" ? [
    ["zenity", ["--file-selection", "--directory", `--title=${title}`]],
    ["kdialog", ["--getexistingdirectory", ".", "--title", title]],
  ] : [];
  for (const [command, args] of dialogs) {
    try {
      const { stdout } = await execute(command, args, settings);
      return platform === "darwin" ? JSON.parse(stdout) : stdout.replace(/\r?\n$/u, "") || null;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (platform === "linux" && error.code === 1 && !error.stderr?.trim()) return null;
      if (error.killed) throw new Error("目录选择已超时，请重新选择。");
      throw new Error("无法打开系统目录选择器，请检查本机桌面环境后重试。");
    }
  }
  throw new Error(platform === "linux"
    ? "请在本机安装 Zenity 或 KDialog 以打开目录选择器。"
    : "当前系统不支持本机目录选择器。可在商品资料中输入 JSON。");
}
