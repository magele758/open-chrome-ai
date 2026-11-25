import { isModelReady, loadSettings } from "./lib/storage.js";

const destination = "http://127.0.0.1:4173/api/translation/pagelens/complete";
const connect = document.querySelector("#connect");
const status = document.querySelector("#status");
let token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
if (location.hash) history.replaceState(null, "", location.pathname);
let displayed;

async function currentModel() {
  const { text } = await loadSettings();
  if (!isModelReady(text)) throw new Error("model unavailable");
  const parsed = new URL(text.baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid provider URL");
  }
  return { host: parsed.host, baseUrl: text.baseUrl.trim(), model: text.model.trim(), apiKey: String(text.apiKey || "").trim() };
}

function showModel(slot) {
  displayed = { baseUrl: slot.baseUrl, model: slot.model };
  document.querySelector("#provider").textContent = slot.host;
  document.querySelector("#model").textContent = slot.model;
  document.querySelector("#selection").hidden = false;
}

async function prepare() {
  if (window !== window.top || !/^[a-f0-9]{64}$/i.test(token)) {
    status.textContent = "请从本机有声书工作台的翻译模型设置发起连接。";
    return;
  }
  try {
    showModel(await currentModel());
    status.textContent = "";
    connect.disabled = false;
  } catch {
    status.textContent = "请先在 PageLens 中选好可用的文本模型，再重新打开连接页。";
  }
}

connect.addEventListener("click", async (event) => {
  if (!event.isTrusted || connect.disabled || !displayed || !token) return;
  connect.disabled = true;
  status.textContent = "正在连接本机工作台…";
  try {
    const slot = await currentModel();
    if (slot.baseUrl !== displayed.baseUrl || slot.model !== displayed.model) {
      showModel(slot);
      status.textContent = "PageLens 已切换模型，请核对后再连接。";
      return;
    }
    const response = await fetch(destination, {
      method: "POST", headers: { "Content-Type": "application/json" },
      mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ token, baseUrl: slot.baseUrl, model: slot.model, apiKey: slot.apiKey }),
    });
    if (!response.ok) {
      status.textContent = "工作台未接受连接。请从工作台发起新的连接，再试一次。";
      return;
    }
    token = "";
    status.textContent = "已连接。回到有声书工作台即可使用这个模型翻译网页。";
  } catch {
    status.textContent = "连接未完成。请确认有声书工作台已在本机启动，或重新从工作台发起连接。";
  } finally {
    connect.disabled = !token;
  }
});

prepare();
