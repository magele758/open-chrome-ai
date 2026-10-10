/**
 * Functions injected into the page via chrome.scripting.executeScript.
 * Must stay self-contained (no module locals / imports).
 */

export function getPageInfo() {
  const all = [...document.querySelectorAll("video, audio")].filter((el) => {
    if (el.tagName === "AUDIO") return Number.isFinite(el.duration) && el.duration > 0;
    return (el.offsetWidth || 0) >= 80 && (el.offsetHeight || 0) >= 45;
  });
  const marked = all.find((el) => el.getAttribute("data-pagelens-player") === "1");
  const video =
    marked ||
    all.slice().sort((a, b) => {
      const cls = (n) => (/html5-main-video/.test(String(n.className || "")) ? 1e6 : 0);
      const area = (n) => (n.offsetWidth || 0) * (n.offsetHeight || 0);
      const live = (n) => (!n.paused && !n.ended ? 1e5 : 0);
      return cls(b) + area(b) + live(b) - (cls(a) + area(a) + live(a));
    })[0] ||
    null;
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
    videoCount: all.length,
    video: video
      ? {
          duration: video.duration,
          currentTime: video.currentTime,
          paused: video.paused,
          index: all.indexOf(video),
          count: all.length,
        }
      : null,
  };
}

export function getSelectionText() {
  return (window.getSelection?.().toString() || "").trim();
}

export function getSelectionRich(maxChars) {
  const max = Math.min(Math.max(Number(maxChars) || 50000, 1000), 200000);
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return { text: "", html: "" };
  const box = document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i += 1) box.appendChild(sel.getRangeAt(i).cloneContents());
  for (const el of box.querySelectorAll("script, style, noscript")) el.remove();
  for (const a of box.querySelectorAll("a[href]")) a.setAttribute("href", a.href || a.getAttribute("href"));
  for (const img of box.querySelectorAll("img[src]")) img.setAttribute("src", img.src || img.getAttribute("src"));
  const html = box.innerHTML;
  return {
    text: sel.toString(),
    html: html.length > max ? html.slice(0, max) : html,
    truncated: html.length > max,
  };
}

/**
 * 把文字/富文本粘贴进页面：先派发 paste 事件（ProseMirror、Slate、Draft 等编辑器自己处理），
 * 没人拦截再退到 insertHTML / insertText；普通输入框直接写 value。必须自包含。
 */
