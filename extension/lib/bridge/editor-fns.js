/**
 * 注入页面执行的函数（必须自包含，不能引用模块作用域）：富文本编辑器挑选/回读校验、
 * 已渲染 HTML 内联样式读取、原生 setter 写 input、选取元素内容。
 * 返回值都是 JSON 可序列化对象。
 */

/**
 * op = "pick" | "prepare" | "verify"
 * spec: { selector?, domIndex?（沿用 pick 返回值，避免粘贴后占位文案消失导致换编辑器）, excludeSelectors?, preferPlaceholders?, titleSelector?, titleBefore?, titleEquals?,
 *         maxTitleLength?, expect?: { minChars, minTables, minImages, contains[] } }
 */
export function plEditor(op, spec) {
  const o = spec || {};
  const excludeSelectors = Array.isArray(o.excludeSelectors)
    ? o.excludeSelectors
    : [".title-editor__input", "#title", "[class*='title-editor']"];
  const preferPlaceholders = Array.isArray(o.preferPlaceholders) ? o.preferPlaceholders : ["从这里开始写正文"];
  const titleSelector = o.titleSelector === undefined ? "#title" : o.titleSelector;

  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const isEditable = (el) => {
    if (el.isContentEditable === true) return true;
    const attr = el.getAttribute("contenteditable");
    return attr !== null && ["", "true", "plaintext-only"].includes(attr.toLowerCase());
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const excluded = (el) =>
    excludeSelectors.some((s) => safe(() => el.matches(s) || Boolean(el.closest(s)), false));
  const placeholderOf = (el) => {
    const parts = [
      el.getAttribute("data-placeholder"),
      el.getAttribute("placeholder"),
      el.getAttribute("aria-placeholder"),
      el.getAttribute("aria-label"),
    ];
    for (const n of el.querySelectorAll("[data-placeholder], .placeholder, .is-empty, .is-editor-empty")) {
      parts.push(n.getAttribute("data-placeholder"), n.textContent);
    }
    const first = el.firstElementChild;
    if (first) {
      const content = safe(() => getComputedStyle(first, "::before").content, "");
      if (content && content !== "none" && content !== "normal") parts.push(content.replace(/^["']|["']$/g, ""));
    }
    if (!(el.textContent || "").trim()) parts.push(el.textContent);
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const pick = () => {
    const nodes = o.selector
      ? safe(() => [...document.querySelectorAll(String(o.selector))], [])
      : [...document.querySelectorAll("[contenteditable], .ProseMirror")];
    const seen = new Set();
    const candidates = [];
    let excludedCount = 0;
    let editableIndex = 0;
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!o.selector && !isEditable(el)) continue;
      if (!o.selector && excluded(el)) {
        excludedCount += 1;
        continue;
      }
      const domIndex = editableIndex;
      editableIndex += 1;
      if (!visible(el)) continue;
      const r = rectOf(el);
      const hint = placeholderOf(el);
      let score = 0;
      const reasons = [];
      if (preferPlaceholders.some((p) => p && hint.includes(p))) {
        score += 100;
        reasons.push("placeholder");
      }
      if (el.classList.contains("ProseMirror")) {
        score += 20;
        reasons.push("ProseMirror");
      }
      score += Math.round(Math.min(r.h, 800) / 10);
      if (r.h < 48) {
        score -= 40;
        reasons.push("single-line");
      }
      if (safe(() => Boolean(el.closest("[class*='title']")), false)) {
        score -= 30;
        reasons.push("title-ish");
      }
      candidates.push({ el, domIndex, tag: el.tagName, className: String(el.className || "").slice(0, 80), score, reasons, rect: r, hint });
    }
    candidates.sort((a, b) => b.score - a.score);
    const pinned = o.domIndex != null ? candidates.find((c) => c.domIndex === Number(o.domIndex)) : null;
    const best = pinned || candidates[0];
    return { best, candidates, excludedCount };
  };

  const summary = (picked) => ({
    tag: picked.best.tag,
    className: picked.best.className,
    domIndex: picked.best.domIndex,
    score: picked.best.score,
    reasons: picked.best.reasons,
    rect: picked.best.rect,
    placeholder: picked.best.hint,
    candidates: picked.candidates.slice(0, 6).map((c) => ({ tag: c.tag, className: c.className, score: c.score, reasons: c.reasons })),
    excludedCount: picked.excludedCount,
  });

  const picked = pick();
  if (!picked.best) {
    return { ok: false, code: "NO_EDITOR", error: "没有找到可用的富文本编辑器", excludedCount: picked.excludedCount };
  }
  const el = picked.best.el;

  if (op === "pick") return { ok: true, ...summary(picked) };

  if (op === "prepare") {
    el.scrollIntoView?.({ block: "center", behavior: "auto" });
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1;
    const vh = window.innerHeight || document.documentElement.clientHeight || 1;
    const candidatesAt = [
      [r.left + Math.min(r.width / 2, 240), r.top + Math.min(r.height / 2, 48)],
      [r.left + r.width / 2, r.top + r.height / 2],
    ];
    let point = null;
    for (const [x, y] of candidatesAt) {
      if (x < 0 || y < 0 || x > vw || y > vh) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) {
        point = { x: Math.round(x), y: Math.round(y) };
        break;
      }
    }
    el.focus?.();
    return {
      ok: Boolean(point),
      ...(point ? {} : { code: "NO_EDITOR", error: "编辑器被遮挡或在视口外，无法确定点击位置" }),
      point,
      focused: document.activeElement === el || el.contains(document.activeElement),
      ...summary(picked),
    };
  }

  // verify
  const text = String(el.innerText ?? el.textContent ?? "").trim();
  const chars = text.replace(/\s+/g, "").length;
  const tables = el.querySelectorAll("table").length;
  const imgs = el.querySelectorAll("img").length;
  const titleEl = titleSelector ? safe(() => document.querySelector(titleSelector), null) : null;
  const title = titleEl ? String(titleEl.value ?? titleEl.textContent ?? "").trim() : null;
  const maxTitleLength = Number(o.maxTitleLength) > 0 ? Number(o.maxTitleLength) : 64;
  const probe = text.replace(/\s+/g, "").slice(0, 20);
  const titlePolluted =
    title != null &&
    (title.length > maxTitleLength || (probe.length >= 12 && title.replace(/\s+/g, "").includes(probe)));

  const stats = {
    chars,
    tables,
    imgs,
    paragraphs: el.querySelectorAll("p").length,
    headings: el.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
    links: el.querySelectorAll("a[href]").length,
    htmlLength: el.innerHTML.length,
  };
  const checks = [];
  const check = (name, ok, expected, actual) => checks.push({ name, ok: Boolean(ok), expected, actual });
  const expect = o.expect || {};
  if (expect.minChars != null) check("minChars", chars >= expect.minChars, expect.minChars, chars);
  if (expect.minTables != null) check("minTables", tables >= expect.minTables, expect.minTables, tables);
  if (expect.minImages != null) check("minImages", imgs >= expect.minImages, expect.minImages, imgs);
  for (const needle of Array.isArray(expect.contains) ? expect.contains : []) {
    check(`contains:${String(needle).slice(0, 24)}`, text.includes(String(needle)), String(needle).slice(0, 24), null);
  }
  if (title != null) {
    check("titleNotPolluted", !titlePolluted, `<=${maxTitleLength} chars, 不含正文`, title.slice(0, 80));
    if (o.titleEquals != null) check("titleEquals", title === String(o.titleEquals), String(o.titleEquals), title);
    if (o.titleBefore != null) check("titleUnchanged", title === String(o.titleBefore), String(o.titleBefore), title);
  } else if (o.titleEquals != null) {
    check("titleEquals", false, String(o.titleEquals), null);
  }
  if (!checks.length) check("nonEmpty", chars > 0, ">0", chars);

  return {
    ok: checks.every((c) => c.ok),
    stats,
    title,
    titlePolluted,
    checks,
    editor: { tag: picked.best.tag, className: picked.best.className },
    textSample: text.slice(0, 120),
    ...(o.includeHtml ? { html: el.innerHTML } : {}),
  };
}

/**
 * 读取已渲染元素的 HTML，并用 getComputedStyle 把样式内联（cloneContents / innerHTML 会丢样式表）。
 * spec: { selector, removeSelectors?, keepClass?, maxElements? }
 */
export function plReadRenderedHtml(spec) {
  const o = spec || {};
  const selector = String(o.selector || "").trim();
  if (!selector) return { ok: false, error: "selector 必填" };
  let src;
  try {
    src = document.querySelector(selector);
  } catch (err) {
    return { ok: false, error: `选择器无效：${err?.message || err}` };
  }
  if (!src) return { ok: false, notFound: true, error: `没有元素：${selector}` };

  const inherited = [
    "color", "font-family", "font-size", "font-style", "font-weight", "line-height", "text-align",
    "text-indent", "letter-spacing", "white-space", "word-break", "list-style-type", "text-decoration-line",
  ];
  const own = [
    "background-color", "background-image", "display", "width", "max-width", "height", "vertical-align",
    "border-top-width", "border-top-style", "border-top-color",
    "border-right-width", "border-right-style", "border-right-color",
    "border-bottom-width", "border-bottom-style", "border-bottom-color",
    "border-left-width", "border-left-style", "border-left-color",
    "border-collapse", "border-spacing", "border-radius",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "box-sizing", "overflow-x", "text-shadow", "box-shadow",
  ];
  const trivial = new Set(["0px", "none", "rgba(0, 0, 0, 0)", "transparent", "normal", "auto", "static", "visible", "initial"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "META", "TEMPLATE"]);
  const max = Math.min(Math.max(Number(o.maxElements) || 20000, 100), 50000);
  let count = 0;

  const clone = src.cloneNode(true);
  const walk = (a, b, parentStyle) => {
    if (a.nodeType !== 1 || count >= max) return;
    count += 1;
    const cs = getComputedStyle(a);
    const parts = [];
    for (const prop of inherited) {
      const v = cs.getPropertyValue(prop);
      if (!v) continue;
      if (parentStyle && parentStyle.getPropertyValue(prop) === v) continue;
      parts.push(`${prop}:${v}`);
    }
    for (const prop of own) {
      const v = cs.getPropertyValue(prop);
      if (!v || trivial.has(v)) continue;
      if (prop === "display" && ["block", "inline"].includes(v)) continue;
      if (prop === "box-sizing" && v === "content-box") continue;
      if (prop === "overflow-x" && v === "visible") continue;
      if ((prop === "width" || prop === "height" || prop === "max-width") && !["IMG", "TABLE", "TD", "TH", "SVG", "VIDEO"].includes(a.tagName)) continue;
      if (prop === "background-image" && v === "none") continue;
      parts.push(`${prop}:${v}`);
    }
    if (parts.length) {
      const prev = b.getAttribute("style");
      b.setAttribute("style", `${prev ? `${prev.replace(/;?\s*$/, ";")} ` : ""}${parts.join(";")}`);
    }
    if (a.tagName === "A" && a.href) b.setAttribute("href", a.href);
    if (["IMG", "VIDEO", "SOURCE", "IFRAME"].includes(a.tagName) && a.src) b.setAttribute("src", a.src);
    if (a.tagName === "IMG" && a.currentSrc) b.setAttribute("src", a.currentSrc);
    for (let i = 0; i < a.children.length; i += 1) walk(a.children[i], b.children[i], cs);
  };
  walk(src, clone, null);

  const removals = ["script", "style", "link", "noscript", "iframe", "template", ...(Array.isArray(o.removeSelectors) ? o.removeSelectors : [])];
  for (const sel of removals) {
    try {
      for (const n of clone.querySelectorAll(sel)) n.remove();
    } catch {
      /* 忽略无效选择器 */
    }
  }
  for (const n of [clone, ...clone.querySelectorAll("*")]) {
    if (SKIP_TAGS.has(n.tagName)) continue;
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("data-") || name === "id" || name.startsWith("on") || (name === "class" && o.keepClass !== true)) {
        n.removeAttribute(attr.name);
      }
    }
  }
  const html = clone.outerHTML;
  const text = String(src.innerText ?? src.textContent ?? "").trim();
  return {
    ok: true,
    html,
    stats: {
      chars: text.replace(/\s+/g, "").length,
      tables: clone.querySelectorAll("table").length + (clone.tagName === "TABLE" ? 1 : 0),
      imgs: clone.querySelectorAll("img").length,
      elements: count,
      htmlLength: html.length,
      truncated: count >= max,
    },
  };
}

