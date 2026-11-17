import { sendPrompt } from "./agent-loop.js";
import { openClipModal } from "./clippings-ui.js";
import { $, on } from "./dom.js";
import { pushError } from "./messages.js";
import { fitInput, renderModelLine, setModelLineMeta } from "./model-line.js";
import { setView } from "./session.js";
import { handleSlashKey, hideSlashMenu, updateSlashMenu } from "./slash-menu.js";
import { state } from "./state.js";
import { syncTextCatalog } from "./text-providers-ui.js";
import { hydrateTextCatalog } from "../lib/text-providers.js";
import { modifySettings } from "../lib/storage.js";

let composerBound = false;

function renderAttach() {
  const row = $("attach-row");
  if (!row) return;
  row.classList.toggle("hidden", !state.image);
  if (state.image && $("attach-thumb")) $("attach-thumb").src = state.image;
}

async function consumePending() {
  const key = `pl.contextMenu.${state.windowId}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return;
  await chrome.storage.session.remove(key);
  if (pending.clip) {
    openClipModal(pending.clip);
    return;
  }
  const pendingSelection = pending.selection;
  if (!pendingSelection) return;
  if ($("input")) {
    $("input").value = `关于这段选区：\n${pendingSelection}\n\n请解释它在本页里的含义。`;
    $("input").focus();
  }
}

function bindComposer() {
  if (composerBound) return;
  composerBound = true;
  on("btn-send", "click", () => {
    try {
      if (state.busy) {
        console.info("[pagelens] sendPrompt busy-stop");
        state.stopIntent = "user";
        state.abort?.abort();
        setModelLineMeta("已请求停止上一轮");
        return;
      }
      const text = $("input")?.value?.trim();
      if (!text) {
        console.info("[pagelens] sendPrompt empty");
        return;
      }
      if ($("input")) $("input").value = "";
      hideSlashMenu();
      fitInput();
      sendPrompt(text, { clearImage: true }).catch((err) => {
        if (err?.code === "WINDOW_BUSY") {
          if (!$("input").value) $("input").value = text;
          fitInput();
          setModelLineMeta(err.message);
          return;
        }
        console.error("[pagelens] send", err);
        pushError("发送失败：" + (err.message || err));
      });
    } catch (err) {
      console.error("[pagelens] click send", err);
      pushError("发送失败：" + (err.message || err));
    }
  });
  on("input", "keydown", (e) => {
    if (handleSlashKey(e)) return;
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    $("btn-send")?.click();
  });
  on("input", "input", () => {
    fitInput();
    updateSlashMenu();
  });
  on("input", "click", updateSlashMenu);
  on("input", "keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      updateSlashMenu();
    }
  });
  $("text-model-pick")?.addEventListener("change", async (e) => {
    const value = String(e.target.value || "");
    const sep = value.indexOf("::");
    if (sep < 0) return;
    const picked = { providerId: value.slice(0, sep), modelId: value.slice(sep + 2) };
    state.settings.textRef = picked;
    syncTextCatalog();
    try {
      const saved = await modifySettings((latest) => {
        const catalog = hydrateTextCatalog({ ...latest, textRef: picked }, latest.text);
        return {
          ...latest,
          textProviders: catalog.textProviders,
          textRef: catalog.textRef,
          text: { ...catalog.text, summaryInputTokens: latest.text?.summaryInputTokens },
        };
      });
      state.settings.textProviders = saved.textProviders;
      state.settings.textRef = saved.textRef;
      state.settings.text = saved.text;
      state.settings.agentBridgeOrigins = saved.agentBridgeOrigins;
    } catch {
      /* keep local selection */
    }
    renderModelLine();
  });
  console.info("[pagelens] wire send", Boolean($("btn-send")), "shortcuts", Boolean($("skills")));
}


export {
  composerBound,
  renderAttach,
  consumePending,
  bindComposer,
};