export function pasteIntoPage(spec) {
  const o = spec || {};
  const text = String(o.text ?? "");
  const html = String(o.html ?? "");
  if (!text && !html) return { ok: false, error: "没有可粘贴的内容" };
  let el = null;
  if (o.selector) {
    try {
      el = document.querySelector(String(o.selector));
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
    if (!el) return { ok: false, error: `没有元素：${o.selector}`, notFound: true };
  } else {
    el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    if (!el) return { ok: false, error: "页面没有焦点元素，请传 selector" };
  }
  el.scrollIntoView?.({ block: "center", behavior: "auto" });
  el.focus?.();
  const plain = text || html.replace(/<[^>]+>/g, "");

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = o.replace ? plain : el.value.slice(0, start) + plain + el.value.slice(end);
    if (desc?.set) desc.set.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: plain, inputType: "insertFromPaste" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, method: "value", length: plain.length };
  }

  if (!el.isContentEditable) return { ok: false, error: "目标不是输入框或可编辑区域" };
  if (o.replace) document.execCommand?.("selectAll", false);

  if (typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
    const dt = new DataTransfer();
    if (plain) dt.setData("text/plain", plain);
    if (html) dt.setData("text/html", html);
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    if (event.defaultPrevented) return { ok: true, method: "paste-event", length: plain.length };
  }
  if (html && document.execCommand?.("insertHTML", false, html)) {
    return { ok: true, method: "insertHTML", length: plain.length };
  }
  if (document.execCommand?.("insertText", false, plain)) {
    return { ok: true, method: "insertText", length: plain.length };
  }
  return { ok: false, error: "编辑器拒绝了粘贴，可改用 fill 或手动 Ctrl+V" };
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
    nodes = [...document.querySelectorAll(String(selector || ""))];
    if (!nodes.length) {
      const walk = (root) => {
        for (const host of root.querySelectorAll("*")) {
          if (!host.shadowRoot) continue;
          nodes.push(...host.shadowRoot.querySelectorAll(String(selector || "")));
          walk(host.shadowRoot);
        }
      };
      walk(document);
    }
    nodes = nodes.slice(0, max);
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
  const max = Math.min(Number(limit) || 60, 150);
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
  const checkRoles = "[role='checkbox'], [role='switch'], [role='radio']";
  const controlSelector =
    `a[href], button, [role='button'], input, textarea, select, [role='tab'], [role='menuitem'], [role='link'], ${checkRoles}`;
  const all = [];
  const gather = (root) => {
    all.push(...root.querySelectorAll(controlSelector));
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) gather(host.shadowRoot);
  };
  gather(document);
  const seen = new Set();
  const nodes = all.filter((el) => (seen.has(el) ? false : (seen.add(el), visible(el))));
  // 打开的弹窗优先：弹窗里的控件排前面，避免被页面主体的上百个控件挤出 limit。
  const modals = [...document.querySelectorAll("[role='dialog'], [aria-modal='true'], dialog[open]")].filter(visible);
  const inModal = (el) => modals.some((m) => m.contains(el));
  const ordered = modals.length ? [...nodes.filter(inModal), ...nodes.filter((el) => !inModal(el))] : nodes;
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const isCheck = (el) =>
    (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) || el.matches(checkRoles);
  const checkedOf = (el) =>
    el instanceof HTMLInputElement
      ? el.checked
      : el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked";
  const labelOf = (el) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.labels?.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    let node = el;
    for (let n = 0; n < 4 && node.parentElement; n += 1) {
      node = node.parentElement;
      if (node.querySelectorAll(`input[type='checkbox'], input[type='radio'], ${checkRoles}`).length > 1) break;
      const t = clean(node.innerText);
      if (t && t.length <= 120) return t;
    }
    return "";
  };
  return ordered.slice(0, max).map((el, i) => {
    const item = {
      i,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      selector: hint(el),
      text: clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").slice(0, 80),
      href: el.href || "",
    };
    if (isCheck(el)) {
      item.checked = checkedOf(el);
      item.text = item.text || labelOf(el).slice(0, 80);
    }
    if (modals.length && inModal(el)) item.modal = true;
    return item;
  });
}

/**
 * 读/定位复选框、开关、单选（原生 input 与 role=checkbox|switch|radio，含 shadow DOM）。
 * spec: { labels?: string[], exact?: boolean, scroll?: boolean }
 * 不传 labels 返回全部可见项；传了则按标签文字（精确 > 前缀 > 包含）匹配并返回视口中心坐标。
 * 必须自包含（会被注入页面）。
 */