/** 用原生 value setter 写 input / textarea（绕过 React 等框架的受控值），并触发 input/change。 */
export function plSetInputValue(spec) {
  const o = spec || {};
  let el;
  try {
    el = document.querySelector(String(o.selector || ""));
  } catch (err) {
    return { ok: false, error: `选择器无效：${err?.message || err}` };
  }
  if (!el) return { ok: false, notFound: true, error: `没有元素：${o.selector}` };
  const isTextarea = el instanceof HTMLTextAreaElement;
  const isInput = el instanceof HTMLInputElement;
  if (!isTextarea && !isInput) return { ok: false, error: "目标不是 input/textarea；富文本请用 trusted_type / paste_rich_trusted" };
  const value = String(o.value ?? "");
  el.focus?.();
  const desc = Object.getOwnPropertyDescriptor(isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value, matches: el.value === value, length: el.value.length };
}

/** 选中元素全部内容（供之后的可信 Meta/Ctrl+C 复制，保留 Chrome 序列化出的内联样式）。 */
export function plSelectContents(spec) {
  const o = spec || {};
  let el;
  try {
    el = document.querySelector(String(o.selector || ""));
  } catch (err) {
    return { ok: false, error: `选择器无效：${err?.message || err}` };
  }
  if (!el) return { ok: false, notFound: true, error: `没有元素：${o.selector}` };
  el.scrollIntoView?.({ block: "center", behavior: "auto" });
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  const text = sel.toString();
  return {
    ok: !sel.isCollapsed,
    chars: text.replace(/\s+/g, "").length,
    tables: el.querySelectorAll("table").length,
    imgs: el.querySelectorAll("img").length,
  };
}

/** 等待选择器出现或文本出现（轮询在页面内完成）。 */
export function plWaitFor(spec) {
  const o = spec || {};
  const timeout = Math.min(Math.max(Number(o.timeoutMs) || 8000, 100), 60000);
  const check = () => {
    if (o.selector) {
      try {
        if (!document.querySelector(String(o.selector))) return false;
      } catch {
        return false;
      }
    }
    if (o.text && !(document.body?.innerText || "").includes(String(o.text))) return false;
    return Boolean(o.selector || o.text);
  };
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve({ ok: true, waitedMs: Date.now() - started });
      if (Date.now() - started >= timeout) return resolve({ ok: false, error: "等待超时", waitedMs: timeout });
      return setTimeout(tick, 100);
    };
    tick();
  });
}
