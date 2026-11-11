/**
 * 确定性工作流执行器（浏览器侧纯 ES2022 模块，零 LLM 回合、零站点硬编码）。
 *
 * 设计要点：
 * 1. 只接受显式 `/workflow <JSON>` 指令（支持可选 ```json 代码围栏），schemaVersion 必须为 "1.0"。
 * 2. 100% 复用已收敛底层原语（select_option / fill / click / trusted_click / wait_for / scroll_page / run_js / screenshot），
 *    不在 runner 内重复造组件交互轮子。
 * 3. 所有写入型动作坚持「先实读幂等判断 → 不一致才执行 → 执行后立即回读校验」。
 * 4. 严格 `on_fail: "stop"`：任何一步失败立即中止后续步骤，自动补拍失败现场截图，
 *    产出固定 5 字段（失败步号 / 期望状态原文 / 页面实读原文 / 截图路径 / 失败归属）。
 */

import { matchIrreversible } from "./trust/irreversible.js";

export const WORKFLOW_MODEL_ID = "deterministic-workflow";
export const WORKFLOW_SCHEMA_VERSION = "1.0";

const UNTRUSTED_TAG_RE = /^<untrusted_page(?:\s+source="[^"]*")?>\r?\n?([\s\S]*?)\r?\n?<\/untrusted_page>$/i;
const PLACEHOLDER_EXACT_RE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;
const PLACEHOLDER_GLOBAL_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const FILE_CHOOSER_ERR_RE = /文件上传控件|文件选择框|file\s*chooser|blockedFileChooser/i;
const EXTERNAL_CHALLENGE_RE =
  /(?:请完成安全验证|拖动下方滑块|滑块验证|人脸识别验证|短信验证登录|登录已过期[，,\s]*请重新登录|会话已过期[，,\s]*请重新登录|账号已被限制|访问受限|访问过于频繁)/i;
const GATEWAY_ERR_RE =
  /\b(?:502\s+Bad\s+Gateway|503\s+Service\s+Temporarily\s+Unavailable|504\s+Gateway\s+Time-?out)\b/i;
const LOGIN_PATH_RE = /\/(?:login|signin|passport|sso)(?:[/?#]|$)/i;

export class WorkflowError extends Error {
  constructor({
    message,
    code = "WORKFLOW_STEP_FAILED",
    blame = "workflow",
    expected = "",
    actual = "",
    stepIndex = 0,
    stepId = "",
    op = "",
  } = {}) {
    super(String(message || code));
    this.name = "WorkflowError";
    this.code = String(code);
    this.blame = blame === "工具" || blame === "其他" ? blame : "workflow";
    this.expected = String(expected || "");
    this.actual = String(actual || "");
    this.stepIndex = Number(stepIndex) || 0;
    this.stepId = String(stepId || "");
    this.op = String(op || "");
  }
}

export function normalizeSpaces(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeCjkText(value) {
  return normalizeSpaces(value).replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
}

export function isWorkflowDirectiveText(rawText) {
  return /^\s*\/workflow(?:\s|$)/i.test(String(rawText ?? ""));
}

export function parseWorkflowDirective(rawText) {
  const raw = String(rawText ?? "");
  if (!isWorkflowDirectiveText(raw)) return null;

  let body = raw.replace(/^\s*\/workflow\b/i, "").trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(body);
  if (fenced) body = fenced[1].trim();

  if (!body) {
    throw new WorkflowError({
      code: "WORKFLOW_EMPTY_BODY",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "/workflow 后紧跟 schemaVersion=1.0 的 JSON 定义",
      actual: "指令正文为空",
      message: "工作流指令正文为空",
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_JSON",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "合法 JSON 对象",
      actual: `JSON 解析失败: ${err?.message || String(err)}`,
      message: `工作流 JSON 解析失败: ${err?.message || String(err)}`,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_ROOT",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "顶层为 JSON 对象",
      actual: typeof parsed,
      message: "工作流顶层必须为 JSON 对象",
    });
  }

  if (parsed.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowError({
      code: "WORKFLOW_UNSUPPORTED_SCHEMA",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: `schemaVersion === "${WORKFLOW_SCHEMA_VERSION}"`,
      actual: `schemaVersion === ${JSON.stringify(parsed.schemaVersion)}`,
      message: `不支持的 schemaVersion: ${String(parsed.schemaVersion)}`,
    });
  }

  const id = String(parsed.id || "").trim();
  if (!id) {
    throw new WorkflowError({
      code: "WORKFLOW_MISSING_ID",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "非空字符串 id",
      actual: JSON.stringify(parsed.id),
      message: "工作流缺少非空 id",
    });
  }

  const binds = parsed.binds == null ? {} : parsed.binds;
  if (typeof binds !== "object" || Array.isArray(binds)) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_BINDS",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "binds 为键值对象",
      actual: Array.isArray(binds) ? "array" : typeof binds,
      message: "工作流 binds 必须为对象",
    });
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new WorkflowError({
      code: "WORKFLOW_EMPTY_STEPS",
      blame: "workflow",
      stepIndex: 0,
      stepId: "workflow.parse",
      op: "parse",
      expected: "非空 steps 数组",
      actual: JSON.stringify(parsed.steps),
      message: "工作流 steps 必须为非空数组",
    });
  }

  const steps = parsed.steps.map((rawStep, idx) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      throw new WorkflowError({
        code: "WORKFLOW_INVALID_STEP",
        blame: "workflow",
        stepIndex: idx + 1,
        stepId: `step_${idx + 1}`,
        op: "parse",
        expected: "步骤为对象 { id, op, params }",
        actual: JSON.stringify(rawStep),
        message: `第 ${idx + 1} 步定义非法`,
      });
    }
    const stepId = String(rawStep.id || `step_${idx + 1}`).trim();
    const op = String(rawStep.op || "").trim();
    if (!op) {
      throw new WorkflowError({
        code: "WORKFLOW_MISSING_OP",
        blame: "workflow",
        stepIndex: idx + 1,
        stepId,
        op: "parse",
        expected: "非空步骤原语 op",
        actual: JSON.stringify(rawStep.op),
        message: `步骤 ${stepId} 缺少 op`,
      });
    }
    return {
      id: stepId,
      op,
      description: rawStep.description ? String(rawStep.description) : "",
      when: rawStep.when,
      screenshot: Boolean(rawStep.screenshot),
      params: rawStep.params && typeof rawStep.params === "object" ? rawStep.params : {},
    };
  });

  const forbidClickTexts = Array.isArray(parsed.forbidClickTexts)
    ? parsed.forbidClickTexts.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const forbidUrlSubstrings = Array.isArray(parsed.forbidUrlSubstrings)
    ? parsed.forbidUrlSubstrings.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: parsed.name ? String(parsed.name) : id,
    binds,
    steps,
    forbidClickTexts,
    forbidUrlSubstrings,
  };
}

export function lookupBindValue(binds, keyPath) {
  const pathStr = String(keyPath || "").trim();
  if (!pathStr || !binds || typeof binds !== "object") return { found: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(binds, pathStr) && binds[pathStr] !== undefined) {
    return { found: true, value: binds[pathStr] };
  }
  const parts = pathStr.split(".");
  let cur = binds;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return { found: false, value: undefined };
    }
    cur = cur[part];
  }
  if (cur === undefined) return { found: false, value: undefined };
  return { found: true, value: cur };
}

export function interpolateParams(node, binds = {}, stepCtx = {}) {
  if (node == null || typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node === "string") {
    const exact = PLACEHOLDER_EXACT_RE.exec(node);
    if (exact) {
      const hit = lookupBindValue(binds, exact[1]);
      if (!hit.found) {
        throw new WorkflowError({
          code: "WORKFLOW_BIND_MISSING",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex || 0,
          stepId: stepCtx.stepId || "",
          op: stepCtx.op || "",
          expected: `binds 中存在非空参数 "${exact[1]}"`,
          actual: `未定义占位符 "{{${exact[1]}}}"`,
          message: `未定义的工作流参数占位符: {{${exact[1]}}}`,
        });
      }
      return hit.value;
    }
    if (!node.includes("{{")) return node;
    return node.replace(PLACEHOLDER_GLOBAL_RE, (_m, key) => {
      const hit = lookupBindValue(binds, key);
      if (!hit.found || hit.value == null) {
        throw new WorkflowError({
          code: "WORKFLOW_BIND_MISSING",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex || 0,
          stepId: stepCtx.stepId || "",
          op: stepCtx.op || "",
          expected: `binds 中存在非空字符串/数值参数 "${key}"`,
          actual: `未定义占位符 "{{${key}}}"`,
          message: `未定义的工作流参数占位符: {{${key}}}`,
        });
      }
      if (typeof hit.value === "object") {
        return JSON.stringify(hit.value);
      }
      return String(hit.value);
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => interpolateParams(item, binds, stepCtx));
  }
  if (typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = interpolateParams(v, binds, stepCtx);
    }
    return out;
  }
  return node;
}

export function evaluateWhenPredicate(whenExpr, binds = {}, stepCtx = {}) {
  if (whenExpr === undefined || whenExpr === null || whenExpr === "") return true;
  if (typeof whenExpr === "boolean") return whenExpr;
  if (typeof whenExpr !== "string") {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_WHEN",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: "when 为布尔值或静态绑定布尔键名（如 \"flag\" 或 \"!flag\"）",
      actual: JSON.stringify(whenExpr),
      message: "不支持动态表达式类型的 when 条件",
    });
  }
  const trimmed = whenExpr.trim();
  const negated = trimmed.startsWith("!");
  const key = (negated ? trimmed.slice(1) : trimmed).trim();
  if (!key || /[^A-Za-z0-9_.-]/.test(key)) {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_WHEN",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: "静态布尔参数键名（仅允许字母数字下划线点号）",
      actual: whenExpr,
      message: `非法的 when 静态布尔键: ${whenExpr}`,
    });
  }
  const hit = lookupBindValue(binds, key);
  if (!hit.found || typeof hit.value !== "boolean") {
    throw new WorkflowError({
      code: "WORKFLOW_WHEN_BIND_INVALID",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: `binds.${key} 为明确布尔值 (true/false)`,
      actual: hit.found ? `${typeof hit.value}: ${JSON.stringify(hit.value)}` : "未定义",
      message: `when 条件引用的静态布尔键未定义或非布尔值: ${key}`,
    });
  }
  return negated ? !hit.value : hit.value;
}

export function detectExternalBlocker({ url = "", title = "", text = "" } = {}) {
  const u = String(url || "");
  let pathname = "";
  try {
    pathname = new URL(u).pathname || "";
  } catch {
    pathname = u;
  }
  if (LOGIN_PATH_RE.test(pathname)) {
    return `检测到登录重定向 URL: ${u}`;
  }
  const sample = `${String(title || "")}\n${String(text || "").slice(0, 2000)}`;
  const gw = GATEWAY_ERR_RE.exec(sample);
  if (gw) {
    return `检测到网关异常页面: ${gw[0]}`;
  }
  const ch = EXTERNAL_CHALLENGE_RE.exec(sample);
  if (ch) {
    return `检测到外部验证或会话失效阻断: ${ch[0]}`;
  }
  return null;
}

function unwrapToolString(raw) {
  const str = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const m = UNTRUSTED_TAG_RE.exec(str.trim());
  return (m ? m[1] : str).trim();
}

function parseToolOutput(raw) {
  const text = unwrapToolString(raw);
  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: null, text };
  }
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const err = new Error("Workflow aborted");
    err.name = "AbortError";
    throw err;
  }
}

