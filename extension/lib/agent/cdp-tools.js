/**
 * 基于 chrome.debugger（CDP）的可信输入工具：真实点击/悬停/拖拽/组合键/文件上传/对话框/整页截图。
 * 页面里合成的 DOM 事件是 untrusted，很多网站会忽略；这里发的是浏览器级输入事件。
 */

import { dragMoveEvents, keyEvents, mouseClickEvents } from "../cdp-input.js";
import { inject, injectFrames, toToolText } from "../chrome.js";
import { requireOptionalFeature } from "../optional-permissions.js";
import { checkStates } from "./page-fns.js";
import { iframeRect, locateElement } from "./page-snapshot.js";

const MAX_SHOT_HEIGHT = 16000;
const DIALOG_GUARDED = new Set([
  "click",
  "fill",
  "select_option",
  "press_key",
  "run_js",
  "act_element",
  "jev_next_action",
  "paste_into_page",
  "trusted_click",
  "set_checks",
  "hover",
  "trusted_type",
  "press_keys",
  "drag_drop",
  "upload_file",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

const TARGET_PROPS = {
  index: { type: "integer", minimum: 1, description: "snapshot_controls 的编号" },
  selector: { type: "string", description: "CSS 选择器" },
  text: { type: "string", description: "控件可见文字" },
  nth: { type: "integer", description: "多个匹配时取第几个，从 0 开始" },
  x: { type: "number", description: "直接给视口坐标（CSS 像素）" },
  y: { type: "number" },
};

export function dialogNote(dialog) {
  return `页面弹出了 ${dialog.type} 对话框：「${String(dialog.message).slice(0, 200)}」。操作可能还没完成，用 handle_dialog（accept=true 确认 / false 取消）处理后再继续。`;
}

/** 给会触发页面行为的工具加上对话框保护：alert/confirm 会卡住注入的脚本，这里抢先返回。 */
export function withDialogGuard(tools, { cdp, resolveTabId, enabled }) {
  if (!enabled) return tools;
  return tools.map((tool) => {
    if (!DIALOG_GUARDED.has(tool.name)) return tool;
    return {
      ...tool,
      async execute(args) {
        let tabId;
        try {
          tabId = await resolveTabId(args);
          await cdp.ensure(tabId);
        } catch {
          return tool.execute(args);
        }
        const watch = cdp.watchDialog(tabId);
        const run = tool.execute(args);
        run.catch(() => {});
        const first = await Promise.race([run.then((value) => ({ value })), watch.promise.then((dialog) => ({ dialog }))]);
        watch.cancel();
        if (first.dialog) return dialogNote(first.dialog);
        const pending = cdp.pendingDialog(tabId);
        return pending ? `${first.value}\n\n${dialogNote(pending)}` : first.value;
      },
    };
  });
}

export async function cdpScreenshot(cdp, tabId, { fullPage = false, selector = "", quality = 80 } = {}) {
  let clip;
  if (selector) {
    const hit = await inject(tabId, locateElement, [{ selector }]);
    if (!hit?.ok && !hit?.covered) throw new Error(hit?.error || "找不到要截图的元素");
    const { x, y, w, h } = hit.page;
    clip = { x, y, width: w, height: Math.min(h, MAX_SHOT_HEIGHT), scale: 1 };
  } else if (fullPage) {
    const metrics = await cdp.send(tabId, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), MAX_SHOT_HEIGHT), scale: 1 };
  }
  const shot = await cdp.send(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality,
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  });
  return { dataUrl: `data:image/jpeg;base64,${shot.data}`, clip };
}

