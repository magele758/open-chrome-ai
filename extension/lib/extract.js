/** Injected into the page. Must stay self-contained (no module locals). */
export async function extractPage() {
  const MAX_CHARS = 9000;
  const title = document.title || "";
  const url = location.href;
  const hostname = location.hostname;
  const selection = (window.getSelection?.().toString() || "").trim();

  const clean = (s) =>
    String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const visible = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (el.closest("[aria-hidden='true']") && !el.closest('article[data-testid="tweet"]')) return false;
    return true;
  };

  const og = (name) =>
    document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") || "";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(pred, ms) {
    const t0 = Date.now();
    let v = pred();
    while (!v && Date.now() - t0 < ms) {
      await sleep(160);
      v = pred();
    }
    return v;
  }

  function metaFallback() {
    const desc = clean(og("og:description") || og("description"));
    const ogTitle = clean(og("og:title"));
    if (!desc && !ogTitle) return "";
    return [ogTitle && ogTitle !== title ? ogTitle : "", desc].filter(Boolean).join("\n");
  }

  function looksLikeChrome(t) {
    const s = clean(t);
    if (!s) return true;
    if (/^(Like|Reply|Repost|Share|Follow|Following|Views?|Likes?|Posts?|评论|转发|喜欢|关注|分享|回复|查看|首页|探索|通知)$/i.test(s)) {
      return true;
    }
    if (/^\d+(\.\d+)?[KMB万亿]?$/.test(s)) return true;
    if (s.length < 24 && /cookie|subscribe|newsletter|sign in|log in|登录|注册/i.test(s)) return true;
    return false;
  }

  function parseXUser(article) {
    const user = article.querySelector('[data-testid="User-Name"]');
    const blob = clean(user?.innerText || "");
    const handle = (blob.match(/@[\w.]+/) || [""])[0];
    const name = blob
      .replace(handle, "")
      .replace(/·.*/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && l !== "·") || "";
    return { name: clean(name), handle };
  }

  function parseXTweet(article) {
    const { name, handle } = parseXUser(article);
    const textEls = [...article.querySelectorAll('[data-testid="tweetText"]')].filter(
      (el) => el.closest('article[data-testid="tweet"]') === article,
    );
    const body = textEls.map((el) => clean(el.innerText)).filter(Boolean).join("\n");
    const timeEl = article.querySelector("time");
    const time = timeEl?.getAttribute("datetime") || clean(timeEl?.textContent || "");
    const permalink = article.querySelector('a[href*="/status/"]')?.getAttribute("href") || "";
    const alts = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .filter((img) => img.closest('article[data-testid="tweet"]') === article)
      .map((img) => clean(img.getAttribute("alt") || ""))
      .filter((alt) => alt && !/^image$/i.test(alt));
    const hasVideo = Boolean(
      article.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"], video'),
    );
    const card = article.querySelector('[data-testid="card.wrapper"]');
    const cardText = card ? clean(card.innerText).slice(0, 240) : "";
    const quoteRoot =
      article.querySelector('[data-testid="quoteTweet"]') ||
      [...article.querySelectorAll('div[role="link"]')].find((n) => n.querySelector('[data-testid="tweetText"]'));
    let quote = "";
    if (quoteRoot) {
      const qText = clean(quoteRoot.querySelector('[data-testid="tweetText"]')?.innerText || "");
      const qUser = clean(quoteRoot.querySelector('[data-testid="User-Name"]')?.innerText || "")
        .split("\n")[0];
      quote = [qUser, qText].filter(Boolean).join("：");
    }
    return { name, handle, body, time, permalink, alts, hasVideo, cardText, quote };
  }

  function formatXTweet(t, heading) {
    const lines = [heading];
    const who = [t.name, t.handle].filter(Boolean).join(" ");
    if (who) lines.push(`作者：${who}`);
    if (t.time) lines.push(`时间：${t.time}`);
    if (t.body) lines.push(`正文：${t.body}`);
    else lines.push("正文：（无文字，可能是纯图片/视频）");
    if (t.alts.length) lines.push(`配图：${t.alts.join("；")}`);
    if (t.hasVideo) lines.push("媒体：含视频");
    if (t.quote) lines.push(`引用：${t.quote}`);
    if (t.cardText) lines.push(`链接卡片：${t.cardText}`);
    return lines.join("\n");
  }

  async function extractX() {
    await waitFor(() => document.querySelector('article[data-testid="tweet"]'), 2500);
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(
      (el) => !el.closest('[data-testid="placementTracking"]') && visible(el),
    );
    const statusId = (location.pathname.match(/\/status\/(\d+)/) || [])[1];
    let main = articles[0] || null;
    if (statusId) {
      const hit = articles.find((el) => {
        const href = el.querySelector(`a[href*="/status/${statusId}"]`)?.getAttribute("href") || "";
        return href.includes(statusId);
      });
      if (hit) main = hit;
    }

    if (!main) {
      const fallback = metaFallback();
      const login = Boolean(document.querySelector('a[href="/login"], [data-testid="loginButton"]'));
      return {
        text:
          fallback ||
          (login
            ? "未能读取帖子正文。当前页面可能需要登录后才能看到内容。"
            : "未能读取帖子正文。等页面加载完成后再点总结。"),
        quotes: [],
        kind: "x",
        videoIsPrimary: false,
      };
    }

    const mainTweet = parseXTweet(main);
    const chunks = [formatXTweet(mainTweet, "【主贴】")];
    const replies = articles.filter((el) => el !== main).slice(0, 8);
    if (replies.length) {
      chunks.push("【相关回复】");
      replies.forEach((el, i) => {
        const t = parseXTweet(el);
        const who = t.handle || t.name || `回复${i + 1}`;
        const body = t.body || (t.alts[0] ? `[图片] ${t.alts[0]}` : "");
        if (body) chunks.push(`${who}：${body}`);
      });
    }

    let text = chunks.join("\n");
    if (text.length < 40) {
      const fallback = metaFallback();
      if (fallback) text = `【主贴】\n${fallback}`;
    }

    const quotes = [];
    if (mainTweet.body) {
      quotes.push({ id: "q_1", text: mainTweet.body.slice(0, 280) });
    }

    return {
      text: text.slice(0, MAX_CHARS),
      quotes,
      kind: "x",
      videoIsPrimary: false,
      hasAttachedVideo: Boolean(mainTweet.hasVideo),
    };
  }

  function extractGeneric() {
    const root =
      document.querySelector(
        '[itemprop="articleBody"], .post-content, .entry-content, .article-content, article, main, [role="main"]',
      ) || document.body;

    const blocks = root.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre, figcaption");
    const parts = [];
    const seen = new Set();

    for (const el of blocks) {
      const nest = el.parentElement?.closest("p, li, blockquote, pre");
      if (nest && nest !== el) continue;
      if (el.closest("nav, footer, aside, form, [role='navigation'], [role='complementary'], [role='banner']")) {
        continue;
      }
      if (!visible(el)) continue;
      const t = clean(el.innerText);
      if (t.length < 12) continue;
      if (looksLikeChrome(t)) continue;
      const key = t.slice(0, 96);
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(t);
      if (parts.join("\n").length > MAX_CHARS) break;
    }

    let text = parts.join("\n");
    if (text.length < 60) {
      const fallback = metaFallback();
      if (fallback.length > text.length) text = fallback;
    }

    const quotes = [];
    for (const p of parts) {
      if (quotes.length >= 8) break;
      if (p.length >= 40 && p.length <= 400) quotes.push({ id: `q_${quotes.length + 1}`, text: p.slice(0, 280) });
    }

    return { text: text.slice(0, MAX_CHARS), quotes, kind: "generic", videoIsPrimary: false };
  }

  const isXHost = /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(hostname);
  const hasXTweet = Boolean(document.querySelector('article[data-testid="tweet"]'));

  let extracted;
  if (isXHost || hasXTweet) extracted = await extractX();
  else extracted = extractGeneric();

  const videos = [...document.querySelectorAll("video")].filter(
    (el) => el.duration && Number.isFinite(el.duration) && el.duration >= 5 && el.offsetWidth > 0,
  );
  const video = videos[0];
  const videoMeta = video
    ? {
        duration: video.duration,
        currentTime: video.currentTime,
        paused: video.paused,
        width: video.videoWidth,
        height: video.videoHeight,
      }
    : null;

  const hostPrimaryVideo = /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com/.test(hostname);
  const videoIsPrimary = Boolean(extracted.videoIsPrimary) || (hostPrimaryVideo && Boolean(videoMeta));

  return {
    title,
    url,
    hostname,
    text: extracted.text || "",
    selection,
    quotes: extracted.quotes || [],
    video: videoIsPrimary ? videoMeta : null,
    videoIsPrimary,
    kind: extracted.kind || "generic",
  };
}

