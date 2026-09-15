/** Player src that is a video-only Twitter/X adaptive variant (no voice track). */
const TWIMG_VIDEO_ONLY = /video\.twimg\.com\/.*\/vid\/(?:avc1|hev1|hvc1|vp9|av01)\//i;
const TWIMG_AUDIO = /video\.twimg\.com\/.*\/(?:aud|audio)\//i;
const TWIMG_AAC = /video\.twimg\.com\/.*\/vid\/mp4a\//i;
const TWIMG_STATUS_ID = /video\.twimg\.com\/(?:amplify_video|ext_tw_video|tweet_video)\/(\d+)/i;
const PAGE_ONLY_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|bilibili\.com)$/i;

export function isTwimgVideoOnlyUrl(url) {
  const src = String(url || "");
  if (!TWIMG_VIDEO_ONLY.test(src)) return false;
  return !TWIMG_AUDIO.test(src) && !TWIMG_AAC.test(src);
}

export function twitterStatusUrl(url) {
  const src = String(url || "");
  try {
    const parsed = new URL(src);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com") {
      const id = parsed.pathname.match(/\/status\/(\d+)/)?.[1];
      if (id) return `https://x.com/i/status/${id}`;
    }
  } catch {
    /* ignore */
  }
  const twimgId = src.match(TWIMG_STATUS_ID)?.[1];
  return twimgId ? `https://x.com/i/status/${twimgId}` : "";
}

function pageHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function interpretSourceUrls({ pageUrl, mediaSrc, audioSrc } = {}) {
  const page = String(pageUrl || "");
  const src = String(mediaSrc || "");
  const audio = String(audioSrc || "");
  const host = pageHost(page || src || audio);
  const file = /^https?:/i.test(audio) ? audio : (/^https?:/i.test(src) ? src : undefined);

  if (PAGE_ONLY_HOST.test(host)) {
    return { url: page, mediaUrl: undefined };
  }
  return { url: page || file, mediaUrl: file };
}
