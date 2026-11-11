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
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (
        cur.hidden ||
        cur.classList?.contains("ant-select-dropdown-hidden") ||
        cur.classList?.contains("ant-dropdown-hidden") ||
        cur.classList?.contains("ant-popover-hidden")
      ) {
        return false;
      }
      const st = window.getComputedStyle(cur);
      if (st.display === "none" || st.visibility === "hidden") return false;
      if (
        cur !== el &&
        cur.style?.overflow === "hidden" &&
        (cur.style?.width === "0px" || cur.style?.height === "0px")
      ) {
        return false;
      }
      cur = cur.parentElement;
    }
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
    `a[href], button, [role='button'], input, textarea, select, [role='tab'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='treeitem'], [role='link'], ${checkRoles}`;
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
  const compactCjk = (s) => String(s || "").replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
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
    } else if (
      (item.tag === "button" || el.getAttribute("role") === "button") &&
      /^[\u4e00-\u9fff]\s+[\u4e00-\u9fff]$/.test(item.text)
    ) {
      item.text = compactCjk(item.text);
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
  const compactCjk = (s) => String(s || "").replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
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
  const compact = (s) => compactCjk(lower(s));
  const results = labels.map((want) => {
    const w = lower(want);
    const cw = compact(want);
    const exact = rows.filter((r) => lower(r.label) === w || (cw && compact(r.label) === cw));
    const starts = rows.filter((r) => lower(r.label).startsWith(w) || (cw && compact(r.label).startsWith(cw)));
    const includes = rows.filter((r) => lower(r.label).includes(w) || (cw && compact(r.label).includes(cw)));
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
 * kind: click | fill | press | select | wait | probe | waitProbe（只查找不操作，用于跨 frame 定位）
 */
export async function pageAct(kind, spec) {
  const o = spec || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const compactCjk = (s) => String(s || "").replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
  const visible = (el) => {
    if (!el) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (
        cur.hidden ||
        cur.classList?.contains("ant-select-dropdown-hidden") ||
        cur.classList?.contains("ant-dropdown-hidden") ||
        cur.classList?.contains("ant-popover-hidden")
      ) {
        return false;
      }
      const st = window.getComputedStyle(cur);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      if (
        cur !== el &&
        cur.style?.overflow === "hidden" &&
        (cur.style?.width === "0px" || cur.style?.height === "0px")
      ) {
        return false;
      }
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const resolveProxy = (el) => {
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) return null;
    if (String(el.getAttribute("type") || el.type || "").toLowerCase() === "hidden") return null;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return null;
    if (visible(el)) return null;
    const anc = el.parentElement;
    const primary = anc?.closest(
      '.ant-select-selector, .ant-cascader-picker, .ant-picker, [role="combobox"], [role="listbox"], [role="switch"], [role="checkbox"], [role="radio"], .ant-checkbox-wrapper, .ant-radio-wrapper, .ant-switch',
    );
    if (primary && visible(primary)) return primary;
    const secondary = anc?.closest(".ant-select, .ant-cascader, label");
    if (secondary && visible(secondary)) return secondary;
    const lbl = el.labels?.[0] || null;
    if (lbl && visible(lbl)) return lbl;
    return null;
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    text: (el.innerText || el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
    href: el.href || el.getAttribute("href") || "",
    type: el.getAttribute("type") || "",
  });
  const FILE_CHOOSER_BLOCKED_MSG =
    "目标位置命中文件上传控件（点击会弹出系统文件选择框），已拦截；如需上传文件请使用 upload_file 工具，如系滚动后坐标偏移请改用 selector 定位目标控件";
  const isFileUploadTrigger = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (
      node.tagName === "INPUT" &&
      String(node.type || node.getAttribute("type") || "").toLowerCase() === "file" &&
      !node.disabled
    ) {
      return true;
    }
    for (
      let cur = node;
      cur && cur !== document.body && cur !== document.documentElement;
      cur = cur.parentElement || cur.getRootNode?.()?.host || null
    ) {
      if (cur.matches?.('.ant-upload-list, .el-upload-list, [class*="upload-list"]')) break;
      if (cur.tagName === "LABEL") {
        const forId = cur.getAttribute?.("for");
        const ctrl = cur.control || (forId ? document.getElementById(forId) : null);
        if (
          (ctrl?.tagName === "INPUT" &&
            String(ctrl.type || ctrl.getAttribute?.("type") || "").toLowerCase() === "file" &&
            !ctrl.disabled) ||
          cur.querySelector?.('input[type="file"]:not([disabled])')
        ) {
          return true;
        }
      }
      if (
        cur.matches?.('button, [role="button"], .ant-upload-btn, .el-upload') ||
        (cur.classList?.contains("ant-upload") &&
          !cur.classList.contains("ant-upload-wrapper") &&
          !cur.classList.contains("ant-upload-picture-card-wrapper"))
      ) {
        if (cur.querySelector?.('input[type="file"]:not([disabled])')) return true;
      }
    }
    return false;
  };

  const CONTROLS =
    "a, button, [role='button'], input, textarea, select, label, summary, [role='link'], [role='tab'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='treeitem'], [role='checkbox'], [role='radio'], [role='switch'], [onclick]";
  const TEXT_CONTAINERS =
    "h1, h2, h3, h4, h5, h6, [role='heading'], [role='dialog'], [aria-modal='true'], .ant-modal-title, .ant-drawer-title, th, td, li, p, span, div";
  const POPUP_LAYER_SEL =
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-cascader-dropdown:not(.ant-select-dropdown-hidden), .ant-dropdown:not(.ant-dropdown-hidden), .el-select-dropdown, .el-cascader__dropdown, [role='listbox'], [role='menu'], [role='tree']";
  const DIALOG_LAYER_SEL = "[role='dialog'], [aria-modal='true'], dialog[open], .ant-modal, .ant-drawer, .el-dialog";
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

  const isWaitKind = kind === "wait" || kind === "waitProbe";
  const notDisabled = (el) =>
    Boolean(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && !el.closest?.("[aria-disabled='true']");
  const textFieldsOf = (el) => {
    const rawText = el.innerText ?? el.textContent ?? "";
    return [rawText, el.value, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title")]
      .filter(Boolean)
      .map((s) => String(s).replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean);
  };
  const prioritizeTopLayer = (items) => {
    if (items.length <= 1) return items;
    const inPopup = (el) => {
      const p = el.closest?.(POPUP_LAYER_SEL);
      return Boolean(p && visible(p) && !p.closest?.("[aria-hidden='true']"));
    };
    const rawDialogs = [...document.querySelectorAll(DIALOG_LAYER_SEL)].filter(
      (d) => visible(d) && !d.closest?.("[aria-hidden='true']"),
    );
    const outerDialogs = rawDialogs
      .filter((d) => !rawDialogs.some((other) => other !== d && other.contains(d)))
      .map((d, idx) => {
        let bestZ = 0;
        let cur = d;
        while (cur && cur !== document.documentElement) {
          const z = Number.parseInt(window.getComputedStyle(cur).zIndex, 10);
          if (Number.isFinite(z) && z > bestZ) bestZ = z;
          cur = cur.parentElement;
        }
        return { d, idx, z: bestZ };
      })
      .sort((a, b) => (b.z !== a.z ? b.z - a.z : b.idx - a.idx));
    return items
      .map((el, order) => {
        let tier = 1 + outerDialogs.length;
        if (inPopup(el)) {
          tier = 0;
        } else {
          const mIdx = outerDialogs.findIndex(({ d }) => d.contains(el));
          if (mIdx >= 0) tier = 1 + mIdx;
        }
        return { el, order, tier };
      })
      .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.order - b.order))
      .map((x) => x.el);
  };
  const rankByText = (candidates, rawNeedle, preferTopLayer = true) => {
    const lower = String(rawNeedle || "").replace(/\s+/g, " ").trim().toLowerCase();
    const cLower = compactCjk(lower);
    const exact = [];
    const partial = [];
    for (const item of candidates) {
      const targetEl = item.el || item;
      const fields = textFieldsOf(targetEl);
      if (fields.some((f) => f === lower || (Boolean(cLower) && compactCjk(f) === cLower))) {
        exact.push(item);
      } else if (fields.some((f) => f.includes(lower) || (Boolean(cLower) && compactCjk(f).includes(cLower)))) {
        partial.push(item);
      }
    }
    const pool = exact.length ? exact : partial;
    if (!preferTopLayer || pool.length <= 1 || pool[0]?.el) return pool;
    return prioritizeTopLayer(pool);
  };

  const find = () => {
    const nth = Math.max(0, Number(o.nth) || 0);
    const needle = String(o.text || "").trim();
    if (o.selector) {
      let raw;
      try {
        raw = collect(String(o.selector), false);
        if (!raw.some(visible)) raw = collect(String(o.selector), true);
      } catch (err) {
        return { error: err?.message || String(err) };
      }
      let nodes = raw.filter(visible);
      if (!nodes.length && raw.length) {
        if (kind === "fill" || kind === "press" || kind === "select") {
          let proxyInputs = [];
          for (const n of raw) {
            const wrap = resolveProxy(n);
            if (wrap) proxyInputs.push({ el: n, scrollTarget: wrap });
          }
          if (needle && proxyInputs.length) {
            proxyInputs = rankByText(proxyInputs, needle, false);
          }
          if (proxyInputs.length) {
            const picked = proxyInputs[Math.min(nth, proxyInputs.length - 1)];
            return { el: picked.el, scrollTarget: picked.scrollTarget, count: proxyInputs.length };
          }
        } else {
          nodes = [...new Set(raw.map(resolveProxy).filter(Boolean))];
        }
      }
      if (!nodes.length) {
        if (kind === "click" && raw.some(isFileUploadTrigger)) {
          return { error: FILE_CHOOSER_BLOCKED_MSG, blockedFileChooser: true };
        }
        return { error: `没有可见元素：${o.selector}`, notFound: true };
      }
      if (needle) {
        nodes = rankByText(nodes, needle, true);
        if (!nodes.length) {
          return { error: `选择器 ${o.selector} 中没有匹配「${needle}」的可见元素`, notFound: true };
        }
      }
      return { el: nodes[Math.min(nth, nodes.length - 1)], count: nodes.length };
    }
    if (!needle) {
      if (kind === "press") return { el: document.activeElement || document.body, count: 1 };
      return { error: "需要 selector 或 text" };
    }
    const filterCtrl = (el) => visible(el) && (isWaitKind || notDisabled(el));
    let nodes = rankByText(collect(CONTROLS, false).filter(filterCtrl), needle, true);
    if (!nodes.length) nodes = rankByText(collect(CONTROLS, true).filter(filterCtrl), needle, true);
    if (!nodes.length && isWaitKind) {
      let candidates = rankByText(collect(TEXT_CONTAINERS, false).filter(visible), needle, false);
      if (!candidates.length) candidates = rankByText(collect(TEXT_CONTAINERS, true).filter(visible), needle, false);
      if (candidates.length) {
        const ancestorsWithMatch = new Set();
        for (const c of candidates) {
          let p = c.parentElement || (c.getRootNode?.() instanceof ShadowRoot ? c.getRootNode().host : null);
          while (p) {
            ancestorsWithMatch.add(p);
            p = p.parentElement || (p.getRootNode?.() instanceof ShadowRoot ? p.getRootNode().host : null);
          }
        }
        const deepest = candidates.filter((el) => !ancestorsWithMatch.has(el));
        nodes = prioritizeTopLayer(deepest.length ? deepest : candidates);
      }
    }
    if (!nodes.length) {
      return {
        error: isWaitKind ? `没有匹配「${needle}」的可见元素或文字` : `没有匹配「${needle}」的可见控件`,
        notFound: true,
      };
    }
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
    const scrollEl = hit.scrollTarget || hit.el;
    const rect = scrollEl.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    const vw = window.innerWidth || document.documentElement?.clientWidth || 0;
    const inViewport =
      vh > 0 &&
      rect.bottom > 0 &&
      rect.top < vh &&
      (vw <= 0 || (rect.right > 0 && rect.left < vw));
    const oversized = vh > 0 && rect.height > vh * 0.6;
    if (!inViewport && !oversized) {
      scrollEl.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
    return { ok: true, waitedMs: Date.now() - t0, match: describe(hit.el), count: hit.count };
  }

  const hit = find();
  if (hit.error) {
    return {
      ok: false,
      error: hit.error,
      ...(hit.blockedFileChooser ? { blockedFileChooser: true } : { notFound: hit.notFound === true }),
    };
  }

  if (kind === "probe" || kind === "waitProbe") return { ok: true, count: hit.count, match: describe(hit.el) };

  const el = hit.el;
  if (kind === "click" && isFileUploadTrigger(el)) {
    return { ok: false, blockedFileChooser: true, error: FILE_CHOOSER_BLOCKED_MSG };
  }
  (hit.scrollTarget || el).scrollIntoView({ block: "center", behavior: "instant" });

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
    if (o.blur) {
      el.blur();
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
    const target =
      o.selector || o.text
        ? el
        : document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : el;
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    return { ok: true, action: "press", key };
  }

  return { ok: false, error: `未知动作 ${kind}` };
}

export async function prepareSelectOption(spec) {
  const o = spec || {};
  const val = String(o.value ?? "").replace(/\s+/g, " ").trim();
  if (!val) return { ok: false, error: "需要非空 value" };
  if (!o.selector && !o.label) return { ok: false, error: "需要 selector 或 label" };

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const compactCjk = (s) => {
    const t = clean(s);
    if (!/[\u3400-\u9fff]/.test(t)) return "";
    return t.replace(/\s+/g, "");
  };
  const cVal = compactCjk(val);
  const normLabel = (s) =>
    clean(s)
      .replace(/^[\s*＊:：]+/, "")
      .replace(/[\s:：]+$/, "")
      .trim();
  const baseLabel = (s) => normLabel(s).replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim();
  const doubleRaf = () =>
    new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      } else {
        setTimeout(resolve, 16);
      }
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hidden) return false;
      const st = window.getComputedStyle(cur);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isFileUploadTrigger = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (
      node.tagName === "INPUT" &&
      String(node.type || node.getAttribute("type") || "").toLowerCase() === "file" &&
      !node.disabled
    ) {
      return true;
    }
    for (
      let cur = node;
      cur && cur !== document.body && cur !== document.documentElement;
      cur = cur.parentElement || cur.getRootNode?.()?.host || null
    ) {
      if (cur.matches?.('.ant-upload-list, .el-upload-list, [class*="upload-list"]')) break;
      if (
        cur.matches?.('button, [role="button"], .ant-upload-btn, .el-upload') ||
        (cur.classList?.contains("ant-upload") &&
          !cur.classList.contains("ant-upload-wrapper") &&
          !cur.classList.contains("ant-upload-picture-card-wrapper"))
      ) {
        if (cur.querySelector?.('input[type="file"]:not([disabled])')) return true;
      }
    }
    return false;
  };
  const COMBO_SEL = "select, .ant-select:not(.ant-cascader), .el-select, [data-radix-select-trigger], [role='combobox']";
  const resolveControl = (node) => {
    if (!node || node.nodeType !== 1) return null;
    if (node instanceof HTMLSelectElement) return node;
    const up = node.closest?.(".ant-select:not(.ant-cascader), .el-select, [data-radix-select-trigger]");
    if (up) return up;
    if (node.matches?.("[role='combobox']") && !node.closest?.(".ant-cascader")) {
      return node.closest?.('[class*="select"]:not(.ant-cascader)') || node;
    }
    const down = node.querySelector?.("select, .ant-select:not(.ant-cascader), .el-select, [data-radix-select-trigger]");
    if (down) return down;
    const cb = node.querySelector?.("[role='combobox']");
    if (cb && !cb.closest?.(".ant-cascader")) return cb;
    return null;
  };
  const controlVisible = (ctrl) => {
    if (!ctrl) return false;
    if (visible(ctrl)) return true;
    const sub = ctrl.querySelector?.(".ant-select-selector, .el-select__wrapper");
    return Boolean(sub && visible(sub));
  };
  const DIALOG_SEL = ".ant-modal, .ant-drawer, .el-dialog, [role='dialog'], [aria-modal='true']";
  const isComboOpen = (root) => {
    if (!root) return false;
    if (root.classList?.contains("ant-select")) {
      return Boolean(
        root.classList.contains("ant-select-open") ||
          root.querySelector?.("input")?.getAttribute?.("aria-expanded") === "true",
      );
    }
    if (root.classList?.contains("el-select")) {
      return Boolean(
        root.querySelector?.(".el-select__caret.is-reverse, .el-select__wrapper.is-focused") ||
          root.getAttribute?.("aria-expanded") === "true",
      );
    }
    return Boolean(
      root.getAttribute?.("aria-expanded") === "true" ||
        root.getAttribute?.("data-state") === "open" ||
        root.querySelector?.("[aria-expanded='true']"),
    );
  };
  const pickSafeNeutralNode = (root) => {
    const hostDialog = root?.closest?.(DIALOG_SEL) || null;
    const fieldBox = root?.closest?.(
      ".ant-form-item, .el-form-item, [class*='__field'], [class*='-field'], [class*='__item']",
    );
    const fieldHeader = fieldBox?.querySelector?.("[class*='__label'], [class*='-label']");
    if (fieldHeader && fieldHeader.tagName !== "LABEL" && !root.contains(fieldHeader)) {
      return fieldHeader;
    }
    if (hostDialog) {
      const dlgHeader = hostDialog.querySelector?.(
        ".ant-modal-title, .ant-modal-header, .ant-drawer-title, .el-dialog__title, .el-dialog__header",
      );
      if (dlgHeader) return dlgHeader;
      return hostDialog.querySelector?.(".ant-modal-content, .ant-drawer-content, .el-dialog__body") || hostDialog;
    }
    return document.body;
  };
  const closeCombo = (root) => {
    if (!root) return;
    const inp = root.querySelector?.("input") || root;
    inp.blur?.();
    const safeNeutral = pickSafeNeutralNode(root);
    if (safeNeutral) {
      const r = safeNeutral.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      const cx = r.width > 0 ? Math.round(r.left + Math.min(20, r.width / 2)) : 0;
      const cy = r.height > 0 ? Math.round(r.top + r.height / 2) : 0;
      if (typeof PointerEvent === "function") {
        safeNeutral.dispatchEvent?.(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
      }
      safeNeutral.dispatchEvent?.(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
      );
      if (typeof PointerEvent === "function") {
        safeNeutral.dispatchEvent?.(
          new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
      }
      safeNeutral.dispatchEvent?.(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
      );
      safeNeutral.dispatchEvent?.(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
      );
    }
  };
  const readSelected = (root) => {
    const items = [...(root.querySelectorAll?.(".ant-select-selection-item, .el-select__tags-text") || [])];
    const out = [];
    for (const item of items) {
      const tAttr = clean(item.getAttribute?.("title"));
      if (tAttr) {
        out.push(tAttr);
        continue;
      }
      const clone = item.cloneNode(true);
      clone.querySelectorAll?.(".ant-select-selection-item-remove, [aria-hidden='true']").forEach((x) => x.remove());
      const txt = clean(clone.textContent);
      if (txt) out.push(txt);
    }
    if (!out.length && !root.classList?.contains("ant-select") && !root.classList?.contains("el-select")) {
      const ph = clean(root.getAttribute?.("placeholder") || root.getAttribute?.("data-placeholder"));
      const txt = clean(root.value ?? root.textContent);
      if (txt && txt !== ph) out.push(txt);
    }
    return out;
  };
  const matchesVal = (s) => s === val || Boolean(cVal && compactCjk(s) === cVal);

  const nth = Math.max(0, Number(o.nth) || 0);
  let candidates = [];
  if (o.selector) {
    let raw;
    try {
      raw = [...document.querySelectorAll(String(o.selector))];
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
    const seen = new Set();
    for (const n of raw) {
      const ctrl = resolveControl(n);
      if (ctrl && !seen.has(ctrl) && controlVisible(ctrl)) {
        seen.add(ctrl);
        candidates.push(ctrl);
      }
    }
    if (!candidates.length) {
      return { ok: false, notFound: true, error: `没有可见下拉控件：${o.selector}` };
    }
  } else {
    const targetNorm = normLabel(o.label);
    const targetBase = baseLabel(o.label);
    const targetCjk = compactCjk(targetNorm);
    const maxZIndex = (el) => {
      let best = 0;
      for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
        const z = Number.parseInt(window.getComputedStyle(cur).zIndex, 10);
        if (Number.isFinite(z) && z > best) best = z;
      }
      return best;
    };
    const modals = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .ant-modal, .ant-drawer')]
      .filter((m) => visible(m) && !m.closest('[aria-hidden="true"]'));
    const topModals = modals
      .filter((m) => !modals.some((other) => other !== m && other.contains(m)))
      .map((m, idx) => ({ m, idx, z: maxZIndex(m) }))
      .sort((a, b) => (b.z !== a.z ? b.z - a.z : b.idx - a.idx));
    const roots = topModals.length ? [topModals[0].m, document] : [document];

    const labelTextOf = (labelEl) => {
      const clone = labelEl.cloneNode(true);
      clone
        .querySelectorAll?.('[class*="hint"], [class*="desc"], [class*="extra"], [class*="tip"], [class*="tooltip"]')
        .forEach((x) => x.remove());
      return clean(clone.textContent);
    };
    const isLabelMatch = (rawTxt) => {
      const fn = normLabel(rawTxt);
      if (!fn) return false;
      const bn = baseLabel(rawTxt);
      if (fn === targetNorm || bn === targetNorm || (targetBase && bn === targetBase)) return true;
      if (targetCjk && compactCjk(fn) === targetCjk) return true;
      return false;
    };

    for (const root of roots) {
      const seen = new Set();
      const labelEls = [
        ...root.querySelectorAll("label, .ant-form-item-label, .el-form-item__label, [class*='__label'], [class*='-label']"),
      ].filter(visible);
      for (const lEl of labelEls) {
        if (!isLabelMatch(labelTextOf(lEl))) continue;
        let ctrl = null;
        if (lEl.tagName === "LABEL" && lEl.control) {
          ctrl = resolveControl(lEl.control);
        }
        if (!ctrl) {
          const fieldBox =
            lEl.closest(
              ".ant-form-item, .el-form-item, [class*='__field'], [class*='-field'], [class*='__item']",
            ) || lEl.parentElement;
          ctrl = resolveControl(fieldBox);
        }
        if (ctrl && !seen.has(ctrl) && controlVisible(ctrl)) {
          seen.add(ctrl);
          candidates.push(ctrl);
        }
      }
      if (!candidates.length) {
        for (const el of root.querySelectorAll(COMBO_SEL)) {
          const ctrl = resolveControl(el);
          if (!ctrl || seen.has(ctrl) || !controlVisible(ctrl)) continue;
          const aria = el.getAttribute?.("aria-label") || ctrl.getAttribute?.("aria-label") || "";
          const ph = el.getAttribute?.("placeholder") || ctrl.querySelector?.(".ant-select-selection-placeholder")?.textContent || "";
          if (isLabelMatch(aria) || isLabelMatch(ph)) {
            seen.add(ctrl);
            candidates.push(ctrl);
          }
        }
      }
      if (candidates.length) break;
    }
    if (!candidates.length) {
      return { ok: false, notFound: true, error: `没有匹配标签「${o.label}」的可见下拉框` };
    }
  }

  const target = candidates[Math.min(nth, candidates.length - 1)];
  if (target instanceof HTMLSelectElement) {
    const opt = [...target.options].find(
      (x) => x.value === val || clean(x.text) === val || x.text.includes(val),
    );
    if (!opt) return { ok: false, notFound: true, error: `没有选项 ${val}` };
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.value = opt.value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, done: true, action: "select", value: target.value, text: clean(opt.text) };
  }

  const selectedBefore = readSelected(target);
  if (selectedBefore.some(matchesVal)) {
    if (isComboOpen(target)) {
      closeCombo(target);
      await sleep(40);
    }
    return { ok: true, done: true, action: "select", alreadySelected: true, value: val, selected: selectedBefore };
  }

  const otherOpen = [...document.querySelectorAll(".ant-select-open, [role='combobox'][aria-expanded='true']")].filter(
    (el) => el !== target && !target.contains(el) && !el.contains(target),
  );
  if (otherOpen.length) {
    for (const op of otherOpen) closeCombo(op);
    await sleep(60);
    await doubleRaf();
  }

  const trigger = target.querySelector?.(".ant-select-selector, .el-select__wrapper") || target;
  if (isFileUploadTrigger(trigger)) {
    return {
      ok: false,
      blockedFileChooser: true,
      error: "目标位置命中文件上传控件（点击会弹出系统文件选择框），已拦截；如需上传文件请使用 upload_file 工具",
    };
  }
  trigger.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await doubleRaf();

  let r = trigger.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) {
    return { ok: false, error: "下拉框没有可点击区域" };
  }
  let x = Math.round(r.x + r.width / 2);
  let y = Math.round(r.y + r.height / 2);
  const composedContains = (a, b) => {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  };
  let hit = document.elementFromPoint(x, y);
  if (hit && !composedContains(target, hit) && !composedContains(hit, target)) {
    closeCombo(hit.closest?.(".ant-select-open") || target);
    await sleep(60);
    await doubleRaf();
    r = trigger.getBoundingClientRect();
    x = Math.round(r.x + r.width / 2);
    y = Math.round(r.y + r.height / 2);
    hit = document.elementFromPoint(x, y);
    if (hit && !composedContains(target, hit) && !composedContains(hit, target)) {
      return { ok: false, covered: true, error: "目标下拉框被其他浮层遮挡，请先关闭遮挡层" };
    }
  }

  const uid = `plsel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  target.setAttribute("data-pl-select-uid", uid);
  target.setAttribute("data-pl-select-dialog", target.closest?.(DIALOG_SEL) ? "1" : "0");
  const isOpen = isComboOpen(target);

  if (!o.useCdp && !isOpen) {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    trigger.click?.();
  }

  return {
    ok: true,
    done: false,
    uid,
    needCdpOpen: Boolean(o.useCdp && !isOpen),
    x,
    y,
    count: candidates.length,
  };
}

export async function completeSelectOption(spec) {
  const o = spec || {};
  const uid = String(o.uid || "");
  const val = String(o.value ?? "").replace(/\s+/g, " ").trim();
  const stage = o.stage || "select";
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const compactCjk = (s) => {
    const t = clean(s);
    if (!/[\u3400-\u9fff]/.test(t)) return "";
    return t.replace(/\s+/g, "");
  };
  const cVal = compactCjk(val);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const doubleRaf = () =>
    new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      } else {
        setTimeout(resolve, 16);
      }
    });
  const comboRoot = uid ? document.querySelector(`[data-pl-select-uid="${uid}"]`) : null;
  if (!comboRoot) {
    return { ok: false, error: "下拉框引用已失效" };
  }
  let keepUid = false;
  const DIALOG_SEL = ".ant-modal, .ant-drawer, .el-dialog, [role='dialog'], [aria-modal='true']";
  const isComboOpen = (root) => {
    if (!root) return false;
    if (root.classList?.contains("ant-select")) {
      return Boolean(
        root.classList.contains("ant-select-open") ||
          root.querySelector?.("input")?.getAttribute?.("aria-expanded") === "true",
      );
    }
    if (root.classList?.contains("el-select")) {
      return Boolean(
        root.querySelector?.(".el-select__caret.is-reverse, .el-select__wrapper.is-focused") ||
          root.getAttribute?.("aria-expanded") === "true",
      );
    }
    return Boolean(
      root.getAttribute?.("aria-expanded") === "true" ||
        root.getAttribute?.("data-state") === "open" ||
        root.querySelector?.("[aria-expanded='true']"),
    );
  };
  const pickSafeNeutralNode = (root) => {
    const hostDialog = root?.closest?.(DIALOG_SEL) || null;
    const fieldBox = root?.closest?.(
      ".ant-form-item, .el-form-item, [class*='__field'], [class*='-field'], [class*='__item']",
    );
    const fieldHeader = fieldBox?.querySelector?.("[class*='__label'], [class*='-label']");
    if (fieldHeader && fieldHeader.tagName !== "LABEL" && !root.contains(fieldHeader)) {
      return fieldHeader;
    }
    if (hostDialog) {
      const dlgHeader = hostDialog.querySelector?.(
        ".ant-modal-title, .ant-modal-header, .ant-drawer-title, .el-dialog__title, .el-dialog__header",
      );
      if (dlgHeader) return dlgHeader;
      return hostDialog.querySelector?.(".ant-modal-content, .ant-drawer-content, .el-dialog__body") || hostDialog;
    }
    return document.body;
  };
  const closeCombo = (root) => {
    if (!root) return;
    const inp = root.querySelector?.("input") || root;
    inp.blur?.();
    const safeNeutral = pickSafeNeutralNode(root);
    if (safeNeutral) {
      const r = safeNeutral.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      const cx = r.width > 0 ? Math.round(r.left + Math.min(20, r.width / 2)) : 0;
      const cy = r.height > 0 ? Math.round(r.top + r.height / 2) : 0;
      if (typeof PointerEvent === "function") {
        safeNeutral.dispatchEvent?.(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
      }
      safeNeutral.dispatchEvent?.(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
      );
      if (typeof PointerEvent === "function") {
        safeNeutral.dispatchEvent?.(
          new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
        );
      }
      safeNeutral.dispatchEvent?.(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
      );
      safeNeutral.dispatchEvent?.(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }),
      );
    }
  };
  const readSelected = (root) => {
    const items = [...(root.querySelectorAll?.(".ant-select-selection-item, .el-select__tags-text") || [])];
    const out = [];
    for (const item of items) {
      const tAttr = clean(item.getAttribute?.("title"));
      if (tAttr) {
        out.push(tAttr);
        continue;
      }
      const clone = item.cloneNode(true);
      clone.querySelectorAll?.(".ant-select-selection-item-remove, [aria-hidden='true']").forEach((x) => x.remove());
      const txt = clean(clone.textContent);
      if (txt) out.push(txt);
    }
    if (!out.length && !root.classList?.contains("ant-select") && !root.classList?.contains("el-select")) {
      const ph = clean(root.getAttribute?.("placeholder") || root.getAttribute?.("data-placeholder"));
      const txt = clean(root.value ?? root.textContent);
      if (txt && txt !== ph) out.push(txt);
    }
    return out;
  };
  const matchesVal = (s) => s === val || Boolean(cVal && compactCjk(s) === cVal);
  const findVisiblePopup = () => {
    const boxVisible = (el) => {
      if (!el) return false;
      if (el.classList?.contains("ant-select-dropdown-hidden")) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const inp = comboRoot.querySelector?.("input[aria-controls], input[aria-owns]") || comboRoot;
    const ctrlId = inp?.getAttribute?.("aria-controls") || inp?.getAttribute?.("aria-owns") || "";
    if (ctrlId) {
      const listEl = document.getElementById(ctrlId);
      const wrap =
        listEl?.closest?.(".ant-select-dropdown, .el-select-dropdown, [data-radix-popper-content-wrapper]") || listEl;
      if (wrap && boxVisible(wrap)) return wrap;
    }
    const all = [
      ...document.querySelectorAll(
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden), .el-select-dropdown, [role='listbox']",
      ),
    ].filter(boxVisible);
    return all.length ? all[all.length - 1] : null;
  };
  const listVisibleOptions = (popup) => {
    if (!popup) return [];
    const raw = [
      ...popup.querySelectorAll(
        ".ant-select-item-option:not(.ant-select-item-option-disabled), .el-select-dropdown__item:not(.is-disabled), [role='option']:not([aria-disabled='true'])",
      ),
    ];
    return raw.filter((el) => {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  };
  const optionLabel = (opt) =>
    clean(
      opt.querySelector?.(".ant-select-item-option-content")?.textContent ||
        opt.getAttribute?.("title") ||
        opt.textContent,
    );
  const findOption = (popup) => {
    const opts = listVisibleOptions(popup);
    return (
      opts.find((opt) => {
        const lbl = optionLabel(opt);
        const title = clean(opt.getAttribute?.("title"));
        return matchesVal(lbl) || (title && matchesVal(title));
      }) || null
    );
  };
  const setSearchInput = (inp, text) => {
    inp.focus?.();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc?.set) desc.set.call(inp, text);
    else inp.value = text;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const inDialog = comboRoot.getAttribute("data-pl-select-dialog") === "1";
  const isFileUploadTrigger = (node) => {
    const start = node && node.nodeType === 1 ? node : node?.parentElement || null;
    if (!start) return false;
    if (start.tagName === "INPUT" && String(start.type || "").toLowerCase() === "file") return true;
    const lbl = start.closest?.("label");
    if (lbl) {
      const c = lbl.control || lbl.querySelector?.('input[type="file"]');
      if (c && c.tagName === "INPUT" && String(c.type || "").toLowerCase() === "file" && !c.disabled) return true;
    }
    for (
      let cur = start;
      cur && cur !== document.body && cur !== document.documentElement;
      cur = cur.parentElement || cur.getRootNode?.()?.host || null
    ) {
      if (cur.matches?.('.ant-upload-list, .el-upload-list, [class*="upload-list"]')) break;
      if (
        cur.matches?.('button, [role="button"], .ant-upload-btn, .el-upload') ||
        (cur.classList?.contains("ant-upload") &&
          !cur.classList.contains("ant-upload-wrapper") &&
          !cur.classList.contains("ant-upload-picture-card-wrapper"))
      ) {
        if (cur.querySelector?.('input[type="file"]:not([disabled])')) return true;
      }
    }
    return false;
  };
  const pickUncoveredNeutralPoint = (root) => {
    const hostDialog = root?.closest?.(DIALOG_SEL) || null;
    const fieldBox = root?.closest?.(
      ".ant-form-item, .el-form-item, [class*='__field'], [class*='-field'], [class*='__item']",
    );
    const fieldHeader = fieldBox?.querySelector?.("[class*='__label'], [class*='-label']");
    const candidates = [];
    if (fieldHeader && fieldHeader.tagName !== "LABEL" && !root.contains(fieldHeader)) {
      candidates.push(fieldHeader);
    }
    if (hostDialog) {
      hostDialog
        .querySelectorAll?.(".ant-modal-title, .ant-modal-header, .ant-drawer-title, .el-dialog__title, .el-dialog__header")
        .forEach((el) => candidates.push(el));
    } else if (document.body) {
      candidates.push(document.body);
    }
    const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement?.clientHeight || 800;
    for (const el of candidates) {
      const r = el?.getBoundingClientRect?.();
      if (!r || r.width <= 4 || r.height <= 4) continue;
      const sampleXs = [
        Math.round(r.left + Math.min(20, r.width / 2)),
        Math.round(r.left + Math.min(80, r.width * 0.4)),
      ];
      const cy = Math.round(r.top + Math.min(16, r.height / 2));
      for (const cx of sampleXs) {
        if (cx < 2 || cy < 2 || cx > vw - 2 || cy > vh - 2) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit) continue;
        if (hostDialog && !hostDialog.contains(hit)) continue;
        if (root.contains(hit)) continue;
        if (
          hit.closest?.(
            ".ant-select-dropdown, .el-select-dropdown, [role='listbox'], button, a, input, select, textarea, label, .ant-modal-close, .ant-drawer-close, .el-dialog__headerbtn",
          )
        ) {
          continue;
        }
        if (isFileUploadTrigger(hit)) continue;
        return { x: cx, y: cy };
      }
    }
    return null;
  };
  const verifyHostAlive = () => {
    if (!comboRoot.isConnected) {
      return "选择后下拉控件已从 DOM 卸载（宿主容器可能被意外关闭）";
    }
    if (inDialog) {
      const curDialog = comboRoot.closest?.(DIALOG_SEL);
      if (!curDialog || !curDialog.isConnected) {
        return "选择后宿主弹窗已卸载";
      }
      const wrap = curDialog.closest?.(".ant-modal-wrap, .el-overlay-dialog") || curDialog;
      const st = window.getComputedStyle(wrap);
      if (
        st.display === "none" ||
        st.visibility === "hidden" ||
        curDialog.classList?.contains("ant-zoom-leave") ||
        curDialog.classList?.contains("ant-fade-leave")
      ) {
        return "选择后宿主弹窗正在关闭或已隐藏";
      }
    }
    return null;
  };

  try {
    if (stage === "verify") {
      await sleep(50);
      const hostErr = verifyHostAlive();
      if (hostErr) return { ok: false, hostClosed: true, error: hostErr };
      const selected = readSelected(comboRoot);
      if (!selected.some(matchesVal)) {
        return { ok: false, error: `点击选项后回读未生效（期望「${val}」，实读 ${JSON.stringify(selected)}）`, selected };
      }
      return {
        ok: true,
        action: "select",
        value: val,
        selected,
        popupClosed: !isComboOpen(comboRoot),
      };
    }

    if (stage === "finalize") {
      await sleep(60);
      if (isComboOpen(comboRoot)) {
        closeCombo(comboRoot);
        await sleep(50);
        if (isComboOpen(comboRoot) && o.allowCdpFallback) {
          const pt = pickUncoveredNeutralPoint(comboRoot);
          if (pt) {
            keepUid = true;
            return { ok: true, needCdpCloseClick: true, closeX: pt.x, closeY: pt.y };
          }
        }
      }
      const hostErr = verifyHostAlive();
      if (hostErr) return { ok: false, hostClosed: true, error: hostErr };
      const selected = readSelected(comboRoot);
      if (!selected.some(matchesVal)) {
        return { ok: false, error: `点击选项后回读未生效（期望「${val}」，实读 ${JSON.stringify(selected)}）`, selected };
      }
      return {
        ok: true,
        action: "select",
        value: val,
        selected,
        popupClosed: !isComboOpen(comboRoot),
      };
    }

    if (stage === "cleanup") {
      if (isComboOpen(comboRoot)) closeCombo(comboRoot);
      return { ok: true };
    }

    const t0 = Date.now();
    let popup = findVisiblePopup();
    while (!popup && Date.now() - t0 < 1200) {
      await sleep(50);
      popup = findVisiblePopup();
    }

    let opt = findOption(popup);
    const searchInput = comboRoot.querySelector?.(
      "input[type='search'], input.ant-select-selection-search-input, input.el-select__input, input[role='combobox']",
    );
    const isSearchable = comboRoot.classList?.contains("ant-select")
      ? comboRoot.classList.contains("ant-select-show-search") && Boolean(searchInput && !searchInput.disabled)
      : Boolean(
          searchInput &&
            !searchInput.readOnly &&
            !searchInput.disabled &&
            Number(window.getComputedStyle(searchInput).opacity) > 0,
        );

    if (!opt && isSearchable && searchInput) {
      setSearchInput(searchInput, val);
      const tSearch = Date.now();
      while (Date.now() - tSearch < 1200) {
        await sleep(65);
        popup = findVisiblePopup();
        opt = findOption(popup);
        if (opt) break;
      }
    }

    if (!opt) {
      popup = findVisiblePopup();
      if (popup) {
        const holder =
          popup.querySelector?.(".rc-virtual-list-holder, .el-scrollbar__wrap") ||
          (popup.scrollHeight > popup.clientHeight + 10 ? popup : null);
        if (holder && holder.scrollHeight > holder.clientHeight + 10) {
          if (typeof holder.scrollTo === "function") holder.scrollTo({ top: 0, behavior: "instant" });
          holder.scrollTop = 0;
          await sleep(40);
          opt = findOption(popup);
          const step = Math.max(120, Math.floor(holder.clientHeight * 0.75));
          for (let pos = step; !opt && pos <= holder.scrollHeight + step; pos += step) {
            const nextTop = Math.min(pos, Math.max(0, holder.scrollHeight - holder.clientHeight));
            if (typeof holder.scrollTo === "function") holder.scrollTo({ top: nextTop, behavior: "instant" });
            holder.scrollTop = nextTop;
            await sleep(45);
            popup = findVisiblePopup() || popup;
            opt = findOption(popup);
            if (nextTop >= holder.scrollHeight - holder.clientHeight) break;
          }
        }
      }
    }

    if (!opt) {
      const availableOptions = listVisibleOptions(findVisiblePopup() || popup)
        .map(optionLabel)
        .filter(Boolean)
        .slice(0, 20);
      if (isSearchable && searchInput && searchInput.value) {
        setSearchInput(searchInput, "");
      }
      closeCombo(comboRoot);
      return {
        ok: false,
        notFound: true,
        error: `下拉框中未找到精确匹配项「${val}」`,
        availableOptions,
      };
    }

    opt.scrollIntoView({ block: "nearest", behavior: "instant" });
    await doubleRaf();
    const optRect = opt.getBoundingClientRect();
    const optX = Math.round(optRect.x + optRect.width / 2);
    const optY = Math.round(optRect.y + optRect.height / 2);
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: optX, clientY: optY }));
    opt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: optX, clientY: optY }));
    opt.click?.();
    await sleep(75);

    let selected = readSelected(comboRoot);
    if (!selected.some(matchesVal) && o.allowCdpFallback && optRect.width > 0 && optRect.height > 0) {
      keepUid = true;
      return { ok: true, needCdpOptionClick: true, optX, optY };
    }

    if (isComboOpen(comboRoot)) {
      closeCombo(comboRoot);
      await sleep(50);
      if (isComboOpen(comboRoot) && o.allowCdpFallback) {
        const pt = pickUncoveredNeutralPoint(comboRoot);
        if (pt) {
          keepUid = true;
          return { ok: true, needCdpCloseClick: true, closeX: pt.x, closeY: pt.y };
        }
      }
    }
    const hostErr = verifyHostAlive();
    if (hostErr) return { ok: false, hostClosed: true, error: hostErr };
    selected = readSelected(comboRoot);
    return {
      ok: true,
      action: "select",
      value: val,
      selected,
      popupClosed: !isComboOpen(comboRoot),
    };
  } finally {
    if (!keepUid) {
      comboRoot.removeAttribute("data-pl-select-uid");
      comboRoot.removeAttribute("data-pl-select-dialog");
    }
  }
}

export function scrollPage(opts) {
  const o = opts || {};
  if (o.selector) {
    const el = document.querySelector(String(o.selector));
    if (!el) return { ok: false, error: "没有匹配元素" };
    el.scrollIntoView({ block: o.block || "center", behavior: "instant" });
    return { ok: true, via: "selector" };
  }
  const visible = (el) => {
    if (!el) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (
        cur.hidden ||
        cur.classList?.contains("ant-select-dropdown-hidden") ||
        cur.classList?.contains("ant-dropdown-hidden") ||
        cur.classList?.contains("ant-popover-hidden")
      ) {
        return false;
      }
      const st = window.getComputedStyle(cur);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      if (
        cur !== el &&
        cur.style?.overflow === "hidden" &&
        (cur.style?.width === "0px" || cur.style?.height === "0px")
      ) {
        return false;
      }
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isScrollableY = (el) => {
    if (!el) return false;
    const oy = window.getComputedStyle(el).overflowY;
    return (oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 20;
  };
  const maxZIndex = (el) => {
    let best = 0;
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const z = Number.parseInt(window.getComputedStyle(cur).zIndex, 10);
      if (Number.isFinite(z) && z > best) best = z;
      cur = cur.parentElement;
    }
    return best;
  };
  const findModalScroller = () => {
    const rawModals = [
      ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .ant-modal, .ant-drawer'),
    ].filter((el) => visible(el) && !el.closest('[aria-hidden="true"]'));
    if (!rawModals.length) return null;
    const topModals = rawModals
      .filter((m) => !rawModals.some((other) => other !== m && other.contains(m)))
      .map((m, idx) => ({ m, idx, z: maxZIndex(m) }))
      .sort((a, b) => (b.z !== a.z ? b.z - a.z : b.idx - a.idx));
    for (const { m } of topModals) {
      const scrollers = [m, ...m.querySelectorAll("*")].filter((el) => visible(el) && isScrollableY(el));
      if (scrollers.length) {
        scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        return scrollers[0];
      }
    }
    return null;
  };
  if (typeof o.percent === "number") {
    const scroller = findModalScroller();
    if (scroller) {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const y = max * (o.percent / 100);
      if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: y, behavior: "instant" });
      scroller.scrollTop = y;
      return { ok: true, via: "modal-percent", y, scrollTop: scroller.scrollTop };
    }
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const y = max * (o.percent / 100);
    scrollTo({ top: y, behavior: "instant" });
    return { ok: true, via: "percent", y };
  }
  if (typeof o.y === "number") {
    const scroller = findModalScroller();
    if (scroller) {
      if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: o.y, behavior: "instant" });
      scroller.scrollTop = o.y;
      return { ok: true, via: "modal-y", y: o.y, scrollTop: scroller.scrollTop };
    }
    scrollTo({ top: o.y, behavior: "instant" });
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
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const failure = (err) => {
    const message = err?.message || String(err);
    const csp = err instanceof EvalError || /unsafe-eval|Content Security Policy|Trusted ?Script/i.test(message);
    return csp ? { ok: false, cspBlocked: true, error: message } : { ok: false, error: message };
  };
  let fn;
  if (!/^\s*return\b/.test(raw)) {
    const exprCandidate = raw
      .trim()
      .replace(/;+(\s*(?:\/\/[^\n]*)?)$/, "$1")
      .replace(/;+\s*$/, "");
    if (exprCandidate) {
      try {
        fn = new AsyncFunction(`return (\n${exprCandidate}\n)`);
      } catch (err) {
        const isSyntax = err instanceof SyntaxError || err?.name === "SyntaxError";
        if (!isSyntax) return failure(err);
      }
    }
  }
  try {
    if (!fn) fn = new AsyncFunction(raw);
    const result = fn();
    return Promise.resolve(result).then((value) => ({ ok: true, result: dump(value) }), failure);
  } catch (err) {
    return failure(err);
  }
}
