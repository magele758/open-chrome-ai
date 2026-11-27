import { dialogNote } from "../../../lib/agent/cdp-tools.js";
import { isSensitiveUploadPath } from "../../../lib/bridge/tools-browser.js";
import { getCdp } from "../../../lib/cdp.js";
import { createTemuOptionCache } from "./attribute-cache.js";
import { temuApparelPage } from "./apparel-page.js";
import { temuControls } from "./controls.js";
import { temuDecorationPage } from "./decoration-page.js";
import { temuEditorPage } from "./editor-page.js";
import { temuMediaPage } from "./media-page.js";
import { temuSensitivePage } from "./sensitive-page.js";
import { temuSpecPage } from "./spec-page.js";
import { isTemuCategoryPage, temuStagePage } from "./stage1.js";
import { temuStockPage } from "./stock-page.js";

const SITE = "https://agentseller.temu.com";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => ({ ok: false, code, message });
const imagePath = path => typeof path === "string" && /^(?:\/|[A-Za-z]:[\\/]).+\.(?:jpe?g|png|webp)$/iu.test(path) &&
  !isSensitiveUploadPath(path);

export function isTemuDraftEditor(href) {
  try {
    const url = new URL(href);
    const drafts = url.searchParams.getAll("productDraftId");
    return !url.username && !url.password && url.origin === SITE && url.pathname === "/goods/edit" &&
      drafts.length === 1 && /^\d{1,24}$/u.test(drafts[0]) && !url.searchParams.has("productId");
  } catch {
    return false;
  }
}