function sleepWithAbort(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      const err = new Error("Workflow aborted");
      err.name = "AbortError";
      reject(err);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertUrlNotForbidden(url, forbidUrlSubstrings, stepCtx) {
  const u = String(url || "");
  if (!u || !Array.isArray(forbidUrlSubstrings) || !forbidUrlSubstrings.length) return;
  const lower = u.toLowerCase();
  for (const sub of forbidUrlSubstrings) {
    const s = String(sub || "").trim().toLowerCase();
    if (s && lower.includes(s)) {
      throw new WorkflowError({
        code: "WORKFLOW_FORBIDDEN_URL",
        blame: "workflow",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: `页面 URL 不包含禁止子串 "${sub}"`,
        actual: `当前 URL: ${u}`,
        message: `触发禁止访问域名/路径拦截: ${sub}`,
      });
    }
  }
}

function assertClickTargetSafe({
  labelText = "",
  domElementText = "",
  forbidClickTexts = [],
  settings = {},
  targetUrl = "",
  stepCtx = {},
}) {
  const candidates = [labelText, domElementText]
    .map((s) => normalizeCjkText(s))
    .filter(Boolean);

  for (const rawForbid of forbidClickTexts) {
    const normForbid = normalizeCjkText(rawForbid);
    if (!normForbid) continue;
    for (const cand of candidates) {
      if (cand === normForbid || cand.includes(normForbid)) {
        throw new WorkflowError({
          code: "WORKFLOW_FORBIDDEN_CLICK",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: `禁止点击匹配 "${rawForbid}" 的控件`,
          actual: `尝试点击控件文本: "${domElementText || labelText}"`,
          message: `命中工作流禁点红线: "${rawForbid}"`,
        });
      }
    }
  }

  const irr = matchIrreversible(
    "click",
    { text: String(labelText || "") },
    settings,
    { elementText: String(domElementText || ""), targetUrl: String(targetUrl || "") },
  );
  if (irr) {
    throw new WorkflowError({
      code: "WORKFLOW_IRREVERSIBLE_BLOCKED",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex,
      stepId: stepCtx.stepId,
      op: stepCtx.op,
      expected: "确定性工作流仅允许执行非不可逆动作",
      actual: `命中不可逆动作守卫 [${irr.id}]: ${irr.reason}`,
      message: `命中不可逆动作拦截 (${irr.id}): ${irr.reason}`,
    });
  }
}

function summarizeStepArgs(stepId, params = {}) {
  const out = { stepId };
  for (const [k, v] of Object.entries(params || {})) {
    if (k === "checks" && Array.isArray(v)) {
      out.checkCount = v.length;
      out.checkKinds = v.map((c) => c?.kind || "unknown").slice(0, 16);
      continue;
    }
    if (k === "rules" && Array.isArray(v)) {
      out.ruleCount = v.length;
      continue;
    }
    if (typeof v === "string" && v.length > 180) {
      out[k] = `${v.slice(0, 177)}...`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

const ASSERT_KIND_SNIPPETS = Object.freeze({
  modals_count: `const ms=visibleModals(),titles=ms.map(m=>norm((m.querySelector(".ant-modal-title")||{}).innerText));
if(ms.length!==Number(c.equals))return{pass:false,index:idx,kind:c.kind,expected:"可见弹窗数 === "+c.equals,actual:"实读弹窗数 === "+ms.length+" ("+JSON.stringify(titles)+")"};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{count:ms.length,titles}});`,

  select_items_include: `const items=[...scope.querySelectorAll(".ant-select-selection-item")].map(itemText).filter(Boolean);
const missing=(c.mustInclude||[]).filter(w=>!items.includes(String(w)));
if(missing.length)return{pass:false,index:idx,kind:c.kind,expected:"已选下拉项包含 "+JSON.stringify(c.mustInclude),actual:"缺少 "+JSON.stringify(missing)+"；当前已选: "+JSON.stringify(items.slice(0,20))};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:items});`,

  checked_checkboxes_equal: `const ignore=new Set((c.ignoreLabels||["全选"]).map(norm));
const checked=[...scope.querySelectorAll('input[type="checkbox"]')].filter(cb=>cb.checked).map(cb=>{const l=cb.closest("label");return l?norm(l.innerText):"";}).filter(t=>t&&!ignore.has(t));
const want=(c.equals||[]).map(String);
if(JSON.stringify(checked)!==JSON.stringify(want))return{pass:false,index:idx,kind:c.kind,expected:"已勾选复选框 === "+JSON.stringify(want),actual:"实读已勾选 === "+JSON.stringify(checked)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:checked});`,

  cascader_or_select_equals: `const inp=scope.querySelector(c.inputSelector)||document.querySelector(c.inputSelector);
const sel=inp?inp.closest(".ant-select"):null,it=sel?sel.querySelector(".ant-select-selection-item"):null,got=it?itemText(it):"";
if(got!==String(c.equals))return{pass:false,index:idx,kind:c.kind,expected:c.inputSelector+" 选中值 === "+JSON.stringify(c.equals),actual:"实读选中值 === "+JSON.stringify(got)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:got});`,

  input_equals: `const nth=Number(c.nth)||0,el=scope.querySelectorAll(c.selector)[nth]||document.querySelectorAll(c.selector)[nth],got=el?String(el.value??""):null;
if(got!==String(c.equals))return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 值 === "+JSON.stringify(c.equals),actual:"实读值 === "+JSON.stringify(got)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:got});`,

  inputs_by_placeholder_equal: `const list=[...scope.querySelectorAll("input")].filter(inp=>inp.getAttribute("placeholder")===String(c.placeholder)).map(inp=>String(inp.value??""));
if(c.allEqual!==undefined){const w=String(c.allEqual),m=Number(c.minCount??1);if(list.length<m||list.some(v=>v!==w))return{pass:false,index:idx,kind:c.kind,expected:'placeholder="'+c.placeholder+'" 至少 '+m+" 项且全部 === "+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
else{const w=(c.equals||[]).map(String);if(JSON.stringify(list)!==JSON.stringify(w))return{pass:false,index:idx,kind:c.kind,expected:'placeholder="'+c.placeholder+'" 输入值序列 === '+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
evidence.push({index:idx,id:checkId,kind:c.kind,placeholder:c.placeholder,actual:list});`,

  text_matches_regex: `const full=norm(scope.innerText||""),m=new RegExp(String(c.pattern),c.flags||"").exec(full);
if(!m)return{pass:false,index:idx,kind:c.kind,expected:"文本匹配正则 /"+c.pattern+"/"+(c.flags||""),actual:"实读片段: "+JSON.stringify(full.slice(0,260))};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:m[0]});`,

  select_sequence_equals: `const list=[...scope.querySelectorAll(c.selector)].map(s=>{const it=s.querySelector(".ant-select-selection-item");return it?itemText(it):"";});
if(Array.isArray(c.repeatPattern)&&c.repeatPattern.length>0){const p=c.repeatPattern.map(String),okR=list.length>=p.length&&list.length%p.length===0&&list.every((v,k)=>v===p[k%p.length]);if(!okR)return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 选中序列按周期重复 "+JSON.stringify(p),actual:"实读序列 === "+JSON.stringify(list)};}
else{const w=(c.equals||[]).map(String);if(JSON.stringify(list)!==JSON.stringify(w))return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 选中序列 === "+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
evidence.push({index:idx,id:checkId,kind:c.kind,actual:list});`,

  radio_checked_equals: `const checked=[...scope.querySelectorAll('input[type="radio"]')].filter(r=>r.checked).map(r=>{const l=r.closest("label");return l?normBtn(l.innerText):"";}).filter(Boolean);
if(!checked.includes(normBtn(c.equals)))return{pass:false,index:idx,kind:c.kind,expected:(c.scopeSelector||"scope")+" 选中单选 === "+JSON.stringify(c.equals),actual:"实读选中 === "+JSON.stringify(checked)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:checked});`,

  field_blocks_match: `const fSel=c.fieldSelector||".ant-form-item",lSel=c.labelSelector||".ant-form-item-label, label";
const blocks=[...scope.querySelectorAll(fSel)].map(b=>({label:norm((b.querySelector(lSel)||{}).innerText),items:[...b.querySelectorAll(".ant-select-selection-item")].map(itemText).filter(Boolean),inputs:[...b.querySelectorAll("input")].filter(x=>x.type!=="search"&&x.type!=="checkbox"&&x.type!=="radio").map(x=>String(x.value??"")).filter(v=>v!=="")}));
for(const exp of c.expectedFields||[]){const hit=blocks.find(b=>b.label.includes(String(exp.labelIncludes)));if(!hit)return{pass:false,index:idx,kind:c.kind,expected:"存在属性块包含 "+JSON.stringify(exp.labelIncludes),actual:"当前属性块标签: "+JSON.stringify(blocks.map(b=>b.label))};if(exp.items&&JSON.stringify(hit.items)!==JSON.stringify(exp.items))return{pass:false,index:idx,kind:c.kind,expected:hit.label+" 已选项 === "+JSON.stringify(exp.items),actual:"实读已选项 === "+JSON.stringify(hit.items)};if(exp.inputs&&JSON.stringify(hit.inputs)!==JSON.stringify(exp.inputs))return{pass:false,index:idx,kind:c.kind,expected:hit.label+" 输入值 === "+JSON.stringify(exp.inputs),actual:"实读输入值 === "+JSON.stringify(hit.inputs)};}
evidence.push({index:idx,id:checkId,kind:c.kind,actual:blocks});`,

  text_includes: `const full=norm(scope.innerText||""),missing=(c.mustInclude||[]).filter(sub=>!full.includes(norm(sub)));
if(missing.length)return{pass:false,index:idx,kind:c.kind,expected:"文本包含 "+JSON.stringify(c.mustInclude),actual:"缺少 "+JSON.stringify(missing)+"；实读片段: "+JSON.stringify(full.slice(0,260))};
const snippets=(c.mustInclude||[]).map(sub=>{const n=norm(sub),p=full.indexOf(n);return p>=0?full.slice(Math.max(0,p-16),p+n.length+64):"";});
evidence.push({index:idx,id:checkId,kind:c.kind,actual:snippets});`,

  text_excludes: `const full=norm(scope.innerText||""),found=(c.forbid||[]).find(sub=>sub&&full.includes(norm(sub)));
if(found)return{pass:false,index:idx,kind:c.kind,expected:"文本不包含 "+JSON.stringify(c.forbid),actual:"命中禁止文本: "+JSON.stringify(found)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{excludedAll:c.forbid||[],sample:full.slice(0,180)}});`,

  images_min_count: `const imgs=[...scope.querySelectorAll(c.selector||"img")].filter(img=>{const s=String(img.getAttribute("src")||img.src||"").trim();return Boolean(s)&&!s.startsWith("data:image/svg+xml");});
const min=Number(c.minCount??1);
if(imgs.length<min)return{pass:false,index:idx,kind:c.kind,expected:(c.selector||"img")+" 有效图片数 >= "+min,actual:"实读有效图片数 === "+imgs.length};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{count:imgs.length,samples:imgs.slice(0,4).map(img=>({alt:img.alt||"",w:img.naturalWidth||0,h:img.naturalHeight||0}))}});`,

  row_state: `const rows=[...scope.querySelectorAll(c.rowSelector||"tr")].filter(r=>{const rc=r.getBoundingClientRect();return rc.width>0&&rc.height>0;});
const allK=c.mustIncludeAll||[],exK=c.excludeSubstrings||[];
const matched=rows.filter(r=>{const t=norm(r.innerText);return allK.every(k=>t.includes(String(k)))&&!exK.some(ex=>ex&&t.includes(String(ex)));});
const wantC=Number(c.expectedCount??1);
if(matched.length!==wantC)return{pass:false,index:idx,kind:c.kind,expected:"匹配行数 === "+wantC+" ("+JSON.stringify(allK)+")",actual:"实读匹配行数 === "+matched.length};
const btns=matched[0]?[...matched[0].querySelectorAll("button")].map(b=>({text:normBtn(b.innerText),enabled:!b.disabled&&b.getBoundingClientRect().width>0})):[];
if(wantC===1&&Array.isArray(c.mustHaveEnabledButtons)){for(const wb of c.mustHaveEnabledButtons){if(!btns.find(b=>b.text===normBtn(wb)&&b.enabled))return{pass:false,index:idx,kind:c.kind,expected:"行内按钮可见且可用（未点击）: "+wb,actual:"实读行内按钮: "+JSON.stringify(btns)};}}
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{rowCount:matched.length,rowText:matched[0]?norm(matched[0].innerText).slice(0,500):null,buttons:btns}});`,
});

function buildSingleAssertScript(containerSelector, subChecks, baseIndex = 0) {
  const kinds = [...new Set(subChecks.map((c) => String(c?.kind || "")))];
  const branches = kinds
    .map((k, bi) => {
      const body = ASSERT_KIND_SNIPPETS[k];
      const cond = `${bi === 0 ? "if" : "else if"}(c.kind===${JSON.stringify(k)})`;
      if (!body) {
        return `${cond}{return{pass:false,index:idx,kind:c.kind,expected:"已知断言类型",actual:"未知 check.kind: "+c.kind};}`;
      }
      return `${cond}{${body}}`;
    })
    .join("\n");
  const fallback = kinds.length
    ? `else{return{pass:false,index:idx,kind:c.kind,expected:"已知断言类型",actual:"未知 check.kind: "+c.kind};}`
    : "";

  return `const containerSel=${JSON.stringify(containerSelector)};
const checks=${JSON.stringify(subChecks)};
const baseIdx=${Number(baseIndex) || 0};
const norm=s=>String(s||"").replace(/\\s+/g," ").trim();
const normBtn=s=>norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g,"$1");
const visibleModals=()=>[...document.querySelectorAll(".ant-modal")].filter(m=>{const w=m.closest(".ant-modal-wrap")||m.parentElement,ws=w?getComputedStyle(w):getComputedStyle(m),r=m.getBoundingClientRect();if(ws.display==="none"||ws.visibility==="hidden")return false;if((w&&/leave/.test(w.className||""))||/leave/.test(m.className||""))return false;return r.width>0&&r.height>0;});
const defaultScope=containerSel?document.querySelector(containerSel):document;
if(containerSel&&!defaultScope)return{pass:false,failedCheck:"container",expected:"容器存在: "+containerSel,actual:"容器不存在"};
const pickScope=c=>c.topmostModal?(visibleModals().slice(-1)[0]||null):(c.scopeSelector?document.querySelector(c.scopeSelector):defaultScope);
const itemText=el=>((el.querySelector(".ant-select-selection-item-content")||el).textContent||"").replace(/\\s+/g," ").trim();
const evidence=[];
for(let i=0;i<checks.length;i+=1){
const c=checks[i]||{},idx=baseIdx+i,checkId=c.id?String(c.id):(c.kind+"_"+idx),scope=pickScope(c);
if(!scope&&c.kind!=="modals_count")return{pass:false,index:idx,kind:c.kind,expected:"作用域存在: "+(c.scopeSelector||"topmostModal"),actual:"作用域不存在"};
${branches}
${fallback}
}
return{pass:true,checkedCount:checks.length,evidence};`;
}

export function buildAssertStateBatches(containerSelector, checks = [], maxCodeLen = 6000) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return [{ baseIndex: 0, count: 0, code: buildSingleAssertScript(containerSelector, [], 0) }];
  }
  const batches = [];
  let start = 0;
  while (start < checks.length) {
    let end = start + 1;
    let bestCode = buildSingleAssertScript(containerSelector, checks.slice(start, end), start);
    while (end < checks.length) {
      const candidate = buildSingleAssertScript(containerSelector, checks.slice(start, end + 1), start);
      if (candidate.length > maxCodeLen) break;
      bestCode = candidate;
      end += 1;
    }
    batches.push({ baseIndex: start, count: end - start, code: bestCode });
    start = end;
  }
  return batches;
}

export function formatWorkflowSummary({
  ok,
  aborted = false,
  workflowId = "",
  totalSteps = 0,
  executedSteps = 0,
  skippedSteps = 0,
  durationMs = 0,
  failure = null,
  allShotPaths = [],
  lastShotPath = "",
} = {}) {
  if (aborted) {
    return `已停止确定性工作流 \`${workflowId || "workflow"}\`（已完成 ${executedSteps}/${totalSteps} 步）。`;
  }
  if (!ok && failure) {
    const shot = failure.shotPath || lastShotPath || "无（截图未生成）";
    return [
      `❌ 确定性工作流执行失败（\`${workflowId || "workflow"}\`）`,
      `- 失败步号: 第 ${failure.stepIndex} 步 (${failure.stepId} · ${failure.op})`,
      `- 期望状态原文: ${failure.expected || "步骤断言通过"}`,
      `- 页面实读原文: ${failure.actual || failure.message || "未知异常"}`,
      `- 截图路径: ${shot}`,
      `- 失败归属: ${failure.blame || "workflow"}`,
    ].join("\n");
  }
  const shotsText =
    Array.isArray(allShotPaths) && allShotPaths.length > 0
      ? allShotPaths.join(", ")
      : "无";
  return [
    `✅ 确定性工作流执行通过（\`${workflowId}\`）`,
    `- 执行步数: ${executedSteps}/${totalSteps}（条件跳过 ${skippedSteps} 步）`,
    `- 总耗时: ${Math.max(0, Math.round(durationMs))} ms`,
    `- 模型调用: 0 回合 / 0 词元`,
    `- 截图路径: ${shotsText}`,
  ].join("\n");
}

function buildToolMap(rawTools) {
  if (rawTools instanceof Map) return rawTools;
  const map = new Map();
  if (Array.isArray(rawTools)) {
    for (const item of rawTools) {
      if (item && typeof item.name === "string" && typeof item.execute === "function") {
        map.set(item.name, item);
      }
    }
    return map;
  }
  if (rawTools && typeof rawTools === "object") {
    for (const [name, val] of Object.entries(rawTools)) {
      if (typeof val === "function") {
        map.set(name, { name, execute: val });
      } else if (val && typeof val.execute === "function") {
        map.set(name, val);
      }
    }
  }
  return map;
}

export async function runDeterministicWorkflow({
  rawText = "",
  directive: preParsedDirective = null,
  rawTools = [],
  getLastCapturedImage = () => null,
  clearLastCapturedImage = () => {},
  resolvePageSnapshot = async () => null,
  settings = {},
  signal = null,
  traceSteps = [],
  onStepStart = null,
  onStepDone = null,
} = {}) {
  const startedMs = Date.now();
  const toolMap = buildToolMap(rawTools);
  const executedSingleShots = new Set();
  let nonceCounter = 0;

  async function invokeRawTool(toolName, args, stepCtx) {
    checkAbort(signal);
    const tool = toolMap.get(toolName);
    if (!tool) {
      throw new WorkflowError({
        code: "WORKFLOW_TOOL_MISSING",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: `底层工具 "${toolName}" 可用`,
        actual: `未注册工具 "${toolName}"`,
        message: `缺少底层工具: ${toolName}`,
      });
    }
    let rawOut;
    try {
      rawOut = await tool.execute(args || {});
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const msg = err?.message || String(err);
      throw new WorkflowError({
        code: "WORKFLOW_TOOL_EXCEPTION",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: `${toolName} 正常执行`,
        actual: msg,
        message: `${toolName} 抛出异常: ${msg}`,
      });
    }
    const { parsed, text } = parseToolOutput(rawOut);
    if (FILE_CHOOSER_ERR_RE.test(text) || parsed?.blockedFileChooser === true) {
      throw new WorkflowError({
        code: "WORKFLOW_FILE_CHOOSER_BLOCKED",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: "点击不触发原生文件选择框",
        actual: text.slice(0, 300),
        message: `底层拦截到原生文件选择框触发: ${text.slice(0, 200)}`,
      });
    }
    return { parsed, text };
  }

  async function evalJs(code, stepCtx) {
    const { parsed, text } = await invokeRawTool("run_js", { code }, stepCtx);
    if (!parsed || parsed.ok === false) {
      const errDetail = parsed?.error || text || "run_js 返回失败";
      throw new WorkflowError({
        code: "WORKFLOW_DOM_EVAL_FAILED",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: "页面脚本正常返回 { ok: true }",
        actual: String(errDetail).slice(0, 400),
        message: `页面实读脚本异常: ${String(errDetail).slice(0, 240)}`,
      });
    }
    return parsed.result;
  }

  async function captureStepScreenshot(stepCtx) {
    if (!toolMap.has("screenshot")) return null;
    try {
      clearLastCapturedImage();
      const { text } = await invokeRawTool("screenshot", {}, stepCtx);
      const dataUrl = getLastCapturedImage();
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        return dataUrl;
      }
      if (typeof text === "string" && text.startsWith("data:image/")) {
        return text;
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }
    return null;
  }

  async function checkEnvironmentAndUrl(directive, stepCtx) {
    const snap = await resolvePageSnapshot().catch(() => null);
    if (snap?.url) {
      assertUrlNotForbidden(snap.url, directive.forbidUrlSubstrings, stepCtx);
      const extBlock = detectExternalBlocker({ url: snap.url, title: snap.title || "", text: "" });
      if (extBlock) {
        throw new WorkflowError({
          code: "WORKFLOW_EXTERNAL_BLOCKER",
          blame: "其他",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: "目标站点已登录且无安全验证/网关错误",
          actual: extBlock,
          message: extBlock,
        });
      }
    }
    return snap;
  }

  let directive = preParsedDirective;
  if (!directive) {
    try {
      directive = parseWorkflowDirective(rawText);
    } catch (err) {
      const wfErr =
        err instanceof WorkflowError
          ? err
          : new WorkflowError({
              code: "WORKFLOW_PARSE_ERROR",
              blame: "workflow",
              stepIndex: 0,
              stepId: "workflow.parse",
              op: "parse",
              expected: "合法 /workflow JSON 指令",
              actual: err?.message || String(err),
              message: err?.message || String(err),
            });
      const now = Date.now();
      const shotUrl = await captureStepScreenshot({ stepIndex: 1, stepId: wfErr.stepId, op: wfErr.op });
      const snap = await resolvePageSnapshot().catch(() => null);
      traceSteps.push({
        type: "tool_exec",
        turn: 0,
        name: wfErr.op || "parse",
        toolName: wfErr.op || "parse",
        workflowStepId: wfErr.stepId || "workflow.parse",
        args: { stepId: wfErr.stepId || "workflow.parse" },
        ok: false,
        jsOk: true,
        failureReason: wfErr.message,
        resultSummary: wfErr.actual || wfErr.message,
        expected: wfErr.expected,
        actual: wfErr.actual,
        blame: wfErr.blame,
        ...(shotUrl ? { screenshotDataUrl: shotUrl } : {}),
        durationMs: Math.max(1, now - startedMs),
        tabId: snap?.tabId ?? null,
        pageUrl: snap?.url ?? null,
        pageTitle: snap?.title ?? null,
        timestamp: now,
        isoTime: new Date(now).toISOString(),
      });
      return {
        ok: false,
        aborted: false,
        workflowId: "invalid-workflow",
        totalSteps: 1,
        executedSteps: 0,
        skippedSteps: 0,
        durationMs: Math.max(1, Date.now() - startedMs),
        errorMessage: wfErr.message,
        failure: {
          stepIndex: 1,
          stepId: wfErr.stepId || "workflow.parse",
          op: wfErr.op || "parse",
          expected: wfErr.expected,
          actual: wfErr.actual,
          blame: wfErr.blame,
          message: wfErr.message,
        },
      };
    }
  }

  async function clickMarkedElement({ markNonce, buttonText, selectorOverride = null, stepCtx, targetUrl = "" }) {
    const sel = selectorOverride || `[data-pl-wf-act="${markNonce}"]`;
    try {
      assertClickTargetSafe({
        labelText: buttonText,
        domElementText: buttonText,
        forbidClickTexts: directive.forbidClickTexts,
        settings,
        targetUrl,
        stepCtx,
      });
      const clickArgs = buttonText ? { selector: sel, text: String(buttonText) } : { selector: sel };
      const { parsed, text } = await invokeRawTool("click", clickArgs, stepCtx);
      if (!parsed || parsed.ok !== true) {
        throw new WorkflowError({
          code: "WORKFLOW_CLICK_FAILED",
          blame: "工具",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: `成功点击控件 "${buttonText || sel}"`,
          actual: text.slice(0, 350),
          message: `点击控件失败 (${buttonText || sel}): ${text.slice(0, 200)}`,
        });
      }
      return parsed;
    } finally {
      if (!selectorOverride && markNonce) {
        await invokeRawTool(
          "run_js",
          {
            code: `for (const el of document.querySelectorAll(${JSON.stringify(`[data-pl-wf-act="${markNonce}"]`)})) el.removeAttribute('data-pl-wf-act'); return true;`,
          },
          stepCtx,
        ).catch(() => {});
      }
    }
  }

  async function executeStepOp(step, params, stepCtx, currentUrl) {
    switch (step.op) {
      case "assert_url": {
        const mustStartWith = params.mustStartWith ? String(params.mustStartWith) : "";
        const mustInclude = params.mustInclude ? String(params.mustInclude) : "";
        const timeoutMs = Math.max(0, Number(params.timeoutMs) || 0);
        const deadline = Date.now() + timeoutMs;
        let info = null;
        while (true) {
          info = await evalJs(
            `return {
              url: location.href,
              title: document.title || "",
              bodySample: (document.body ? document.body.innerText : "").slice(0, 1800)
            };`,
            stepCtx,
          );
          const extBlock = detectExternalBlocker({
            url: info?.url,
            title: info?.title,
            text: info?.bodySample,
          });
          if (extBlock) {
            throw new WorkflowError({
              code: "WORKFLOW_EXTERNAL_BLOCKER",
              blame: "其他",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `页面正常就绪 (${mustStartWith || mustInclude || "目标地址"})`,
              actual: extBlock,
              message: extBlock,
            });
          }
          assertUrlNotForbidden(info?.url, directive.forbidUrlSubstrings, stepCtx);
          const okStart = !mustStartWith || String(info?.url || "").startsWith(mustStartWith);
          const okInc = !mustInclude || String(info?.url || "").includes(mustInclude);
          if (okStart && okInc) {
            return { ok: true, url: info.url, title: info.title };
          }
          if (Date.now() >= deadline) {
            throw new WorkflowError({
              code: "WORKFLOW_URL_MISMATCH",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `URL 匹配 ${mustStartWith || mustInclude}`,
              actual: `当前 URL: ${info?.url || "(空)"}`,
              message: `当前标签页 URL 不符合预期: ${info?.url || "(空)"}`,
            });
          }
          await sleepWithAbort(150, signal);
        }
      }

      case "close_modals_if_present": {
        const modalSelector = String(params.modalSelector || ".ant-modal");
        const cancelText = String(params.cancelText || "取消");
        const maxAttempts = Math.max(1, Number(params.maxAttempts) || 5);
        const settleMs = Math.max(200, Number(params.settleMs) || 1500);
        let closedCount = 0;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const nonce = `close_${++nonceCounter}`;
          const probe = await evalJs(
            `const sel = ${JSON.stringify(modalSelector)};
            const wantCancel = ${JSON.stringify(normalizeCjkText(cancelText))};
            const nonce = ${JSON.stringify(nonce)};
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
            const visible = [...document.querySelectorAll(sel)].filter((m) => {
              const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
              const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
              const ms = getComputedStyle(m);
              const r = m.getBoundingClientRect();
              if (ws.display === "none" || ws.visibility === "hidden" || ms.display === "none" || ms.visibility === "hidden") return false;
              if ((wrap && /leave/.test(wrap.className || "")) || /leave/.test(m.className || "")) return false;
              return r.width > 0 && r.height > 0;
            });
            if (!visible.length) return { count: 0 };
            const topModal = visible[visible.length - 1];
            const title = norm((topModal.querySelector(".ant-modal-title") || {}).innerText || "");
            const btns = [...topModal.querySelectorAll("button")].filter((b) => {
              const r = b.getBoundingClientRect();
              return !b.disabled && r.width > 0 && r.height > 0;
            });
            const hit = btns.find((b) => norm(b.innerText) === wantCancel);
            if (!hit) {
              return { count: visible.length, title, foundCancel: false, buttons: btns.map((b) => norm(b.innerText)).slice(0, 12) };
            }
            hit.setAttribute("data-pl-wf-act", nonce);
            return { count: visible.length, title, foundCancel: true, buttonText: norm(hit.innerText) };`,
            stepCtx,
          );

          if (!probe || probe.count === 0) {
            return { ok: true, closedCount, remainingModals: 0 };
          }
          if (!probe.foundCancel) {
            throw new WorkflowError({
              code: "WORKFLOW_MODAL_CANCEL_NOT_FOUND",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `遗留弹窗 "${probe.title || modalSelector}" 存在可点击 "${cancelText}" 按钮`,
              actual: `可见按钮: ${JSON.stringify(probe.buttons || [])}`,
              message: `遗留弹窗未找到 "${cancelText}" 按钮`,
            });
          }
          await clickMarkedElement({
            markNonce: nonce,
            buttonText: cancelText,
            stepCtx,
            targetUrl: currentUrl,
          });
          closedCount += 1;

          const waitDeadline = Date.now() + settleMs;
          while (Date.now() < waitDeadline) {
            const after = await evalJs(
              `const visible = [...document.querySelectorAll(${JSON.stringify(modalSelector)})].filter((m) => {
                const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
                const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
                const r = m.getBoundingClientRect();
                if (ws.display === "none" || ws.visibility === "hidden") return false;
                if ((wrap && /leave/.test(wrap.className || "")) || /leave/.test(m.className || "")) return false;
                return r.width > 0 && r.height > 0;
              });
              return visible.length;`,
              stepCtx,
            );
            if (after < probe.count) break;
            await sleepWithAbort(120, signal);
          }
        }

        const finalCount = await evalJs(
          `return [...document.querySelectorAll(${JSON.stringify(modalSelector)})].filter((m) => {
            const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
            const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
            const r = m.getBoundingClientRect();
            return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
          }).length;`,
          stepCtx,
        );
        if (finalCount !== 0) {
          throw new WorkflowError({
            code: "WORKFLOW_MODAL_STILL_OPEN",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: "所有弹窗已关闭 (remainingModals === 0)",
            actual: `仍余 ${finalCount} 个可见弹窗`,
            message: `关闭弹窗后仍残留 ${finalCount} 个弹窗`,
          });
        }
        return { ok: true, closedCount, remainingModals: 0 };
      }

      case "row_action": {
        const rowSelector = String(params.rowSelector || "tr");
        const mustIncludeAll = Array.isArray(params.mustIncludeAll) ? params.mustIncludeAll.map(String) : [];
        const mustIncludeAny = Array.isArray(params.mustIncludeAny) ? params.mustIncludeAny.map(String) : [];
        const excludeSubstrings = Array.isArray(params.excludeSubstrings) ? params.excludeSubstrings.map(String) : [];
        const forbidRowTexts = Array.isArray(params.forbidRowTexts) ? params.forbidRowTexts.map(String) : [];
        const mode = params.mode === "assert_only" ? "assert_only" : "click";
        const buttonText = params.buttonText ? String(params.buttonText) : "";
        const timeoutMs = Math.max(0, Number(params.timeoutMs ?? 8000));
        const deadline = Date.now() + timeoutMs;
        const nonce = `row_${++nonceCounter}`;

        let probe = null;
        while (true) {
          probe = await evalJs(
            `const rowSel = ${JSON.stringify(rowSelector)};
            const allKeys = ${JSON.stringify(mustIncludeAll)};
            const anyKeys = ${JSON.stringify(mustIncludeAny)};
            const excludes = ${JSON.stringify(excludeSubstrings)};
            const forbids = ${JSON.stringify(forbidRowTexts)};
            const mode = ${JSON.stringify(mode)};
            const wantBtn = ${JSON.stringify(normalizeCjkText(buttonText))};
            const nonce = ${JSON.stringify(nonce)};
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
            const rows = [...document.querySelectorAll(rowSel)].filter((r) => {
              const rect = r.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            const matched = [];
            for (const r of rows) {
              const t = norm(r.innerText);
              if (!t) continue;
              if (allKeys.some((k) => !t.includes(k))) continue;
              if (anyKeys.length > 0 && !anyKeys.some((k) => t.includes(k))) continue;
              if (excludes.some((k) => k && t.includes(k))) continue;
              matched.push({ el: r, text: t });
            }
            if (matched.length !== 1) {
              return { count: matched.length, sample: matched.map((m) => m.text.slice(0, 220)).slice(0, 3), totalRows: rows.length };
            }
            const target = matched[0];
            const hitForbid = forbids.find((f) => f && target.text.includes(f));
            if (hitForbid) {
              return { count: 1, forbiddenHit: hitForbid, rowText: target.text.slice(0, 300) };
            }
            const btns = [...target.el.querySelectorAll("button")].map((b) => ({
              el: b,
              text: normBtn(b.innerText),
              disabled: Boolean(b.disabled),
              visible: b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0
            }));
            if (mode === "assert_only") {
              return {
                count: 1,
                rowText: target.text.slice(0, 400),
                buttons: btns.filter((b) => b.visible).map((b) => ({ text: b.text, disabled: b.disabled }))
              };
            }
            const btn = btns.find((b) => b.text === wantBtn && b.visible && !b.disabled);
            if (!btn) {
              return {
                count: 1,
                rowText: target.text.slice(0, 300),
                buttonFound: false,
                buttons: btns.map((b) => ({ text: b.text, disabled: b.disabled, visible: b.visible }))
              };
            }
            btn.el.setAttribute("data-pl-wf-act", nonce);
            return {
              count: 1,
              buttonFound: true,
              buttonText: btn.text,
              rowText: target.text.slice(0, 320)
            };`,
            stepCtx,
          );

          if (probe?.forbiddenHit) {
            throw new WorkflowError({
              code: "WORKFLOW_FORBIDDEN_ROW",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `目标行不含禁触样本关键字 ${JSON.stringify(forbidRowTexts)}`,
              actual: `命中禁触关键字 "${probe.forbiddenHit}"，行文本: ${probe.rowText}`,
              message: `命中禁触样本保护: ${probe.forbiddenHit}`,
            });
          }

          if (probe?.count === 1 && (mode === "assert_only" || probe?.buttonFound)) {
            break;
          }
          if (Date.now() >= deadline) {
            if (probe?.count !== 1) {
              throw new WorkflowError({
                code: "WORKFLOW_ROW_MATCH_COUNT",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `唯一命中 1 行 (mustIncludeAll=${JSON.stringify(mustIncludeAll)}, mustIncludeAny=${JSON.stringify(mustIncludeAny)})`,
                actual: `实际命中 ${probe?.count ?? 0} 行（总可见行 ${probe?.totalRows ?? 0}）: ${JSON.stringify(probe?.sample || [])}`,
                message: `目标商品行匹配数异常: 期望 1，实得 ${probe?.count ?? 0}`,
              });
            }
            throw new WorkflowError({
              code: "WORKFLOW_ROW_BUTTON_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `目标行存在可见可用按钮 "${buttonText}"`,
              actual: `行内按钮: ${JSON.stringify(probe?.buttons || [])}`,
              message: `目标商品行缺少可用按钮: ${buttonText}`,
            });
          }
          await sleepWithAbort(200, signal);
        }

        if (mode === "assert_only") {
          return { ok: true, matchedCount: 1, rowText: probe.rowText, buttons: probe.buttons };
        }

        await clickMarkedElement({
          markNonce: nonce,
          buttonText,
          stepCtx,
          targetUrl: currentUrl,
        });

        if (params.waitText || params.waitSelector) {
          const waitArgs = {
            ...(params.waitText ? { text: String(params.waitText) } : {}),
            ...(params.waitSelector ? { selector: String(params.waitSelector) } : {}),
            timeoutMs: Math.max(1000, Number(params.waitTimeoutMs) || 15000),
          };
          const { parsed, text } = await invokeRawTool("wait_for", waitArgs, stepCtx);
          if (!parsed || parsed.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_ROW_WAIT_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `点击 "${buttonText}" 后出现 ${params.waitText || params.waitSelector}`,
              actual: text.slice(0, 300),
              message: `点击 "${buttonText}" 后等待目标状态超时`,
            });
          }
        }
        return { ok: true, clicked: buttonText, rowText: probe.rowText };
      }

      case "wait_for": {
        const waitArgs = {
          ...(params.selector ? { selector: String(params.selector) } : {}),
          ...(params.text ? { text: String(params.text) } : {}),
          timeoutMs: Math.max(500, Number(params.timeoutMs) || 10000),
        };
        const { parsed, text } = await invokeRawTool("wait_for", waitArgs, stepCtx);
        if (!parsed || parsed.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_WAIT_TIMEOUT",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `等待元素/文本就绪: ${JSON.stringify(waitArgs)}`,
            actual: text.slice(0, 350),
            message: `等待目标元素或文本超时`,
          });
        }
        return parsed;
      }

      case "scroll_container": {
        const containerSelector = String(params.containerSelector || "");
        const direction = String(params.direction || "down");
        const amount = Number(params.amount) || 500;
        if (!containerSelector) {
          const { parsed } = await invokeRawTool(
            "scroll_page",
            { selector: params.selector, percent: params.percent, y: params.y },
            stepCtx,
          );
          return parsed || { ok: true };
        }
        const res = await evalJs(
          `const el = document.querySelector(${JSON.stringify(containerSelector)});
          if (!el) return { found: false };
          const dir = ${JSON.stringify(direction)};
          const amt = ${JSON.stringify(amount)};
          if (dir === "maxRight") el.scrollLeft = el.scrollWidth;
          else if (dir === "maxLeft") el.scrollLeft = 0;
          else if (dir === "right") el.scrollLeft += amt;
          else if (dir === "left") el.scrollLeft = Math.max(0, el.scrollLeft - amt);
          else if (dir === "top") el.scrollTop = 0;
          else if (dir === "bottom") el.scrollTop = el.scrollHeight;
          else if (dir === "up") el.scrollTop = Math.max(0, el.scrollTop - amt);
          else el.scrollTop += amt;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return {
            found: true,
            scrollLeft: el.scrollLeft,
            scrollTop: el.scrollTop,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight
          };`,
          stepCtx,
        );
        if (!res?.found) {
          throw new WorkflowError({
            code: "WORKFLOW_SCROLL_CONTAINER_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `滚动容器存在: ${containerSelector}`,
            actual: "未找到匹配滚动容器",
            message: `未找到滚动容器: ${containerSelector}`,
          });
        }
        return res;
      }

      case "ensure_select": {
        if (params.groupSelector && Array.isArray(params.groupValues)) {
          const groupSel = String(params.groupSelector);
          const subSel = String(params.selectSelector || ".ant-select");
          const groupVals = params.groupValues.map((v) => String(v));
          const groupCount = await evalJs(
            `return document.querySelectorAll(${JSON.stringify(groupSel)}).length;`,
            stepCtx,
          );
          if (!groupCount) {
            throw new WorkflowError({
              code: "WORKFLOW_SELECT_GROUP_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `至少存在 1 个下拉分组容器: ${groupSel}`,
              actual: "匹配到 0 个分组容器",
              message: `未找到下拉分组容器: ${groupSel}`,
            });
          }
          const groupResults = [];
          for (let g = 0; g < groupCount; g += 1) {
            for (let k = 0; k < groupVals.length; k += 1) {
              const gNonce = `gsel_${++nonceCounter}`;
              const tagDeadline = Date.now() + 4000;
              let tagged = false;
              while (true) {
                tagged = await evalJs(
                  `const grp = document.querySelectorAll(${JSON.stringify(groupSel)})[${g}];
                  const el = grp ? grp.querySelectorAll(${JSON.stringify(subSel)})[${k}] : null;
                  if (!el) return false;
                  el.setAttribute("data-pl-wf-act", ${JSON.stringify(gNonce)});
                  return true;`,
                  stepCtx,
                );
                if (tagged || Date.now() >= tagDeadline) break;
                await sleepWithAbort(100, signal);
              }
              if (!tagged) {
                throw new WorkflowError({
                  code: "WORKFLOW_SELECT_SUBITEM_MISSING",
                  blame: "workflow",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `${groupSel}[${g}] 内存在第 ${k + 1} 个 ${subSel}`,
                  actual: "子下拉框未挂载",
                  message: `分组 ${groupSel}[${g}] 第 ${k + 1} 个下拉未找到`,
                });
              }
              const tagSel = `[data-pl-wf-act="${gNonce}"]`;
              try {
                const { parsed, text } = await invokeRawTool(
                  "select_option",
                  { selector: tagSel, value: groupVals[k] },
                  stepCtx,
                );
                if (!parsed || parsed.ok !== true) {
                  throw new WorkflowError({
                    code: "WORKFLOW_SELECT_FAILED",
                    blame: "工具",
                    stepIndex: stepCtx.stepIndex,
                    stepId: stepCtx.stepId,
                    op: stepCtx.op,
                    expected: `${groupSel}[${g}][${k}] 选中 "${groupVals[k]}"`,
                    actual: text.slice(0, 350),
                    message: `分组下拉选择失败 (${groupSel}[${g}][${k}] -> ${groupVals[k]})`,
                  });
                }
                groupResults.push({
                  group: g,
                  index: k,
                  value: groupVals[k],
                  alreadySelected: Boolean(parsed.alreadySelected),
                });
              } finally {
                await invokeRawTool(
                  "run_js",
                  {
                    code: `for (const el of document.querySelectorAll(${JSON.stringify(tagSel)})) el.removeAttribute("data-pl-wf-act"); return true;`,
                  },
                  stepCtx,
                ).catch(() => {});
              }
            }
          }
          return { ok: true, groupCount, results: groupResults };
        }

        const selectSpecs = Array.isArray(params.items)
          ? params.items
          : [
              {
                label: params.label,
                selector: params.selector,
                nth: params.nth,
                values: params.values,
                value: params.value,
              },
            ];
        const results = [];
        for (const spec of selectSpecs) {
          const targets = Array.isArray(spec.values)
            ? spec.values.map((v) => String(v))
            : [String(spec.value ?? "")];
          for (const val of targets) {
            const selArgs = {
              ...(spec.label ? { label: String(spec.label) } : {}),
              ...(spec.selector ? { selector: String(spec.selector) } : {}),
              ...(spec.nth !== undefined ? { nth: Number(spec.nth) } : {}),
              value: val,
            };
            const { parsed, text } = await invokeRawTool("select_option", selArgs, stepCtx);
            if (!parsed || parsed.ok !== true) {
              throw new WorkflowError({
                code: "WORKFLOW_SELECT_FAILED",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `下拉项 "${spec.label || spec.selector}" 选中 "${val}"`,
                actual: text.slice(0, 350),
                message: `下拉选择失败 (${spec.label || spec.selector} -> ${val})`,
              });
            }
            results.push({
              target: spec.label || spec.selector,
              value: val,
              alreadySelected: Boolean(parsed.alreadySelected),
              selected: parsed.selected,
            });
          }
        }
        return { ok: true, results };
      }

      case "ensure_cascader": {
        const selector = String(params.selector || "");
        const expectedText = normalizeSpaces(params.expectedText || "");
        const mode = params.mode === "levels" ? "levels" : "search";
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 12000);

        if (params.navButtonSelector && params.navButtonText) {
          assertClickTargetSafe({
            labelText: params.navButtonText,
            domElementText: params.navButtonText,
            forbidClickTexts: directive.forbidClickTexts,
            settings,
            targetUrl: currentUrl,
            stepCtx,
          });
          await invokeRawTool(
            "click",
            { selector: String(params.navButtonSelector), text: String(params.navButtonText) },
            stepCtx,
          );
        }

        const current = await evalJs(
          `const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { exists: false, itemText: "" };
          const wrap = el.closest(".ant-select");
          const item = wrap ? wrap.querySelector(".ant-select-selection-item") : null;
          const text = item ? ((item.querySelector(".ant-select-selection-item-content") || item).textContent || "") : "";
          return { exists: true, itemText: text.replace(/\\s+/g, " ").trim() };`,
          stepCtx,
        );

        if (!current?.exists) {
          throw new WorkflowError({
            code: "WORKFLOW_CASCADER_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `级联控件存在: ${selector}`,
            actual: "DOM 中未找到该选择器",
            message: `未找到级联选择器: ${selector}`,
          });
        }

        let skipped = false;
        if (current.itemText === expectedText) {
          skipped = true;
        } else if (mode === "search") {
          const searchValue = String(params.searchValue || "");
          const { parsed: fillRes, text: fillTxt } = await invokeRawTool(
            "fill",
            { selector, value: searchValue },
            stepCtx,
          );
          if (!fillRes || fillRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_SEARCH_FILL_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `在 ${selector} 输入搜索词 "${searchValue}"`,
              actual: fillTxt.slice(0, 300),
              message: `级联搜索词输入失败`,
            });
          }
          const waitArgs = params.dropdownSelector
            ? { selector: String(params.dropdownSelector), timeoutMs }
            : { text: expectedText, timeoutMs };
          const { parsed: waitRes, text: waitTxt } = await invokeRawTool("wait_for", waitArgs, stepCtx);
          if (!waitRes || waitRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_DROPDOWN_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `级联候选浮层出现 (${params.dropdownSelector || expectedText})`,
              actual: waitTxt.slice(0, 300),
              message: `级联候选浮层等待超时`,
            });
          }
          assertClickTargetSafe({
            labelText: expectedText,
            domElementText: expectedText,
            forbidClickTexts: directive.forbidClickTexts,
            settings,
            targetUrl: currentUrl,
            stepCtx,
          });
          const clickArgs = {
            ...(params.optionSelector ? { selector: String(params.optionSelector) } : {}),
            text: expectedText,
          };
          const { parsed: clickRes, text: clickTxt } = await invokeRawTool("click", clickArgs, stepCtx);
          if (!clickRes || clickRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_OPTION_CLICK_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `点击级联目标路径 "${expectedText}"`,
              actual: clickTxt.slice(0, 300),
              message: `点击级联路径失败`,
            });
          }
        } else {
          const levels = Array.isArray(params.levels) ? params.levels.map((x) => String(x)) : [];
          const openTool = params.openWithTrustedClick !== false ? "trusted_click" : "click";
          const { parsed: openRes, text: openTxt } = await invokeRawTool(openTool, { selector }, stepCtx);
          if (!openRes || openRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_OPEN_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `展开级联选择器 ${selector}`,
              actual: openTxt.slice(0, 300),
              message: `展开级联选择器失败`,
            });
          }
          for (const lvl of levels) {
            const { parsed: wRes, text: wTxt } = await invokeRawTool(
              "wait_for",
              { text: lvl, timeoutMs },
              stepCtx,
            );
            if (!wRes || wRes.ok !== true) {
              throw new WorkflowError({
                code: "WORKFLOW_CASCADER_LEVEL_TIMEOUT",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `级联层级出现 "${lvl}"`,
                actual: wTxt.slice(0, 300),
                message: `等待级联层级 "${lvl}" 超时`,
              });
            }
            assertClickTargetSafe({
              labelText: lvl,
              domElementText: lvl,
              forbidClickTexts: directive.forbidClickTexts,
              settings,
              targetUrl: currentUrl,
              stepCtx,
            });
            const lvlClickArgs = {
              ...(params.optionSelector ? { selector: String(params.optionSelector) } : {}),
              text: lvl,
            };
            const { parsed: cRes, text: cTxt } = await invokeRawTool("click", lvlClickArgs, stepCtx);
            if (!cRes || cRes.ok !== true) {
              throw new WorkflowError({
                code: "WORKFLOW_CASCADER_LEVEL_CLICK_FAILED",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `点击级联层级 "${lvl}"`,
                actual: cTxt.slice(0, 300),
                message: `点击级联层级 "${lvl}" 失败`,
              });
            }
          }
        }

        let readbackText = skipped ? expectedText : "";
        if (!skipped) {
          const verifyDeadline = Date.now() + 4000;
          while (true) {
            const check = await evalJs(
              `const el = document.querySelector(${JSON.stringify(selector)});
              const wrap = el ? el.closest(".ant-select") : null;
              const item = wrap ? wrap.querySelector(".ant-select-selection-item") : null;
              const text = item ? ((item.querySelector(".ant-select-selection-item-content") || item).textContent || "") : "";
              return text.replace(/\\s+/g, " ").trim();`,
              stepCtx,
            );
            readbackText = String(check || "");
            if (readbackText === expectedText) break;
            if (Date.now() >= verifyDeadline) {
              throw new WorkflowError({
                code: "WORKFLOW_CASCADER_VERIFY_MISMATCH",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: expectedText,
                actual: readbackText || "(空)",
                message: `级联选择回读不一致: 期望 "${expectedText}"，实读 "${readbackText || "(空)"}"`,
              });
            }
            await sleepWithAbort(120, signal);
          }
        }

        if (params.postWaitSelector) {
          const { parsed: pwRes, text: pwTxt } = await invokeRawTool(
            "wait_for",
            { selector: String(params.postWaitSelector), timeoutMs },
            stepCtx,
          );
          if (!pwRes || pwRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_POSTWAIT_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `级联选择后联动区域就绪 (${params.postWaitSelector})`,
              actual: pwTxt.slice(0, 300),
              message: `级联联动区域加载超时`,
            });
          }
        }
        return { ok: true, skipped, selected: readbackText };
      }

      case "fill_input": {
        if (params.navButtonSelector && params.navButtonText) {
          assertClickTargetSafe({
            labelText: params.navButtonText,
            domElementText: params.navButtonText,
            forbidClickTexts: directive.forbidClickTexts,
            settings,
            targetUrl: currentUrl,
            stepCtx,
          });
          await invokeRawTool(
            "click",
            { selector: String(params.navButtonSelector), text: String(params.navButtonText) },
            stepCtx,
          );
        }

        const itemSpecs = Array.isArray(params.items)
          ? params.items
          : [
              {
                selector: params.selector,
                all: params.all,
                nth: params.nth,
                value: params.value,
                blur: params.blur,
              },
            ];

        const itemResults = [];
        for (const spec of itemSpecs) {
          const selector = String(spec.selector || "");
          const fillAll = Boolean(spec.all);
          const nth = Number.isInteger(Number(spec.nth)) ? Number(spec.nth) : 0;
          const expectedValue = String(spec.value ?? "");
          const blur = spec.blur !== false;

          if (fillAll) {
            const allInfo = await evalJs(
              `const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
              return { count: list.length, values: list.map((el) => String(el.value ?? "")) };`,
              stepCtx,
            );
            if (!allInfo?.count) {
              throw new WorkflowError({
                code: "WORKFLOW_INPUT_MISSING",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `至少存在 1 个输入框: ${selector}`,
                actual: "匹配到 0 个元素",
                message: `未找到目标输入框集合: ${selector}`,
              });
            }
            let changed = 0;
            for (let idx = 0; idx < allInfo.count; idx += 1) {
              if (allInfo.values[idx] === expectedValue) continue;
              const { parsed: fRes, text: fTxt } = await invokeRawTool(
                "fill",
                { selector, ...(idx > 0 ? { nth: idx } : {}), value: expectedValue, blur },
                stepCtx,
              );
              if (!fRes || fRes.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_FILL_FAILED",
                  blame: "工具",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `输入框 ${selector}[${idx}] 写入 "${expectedValue}"`,
                  actual: fTxt.slice(0, 300),
                  message: `批量输入框写入失败: ${selector}[${idx}]`,
                });
              }
              changed += 1;
            }
            const afterValues = await evalJs(
              `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => String(el.value ?? ""));`,
              stepCtx,
            );
            if (!Array.isArray(afterValues) || afterValues.some((v) => v !== expectedValue)) {
              throw new WorkflowError({
                code: "WORKFLOW_FILL_VERIFY_MISMATCH",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `所有 ${selector} 值均为 "${expectedValue}"`,
                actual: JSON.stringify(afterValues),
                message: `批量输入框回读不一致: ${selector}`,
              });
            }
            itemResults.push({ selector, count: afterValues.length, changed, skipped: changed === 0, value: expectedValue });
            continue;
          }

          const pre = await evalJs(
            `const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
            const el = list[${nth}];
            if (!el) return { exists: false, count: list.length, value: "" };
            return { exists: true, count: list.length, value: String(el.value ?? "") };`,
            stepCtx,
          );
          if (!pre?.exists) {
            throw new WorkflowError({
              code: "WORKFLOW_INPUT_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `输入框存在: ${selector} (nth=${nth})`,
              actual: `仅匹配到 ${pre?.count ?? 0} 个元素`,
              message: `未找到目标输入框: ${selector} (nth=${nth})`,
            });
          }
          if (pre.value === expectedValue) {
            itemResults.push({ selector, nth, skipped: true, value: pre.value });
            continue;
          }

          const fillArgs = {
            selector,
            ...(nth > 0 ? { nth } : {}),
            value: expectedValue,
            blur,
          };
          const { parsed: fillRes, text: fillTxt } = await invokeRawTool("fill", fillArgs, stepCtx);
          if (!fillRes || fillRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_FILL_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `输入框 ${selector} 写入 "${expectedValue}"`,
              actual: fillTxt.slice(0, 300),
              message: `输入框写入失败: ${selector}`,
            });
          }

          const afterVal = await evalJs(
            `const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
            return el ? String(el.value ?? "") : null;`,
            stepCtx,
          );
          if (afterVal !== expectedValue) {
            throw new WorkflowError({
              code: "WORKFLOW_FILL_VERIFY_MISMATCH",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: expectedValue,
              actual: String(afterVal ?? "(null)"),
              message: `输入框回读校验不一致 (${selector})`,
            });
          }
          itemResults.push({ selector, nth, skipped: false, value: afterVal });
        }

        return Array.isArray(params.items)
          ? { ok: true, items: itemResults }
          : { ok: true, ...itemResults[0] };
      }

      case "ensure_radio": {
        const containerSelector = String(params.containerSelector || "body");
        const expectedValue = normalizeCjkText(params.value || "");
        const nonce = `radio_${++nonceCounter}`;

        const probe = await evalJs(
          `const scope = document.querySelector(${JSON.stringify(containerSelector)});
          if (!scope) return { scopeExists: false };
          const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
          const radios = [...scope.querySelectorAll('input[type="radio"]')].map((r) => {
            const label = r.closest("label");
            return {
              checked: Boolean(r.checked),
              text: label ? norm(label.innerText) : "",
              labelEl: label
            };
          });
          const checkedHit = radios.find((r) => r.checked && r.text === ${JSON.stringify(expectedValue)});
          if (checkedHit) return { scopeExists: true, alreadyChecked: true, radios: radios.map((r) => ({ text: r.text, checked: r.checked })) };
          const target = radios.find((r) => r.text === ${JSON.stringify(expectedValue)} && r.labelEl);
          if (!target) return { scopeExists: true, alreadyChecked: false, foundTarget: false, radios: radios.map((r) => ({ text: r.text, checked: r.checked })) };
          target.labelEl.setAttribute("data-pl-wf-act", ${JSON.stringify(nonce)});
          return { scopeExists: true, alreadyChecked: false, foundTarget: true };`,
          stepCtx,
        );

        if (!probe?.scopeExists) {
          throw new WorkflowError({
            code: "WORKFLOW_RADIO_SCOPE_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `单选容器存在: ${containerSelector}`,
            actual: "未找到容器",
            message: `未找到单选容器: ${containerSelector}`,
          });
        }
        if (probe.alreadyChecked) {
          return { ok: true, skipped: true, value: expectedValue };
        }
        if (!probe.foundTarget) {
          throw new WorkflowError({
            code: "WORKFLOW_RADIO_OPTION_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `单选项 "${expectedValue}" 存在`,
            actual: `当前可选项: ${JSON.stringify(probe.radios || [])}`,
            message: `未找到单选项: ${expectedValue}`,
          });
        }

        await clickMarkedElement({
          markNonce: nonce,
          buttonText: expectedValue,
          stepCtx,
          targetUrl: currentUrl,
        });

        const verified = await evalJs(
          `const scope = document.querySelector(${JSON.stringify(containerSelector)});
          const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
          return [...(scope ? scope.querySelectorAll('input[type="radio"]') : [])].some((r) => {
            const label = r.closest("label");
            return r.checked && label && norm(label.innerText) === ${JSON.stringify(expectedValue)};
          });`,
          stepCtx,
        );
        if (!verified) {
          throw new WorkflowError({
            code: "WORKFLOW_RADIO_VERIFY_FAILED",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `单选项 "${expectedValue}" 处于选中态`,
            actual: "点击后仍未选中",
            message: `单选项回读校验失败: ${expectedValue}`,
          });
        }
        return { ok: true, skipped: false, value: expectedValue };
      }

      case "ensure_attr_fields": {
        const containerSelector = String(params.containerSelector || "body");
        const fieldSelector = String(params.fieldSelector || ".ant-form-item");
        const labelSelector = String(params.labelSelector || ".ant-form-item-label, label");
        const rules = Array.isArray(params.rules) ? params.rules : [];
        const summary = [];

        if (params.navButtonSelector && params.navButtonText) {
          assertClickTargetSafe({
            labelText: params.navButtonText,
            domElementText: params.navButtonText,
            forbidClickTexts: directive.forbidClickTexts,
            settings,
            targetUrl: currentUrl,
            stepCtx,
          });
          await invokeRawTool(
            "click",
            { selector: String(params.navButtonSelector), text: String(params.navButtonText) },
            stepCtx,
          );
        }

        for (const rule of rules) {
          checkAbort(signal);
          if (rule.kind === "composition") {
            const matSel = String(rule.materialSelector || "");
            const existsCount = await evalJs(
              `return document.querySelectorAll(${JSON.stringify(matSel)}).length;`,
              stepCtx,
            );
            if (!existsCount) {
              assertClickTargetSafe({
                labelText: rule.addButtonText || "添加",
                domElementText: rule.addButtonText || "添加",
                forbidClickTexts: directive.forbidClickTexts,
                settings,
                targetUrl: currentUrl,
                stepCtx,
              });
              const { parsed: addRes, text: addTxt } = await invokeRawTool(
                "click",
                {
                  selector: String(rule.addButtonSelector),
                  text: String(rule.addButtonText || "添加"),
                },
                stepCtx,
              );
              if (!addRes || addRes.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_ATTR_COMPOSITION_ADD_FAILED",
                  blame: "工具",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `点击成分 "${rule.addButtonText || "添加"}" 按钮新增行`,
                  actual: addTxt.slice(0, 300),
                  message: `新增成分行失败`,
                });
              }
              await invokeRawTool("wait_for", { selector: matSel, timeoutMs: 5000 }, stepCtx);
            }
            const { parsed: selRes, text: selTxt } = await invokeRawTool(
              "select_option",
              { selector: matSel, value: String(rule.materialValue) },
              stepCtx,
            );
            if (!selRes || selRes.ok !== true) {
              throw new WorkflowError({
                code: "WORKFLOW_ATTR_COMPOSITION_SELECT_FAILED",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `成分材质选中 "${rule.materialValue}"`,
                actual: selTxt.slice(0, 300),
                message: `成分材质选择失败`,
              });
            }
            const propSel = String(rule.proportionSelector);
            const propVal = String(rule.proportionValue);
            const curProp = await evalJs(
              `const el = document.querySelector(${JSON.stringify(propSel)});
              return el ? String(el.value ?? "") : null;`,
              stepCtx,
            );
            if (curProp !== propVal) {
              const { parsed: fRes, text: fTxt } = await invokeRawTool(
                "fill",
                { selector: propSel, value: propVal, blur: true },
                stepCtx,
              );
              if (!fRes || fRes.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_ATTR_COMPOSITION_FILL_FAILED",
                  blame: "工具",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `成分比例填入 "${propVal}"`,
                  actual: fTxt.slice(0, 300),
                  message: `成分比例输入失败`,
                });
              }
            }
            if (rule.summaryMustInclude) {
              const bodyHas = await evalJs(
                `return (document.body ? document.body.innerText : "").includes(${JSON.stringify(String(rule.summaryMustInclude))});`,
                stepCtx,
              );
              if (!bodyHas) {
                throw new WorkflowError({
                  code: "WORKFLOW_ATTR_COMPOSITION_SUM_INVALID",
                  blame: "workflow",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `页面出现校验文案 "${rule.summaryMustInclude}"`,
                  actual: "未检测到成分比例 100% 校验通过文案",
                  message: `成分比例合计校验未通过`,
                });
              }
            }
            summary.push({ label: "composition", value: `${rule.materialValue}:${propVal}` });
          } else if (rule.kind === "select") {
            const vals = Array.isArray(rule.values) ? rule.values.map(String) : [String(rule.value)];
            for (const val of vals) {
              const { parsed: sRes, text: sTxt } = await invokeRawTool(
                "select_option",
                { label: String(rule.label), value: val },
                stepCtx,
              );
              if (!sRes || sRes.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_ATTR_SELECT_FAILED",
                  blame: "工具",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `属性 "${rule.label}" 选中 "${val}"`,
                  actual: sTxt.slice(0, 300),
                  message: `类目属性 "${rule.label}" 选择失败`,
                });
              }
            }
            summary.push({ label: rule.label, values: vals });
          } else if (rule.kind === "number") {
            const inSel = String(rule.inputSelector);
            const nth = Number(rule.nth) || 0;
            const targetVal = String(rule.value);
            const curNum = await evalJs(
              `const el = document.querySelectorAll(${JSON.stringify(inSel)})[${nth}];
              return el ? String(el.value ?? "") : null;`,
              stepCtx,
            );
            if (curNum === null) {
              throw new WorkflowError({
                code: "WORKFLOW_ATTR_NUMBER_MISSING",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `数值属性输入框存在: ${inSel} (nth=${nth})`,
                actual: "未找到输入框",
                message: `未找到数值属性输入框: ${inSel}`,
              });
            }
            if (curNum !== targetVal) {
              const { parsed: nRes, text: nTxt } = await invokeRawTool(
                "fill",
                { selector: inSel, ...(nth > 0 ? { nth } : {}), value: targetVal, blur: true },
                stepCtx,
              );
              if (!nRes || nRes.ok !== true) {
                throw new WorkflowError({
                  code: "WORKFLOW_ATTR_NUMBER_FILL_FAILED",
                  blame: "工具",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `数值属性填入 "${targetVal}"`,
                  actual: nTxt.slice(0, 300),
                  message: `数值属性填写失败`,
                });
              }
            }
            if (rule.expectedUnit) {
              const unitCheck = await evalJs(
                `const el = document.querySelectorAll(${JSON.stringify(inSel)})[${nth}];
                const field = el ? el.closest(${JSON.stringify(fieldSelector)}) : null;
                const items = field ? [...field.querySelectorAll(".ant-select-selection-item")].map((i) => ((i.querySelector(".ant-select-selection-item-content") || i).textContent || "").trim()) : [];
                return items;`,
                stepCtx,
              );
              if (!Array.isArray(unitCheck) || !unitCheck.includes(String(rule.expectedUnit))) {
                throw new WorkflowError({
                  code: "WORKFLOW_ATTR_UNIT_MISMATCH",
                  blame: "workflow",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `数值属性单位为 "${rule.expectedUnit}"`,
                  actual: `实读单位: ${JSON.stringify(unitCheck || [])}`,
                  message: `数值属性单位不匹配`,
                });
              }
            }
            summary.push({ label: rule.label || inSel, value: targetVal });
          } else if (rule.kind === "field_input") {
            const labelKey = String(rule.labelIncludes || rule.label || "");
            const targetVal = String(rule.value ?? "");
            const fNonce = `finp_${++nonceCounter}`;
            const fProbe = await evalJs(
              `const root = document.querySelector(${JSON.stringify(containerSelector)}) || document;
              const fields = [...root.querySelectorAll(${JSON.stringify(fieldSelector)})];
              const hit = fields.find((f) => {
                const l = (f.querySelector(${JSON.stringify(labelSelector)}) || {}).innerText || "";
                return l.replace(/\\s+/g, " ").trim().includes(${JSON.stringify(labelKey)});
              });
              if (!hit) return { found: false };
              const inp = [...hit.querySelectorAll("input")].find((i) => i.type !== "search" && i.type !== "checkbox" && i.type !== "radio");
              if (!inp) return { found: false, reason: "no_input" };
              const cur = String(inp.value ?? "");
              if (cur !== ${JSON.stringify(targetVal)}) {
                inp.setAttribute("data-pl-wf-act", ${JSON.stringify(fNonce)});
              }
              return { found: true, value: cur };`,
              stepCtx,
            );
            if (!fProbe?.found) {
              throw new WorkflowError({
                code: "WORKFLOW_ATTR_FIELD_INPUT_MISSING",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `存在属性输入框 "${labelKey}"`,
                actual: JSON.stringify(fProbe),
                message: `未找到属性输入框: ${labelKey}`,
              });
            }
            if (fProbe.value !== targetVal) {
              const sel = `[data-pl-wf-act="${fNonce}"]`;
              try {
                const { parsed: fiRes, text: fiTxt } = await invokeRawTool(
                  "fill",
                  { selector: sel, value: targetVal, blur: true },
                  stepCtx,
                );
                if (!fiRes || fiRes.ok !== true) {
                  throw new WorkflowError({
                    code: "WORKFLOW_ATTR_FIELD_INPUT_FILL_FAILED",
                    blame: "工具",
                    stepIndex: stepCtx.stepIndex,
                    stepId: stepCtx.stepId,
                    op: stepCtx.op,
                    expected: `属性 "${labelKey}" 填入 "${targetVal}"`,
                    actual: fiTxt.slice(0, 300),
                    message: `属性 "${labelKey}" 填写失败`,
                  });
                }
              } finally {
                await invokeRawTool(
                  "run_js",
                  {
                    code: `for (const el of document.querySelectorAll(${JSON.stringify(sel)})) el.removeAttribute("data-pl-wf-act"); return true;`,
                  },
                  stepCtx,
                ).catch(() => {});
              }
            }
            summary.push({ label: labelKey, value: targetVal });
          }
        }

        if (params.requireAllStarredFilled !== false) {
          const audit = await evalJs(
            `const root = document.querySelector(${JSON.stringify(containerSelector)}) || document;
            const fields = [...root.querySelectorAll(${JSON.stringify(fieldSelector)})];
            const missing = [];
            let starredCount = 0;
            for (const f of fields) {
              const lblEl = f.querySelector(${JSON.stringify(labelSelector)});
              const label = (lblEl ? lblEl.innerText : "").replace(/\\s+/g, " ").trim();
              const hasStar = label.includes("*") || Boolean(f.querySelector(".ant-form-item-required, .is-required"));
              if (!hasStar) continue;
              starredCount += 1;
              const items = [...f.querySelectorAll(".ant-select-selection-item")]
                .map((s) => ((s.querySelector(".ant-select-selection-item-content") || s).textContent || "").trim())
                .filter(Boolean);
              const inputs = [...f.querySelectorAll("input")]
                .filter((i) => i.type !== "search" && i.type !== "checkbox" && i.type !== "radio")
                .map((i) => String(i.value || "").trim())
                .filter(Boolean);
              if (!items.length && !inputs.length) {
                missing.push(label || "(未命名必填属性)");
              }
            }
            return { starredCount, missing };`,
            stepCtx,
          );
          if (Array.isArray(audit?.missing) && audit.missing.length > 0) {
            throw new WorkflowError({
              code: "WORKFLOW_STARRED_ATTR_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: "所有带 * 必填类目属性均非空",
              actual: `存在未填必填属性 (${audit.missing.length} 项): ${audit.missing.join("、")}`,
              message: `存在未配置的必填属性: ${audit.missing.join("、")}`,
            });
          }
          return { ok: true, starredCount: audit?.starredCount || 0, configuredCount: summary.length };
        }
        return { ok: true, configuredCount: summary.length };
      }

      case "ensure_modal_entity": {
        const selectedSelector = String(params.selectedSelector || "");
        const alreadyBoundTexts = Array.isArray(params.alreadyBoundTexts)
          ? params.alreadyBoundTexts.map(String)
          : [];
        const openButtonText = String(params.openButtonText || "");
        const rowMustInclude = Array.isArray(params.rowMustInclude) ? params.rowMustInclude.map(String) : [];
        const rowActionText = String(params.rowActionText || "");
        const optionClicks = Array.isArray(params.optionClicks) ? params.optionClicks.map(String) : [];
        const confirmText = String(params.confirmText || "确认");
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 12000);

        const existing = await evalJs(
          `const items = [...document.querySelectorAll(${JSON.stringify(selectedSelector)})];
          const text = items.map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim()).join(" | ");
          return text;`,
          stepCtx,
        );
        const clipBound = (txt) => {
          const s = String(txt || "");
          if (s.length <= 280) return s;
          const anchor = alreadyBoundTexts[0] ? s.indexOf(alreadyBoundTexts[0]) : -1;
          const from = anchor >= 0 ? Math.max(0, anchor - 24) : 0;
          return s.slice(from, from + 280);
        };
        if (
          existing &&
          alreadyBoundTexts.length > 0 &&
          alreadyBoundTexts.every((sub) => String(existing).includes(sub))
        ) {
          return { ok: true, skipped: true, boundText: clipBound(existing) };
        }

        assertClickTargetSafe({
          labelText: openButtonText,
          domElementText: openButtonText,
          forbidClickTexts: directive.forbidClickTexts,
          settings,
          targetUrl: currentUrl,
          stepCtx,
        });
        const { parsed: openRes, text: openTxt } = await invokeRawTool(
          "click",
          { text: openButtonText },
          stepCtx,
        );
        if (!openRes || openRes.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_ENTITY_MODAL_OPEN_FAILED",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `点击 "${openButtonText}" 打开选择弹窗`,
            actual: openTxt.slice(0, 300),
            message: `打开弹窗失败: ${openButtonText}`,
          });
        }

        const { parsed: wRes, text: wTxt } = await invokeRawTool(
          "wait_for",
          { text: rowActionText, timeoutMs },
          stepCtx,
        );
        if (!wRes || wRes.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_ENTITY_MODAL_WAIT_TIMEOUT",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `弹窗加载出操作按钮 "${rowActionText}"`,
            actual: wTxt.slice(0, 300),
            message: `等待弹窗列表超时`,
          });
        }

        const rowNonce = `ent_${++nonceCounter}`;
        const rowProbe = await evalJs(
          `const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
            const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
            const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
            const r = m.getBoundingClientRect();
            return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
          });
          const top = modals[modals.length - 1] || document;
          const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
          const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
          const rows = [...top.querySelectorAll("tbody tr")];
          const must = ${JSON.stringify(rowMustInclude)};
          const wantAct = ${JSON.stringify(normalizeCjkText(rowActionText))};
          const hitRow = rows.find((tr) => {
            const t = norm(tr.innerText);
            return must.every((k) => t.includes(k));
          });
          if (!hitRow) return { found: false, rows: rows.map((r) => norm(r.innerText)).slice(0, 8) };
          const btn = [...hitRow.querySelectorAll("button, a")].find((b) => normBtn(b.innerText) === wantAct);
          if (!btn) return { found: false, reason: "no_button", rowText: norm(hitRow.innerText) };
          btn.setAttribute("data-pl-wf-act", ${JSON.stringify(rowNonce)});
          return { found: true, rowText: norm(hitRow.innerText) };`,
          stepCtx,
        );
        if (!rowProbe?.found) {
          throw new WorkflowError({
            code: "WORKFLOW_ENTITY_ROW_NOT_FOUND",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `弹窗表格存在包含 ${JSON.stringify(rowMustInclude)} 且带 "${rowActionText}" 的行`,
            actual: JSON.stringify(rowProbe),
            message: `弹窗内未找到目标实体行`,
          });
        }

        await clickMarkedElement({
          markNonce: rowNonce,
          buttonText: rowActionText,
          stepCtx,
          targetUrl: currentUrl,
        });

        for (const optText of optionClicks) {
          await invokeRawTool("wait_for", { text: optText, timeoutMs: 5000 }, stepCtx);
          assertClickTargetSafe({
            labelText: optText,
            domElementText: optText,
            forbidClickTexts: directive.forbidClickTexts,
            settings,
            targetUrl: currentUrl,
            stepCtx,
          });
          const { parsed: oRes, text: oTxt } = await invokeRawTool("click", { text: optText }, stepCtx);
          if (!oRes || oRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTITY_OPTION_CLICK_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `点击选项 "${optText}"`,
              actual: oTxt.slice(0, 300),
              message: `点击选项失败: ${optText}`,
            });
          }
        }

        assertClickTargetSafe({
          labelText: confirmText,
          domElementText: confirmText,
          forbidClickTexts: directive.forbidClickTexts,
          settings,
          targetUrl: currentUrl,
          stepCtx,
        });
        const { parsed: cRes, text: cTxt } = await invokeRawTool("click", { text: confirmText }, stepCtx);
        if (!cRes || cRes.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_ENTITY_CONFIRM_FAILED",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `点击确认按钮 "${confirmText}"`,
            actual: cTxt.slice(0, 300),
            message: `确认绑定失败: ${confirmText}`,
          });
        }

        const bindDeadline = Date.now() + 5000;
        let boundAfter = "";
        while (true) {
          boundAfter = await evalJs(
            `return [...document.querySelectorAll(${JSON.stringify(selectedSelector)})]
              .map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim())
              .join(" | ");`,
            stepCtx,
          );
          if (boundAfter && alreadyBoundTexts.every((sub) => String(boundAfter).includes(sub))) {
            break;
          }
          if (Date.now() >= bindDeadline) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTITY_VERIFY_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `已绑定区域包含 ${JSON.stringify(alreadyBoundTexts)}`,
              actual: boundAfter || "(空)",
              message: `绑定实体回读校验失败`,
            });
          }
          await sleepWithAbort(150, signal);
        }
        return { ok: true, skipped: false, boundText: boundAfter };
      }

      case "click_and_wait": {
        const text = String(params.text || "");
        const selector = params.selector ? String(params.selector) : "";
        const onlyIfVisible = Boolean(params.onlyIfVisible);
        const singleShotKey = params.singleShotKey ? String(params.singleShotKey) : "";
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 12000);

        if (singleShotKey && executedSingleShots.has(singleShotKey)) {
          throw new WorkflowError({
            code: "WORKFLOW_SINGLE_SHOT_VIOLATION",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `单次门禁动作 "${singleShotKey}" 单轮最多执行 1 次`,
            actual: `尝试第 2 次触发 "${singleShotKey}"`,
            message: `违反单次执行门禁: ${singleShotKey}`,
          });
        }

        assertClickTargetSafe({
          labelText: text,
          domElementText: text,
          forbidClickTexts: directive.forbidClickTexts,
          settings,
          targetUrl: currentUrl,
          stepCtx,
        });

        if (onlyIfVisible) {
          const vis = await evalJs(
            `const sel = ${JSON.stringify(selector || "button, [role='button'], a")};
            const want = ${JSON.stringify(normalizeCjkText(text))};
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
            const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
              const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
              const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
              const r = m.getBoundingClientRect();
              return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
            });
            const scope = modals.length ? modals[modals.length - 1] : document;
            const hit = [...scope.querySelectorAll(sel)].find((el) => {
              const r = el.getBoundingClientRect();
              return !el.disabled && r.width > 0 && r.height > 0 && norm(el.innerText) === want;
            });
            return Boolean(hit);`,
            stepCtx,
          );
          if (!vis) {
            return { ok: true, skipped: true, reason: "not_visible" };
          }
        }

        const clickArgs = {
          ...(selector ? { selector } : {}),
          ...(text ? { text } : {}),
        };
        const { parsed: cRes, text: cTxt } = await invokeRawTool("click", clickArgs, stepCtx);
        if (!cRes || cRes.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_CLICK_AND_WAIT_FAILED",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `点击 "${text || selector}" 成功`,
            actual: cTxt.slice(0, 350),
            message: `点击 "${text || selector}" 失败`,
          });
        }

        if (singleShotKey) executedSingleShots.add(singleShotKey);

        if (params.waitText || params.waitSelector) {
          const wArgs = {
            ...(params.waitText ? { text: String(params.waitText) } : {}),
            ...(params.waitSelector ? { selector: String(params.waitSelector) } : {}),
            timeoutMs,
          };
          const { parsed: wRes, text: wTxt } = await invokeRawTool("wait_for", wArgs, stepCtx);
          if (!wRes || wRes.ok !== true) {
            throw new WorkflowError({
              code: "WORKFLOW_CLICK_POSTWAIT_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `点击 "${text}" 后出现 ${params.waitText || params.waitSelector}`,
              actual: wTxt.slice(0, 300),
              message: `点击 "${text}" 后等待后置状态超时`,
            });
          }
        }

        if (params.waitModalsCount !== undefined) {
          const wantModals = Number(params.waitModalsCount);
          const modalSelector = String(params.modalSelector || ".ant-modal");
          const waitDeadline = Date.now() + timeoutMs;
          let lastInfo = null;
          while (true) {
            lastInfo = await evalJs(
              `const visible = [...document.querySelectorAll(${JSON.stringify(modalSelector)})].filter((m) => {
                const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
                const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
                const r = m.getBoundingClientRect();
                if (ws.display === "none" || ws.visibility === "hidden") return false;
                if ((wrap && /leave/.test(wrap.className || "")) || /leave/.test(m.className || "")) return false;
                return r.width > 0 && r.height > 0;
              });
              const alerts = [...document.querySelectorAll(".ant-message-notice, .ant-notification-notice")]
                .map((n) => (n.innerText || "").replace(/\\s+/g, " ").trim())
                .filter(Boolean);
              return { count: visible.length, titles: visible.map((m) => ((m.querySelector(".ant-modal-title") || {}).innerText || "").trim()), alerts };`,
              stepCtx,
            );
            if (lastInfo?.count === wantModals) break;
            if (Date.now() >= waitDeadline) {
              throw new WorkflowError({
                code: "WORKFLOW_WAIT_MODALS_COUNT_TIMEOUT",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `可见弹窗数变为 ${wantModals}`,
                actual: `当前可见弹窗 ${lastInfo?.count} (${JSON.stringify(lastInfo?.titles || [])})，提示消息: ${JSON.stringify(lastInfo?.alerts || [])}`,
                message: `等待弹窗数量变为 ${wantModals} 超时`,
              });
            }
            await sleepWithAbort(150, signal);
          }
        }
        return { ok: true, skipped: false, clicked: text || selector };
      }

      case "assert_state": {
        const containerSelector = params.containerSelector ? String(params.containerSelector) : "";
        const checks = Array.isArray(params.checks) ? params.checks : [];
        const timeoutMs = Math.max(0, Number(params.timeoutMs) || 0);
        const deadline = Date.now() + timeoutMs;
        const batches = buildAssertStateBatches(containerSelector, checks, 6000);

        while (true) {
          let failedEval = null;
          const mergedEvidence = [];
          for (const batch of batches) {
            const evalRes = await evalJs(batch.code, stepCtx);
            if (!evalRes?.pass) {
              failedEval = evalRes;
              break;
            }
            if (Array.isArray(evalRes.evidence)) {
              mergedEvidence.push(...evalRes.evidence);
            }
          }

          if (!failedEval) {
            return { ok: true, checkedCount: checks.length, evidence: mergedEvidence };
          }
          if (Date.now() >= deadline) {
            throw new WorkflowError({
              code: "WORKFLOW_ASSERT_FAILED",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: failedEval?.expected || "所有状态断言通过",
              actual: failedEval?.actual || JSON.stringify(failedEval),
              message: `断言未通过 [${failedEval?.kind || "check"}]: 期望 ${failedEval?.expected}，实读 ${failedEval?.actual}`,
            });
          }
          await sleepWithAbort(150, signal);
        }
      }

      default:
        throw new WorkflowError({
          code: "WORKFLOW_UNKNOWN_OP",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: step.op,
          expected: "已注册的确定性步骤原语 op",
          actual: step.op,
          message: `未知步骤原语 op: ${step.op}`,
        });
    }
  }

  let executedSteps = 0;
  let skippedSteps = 0;

  for (let i = 0; i < directive.steps.length; i += 1) {
    checkAbort(signal);
    const step = directive.steps[i];
    const stepIndex = i + 1;
    const stepCtx = { stepIndex, stepId: step.id, op: step.op };
    const stepStartMs = Date.now();
    let summaryArgs = { stepId: step.id };
    let startedEmitted = false;

    try {
      const shouldRun = evaluateWhenPredicate(step.when, directive.binds, stepCtx);
      if (!shouldRun) {
        skippedSteps += 1;
        const skipTs = Date.now();
        const snap = await resolvePageSnapshot().catch(() => null);
        const skipSummary = JSON.stringify({ ok: true, skippedByWhen: step.when });
        onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: { stepId: step.id, when: step.when } });
        onStepDone?.({
          stepIndex,
          stepId: step.id,
          name: step.op,
          ok: true,
          durationMs: Math.max(1, skipTs - stepStartMs),
          result: skipSummary,
        });
        traceSteps.push({
          type: "tool_exec",
          turn: 0,
          name: step.op,
          toolName: step.op,
          workflowStepId: step.id,
          args: { stepId: step.id, when: step.when },
          ok: true,
          jsOk: true,
          failureReason: null,
          resultSummary: skipSummary,
          durationMs: Math.max(1, skipTs - stepStartMs),
          tabId: snap?.tabId ?? null,
          pageUrl: snap?.url ?? null,
          pageTitle: snap?.title ?? null,
          timestamp: skipTs,
          isoTime: new Date(skipTs).toISOString(),
        });
        continue;
      }

      const params = interpolateParams(step.params || {}, directive.binds, stepCtx);
      summaryArgs = summarizeStepArgs(step.id, params);
      onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: summaryArgs });
      startedEmitted = true;

      const preSnap = await checkEnvironmentAndUrl(directive, stepCtx);
      const out = await executeStepOp(step, params, stepCtx, preSnap?.url || "");
      const postSnap = await checkEnvironmentAndUrl(directive, stepCtx);

      let shotDataUrl = null;
      if (step.screenshot) {
        shotDataUrl = await captureStepScreenshot(stepCtx);
      }

      const endTs = Date.now();
      const durMs = Math.max(1, endTs - stepStartMs);
      const fullOut = out ?? { ok: true };
      const outText = JSON.stringify(fullOut).slice(0, 4000);
      executedSteps += 1;

      onStepDone?.({
        stepIndex,
        stepId: step.id,
        name: step.op,
        ok: true,
        durationMs: durMs,
        result: outText,
      });

      traceSteps.push({
        type: "tool_exec",
        turn: 0,
        name: step.op,
        toolName: step.op,
        workflowStepId: step.id,
        args: summaryArgs,
        ok: true,
        jsOk: true,
        failureReason: null,
        resultSummary: outText,
        actualReadback: fullOut,
        ...(shotDataUrl ? { screenshotDataUrl: shotDataUrl } : {}),
        durationMs: durMs,
        tabId: postSnap?.tabId ?? preSnap?.tabId ?? null,
        pageUrl: postSnap?.url ?? preSnap?.url ?? null,
        pageTitle: postSnap?.title ?? preSnap?.title ?? null,
        timestamp: endTs,
        isoTime: new Date(endTs).toISOString(),
      });
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) {
        return {
          ok: false,
          aborted: true,
          workflowId: directive.id,
          totalSteps: directive.steps.length,
          executedSteps,
          skippedSteps,
          durationMs: Math.max(1, Date.now() - startedMs),
          errorMessage: "已停止。",
          failure: null,
        };
      }

      const wfErr =
        err instanceof WorkflowError
          ? err
          : new WorkflowError({
              code: "WORKFLOW_UNEXPECTED_ERROR",
              blame: "工具",
              stepIndex,
              stepId: step.id,
              op: step.op,
              expected: "步骤无异常完成",
              actual: err?.message || String(err),
              message: err?.message || String(err),
            });

      if (!startedEmitted) {
        onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: summaryArgs });
      }

      const failShotUrl = await captureStepScreenshot(stepCtx);
      const failSnap = await resolvePageSnapshot().catch(() => null);
      const endTs = Date.now();
      const durMs = Math.max(1, endTs - stepStartMs);
      const failSummary = `${wfErr.code}: ${wfErr.actual || wfErr.message}`.slice(0, 500);

      onStepDone?.({
        stepIndex,
        stepId: step.id,
        name: step.op,
        ok: false,
        durationMs: durMs,
        result: failSummary,
      });

      traceSteps.push({
        type: "tool_exec",
        turn: 0,
        name: step.op,
        toolName: step.op,
        workflowStepId: step.id,
        args: summaryArgs,
        ok: false,
        jsOk: true,
        failureReason: wfErr.message,
        resultSummary: failSummary,
        expected: wfErr.expected,
        actual: wfErr.actual,
        blame: wfErr.blame,
        ...(failShotUrl ? { screenshotDataUrl: failShotUrl } : {}),
        durationMs: durMs,
        tabId: failSnap?.tabId ?? null,
        pageUrl: failSnap?.url ?? null,
        pageTitle: failSnap?.title ?? null,
        timestamp: endTs,
        isoTime: new Date(endTs).toISOString(),
      });

      return {
        ok: false,
        aborted: false,
        workflowId: directive.id,
        totalSteps: directive.steps.length,
        executedSteps,
        skippedSteps,
        durationMs: Math.max(1, Date.now() - startedMs),
        errorMessage: wfErr.message,
        failure: {
          stepIndex,
          stepId: step.id,
          op: step.op,
          code: wfErr.code,
          expected: wfErr.expected,
          actual: wfErr.actual,
          blame: wfErr.blame,
          message: wfErr.message,
          hasScreenshot: Boolean(failShotUrl),
        },
      };
    }
  }

  return {
    ok: true,
    aborted: false,
    workflowId: directive.id,
    totalSteps: directive.steps.length,
    executedSteps,
    skippedSteps,
    durationMs: Math.max(1, Date.now() - startedMs),
    errorMessage: null,
    failure: null,
  };
}
