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