/** A tool caller serves one trial begun on the new-product category page. */
export function createTemuListingToolCaller({
  tabId, url, signal, confirmUpload, api = globalThis.chrome, cdp = getCdp(),
  optionCache = createTemuOptionCache({ storage: api?.storage?.local }),
} = {}) {
  let href = url;
  let documentId;
  let categoryPath;
  let site;
  let stage = "category";
  let siteAndCategorySet = false;
  let busy = false;
  const verifiedMaterials = new Map();
  const currentTab = () => api.tabs.get(tabId).catch(() => null);
  const editorScope = () => ({ origin: SITE, path: "/goods/edit", href });

  const getConsistentTab = async () => {
    const tab = await currentTab();
    if (!tab || tab.url !== href || (stage === "editor" ? !isTemuDraftEditor(tab.url) : !isTemuCategoryPage(tab.url))) {
      return failure("PAGE_CHANGED", "试填标签或 Temu 登录状态已变化。");
    }
    const dialog = cdp.pendingDialog?.(tabId);
    return dialog ? failure("MODAL_BLOCKED", dialogNote(dialog)) : null;
  };

  async function runInPage(func, request) {
    signal?.throwIfAborted();
    const stopped = await getConsistentTab();
    if (stopped) return stopped;
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] };
    const [reply] = await api.scripting.executeScript({
      target, func, args: [func === temuEditorPage ? { ...request, categoryPath } : request],
    });
    signal?.throwIfAborted();
    if (!reply || !reply.documentId || reply.frameId !== 0 || documentId && reply.documentId !== documentId) {
      return failure("PAGE_CHANGED", "试填页面已重新加载。");
    }
    documentId ||= reply.documentId;
    const result = reply.result;
    const transition = func === temuStagePage && request.kind === "next" && result?.ok;
    return (!transition && await getConsistentTab()) || result || failure("PAGE_CHANGED", "试填页面失去连接。");
  }

  async function enteredEditor() {
    const deadline = Date.now() + 12000;
    do {
      signal?.throwIfAborted();
      const tab = await currentTab();
      if (isTemuDraftEditor(tab?.url)) {
        href = tab.url;
        documentId = undefined;
        stage = "editor";
        return { ok: true, href };
      }
      if (tab?.url !== href) return failure("PAGE_CHANGED", "选择类目后跳出了 Temu 新建商品页。");
      await sleep(180);
    } while (Date.now() < deadline);
    return failure("EDITOR_LOADING", "Temu 未进入第二步，请检查类目、站点或页面提示。");
  }

  async function approveFiles(role, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 10 || paths.some(path => !imagePath(path))) {
      return failure("UPLOAD_DENIED", "只能上传所选商品目录里的 JPG、PNG 或 WebP 图片。");
    }
    if (!(await confirmUpload?.({ role, paths: [...paths] }))) return failure("UPLOAD_DENIED", "未确认本次图片上传。");
    return null;
  }

  async function selectFiles(selector, paths) {
    signal?.throwIfAborted();
    const result = await cdp.send(tabId, "Runtime.evaluate", {
      expression: `(() => { if (location.href !== ${JSON.stringify(href)}) return null; const found = document.querySelectorAll(${JSON.stringify(selector)}); const input = found.length === 1 && found[0]; return input instanceof HTMLInputElement && input.type === "file" && !input.disabled ? input : null; })()`,
    });
    const objectId = result?.result?.objectId;
    if (!objectId) return failure("PAGE_CHANGED", "图片上传控件已切换。");
    try {
      await cdp.send(tabId, "DOM.setFileInputFiles", { objectId, files: paths });
    } finally {
      await cdp.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
    }
    return { ok: true };
  }

  async function pointAt(target, click = false) {
    if (!target.ok) return target;
    const { x, y } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      return failure("CONTROL_NOT_VISIBLE", "无法核对当前 Temu 控件的点击位置。");
    }
    const stopped = await getConsistentTab();
    if (stopped) return stopped;
    signal?.throwIfAborted();
    await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (click) {
      await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
    return { ok: true };
  }

  async function apparel(args) {
    const request = { href, kind: args.kind, key: args.key, value: args.value, alternate: args.alternate };
    const first = await runInPage(temuApparelPage, request);
    if (args.kind !== "set-color" || first.code !== "COLOR_MENU_UNAVAILABLE") return first;
    const point = await runInPage(temuApparelPage, { href, kind: "color-target", key: args.key });
    const clicked = await pointAt(point, true);
    return clicked.ok ? await runInPage(temuApparelPage, { ...request, allowOpened: true }) : clicked;
  }

  async function uploadMaterial(key, paths) {
    const filenames = paths.map(path => path.split(/[/\\]/u).at(-1).replace(/\.(?:jpe?g|png|webp)$/iu, ""));
    if (new Set(filenames).size !== filenames.length) return failure("UPLOAD_DENIED", "一起上传的图片需要不同的文件名。");
    const media = (kind, args) => runInPage(temuMediaPage, { href, kind, key, filenames, ...args });
    let openedWithHover = false;
    if (key === "decoration-images") {
      const point = await media("detail-target");
      const hovered = await pointAt(point);
      if (!hovered.ok) return hovered;
      openedWithHover = true;
    }
    const picker = await media("open", { trustedHover: openedWithHover });
    if (!picker.ok) return picker;
    let confirmed;
    try {
      if (Number.isInteger(picker.available) && paths.length > picker.available) {
        return failure("UPLOAD_CAPACITY", `素材中心还可选择 ${picker.available} 张图片。`);
      }
      let snapshot = picker;
      const receipts = [];
      for (const [index, path] of paths.entries()) {
        const filename = filenames[index];
        const localFilename = path.split(/[/\\]/u).at(-1);
        const baseline = picker.count + index;
        const pick = card => media("select-new", { filenames: [filename], baseline, expected: [card] });
        let card = verifiedMaterials.get(path);
        let picked = card && await pick(card);
        if (picked && !picked.ok && picked.code !== "UPLOAD_PENDING") return picked;
        if (!picked?.ok) {
          const selectedFiles = await selectFiles(snapshot.selector, [path]);
          if (!selectedFiles.ok) return selectedFiles;
          const settled = await media("settle-upload", { name: filename, previous: snapshot.knownMedia || [],
            baseline, localFilename });
          if (!settled.ok) return settled;
          card = settled.card;
          if (!card) return failure("UPLOAD_UNVERIFIED", "未能核对新上传的素材。");
          snapshot = await media("inspect");
          if (!snapshot.ok) return snapshot;
          if (snapshot.count === baseline) picked = await pick(card);
          else if (snapshot.count === baseline + 1) picked = { ok: true };
          else return failure("UPLOAD_UNVERIFIED", "上传后素材选择顺序已变化。");
          if (!picked.ok) return picked;
        }
        if (receipts.some(previous => previous.identity === card.identity)) {
          return failure("UPLOAD_UNVERIFIED", "多个槽位匹配到同一张素材，请核对目录里的图片。");
        }
        receipts.push(card);
        snapshot = await media("inspect");
        if (!snapshot.ok) return snapshot;
        if (snapshot.count !== baseline + 1) return failure("UPLOAD_UNVERIFIED", "素材没有进入预期的选择槽位。");
      }
      confirmed = await media("confirm", { baseline: picker.count, added: paths.length });
      if (!confirmed.ok) return confirmed;
      for (const [index, path] of paths.entries()) verifiedMaterials.set(path, receipts[index]);
      return { ...confirmed, media: receipts };
    } finally {
      if (!confirmed?.ok) await media("cancel").catch(() => {});
    }
  }

  async function upload({ role, key, identifier, paths }) {
    const request = { kind: "upload-target", href, role, key, identifier, expectedCount: paths?.length };
    const target = await runInPage(temuEditorPage, request);
    if (!target.ok) return target;
    const denied = await approveFiles(role, paths);
    if (denied) return denied;
    const stable = await runInPage(temuEditorPage, request);
    if (!stable.ok || stable.mode !== target.mode || stable.selector !== target.selector) return failure("PAGE_CHANGED", "图片上传控件已变化。");
    const selected = stable.mode === "material" ? await uploadMaterial(key, paths) : await selectFiles(stable.selector, paths);
    if (!selected.ok) return selected;
    const uploadDeadline = Date.now() + 14000;
    do {
      const next = await runInPage(temuEditorPage, request);
      if (next.ok && next.markers >= stable.markers + paths.length) {
        if (Array.isArray(stable.images)) {
          const desired = [...stable.images, ...(selected.media || []).map(card => card.src)];
          if (desired.length !== next.images?.length || desired.some((src, index) => src !== next.images[index])) {
            return failure("SKC_GALLERY_ORDER_UNVERIFIED", "规格图片已经回显，但无法按原定槽位核对顺序。");
          }
        }
        return { ok: true, status: "verified", uploaded: paths.length };
      }
      if (["PAGE_CHANGED", "MODAL_BLOCKED"].includes(next.code)) return next;
      await sleep(250);
    } while (Date.now() < uploadDeadline);
    return failure("UPLOAD_UNVERIFIED", "浏览器已交给页面处理图片，但未能核对 Temu 上传完成状态。");
  }

  async function fillDetails({ description, paths }) {
    if (!paths?.length) return failure("DETAIL_IMAGE_REQUIRED", "详情图文至少需要一张图片，请在商品目录中提供详情图并启用上传。");
    const denied = await approveFiles("detail", paths);
    if (denied) return denied;
    const edit = (kind, text, images) => runInPage(temuDecorationPage, { href, kind, description: text, hasImages: true, images });
    const prepared = await edit("begin", description);
    if (!prepared.ok) return prepared;
    let verified;
    try {
      const imageResult = await uploadMaterial("decoration-images", paths);
      if (!imageResult.ok) return imageResult;
      const images = imageResult.media?.map(card => card.src);
      if (images?.length !== paths.length) return failure("UPLOAD_UNVERIFIED", "未能核对放入详情预览的图片。");
      const written = await edit("write", description, images);
      if (!written.ok) return written;
      verified = await edit("apply", written.written ?? description, images);
      return verified.ok ? { ...verified, uploaded: paths.length, ...(written.detailIssue && { detailIssue: written.detailIssue }) } : verified;
    } finally {
      if (!verified?.ok && !signal?.aborted) await edit("cancel").catch(() => {});
    }
  }

  return async (tool, args = {}) => {
    if (args.tabId !== tabId || !Number.isSafeInteger(tabId) || tabId < 1) return failure("PAGE_CHANGED", "试填标签不匹配。");
    if (busy) return failure("FLOW_BUSY", "当前 Temu 商品页正执行另一步。");
    busy = true;
    try {
      if (stage === "category") {
        if (tool === "temu_sites") return await runInPage(temuStagePage, { kind: "sites", expectedHref: href });
        if (tool === "temu_category") {
          const selection = { expectedHref: href, siteId: args.site, category: args.categoryPath };
          const applied = await runInPage(temuStagePage, { ...selection, kind: "select" });
          if (!applied.ok) return applied;
          siteAndCategorySet = true;
          categoryPath = args.categoryPath;
          site = args.site;
          const next = await runInPage(temuStagePage, { ...selection, kind: "next" });
          return next.ok ? await enteredEditor() : next;
        }
      } else if (siteAndCategorySet) {
        switch (tool) {
          case "temu_editor_state": {
            const state = await runInPage(temuEditorPage, { kind: "inspect", href });
            if (!state.ok) return state;
            const dropdowns = await runInPage(temuControls, { kind: "inspect", scope: editorScope() });
            if (!dropdowns.ok) return dropdowns;
            return { ...state, fields: [...state.fields, ...dropdowns.fields],
              unsupported: dropdowns.unsupported, truncated: Boolean(state.truncated || dropdowns.truncated) };
          }
          case "temu_field_options":
          case "temu_select": {
            const options = await runInPage(temuControls, { kind: "inspect", scope: editorScope() });
            if (!options.ok) return options;
            const fields = options.fields.filter(field => field.key === args.key);
            if (fields.length !== 1) return failure("FIELD_MISSING", "没有唯一匹配的动态下拉字段。");
            const [field] = fields;
            const scope = { site, categoryPath };
            const request = { field, query: args.query, scope: editorScope() };
            if (tool === "temu_select") {
              if (field.skuMember === "sensitiveAttr") {
                return await runInPage(temuSensitivePage, { href, key: field.key, value: args.value });
              }
              const selected = await runInPage(temuControls, { ...request, kind: "select", value: args.value });
              if (selected?.options?.length) await optionCache.write(scope, field, selected.options);
              return selected;
            }
            const cached = !args.forceLive && !args.query && await optionCache.read(scope, field);
            if (cached) return { ok: true, options: cached };
            const live = await runInPage(temuControls, { ...request, kind: "probe" });
            if (live.ok && !args.query) await optionCache.write(scope, field, live.options);
            return live;
          }
          case "temu_write":
            return await runInPage(temuEditorPage, { kind: "write", href, key: args.key, value: args.value });
          case "temu_add_parent_spec":
            return await runInPage(temuEditorPage, { kind: "add-parent-spec", href });
          case "temu_spec_values":
            return await runInPage(temuSpecPage, { href, parentIndex: args.parentIndex, labels: args.labels, values: args.values });
          case "temu_stock":
            return await runInPage(temuStockPage, { href, kind: args.kind, key: args.key, value: args.value, rows: args.rows });
          case "temu_apparel":
            if (!["inspect", "add-color", "set-color", "inspect-sizes", "set-sizes", "dismiss-size-tip", "select-size-chart", "create-size-chart", "composition-inspect", "composition-add", "composition-percentage"].includes(args.kind)) {
              return failure("ACTION_UNSUPPORTED", "此操作不属于服装试填。");
            }
            return await apparel(args);
          case "temu_description":
            return await fillDetails(args);
          case "temu_origin":
            return await runInPage(temuStagePage, { kind: "origin", expectedHref: href, origin: args.origin });
          case "temu_upload":
            return await upload(args);
        }
      }
      return failure("ACTION_UNSUPPORTED", "此操作不属于当前 Temu 商品步骤。");
    } catch (error) {
      if (signal?.aborted) throw error;
      const stopped = await getConsistentTab();
      return stopped || failure("ACTION_FAILED", error?.message || "Temu 试填操作失败。");
    } finally {
      busy = false;
    }
  };
}
