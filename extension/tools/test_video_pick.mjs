import { pickBestVideoIndex, plVideo, scoreVideoInfo } from "../lib/video-pick.js";
import { cleanTranslation } from "../lib/interpret.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const preview = {
  boxW: 160,
  boxH: 90,
  duration: 8,
  currentTime: 0,
  playing: false,
  mainClass: false,
  inPlayer: false,
  hidden: false,
  tag: "video",
  readyState: 1,
};
const main = {
  boxW: 1280,
  boxH: 720,
  duration: 660,
  currentTime: 12,
  playing: true,
  mainClass: true,
  inPlayer: true,
  hidden: false,
  tag: "video",
  readyState: 4,
};
const adish = {
  boxW: 640,
  boxH: 360,
  duration: 15,
  currentTime: 2,
  playing: true,
  mainClass: false,
  inPlayer: true,
  hidden: false,
  tag: "video",
  readyState: 4,
};

assert(scoreVideoInfo(main) > scoreVideoInfo(preview), "main beats preview");
assert(scoreVideoInfo(main) > scoreVideoInfo(adish), "html5-main-video beats other in-player");
assert(pickBestVideoIndex([preview, adish, main]) === 2, "pick main among three");
assert(pickBestVideoIndex([preview, adish]) === 1, "playing larger wins without main class");
assert(pickBestVideoIndex([]) === -1, "empty");

assert(cleanTranslation("<think>plan</think>\n你好世界", "x") === "你好世界", "strip think");

{
  const makeEl = () => ({
    tagName: "VIDEO",
    className: "html5-main-video",
    offsetWidth: 1280,
    offsetHeight: 720,
    videoWidth: 1280,
    videoHeight: 720,
    duration: 60,
    currentTime: 3,
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    readyState: 4,
    playbackRate: 1,
    isConnected: true,
    closest: () => ({}),
    getAttribute: () => "",
    setAttribute() {},
  });
  const first = makeEl();
  const second = makeEl();
  let current = first;
  const gains = [];
  globalThis.document = {
    querySelectorAll: (sel) => (sel.includes("data-pagelens-player") ? [] : [current]),
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.window = globalThis;
  globalThis.AudioContext = class {
    createMediaElementSource(el) {
      this.el = el;
      return { connect() {} };
    }
    createGain() {
      const node = { connect() {}, gain: { value: 1 } };
      gains.push(node);
      return node;
    }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{}] } }; }
    resume() {}
  };
  delete globalThis.__plAudioTap;
  delete globalThis.__plSiMute;
  const a = plVideo("silence");
  assert(a.via === "webaudio", "silence uses webaudio");
  assert(gains[0].gain.value === 0, "speaker gain is 0");
  assert(plVideo("state").silenced === true, "state reports silenced");
  first.isConnected = false;
  current = second;
  const b = plVideo("silence");
  assert(b.rebound === true, "YouTube remount must rebuild the tap on the new video");
  assert(gains[1].gain.value === 0, "new tap is silent");
  assert(globalThis.__plAudioTap.el === second, "tap follows the new video");
  assert(plVideo("state").silenced === true, "new element is silenced");
  delete globalThis.__plAudioTap;
  delete globalThis.__plSiMute;
}

{
  const attr = new Map();
  const makeEl = (info) => ({
    tagName: "VIDEO",
    className: info.className,
    offsetWidth: info.w,
    offsetHeight: info.h,
    videoWidth: info.w,
    videoHeight: info.h,
    duration: info.duration,
    currentTime: info.currentTime,
    paused: info.paused,
    ended: false,
    muted: false,
    volume: 1,
    readyState: 4,
    playbackRate: 1,
    isConnected: true,
    closest: (sel) => (sel.includes("html5-video-player") && info.inPlayer ? {} : null),
    getAttribute: (key) => (key === "data-pagelens-player" && attr.get(info.id) ? "1" : ""),
    setAttribute(key) { if (key === "data-pagelens-player") attr.set(info.id, true); },
    removeAttribute(key) { if (key === "data-pagelens-player") attr.delete(info.id); },
  });
  const preview = makeEl({ id: "preview", className: "", w: 160, h: 90, duration: 8, currentTime: 0, paused: true, inPlayer: false });
  const main = makeEl({ id: "main", className: "html5-main-video", w: 1280, h: 720, duration: 660, currentTime: 40, paused: true, inPlayer: true });
  globalThis.document = {
    querySelectorAll: (sel) => {
      if (sel.includes("data-pagelens-player")) return [preview, main].filter((el) => el.getAttribute("data-pagelens-player") === "1");
      return [preview, main];
    },
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  delete globalThis.__plVideoIndex;
  globalThis.__plVideoIndex = 0;
  attr.set("preview", true);
  const st = plVideo("state");
  assert(Math.abs(st.currentTime - 40) < 0.01, `stale preview must not win over mid-video main, got ${st.currentTime}`);
  delete globalThis.__plVideoIndex;
}

console.log("ok video-pick");