export function seekVideo(seconds) {
  const nodes = [...document.querySelectorAll("video")].filter(
    (el) => el.duration && Number.isFinite(el.duration) && el.offsetWidth > 0,
  );
  const el = nodes[0];
  if (!el) throw new Error("NO_PLAYER");
  el.currentTime = Number(seconds);
  const play = el.play?.();
  if (play && typeof play.catch === "function") play.catch(() => {});
  return true;
}

export function highlightQuote(needle) {
  const target = String(needle || "").trim();
  if (target.length < 8) return false;
  document.querySelectorAll("[data-pagelens-hl]").forEach((n) => {
    const parent = n.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(n.textContent), n);
    parent.normalize();
  });
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent || "";
    const idx = text.indexOf(target.slice(0, 48));
    if (idx === -1) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, Math.min(text.length, idx + Math.min(target.length, 80)));
    const mark = document.createElement("mark");
    mark.dataset.pagelensHl = "1";
    mark.style.background = "#f3d9a4";
    mark.style.color = "inherit";
    try {
      range.surroundContents(mark);
    } catch {
      return false;
    }
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      if (!mark.parentNode) return;
      mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
    }, 1600);
    return true;
  }
  return false;
}

/** MAIN world: YouTube player payload. */
export function readYoutubeCaptionTracks() {
  const player =
    window.ytInitialPlayerResponse ||
    window.ytplayer?.config?.args?.player_response ||
    null;
  let parsed = player;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const tracks = parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return tracks.map((t) => ({
    baseUrl: t.baseUrl,
    languageCode: t.languageCode,
    kind: t.kind,
    name: t.name?.simpleText || "",
  }));
}
