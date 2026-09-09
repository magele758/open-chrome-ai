import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../docs/mockups");
const WS = process.argv[2];
if (!WS) {
  console.error("usage: node cdp_demo.mjs <page-websocket-url>");
  process.exit(1);
}

const { default: WebSocket } = await import("ws");
const ws = new WebSocket(WS);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
    setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        reject(new Error("timeout " + method));
      }
    }, 20000);
  });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

await send("Runtime.enable");
await send("Page.enable");

async function evalExpr(expression, awaitPromise = true) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "eval failed");
  }
  return result.result?.value;
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const dest = path.join(OUT, name);
  fs.writeFileSync(dest, Buffer.from(data, "base64"));
  console.log("wrote", dest);
}

await evalExpr(`(async () => {
  const settings = {
    text: { preset: "custom", baseUrl: "http://127.0.0.1:18787/v1", model: "mock-text", apiKey: "local" },
    multimodal: { preset: "custom", baseUrl: "http://127.0.0.1:18787/v1", model: "mock-vision", apiKey: "local" },
    multimodalSameAsText: false,
    answerLanguage: "zh-CN",
    shareActiveTab: true,
  };
  await chrome.storage.local.set({ settings });
  return "saved";
})()`);

await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 1200));

await evalExpr(`(async () => {
  const btn = document.getElementById("btn-settings");
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 200));
  return document.getElementById("view-settings")?.className || "";
})()`);
await shot("02-settings.png");

await evalExpr(`(async () => {
  const testBtns = [...document.querySelectorAll("[data-test='text']")];
  if (testBtns[0]) testBtns[0].click();
  await new Promise((r) => setTimeout(r, 800));
  return document.querySelector("[data-test-status='text']")?.textContent || "";
})()`).then((t) => console.log("text test:", t));

await evalExpr(`(async () => {
  document.getElementById("btn-back")?.click();
  await new Promise((r) => setTimeout(r, 400));
  return document.getElementById("ctx-title")?.textContent || "";
})()`).then((t) => console.log("ctx:", t));
await shot("02-chat-empty.png");

await evalExpr(`(async () => {
  const skills = [...document.querySelectorAll("#skills button, .big-actions button")];
  const sum = skills.find((b) => b.textContent.includes("总结"));
  if (sum) sum.click();
  await new Promise((r) => setTimeout(r, 1800));
  return document.getElementById("msgs")?.innerText?.slice(0, 400) || "";
})()`).then((t) => console.log("msgs:\n", t));
await shot("02-chat-summary.png");

ws.close();
