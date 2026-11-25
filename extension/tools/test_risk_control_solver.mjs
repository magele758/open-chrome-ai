import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { solveRiskControlPlayground } from "../lib/agent/risk-control-solver.js";
import { installSoftwareCanvas } from "./rc_software_canvas.mjs";

const indexUrl = new URL("../../tools/risk-control-playground/index.html", import.meta.url);
const frameUrl = new URL("../../tools/risk-control-playground/verifycenter-captcha-frame.html", import.meta.url);
const indexHtml = readFileSync(indexUrl, "utf8");
const frameHtml = readFileSync(frameUrl, "utf8");

const CLICK_FONT = 'bold 28px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const MONO_25 = "bold 25px ui-monospace, SFMono-Regular, Menlo, monospace";
const MONO_21 = "bold 21px ui-monospace, SFMono-Regular, Menlo, monospace";
const POOLS = ["风和日丽云淡", "春暖花开山青", "晴空万里星河", "安全验证守护", "海阔天空明月", "锦绣前程如意"];
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EXTRA = "0123456789+-=?";
const CARD_IDS = [
  "slider-puzzle",
  "click-text",
  "rotate-image",
  "image-grid",
  "checkbox-human",
  "text-captcha",
  "two-factor-auth",
  "iframe-challenge",
];
const ROTATIONS = [0, 0.3];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function installFrame(iframe, frameHtml) {
  const cw = iframe.contentWindow;
  if (!cw || cw.__rcFrame) return;
  const doc = iframe.contentDocument;
  const bodyMatch = frameHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const scriptMatch = frameHtml.match(/<script>([\s\S]*?)<\/script>/i);
  const bodyInner = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "");
  doc.open();
  doc.write("<!DOCTYPE html><html><head></head><body>" + bodyInner + "</body></html>");
  doc.close();
  const parentWin = iframe.ownerDocument.defaultView;
  const bridge = {
    postMessage(data) {
      const ev = new parentWin.MessageEvent("message", { data });
      Object.defineProperty(ev, "source", { get() { return cw; } });
      parentWin.dispatchEvent(ev);
    }
  };
  Object.defineProperty(cw, "parent", { configurable: true, get() { return bridge; } });
  installSoftwareCanvas(cw);
  cw.eval(scriptMatch[1]);
  cw.__rcFrame = true;
}

function measureInk(window, font, ch, rotation) {
  const canvas = window.document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 64, 64);
  ctx.translate(32, 32);
  ctx.rotate(rotation);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000";
  ctx.fillText(ch, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pts = [];
  let minX = Infinity;
  let minY = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a >= 128 && luma < 140) {
        pts.push([x, y]);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
    }
  }
  const offsets = new Set();
  for (const [x, y] of pts) offsets.add(`${x - minX},${y - minY}`);
  return { count: pts.length, key: [...offsets].sort().join("|") };
}

function assertStampUnique(window) {
  const groups = [
    [CLICK_FONT, [...POOLS.join("")]],
    [MONO_25, [...(CHARSET + EXTRA)]],
    [MONO_21, [...(CHARSET + EXTRA)]],
  ];
  for (const [font, chars] of groups) {
    const uniq = [...new Set(chars)].filter((ch) => ch !== " ");
    const size = font.match(/(\d+)px/)[1];
    for (const rotation of ROTATIONS) {
      const seen = new Map();
      for (const ch of uniq) {
        const ink = measureInk(window, font, ch, rotation);
        const prev = seen.get(ink.key);
        if (prev !== undefined) {
          throw new Error(`font size ${size} rotation ${rotation} ${prev} ${ch}`);
        }
        seen.set(ink.key, ch);
      }
      const space = measureInk(window, font, " ", rotation);
      assert(space.count === 0, `space ink font size ${size} rotation ${rotation}`);
    }
  }
}

function hookFrameInstall(window) {
  installSoftwareCanvas(window);

  window.HTMLCanvasElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const width = this.width;
    const height = this.height;
    return {
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    };
  };

  const srcDesc = Object.getOwnPropertyDescriptor(window.HTMLIFrameElement.prototype, "src");
  const origSrcSet = srcDesc.set;
  Object.defineProperty(window.HTMLIFrameElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      origSrcSet.call(this, value);
      if (String(value).includes("verifycenter") && this.contentWindow) {
        installFrame(this, frameHtml);
      }
    },
  });

  const origSetAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function setAttribute(name, value) {
    origSetAttribute.call(this, name, value);
    if (name === "src" && String(value).includes("verifycenter") && this.contentWindow) {
      installFrame(this, frameHtml);
    }
  };

  const origAppendChild = window.Node.prototype.appendChild;
  window.Node.prototype.appendChild = function appendChild(node) {
    const result = origAppendChild.call(this, node);
    if (node && node.nodeName === "IFRAME") {
      const src = `${node.getAttribute?.("src") || ""} ${node.src || ""}`;
      if (src.includes("verifycenter")) installFrame(node, frameHtml);
    }
    return result;
  };
}

async function main() {
  delete globalThis.document;
  const gate = await solveRiskControlPlayground({});
  assert(gate && gate.ok === false && gate.error === "当前页面不是 PageLens 风控沙盒", "gate");

  const dom = new JSDOM(indexHtml, {
    url: "http://127.0.0.1:18473/",
    contentType: "text/html",
    runScripts: "dangerously",
    beforeParse(window) {
      hookFrameInstall(window);
    },
  });

  try {
    for (const iframe of dom.window.document.querySelectorAll("iframe")) {
      const src = `${iframe.getAttribute("src") || ""} ${iframe.src || ""}`;
      if (src.includes("verifycenter")) installFrame(iframe, frameHtml);
    }

    globalThis.document = dom.window.document;
    assertStampUnique(dom.window);

    const grid = await solveRiskControlPlayground({ only: ["image-grid"] });
    assert(grid && grid.ok === true, "grid");
    const doc = globalThis.document;
    assert(doc.querySelector("#rc-image-grid").getAttribute("data-rc-status") === "passed", "image-grid");
    for (const id of CARD_IDS) {
      if (id === "image-grid") continue;
      const status = doc.querySelector(`#rc-${id}`).getAttribute("data-rc-status");
      assert(status === "idle", `${id} ${status}`);
    }

    const full = await solveRiskControlPlayground({ mode: "full" });
    assert(full && full.ok === true, "full");
    for (const id of CARD_IDS) {
      const status = doc.querySelector(`#rc-${id}`).getAttribute("data-rc-status");
      assert(status === "passed", `${id} ${status}`);
    }
    assert(doc.body.dataset.rcModalOpen !== "true", "rcModalOpen");
    assert(full.modal?.open !== true, "modal.open");

    const dumped = JSON.stringify(full);
    const stateDump = JSON.stringify(dom.window.__RC_PLAYGROUND_STATE__());
    for (const secret of ["targetX", "expectedAnswer", "expectedCode", "targetSequence"]) {
      assert(!dumped.includes(secret), secret);
      assert(!stateDump.includes(secret), secret);
    }
  } finally {
    dom.window.close();
    delete globalThis.document;
  }

  console.log("PASS test_risk_control_solver.mjs");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
