import { INTERPRET_CMD } from "../lib/interpret-messages.js";
import { loadFullMediaArchive } from "../lib/audio-composer.js";
import { videoIdentity } from "../lib/library.js";
import { bindMediaSource, isVideoPack, isVideoUrl, packForMediaWrite, mediaActionTab } from "./tab-context.js";
import { state } from "./state.js";
import { $ } from "./dom.js";

export function bindDubQueue(toggleDubPlayback) {
  const panel = $("dub-queue"), list = $("queue-items"), status = $("queue-status"), player = $("queue-player");
  let timer, signature, objectUrl;
  const missing = new Set();
  const report = err => { status.textContent = err.message; };
  async function command(op, data = {}) {
    const res = await chrome.runtime.sendMessage({ type: INTERPRET_CMD, op, ...data });
    if (!res?.ok) throw Error(res?.error || "预处理后台未响应");
    return res;
  }
  async function add(tab) {
    if (!tab?.url) throw Error("请选择视频网页");
    await command("queueAdd", { tab: { url: tab.url, title: tab.title, id: tab.id } });
    missing.delete(videoIdentity(tab.url));
    status.textContent = "已加入队列";
    await refresh();
  }
  async function listen(row) {
    const archive = await loadFullMediaArchive(row.id);
    if (!archive?.compactAudioBlob) {
      missing.add(row.id);
      await refresh();
      throw Error("音频缓存已清除或过期，请重新处理");
    }
    player.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    player.src = objectUrl = URL.createObjectURL(archive.compactAudioBlob);
    player.hidden = false;
    await player.play();
  }
  async function syncPlayback(row) {
    const tab = mediaActionTab();
    if (!tab?.id || videoIdentity(tab.url) !== row.id) throw Error("请先切回此视频的标签页");
    const archive = await loadFullMediaArchive(row.id);
    if (!archive?.audioBlob) throw Error("缓存已清除或过期，请重新加入队列");
    if (mediaActionTab()?.id !== tab.id || mediaActionTab()?.url !== tab.url) return;
    player.pause();
    const pack = packForMediaWrite(tab.id);
    pack.archive = archive;
    bindMediaSource(tab, pack);
    await toggleDubPlayback();
  }
  async function refresh() {
    const { jobs } = await command("queueList");
    const labels = { ready: "已完成", queued: "排队中", running: "处理中", failed: "失败", expired: "缓存已过期" };
    const rows = jobs.map(row => row.status === "ready" && (row.expireAt <= Date.now() || missing.has(row.id)) ? { ...row, status: "expired" } : row);
    const tab = state.tab;
    const canAdd = Boolean(tab?.id && (isVideoPack(state.pack) || isVideoUrl(tab.url)));
    $("queue-add").disabled = !canAdd;
    $("queue-add").textContent = canAdd ? "加入队列 · " + (tab.title || tab.url) : "切换到视频标签页即可加入队列";
    const currentId = videoIdentity(mediaActionTab()?.url);
    const next = JSON.stringify([currentId, rows]);
    if (next === signature) return;
    signature = next;
    list.replaceChildren();
    if (!rows.length) status.textContent = "队列为空";
    for (const row of rows) {
      const item = document.createElement("li");
      item.textContent = [row.title || row.url, labels[row.status], row.detail].filter(Boolean).join(" · ");
      if (["ready", "failed", "expired"].includes(row.status)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = row.status === "ready" ? "试听" : "重新处理";
        button.onclick = () => (row.status === "ready" ? listen(row) : add({ url: row.url, title: row.title })).catch(report);
        item.append(" ", button);
        if (row.status === "ready" && row.id === currentId) {
          const synced = document.createElement("button");
          synced.type = "button";
          synced.textContent = "对齐配音";
          synced.onclick = () => syncPlayback(row).catch(report);
          item.append(" ", synced);
        }
      }
      list.append(item);
    }
  }
  $("queue-add").onclick = () => add(state.tab).catch(report);
  panel.ontoggle = () => {
    clearInterval(timer);
    if (panel.open) {
      void refresh().catch(report);
      timer = setInterval(() => refresh().catch(report), 2000);
    }
  };
}
