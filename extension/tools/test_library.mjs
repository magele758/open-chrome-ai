import {
  videoIdentity,
  folderNameFor,
  splitRelPath,
  extOf,
  formatVttTime,
  cuesToVtt,
  parseVtt,
  parseTimedText,
  cuesToMarkdown,
  mergeZhCues,
  TRANSCRIPT_CACHE_PATH,
} from "../lib/library.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(videoIdentity("https://www.youtube.com/watch?v=dQw4w9wgGcQ&t=12") === "yt:dQw4w9wgGcQ", "yt");
assert(videoIdentity("https://www.youtube.com/shorts/dQw4w9wgGcQ") === "yt:dQw4w9wgGcQ", "yt shorts");
assert(videoIdentity("https://music.youtube.com/watch?v=dQw4w9wgGcQ") === "yt:dQw4w9wgGcQ", "yt music");
assert(folderNameFor("yt:dQw4w9wgGcQ") === "yt-dQw4w9wgGcQ", "folder " + folderNameFor("yt:dQw4w9wgGcQ"));
assert(TRANSCRIPT_CACHE_PATH === "~/.cache/pagelens-docs", "cache path");
assert(folderNameFor("https://example.com/a/b") === "example.com-a-b" || folderNameFor("https://example.com/a/b").startsWith("example.com"), "http folder");

assert(splitRelPath("yt-x/original.vtt").join("/") === "yt-x/original.vtt", "rel path");
assert(extOf("yt-x/transcript.md") === "md", "ext");

let threw = false;
try {
  splitRelPath("../secret");
} catch {
  threw = true;
}
assert(threw, "reject ..");
threw = false;
try {
  splitRelPath("/tmp/x");
} catch {
  threw = true;
}
assert(threw, "reject absolute");

assert(formatVttTime(1.2) === "00:00:01.200", "vtt 1.2 " + formatVttTime(1.2));
assert(formatVttTime(3661) === "01:01:01.000", "vtt hour");

const cues = [
  { start: 1.2, text: "hello" },
  { start: 4, text: "world" },
];
const vtt = cuesToVtt(cues);
assert(vtt.startsWith("WEBVTT"), "header");
assert(vtt.includes("00:00:01.200 --> 00:00:04.000"), "range " + vtt);
assert(vtt.includes("hello") && vtt.includes("world"), "texts");

const back = parseVtt(vtt);
assert(back.length === 2 && back[0].text === "hello", "parse vtt");
assert(Math.abs(back[0].start - 1.2) < 0.001, "start");

const timed = parseTimedText("[0:01] hello\n[1:02] world\n[1:02:03] later");
assert(timed[0].start === 1 && timed[1].start === 62 && timed[2].start === 3723, JSON.stringify(timed));

const merged = mergeZhCues(cues, [{ start: 1.2, text: "你好" }]);
assert(merged[0].zh === "你好" && merged[1].text === "world" && !merged[1].zh, "merge zh");

const md = cuesToMarkdown({ identity: "yt:x", title: "Demo: 1", url: "https://youtu.be/x" }, merged);
assert(md.includes("title: "), "frontmatter");
assert(md.includes("hello") && md.includes("你好"), "bilingual md");
assert(md.includes("## 0:01") || md.includes("## 0:01"), "heading time");

console.log("PASS library");
