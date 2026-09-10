import { pickBestVideoIndex, scoreVideoInfo } from "../lib/video-pick.js";
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

console.log("ok video-pick");
