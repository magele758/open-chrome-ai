/**
 * 外部 Agent 可直接调用的确定性工具（不经过扩展内 LLM）。
 * 每个工具：{ name, description, parameters, focus, needsTab, exclusive, execute(args, ctx) }
 *   focus: "none" 不碰焦点 | "emulated" 用 Emulation.setFocusEmulationEnabled 模拟焦点（不抢窗口）
 *          | "activates" 会把标签切到前台
 *   exclusive: 进全局串行队列（剪贴板、键鼠输入共享全局状态）
 * ctx: { tab, settings, authorizeTab(tabId), artifacts[], meta }
 */

import { keyEvents, mouseClickEvents } from "../cdp-input.js";
import { htmlToPlainText } from "../clipboard.js";
import { restrictedUrl } from "../chrome.js";
import { cdpScreenshot, createCdpTools } from "../agent/cdp-tools.js";
import { queryDom, runJs } from "../agent/page-fns.js";
import { BridgeError, ERROR_CODES, makeArtifact, toBridgeError } from "./protocol.js";
import { isUrlAllowed } from "./policy.js";
import { plEditor, plReadRenderedHtml, plSelectContents, plSetInputValue, plWaitFor } from "./editor-fns.js";

export const MAX_PASTE_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 500;

function obj(properties, required = []) {
  return { type: "object", properties, additionalProperties: false, required };
}

