import { openDubFolder } from "./dub-folder.js";
import { canMoveDubJob } from "../lib/dub-queue.js";
import { INTERPRET_CMD } from "../lib/interpret-messages.js";
import { loadFullMediaArchive } from "../lib/audio-composer.js";
import { videoIdentity } from "../lib/library.js";
import { bindMediaSource, isVideoPack, isVideoUrl, packForMediaWrite, mediaActionTab } from "./tab-context.js";
import { state } from "./state.js";
import { $ } from "./dom.js";

const icons = {
  folder: "M3 6h7l2 2h9v11H3z",
  pause: "M8 5v14M16 5v14", play: "M7 4l13 8-13 8z",
  up: "m6 14 6-6 6 6", down: "m6 10 6 6 6-6",
  remove: "M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6m4-6v6",
  info: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 11v6m0-10v.2",
  retry: "M4 10a8 8 0 1 1 1 7M4 4v6h6", sync: "M3 5h18v12H3zM8 21h8m-4-4v4",
  video: "M2 6h13v12H2zM15 10l6-3v10l-6-3",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", icons[name]);
  svg.append(path);
  return svg;
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function videoCover(row) {
  const box = document.createElement("div");
  box.className = "queue-cover";
  box.append(icon("video"));
  const youtube = /^yt:([a-zA-Z0-9_-]+)$/.exec(row.id);
  const frame = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(row.poster || "") ? row.poster : "";
  const fallback = youtube ? `https://i.ytimg.com/vi/${youtube[1]}/mqdefault.jpg` : "";
  const url = httpUrl(row.poster) || frame || fallback;
  if (url) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      if (fallback && img.src !== fallback) img.src = fallback;
      else img.remove();
    };
    img.src = url;
    box.append(img);
  }
  return box;
}

export function bindDubQueue(toggleDubPlayback) {
  const panel = $("dub-queue"), list = $("queue-items"), status = $("queue-status"), player = $("queue-player");
  let timer, signature, objectUrl, previewId, revision = 0;
  const missing = new Set();
  const busy = new Set();
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
    const audio = archive?.compactAudioBlob || archive?.audioBlob;
    if (!audio) {
      missing.add(row.id);
      await refresh();
      throw Error("音频缓存已清除或过期，请重新处理");
    }
    player.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    previewId = row.id;
    player.src = objectUrl = URL.createObjectURL(audio);
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
  async function remove(row) {
    await command("queueDelete", { id: row.id });
    if (previewId === row.id) {
      player.pause();
      player.removeAttribute("src");
      player.load();
      player.hidden = true;
      URL.revokeObjectURL(objectUrl);
      objectUrl = previewId = null;
    }
    for (const pack of [state.pack, state.mediaPack]) {
      if (pack?.archive?.videoId === row.id) pack.archive = null;
    }
    missing.delete(row.id);
    status.textContent = "已删除";
  }
  async function refresh() {
    const request = ++revision;
    const { jobs } = await command("queueList");
    if (request !== revision) return;
    const labels = { live: "实时同传", ready: "已完成", queued: "排队中", paused: "已暂停", running: "处理中", failed: "失败", expired: "缓存已过期" };
    const rows = jobs.map(row => row.status === "ready" && ((row.expireAt && row.expireAt <= Date.now()) || missing.has(row.id)) ? { ...row, status: "expired" } : row);
    const tab = state.tab;
    const canAdd = Boolean(tab?.id && (isVideoPack(state.pack) || isVideoUrl(tab.url)));
    $("queue-add").disabled = !canAdd;
    $("queue-add").textContent = canAdd ? "加入队列 · " + (tab.title || tab.url) : "切换到视频标签页即可加入队列";
    const currentId = videoIdentity(mediaActionTab()?.url);
    const next = JSON.stringify([currentId, rows]);
    if (next === signature) return;
    signature = next;
    const focused = list.contains(document.activeElement) && document.activeElement.dataset.actionKey;
    list.replaceChildren();
    if (!rows.length) status.textContent = "队列为空";
    else if (status.textContent === "队列为空") status.textContent = "";
    const waiting = rows.filter(canMoveDubJob);
    for (const row of rows) {
      const item = document.createElement("li");
      item.dataset.status = row.status;
      const body = document.createElement("div");
      body.className = "queue-body";
      const title = document.createElement("strong");
      title.title = title.textContent = row.title || row.url || row.id;
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      meta.textContent = [row.live ? "边听边生成" : labels[row.status], row.detail].filter(Boolean).join(" · ");
      meta.title = meta.textContent;
      const actions = document.createElement("div");
      actions.className = "queue-actions";
      function button(name, label, run, disabled = false) {
        const el = document.createElement("button");
        el.type = "button";
        el.title = label;
        el.setAttribute("aria-label", label);
        el.dataset.action = name;
        el.dataset.actionKey = row.id + ":" + name;
        el.disabled = disabled || busy.has(row.id);
        el.append(icon(name));
        if (name === "up" || name === "down") el.append(label);
        el.onclick = async () => {
          if (busy.has(row.id)) return;
          busy.add(row.id);
          el.disabled = true;
          try { await run(); } catch (err) { report(err); }
          finally {
            busy.delete(row.id);
            signature = null;
            await refresh().catch(report);
          }
        };
        actions.append(el);
      }
      const op = (name, extra) => command(name, { id: row.id, ...extra });
      if (row.status === "queued" || row.status === "running") button("pause", "暂停后台处理", () => op("queuePause"));
      if (row.status === "paused") button("play", "继续处理", () => op("queueContinue"));
      if (row.status === "ready") {
        button("play", "试听", () => listen(row));
        if (row.id === currentId) button("sync", "对齐配音", () => syncPlayback(row));
      }
      if (["failed", "expired"].includes(row.status)) button("retry", "重新处理", () => add({ url: row.url, title: row.title }));
      {
        const index = waiting.indexOf(row);
        button("up", "上移", () => op("queueMove", { direction: -1 }), index <= 0);
        button("down", "下移", () => op("queueMove", { direction: 1 }), index < 0 || index === waiting.length - 1);
      }
      button("remove", row.status === "ready" ? "删除成品" : "删除任务", () => remove(row));
      const url = httpUrl(row.url) || (row.id.startsWith("yt:") ? "https://www.youtube.com/watch?v=" + encodeURIComponent(row.id.slice(3)) : httpUrl(row.id));
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = url;
        link.setAttribute("aria-label", "打开原视频：" + url);
        link.dataset.actionKey = row.id + ":info";
        link.append(icon("info"));
        actions.append(link);
      }
      body.append(title, meta, actions);
      item.append(videoCover(row), body);
      list.append(item);
    }
    if (focused) Array.from(list.querySelectorAll("[data-action-key]")).find(el => el.dataset.actionKey === focused)?.focus({ preventScroll: true });
  }
  const folder = $("queue-folder");
  folder.replaceChildren(icon("folder"));
  folder.onclick = async () => {
    folder.disabled = true;
    try { await openDubFolder(status); } catch (err) { report(err); }
    finally { folder.disabled = false; }
  };
  $("queue-add").onclick = () => add(state.tab).catch(report);
  panel.ontoggle = () => {
    clearInterval(timer);
    if (panel.open) {
      void refresh().catch(report);
      timer = setInterval(() => refresh().catch(report), 2000);
    }
  };
}
