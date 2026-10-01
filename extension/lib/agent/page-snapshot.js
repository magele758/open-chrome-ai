/**
 * 带编号的控件快照与按引用操作。参考 browser-use/jev-ultrafast 的 snapshot.js。
 * 这些函数通过 chrome.scripting.executeScript 注入，必须自包含（不能引用模块变量）。
 * 默认在隔离世界执行：节点缓存挂在该世界的 window 上，页面脚本读不到。
 */

export function snapshotControls(opts) {
  const o = opts || {};
  if (!document.body) return null;
  const maxItems = Math.min(Math.max(Number(o.limit) || 120, 10), 250);
  const textLimit = Math.min(Math.max(Number(o.textLimit) || 3000, 0), 6000);
  const viewportOnly = o.viewportOnly !== false;

  const cache = (window.__pagelensSnap ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (el) => {
    if (!cache.ids.has(el)) cache.ids.set(el, cache.next++);
    const id = cache.ids.get(el);
    cache.nodes.set(id, el);
    return id;
  };
  for (const [id, el] of cache.nodes) if (!el.isConnected) cache.nodes.delete(id);

  const visible = (el) => {
    if (el.closest?.('[aria-hidden="true"],[inert]')) return false;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0;
  };

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const name = (el, seen = new Set()) => {
    if (!el || seen.has(el)) return "";
    seen.add(el);
    const referenced = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => name(el.getRootNode().getElementById?.(id), seen))
      .filter(Boolean)
      .join(" ");
    if (referenced) return clean(referenced);
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labels = [...(el.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(" ");
    if (labels) return clean(labels);
    if (["button", "submit", "reset"].includes(el.type) && el.value) return clean(el.value);
    const alt = el.getAttribute("alt");
    if (alt) return clean(alt);
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") {
      let text = [...el.childNodes]
        .map((n) =>
          n.nodeType === 3
            ? n.textContent
            : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true"
              ? name(n, seen)
              : "",
        )
        .join(" ");
      if (!clean(text) && el.shadowRoot) text = el.shadowRoot.textContent || "";
      if (clean(text)) return clean(text);
    }
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || "");
  };

  const roles = [
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio",
    "menuitemcheckbox", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton", "treeitem",
  ];
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],[contenteditable=""],[onclick],[tabindex]:not([tabindex^="-"]),' +
    roles.map((r) => `[role="${r}"]`).join(",");
  const role = (el) => {
    const explicit = el.getAttribute("role");
    if (roles.includes(explicit)) return explicit;
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "A") return "link";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA" || el.isContentEditable) return "textbox";
    if (tag === "INPUT") {
      const t = el.type;
      if (t === "checkbox" || t === "radio") return t;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "search") return "searchbox";
      if (t === "number") return "spinbutton";
      return "textbox";
    }
    return "button";
  };
  cache.name = name;
  cache.role = role;
  cache.visible = visible;

  const found = [];
  const gather = (root) => {
    for (const el of root.querySelectorAll(selector)) found.push(el);
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) gather(host.shadowRoot);
  };
  gather(document);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const items = [];
  const seen = new Set();
  for (const el of found) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (["file", "hidden"].includes(el.type)) continue;
    if (el.matches?.(":disabled") || el.closest?.('[aria-disabled="true"]')) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (viewportOnly && (cx < 0 || cy < 0 || cx >= vw || cy >= vh)) continue;
    const r0 = role(el);
    if (r0 === "gridcell" && el.querySelector("button,[role='button']")) continue;
    const tag = el.tagName;
    const isSecret = el.type === "password";
    const item = {
      node: identity(el),
      role: r0,
      label: name(el).slice(0, 80) || r0,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
    for (const key of ["checked", "selected", "expanded"]) {
      const v = el.getAttribute("aria-" + key);
      if (v !== null) item[key] = v;
    }
    if (el.type === "checkbox" || el.type === "radio") item.checked = String(el.checked);
    if (tag === "SELECT") {
      item.kind = "select";
      item.value = [...el.selectedOptions].map((x) => clean(x.label || x.text)).join(", ");
      item.options = [...el.options]
        .filter((x) => !x.disabled && !x.closest("optgroup[disabled]"))
        .slice(0, 40)
        .map((x) => ({ value: x.value, label: clean(x.label || x.text).slice(0, 60) }));
    } else {
      const editable =
        !el.readOnly &&
        el.getAttribute("aria-readonly") !== "true" &&
        (["textbox", "searchbox", "spinbutton"].includes(r0) ||
          (r0 === "combobox" && (tag === "INPUT" || tag === "TEXTAREA")));
      item.kind = editable ? "fill" : "click";
      if (isSecret) item.secret = true;
      else if (editable) item.value = "value" in el ? String(el.value).slice(0, 120) : clean(el.innerText).slice(0, 120);
    }
    items.push(item);
  }
  items.sort((a, b) => Math.round(a.rect.y / 12) - Math.round(b.rect.y / 12) || a.rect.x - b.rect.x);
  const omitted = Math.max(0, items.length - maxItems);
  items.length = Math.min(items.length, maxItems);

  const words = [];
  let length = 0;
  if (textLimit > 0) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node;
    while ((node = walker.nextNode()) && length < textLimit) {
      const value = clean(node.textContent);
      const parent = node.parentElement;
      if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) {
        words.push(value);
        length += value.length;
      }
    }
  }

  return {
    url: location.href,
    title: document.title || "",
    isTop: window === window.top,
    w: vw,
    h: vh,
    scroll: { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight },
    text: words.join("\n").slice(0, textLimit),
    items,
    omitted,
  };
}