const TAB_ID = { type: "integer", minimum: 1, description: "目标标签 id（list_tabs 取得）" };
const EDITOR_PROPS = {
  editorSelector: { type: "string", description: "显式指定编辑器 CSS 选择器；省略则自动挑选" },
  domIndex: { type: "integer", description: "沿用 pick_rich_editor 返回的 domIndex" },
  preferPlaceholders: { type: "array", items: { type: "string" }, description: "优先占位文案，默认 [\"从这里开始写正文\"]" },
  excludeSelectors: { type: "array", items: { type: "string" }, description: "排除的编辑器，默认标题编辑器 .title-editor__input / #title" },
  titleSelector: { type: "string", description: "标题元素选择器，默认 #title；传空字符串关闭标题校验" },
};
const EXPECT_PROP = {
  type: "object",
  description: "回读断言：minChars、minTables、minImages、contains[]",
  properties: {
    minChars: { type: "integer" },
    minTables: { type: "integer" },
    minImages: { type: "integer" },
    contains: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

export function editorSpec(args) {
  return {
    selector: args.editorSelector || undefined,
    domIndex: args.domIndex,
    preferPlaceholders: args.preferPlaceholders,
    excludeSelectors: args.excludeSelectors,
    titleSelector: args.titleSelector,
    titleEquals: args.titleEquals,
    titleBefore: args.titleBefore,
    maxTitleLength: args.maxTitleLength,
    expect: args.expect,
    includeHtml: args.includeHtml === true,
  };
}

/** 从 HTML 字符串估计应当粘贴出来的结构（SW 里没有 DOMParser，用正则足够做下限）。 */
export function sourceStats(html) {
  const text = htmlToPlainText(html);
  return {
    chars: text.replace(/\s+/g, "").length,
    tables: (String(html).match(/<table[\s>]/gi) || []).length,
    imgs: (String(html).match(/<img[\s>]/gi) || []).length,
  };
}

export function deriveExpect(html, override) {
  const out = {};
  if (html) {
    const s = sourceStats(html);
    if (s.chars > 0) out.minChars = Math.floor(s.chars * 0.85);
    if (s.tables > 0) out.minTables = s.tables;
    if (s.imgs > 0) out.minImages = s.imgs;
  }
  return { ...out, ...(override || {}) };
}

export function createBridgeTools(env) {
  const sleep = env.sleep;

  async function withBusyRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (toBridgeError(err).code !== ERROR_CODES.DEBUGGER_BUSY) throw err;
      await sleep(BUSY_RETRY_DELAY_MS);
      return fn();
    }
  }

  async function page(tabId, func, args = [], opts) {
    return env.inject(tabId, func, args, opts);
  }

  async function prepareInput(tabId, activate) {
    if (activate) await env.tabs.update(tabId, { active: true });
    try {
      await env.cdp.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (err) {
      if (toBridgeError(err).code === ERROR_CODES.DEBUGGER_BUSY) throw err;
    }
  }

  async function pressCombos(tabId, combos) {
    for (const combo of combos) {
      for (const event of keyEvents(combo)) await env.cdp.send(tabId, "Input.dispatchKeyEvent", event);
    }
  }

  async function clickAt(tabId, point) {
    for (const event of mouseClickEvents(point.x, point.y)) await env.cdp.send(tabId, "Input.dispatchMouseEvent", event);
  }

  const modKey = () => (env.platform() === "mac" ? "Meta" : "Control");

  /** 包装 createCdpTools 里已有的可信输入工具：解析其 JSON 文本结果，失败转结构化错误。 */
  function wrapCdpTool(inner) {
    return {
      name: inner.name,
      description: inner.description,
      parameters: obj(
        {
          ...inner.parameters.properties,
          activate: { type: "boolean", description: "true 则先把标签切到前台（会抢焦点）；默认用模拟焦点" },
        },
        inner.parameters.required,
      ),
      focus: "emulated",
      needsTab: true,
      exclusive: true,
      async execute(args, ctx) {
        const { activate, ...rest } = args;
        const run = async () => {
          await prepareInput(ctx.tab.id, activate === true);
          const text = await inner.execute({ ...rest, tabId: ctx.tab.id });
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new BridgeError(ERROR_CODES.BAD_ARGS, String(text).slice(0, 300));
          }
          if (parsed?.ok === false) throw toBridgeError(new Error(parsed.error || "工具失败"));
          return parsed;
        };
        return withBusyRetry(run);
      },
    };
  }

  const cdpToolDefs = createCdpTools(
    { settings: {} },
    {
      cdp: env.cdp,
      resolveTabId: async (args) => Number(args.tabId),
      attachTabToTask: async () => null,
      getRefItem: () => ({ error: "桥接入口不支持 index 定位；请用 selector / text / x,y。" }),
    },
  );
  const trusted = new Map(cdpToolDefs.map((t) => [t.name, t]));

  const tools = [];
  const add = (def) => tools.push({ focus: "none", needsTab: false, exclusive: false, ...def });

  add({
    name: "list_tabs",
    description: "列出白名单 origin 内的标签（其他标签不可见）。",
    parameters: obj({ query: { type: "string", description: "按标题或 URL 子串过滤" } }),
    async execute(args, ctx) {
      const needle = String(args.query || "").toLowerCase();
      const tabs = await env.tabs.query({});
      return tabs
        .filter((t) => t.url && !restrictedUrl(t.url) && isUrlAllowed(t.url, ctx.settings.agentBridgeOrigins))
        .filter((t) => !needle || `${t.title || ""} ${t.url}`.toLowerCase().includes(needle))
        .map((t) => ({ id: t.id, windowId: t.windowId, active: Boolean(t.active), title: t.title || "", url: t.url }));
    },
  });

  add({
    name: "open_tab",
    description: "新开标签（默认后台，不抢焦点）。URL 必须在 origin 白名单内。",
    parameters: obj(
      { url: { type: "string" }, active: { type: "boolean", description: "true 会切到前台（抢焦点），默认 false" } },
      ["url"],
    ),
    focus: "none",
    async execute(args, ctx) {
      const url = String(args.url || "");
      if (!isUrlAllowed(url, ctx.settings.agentBridgeOrigins)) {
        throw new BridgeError(ERROR_CODES.ORIGIN_NOT_ALLOWED, `URL 不在白名单：${url}`);
      }
      const tab = await env.tabs.create({ url, active: args.active === true });
      return { tabId: tab.id, url: tab.pendingUrl || tab.url || url };
    },
  });

  add({
    name: "activate_tab",
    description: "把标签切到前台。会抢焦点（明示）。",
    parameters: obj({ tabId: TAB_ID }, ["tabId"]),
    focus: "activates",
    needsTab: true,
    async execute(_args, ctx) {
      await env.tabs.update(ctx.tab.id, { active: true });
      return { tabId: ctx.tab.id, active: true };
    },
  });

  add({
    name: "wait_for",
    description: "在页面内轮询等待 selector 出现或文本出现。",
    parameters: obj({
      tabId: TAB_ID,
      selector: { type: "string" },
      text: { type: "string" },
      timeoutMs: { type: "integer", description: "默认 8000，最大 60000" },
    }, ["tabId"]),
    needsTab: true,
    async execute(args, ctx) {
      if (!args.selector && !args.text) throw new BridgeError(ERROR_CODES.BAD_ARGS, "selector 或 text 至少给一个。");
      const res = await page(ctx.tab.id, plWaitFor, [{ selector: args.selector, text: args.text, timeoutMs: args.timeoutMs }]);
      if (!res?.ok) throw new BridgeError(ERROR_CODES.TIMEOUT, res?.error || "等待超时", { details: res });
      return res;
    },
  });

  add({
    name: "query_dom",
    description: "用 CSS 选择器读取 DOM 节点的 tag/文本/href。",
    parameters: obj({ tabId: TAB_ID, selector: { type: "string" }, limit: { type: "integer" } }, ["tabId", "selector"]),
    needsTab: true,
    async execute(args, ctx) {
      return page(ctx.tab.id, queryDom, [String(args.selector), args.limit]);
    },
  });

  add({
    name: "run_js",
    description: "在页面执行 JS（return 结果需 JSON 可序列化）。只在白名单 origin 的标签内可用。",
    parameters: obj({ tabId: TAB_ID, code: { type: "string" } }, ["tabId", "code"]),
    needsTab: true,
    async execute(args, ctx) {
      const res = await env.runJs(ctx.tab.id, runJs, String(args.code));
      if (res?.ok === false) throw new BridgeError(ERROR_CODES.TOOL_FAILED, res.error || "run_js 失败", { details: res });
      return res;
    },
  });

  add({
    name: "read_rendered_html",
    description:
      "读取已渲染元素的 HTML，用 getComputedStyle 把样式内联（解决 cloneContents/innerHTML 丢样式表）。HTML 放在 artifacts[0]，result 只给统计。",
    parameters: obj({
      tabId: TAB_ID,
      selector: { type: "string" },
      removeSelectors: { type: "array", items: { type: "string" } },
      keepClass: { type: "boolean" },
    }, ["tabId", "selector"]),
    needsTab: true,
    async execute(args, ctx) {
      const res = await page(ctx.tab.id, plReadRenderedHtml, [
        { selector: args.selector, removeSelectors: args.removeSelectors, keepClass: args.keepClass },
      ]);
      if (!res?.ok) throw new BridgeError(ERROR_CODES.TOOL_FAILED, res?.error || "读取失败", { details: res });
      ctx.artifacts.push(makeArtifact("rendered.html", "text/html", res.html));
      return { stats: res.stats, artifact: "rendered.html" };
    },
  });

  add({
    name: "screenshot",
    description: "截图（可见区/整页/元素），作为 artifact 返回 base64 JPEG。走调试器，不切标签。",
    parameters: obj({ tabId: TAB_ID, fullPage: { type: "boolean" }, selector: { type: "string" } }, ["tabId"]),
    needsTab: true,
    async execute(args, ctx) {
      const { dataUrl, clip } = await withBusyRetry(() =>
        cdpScreenshot(env.cdp, ctx.tab.id, { fullPage: args.fullPage, selector: args.selector }),
      );
      ctx.artifacts.push(makeArtifact("screenshot.jpg", "image/jpeg", dataUrl.replace(/^data:image\/jpeg;base64,/, ""), "base64"));
      return { artifact: "screenshot.jpg", clip: clip || null };
    },
  });

  add({
    name: "clipboard_write",
    description: "写系统剪贴板 text/html + text/plain（不含图片）。写完请用 paste_rich_trusted 的 useClipboard 粘贴。",
    parameters: obj({ html: { type: "string" }, text: { type: "string" } }),
    exclusive: true,
    async execute(args) {
      const html = String(args.html || "");
      const text = String(args.text || "") || htmlToPlainText(html);
      if (!html && !text) throw new BridgeError(ERROR_CODES.BAD_ARGS, "html 或 text 至少给一个。");
      try {
        return await env.clipboard.write({ html, text });
      } catch (err) {
        throw new BridgeError(ERROR_CODES.CLIPBOARD_FAILED, err?.message || String(err), { details: err?.attempts });
      }
    },
  });

  add({
    name: "set_input_value",
    description: "用原生 value setter 写 input/textarea 并触发 input/change（标题栏用这个；富文本正文不要用）。",
    parameters: obj({ tabId: TAB_ID, selector: { type: "string" }, value: { type: "string" } }, ["tabId", "selector", "value"]),
    needsTab: true,
    async execute(args, ctx) {
      const res = await page(ctx.tab.id, plSetInputValue, [{ selector: args.selector, value: args.value }]);
      if (!res?.ok) throw new BridgeError(ERROR_CODES.TOOL_FAILED, res?.error || "写入失败", { details: res });
      if (!res.matches) throw new BridgeError(ERROR_CODES.VERIFY_FAILED, "写入后回读值不一致（可能被框架截断）", { details: res });
      return res;
    },
  });

  for (const name of ["trusted_click", "trusted_type", "press_keys", "hover"]) {
    const inner = trusted.get(name);
    if (inner) add(wrapCdpTool(inner));
  }

  const pickDef = (name, description) => ({
    name,
    description,
    parameters: obj({ tabId: TAB_ID, ...EDITOR_PROPS }, ["tabId"]),
    needsTab: true,
    async execute(args, ctx) {
      const res = await page(ctx.tab.id, plEditor, ["pick", editorSpec(args)]);
      if (!res?.ok) throw new BridgeError(ERROR_CODES.NO_EDITOR, res?.error || "没有找到编辑器", { details: res });
      return res;
    },
  });
  add(pickDef("pick_rich_editor", "挑选正文富文本编辑器：排除标题编辑器，优先占位文案（默认“从这里开始写正文”），返回 domIndex 与候选打分。"));
  add(pickDef("wechat_pick_body_editor", "pick_rich_editor 的微信公众号别名（默认参数即为微信）。"));

  add({
    name: "verify_editor_content",
    description: "回读校验编辑器：字数/table/img 数量、标题是否被污染、必含文本。ok=false 时 checks 列出失败项。",
    parameters: obj(
      {
        tabId: TAB_ID,
        ...EDITOR_PROPS,
        expect: EXPECT_PROP,
        titleEquals: { type: "string" },
        titleBefore: { type: "string" },
        maxTitleLength: { type: "integer" },
        includeHtml: { type: "boolean", description: "把编辑器 innerHTML 作为 artifact 返回" },
      },
      ["tabId"],
    ),
    needsTab: true,
    async execute(args, ctx) {
      const res = await page(ctx.tab.id, plEditor, ["verify", editorSpec(args)]);
      if (res?.code === "NO_EDITOR") throw new BridgeError(ERROR_CODES.NO_EDITOR, res.error, { details: res });
      if (res?.html) {
        ctx.artifacts.push(makeArtifact("editor.html", "text/html", res.html));
        delete res.html;
      }
      return res;
    },
  });

  add({
    name: "copy_selection_trusted",
    description:
      "选中某元素全部内容并用可信 Meta/Ctrl+C 复制（Chrome 自己序列化，带内联样式）。随后在编辑器页用 paste_rich_trusted {useClipboard:true} 粘贴。",
    parameters: obj(
      { tabId: TAB_ID, selector: { type: "string" }, activate: { type: "boolean" } },
      ["tabId", "selector"],
    ),
    focus: "emulated",
    needsTab: true,
    exclusive: true,
    async execute(args, ctx) {
      const tabId = ctx.tab.id;
      return withBusyRetry(async () => {
        await prepareInput(tabId, args.activate === true);
        const sel = await page(tabId, plSelectContents, [{ selector: args.selector }]);
        if (!sel?.ok) throw new BridgeError(ERROR_CODES.TOOL_FAILED, sel?.error || "选取失败（选区为空）", { details: sel });
        await pressCombos(tabId, [`${modKey()}+C`]);
        await sleep(150);
        return { selected: sel, copied: true };
      });
    },
  });

  add({
    name: "paste_rich_trusted",
    description:
      "写富文本剪贴板 → 聚焦编辑器 → 可信 Meta/Ctrl+V → 回读校验 → 失败重试（默认最多 2 次重试）。不使用 DataTransfer / innerHTML 兜底；仍失败返回 VERIFY_FAILED。内容来源：html / text / source{tabId,selector} / useClipboard。",
    parameters: obj(
      {
        tabId: TAB_ID,
        html: { type: "string" },
        text: { type: "string" },
        source: obj({ tabId: TAB_ID, selector: { type: "string" }, removeSelectors: { type: "array", items: { type: "string" } } }, ["selector"]),
        useClipboard: { type: "boolean", description: "沿用剪贴板现有内容（例如 copy_selection_trusted 之后）" },
        ...EDITOR_PROPS,
        expect: EXPECT_PROP,
        titleEquals: { type: "string" },
        titleBefore: { type: "string" },
        maxTitleLength: { type: "integer" },
        replace: { type: "boolean", description: "粘贴前先全选并删除编辑器内容（重试幂等、避免旧内容让校验假通过），默认 true" },
        retries: { type: "integer", minimum: 0, maximum: MAX_PASTE_RETRIES },
        settleMs: { type: "integer", description: "粘贴后等待编辑器稳定的最长毫秒，默认 1500" },
        activate: { type: "boolean", description: "true 则切到前台（抢焦点），默认模拟焦点" },
        includeHtml: { type: "boolean" },
      },
      ["tabId"],
    ),
    focus: "emulated",
    needsTab: true,
    exclusive: true,
    async execute(args, ctx) {
      const tabId = ctx.tab.id;
      let html = String(args.html || "");
      let text = String(args.text || "");
      let sourceInfo = null;
      if (args.source) {
        const srcTabId = args.source.tabId != null ? Number(args.source.tabId) : tabId;
        const srcTab = srcTabId === tabId ? ctx.tab : await ctx.authorizeTab(srcTabId);
        const res = await page(srcTab.id, plReadRenderedHtml, [
          { selector: args.source.selector, removeSelectors: args.source.removeSelectors },
        ]);
        if (!res?.ok) throw new BridgeError(ERROR_CODES.TOOL_FAILED, `读取来源失败：${res?.error || "未知"}`, { details: res });
        html = res.html;
        sourceInfo = { tabId: srcTab.id, selector: args.source.selector, stats: res.stats };
      }
      if (!html && !text && args.useClipboard !== true) {
        throw new BridgeError(ERROR_CODES.BAD_ARGS, "需要 html / text / source / useClipboard 之一。");
      }
      if (html && !text) text = htmlToPlainText(html);

      const retries = Math.min(Math.max(Number.isInteger(args.retries) ? args.retries : 2, 0), MAX_PASTE_RETRIES);
      const settleMs = Math.min(Math.max(Number(args.settleMs) || 1500, 0), 10000);
      const expect = deriveExpect(html, args.expect);
      const baseSpec = editorSpec({ ...args, expect });

      const picked = await page(tabId, plEditor, ["pick", baseSpec]);
      if (!picked?.ok) throw new BridgeError(ERROR_CODES.NO_EDITOR, picked?.error || "没有找到编辑器", { details: picked });
      const pinned = { ...baseSpec, selector: baseSpec.selector, domIndex: picked.domIndex };

      const before = await page(tabId, plEditor, ["verify", { ...pinned, expect: undefined }]);
      const titleBefore = args.titleBefore != null ? args.titleBefore : before?.title ?? undefined;
      const verifySpec = { ...pinned, expect, titleBefore };

      const attempts = [];
      let clipboard = null;
      let last = null;
      for (let n = 0; n <= retries; n += 1) {
        const attempt = { n: n + 1 };
        try {
          if (html || text) {
            try {
              clipboard = await env.clipboard.write({ html, text });
            } catch (err) {
              throw new BridgeError(ERROR_CODES.CLIPBOARD_FAILED, err?.message || String(err), { details: err?.attempts });
            }
            attempt.clipboard = clipboard.via;
          }
          await withBusyRetry(async () => {
            await prepareInput(tabId, args.activate === true);
            const prep = await page(tabId, plEditor, ["prepare", pinned]);
            if (!prep?.ok || !prep.point) {
              throw new BridgeError(ERROR_CODES.NO_EDITOR, prep?.error || "无法聚焦编辑器", { details: prep });
            }
            await clickAt(tabId, prep.point);
            if (args.replace !== false) await pressCombos(tabId, [`${modKey()}+A`, "Backspace"]);
            await pressCombos(tabId, [`${modKey()}+V`]);
          });
          const started = Date.now();
          do {
            await sleep(200);
            last = await page(tabId, plEditor, ["verify", verifySpec]);
          } while (!last?.ok && Date.now() - started < settleMs);
          attempt.ok = Boolean(last?.ok);
          attempt.stats = last?.stats;
          if (!last?.ok) attempt.failed = (last?.checks || []).filter((c) => !c.ok);
        } catch (err) {
          const be = toBridgeError(err);
          if (be.code === ERROR_CODES.NO_EDITOR || be.code === ERROR_CODES.CLIPBOARD_FAILED || be.code === ERROR_CODES.DEBUGGER_BUSY) {
            attempt.ok = false;
            attempt.error = { code: be.code, message: be.message };
            attempts.push(attempt);
            if (n === retries) throw new BridgeError(be.code, be.message, { details: { attempts }, retryable: be.retryable });
            await sleep(400);
            continue;
          }
          throw err;
        }
        attempts.push(attempt);
        if (last?.ok) {
          if (args.includeHtml) {
            const full = await page(tabId, plEditor, ["verify", { ...verifySpec, includeHtml: true }]);
            if (full?.html) ctx.artifacts.push(makeArtifact("editor.html", "text/html", full.html));
          }
          return {
            method: "trusted_paste",
            attempts,
            verify: last,
            editor: { ...picked, candidates: undefined },
            source: sourceInfo,
            clipboard,
            focus: args.activate === true ? "activated" : "emulated",
          };
        }
        if (n < retries) await sleep(400);
      }
      throw new BridgeError(ERROR_CODES.VERIFY_FAILED, `可信粘贴后回读校验失败（已尝试 ${attempts.length} 次，已停止）`, {
        details: { attempts, verify: last, editor: { ...picked, candidates: undefined } },
        hint: "不要改用 innerHTML / 合成 paste 事件；检查编辑器是否选对、页面是否有未处理的弹窗，或由人工在页面里粘贴确认。",
      });
    },
  });

  return tools;
}