export function checkStates(spec) {
  const o = spec || {};
  const visible = (el) => {
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const roles = "[role='checkbox'], [role='switch'], [role='radio']";
  const selector = `input[type='checkbox'], input[type='radio'], ${roles}`;
  const all = [];
  const gather = (root) => {
    all.push(...root.querySelectorAll(selector));
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) gather(host.shadowRoot);
  };
  gather(document);
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const checkedOf = (el) =>
    el instanceof HTMLInputElement
      ? el.checked
      : el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked";
  const labelOf = (el) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.labels?.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    let node = el;
    for (let n = 0; n < 4 && node.parentElement; n += 1) {
      node = node.parentElement;
      if (node.querySelectorAll(selector).length > 1) break;
      const t = clean(node.innerText);
      if (t && t.length <= 120) return t;
    }
    return "";
  };
  const rows = [...new Set(all)].filter(visible).map((el) => ({
    el,
    label: labelOf(el),
    checked: checkedOf(el),
    disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
  }));
  const labels = Array.isArray(o.labels) ? o.labels.map(clean).filter(Boolean) : [];
  if (!labels.length) {
    return { items: rows.map((r) => ({ label: r.label, checked: r.checked, disabled: r.disabled })) };
  }
  const lower = (s) => s.toLowerCase();
  const results = labels.map((want) => {
    const w = lower(want);
    const exact = rows.filter((r) => lower(r.label) === w);
    const starts = rows.filter((r) => lower(r.label).startsWith(w));
    const includes = rows.filter((r) => lower(r.label).includes(w));
    const pool = exact.length ? exact : o.exact ? [] : starts.length ? starts : includes;
    if (!pool.length) return { want, found: false };
    const hit = pool[0];
    if (o.scroll) hit.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = hit.el.getBoundingClientRect();
    return {
      want,
      found: true,
      label: hit.label,
      checked: hit.checked,
      disabled: hit.disabled,
      ambiguous: pool.length > 1,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  });
  return { results };
}

/**
 * Operate the page. Must stay self-contained.
 * kind: click | fill | press | select | wait | probe（只查找不操作，用于跨 frame 定位）
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

  const CONTROLS =
    "a, button, [role='button'], input, textarea, select, label, summary, [role='link'], [role='tab'], [role='menuitem']";
  const collect = (selector, deep) => {
    const out = [...document.querySelectorAll(selector)];
    if (!deep) return out;
    const walk = (root) => {
      for (const host of root.querySelectorAll("*")) {
        if (!host.shadowRoot) continue;
        out.push(...host.shadowRoot.querySelectorAll(selector));
        walk(host.shadowRoot);
      }
    };
    walk(document);
    return out;
  };

  const find = () => {
    const nth = Math.max(0, Number(o.nth) || 0);
    if (o.selector) {
      let nodes;
      try {
        nodes = collect(String(o.selector), false).filter(visible);
        if (!nodes.length) nodes = collect(String(o.selector), true).filter(visible);
      } catch (err) {
        return { error: err?.message || String(err) };
      }
      if (!nodes.length) return { error: `没有可见元素：${o.selector}`, notFound: true };
      return { el: nodes[Math.min(nth, nodes.length - 1)], count: nodes.length };
    }
    const needle = String(o.text || "").trim();
    if (!needle) return { error: "需要 selector 或 text" };
    const lower = needle.toLowerCase();
    const matches = (el) => {
      const t = `${el.innerText || ""} ${el.value || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return t === lower || t.includes(lower);
    };
    let nodes = collect(CONTROLS, false).filter(visible).filter(matches);
    if (!nodes.length) nodes = collect(CONTROLS, true).filter(visible).filter(matches);
    if (!nodes.length) return { error: `没有匹配「${needle}」的可见控件`, notFound: true };
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
    if (hit.error) return { ok: false, error: hit.error, notFound: hit.notFound === true, waitedMs: Date.now() - t0 };
    hit.el.scrollIntoView({ block: "center", behavior: "auto" });
    return { ok: true, waitedMs: Date.now() - t0, match: describe(hit.el), count: hit.count };
  }

  const hit = find();
  if (hit.error) return { ok: false, error: hit.error, notFound: hit.notFound === true };

  if (kind === "probe") return { ok: true, count: hit.count, match: describe(hit.el) };

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
  const failure = (err) => {
    const message = err?.message || String(err);
    const csp = err instanceof EvalError || /unsafe-eval|Content Security Policy|Trusted ?Script/i.test(message);
    return csp ? { ok: false, cspBlocked: true, error: message } : { ok: false, error: message };
  };
  try {
    const result = new AsyncFunction(wrapped)();
    return Promise.resolve(result).then((value) => ({ ok: true, result: dump(value) }), failure);
  } catch (err) {
    return failure(err);
  }
}