export function createCdpTools(ctx, { cdp, resolveTabId, attachTabToTask, getRefItem }) {
  const webNavigation = () => globalThis.chrome?.webNavigation;

  async function frameOffset(tabId, frameId) {
    if (!frameId) return { x: 0, y: 0 };
    const denied = await requireOptionalFeature("webNavigation");
    if (denied) throw new Error(denied);
    const info = await webNavigation()?.getFrame?.({ tabId, frameId });
    if (!info || info.parentFrameId !== 0) {
      throw new Error("嵌套 iframe 暂不支持可信输入，请改用 click / act_element。");
    }
    const rect = await inject(tabId, iframeRect, [info.url]);
    if (!rect) throw new Error("找不到承载该 iframe 的元素，无法换算坐标。");
    return rect;
  }

  async function resolvePoint(tabId, spec) {
    if (Number.isFinite(Number(spec?.x)) && Number.isFinite(Number(spec?.y)) && spec.x != null && spec.y != null) {
      return { x: Math.round(Number(spec.x)), y: Math.round(Number(spec.y)), match: "坐标" };
    }
    let frameId = 0;
    let target;
    if (spec?.index != null) {
      const { item, error } = getRefItem(tabId, spec.index);
      if (error) throw new Error(error);
      frameId = item.frameId || 0;
      target = { node: item.node };
    } else {
      target = { selector: spec?.selector, text: spec?.text, nth: spec?.nth };
    }
    let hit = await inject(tabId, locateElement, [target], { frameId });
    if (!hit?.ok && hit?.notFound && spec?.index == null) {
      const all = await injectFrames(tabId, locateElement, [target]);
      const found = all.find((f) => f.frameId > 0 && f.result?.ok);
      if (found) {
        hit = found.result;
        frameId = found.frameId;
      }
    }
    if (!hit?.ok) {
      const extra = hit?.blocker ? `（遮挡物：${hit.blocker.tag} ${hit.blocker.text}）` : "";
      throw new Error(`${hit?.error || "定位失败"}${extra}`);
    }
    const offset = await frameOffset(tabId, frameId);
    return { x: hit.x + offset.x, y: hit.y + offset.y, match: `${hit.tag} ${hit.text}`.trim(), frameId };
  }

  const mouse = (tabId, events) =>
    events.reduce((p, e) => p.then(() => cdp.send(tabId, "Input.dispatchMouseEvent", e)), Promise.resolve());
  const keys = async (tabId, combos) => {
    for (const combo of combos) {
      for (const event of keyEvents(combo)) await cdp.send(tabId, "Input.dispatchKeyEvent", event);
    }
  };
  const hasTarget = (a) =>
    a?.index != null || a?.selector || a?.text || (a?.x != null && a?.y != null);

  const prepare = async (args) => {
    const tabId = await resolveTabId(args);
    await attachTabToTask(tabId);
    return tabId;
  };

  return [
    {
      name: "trusted_click",
      description:
        "用浏览器级真实鼠标事件点击（untrusted 的 click 被网站忽略时用）：支持右键 button=right、双击 double=true。目标用 index / selector / text 或 x,y。会触发 Chrome「正在调试」横幅。",
      parameters: obj({
        tabId: { type: "integer", minimum: 1 },
        ...TARGET_PROPS,
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean" },
      }),
      async execute(args) {
        if (!hasTarget(args)) return "需要 index、selector、text 或 x,y 之一。";
        const tabId = await prepare(args);
        try {
          const p = await resolvePoint(tabId, args);
          await mouse(tabId, mouseClickEvents(p.x, p.y, { button: args.button || "left", clickCount: args.double ? 2 : 1 }));
          await sleep(60);
          return toToolText({ ok: true, action: args.double ? "double_click" : `${args.button || "left"}_click`, at: { x: p.x, y: p.y }, match: p.match });
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "set_checks",
      description:
        "按标签文字批量勾选/取消复选框、开关、单选（含 Radix/shadcn 的 button[role=checkbox]），一次调用处理多项，用真实鼠标点击并回读确认。labels 写选项名或其前缀即可（如 [\"知乎\",\"B站专栏\"]）。不传 labels 则只列出页面上所有复选项及状态。多选平台/权限/筛选项时优先用它，不要逐个 click 再逐个验证。",
      parameters: obj({
        tabId: { type: "integer", minimum: 1 },
        labels: { type: "array", items: { type: "string" }, description: "要设置的选项文字" },
        checked: { type: "boolean", description: "目标状态，默认 true（勾选）；false 为取消" },
        exact: { type: "boolean", description: "true 则标签必须完全相等" },
      }),
      async execute(args) {
        const tabId = await prepare(args);
        const labels = (Array.isArray(args.labels) ? args.labels : []).map(String).filter(Boolean);
        try {
          if (!labels.length) {
            const listed = await inject(tabId, checkStates, [{}]);
            return toToolText({ ok: true, items: listed?.items || [] });
          }
          const want = args.checked !== false;
          const read = async (label) =>
            (await inject(tabId, checkStates, [{ labels: [label], exact: args.exact === true, scroll: true }]))?.results?.[0];
          const results = [];
          for (const label of labels) {
            let st = await read(label);
            if (!st?.found) {
              results.push({ label, ok: false, error: "页面上没有匹配的复选项" });
              continue;
            }
            if (st.ambiguous) {
              results.push({ label, ok: false, matched: st.label, error: "匹配到多个选项，请写得更完整或设 exact" });
              continue;
            }
            if (st.disabled && st.checked !== want) {
              results.push({ label, ok: false, matched: st.label, checked: st.checked, error: "该选项被禁用" });
              continue;
            }
            for (let attempt = 0; attempt < 2 && st.checked !== want; attempt += 1) {
              await mouse(tabId, mouseClickEvents(st.x, st.y));
              await sleep(150);
              st = (await read(label)) || st;
            }
            results.push({ label, ok: st.checked === want, matched: st.label, checked: st.checked });
          }
          return toToolText({ ok: results.every((r) => r.ok), results });
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "hover",
      description: "把真实鼠标移到目标上（触发悬停菜单、tooltip）。目标用 index / selector / text 或 x,y。",
      parameters: obj({ tabId: { type: "integer", minimum: 1 }, ...TARGET_PROPS }),
      async execute(args) {
        if (!hasTarget(args)) return "需要 index、selector、text 或 x,y 之一。";
        const tabId = await prepare(args);
        try {
          const p = await resolvePoint(tabId, args);
          await mouse(tabId, [{ type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 }]);
          await sleep(200);
          return toToolText({ ok: true, action: "hover", at: { x: p.x, y: p.y }, match: p.match });
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "trusted_type",
      description:
        "用真实输入输入文字（富文本编辑器、画布类输入框、fill 填不进去时用）。给目标会先真实点击聚焦；clear=true 先全选删除；submit=true 末尾回车。",
      parameters: obj(
        {
          tabId: { type: "integer", minimum: 1 },
          ...TARGET_PROPS,
          value: { type: "string", description: "要输入的文字" },
          clear: { type: "boolean" },
          submit: { type: "boolean" },
        },
        ["value"],
      ),
      async execute(args) {
        const tabId = await prepare(args);
        try {
          if (hasTarget(args)) {
            const p = await resolvePoint(tabId, args);
            await mouse(tabId, mouseClickEvents(p.x, p.y));
          }
          if (args.clear) await keys(tabId, ["Control+A", "Delete"]);
          await cdp.send(tabId, "Input.insertText", { text: String(args.value ?? "") });
          if (args.submit) await keys(tabId, ["Enter"]);
          return toToolText({ ok: true, action: "type", length: String(args.value ?? "").length });
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "press_keys",
      description:
        "发送真实键盘组合键，按顺序执行。写法：Enter、Tab、Escape、ArrowDown、F5、Control+A、Control+C、Control+V、Shift+Tab、Meta+K（Mac 用 Meta）。Control/Meta+A/C/V/X/Z 会触发真正的全选/复制/粘贴/剪切/撤销。给目标会先点击聚焦。",
      parameters: obj(
        {
          tabId: { type: "integer", minimum: 1 },
          ...TARGET_PROPS,
          keys: { type: "array", items: { type: "string" }, description: "如 [\"Control+A\", \"Control+C\"]" },
        },
        ["keys"],
      ),
      async execute(args) {
        const combos = Array.isArray(args.keys) ? args.keys.map(String) : [String(args.keys || "")];
        if (!combos.length || combos.some((c) => !c.trim())) return "keys 不能为空。";
        const tabId = await prepare(args);
        try {
          for (const combo of combos) keyEvents(combo);
          if (hasTarget(args)) {
            const p = await resolvePoint(tabId, args);
            await mouse(tabId, mouseClickEvents(p.x, p.y));
          }
          await keys(tabId, combos);
          return toToolText({ ok: true, action: "press_keys", keys: combos });
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "drag_drop",
      description:
        "真实鼠标拖拽：从 from 拖到 to，支持原生 HTML5 拖放和滑块/排序类库。from / to 各自用 index、selector、text 或 x,y 指定。",
      parameters: obj(
        {
          tabId: { type: "integer", minimum: 1 },
          from: obj(TARGET_PROPS),
          to: obj(TARGET_PROPS),
        },
        ["from", "to"],
      ),
      async execute(args) {
        if (!hasTarget(args.from) || !hasTarget(args.to)) return "from 和 to 都需要 index、selector、text 或 x,y 之一。";
        const tabId = await prepare(args);
        try {
          const from = await resolvePoint(tabId, args.from);
          const to = await resolvePoint(tabId, args.to);
          await cdp.send(tabId, "Input.setInterceptDrags", { enabled: true });
          try {
            await mouse(tabId, dragMoveEvents(from, to));
            const data = cdp.takeDragData?.(tabId);
            if (data) {
              for (const type of ["dragEnter", "dragOver", "drop"]) {
                await cdp.send(tabId, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data });
              }
            }
            return toToolText({ ok: true, action: "drag_drop", nativeDrag: Boolean(data), from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
          } finally {
            await cdp.send(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
          }
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "upload_file",
      description:
        "给网页上传本机文件。paths 是本机绝对路径（可用 download_file 先下载拿到路径）。目标可以是 <input type=file> 的 selector，也可以是自定义的「上传」按钮（index/selector/text），会自动接管文件选择框。会把本机文件交给网站，只在用户明确要求时用。",
      parameters: obj(
        {
          tabId: { type: "integer", minimum: 1 },
          ...TARGET_PROPS,
          paths: { type: "array", items: { type: "string" }, description: "本机文件的绝对路径" },
        },
        ["paths"],
      ),
      async execute(args) {
        const files = (Array.isArray(args.paths) ? args.paths : []).map(String);
        if (!files.length) return "paths 不能为空。";
        if (files.some((p) => !/^(\/|[A-Za-z]:[\\/]|~\/)/.test(p))) return "paths 必须是绝对路径。";
        if (!hasTarget(args)) return "需要 index、selector 或 text 指出上传控件。";
        const tabId = await prepare(args);
        try {
          if (args.selector && args.index == null) {
            const direct = await cdp.send(tabId, "Runtime.evaluate", {
              expression: `(() => { const el = document.querySelector(${JSON.stringify(String(args.selector))}); return el; })()`,
            });
            const objectId = direct?.result?.objectId;
            if (objectId) {
              const kind = await cdp.send(tabId, "Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: "function(){return this.tagName==='INPUT'&&this.type==='file'}",
                returnByValue: true,
              });
              if (kind?.result?.value) {
                await cdp.send(tabId, "DOM.setFileInputFiles", { files, objectId });
                return toToolText({ ok: true, action: "upload", via: "input", files: files.length });
              }
            }
          }
          await cdp.send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
          try {
            const chooser = cdp.waitFileChooser(tabId);
            chooser.catch(() => {});
            const p = await resolvePoint(tabId, args);
            await mouse(tabId, mouseClickEvents(p.x, p.y));
            const event = await chooser;
            await cdp.send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: event.backendNodeId });
            return toToolText({ ok: true, action: "upload", via: "file_chooser", files: files.length });
          } finally {
            await cdp.send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          }
        } catch (err) {
          return toToolText({ ok: false, error: err?.message || String(err) });
        }
      },
    },
    {
      name: "handle_dialog",
      description:
        "处理页面弹出的 alert / confirm / prompt / beforeunload 对话框。accept=true 确认，false 取消；prompt 可带 promptText。工具返回「页面弹出了对话框」时调用。",
      parameters: obj({
        tabId: { type: "integer", minimum: 1 },
        accept: { type: "boolean", description: "默认 true" },
        promptText: { type: "string" },
      }),
      async execute(args) {
        const tabId = await resolveTabId(args);
        const dialog = cdp.pendingDialog(tabId);
        if (!dialog) return "当前没有待处理的对话框。";
        await cdp.send(tabId, "Page.handleJavaScriptDialog", {
          accept: args.accept !== false,
          ...(args.promptText != null ? { promptText: String(args.promptText) } : {}),
        });
        return toToolText({ ok: true, handled: dialog.type, message: dialog.message, accepted: args.accept !== false });
      },
    },
  ];
}
