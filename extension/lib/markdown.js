function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mermaidBlock(src) {
  return `<pre class="mermaid-src">${escapeHtml(src)}</pre>`;
}

export function resolveLinkHref(href, baseUrl) {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#")) return "";
  if (/^(javascript|data|vbscript|file|blob|chrome|chrome-extension|about|edge):/i.test(raw)) {
    return "";
  }
  try {
    const url = new URL(raw, baseUrl || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function openExternal(href) {
  try {
    if (globalThis.chrome?.tabs?.create) {
      chrome.tabs.create({ url: href, active: true });
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function makeRenderer() {
  const Renderer = globalThis.marked?.Renderer;
  if (!Renderer) return undefined;
  const renderer = new Renderer();
  const orig = renderer.code.bind(renderer);
  renderer.code = function code(token, info, escaped) {
    if (token && typeof token === "object") {
      const lang = String(token.lang || "").trim().split(/\s+/)[0].toLowerCase();
      if (lang === "mermaid") return mermaidBlock(token.text || "");
      return orig(token);
    }
    const lang = String(info || "").trim().split(/\s+/)[0].toLowerCase();
    if (lang === "mermaid") return mermaidBlock(token || "");
    return orig(token, info, escaped);
  };
  renderer.link = function link(token, title, text) {
    let href = token;
    let body = text;
    let cap = title;
    if (token && typeof token === "object" && !Array.isArray(token)) {
      href = token.href;
      cap = token.title;
      body =
        token.tokens && this.parser?.parseInline
          ? this.parser.parseInline(token.tokens)
          : token.text || "";
    }
    const safe = resolveLinkHref(href);
    if (!safe) return body || "";
    const titleAttr = cap ? ` title="${escapeHtml(cap)}"` : "";
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${body || safe}</a>`;
  };
  return renderer;
}

let inited = false;

export function initMarkdown() {
  if (inited) return;
  inited = true;
  const mermaid = globalThis.mermaid;
  if (!mermaid) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      primaryColor: "#f4e4d7",
      primaryTextColor: "#1c1917",
      primaryBorderColor: "#c45c26",
      lineColor: "#78716c",
      secondaryColor: "#f7f6f2",
      tertiaryColor: "#ffffff",
      fontFamily: "PingFang SC, Hiragino Sans GB, Noto Sans SC, sans-serif",
    },
    flowchart: { htmlLabels: false, curve: "basis" },
  });
}

export function formatAnswer(text) {
  const src = String(text || "");
  const markedApi = globalThis.marked;
  const purify = globalThis.DOMPurify;
  if (!markedApi?.parse || !purify?.sanitize) {
    return escapeHtml(src).replace(/\n/g, "<br>");
  }
  const html = markedApi.parse(src, {
    async: false,
    gfm: true,
    breaks: true,
    renderer: makeRenderer(),
  });
  return purify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["button", "details", "summary"],
    ADD_ATTR: ["class", "data-t", "data-q", "type", "target", "rel", "open"],
  });
}

/**
 * Splits model response text and explicit reasoning into thinking content and answer text.
 * Supports:
 * 1. Closed `<think>...</think>` or `<thought>...</thought>` tags.
 * 2. Unclosed `<think>...` or `<thought>...` tags during streaming.
 * 3. Explicit reasoning passed from API delta (reasoning_content).
 *
 * @param {string} rawText
 * @param {string} [explicitThinking=""]
 * @returns {{ thinking: string, answer: string, isStreamingThinking: boolean }}
 */
export function splitThinking(rawText = "", explicitThinking = "") {
  let text = String(rawText || "");
  const thinkingParts = [];
  if (explicitThinking && typeof explicitThinking === "string" && explicitThinking.trim()) {
    thinkingParts.push(explicitThinking.trim());
  }

  let isStreamingThinking = false;

  // 1. Check for complete <think>...</think> or <thought>...</thought> blocks
  const closedTagRe = /<(think|thought)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = closedTagRe.exec(text)) !== null) {
    if (match[2].trim()) thinkingParts.push(match[2].trim());
  }
  text = text.replace(closedTagRe, "").trim();

  // 2. Check for unclosed <think> or <thought> (in-progress streaming)
  const openTagMatch = text.match(/<(think|thought)>([\s\S]*)$/i);
  if (openTagMatch) {
    isStreamingThinking = true;
    const tagContent = openTagMatch[2];
    if (tagContent.trim()) thinkingParts.push(tagContent.trim());
    text = text.slice(0, openTagMatch.index).trim();
  }

  const thinking = thinkingParts.join("\n\n").trim();
  return {
    thinking,
    answer: text,
    isStreamingThinking,
  };
}

function autolinkText(root) {
  const skip = new Set(["PRE", "CODE", "A", "BUTTON", "SVG", "TEXTAREA"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (skip.has(p.tagName) || p.classList?.contains("mermaid-wrap") || p.classList?.contains("mermaid-src")) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return /https?:\/\//i.test(node.textContent || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = /(https?:\/\/[^\s<>"'`）】\]]+)/g;
  for (const node of nodes) {
    const text = node.textContent || "";
    const parts = text.split(re);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      const trimmed = part.replace(/[.,;:!?。，、)）]+$/g, "");
      const trail = part.slice(trimmed.length);
      const href = resolveLinkHref(trimmed);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = trimmed;
        frag.appendChild(a);
        if (trail) frag.appendChild(document.createTextNode(trail));
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

export function decorateLinks(root, { baseUrl } = {}) {
  for (const a of [...root.querySelectorAll("a[href]")]) {
    const href = resolveLinkHref(a.getAttribute("href"), baseUrl);
    if (!href) {
      a.replaceWith(document.createTextNode(a.textContent || ""));
      continue;
    }
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
}

export function bindMarkdownLinks(root) {
  if (!root || root.dataset.plLinks === "1") return;
  root.dataset.plLinks = "1";
  root.addEventListener("click", (e) => {
    const a = e.target?.closest?.("a[href]");
    if (!a || !root.contains(a)) return;
    const href = resolveLinkHref(a.getAttribute("href") || a.href);
    e.preventDefault();
    if (href) openExternal(href);
  });
}

export function decorateInlines(root, { baseUrl } = {}) {
  autolinkText(root);
  decorateLinks(root, { baseUrl });
  // Models often format a video index as `0:44`. Only standalone inline
  // timestamps become seek controls; code blocks and existing links stay intact.
  for (const code of root.querySelectorAll('code')) {
    const timestamp = code.textContent.trim();
    if (!/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(timestamp)) continue;
    if (code.closest('pre, a, button, svg, textarea, .mermaid-wrap, .mermaid-src')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ts';
    button.dataset.t = timestamp;
    button.textContent = timestamp;
    button.title = `跳转到 ${timestamp}`;
    code.replaceWith(button);
  }
  const skip = new Set(["PRE", "CODE", "A", "BUTTON", "SVG", "TEXTAREA"]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (skip.has(p.tagName) || p.classList?.contains("mermaid-wrap") || p.classList?.contains("mermaid-src")) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return /\d{1,2}:\d{2}|〔\d+〕/.test(node.textContent || "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = /(\b\d{1,2}:\d{2}(?::\d{2})?\b|〔\d+〕)/g;
  for (const node of nodes) {
    const text = node.textContent || "";
    const parts = text.split(re);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(part)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ts";
        btn.dataset.t = part;
        btn.textContent = part;
        btn.title = `跳转到 ${part}`;
        frag.appendChild(btn);
      } else if (/^〔\d+〕$/.test(part)) {
        const span = document.createElement("span");
        span.className = "ref";
        span.dataset.q = part.replace(/\D/g, "");
        span.textContent = part;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

let mermaidSeq = 0;

export async function enhanceMermaid(root) {
  const mermaid = globalThis.mermaid;
  if (!mermaid?.render || !root) return;
  const blocks = [...root.querySelectorAll("pre.mermaid-src")];
  for (const pre of blocks) {
    const src = pre.textContent || "";
    if (!src.trim()) continue;
    const id = `pagelens-mmd-${++mermaidSeq}`;
    try {
      const { svg, bindFunctions } = await mermaid.render(id, src);
      const wrap = document.createElement("div");
      wrap.className = "mermaid-wrap";
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
      bindFunctions?.(wrap);
    } catch (err) {
      pre.classList.add("mermaid-error");
      const note = document.createElement("div");
      note.className = "mermaid-error-msg";
      note.textContent = "Mermaid 无法渲染：" + (err?.message || String(err));
      pre.before(note);
    }
  }
}
