/**
 * Functions injected into the page via chrome.scripting.executeScript.
 * Must stay self-contained (no module locals / imports).
 */

export function getPageInfo() {
  const videos = [...document.querySelectorAll("video")].filter((el) => el.offsetWidth > 0);
  const video = videos[0];
  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 120) }))
    .filter((h) => h.text)
    .slice(0, 20);
  return {
    title: document.title || "",
    url: location.href,
    readyState: document.readyState,
    selection: (window.getSelection?.().toString() || "").trim().slice(0, 1000),
    headings,
    links: document.querySelectorAll("a[href]").length,
    images: document.querySelectorAll("img").length,
    video: video
      ? {
          duration: video.duration,
          currentTime: video.currentTime,
          paused: video.paused,
        }
      : null,
  };
}

export function getSelectionText() {
  return (window.getSelection?.().toString() || "").trim();
}

export function getLinks(limit) {
  const max = Math.min(Number(limit) || 40, 80);
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href || "";
    if (!href || href.startsWith("javascript:")) continue;
    const text = (a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const key = `${href}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
    if (out.length >= max) break;
  }
  return out;
}

export function findInPage(query, limit) {
  const q = String(query || "").trim();
  if (q.length < 2) return { query: q, count: 0, hits: [], error: "查询太短" };
  const max = Math.min(Number(limit) || 8, 20);
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode() && hits.length < max) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("script, style, noscript")) continue;
    const text = node.textContent || "";
    const idx = text.toLowerCase().indexOf(lower);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 50);
    hits.push({ snippet: text.slice(start, idx + q.length + 70).replace(/\s+/g, " ").trim() });
  }
  return { query: q, count: hits.length, hits };
}

export function queryDom(selector, limit) {
  const max = Math.min(Number(limit) || 20, 50);
  let nodes;
  try {
    nodes = [...document.querySelectorAll(String(selector || ""))].slice(0, max);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
  return nodes.map((el, i) => ({
    i,
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    className: String(el.className || "").slice(0, 120),
    href: el.href || el.getAttribute("href") || "",
    type: el.getAttribute("type") || "",
    text: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 400),
  }));
}

export function listControls(limit) {
  const max = Math.min(Number(limit) || 40, 80);
  const visible = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const hint = (el) => {
    if (el.id) return `#${el.id}`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria.slice(0, 40)}"]`;
    const testid = el.getAttribute("data-testid");
    if (testid) return `[data-testid="${testid}"]`;
    return el.tagName.toLowerCase();
  };
  const nodes = [
    ...document.querySelectorAll(
      "a[href], button, [role='button'], input, textarea, select, [role='tab'], [role='menuitem'], [role='link']",
    ),
  ].filter(visible);
  return nodes.slice(0, max).map((el, i) => ({
    i,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    selector: hint(el),
    text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80),
    href: el.href || "",
  }));
}

/**
 * Operate the page. Must stay self-contained.
 * kind: click | fill | press | select | wait
 */