/**
 * 对 snapshotControls 返回的节点执行动作。
 * kind: click | fill | select
 * spec: { node, label, value, submit }
 */
export async function actOnRef(kind, spec) {
  const o = spec || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const cache = window.__pagelensSnap;
  const stale = (why) => ({ ok: false, stale: true, error: `${why}，请重新 snapshot_controls 后再操作` });

  const el = cache?.nodes.get(Number(o.node));
  if (!el || !el.isConnected) return stale("目标元素已不在页面上");
  if (!cache.visible(el)) return stale("目标元素已不可见");
  if (o.label != null) {
    const now = clean(cache.name(el)).slice(0, 80) || cache.role(el);
    if (now !== clean(o.label).slice(0, 80)) return stale(`目标名称已变化（现为「${now}」）`);
  }

  const describe = (n) => ({
    tag: n.tagName.toLowerCase(),
    id: n.id || "",
    text: clean(n.innerText || n.value || n.getAttribute?.("aria-label")).slice(0, 80),
  });
  const composedContains = (a, b) => {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  };
  const deepFromPoint = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === "function") {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return stale("目标元素没有可点击区域");
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) {
    return { ok: false, error: "目标元素在视口外，无法操作（可能在内部滚动容器里）" };
  }
  const hit = deepFromPoint(cx, cy);
  if (hit && !composedContains(el, hit) && !composedContains(hit, el)) {
    return {
      ok: false,
      covered: true,
      error: "目标被其他元素遮挡（弹窗/遮罩/悬浮层），先处理遮挡物或关闭它",
      blocker: describe(hit),
    };
  }

  const settle = async (combobox) => {
    if (combobox) {
      const t0 = performance.now();
      while (performance.now() - t0 < 200) {
        const box = document.querySelector('[role="listbox"],[role="option"]');
        if (box && cache.visible(box)) return;
        await sleep(25);
      }
      return;
    }
    await Promise.race([
      new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
      sleep(50),
    ]);
  };

  if (kind === "click") {
    el.focus?.();
    const init = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, init));
    }
    el.click();
    await settle(false);
    return { ok: true, action: "click", match: describe(el), url: location.href };
  }

  if (kind === "fill") {
    const value = String(o.value ?? "");
    el.focus?.();
    if (el.isContentEditable && !("value" in el)) {
      let done = false;
      if (typeof document.execCommand === "function") {
        document.execCommand("selectAll", false);
        done = document.execCommand("insertText", false, value);
      }
      if (!done) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      }
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc?.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (o.submit) {
      const form = el.form || el.closest?.("form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else {
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        }
      }
    }
    await settle(cache.role(el) === "combobox" || cache.role(el) === "searchbox");
    return { ok: true, action: "fill", match: describe(el), length: value.length };
  }

  if (kind === "select") {
    if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "目标不是 <select>，请改用 click" };
    const want = String(o.value ?? "");
    const opt =
      [...el.options].find((x) => x.value === want) ||
      [...el.options].find((x) => clean(x.label || x.text) === clean(want)) ||
      [...el.options].find((x) => clean(x.label || x.text).includes(clean(want)));
    if (!opt || opt.disabled) return { ok: false, error: `没有可选项：${want}` };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(false);
    return { ok: true, action: "select", value: el.value, text: clean(opt.label || opt.text) };
  }

  return { ok: false, error: `未知动作 ${kind}` };
}

export function scrollViewport(dir, amount) {
  const step = Math.round(window.innerHeight * Math.min(Math.max(Number(amount) || 0.8, 0.1), 1));
  const before = window.scrollY;
  window.scrollBy(0, dir === "up" ? -step : step);
  const y = window.scrollY;
  return {
    ok: true,
    action: dir === "up" ? "scroll_up" : "scroll_down",
    moved: y !== before,
    atEnd: y + window.innerHeight >= document.documentElement.scrollHeight - 2,
    scrollY: Math.round(y),
  };
}

