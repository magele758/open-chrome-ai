import assert from "node:assert/strict";
import { interpretSourceUrls, isTwimgVideoOnlyUrl, twitterStatusUrl } from "../lib/media-url.js";

const videoOnly = "https://video.twimg.com/amplify_video/1234567890123456789/vid/avc1/1924x1080/clip.mp4?tag=29";
const audioOnly = "https://video.twimg.com/amplify_video/1234567890123456789/aud/mp4a/128000/clip.mp4";
const tweet = "https://x.com/someone/status/1234567890123456789";
const youtube = "https://www.youtube.com/watch?v=abcdefghijk";
const ytMedia = "https://rr1---sn-example.googlevideo.com/videoplayback?id=1";

assert.equal(isTwimgVideoOnlyUrl(videoOnly), true);
assert.equal(isTwimgVideoOnlyUrl(audioOnly), false);
assert.equal(twitterStatusUrl(videoOnly), "https://x.com/i/status/1234567890123456789");
assert.equal(twitterStatusUrl(tweet), "https://x.com/i/status/1234567890123456789");

assert.deepEqual(interpretSourceUrls({ pageUrl: tweet, mediaSrc: videoOnly, audioSrc: audioOnly }), {
  url: tweet,
  mediaUrl: audioOnly,
}, "prefer the twimg audio rendition when the page already fetched it");

assert.deepEqual(interpretSourceUrls({ pageUrl: tweet, mediaSrc: videoOnly }), {
  url: tweet,
  mediaUrl: videoOnly,
}, "tweet page keeps the working twimg file URL");

assert.deepEqual(interpretSourceUrls({ pageUrl: videoOnly, mediaSrc: videoOnly }), {
  url: videoOnly,
  mediaUrl: videoOnly,
}, "opened twimg tab downloads that file instead of the status page");

assert.deepEqual(interpretSourceUrls({ pageUrl: youtube, mediaSrc: ytMedia }), {
  url: youtube,
  mediaUrl: undefined,
}, "YouTube keeps using the watch page");

assert.deepEqual(interpretSourceUrls({ pageUrl: "https://news.example/watch", mediaSrc: "https://cdn.example/full.mp4" }), {
  url: "https://news.example/watch",
  mediaUrl: "https://cdn.example/full.mp4",
}, "generic sites still pass a real media file");

console.log("PASS media-url twitter keeps direct twimg file; YouTube stays page-only");
