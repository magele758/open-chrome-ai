import { sendPrompt } from "./agent-loop.js";
import { openClipModal } from "./clippings-ui.js";
import { $, on } from "./dom.js";
import { pushError } from "./messages.js";
import { fitInput, renderModelLine, setModelLineMeta } from "./model-line.js";
import { setView } from "./session.js";
import { handleSlashKey, hideSlashMenu, updateSlashMenu } from "./slash-menu.js";
import { state } from "./state.js";
import { syncTextCatalog } from "./text-providers-ui.js";
import { saveSettings } from "../lib/storage.js";

let composerBound = false;

function renderAttach() {
  const row = $("attach-row");
  if (!row) return;
  row.classList.toggle("hidden", !state.image);
  if (state.image && $("attach-thumb")) $("attach-thumb").src = state.image;
}

async function consumePending() {
  const data = await chrome.storage.session.get(["pendingSelection", "pendingClip", "pendingReview"]);
  if (data.pendingClip) {
    await chrome.storage.session.remove("pendingClip");
    openClipModal(data.pendingClip);
    return;
  }
  if (data.pendingReview) {
    await chrome.storage.session.remove("pendingReview");
    setView("review");
    return;
  }
  const pendingSelection = data.pendingSelection;
  if (!pendingSelection) return;
  await chrome.storage.session.remove("pendingSelection");
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
      const text = $("input")?.value?.trim();
      if (!text) {
        if (state.busy) {
          console.info("[pagelens] sendPrompt busy-stop");
          state.stopIntent = "user";
          state.abort?.abort();
          setModelLineMeta("已请求停止上一轮");
        } else {
          console.info("[pagelens] sendPrompt empty");
        }
        return;
      }
      if ($("input")) $("input").value = "";
      hideSlashMenu();
      fitInput();
      sendPrompt(text, { clearImage: true }).catch((err) => {
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
    state.settings.textRef = { providerId: value.slice(0, sep), modelId: value.slice(sep + 2) };
    syncTextCatalog();
    try {
      state.settings = await saveSettings(state.settings);
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