/**
 * 找到目标并滚到视口中央，返回它在本 frame 视口里的中心坐标（供 CDP 可信输入使用）。
 * spec: { node } 用 snapshotControls 的引用；或 { selector | text, nth }。必须自包含。
 */
export function locateElement(spec) {
  const o = spec || {};
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const collect = (selector) => {
    const out = [...document.querySelectorAll(selector)];
    if (out.some(visible)) return out;
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

  let el = null;
  let count = 1;
  if (o.node != null) {
    el = window.__pagelensSnap?.nodes.get(Number(o.node)) || null;
    if (!el || !el.isConnected) return { ok: false, stale: true, error: "目标元素已不在页面上，请重新 snapshot_controls" };
  } else {
    const nth = Math.max(0, Number(o.nth) || 0);
    let nodes;
    if (o.selector) {
      try {
        nodes = collect(String(o.selector)).filter(visible);
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
      if (!nodes.length) return { ok: false, notFound: true, error: `没有可见元素：${o.selector}` };
    } else {
      const needle = clean(o.text).toLowerCase();
      if (!needle) return { ok: false, error: "需要 node、selector 或 text" };
      nodes = collect("a, button, [role='button'], input, textarea, select, label, summary, [role='link'], [role='tab'], [role='menuitem'], [onclick]")
        .filter(visible)
        .filter((n) => {
          const t = clean(`${n.innerText || ""} ${n.value || ""} ${n.getAttribute("aria-label") || ""} ${n.getAttribute("placeholder") || ""}`).toLowerCase();
          return t === needle || t.includes(needle);
        });
      if (!nodes.length) return { ok: false, notFound: true, error: `没有匹配「${o.text}」的可见控件` };
    }
    count = nodes.length;
    el = nodes[Math.min(nth, nodes.length - 1)];
  }

  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { ok: false, error: "目标没有可点击区域" };
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    return { ok: false, error: "目标在视口外（可能在内部滚动容器里）" };
  }
  const composedContains = (a, b) => {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  };
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === "function") {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (hit && !composedContains(el, hit) && !composedContains(hit, el)) {
    return {
      ok: false,
      covered: true,
      error: "目标被其他元素遮挡（弹窗/遮罩/悬浮层），先处理遮挡物",
      blocker: { tag: hit.tagName.toLowerCase(), text: clean(hit.innerText || "").slice(0, 60) },
    };
  }
  return {
    ok: true,
    x,
    y,
    page: {
      x: Math.round(r.x + window.scrollX),
      y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    tag: el.tagName.toLowerCase(),
    text: clean(el.innerText || el.value || el.getAttribute("aria-label")).slice(0, 60),
    count,
  };
}

/** 顶层 frame 里找到承载某个 iframe 的元素，返回它内容区左上角在顶层视口的坐标。 */
export function iframeRect(url) {
  const frames = [...document.querySelectorAll("iframe, frame")].filter((f) => {
    const r = f.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const exact = frames.filter((f) => f.src === url || f.getAttribute("src") === url);
  const pick = exact[0] || (frames.length === 1 ? frames[0] : null);
  if (!pick) return null;
  const r = pick.getBoundingClientRect();
  return { x: Math.round(r.x + pick.clientLeft), y: Math.round(r.y + pick.clientTop), ambiguous: !exact.length };
}

/** 滚动某个控件所在的最近可滚动容器（用于页面内部的滚动区域）。 */
export function scrollContainerOf(node, dir, amount) {
  const el = window.__pagelensSnap?.nodes.get(Number(node));
  if (!el || !el.isConnected) return { ok: false, stale: true, error: "目标元素已不在页面上，请重新 snapshot_controls" };
  let box = el.parentElement;
  while (box && box !== document.body && box !== document.documentElement) {
    const st = getComputedStyle(box);
    if (/(auto|scroll)/.test(st.overflowY) && box.scrollHeight > box.clientHeight + 2) break;
    box = box.parentElement;
  }
  if (!box || box === document.body || box === document.documentElement) {
    return { ok: false, error: "该控件不在内部滚动容器里，请用不带编号的 scroll_down / scroll_up" };
  }
  const step = Math.round(box.clientHeight * Math.min(Math.max(Number(amount) || 0.8, 0.1), 1));
  const before = box.scrollTop;
  box.scrollBy(0, dir === "up" ? -step : step);
  return {
    ok: true,
    action: dir === "up" ? "scroll_up" : "scroll_down",
    container: box.tagName.toLowerCase(),
    moved: box.scrollTop !== before,
    atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
  };
}
