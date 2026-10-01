import { writeClipboardRich, readClipboardRich } from "../lib/clipboard.js";

/** 不依赖文档焦点：选中隐藏 textarea 后 execCommand("copy")，在 copy 事件里替换成 text/html + text/plain。 */
function copyViaEvent({ text = "", html = "" } = {}) {
  const plain = text || html.replace(/<[^>]+>/g, "");
  const holder = document.createElement("textarea");
  holder.value = plain || " ";
  document.body.appendChild(holder);
  holder.select();
  const onCopy = (event) => {
    event.clipboardData.setData("text/plain", plain);
    if (html) event.clipboardData.setData("text/html", html);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy, { once: true, capture: true });
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy, { capture: true });
    holder.remove();
  }
  return ok;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pl.clipboard.write") {
    writeClipboardRich(msg.payload || {})
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === "pl.clipboard.copyEvent") {
    try {
      const ok = copyViaEvent(msg.payload || {});
      sendResponse(ok ? { ok: true } : { ok: false, error: "execCommand('copy') 返回 false" });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false;
  }
  if (msg?.type === "pl.clipboard.read") {
    readClipboardRich()
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  return false;
});
