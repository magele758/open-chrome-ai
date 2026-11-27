/** Read and operate the material picker only while the new Temu draft remains open. */
export async function temuMediaPage({ href, kind, key, filenames = [], previous = [], expected = [], name, localFilename, baseline, added, trustedHover = false }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const modalSelector = '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]';
  const modals = () => [...document.querySelectorAll(modalSelector)].filter(visible);
  const unique = items => items.length === 1 ? items[0] : null;
  const hasTitle = (node, text) => [...node.querySelectorAll('h1,h2,h3,[role="heading"],span,div')]
    .some(heading => visible(heading) && heading.childElementCount === 0 && clean(heading.textContent) === text);
  const withTitle = (text, matchesTitle = hasTitle) => {
    const matches = modals().filter(node => matchesTitle(node, text));
    return unique(matches.filter(node => !matches.some(other => node !== other && node.contains(other))));
  };
  const picker = () => withTitle("素材中心");
  const decoration = () => withTitle("详情页装修");
  const buttons = 'button,[role="button"]';
  const enabledButton = (area, label) => unique([...area.querySelectorAll(buttons)].filter(node =>
    visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && clean(node.textContent) === label));
  const isOrdered = /^productSkcList\[\d{1,3}\]\.carouselImgsI18n\.common$/u.test(key || "");
  const isImageArea = key => key === "noCostumeCarouselImgsI18n.common" ||
    /^productSkuMap\.[\w-]*\.previewImgsI18n\.common$/u.test(key || "") ||
    isOrdered;

  function selected(dialog) {
    const candidates = [...dialog.querySelectorAll("span,div,p")].filter(node => visible(node) && node.childElementCount <= 3)
      .map(node => /已选\s*(\d+)\s*个\s*[，,]?\s*可选\s*(\d+)\s*个/u.exec(clean(node.textContent)))
      .filter(Boolean);
    const states = new Map(candidates.map(match => [`${match[1]}/${match[2]}`, { count: Number(match[1]), available: Number(match[2]) }]));
    return states.size === 1 ? states.values().next().value : null;
  }

  async function waitFor(check, timeout = 2500) {
    const deadline = Date.now() + timeout;
    do {
      if (!onPage()) return null;
      const state = check();
      if (state) return state;
      await new Promise(resolve => setTimeout(resolve, 70));
    } while (Date.now() < deadline);
    return null;
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品页已切换。");
  const detail = key === "decoration-images";
  if (!detail && !isImageArea(key)) return fail("UPLOAD_CONTROL_MISSING", "图片目标不属于当前商品轮播或 SKU 预览图。");
  if (kind === "detail-target") return detail ? detailTarget() : fail("ACTION_UNSUPPORTED", "悬停只用于详情装修图片组件。");
  if (kind === "open") {
    const opened = detail ? await openDetails() : openListing();
    if (!opened.ok) return opened;
    if (!await waitFor(picker)) return fail("UPLOAD_CONTROL_MISSING", "没有打开当前图片区域对应的素材中心。");
  }

  const dialog = picker();
  const known = decoration();
  const foreignModals = () => modals().filter(node => node !== dialog && !node.contains(dialog) &&
    (!detail || !known || (node !== known && !node.contains(known))));
  if (kind === "settle-upload" && dialog) return settleUpload();
  if (!dialog || foreignModals().length) {
    return fail("MODAL_BLOCKED", "素材中心页面已变化。");
  }
  if (uploadLists(dialog).length) return fail("UPLOAD_PENDING", "素材中心的上传列表尚未关闭。");
  if (kind === "cancel") {
    const button = enabledButton(dialog, "取消");
    if (!button) return fail("UPLOAD_UNVERIFIED", "素材中心暂时不能关闭。");
    button.click();
    return await waitFor(() => !picker()) ? { ok: true } : fail("UPLOAD_UNVERIFIED", "素材中心尚未关闭。");
  }
  const state = selected(dialog);
  if (!state) return fail("UPLOAD_UNVERIFIED", "无法核对素材中心已选图片数。");
  const { count, available } = state;
  if (kind === "open" || kind === "inspect") {
    const input = unique([...dialog.querySelectorAll('[class*="UPD_outerWrapper_"] input[type="file"]')].filter(node => !node.disabled));
    if (!input) {
      return fail("UPLOAD_CONTROL_MISSING", "素材中心没有唯一可用的本地图片上传控件。");
    }
    const parts = [];
    for (let node = input; node && node !== document.body; node = node.parentElement) {
      parts.unshift(`${node.localName}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
    }
    const selector = `body > ${parts.join(" > ")}[type="file"]`;
    return { ok: true, selector, count, available, multiple: input.multiple, ordered: isOrdered,
      knownMedia: mediaCards(dialog).map(receipt) };
  }
  if (kind === "select-new") {
    if (!filenames.length || filenames.length > available || new Set(filenames).size !== filenames.length || count !== baseline ||
        isOrdered && (expected.length !== filenames.length || new Set(expected.map(card => card.identity)).size !== expected.length)) {
      return fail("UPLOAD_UNVERIFIED", "当前素材选择或上传文件名与计划不一致。");
    }
    const existing = new Set(previous.map(card => card.identity));
    const approved = new Map(expected.map(card => [card.filename, card]));
    const find = name => {
      const accepted = approved.get(name);
      return unique(mediaCards(dialog).filter(card => card.filename === name && (accepted ?
        card.identity === accepted.identity && card.libraryFilename === (accepted.libraryFilename ?? name) &&
          (!accepted.src || card.src === accepted.src) :
        card.libraryFilename === name && !existing.has(card.identity))));
    };
    const missing = filenames.filter(name => !find(name));
    if (missing.length) return fail("UPLOAD_PENDING", "尚未出现所有新上传的素材卡片。");
    const media = [];
    for (const [index, name] of filenames.entries()) {
      const current = find(name);
      if (!onPage() || picker() !== dialog || foreignModals().length || !current) return fail("UPLOAD_UNVERIFIED", "新上传的素材卡片已变化。");
      current.target.click();
      if (!await waitFor(() => picker() === dialog && !foreignModals().length && selected(dialog)?.count === baseline + index + 1)) {
        return fail("UPLOAD_UNVERIFIED", "没有核对到刚上传的图片进入选择列表。");
      }
      media.push(receipt(current));
    }
    return { ok: true, count: selected(dialog).count, ordered: isOrdered, media };
  }
  if (kind !== "confirm") return fail("ACTION_UNSUPPORTED", "此操作不属于图片上传流程。");
  if (count !== baseline + added) return fail("UPLOAD_UNVERIFIED", "本次上传的新图片尚未全部选中。");
  const button = enabledButton(dialog, "确认");
  if (!button) return fail("UPLOAD_CONTROL_MISSING", "找不到素材中心内可用的确认按钮。");
  button.click();
  return await waitFor(() => !picker()) ? { ok: true } : fail("UPLOAD_UNVERIFIED", "素材中心尚未关闭。");

  function receipt({ identity, filename, libraryFilename, src }) {
    return { identity, filename, libraryFilename, src };
  }

  function isActiveUploadList(portal) {
    const content = portal.querySelector('[class*="PP_popoverContent_"]');
    return Boolean(content && [portal, content].every(area => {
      if (!visible(area)) return false;
      const style = getComputedStyle(area);
      const box = area.getBoundingClientRect();
      const offscreen = box.bottom < 0 || box.right < 0 || box.top >= innerHeight || box.left >= innerWidth;
      return !(style.opacity === "0" && (offscreen || style.pointerEvents === "none"));
    }));
  }

  function uploadLists(dialog) {
    const modal = dialog.closest('[data-testid="beast-core-modal"]');
    const mask = modal?.parentElement;
    if (!mask?.matches('[data-testid="beast-core-modal-mask"]')) return [];
    return [...mask.children].filter(portal => portal.matches('[data-testid="beast-core-portal"][class*="PP_popover_"]') &&
      isActiveUploadList(portal) && [...portal.querySelectorAll('[class*="PP_popoverContent_"] [class*="index-module_modalContainer"] header')]
        .some(header => visible(header) && clean(header.textContent) === "上传列表"));
  }

  function clickPickerHeading(dialog) {
    const heading = unique([...dialog.querySelectorAll('h1,h2,h3,[role="heading"],span,div')].filter(node =>
      visible(node) && !node.childElementCount && clean(node.textContent) === "素材中心" &&
      !node.closest('button,a,[role="button"],[role="tab"]')));
    if (!heading) return false;
    const { x, y, width, height } = heading.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: x + width / 2, clientY: y + height / 2 };
    const pointer = { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true };
    heading.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    heading.dispatchEvent(new MouseEvent("mousedown", { ...options, buttons: 1 }));
    heading.dispatchEvent(new PointerEvent("pointerup", pointer));
    heading.dispatchEvent(new MouseEvent("mouseup", options));
    heading.dispatchEvent(new MouseEvent("click", options));
    return true;
  }

  function duplicateTitles(modal, title) {
    return [...modal.querySelectorAll(
      '[data-testid="beast-core-modal-body"] > div[class*="index-module_container__"] > div[class*="index-module_title__"]',
    )].filter(heading => visible(heading) && clean(heading.innerText || heading.textContent) === title);
  }

  function duplicateFilename(modal, title) {
    const headings = duplicateTitles(modal, title);
    if (!headings.length) return unique([...modal.querySelectorAll('span,div,p,[title]')]
      .filter(node => visible(node) && !node.childElementCount)
      .map(node => clean(node.getAttribute("title") || node.textContent)).filter(filename => /\.(?:jpe?g|png|webp)$/iu.test(filename)));
    const heading = unique(headings);
    const item = heading && unique([...heading.parentElement.querySelectorAll(
      ':scope > div[class*="index-module_materialContainer__"] > div[class*="index-module_materialItem__"]',
    )].filter(visible));
    const label = item && unique([...item.querySelectorAll(':scope > div[class*="index-module_materialName__"]')].filter(visible));
    return clean(label?.innerText || label?.textContent);
  }

  async function settleUpload() {
    if (!name || !filenames.includes(name) || localFilename && (
      !/\.(?:jpe?g|png|webp)$/iu.test(localFilename) || localFilename.replace(/\.(?:jpe?g|png|webp)$/iu, "") !== name)) {
      return fail("UPLOAD_UNVERIFIED", "上传文件与素材计划不一致。");
    }
    const existing = new Set(previous.map(card => card.identity));
    const initialCount = Number.isInteger(baseline) ? baseline : selected(dialog)?.count;
    let cropped = false;
    let savedAt = 0;
    let refreshed = false;
    let closingList;
    let lastCard;
    let duplicateDismissed = false;
    let duplicateLibraryReadyAt = 0;
    const unverifiedDuplicate = () => fail("UPLOAD_DUPLICATE_UNVERIFIED", "已关闭重复上传提示，素材中心没有可唯一核对的同款图片。");
    const outcome = await waitFor(() => {
      if (picker() !== dialog) return fail("MODAL_BLOCKED", "处理上传时素材中心已切换。");
      const alert = [...document.querySelectorAll('[role="alert"],[data-testid*="toast" i],[class*="Toast_content"]')]
        .filter(visible).map(node => clean(node.textContent))
        .find(message => /图片|裁剪/u.test(message) && /失败|不符合|不支持|超出|不能|无效/u.test(message));
      if (alert) return fail("UPLOAD_REJECTED", alert.slice(0, 180));
      const extra = foreignModals();
      // Temu may place the crop dialog in a portal or nest it within the picker.
      const crop = withTitle("裁剪") || withTitle("图片裁剪");
      const upload = withTitle("本地上传") || withTitle("上传图片");
      const duplicateTitle = "素材中心已有如下素材，无需重复上传";
      const duplicate = withTitle(duplicateTitle, (modal, title) => hasTitle(modal, title) || duplicateTitles(modal, title).length);
      if (extra.some(node => ![crop, upload, duplicate].some(owned => owned && (node === owned || node.contains(owned))))) {
        return fail("MODAL_BLOCKED", "上传时出现了无法识别的 Temu 弹窗。");
      }
      if (duplicate && duplicate !== dialog && duplicate !== known && !duplicateDismissed) {
        const filename = duplicateFilename(duplicate, duplicateTitle);
        const sameFile = filename && (localFilename ? filename === localFilename : filename.replace(/\.(?:jpe?g|png|webp)$/iu, "") === name);
        const footer = unique([...duplicate.querySelectorAll(':scope > div[class*="MDL_bottom_"]')].filter(visible));
        const close = footer && enabledButton(footer, "关闭");
        if (!sameFile || !close || !Number.isInteger(initialCount) || selected(dialog)?.count !== initialCount) {
          return fail("UPLOAD_UNVERIFIED", "Temu 的重复素材提示与本次上传的文件不一致。");
        }
        duplicateDismissed = true;
        lastCard = null;
        close.click();
        return null;
      }
      if (crop && crop !== dialog && crop !== known && !cropped && !duplicateDismissed) {
        const confirm = enabledButton(crop, "确认裁剪");
        if (confirm) {
          cropped = true;
          confirm.click();
        }
        return null;
      }
      const saveArea = crop || upload;
      if (saveArea && saveArea !== dialog && saveArea !== known && !savedAt && !duplicateDismissed) {
        const save = enabledButton(saveArea, "保存");
        if (save) {
          savedAt = Date.now();
          save.click();
        }
        return null;
      }
      if (extra.length) return null;
      if (closingList && isActiveUploadList(closingList)) return null;
      const lists = uploadLists(dialog);
      if (lists.length > 1) return fail("MODAL_BLOCKED", "素材中心出现多个上传列表，需要核对。");
      if (lists.length) {
        closingList = lists[0];
        if (!clickPickerHeading(dialog)) return fail("UPLOAD_UNVERIFIED", "未找到可安全关闭上传列表的位置。");
        lastCard = null;
        return null;
      }
      if (duplicateDismissed) {
        duplicateLibraryReadyAt ||= Date.now();
        const timedOut = Date.now() - duplicateLibraryReadyAt >= 1200;
        if (selected(dialog)?.count !== initialCount) {
          lastCard = null;
          return timedOut ? fail("UPLOAD_UNVERIFIED", "关闭重复素材提示后，无法核对原有图片选择。") : null;
        }
        const card = unique(mediaCards(dialog, true).filter(card => card.libraryFilename === name));
        if (card && card.identity === lastCard?.identity && card.src === lastCard?.src) {
          return { ok: true, duplicate: true, card: receipt(card) };
        }
        lastCard = card;
        return timedOut ? unverifiedDuplicate() : null;
      }
      const matches = mediaCards(dialog).filter(card => card.filename === name && !existing.has(card.identity) &&
        (card.libraryFilename === name || cropped && savedAt));
      if (matches.length > 1) return fail("UPLOAD_UNVERIFIED", "出现多张同名的新素材，无法核对这次上传的文件。");
      const [card] = matches;
      if (card && card.identity === lastCard?.identity && card.src === lastCard?.src) return { ok: true, card: receipt(card) };
      lastCard = card;
      if (!card && savedAt && !refreshed && Date.now() - savedAt >= 900) {
        refreshed = true;
        const refresh = unique([...dialog.querySelectorAll('button,a,[role="link"],[role="button"]')].filter(node => {
          const href = node.getAttribute("href");
          return visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && clean(node.textContent) === "刷新" &&
            (!href || href === "#" || /^javascript:\s*(?:void\(0\))?;?$/u.test(href));
        }));
        refresh?.click();
      }
      return null;
    }, 18000);
    return outcome || fail("UPLOAD_PENDING", duplicateDismissed ? "Temu 的重复素材提示或上传列表尚未关闭。" :
      closingList && isActiveUploadList(closingList) ? "素材中心的上传列表尚未关闭。" : "尚未核对到本次文件在素材中心生成的新图片。");
  }

  function materialLibraryCards(dialog) {
    const selector = 'div[class*="index-module_itemContainer__"] > div[class*="index-module_cardContainer__"]';
    return [...dialog.querySelectorAll(selector)].filter(visible);
  }

  function mediaCards(dialog, allNames = false) {
    if (!filenames.length) return [];
    const names = new Set(filenames);
    const found = new Map();
    function matchingNames(text, approvedAliases = false) {
      const libraryFilename = clean(text).replace(/\.(?:jpe?g|png|webp)$/iu, "");
      const sourceOfCrop = libraryFilename.replace(/-\d+$/u, "");
      const aliases = approvedAliases ? expected.filter(card => card.libraryFilename === libraryFilename).map(card => card.filename) : [];
      const candidates = allNames ? libraryFilename ? [libraryFilename] : [] :
        [...new Set([libraryFilename, sourceOfCrop, ...aliases])].filter(filename => names.has(filename));
      return { libraryFilename, candidates };
    }
    function record({ libraryFilename, candidates }, image, card) {
      const url = new URL(image.currentSrc || image.src);
      const src = url.origin + url.pathname;
      const identity = clean(card.getAttribute("data-material-id") || card.getAttribute("data-id")) || src;
      for (const filename of candidates) {
        found.set(filename + "\0" + libraryFilename + "\0" + identity, { filename, libraryFilename, identity, src, target: image });
      }
    }

    const libraryCards = materialLibraryCards(dialog);
    if (libraryCards.length) {
      for (const card of libraryCards) {
        const holder = unique([...card.querySelectorAll(':scope > div[class*="index-module_itemContent__"] > div[class*="index-module_materialName__"]')].filter(visible));
        const label = holder && unique([...holder.querySelectorAll('div[data-testid="beast-core-ellipsis"] > div[class*="elli_outerWrapper_"]')]);
        if (!label) continue;
        const matched = matchingNames(label.getAttribute("title") || holder.getAttribute("title") || label.innerText || label.textContent, true);
        if (!matched.candidates.length) continue;
        const image = unique([...card.querySelectorAll(':scope > div[class*="index-module_cover__"] > div[class*="index-module_imageContainer__"] > img[src]')]
          .filter(node => visible(node) && /^https:\/\//iu.test(node.currentSrc || node.src)));
        if (image) record(matched, image, card);
      }
      return [...found.values()];
    }
    if (allNames) return [];

    for (const label of dialog.querySelectorAll('span,div,p,[title],img[alt]')) {
      if (!visible(label)) continue;
      const labelText = label.getAttribute("title") || label.getAttribute("alt") ||
        (label.childElementCount <= 1 ? label.textContent : "");
      const matched = matchingNames(labelText);
      if (!matched.candidates.length) continue;
      const start = label.querySelector("img") ? label : label.parentElement;
      for (let card = start, depth = 0; card && card !== dialog && depth < 6; card = card.parentElement, depth++) {
        const image = unique([...card.querySelectorAll("img[src]")].filter(node => visible(node) &&
          /^https:\/\//iu.test(node.src) && !node.closest('a[href]') && !node.matches('[class*="icon" i]')));
        if (!image) continue;
        record(matched, image, card);
        break;
      }
    }
    return [...found.values()];
  }

  function openListing() {
    if (modals().length) return fail("MODAL_BLOCKED", "当前商品页已有弹窗。");
    const root = document.getElementById("page_container_id");
    const holder = document.getElementById(key);
    const label = holder && unique([...holder.querySelectorAll('[class^="upload-trigger_wrap__"],[class^="upload-trigger_wrap__"] *')]
      .filter(node => visible(node) && clean(node.textContent) === "素材中心" && ![...node.children].some(child => clean(child.textContent) === "素材中心")));
    if (!holder || !root?.contains(holder) || !label) return fail("UPLOAD_CONTROL_MISSING", "找不到当前图片区域的素材中心入口。");
    label.click();
    return { ok: true };
  }

  function decorationForeground(active) {
    return active && decoration() === active && modals().every(node => node === active || node.contains(active));
  }

  function imageItem(active) {
    return unique([...active.querySelectorAll('div[draggable="true"] [class*="side-left_sectionItem__"]')].filter(node =>
      visible(node) && [...node.querySelectorAll('span')].some(label => visible(label) && clean(label.textContent) === "图片")));
  }

  async function detailTarget() {
    const active = decoration();
    if (!decorationForeground(active)) return fail("MODAL_BLOCKED", "详情装修弹窗不在前台。");
    const item = imageItem(active);
    if (!item) return fail("UPLOAD_CONTROL_MISSING", "找不到详情装修图片组件。");

    function hitTarget() {
      if (!decorationForeground(active) || item !== imageItem(active)) return null;
      const viewport = active.getBoundingClientRect();
      const bounds = item.getBoundingClientRect();
      const left = Math.max(0, viewport.left, bounds.left);
      const top = Math.max(0, viewport.top, bounds.top);
      const right = Math.min(innerWidth, viewport.right, bounds.right);
      const bottom = Math.min(innerHeight, viewport.bottom, bounds.bottom);
      if (right - left < 2 || bottom - top < 2) return null;
      const x = Math.floor((left + right) / 2);
      const y = Math.floor((top + bottom) / 2);
      const hit = document.elementFromPoint(x, y);
      return hit && item.contains(hit) ? { ok: true, x, y } : null;
    }

    const ready = hitTarget();
    if (ready) return ready;
    // Avoid scrolling the page behind the modal or triggering its sticky controls.
    for (let parent = item.parentElement; parent && active.contains(parent); parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const container = parent.getBoundingClientRect();
      const bounds = item.getBoundingClientRect();
      if (/^(auto|scroll)$/u.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
        parent.scrollTop += bounds.top < container.top ? bounds.top - container.top : Math.max(0, bounds.bottom - container.bottom);
      }
      if (/^(auto|scroll)$/u.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
        parent.scrollLeft += bounds.left < container.left ? bounds.left - container.left : Math.max(0, bounds.right - container.right);
      }
    }
    const target = await waitFor(hitTarget, 600);
    if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品页已切换。");
    if (!decorationForeground(active)) return fail("MODAL_BLOCKED", "详情装修弹窗已切换。");
    return target || fail("DETAIL_HOVER_TARGET_BLOCKED", "详情装修图片组件当前被遮挡或不在视口内。");
  }

  async function openDetails() {
    const active = decoration();
    const foreground = () => decorationForeground(active);
    if (!foreground()) return fail("MODAL_BLOCKED", "详情装修弹窗不在前台。");
    const item = imageItem(active);
    if (!item) return fail("UPLOAD_CONTROL_MISSING", "找不到详情装修图片组件。");
    const modal = active.closest('[data-testid="beast-core-modal"]');
    const mask = modal?.parentElement;
    const entrySelector = 'button,a,span,div,p,strong,h3,h4,label,[role="menuitem"],[role="button"]';
    const entriesIn = area => [...area.querySelectorAll(entrySelector)].filter(node =>
      clean(node.textContent) === "从素材中心添加" && ![...node.children].some(child => clean(child.textContent) === "从素材中心添加") &&
      visible(node) && !node.closest('[disabled],[aria-disabled="true"]'));
    function materialEntries() {
      const portals = mask?.matches('[data-testid="beast-core-modal-mask"]') ? [...mask.children].filter(node =>
        visible(node) && node.matches('[data-testid="beast-core-portal"]')) : [];
      return [...new Set([active, ...portals].flatMap(entriesIn))];
    }
    if (trustedHover) {
      const menuRow = node => {
        for (let row = node.parentElement, depth = 0; row && row !== active && row !== mask && row !== document.body && depth < 3; row = row.parentElement, depth++) {
          if ([...row.querySelectorAll(entrySelector)].some(subtitle => !subtitle.childElementCount &&
            clean(subtitle.textContent) === "快速选择已有素材" && visible(subtitle))) return row;
        }
        return null;
      };
      const add = await waitFor(() => {
        if (!foreground() || item !== imageItem(active)) return null;
        const scoped = materialEntries().filter(menuRow);
        if (scoped.length) return unique(scoped);

        // Temu can render this hover menu in a body portal outside the decoration mask.
        const tile = item.getBoundingClientRect();
        return unique(entriesIn(document.body).filter(node => {
          const title = node.getBoundingClientRect();
          if (title.width <= 0 || title.height <= 0 || title.left < tile.left - 8 || title.left > tile.right + 130 ||
              title.top < tile.bottom - 10 || title.top > tile.bottom + 100) return false;
          const row = menuRow(node);
          const hit = row && document.elementFromPoint(title.left + title.width / 2, title.top + title.height / 2);
          return Boolean(hit && row.contains(hit));
        }));
      });
      if (!add || !foreground()) return fail("UPLOAD_CONTROL_MISSING", "悬停后找不到详情装修的素材中心入口。");
      add.click();
      return { ok: true };
    }
    const existing = new Set(materialEntries());
    const { x, y, width, height } = item.getBoundingClientRect();
    const mouse = { bubbles: true, cancelable: true, composed: true,
      relatedTarget: document.documentElement, clientX: x + width / 2, clientY: y + height / 2 };
    const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };
    // The component opens its image-source menu on hover, not on a DOM click.
    item.dispatchEvent(new PointerEvent("pointerover", pointer));
    item.dispatchEvent(new MouseEvent("mouseover", mouse));
    item.dispatchEvent(new PointerEvent("pointerenter", { ...pointer, bubbles: false }));
    item.dispatchEvent(new MouseEvent("mouseenter", { ...mouse, bubbles: false }));
    const add = await waitFor(() => foreground() && unique(materialEntries().filter(node => !existing.has(node))));
    if (!add || !foreground()) return fail("UPLOAD_CONTROL_MISSING", "找不到详情装修的素材中心入口。");
    add.click();
    return { ok: true };
  }
}