export async function pageAct(kind, spec) {
  const o = spec || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    text: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
    href: el.href || el.getAttribute("href") || "",
    type: el.getAttribute("type") || "",
  });

  const find = () => {
    const nth = Math.max(0, Number(o.nth) || 0);
    if (o.selector) {
      let nodes;
      try {
        nodes = [...document.querySelectorAll(String(o.selector))].filter(visible);
      } catch (err) {
        return { error: err?.message || String(err) };
      }
      if (!nodes.length) return { error: `没有可见元素：${o.selector}` };
      return { el: nodes[Math.min(nth, nodes.length - 1)], count: nodes.length };
    }
    const needle = String(o.text || "").trim();
    if (!needle) return { error: "需要 selector 或 text" };
    const lower = needle.toLowerCase();
    const nodes = [
      ...document.querySelectorAll(
        "a, button, [role='button'], input, textarea, select, label, summary, [role='link'], [role='tab'], [role='menuitem']",
      ),
    ]
      .filter(visible)
      .filter((el) => {
        const t = `${el.innerText || ""} ${el.value || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        return t === lower || t.includes(lower);
      });
    if (!nodes.length) return { error: `没有匹配「${needle}」的可见控件` };
    return { el: nodes[Math.min(nth, nodes.length - 1)], count: nodes.length };
  };

  const setValue = (el, value) => {
    el.focus();
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  if (kind === "wait") {
    const ms = Math.min(Math.max(Number(o.timeoutMs) || 8000, 200), 20000);
    const t0 = Date.now();
    let hit = find();
    while (hit.error && Date.now() - t0 < ms) {
      await sleep(160);
      hit = find();
    }
    if (hit.error) return { ok: false, error: hit.error, waitedMs: Date.now() - t0 };
    hit.el.scrollIntoView({ block: "center", behavior: "auto" });
    return { ok: true, waitedMs: Date.now() - t0, match: describe(hit.el), count: hit.count };
  }

  const hit = find();
  if (hit.error) return { ok: false, error: hit.error };

  const el = hit.el;
  el.scrollIntoView({ block: "center", behavior: "auto" });

  if (kind === "click") {
    el.focus();
    el.click();
    return { ok: true, action: "click", match: describe(el), count: hit.count, url: location.href };
  }

  if (kind === "fill") {
    const value = String(o.value ?? o.fill ?? "");
    if (el instanceof HTMLSelectElement) {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      setValue(el, value);
    }
    if (o.submit) {
      const form = el.form || el.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    return { ok: true, action: "fill", match: describe(el), length: value.length };
  }

  if (kind === "select") {
    if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "目标不是 <select>" };
    const value = String(o.value || "");
    const opt = [...el.options].find(
      (x) => x.value === value || x.text.trim() === value || x.text.includes(value),
    );
    if (!opt) return { ok: false, error: `没有选项 ${value}` };
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, action: "select", value: el.value, text: opt.text };
  }

  if (kind === "press") {
    const key = String(o.key || "Enter");
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : el;
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    return { ok: true, action: "press", key };
  }

  return { ok: false, error: `未知动作 ${kind}` };
}

export function scrollPage(opts) {
  const o = opts || {};
  if (o.selector) {
    const el = document.querySelector(String(o.selector));
    if (!el) return { ok: false, error: "没有匹配元素" };
    el.scrollIntoView({ block: o.block || "center", behavior: "smooth" });
    return { ok: true, via: "selector" };
  }
  if (typeof o.percent === "number") {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const y = max * (o.percent / 100);
    scrollTo({ top: y, behavior: "smooth" });
    return { ok: true, via: "percent", y };
  }
  if (typeof o.y === "number") {
    scrollTo({ top: o.y, behavior: "smooth" });
    return { ok: true, via: "y" };
  }
  return { ok: false, error: "需要 selector、percent 或 y" };
}

export function readTextTracks() {
  const fmt = (seconds) => {
    if (!Number.isFinite(seconds)) return "0:00";
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const video = [...document.querySelectorAll("video")].find((el) => el.offsetWidth > 0);
  if (!video) return { status: "no-video" };
  const cues = [];
  for (const track of video.textTracks || []) {
    const list = track.cues;
    if (!list) continue;
    for (let i = 0; i < list.length && cues.length < 400; i += 1) {
      const cue = list[i];
      const text = String(cue.text || "").replace(/\s+/g, " ").trim();
      if (text) cues.push({ start: cue.startTime, text });
    }
  }
  if (!cues.length) {
    return {
      status: "missing",
      languages: [...(video.textTracks || [])].map((t) => t.language || t.label || ""),
    };
  }
  return {
    status: "ready",
    text: cues.map((c) => `[${fmt(c.start)}] ${c.text}`).join("\n"),
  };
}

export function readVideoState() {
  const video =
    [...document.querySelectorAll("video")].find((el) => el.offsetWidth > 0) ||
    [...document.querySelectorAll("audio")].find((el) => Number.isFinite(el.duration) && el.duration > 0) ||
    null;
  if (!video) return { ok: false, error: "no-video" };
  return {
    ok: true,
    currentTime: video.currentTime || 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    paused: Boolean(video.paused),
    ended: Boolean(video.ended),
    muted: Boolean(video.muted),
  };
}

export function controlVideo(opts) {
  const o = opts || {};
  const video =
    [...document.querySelectorAll("video")].find((el) => el.offsetWidth > 0) ||
    [...document.querySelectorAll("audio")].find((el) => Number.isFinite(el.duration) && el.duration > 0) ||
    null;
  if (!video) return { ok: false, error: "no-video" };
  if (o.fromStart && video.currentTime > 0.5) video.currentTime = 0;
  if (video.muted) video.muted = false;
  if (o.action === "pause") {
    video.pause();
    return { ok: true, paused: true, currentTime: video.currentTime, duration: video.duration };
  }
  const play = video.play?.();
  if (play && typeof play.then === "function") {
    return play
      .then(() => ({
        ok: true,
        paused: video.paused,
        currentTime: video.currentTime,
        duration: video.duration,
      }))
      .catch((err) => ({
        ok: false,
        error: err?.message || String(err),
        paused: video.paused,
        currentTime: video.currentTime,
        duration: video.duration,
      }));
  }
  return { ok: true, paused: video.paused, currentTime: video.currentTime, duration: video.duration };
}

export function runJs(code) {
  const dump = (value, depth = 0) => {
    if (depth > 5) return "[…]";
    if (value == null) return value;
    const t = typeof value;
    if (t === "string") return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return String(value);
    if (t === "function") return `[Function ${value.name || ""}]`;
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => dump(item, depth + 1));
    if (t === "object") {
      if (typeof Element !== "undefined" && value instanceof Element) {
        return {
          tag: value.tagName,
          id: value.id,
          text: (value.innerText || "").slice(0, 200),
        };
      }
      const out = {};
      let n = 0;
      for (const key of Object.keys(value)) {
        out[key] = dump(value[key], depth + 1);
        n += 1;
        if (n >= 40) break;
      }
      return out;
    }
    return String(value);
  };

  const raw = String(code || "");
  if (!raw.trim()) return { ok: false, error: "空代码" };
  if (raw.length > 8000) return { ok: false, error: "代码过长" };
  const wrapped = /^\s*return\b/.test(raw) || /[;{}]/.test(raw) ? raw : `return (${raw})`;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  try {
    const result = new AsyncFunction(wrapped)();
    return Promise.resolve(result).then(
      (value) => ({ ok: true, result: dump(value) }),
      (err) => ({ ok: false, error: err?.message || String(err) }),
    );
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
