import { requireOptionalFeature } from "../lib/optional-permissions.js";

export async function openDubFolder(status) {
  const denied = await requireOptionalFeature("downloads");
  if (denied || !chrome.downloads) {
    throw new Error(denied || "未授予下载目录权限");
  }
  const downloads = chrome.downloads;
  const [prior] = await downloads.search({ filenameRegex: "[/\\\\]PageLens[/\\\\].*\\.wav$", exists: true, state: "complete", limit: 1 });
  if (prior) {
    await downloads.show(prior.id);
  } else {
    await downloads.showDefaultFolder();
    status.textContent = "暂无已保存的配音，已打开下载目录";
  }
}
