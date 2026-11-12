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
    if (k === "categoryMap" && v && typeof v === "object") {
      out.categoryKeys = Object.keys(v);
      continue;
    }
    if (k === "enKeywordDictionary" && Array.isArray(v)) {
      out.dictEntryCount = v.length;
      continue;
    }
    if (k === "navSteps" && Array.isArray(v)) {
      out.navStepCount = v.length;
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
  modals_count: `const ms=modals(Number(c.equals)===0?1:0),titles=ms.map(m=>norm((m.querySelector(".ant-modal-title")||{}).innerText));
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

  cascader_or_select_equals: `const inp=scope.querySelector(c.inputSelector);
const sel=inp?inp.closest(".ant-select"):null,it=sel?sel.querySelector(".ant-select-selection-item"):null,got=it?itemText(it):"";
if(got!==String(c.equals))return{pass:false,index:idx,kind:c.kind,expected:c.inputSelector+" 选中值 === "+JSON.stringify(c.equals),actual:"实读选中值 === "+JSON.stringify(got)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:got});`,

  input_equals: `const nth=Number(c.nth)||0,el=scope.querySelectorAll(c.selector)[nth],got=el?String(el.value??""):null;
if(got!==String(c.equals))return{pass:false,index:idx,kind:c.kind,expected:c.selector+" 值 === "+JSON.stringify(c.equals),actual:"实读值 === "+JSON.stringify(got)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:got});`,

  inputs_by_placeholder_equal: `const list=[...scope.querySelectorAll("input")].filter(inp=>inp.getAttribute("placeholder")===String(c.placeholder)).map(inp=>String(inp.value??""));
if(c.allEqual!==undefined){const w=String(c.allEqual),m=Number(c.minCount??1);if(list.length<m||list.some(v=>v!==w))return{pass:false,index:idx,kind:c.kind,expected:'placeholder="'+c.placeholder+'" 至少 '+m+" 项且全部 === "+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
else{const w=(c.equals||[]).map(String);if(JSON.stringify(list)!==JSON.stringify(w))return{pass:false,index:idx,kind:c.kind,expected:'placeholder="'+c.placeholder+'" 输入值序列 === '+JSON.stringify(w),actual:"实读序列 === "+JSON.stringify(list)};}
evidence.push({index:idx,id:checkId,kind:c.kind,placeholder:c.placeholder,actual:list});`,

  text_matches_regex: `const full=scopeText(scope),m=new RegExp(String(c.pattern),c.flags||"").exec(full);
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

  text_includes: `const full=scopeText(scope),missing=(c.mustInclude||[]).filter(sub=>!full.includes(norm(sub)));
if(missing.length)return{pass:false,index:idx,kind:c.kind,expected:"文本包含 "+JSON.stringify(c.mustInclude),actual:"缺少 "+JSON.stringify(missing)+"；实读片段: "+JSON.stringify(full.slice(0,260))};
const snippets=(c.mustInclude||[]).map(sub=>{const n=norm(sub),p=full.indexOf(n);return p>=0?full.slice(Math.max(0,p-16),p+n.length+64):"";});
evidence.push({index:idx,id:checkId,kind:c.kind,actual:snippets});`,

  text_excludes: `const full=scopeText(scope),found=(c.forbid||[]).find(sub=>sub&&full.includes(norm(sub)));
if(found)return{pass:false,index:idx,kind:c.kind,expected:"文本不包含 "+JSON.stringify(c.forbid),actual:"命中禁止文本: "+JSON.stringify(found)};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{excludedAll:c.forbid||[],sample:full.slice(0,180)}});`,

  images_min_count: `const imgs=[...scope.querySelectorAll(c.selector||"img")].filter(img=>{const s=String(img.getAttribute("src")||img.src||"").trim();return Boolean(s)&&!s.startsWith("data:image/svg+xml");});
const min=Number(c.minCount??1);
if(imgs.length<min)return{pass:false,index:idx,kind:c.kind,expected:(c.selector||"img")+" 有效图片数 >= "+min,actual:"实读有效图片数 === "+imgs.length};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{count:imgs.length,samples:imgs.slice(0,4).map(img=>({alt:img.alt||"",w:img.naturalWidth||0,h:img.naturalHeight||0}))}});`,

  confirmed_cards_min_count: `const btnTxt=normBtn(c.cardButtonText||""),pendTxt=norm(c.pendingText||""),scopeTxt=scopeText(scope),hasScopePend=Boolean(pendTxt&&scopeTxt.includes(pendTxt));
const rmBtns=[...scope.querySelectorAll("button")].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&(!btnTxt||normBtn(b.innerText)===btnTxt);});
const cards=rmBtns.map(b=>{let el=b.parentElement,best=b.parentElement;while(el&&el!==scope){if(el.querySelectorAll("button").length>1)break;if(el.querySelectorAll("img").length>1)break;if(el.querySelectorAll("img").length>=1)best=el;el=el.parentElement;}return norm((best||b).innerText);});
let confirmed=pendTxt?cards.filter(t=>!t.includes(pendTxt)):cards;
let pending=pendTxt?cards.filter(t=>t.includes(pendTxt)):[];
if(hasScopePend&&pending.length===0&&cards.length>0){pending=[cards[cards.length-1]];confirmed=cards.slice(0,cards.length-1);}
const minC=Number(c.minCount??1);
if(confirmed.length<minC)return{pass:false,index:idx,kind:c.kind,expected:"已确认卡片数 >= "+minC,actual:"实读已确认 === "+confirmed.length+"，待确认 === "+pending.length+" ("+JSON.stringify(cards.slice(0,8))+")"};
evidence.push({index:idx,id:checkId,kind:c.kind,actual:{confirmedCount:confirmed.length,pendingCount:pending.length,scopeHasPendingText:hasScopePend,confirmedCards:confirmed,pendingCards:pending}});`,

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
const leaveRe=/\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/;
const isBox=(el,al)=>{if(!el)return false;for(let p=el;p&&p.nodeType===1;p=p.parentElement){if(p.hidden||(!al&&leaveRe.test(String(p.className||""))))return false;const s=getComputedStyle(p);if(s&&(s.display==="none"||s.visibility==="hidden"))return false;}if(!el.getBoundingClientRect)return true;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
const qBox=sel=>{const a=[...document.querySelectorAll(sel)].filter(e=>isBox(e,0));if(a.length)return a.slice(-1)[0];const o=document.querySelector(sel);return isBox(o,0)?o:null;};
const modals=al=>[...document.querySelectorAll(".ant-modal")].filter(m=>isBox(m,al));
const defaultScope=containerSel?qBox(containerSel):(document.body||document.documentElement||document);
if(containerSel&&!defaultScope)return{pass:false,failedCheck:"container",expected:"容器存在: "+containerSel,actual:"容器不存在或正处于关闭离场动画"};
const pickScope=c=>c.topmostModal?(modals(0).slice(-1)[0]||null):(c.scopeSelector?qBox(c.scopeSelector):defaultScope);
const scopeText=s=>{const el=(s===document?(document.body||document.documentElement):s);return norm(el?(el.innerText??el.textContent??""):"");};
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

export function normalizeCategoryPathText(value) {
  return String(value ?? "")
    .replace(/\s*(?:->|\/|>|›)\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

export function synthesizeAsciiTitle({
  rawCnTitle = "",
  existingEnTitle = "",
  dictionary = [],
  prefix = "",
  suffix = "",
  fallbackTitle = "Standard Product Item",
  maxLen = 120,
} = {}) {
  const existing = normalizeSpaces(existingEnTitle);
  if (
    existing.length > 0 &&
    /^[\x20-\x7E]+$/.test(existing) &&
    !/\btest\b/i.test(existing)
  ) {
    return existing.length <= maxLen ? existing : existing.slice(0, maxLen).trim();
  }

  const cn = String(rawCnTitle || "");
  const tokens = [];
  const seenLower = new Set();
  const pushWords = (phrase) => {
    const clean = String(phrase || "")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;
    for (const word of clean.split(" ")) {
      if (!word || /\btest\b/i.test(word)) continue;
      const lw = word.toLowerCase();
      if (seenLower.has(lw)) continue;
      seenLower.add(lw);
      tokens.push(word);
    }
  };

  pushWords(prefix);
  const entries = Array.isArray(dictionary)
    ? dictionary
    : dictionary && typeof dictionary === "object"
      ? Object.entries(dictionary)
      : [];
  for (const entry of entries) {
    const [cnKey, enPhrase] = Array.isArray(entry)
      ? entry
      : [entry?.cn, entry?.en];
    if (cnKey && cn.includes(String(cnKey))) {
      pushWords(enPhrase);
    }
  }
  pushWords(suffix);

  let built = tokens.join(" ").trim();
  if (!built) {
    built = String(fallbackTitle || "Standard Product Item")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (built.length > maxLen) {
    const sliced = built.slice(0, maxLen);
    const lastSpace = sliced.lastIndexOf(" ");
    built = (lastSpace >= 24 ? sliced.slice(0, lastSpace) : sliced).trim();
  }
  return built;
}

export function resolveFormProfileFromSnapshot({
  snapshot = {},
  categoryMap = {},
  categoryOrder = [],
  enKeywordDictionary = [],
  noisePrefixRegex = "^[aA]{3,}",
  noiseSuffixRegex = "[bB]{3,}$",
  forbidTitleSubstrings = [],
  stepCtx = {},
} = {}) {
  const configuredKeys =
    Array.isArray(categoryOrder) && categoryOrder.length > 0
      ? categoryOrder.filter((k) => Object.prototype.hasOwnProperty.call(categoryMap, k))
      : Object.keys(categoryMap || {});

  const currentCatNorm = normalizeCategoryPathText(snapshot.currentCategory || "");
  const rawCn = String(snapshot.titleCnRaw ?? "");
  let cleanCn = rawCn;
  if (noisePrefixRegex) cleanCn = cleanCn.replace(new RegExp(noisePrefixRegex), "");
  if (noiseSuffixRegex) cleanCn = cleanCn.replace(new RegExp(noiseSuffixRegex), "");
  for (const bad of forbidTitleSubstrings) {
    if (bad) cleanCn = cleanCn.split(String(bad)).join("");
  }
  cleanCn = normalizeSpaces(cleanCn);

  const starredLabels = Array.isArray(snapshot.starredLabels)
    ? [...new Set(snapshot.starredLabels.map((s) => normalizeSpaces(s)).filter(Boolean))]
    : [];
  const starredReport =
    starredLabels.length > 0 ? starredLabels.join("、") : "(当前未渲染类目专属带*字段)";

  const allAllowedPaths = new Set();
  for (const key of configuredKeys) {
    const p = categoryMap[key];
    if (!p || typeof p !== "object") continue;
    if (p.categoryPath) allAllowedPaths.add(normalizeCategoryPathText(p.categoryPath));
    if (Array.isArray(p.allowedCategoryPaths)) {
      for (const ap of p.allowedCategoryPaths) {
        if (ap) allAllowedPaths.add(normalizeCategoryPathText(ap));
      }
    }
  }

  if (currentCatNorm && !allAllowedPaths.has(currentCatNorm)) {
    throw new WorkflowError({
      code: "WORKFLOW_CATEGORY_UNMAPPED",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "resolve_form_context",
      expected: `商品类目在已维护的类目映射表中（当前已配置: ${configuredKeys.join("、") || "无"}）`,
      actual: `缺少类目配置: 页面已选类目「${currentCatNorm}」（商品标题:「${cleanCn || rawCn || "(空)"}」）未配置；页面实读带*字段清单（共 ${starredLabels.length} 项）: ${starredReport}`,
      message: `未配置类目「${currentCatNorm}」，已停止并输出页面实读带*字段清单`,
    });
  }

  let matchedKey = "";
  let matchedProfile = null;
  const hay = cleanCn.toLowerCase();
  for (const key of configuredKeys) {
    const p = categoryMap[key];
    if (!p || typeof p !== "object") continue;
    const kws = Array.isArray(p.matchKeywords) ? p.matchKeywords : [];
    if (kws.some((kw) => kw && hay.includes(String(kw).toLowerCase()))) {
      matchedKey = key;
      matchedProfile = p;
      break;
    }
  }

  if (!matchedProfile) {
    throw new WorkflowError({
      code: "WORKFLOW_CATEGORY_UNMAPPED",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "resolve_form_context",
      expected: `商品命中类目映射表配置（当前已配置: ${configuredKeys.join("、") || "无"}）`,
      actual: `缺少类目配置: 商品「${cleanCn || rawCn || "(空)"}」（页面当前类目: ${currentCatNorm || "未选择"}）未匹配任何已配置类目；页面实读带*字段清单（共 ${starredLabels.length} 项）: ${starredReport}`,
      message: `商品未命中任何已配置类目映射，已停止并输出页面实读带*字段清单`,
    });
  }

  const profilePaths = new Set([
    normalizeCategoryPathText(matchedProfile.categoryPath || ""),
    ...(Array.isArray(matchedProfile.allowedCategoryPaths)
      ? matchedProfile.allowedCategoryPaths.map(normalizeCategoryPathText)
      : []),
  ].filter(Boolean));

  if (currentCatNorm && profilePaths.size > 0 && !profilePaths.has(currentCatNorm)) {
    throw new WorkflowError({
      code: "WORKFLOW_CATEGORY_CONFLICT",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "resolve_form_context",
      expected: `类目「${matchedKey}」路径属于 ${JSON.stringify([...profilePaths])}`,
      actual: `缺少对应类目路径配置: 商品「${cleanCn}」命中「${matchedKey}」，但页面当前类目为「${currentCatNorm}」；页面实读带*字段清单（共 ${starredLabels.length} 项）: ${starredReport}`,
      message: `商品页面类目与映射配置冲突: ${currentCatNorm}`,
    });
  }

  const resolvedCategoryPath =
    currentCatNorm && profilePaths.has(currentCatNorm)
      ? currentCatNorm
      : normalizeCategoryPathText(matchedProfile.categoryPath || "");

  const titleEn = synthesizeAsciiTitle({
    rawCnTitle: cleanCn,
    existingEnTitle: snapshot.titleEnRaw || "",
    dictionary: enKeywordDictionary,
    prefix: matchedProfile.enPrefix || "",
    suffix: matchedProfile.enSuffix || "",
    fallbackTitle: matchedProfile.enFallbackTitle || "Standard Fashion Item",
    maxLen: Number(matchedProfile.maxEnTitleLen) || 120,
  });

  return {
    categoryKey: matchedKey,
    categorySearch: String(matchedProfile.categorySearch || ""),
    categoryPath: resolvedCategoryPath,
    titleCn: cleanCn,
    titleEn,
    attrRules: Array.isArray(matchedProfile.attrRules) ? matchedProfile.attrRules : [],
    pkgLength: String(matchedProfile.pkgLength ?? ""),
    pkgWidth: String(matchedProfile.pkgWidth ?? ""),
    pkgHeight: String(matchedProfile.pkgHeight ?? ""),
    pkgWeight: String(matchedProfile.pkgWeight ?? ""),
    requiresSizeChart: Boolean(matchedProfile.requiresSizeChart),
    sizeChartName: String(matchedProfile.sizeChartName || ""),
    requiresModel: Boolean(matchedProfile.requiresModel),
    modelName: String(matchedProfile.modelName || ""),
    modelFitOption: String(matchedProfile.modelFitOption || ""),
    modelSizePrefer: Array.isArray(matchedProfile.modelSizePrefer)
      ? matchedProfile.modelSizePrefer.map(String)
      : [],
    starredLabels,
  };
}

export function formatWorkflowSummary({
  ok,
  aborted = false,
  workflowId = "",
  totalSteps = 0,
  executedSteps = 0,
  skippedSteps = 0,
  durationMs = 0,
  commitMode = "",
  commitElapsedMs = 0,
  mutationsCount = 0,
  targetSummary = "",
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
  const lines = [`✅ 确定性工作流执行通过（\`${workflowId}\`）`];
  if (targetSummary) {
    lines.push(`- 目标对象: ${targetSummary}`);
  }
  if (commitMode) {
    const modeLabel =
      commitMode === "committed_via_confirm"
        ? `首次填写+真实保存+回读校验（写入变更 ${mutationsCount} 项）`
        : `已保存态核对+幂等跳过（写入变更 ${mutationsCount} 项）`;
    lines.push(`- 运行路径: ${modeLabel}`);
    lines.push(`- 首次填写/核对耗时: ${Math.max(1, Math.round(commitElapsedMs))} ms`);
  }
  lines.push(`- 执行步数: ${executedSteps}/${totalSteps}（条件跳过 ${skippedSteps} 步）`);
  lines.push(`- 总耗时: ${Math.max(0, Math.round(durationMs))} ms`);
  lines.push(`- 模型调用: 0 回合 / 0 词元`);
  lines.push(`- 截图路径: ${shotsText}`);
  return lines.join("\n");
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

  const runtimeBinds = {
    ...(directive.binds && typeof directive.binds === "object" ? directive.binds : {}),
    runtime: {
      wasModified: false,
      requiresSizeChart: false,
      requiresModel: false,
      manualSampleVisibleOnPage: false,
      sizeChartVerifyItems: [],
      modelVerifyTexts: [],
      ...(directive.binds?.runtime && typeof directive.binds.runtime === "object"
        ? directive.binds.runtime
        : {}),
    },
  };
  let commitMeta = { mode: "", elapsedMs: 0 };

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

  async function closeModalsStack({
    modalSelector = ".ant-modal",
    cancelText = "取消",
    fallbackCloseSelector = ".ant-modal-close, button[aria-label='Close'], button[aria-label='关闭']",
    allowCloseFallback = true,
    maxAttempts = 5,
    settleMs = 1500,
    stepCtx,
    currentUrl = "",
  }) {
    let closedCount = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const nonce = `close_${++nonceCounter}`;
      const probe = await evalJs(
        `const sel = ${JSON.stringify(modalSelector)};
        const wantCancel = ${JSON.stringify(normalizeCjkText(cancelText))};
        const fbSel = ${JSON.stringify(allowCloseFallback ? String(fallbackCloseSelector || "") : "")};
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
        if (hit) {
          hit.setAttribute("data-pl-wf-act", nonce);
          return { count: visible.length, title, foundCancel: true, buttonText: norm(hit.innerText) };
        }
        if (fbSel) {
          const fbHit = [...topModal.querySelectorAll(fbSel)].find((b) => {
            const r = b.getBoundingClientRect();
            return !b.disabled && r.width > 0 && r.height > 0;
          });
          if (fbHit) {
            fbHit.setAttribute("data-pl-wf-act", nonce);
            return { count: visible.length, title, foundCancel: true, viaFallbackClose: true, buttonText: "" };
          }
        }
        return { count: visible.length, title, foundCancel: false, buttons: btns.map((b) => norm(b.innerText)).slice(0, 12) };`,
        stepCtx,
      );

      if (!probe || probe.count === 0) {
        break;
      }
      if (!probe.foundCancel) {
        throw new WorkflowError({
          code: "WORKFLOW_MODAL_CANCEL_NOT_FOUND",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: `弹窗 "${probe.title || modalSelector}" 存在可点击 "${cancelText}" 按钮`,
          actual: `可见按钮: ${JSON.stringify(probe.buttons || [])}`,
          message: `弹窗未找到 "${cancelText}" 按钮`,
        });
      }
      await clickMarkedElement({
        markNonce: nonce,
        buttonText: probe.viaFallbackClose ? "" : cancelText,
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
            const ms = getComputedStyle(m);
            const r = m.getBoundingClientRect();
            if (ws.display === "none" || ws.visibility === "hidden" || ms.display === "none" || ms.visibility === "hidden") return false;
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

    // 关键契约：不仅等待非离场态弹窗归零，还必须等待离场动画态（*-leave）弹窗彻底卸载或 display:none，
    // 防止下一步重开同类名弹窗时 wait_for / assert_state 误命中尚未销毁的旧弹窗 DOM。
    const settleDeadline = Date.now() + Math.max(settleMs, 2500);
    let finalCount = 0;
    while (true) {
      finalCount = await evalJs(
        `return [...document.querySelectorAll(${JSON.stringify(modalSelector)})].filter((m) => {
          const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
          const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
          const ms = getComputedStyle(m);
          const r = m.getBoundingClientRect();
          if (ws.display === "none" || ws.visibility === "hidden" || ms.display === "none" || ms.visibility === "hidden") return false;
          return r.width > 0 && r.height > 0;
        }).length;`,
        stepCtx,
      );
      if (finalCount === 0 || Date.now() >= settleDeadline) break;
      await sleepWithAbort(80, signal);
    }
    if (finalCount !== 0) {
      throw new WorkflowError({
        code: "WORKFLOW_MODAL_STILL_OPEN",
        blame: "工具",
        stepIndex: stepCtx.stepIndex,
        stepId: stepCtx.stepId,
        op: stepCtx.op,
        expected: "所有弹窗已彻底关闭并完成离场销毁 (remainingModals === 0)",
        actual: `仍余 ${finalCount} 个可见或离场中弹窗`,
        message: `关闭弹窗后仍残留 ${finalCount} 个弹窗`,
      });
    }
    return { ok: true, closedCount, remainingModals: 0 };
  }

  async function waitForModalsCountWithAlerts({
    wantModals = 0,
    modalSelector = ".ant-modal",
    timeoutMs = 12000,
    actionLabel = "",
    stepCtx,
  }) {
    const waitDeadline = Date.now() + timeoutMs;
    const excludeLeave = wantModals > 0;
    const seenAlerts = new Set();
    const seenErrorAlerts = new Set();
    let lastInfo = null;
    let errorSettledPolls = 0;

    while (true) {
      lastInfo = await evalJs(
        `const excludeLeave = ${JSON.stringify(excludeLeave)};
        const visible = [...document.querySelectorAll(${JSON.stringify(modalSelector)})].filter((m) => {
          const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
          const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
          const ms = getComputedStyle(m);
          const r = m.getBoundingClientRect();
          if (ws.display === "none" || ws.visibility === "hidden" || ms.display === "none" || ms.visibility === "hidden") return false;
          if (excludeLeave && ((wrap && /leave/.test(wrap.className || "")) || /leave/.test(m.className || ""))) return false;
          return r.width > 0 && r.height > 0;
        });
        const noticeNodes = [...document.querySelectorAll(".ant-message-notice, .ant-notification-notice, [role='alert']")];
        const alerts = [];
        const errorAlerts = [];
        for (const n of noticeNodes) {
          const t = (n.innerText || n.textContent || "").replace(/\\s+/g, " ").trim();
          if (!t) continue;
          alerts.push(t);
          const cls = String(n.className || "") + " " + String((n.firstElementChild || {}).className || "");
          const isErr = /error|danger/i.test(cls) || Boolean(n.querySelector(".ant-message-error, .ant-notification-notice-icon-error, .anticon-close-circle"));
          if (isErr) errorAlerts.push(t);
        }
        const loadingCount = visible.reduce((acc, m) => acc + m.querySelectorAll(".ant-btn-loading").length, 0);
        return {
          count: visible.length,
          titles: visible.map((m) => ((m.querySelector(".ant-modal-title") || {}).innerText || "").trim()),
          alerts,
          errorAlerts,
          loadingCount
        };`,
        stepCtx,
      );

      for (const a of lastInfo?.alerts || []) seenAlerts.add(a);
      for (const ea of lastInfo?.errorAlerts || []) seenErrorAlerts.add(ea);

      if (lastInfo?.count === wantModals) {
        return { seenAlerts: [...seenAlerts] };
      }

      if (seenErrorAlerts.size > 0 && Number(lastInfo?.loadingCount || 0) === 0) {
        errorSettledPolls += 1;
        if (errorSettledPolls >= 2) {
          throw new WorkflowError({
            code: "WORKFLOW_ACTION_ERROR_TOAST",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `${actionLabel ? `点击 "${actionLabel}" 后` : ""}无错误提示且可见弹窗数变为 ${wantModals}`,
            actual: `当前可见弹窗 ${lastInfo?.count} (${JSON.stringify(lastInfo?.titles || [])})，捕获瞬时错误提示: ${JSON.stringify([...seenErrorAlerts])}`,
            message: `页面返回瞬时错误提示: ${[...seenErrorAlerts].join("；")}`,
          });
        }
      } else {
        errorSettledPolls = 0;
      }

      if (Date.now() >= waitDeadline) {
        throw new WorkflowError({
          code: "WORKFLOW_WAIT_MODALS_COUNT_TIMEOUT",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex,
          stepId: stepCtx.stepId,
          op: stepCtx.op,
          expected: `可见弹窗数变为 ${wantModals}`,
          actual: `当前可见弹窗 ${lastInfo?.count} (${JSON.stringify(lastInfo?.titles || [])})，提示消息: ${JSON.stringify([...seenAlerts])}`,
          message: `等待弹窗数量变为 ${wantModals} 超时`,
        });
      }
      await sleepWithAbort(150, signal);
    }
  }

  async function probeModalCardCounts({
    topmostModal = true,
    containerSelector = "",
    cardButtonText = "",
    pendingText = "",
    acceptButtonText = "",
    stepCtx,
  }) {
    return evalJs(
      `const useTop = ${JSON.stringify(Boolean(topmostModal))};
      const containerSel = ${JSON.stringify(String(containerSelector || ""))};
      const cardBtnWant = ${JSON.stringify(normalizeCjkText(cardButtonText))};
      const pendWant = ${JSON.stringify(normalizeSpaces(pendingText))};
      const acceptWant = ${JSON.stringify(normalizeCjkText(acceptButtonText))};
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
      const visibleModals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
        const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
        const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
        const ms = getComputedStyle(m);
        const r = m.getBoundingClientRect();
        if (ws.display === "none" || ws.visibility === "hidden" || ms.display === "none" || ms.visibility === "hidden") return false;
        if ((wrap && /leave/.test(wrap.className || "")) || /leave/.test(m.className || "")) return false;
        return r.width > 0 && r.height > 0;
      });
      const scope = useTop
        ? (visibleModals[visibleModals.length - 1] || null)
        : (containerSel ? document.querySelector(containerSel) : (document.body || document.documentElement));
      if (!scope) return { scopeFound: false, confirmedCount: 0, pendingCount: 0, scopeHasPendingText: false, acceptVisible: false, cards: [] };
      const scopeTxt = norm(scope.innerText || "");
      const hasScopePend = Boolean(pendWant && scopeTxt.includes(pendWant));
      const rmBtns = [...scope.querySelectorAll("button")].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (!cardBtnWant || normBtn(b.innerText) === cardBtnWant);
      });
      const cards = rmBtns.map((b) => {
        let el = b.parentElement;
        let best = b.parentElement;
        while (el && el !== scope) {
          if (el.querySelectorAll("button").length > 1) break;
          if (el.querySelectorAll("img").length > 1) break;
          if (el.querySelectorAll("img").length >= 1) best = el;
          el = el.parentElement;
        }
        return norm((best || b).innerText);
      });
      let confirmed = pendWant ? cards.filter((t) => !t.includes(pendWant)) : cards;
      let pending = pendWant ? cards.filter((t) => t.includes(pendWant)) : [];
      if (hasScopePend && pending.length === 0 && cards.length > 0) {
        pending = [cards[cards.length - 1]];
        confirmed = cards.slice(0, cards.length - 1);
      }
      const acceptHit = acceptWant
        ? [...scope.querySelectorAll("button, [role='button'], a")].find((el) => {
            const r = el.getBoundingClientRect();
            return !el.disabled && r.width > 0 && r.height > 0 && normBtn(el.innerText) === acceptWant;
          })
        : null;
      return {
        scopeFound: true,
        confirmedCount: confirmed.length,
        pendingCount: pending.length,
        scopeHasPendingText: hasScopePend,
        confirmedCards: confirmed,
        pendingCards: pending,
        acceptVisible: Boolean(acceptHit)
      };`,
      stepCtx,
    );
  }

  async function executeStepOp(step, params, stepCtx, currentUrl, priorMutations = 0) {
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
        const fallbackCloseSelector =
          params.fallbackCloseSelector !== undefined
            ? String(params.fallbackCloseSelector)
            : ".ant-modal-close, button[aria-label='Close'], button[aria-label='关闭']";
        const allowCloseFallback = params.allowCloseFallback !== false;
        const maxAttempts = Math.max(1, Number(params.maxAttempts ?? params.maxRounds) || 5);
        const settleMs = Math.max(200, Number(params.settleMs) || 1500);
        return closeModalsStack({
          modalSelector,
          cancelText,
          fallbackCloseSelector,
          allowCloseFallback,
          maxAttempts,
          settleMs,
          stepCtx,
          currentUrl,
        });
      }

      case "ensure_page_entry": {
        const mustStartWith = params.mustStartWith ? String(params.mustStartWith) : "";
        const wrongHostHint = params.wrongHostHint
          ? String(params.wrongHostHint)
          : "请切回已登录的目标站点标签页后重试（执行器严格仅做页内导航，不跨站跳转）";
        const targetUrlIncludes = Array.isArray(params.targetUrlIncludes)
          ? params.targetUrlIncludes.map(String).filter(Boolean)
          : params.targetUrlIncludes
            ? [String(params.targetUrlIncludes)]
            : [];
        const targetHashQueryEquals =
          params.targetHashQueryEquals && typeof params.targetHashQueryEquals === "object"
            ? params.targetHashQueryEquals
            : null;
        const readySelector = params.readySelector ? String(params.readySelector) : "";
        const waitSpinClear = params.waitSpinClear !== false;
        const navSteps = Array.isArray(params.navSteps) ? params.navSteps : [];
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 12000);

        const probeEntryState = async () =>
          evalJs(
            `/* ensure_page_entry_probe */
            const readySel = ${JSON.stringify(readySelector)};
            const url = String(location.href || "");
            const hash = String(location.hash || "");
            const qIdx = hash.indexOf("?");
            const hashQueryStr = qIdx >= 0 ? hash.slice(qIdx + 1) : "";
            const searchQueryStr = String(location.search || "").replace(/^\\?/, "");
            const parsePairs = (qs) => {
              const out = {};
              if (!qs) return out;
              for (const part of qs.split("&")) {
                if (!part) continue;
                const eq = part.indexOf("=");
                const k = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
                const v = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : "");
                out[k] = v;
              }
              return out;
            };
            const queryMap = { ...parsePairs(searchQueryStr), ...parsePairs(hashQueryStr) };
            const isBox = (el) => {
              if (!el) return false;
              const st = getComputedStyle(el);
              if (st && (st.display === "none" || st.visibility === "hidden")) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const hasPasswordInput = [...document.querySelectorAll('input[type="password"]')].some(isBox);
            const readyEl = readySel ? [...document.querySelectorAll(readySel)].find(isBox) : true;
            const spinning = Boolean(
              readySel &&
                readyEl &&
                readyEl !== true &&
                readyEl.closest(".ant-spin-nested-loading")?.querySelector(".ant-spin-spinning")
            );
            return {
              url,
              title: String(document.title || ""),
              queryMap,
              hasPasswordInput,
              readyFound: Boolean(readyEl),
              spinning,
              bodySample: String(document.body ? document.body.innerText : "").slice(0, 1200)
            };`,
            stepCtx,
          );

        const isTargetUrlMatched = (st) => {
          const u = String(st?.url || "");
          if (targetUrlIncludes.some((sub) => !u.includes(sub))) return false;
          if (targetHashQueryEquals) {
            const qm = st?.queryMap || {};
            for (const [k, v] of Object.entries(targetHashQueryEquals)) {
              if (String(qm[k] ?? "") !== String(v)) return false;
            }
          }
          return true;
        };

        const checkEntryBlockers = (st) => {
          assertUrlNotForbidden(st?.url, directive.forbidUrlSubstrings, stepCtx);
          if (mustStartWith && !String(st?.url || "").startsWith(mustStartWith)) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTRY_WRONG_ORIGIN",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `起点标签页位于目标站点页内 (${mustStartWith}...)`,
              actual: `当前标签页 URL 为 ${st?.url || "(空)"}；${wrongHostHint}`,
              message: `当前标签页不在目标站点内，拒绝跨站跳转: ${st?.url || "(空)"}`,
            });
          }
          const extBlock = detectExternalBlocker({
            url: st?.url,
            title: st?.title,
            text: st?.bodySample,
          });
          if (extBlock) {
            throw new WorkflowError({
              code: "WORKFLOW_EXTERNAL_BLOCKER",
              blame: "其他",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: "站点处于已登录正常状态",
              actual: extBlock,
              message: extBlock,
            });
          }
          if (st?.hasPasswordInput || String(st?.queryMap?.view || "") === "login") {
            throw new WorkflowError({
              code: "WORKFLOW_EXTERNAL_BLOCKER",
              blame: "其他",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: "目标站点已登录，可直接进行页内导航",
              actual: `检测到未登录状态或登录框 (URL: ${st?.url || "(空)"})，请先人工完成登录`,
              message: "目标站点当前处于未登录状态",
            });
          }
        };

        let st = await probeEntryState();
        checkEntryBlockers(st);
        let navigated = false;

        if (!isTargetUrlMatched(st)) {
          navigated = true;
          for (const nav of navSteps) {
            checkAbort(signal);
            const kind = String(nav?.kind || "");
            if (kind === "close_modals") {
              await closeModalsStack({
                modalSelector: String(nav.modalSelector || ".ant-modal"),
                cancelText: String(nav.cancelText || "取消"),
                maxAttempts: Math.max(1, Number(nav.maxAttempts) || 4),
                settleMs: Math.max(200, Number(nav.settleMs) || 1200),
                stepCtx,
                currentUrl: st?.url || currentUrl,
              });
              continue;
            }
            if (kind === "click_if_visible") {
              const cNonce = `nav_${++nonceCounter}`;
              const sel = String(nav.selector || "button, a, [role='button']");
              const wantTxt = nav.text ? normalizeCjkText(nav.text) : "";
              const found = await evalJs(
                `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
                const want = ${JSON.stringify(wantTxt)};
                const hit = [...document.querySelectorAll(${JSON.stringify(sel)})].find((el) => {
                  const st = getComputedStyle(el);
                  if (el.disabled || (st && (st.display === "none" || st.visibility === "hidden"))) return false;
                  const r = el.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) return false;
                  return !want || norm(el.innerText || el.textContent).includes(want);
                });
                if (!hit) return { found: false };
                hit.setAttribute("data-pl-wf-act", ${JSON.stringify(cNonce)});
                return { found: true, text: norm(hit.innerText || hit.textContent) };`,
                stepCtx,
              );
              if (found?.found) {
                await clickMarkedElement({
                  markNonce: cNonce,
                  buttonText: nav.text ? String(nav.text) : "",
                  stepCtx,
                  targetUrl: st?.url || currentUrl,
                });
                await sleepWithAbort(Math.max(150, Number(nav.waitMs) || 450), signal);
                st = await probeEntryState();
                checkEntryBlockers(st);
                if (isTargetUrlMatched(st)) break;
              }
              continue;
            }
            if (kind === "scoped_menu_click") {
              const rootSel = String(nav.rootSelector || "nav, aside, body");
              const grpSel = String(nav.groupSelector || "div");
              const headSel = String(nav.headingSelector || "button");
              const headInc = String(nav.headingMustInclude || "").toLowerCase();
              const headExc = String(nav.headingExclude || "").toLowerCase();
              const itemSel = String(nav.subItemSelector || "button, a, li");
              const itemWant = normalizeCjkText(nav.itemText || "");

              const menuDeadline = Date.now() + Math.min(timeoutMs, 5000);
              let menuProbe = null;
              const mNonce = `menu_${++nonceCounter}`;
              while (true) {
                menuProbe = await evalJs(
                  `/* scoped_menu_probe */
                  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
                  const isBox = (el) => {
                    if (!el) return false;
                    const st = getComputedStyle(el);
                    if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                  };
                  const root = [...document.querySelectorAll(${JSON.stringify(rootSel)})].find(isBox);
                  if (!root) return { rootFound: false };
                  const groups = [...root.querySelectorAll(${JSON.stringify(grpSel)})].filter(isBox);
                  const groupHeads = groups.map((g) => {
                    const h = g.querySelector(${JSON.stringify(headSel)}) || g;
                    return { g, h, text: norm(h.innerText || h.textContent) };
                  });
                  const targetGrp = groupHeads.find((x) => {
                    const low = x.text.toLowerCase();
                    return (!${JSON.stringify(headInc)} || low.includes(${JSON.stringify(headInc)})) &&
                      (!${JSON.stringify(headExc)} || !low.includes(${JSON.stringify(headExc)}));
                  });
                  if (!targetGrp) {
                    return { rootFound: true, groupFound: false, availableGroups: groupHeads.map((x) => x.text).slice(0, 12) };
                  }
                  const subHit = [...targetGrp.g.querySelectorAll(${JSON.stringify(itemSel)})].find(
                    (el) => isBox(el) && norm(el.innerText || el.textContent) === ${JSON.stringify(itemWant)},
                  );
                  if (subHit) {
                    subHit.setAttribute("data-pl-wf-act", ${JSON.stringify(mNonce)});
                    return { rootFound: true, groupFound: true, itemReady: true, itemText: norm(subHit.innerText || subHit.textContent) };
                  }
                  if (isBox(targetGrp.h)) {
                    targetGrp.h.setAttribute("data-pl-wf-act", ${JSON.stringify(mNonce)});
                    return { rootFound: true, groupFound: true, itemReady: false, canExpandHeading: true, headingText: targetGrp.text };
                  }
                  return { rootFound: true, groupFound: true, itemReady: false, canExpandHeading: false };`,
                  stepCtx,
                );
                if (menuProbe?.itemReady || menuProbe?.canExpandHeading || Date.now() >= menuDeadline) break;
                await sleepWithAbort(150, signal);
              }

              if (!menuProbe?.rootFound || !menuProbe?.groupFound) {
                st = await probeEntryState();
                checkEntryBlockers(st);
                throw new WorkflowError({
                  code: "WORKFLOW_ENTRY_NAV_MISSING",
                  blame: "workflow",
                  stepIndex: stepCtx.stepIndex,
                  stepId: stepCtx.stepId,
                  op: stepCtx.op,
                  expected: `页面存在左侧导航容器 (${rootSel}) 及分组 "${nav.headingMustInclude || ""}"`,
                  actual: JSON.stringify({ url: st?.url, menuProbe }),
                  message: `无法在当前页面找到左侧导航菜单 "${nav.headingMustInclude} -> ${nav.itemText}"`,
                });
              }

              if (!menuProbe.itemReady && menuProbe.canExpandHeading) {
                await clickMarkedElement({
                  markNonce: mNonce,
                  buttonText: "",
                  stepCtx,
                  targetUrl: st?.url || currentUrl,
                });
                const subNonce = `menusub_${++nonceCounter}`;
                const subDeadline = Date.now() + 3500;
                let subProbe = null;
                while (true) {
                  subProbe = await evalJs(
                    `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
                    const isBox = (el) => {
                      if (!el) return false;
                      const st = getComputedStyle(el);
                      if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                      const r = el.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    };
                    const root = [...document.querySelectorAll(${JSON.stringify(rootSel)})].find(isBox);
                    const groups = root ? [...root.querySelectorAll(${JSON.stringify(grpSel)})].filter(isBox) : [];
                    const targetGrp = groups.find((g) => {
                      const h = g.querySelector(${JSON.stringify(headSel)}) || g;
                      const low = norm(h.innerText || h.textContent).toLowerCase();
                      return (!${JSON.stringify(headInc)} || low.includes(${JSON.stringify(headInc)})) &&
                        (!${JSON.stringify(headExc)} || !low.includes(${JSON.stringify(headExc)}));
                    });
                    const subHit = targetGrp
                      ? [...targetGrp.querySelectorAll(${JSON.stringify(itemSel)})].find(
                          (el) => isBox(el) && norm(el.innerText || el.textContent) === ${JSON.stringify(itemWant)},
                        )
                      : null;
                    if (!subHit) return { found: false };
                    subHit.setAttribute("data-pl-wf-act", ${JSON.stringify(subNonce)});
                    return { found: true };`,
                    stepCtx,
                  );
                  if (subProbe?.found || Date.now() >= subDeadline) break;
                  await sleepWithAbort(120, signal);
                }
                if (!subProbe?.found) {
                  throw new WorkflowError({
                    code: "WORKFLOW_ENTRY_SUBMENU_MISSING",
                    blame: "workflow",
                    stepIndex: stepCtx.stepIndex,
                    stepId: stepCtx.stepId,
                    op: stepCtx.op,
                    expected: `展开分组 "${nav.headingMustInclude}" 后出现子菜单 "${nav.itemText}"`,
                    actual: JSON.stringify(subProbe),
                    message: `展开导航分组后未找到子菜单 "${nav.itemText}"`,
                  });
                }
                await clickMarkedElement({
                  markNonce: subNonce,
                  buttonText: String(nav.itemText || ""),
                  stepCtx,
                  targetUrl: st?.url || currentUrl,
                });
              } else if (menuProbe.itemReady) {
                await clickMarkedElement({
                  markNonce: mNonce,
                  buttonText: String(nav.itemText || ""),
                  stepCtx,
                  targetUrl: st?.url || currentUrl,
                });
              }
            }
          }
        }

        const readyDeadline = Date.now() + timeoutMs;
        while (true) {
          st = await probeEntryState();
          checkEntryBlockers(st);
          if (isTargetUrlMatched(st) && st.readyFound && (!waitSpinClear || !st.spinning)) {
            break;
          }
          if (Date.now() >= readyDeadline) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTRY_READY_TIMEOUT",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `进入目标列表页就绪 (query=${JSON.stringify(targetHashQueryEquals || targetUrlIncludes)}, readySelector=${readySelector || "无"})`,
              actual: JSON.stringify({
                url: st?.url,
                queryMap: st?.queryMap,
                readyFound: st?.readyFound,
                spinning: st?.spinning,
              }),
              message: `页内导航后等待目标页面就绪超时`,
            });
          }
          await sleepWithAbort(150, signal);
        }

        if (params.closeModalsOnTarget !== false) {
          await closeModalsStack({
            modalSelector: String(params.modalSelector || ".ant-modal"),
            cancelText: String(params.cancelText || "取消"),
            maxAttempts: Math.max(1, Number(params.maxModalCloseAttempts) || 4),
            settleMs: 1500,
            stepCtx,
            currentUrl: st?.url || currentUrl,
          });
        }

        let activeTabText = "";
        if (params.ensureActiveTab && typeof params.ensureActiveTab === "object") {
          const tabCfg = params.ensureActiveTab;
          const tabContainerSel = String(tabCfg.containerSelector || ".ant-tabs");
          const tabItemSel = String(tabCfg.tabSelector || ".ant-tabs-tab");
          const activeCls = String(tabCfg.activeClass || "ant-tabs-tab-active");
          const allowedPrefixes = Array.isArray(tabCfg.allowedPrefixes)
            ? tabCfg.allowedPrefixes.map(String)
            : ["全部"];
          const targetPrefix = String(tabCfg.targetPrefix || allowedPrefixes[0] || "全部");
          const tNonce = `tab_${++nonceCounter}`;
          const tabProbe = await evalJs(
            `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const root = document.querySelector(${JSON.stringify(tabContainerSel)});
            if (!root) return { exists: false };
            const tabs = [...root.querySelectorAll(${JSON.stringify(tabItemSel)})];
            const active = tabs.find((t) => String(t.className || "").includes(${JSON.stringify(activeCls)}));
            const activeTxt = active ? norm(active.innerText || active.textContent) : "";
            const allowed = ${JSON.stringify(allowedPrefixes)};
            if (allowed.some((p) => activeTxt.startsWith(p))) {
              return { exists: true, alreadyAllowed: true, activeTxt };
            }
            const target = tabs.find((t) => norm(t.innerText || t.textContent).startsWith(${JSON.stringify(targetPrefix)}));
            if (!target) return { exists: true, alreadyAllowed: false, foundTarget: false, activeTxt };
            target.setAttribute("data-pl-wf-act", ${JSON.stringify(tNonce)});
            return { exists: true, alreadyAllowed: false, foundTarget: true, activeTxt, targetTxt: norm(target.innerText || target.textContent) };`,
            stepCtx,
          );
          activeTabText = tabProbe?.activeTxt || "";
          if (tabProbe?.exists && !tabProbe.alreadyAllowed && tabProbe.foundTarget) {
            await clickMarkedElement({
              markNonce: tNonce,
              buttonText: "",
              stepCtx,
              targetUrl: st?.url || currentUrl,
            });
            activeTabText = tabProbe.targetTxt || targetPrefix;
            await sleepWithAbort(350, signal);
          }
        }

        let headerCountsSnapshot = "";
        if (params.captureHeaderRegex || Array.isArray(params.checkSampleSubstrings)) {
          const hRegStr = params.captureHeaderRegex ? String(params.captureHeaderRegex) : "";
          const sampleSubs = Array.isArray(params.checkSampleSubstrings)
            ? params.checkSampleSubstrings.map(String).filter(Boolean)
            : [];
          const snapMeta = await evalJs(
            `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const bodyTxt = norm(document.body ? document.body.innerText : "");
            const hRe = ${JSON.stringify(hRegStr)} ? new RegExp(${JSON.stringify(hRegStr)}) : null;
            const hm = hRe ? hRe.exec(bodyTxt) : null;
            const subs = ${JSON.stringify(sampleSubs)};
            let sampleVisible = false;
            if (subs.length > 0) {
              const rows = [...document.querySelectorAll("tbody tr")].filter((r) => {
                const rc = r.getBoundingClientRect();
                return rc.width > 0 && rc.height > 0;
              });
              sampleVisible = rows.some((r) => {
                const t = norm(r.innerText);
                return subs.every((k) => t.includes(k));
              });
            }
            return { headerMatch: hm ? norm(hm[0]) : "", sampleVisible };`,
            stepCtx,
          );
          if (snapMeta?.headerMatch) {
            headerCountsSnapshot = snapMeta.headerMatch;
            const escapedTokens = headerCountsSnapshot
              .split(/\s+/)
              .filter(Boolean)
              .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const patKey = String(params.saveHeaderPatternBindKey || "headerCountsPattern");
            runtimeBinds.runtime[patKey] = escapedTokens.join("\\s*");
            runtimeBinds.runtime.headerCountsSnapshot = headerCountsSnapshot;
          } else if (params.captureHeaderRegex) {
            throw new WorkflowError({
              code: "WORKFLOW_HEADER_COUNTS_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `列表顶部状态统计匹配 /${params.captureHeaderRegex}/`,
              actual: "页面未读取到状态统计计数栏",
              message: "未能从列表页读取顶部状态统计计数",
            });
          }
          if (sampleSubs.length > 0) {
            runtimeBinds.runtime.manualSampleVisibleOnPage = Boolean(snapMeta?.sampleVisible);
          }
        }

        return {
          ok: true,
          navigated,
          url: st?.url || "",
          ...(activeTabText ? { activeTab: activeTabText } : {}),
          ...(headerCountsSnapshot ? { headerCountsSnapshot } : {}),
        };
      }

      case "select_row_and_open": {
        const rowSelector = String(params.rowSelector || "tbody tr");
        const targetClaimedAt = normalizeSpaces(params.targetClaimedAt || "");
        const targetSourceId = normalizeSpaces(params.targetSourceId || "");
        const excludeSubstrings = Array.isArray(params.excludeSubstrings)
          ? params.excludeSubstrings.map(String).filter(Boolean)
          : [];
        const invalidTitleSubstrings = Array.isArray(params.invalidTitleSubstrings)
          ? params.invalidTitleSubstrings.map(String).filter(Boolean)
          : ["未命名商品"];
        const declarePriceColHeader = String(params.declarePriceColHeader || "申报价");
        const sourcePriceColHeader = String(params.sourcePriceColHeader || "货源价格");
        const titleSelector = String(params.titleSelector || ".collection-box-product__title");
        const priceRegex = String(params.priceRegex || "(?:CNY|USD|¥|￥)\\s*(\\d+(?:\\.\\d+)?)");
        const claimTimeRegex = String(params.claimTimeRegex || "\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}");
        const uneditedTitleRegex = String(params.uneditedTitleRegex || "^[aA]{3,}|[bB]{3,}$");
        const buttonText = String(params.buttonText || "编辑");
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 12000);

        const explicitInput = `${targetClaimedAt} ${targetSourceId}`.trim();
        if (explicitInput) {
          const hitForbidParam = excludeSubstrings.find((ex) => ex && explicitInput.includes(ex));
          if (hitForbidParam) {
            throw new WorkflowError({
              code: "WORKFLOW_FORBIDDEN_ROW",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `指定目标不得指向禁触标准样本 ${JSON.stringify(excludeSubstrings)}`,
              actual: `输入目标参数 "${explicitInput}" 命中禁触保护项 "${hitForbidParam}"`,
              message: `拒绝操作禁触手工标准样本: ${hitForbidParam}`,
            });
          }
        }

        const selectionMode = targetClaimedAt || targetSourceId ? "by_claim_time" : "next_unedited";
        const deadline = Date.now() + timeoutMs;
        const rNonce = `selrow_${++nonceCounter}`;
        let probe = null;

        while (true) {
          probe = await evalJs(
            `/* select_row_and_open_probe */
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
            const ths = [...document.querySelectorAll("thead th")];
            const decColIdx = ths.findIndex((th) => norm(th.innerText || th.textContent).includes(${JSON.stringify(declarePriceColHeader)}));
            const srcColIdx = ths.findIndex((th) => norm(th.innerText || th.textContent).includes(${JSON.stringify(sourcePriceColHeader)}));
            const rawRows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})].filter((r) => {
              const cls = String(r.className || "");
              if (cls.includes("ant-table-measure-row") || cls.includes("ant-table-placeholder")) return false;
              const rc = r.getBoundingClientRect();
              return rc.width > 0 && rc.height > 0;
            });
            const pRe = new RegExp(${JSON.stringify(priceRegex)});
            const tRe = new RegExp(${JSON.stringify(claimTimeRegex)});
            const uRe = new RegExp(${JSON.stringify(uneditedTitleRegex)});
            const excludes = ${JSON.stringify(excludeSubstrings)};
            const invalids = ${JSON.stringify(invalidTitleSubstrings)};
            const wantTime = ${JSON.stringify(targetClaimedAt)};
            const wantSrcId = ${JSON.stringify(targetSourceId)};
            const mode = ${JSON.stringify(selectionMode)};
            const wantBtn = ${JSON.stringify(normalizeCjkText(buttonText))};

            const parsed = rawRows.map((r, idx) => {
              const text = norm(r.innerText);
              const hrefs = [...r.querySelectorAll("a[href]")].map((a) => String(a.getAttribute("href") || "")).join(" ");
              const tEl = r.querySelector(${JSON.stringify(titleSelector)});
              const title = tEl ? norm(tEl.innerText || tEl.textContent) : "";
              const decCell = decColIdx >= 0 && r.cells && r.cells[decColIdx] ? norm(r.cells[decColIdx].innerText) : "";
              const srcCell = srcColIdx >= 0 && r.cells && r.cells[srcColIdx] ? norm(r.cells[srcColIdx].innerText) : "";
              const pm = pRe.exec(srcCell || text);
              const tm = tRe.exec(text);
              const idm = /-g-(\\d+)\\.html/i.exec(hrefs);
              const priceText = pm ? pm[0].replace(/\\s+/g, "") : "";
              const priceNum = pm ? pm[1] : "";
              const claimedAt = tm ? norm(tm[0]) : "";
              const sourceId = idm ? idm[1] : "";
              const excluded = excludes.some((ex) => text.includes(ex) || hrefs.includes(ex));
              const invalid = invalids.some((inv) => (title && title.includes(inv)) || text.includes(inv)) || !priceNum || !claimedAt;
              const isUnedited = decColIdx >= 0 ? decCell === "-" || decCell === "" : (title ? uRe.test(title) : uRe.test(text));
              return { r, idx, text, title, decCell, priceText, priceNum, claimedAt, sourceId, excluded, invalid, isUnedited };
            });

            let candidates = [];
            if (mode === "by_claim_time") {
              candidates = parsed.filter(
                (x) =>
                  !x.excluded &&
                  (!wantTime || x.text.includes(wantTime)) &&
                  (!wantSrcId || x.sourceId === wantSrcId || x.text.includes(wantSrcId)),
              );
              if (candidates.length !== 1) {
                return {
                  ok: false,
                  reason: "match_count",
                  mode,
                  count: candidates.length,
                  totalRows: parsed.length,
                  samples: parsed.slice(0, 6).map((x) => ({ claimedAt: x.claimedAt, priceText: x.priceText, title: x.title.slice(0, 40), excluded: x.excluded }))
                };
              }
            } else {
              const firstUnedited = parsed.find((x) => !x.excluded && !x.invalid && x.isUnedited);
              if (!firstUnedited) {
                return {
                  ok: false,
                  reason: "no_unedited",
                  mode,
                  totalRows: parsed.length,
                  samples: parsed.slice(0, 8).map((x) => ({ claimedAt: x.claimedAt, priceText: x.priceText, decCell: x.decCell, title: x.title.slice(0, 40), excluded: x.excluded, invalid: x.invalid }))
                };
              }
              candidates = [firstUnedited];
            }

            const chosen = candidates[0];
            if (chosen.invalid) {
              return {
                ok: false,
                reason: "chosen_invalid",
                chosen: { claimedAt: chosen.claimedAt, priceText: chosen.priceText, title: chosen.title }
              };
            }
            const btn = [...chosen.r.querySelectorAll("button")].find((b) => {
              const rc = b.getBoundingClientRect();
              return !b.disabled && rc.width > 0 && rc.height > 0 && normBtn(b.innerText) === wantBtn;
            });
            if (!btn) {
              return { ok: false, reason: "no_button", chosen: { claimedAt: chosen.claimedAt, title: chosen.title } };
            }
            btn.setAttribute("data-pl-wf-act", ${JSON.stringify(rNonce)});
            return {
              ok: true,
              mode,
              claimedAt: chosen.claimedAt,
              priceText: chosen.priceText,
              priceNum: chosen.priceNum,
              sourceId: chosen.sourceId,
              title: chosen.title,
              isUnedited: chosen.isUnedited,
              rowIndex: chosen.idx + 1
            };`,
            stepCtx,
          );

          if (probe?.ok) break;
          if (Date.now() >= deadline) {
            if (probe?.reason === "no_unedited") {
              throw new WorkflowError({
                code: "WORKFLOW_NO_UNEDITED_ROW",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: "当前列表页存在至少 1 件未编辑有效商品（排除禁触样本及缺货源价异常行）",
                actual: `总行数=${probe?.totalRows ?? 0}，未找到未编辑有效行: ${JSON.stringify(probe?.samples || [])}`,
                message: "当前页无待首次填写的未编辑商品；如需核对已保存商品，请在 binds.target.claimedAt 指定认领时间",
              });
            }
            throw new WorkflowError({
              code: "WORKFLOW_SELECT_ROW_FAILED",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected:
                selectionMode === "by_claim_time"
                  ? `唯一命中指定认领时间 "${targetClaimedAt}" 的有效商品行且含可用 "${buttonText}" 按钮`
                  : `命中下一件未编辑商品行且含可用 "${buttonText}" 按钮`,
              actual: JSON.stringify(probe),
              message: `目标商品行定位失败 (${probe?.reason || "timeout"})`,
            });
          }
          await sleepWithAbort(200, signal);
        }

        runtimeBinds.runtime.selectionMode = probe.mode;
        runtimeBinds.runtime.claimedAt = probe.claimedAt;
        runtimeBinds.runtime.sourcePriceText = probe.priceText;
        runtimeBinds.runtime.sourcePriceNumber = probe.priceNum;
        runtimeBinds.runtime.sourceProductId = probe.sourceId || "";
        runtimeBinds.runtime.rowInitialTitle = probe.title || "";
        runtimeBinds.runtime.rowInitiallyUnedited = Boolean(probe.isUnedited);
        runtimeBinds.runtime.targetSummary = [
          probe.sourceId ? `ID:${probe.sourceId}` : "",
          probe.claimedAt,
          probe.priceText,
          probe.isUnedited ? "初始未编辑" : "初始已保存",
        ]
          .filter(Boolean)
          .join(" · ");

        await clickMarkedElement({
          markNonce: rNonce,
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
              message: `点击 "${buttonText}" 后等待编辑弹窗超时`,
            });
          }
        }

        return {
          ok: true,
          selectionMode: probe.mode,
          rowIndex: probe.rowIndex,
          claimedAt: probe.claimedAt,
          sourcePriceText: probe.priceText,
          sourceProductId: probe.sourceId || null,
          rowInitiallyUnedited: Boolean(probe.isUnedited),
        };
      }

      case "ensure_checkboxes": {
        const containerSelector = String(params.containerSelector || "body");
        const wantList = Array.isArray(params.equals) ? params.equals.map((s) => normalizeSpaces(s)).filter(Boolean) : [];
        const ignoreList = Array.isArray(params.ignoreLabels)
          ? params.ignoreLabels.map((s) => normalizeSpaces(s))
          : ["全选"];
        const hydrateWaitMs = Math.max(0, Number(params.hydrateWaitMs) || 0);
        let mutatedCount = 0;

        if (hydrateWaitMs > 0) {
          const hDeadline = Date.now() + hydrateWaitMs;
          while (true) {
            const hProbe = await evalJs(
              `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
              const scope = document.querySelector(${JSON.stringify(containerSelector)});
              if (!scope) return { scopeFound: false };
              const ignore = new Set(${JSON.stringify(ignoreList)});
              const want = new Set(${JSON.stringify(wantList)});
              const items = [...scope.querySelectorAll('input[type="checkbox"]')].map((cb) => {
                const lbl = cb.closest("label");
                return { checked: Boolean(cb.checked), text: lbl ? norm(lbl.innerText || lbl.textContent) : "" };
              }).filter((x) => x.text && !ignore.has(x.text));
              const curChecked = items.filter((x) => x.checked).map((x) => x.text);
              const allMatch = items.length > 0 && curChecked.length === want.size && curChecked.every((t) => want.has(t));
              return { scopeFound: true, allMatch, checked: curChecked, count: items.length };`,
              stepCtx,
            );
            if (hProbe?.allMatch) {
              return { ok: true, skipped: true, mutatedCount: 0, checked: hProbe.checked };
            }
            if (Date.now() >= hDeadline) break;
            await sleepWithAbort(120, signal);
          }
        }

        for (let round = 0; round < wantList.length + 4; round += 1) {
          const cbNonce = `cb_${++nonceCounter}`;
          const cbProbe = await evalJs(
            `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const scope = document.querySelector(${JSON.stringify(containerSelector)});
            if (!scope) return { scopeFound: false };
            const ignore = new Set(${JSON.stringify(ignoreList)});
            const want = new Set(${JSON.stringify(wantList)});
            const items = [...scope.querySelectorAll('input[type="checkbox"]')].map((cb) => {
              const lbl = cb.closest("label");
              return { cb, lbl, checked: Boolean(cb.checked), text: lbl ? norm(lbl.innerText || lbl.textContent) : "" };
            }).filter((x) => x.text && !ignore.has(x.text));
            const curChecked = items.filter((x) => x.checked).map((x) => x.text);
            const toClick = items.find((x) => (want.has(x.text) && !x.checked) || (!want.has(x.text) && x.checked));
            if (!toClick) {
              const missing = [...want].filter((w) => !items.some((x) => x.text === w));
              return { scopeFound: true, done: missing.length === 0, missing, checked: curChecked, allLabels: items.map((x) => x.text) };
            }
            (toClick.lbl || toClick.cb).setAttribute("data-pl-wf-act", ${JSON.stringify(cbNonce)});
            return { scopeFound: true, done: false, toggleText: toClick.text };`,
            stepCtx,
          );
          if (!cbProbe?.scopeFound) {
            throw new WorkflowError({
              code: "WORKFLOW_CHECKBOX_SCOPE_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `复选框容器存在: ${containerSelector}`,
              actual: "容器未找到",
              message: `未找到复选框容器: ${containerSelector}`,
            });
          }
          if (cbProbe.done) {
            return { ok: true, skipped: mutatedCount === 0, mutatedCount, checked: cbProbe.checked };
          }
          if (!cbProbe.toggleText) {
            throw new WorkflowError({
              code: "WORKFLOW_CHECKBOX_OPTION_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `复选框组包含 ${JSON.stringify(wantList)}`,
              actual: `缺少 ${JSON.stringify(cbProbe.missing || [])}；可选: ${JSON.stringify(cbProbe.allLabels || [])}`,
              message: `未找到目标复选框选项`,
            });
          }
          await clickMarkedElement({
            markNonce: cbNonce,
            buttonText: cbProbe.toggleText,
            stepCtx,
            targetUrl: currentUrl,
          });
          mutatedCount += 1;
          await sleepWithAbort(120, signal);
        }
        return { ok: true, skipped: mutatedCount === 0, mutatedCount };
      }

      case "resolve_form_context": {
        const phase = params.phase === "sales" ? "sales" : "category";
        const containerSelector = String(params.containerSelector || ".ant-modal");
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 8000);

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

        if (phase === "category") {
          const categoryInputSelector = String(params.categoryInputSelector || "input#category");
          const titleCnSelector = String(params.titleCnSelector || "input#productNameCn");
          const titleEnSelector = String(params.titleEnSelector || "input#productName");
          const attrFieldSelector = String(params.attrFieldSelector || ".store-template-attr__field");
          const attrLabelSelector = String(params.attrLabelSelector || ".store-template-attr__label");

          const deadline = Date.now() + Math.min(timeoutMs, 6000);
          let snap = null;
          while (true) {
            snap = await evalJs(
              `/* resolve_form_context_category */
              const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
              const isLive = (n) => {
                if (!n) return false;
                for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                  const cl = String(p.className || "");
                  if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                  const st = getComputedStyle(p);
                  if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                }
                return true;
              };
              const roots = [...document.querySelectorAll(${JSON.stringify(containerSelector)})].filter(isLive);
              const root = roots[roots.length - 1] || null;
              if (!root) return { ready: false, reason: "no_container" };
              const cnEl = root.querySelector(${JSON.stringify(titleCnSelector)});
              if (!cnEl) return { ready: false, reason: "no_title_input" };
              const catSpin = Boolean(root.querySelector("#category .ant-spin-spinning"));
              if (catSpin) return { ready: false, reason: "category_spinning" };
              const enEl = root.querySelector(${JSON.stringify(titleEnSelector)});
              const catInp = root.querySelector(${JSON.stringify(categoryInputSelector)});
              const catWrap = catInp ? catInp.closest(".ant-select") : null;
              const catItem = catWrap ? catWrap.querySelector(".ant-select-selection-item") : null;
              const currentCategory = catItem
                ? norm((catItem.querySelector(".ant-select-selection-item-content") || catItem).textContent || "")
                : "";
              const starred = [];
              for (const f of root.querySelectorAll(${JSON.stringify(attrFieldSelector)})) {
                const l = norm((f.querySelector(${JSON.stringify(attrLabelSelector)}) || {}).innerText || "");
                if (l && (l.includes("*") || f.querySelector(".ant-form-item-required, .is-required"))) {
                  starred.push(l);
                }
              }
              for (const fi of root.querySelectorAll(".ant-form-item")) {
                const lblEl = fi.querySelector(".ant-form-item-label");
                if (!lblEl) continue;
                const l = norm(lblEl.innerText || "");
                const req = l.includes("*") || Boolean(lblEl.querySelector(".ant-form-item-required"));
                if (req && l) starred.push(l.startsWith("*") ? l : "*" + l);
              }
              return {
                ready: true,
                currentCategory,
                titleCnRaw: String(cnEl.value ?? ""),
                titleEnRaw: enEl ? String(enEl.value ?? "") : "",
                starredLabels: starred
              };`,
              stepCtx,
            );
            if (snap?.ready || Date.now() >= deadline) break;
            await sleepWithAbort(120, signal);
          }

          if (!snap?.ready) {
            throw new WorkflowError({
              code: "WORKFLOW_FORM_CONTEXT_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `弹窗表单完成挂载与类目水合 (${containerSelector})`,
              actual: JSON.stringify(snap),
              message: "读取商品弹窗上下文超时",
            });
          }

          const resolved = resolveFormProfileFromSnapshot({
            snapshot: snap,
            categoryMap: params.categoryMap || {},
            categoryOrder: Array.isArray(params.categoryOrder) ? params.categoryOrder : [],
            enKeywordDictionary: Array.isArray(params.enKeywordDictionary) ? params.enKeywordDictionary : [],
            noisePrefixRegex: params.noisePrefixRegex ?? "^[aA]{3,}",
            noiseSuffixRegex: params.noiseSuffixRegex ?? "[bB]{3,}$",
            forbidTitleSubstrings: Array.isArray(params.forbidTitleSubstrings)
              ? params.forbidTitleSubstrings
              : ["测试"],
            stepCtx,
          });

          Object.assign(runtimeBinds.runtime, {
            categoryKey: resolved.categoryKey,
            categorySearch: resolved.categorySearch,
            categoryPath: resolved.categoryPath,
            titleCn: resolved.titleCn,
            titleEn: resolved.titleEn,
            attrRules: resolved.attrRules,
            pkgLength: resolved.pkgLength,
            pkgWidth: resolved.pkgWidth,
            pkgHeight: resolved.pkgHeight,
            pkgWeight: resolved.pkgWeight,
            requiresSizeChart: resolved.requiresSizeChart,
            sizeChartName: resolved.sizeChartName,
            requiresModel: resolved.requiresModel,
            modelName: resolved.modelName,
            modelFitOption: resolved.modelFitOption,
            modelSizePrefer: resolved.modelSizePrefer,
          });
          if (runtimeBinds.runtime.targetSummary) {
            runtimeBinds.runtime.targetSummary = `${resolved.categoryKey} · ${runtimeBinds.runtime.targetSummary}`;
          }

          return {
            ok: true,
            phase: "category",
            categoryKey: resolved.categoryKey,
            categoryPath: resolved.categoryPath,
            titleCn: resolved.titleCn,
            titleEn: resolved.titleEn,
            requiresSizeChart: resolved.requiresSizeChart,
            requiresModel: resolved.requiresModel,
          };
        }

        const skuTableSelector = String(params.skuTableSelector || ".store-template__sku-list");
        const sDeadline = Date.now() + timeoutMs;
        let salesSnap = null;
        while (true) {
          salesSnap = await evalJs(
            `/* resolve_form_context_sales */
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const isLive = (n) => {
              if (!n) return false;
              for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                const cl = String(p.className || "");
                if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                const st = getComputedStyle(p);
                if (st && (st.display === "none" || st.visibility === "hidden")) return false;
              }
              return true;
            };
            const roots = [...document.querySelectorAll(${JSON.stringify(containerSelector)})].filter(isLive);
            const root = roots[roots.length - 1] || document;
            const wrap = root.querySelector(${JSON.stringify(skuTableSelector)});
            if (!wrap) return { ready: false, reason: "no_sku_list" };
            const rows = [...wrap.querySelectorAll("tbody tr")].filter((r) => {
              const cls = String(r.className || "");
              if (cls.includes("ant-table-measure-row") || cls.includes("ant-table-placeholder")) return false;
              const rc = r.getBoundingClientRect();
              return rc.width > 0 && rc.height > 0;
            });
            if (!rows.length) return { ready: false, reason: "zero_sku_rows" };
            const ths = [...wrap.querySelectorAll("thead th")].map((th) => norm(th.innerText || th.textContent));
            const refIdx = ths.findIndex((t) => t.includes("参考链接") || t.includes("申报价"));
            const specEnd = refIdx > 0 ? refIdx : Math.min(3, ths.length);
            const firstSpecTokens = [];
            const allSpecTokens = [];
            rows.forEach((r, rIdx) => {
              const cells = [...(r.cells || [])];
              for (let c = 0; c < specEnd && c < cells.length; c += 1) {
                if (ths[c] && ths[c].includes("预览图")) continue;
                const v = norm(cells[c].innerText || cells[c].textContent);
                if (v && v !== "-") {
                  if (rIdx === 0) firstSpecTokens.push(v);
                  if (!allSpecTokens.includes(v)) allSpecTokens.push(v);
                }
              }
            });
            const readPh = (ph) =>
              [...wrap.querySelectorAll("input")]
                .filter((i) => i.getAttribute("placeholder") === ph && isLive(i))
                .map((i) => String(i.value ?? "").trim());
            return {
              ready: true,
              skuRowCount: rows.length,
              firstSpecTokens,
              allSpecTokens,
              prices: readPh("单位元"),
              stocks: readPh("未填默认0"),
              lens: readPh("长"),
              widths: readPh("宽"),
              heights: readPh("高"),
              weights: readPh("重量")
            };`,
            stepCtx,
          );
          if (salesSnap?.ready || Date.now() >= sDeadline) break;
          await sleepWithAbort(150, signal);
        }

        if (!salesSnap?.ready) {
          throw new WorkflowError({
            code: "WORKFLOW_SKU_CONTEXT_TIMEOUT",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `SKU 列表至少渲染 1 行有效规格 (${skuTableSelector})`,
            actual: JSON.stringify(salesSnap),
            message: "销售属性 SKU 列表未渲染出有效规格行",
          });
        }

        const isUniformPositive = (arr) =>
          Array.isArray(arr) &&
          arr.length > 0 &&
          arr.every((v) => /^\d+(?:\.\d+)?$/.test(v) && Number(v) > 0 && v === arr[0]);
        const isUniformNonNegInt = (arr) =>
          Array.isArray(arr) &&
          arr.length > 0 &&
          arr.every((v) => /^\d+$/.test(v) && v === arr[0]);

        const resolvedSkuPrice = isUniformPositive(salesSnap.prices)
          ? salesSnap.prices[0]
          : String(runtimeBinds.runtime.sourcePriceNumber || "");
        if (!resolvedSkuPrice || !(Number(resolvedSkuPrice) > 0)) {
          throw new WorkflowError({
            code: "WORKFLOW_SKU_PRICE_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: "从列表货源价格或已填申报价解析出正数价格",
            actual: JSON.stringify({
              prices: salesSnap.prices,
              sourcePriceNumber: runtimeBinds.runtime.sourcePriceNumber,
            }),
            message: "无法解析有效的 SKU 申报价",
          });
        }

        const resolvedSkuStock = isUniformNonNegInt(salesSnap.stocks) ? salesSnap.stocks[0] : "0";
        const hasValidSavedVolume =
          isUniformPositive(salesSnap.lens) &&
          isUniformPositive(salesSnap.widths) &&
          isUniformPositive(salesSnap.heights) &&
          isUniformPositive(salesSnap.weights) &&
          Number(salesSnap.lens[0]) >= Number(salesSnap.widths[0]) &&
          Number(salesSnap.widths[0]) >= Number(salesSnap.heights[0]);

        if (hasValidSavedVolume) {
          runtimeBinds.runtime.pkgLength = salesSnap.lens[0];
          runtimeBinds.runtime.pkgWidth = salesSnap.widths[0];
          runtimeBinds.runtime.pkgHeight = salesSnap.heights[0];
          runtimeBinds.runtime.pkgWeight = salesSnap.weights[0];
        }
        runtimeBinds.runtime.skuPrice = resolvedSkuPrice;
        runtimeBinds.runtime.skuStock = resolvedSkuStock;
        runtimeBinds.runtime.skuRowCount = salesSnap.skuRowCount;
        runtimeBinds.runtime.skuMustIncludeTexts = [
          ...(Array.isArray(salesSnap.firstSpecTokens) ? salesSnap.firstSpecTokens.slice(0, 2) : []),
          "否",
        ];
        const prevPrefer = Array.isArray(runtimeBinds.runtime.modelSizePrefer)
          ? runtimeBinds.runtime.modelSizePrefer
          : [];
        const mergedSizePrefer = [];
        for (const tok of [...(salesSnap.allSpecTokens || []), ...prevPrefer]) {
          const s = String(tok || "").trim();
          if (s && !mergedSizePrefer.includes(s)) mergedSizePrefer.push(s);
        }
        runtimeBinds.runtime.modelSizePrefer = mergedSizePrefer;

        return {
          ok: true,
          phase: "sales",
          skuRowCount: salesSnap.skuRowCount,
          skuPrice: resolvedSkuPrice,
          skuStock: resolvedSkuStock,
          pkg: [
            runtimeBinds.runtime.pkgLength,
            runtimeBinds.runtime.pkgWidth,
            runtimeBinds.runtime.pkgHeight,
            runtimeBinds.runtime.pkgWeight,
          ],
          skuMustIncludeTexts: runtimeBinds.runtime.skuMustIncludeTexts,
          modelSizePrefer: mergedSizePrefer,
        };
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
        const containerSelector = String(
          params.containerSelector ||
            (params.scrollLeft !== undefined || params.fallbackSelector ? params.selector || "" : ""),
        );
        const fallbackSelector = String(params.fallbackSelector || "");
        const direction =
          params.scrollLeft === "max"
            ? "maxRight"
            : params.scrollLeft === 0 || params.scrollLeft === "min"
              ? "maxLeft"
              : String(params.direction || "down");
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
          `const el =
            document.querySelector(${JSON.stringify(containerSelector)}) ||
            (${JSON.stringify(fallbackSelector)} ? document.querySelector(${JSON.stringify(fallbackSelector)}) : null);
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
            expected: `滚动容器存在: ${containerSelector}${fallbackSelector ? ` 或 ${fallbackSelector}` : ""}`,
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
            `const isLive = (n) => {
              for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                const cl = typeof p.className === "string" ? p.className : "";
                if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                if (typeof getComputedStyle === "function") {
                  const st = getComputedStyle(p);
                  if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                }
              }
              return true;
            };
            return [...document.querySelectorAll(${JSON.stringify(groupSel)})].filter(isLive).length;`,
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
                  `const isLive = (n) => {
                    for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                      const cl = typeof p.className === "string" ? p.className : "";
                      if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                      if (typeof getComputedStyle === "function") {
                        const st = getComputedStyle(p);
                        if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                      }
                    }
                    return true;
                  };
                  const grp = [...document.querySelectorAll(${JSON.stringify(groupSel)})].filter(isLive)[${g}];
                  const el = grp ? [...grp.querySelectorAll(${JSON.stringify(subSel)})].filter(isLive)[${k}] : null;
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
                preserveExistingNonEmpty: params.preserveExistingNonEmpty,
                saveSelectedBindKey: params.saveSelectedBindKey,
                hydrateWaitMs: params.hydrateWaitMs,
              },
            ];
        const results = [];
        for (const spec of selectSpecs) {
          const targets = Array.isArray(spec.values)
            ? spec.values.map((v) => String(v))
            : [String(spec.value ?? "")];
          const preserveNonEmpty = Boolean(spec.preserveExistingNonEmpty ?? params.preserveExistingNonEmpty);
          const saveBindKey = String(spec.saveSelectedBindKey || params.saveSelectedBindKey || "");
          const hydrateWaitMs = Math.max(0, Number(spec.hydrateWaitMs ?? params.hydrateWaitMs) || 0);

          if (preserveNonEmpty || hydrateWaitMs > 0) {
            const pDeadline = Date.now() + hydrateWaitMs;
            let preItems = [];
            while (true) {
              preItems = await evalJs(
                `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
                const cleanLbl = (s) => norm(s).replace(/^\\*\\s*/, "").replace(/\\s*[:：]\\s*$/, "");
                const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
                  const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
                  const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
                  const r = m.getBoundingClientRect();
                  return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
                });
                const scope = modals.length ? modals[modals.length - 1] : document;
                let host = null;
                if (${JSON.stringify(String(spec.selector || ""))}) {
                  const all = [...scope.querySelectorAll(${JSON.stringify(String(spec.selector || ""))})];
                  host = all[${Number(spec.nth) || 0}] || null;
                } else if (${JSON.stringify(String(spec.label || ""))}) {
                  const wantL = cleanLbl(${JSON.stringify(String(spec.label || ""))});
                  const fields = [...scope.querySelectorAll(".ant-form-item")];
                  const hitF =
                    fields.find((f) => cleanLbl((f.querySelector(".ant-form-item-label, label") || {}).innerText || "") === wantL) ||
                    fields.find((f) => cleanLbl((f.querySelector(".ant-form-item-label, label") || {}).innerText || "").includes(wantL));
                  host = hitF ? hitF.querySelector(".ant-select, select") : null;
                }
                if (!host) return [];
                return [...host.querySelectorAll(".ant-select-selection-item")]
                  .map((i) => norm((i.querySelector(".ant-select-selection-item-content") || i).textContent || ""))
                  .filter(Boolean);`,
                stepCtx,
              );
              const itemsArr = Array.isArray(preItems) ? preItems : [];
              const allTargetsAlready = targets.length > 0 && targets.every((t) => itemsArr.includes(t));
              if (allTargetsAlready || (preserveNonEmpty && itemsArr.length > 0)) {
                preItems = itemsArr;
                break;
              }
              if (Date.now() >= pDeadline) {
                preItems = itemsArr;
                break;
              }
              await sleepWithAbort(120, signal);
            }
            const curItems = Array.isArray(preItems) ? preItems : [];
            const allTargetsPresent = targets.length > 0 && targets.every((t) => curItems.includes(t));
            if (allTargetsPresent || (preserveNonEmpty && curItems.length > 0)) {
              if (saveBindKey) {
                runtimeBinds.runtime[saveBindKey] = allTargetsPresent ? [...targets] : [...curItems];
              }
              for (const v of allTargetsPresent ? targets : curItems) {
                results.push({
                  target: spec.label || spec.selector,
                  value: v,
                  alreadySelected: true,
                  selected: v,
                });
              }
              continue;
            }
          }

          const chosenForBind = [];
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
            chosenForBind.push(String(parsed.selected || val));
            results.push({
              target: spec.label || spec.selector,
              value: val,
              alreadySelected: Boolean(parsed.alreadySelected),
              selected: parsed.selected,
            });
          }
          if (saveBindKey && chosenForBind.length > 0) {
            runtimeBinds.runtime[saveBindKey] = chosenForBind;
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

        const mountDeadline = Date.now() + Math.min(timeoutMs, 6000);
        let current = null;
        while (true) {
          current = await evalJs(
            `const isLiveNode = (n) => {
              for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                const cl = typeof p.className === "string" ? p.className : "";
                if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                if (typeof getComputedStyle === "function") {
                  const st = getComputedStyle(p);
                  if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                }
              }
              return true;
            };
            const list = [...(document.querySelectorAll ? document.querySelectorAll(${JSON.stringify(selector)}) : [])].filter(isLiveNode);
            const el = list[list.length - 1] || (isLiveNode(document.querySelector(${JSON.stringify(selector)})) ? document.querySelector(${JSON.stringify(selector)}) : null);
            if (!el) return { exists: false, itemText: "" };
            const wrap = el.closest(".ant-select");
            const item = wrap ? wrap.querySelector(".ant-select-selection-item") : null;
            const text = item ? ((item.querySelector(".ant-select-selection-item-content") || item).textContent || "") : "";
            return { exists: true, itemText: text.replace(/\\s+/g, " ").trim() };`,
            stepCtx,
          );
          if (current?.exists || Date.now() >= mountDeadline) break;
          await sleepWithAbort(120, signal);
        }

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
          let { parsed: clickRes, text: clickTxt } = await invokeRawTool("click", clickArgs, stepCtx);
          if ((!clickRes || clickRes.ok !== true) && params.dropdownSelector) {
            const optSettleDeadline = Date.now() + Math.min(timeoutMs, 2200);
            while ((!clickRes || clickRes.ok !== true) && Date.now() < optSettleDeadline) {
              await sleepWithAbort(150, signal);
              ({ parsed: clickRes, text: clickTxt } = await invokeRawTool("click", clickArgs, stepCtx));
            }
          }
          if (!clickRes || clickRes.ok !== true) {
            const optProbeSel = String(params.optionSelector || "li.ant-cascader-menu-item, .ant-select-item-option");
            const availableOptions = await evalJs(
              `return [...document.querySelectorAll(${JSON.stringify(optProbeSel)})]
                .map((el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
                .filter(Boolean)
                .slice(0, 20);`,
              stepCtx,
            ).catch(() => []);
            throw new WorkflowError({
              code: "WORKFLOW_CASCADER_OPTION_CLICK_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `点击级联目标路径 "${expectedText}"`,
              actual: JSON.stringify({
                clickError: clickTxt.slice(0, 240),
                availableOptions: Array.isArray(availableOptions) ? availableOptions : [],
              }),
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
            const mountDeadline = Date.now() + Math.min(Math.max(1000, Number(params.timeoutMs) || 5000), 8000);
            let allInfo = null;
            while (true) {
              allInfo = await evalJs(
                `const isLiveNode = (n) => {
                  for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                    const cl = typeof p.className === "string" ? p.className : "";
                    if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                    if (typeof getComputedStyle === "function") {
                      const st = getComputedStyle(p);
                      if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                    }
                  }
                  return true;
                };
                const list = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(isLiveNode);
                return { count: list.length, values: list.map((el) => String(el.value ?? "")) };`,
                stepCtx,
              );
              if (allInfo?.count > 0 || Date.now() >= mountDeadline) break;
              await sleepWithAbort(120, signal);
            }
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
              `return [...document.querySelectorAll(${JSON.stringify(selector)})]
                .filter((n) => {
                  for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                    const cl = typeof p.className === "string" ? p.className : "";
                    if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                    if (typeof getComputedStyle === "function") {
                      const st = getComputedStyle(p);
                      if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                    }
                  }
                  return true;
                })
                .map((el) => String(el.value ?? ""));`,
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

          const mountDeadline = Date.now() + Math.min(Math.max(1000, Number(params.timeoutMs) || 5000), 8000);
          let pre = null;
          while (true) {
            pre = await evalJs(
              `const isLiveNode = (n) => {
                for (let p = n; p && p.nodeType === 1; p = p.parentElement) {
                  const cl = typeof p.className === "string" ? p.className : "";
                  if (p.hidden || /\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cl)) return false;
                  if (typeof getComputedStyle === "function") {
                    const st = getComputedStyle(p);
                    if (st && (st.display === "none" || st.visibility === "hidden")) return false;
                  }
                }
                return true;
              };
              const list = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(isLiveNode);
              const el = list[${nth}];
              if (!el) return { exists: false, count: list.length, value: "" };
              return { exists: true, count: list.length, value: String(el.value ?? "") };`,
              stepCtx,
            );
            if (pre?.exists || Date.now() >= mountDeadline) break;
            await sleepWithAbort(120, signal);
          }
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
        const preserveExisting = Boolean(params.preserveExisting);
        const saveExpectedBindKey = params.saveExpectedBindKey ? String(params.saveExpectedBindKey) : "";
        const summary = [];
        const expectedFields = [];
        let mutatedCount = 0;

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
            const propSel = String(rule.proportionSelector || "");
            const propVal = String(rule.proportionValue ?? "100");
            const compLabel = String(rule.labelIncludes || "成分");

            if (preserveExisting) {
              const curComp = await evalJs(
                `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
                const matHost = document.querySelector(${JSON.stringify(matSel)});
                const matItems = matHost
                  ? [...matHost.querySelectorAll(".ant-select-selection-item")]
                      .map((i) => norm((i.querySelector(".ant-select-selection-item-content") || i).textContent || ""))
                      .filter(Boolean)
                  : [];
                const pEl = document.querySelector(${JSON.stringify(propSel)});
                const pVal = pEl ? String(pEl.value ?? "").trim() : "";
                return { matItems, pVal };`,
                stepCtx,
              );
              if (
                Array.isArray(curComp?.matItems) &&
                curComp.matItems.length > 0 &&
                curComp.pVal === propVal
              ) {
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
                summary.push({ label: "composition", value: `${curComp.matItems[0]}:${curComp.pVal}`, preserved: true });
                expectedFields.push({
                  labelIncludes: compLabel,
                  items: [curComp.matItems[0]],
                  inputs: [curComp.pVal],
                });
                continue;
              }
            }

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
              mutatedCount += 1;
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
            if (!selRes.alreadySelected) mutatedCount += 1;
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
              mutatedCount += 1;
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
            expectedFields.push({
              labelIncludes: compLabel,
              items: [String(rule.materialValue)],
              inputs: [propVal],
            });
          } else if (rule.kind === "select") {
            const vals = Array.isArray(rule.values) ? rule.values.map(String) : [String(rule.value)];
            if (preserveExisting) {
              const curSelItems = await evalJs(
                `const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
                const cleanLbl = (s) => norm(s).replace(/^\\*\\s*/, "").replace(/\\s*[:：]\\s*$/, "");
                const root = document.querySelector(${JSON.stringify(containerSelector)}) || document;
                const want = cleanLbl(${JSON.stringify(String(rule.label || ""))});
                const fields = [...root.querySelectorAll(${JSON.stringify(fieldSelector)})];
                const hit =
                  fields.find((f) => cleanLbl((f.querySelector(${JSON.stringify(labelSelector)}) || {}).innerText || "") === want) ||
                  fields.find((f) => cleanLbl((f.querySelector(${JSON.stringify(labelSelector)}) || {}).innerText || "").includes(want));
                if (!hit) return [];
                return [...hit.querySelectorAll(".ant-select-selection-item")]
                  .map((s) => norm((s.querySelector(".ant-select-selection-item-content") || s).textContent || ""))
                  .filter(Boolean);`,
                stepCtx,
              );
              if (Array.isArray(curSelItems) && curSelItems.length > 0) {
                summary.push({ label: rule.label, values: curSelItems, preserved: true });
                expectedFields.push({ labelIncludes: String(rule.label), items: curSelItems });
                continue;
              }
            }
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
              if (!sRes.alreadySelected) mutatedCount += 1;
            }
            summary.push({ label: rule.label, values: vals });
            expectedFields.push({ labelIncludes: String(rule.label), items: vals });
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
            const curNumTrim = String(curNum).trim();
            const hasValidExistingNum =
              preserveExisting && /^\d+(?:\.\d+)?$/.test(curNumTrim) && Number(curNumTrim) > 0;
            const finalNumVal = hasValidExistingNum ? curNumTrim : targetVal;
            if (!hasValidExistingNum && curNum !== targetVal) {
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
              mutatedCount += 1;
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
            summary.push({ label: rule.label || inSel, value: finalNumVal, ...(hasValidExistingNum ? { preserved: true } : {}) });
            if (rule.label) {
              expectedFields.push({
                labelIncludes: String(rule.label),
                ...(rule.expectedUnit ? { items: [String(rule.expectedUnit)] } : {}),
                inputs: [finalNumVal],
              });
            }
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
              const preserve = ${preserveExisting ? "true" : "false"} && cur.trim() !== "";
              if (!preserve && cur !== ${JSON.stringify(targetVal)}) {
                inp.setAttribute("data-pl-wf-act", ${JSON.stringify(fNonce)});
              }
              return { found: true, value: cur, preserve };`,
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
            const finalFieldVal = fProbe.preserve ? String(fProbe.value).trim() : targetVal;
            if (!fProbe.preserve && fProbe.value !== targetVal) {
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
                mutatedCount += 1;
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
            summary.push({ label: labelKey, value: finalFieldVal, ...(fProbe.preserve ? { preserved: true } : {}) });
            if (labelKey) {
              expectedFields.push({ labelIncludes: labelKey, inputs: [finalFieldVal] });
            }
          }
        }

        if (saveExpectedBindKey) {
          runtimeBinds.runtime[saveExpectedBindKey] = expectedFields;
        }

        if (params.requireAllStarredFilled !== false) {
          const audit = await evalJs(
            `const root = document.querySelector(${JSON.stringify(containerSelector)}) || document;
            const fields = [...root.querySelectorAll(${JSON.stringify(fieldSelector)})];
            const missing = [];
            const missingDetails = [];
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
                const name = label || "(未命名必填属性)";
                missing.push(name);
                const hasTable = Boolean(f.querySelector("table, tbody"));
                const hasSelect = Boolean(f.querySelector(".ant-select, .el-select, select"));
                const nonSearchInputs = [...f.querySelectorAll("input")].filter(
                  (i) => i.type !== "search" && i.type !== "checkbox" && i.type !== "radio",
                );
                missingDetails.push({
                  label: name,
                  kind: hasTable ? "table" : hasSelect && nonSearchInputs.length ? "select+input" : hasSelect ? "select" : "input",
                });
              }
            }
            return { starredCount, missing, missingDetails };`,
            stepCtx,
          );
          if (Array.isArray(audit?.missing) && audit.missing.length > 0) {
            const detailStr = Array.isArray(audit?.missingDetails)
              ? audit.missingDetails.map((d) => `${d.label}[${d.kind}]`).join("、")
              : audit.missing.join("、");
            throw new WorkflowError({
              code: "WORKFLOW_STARRED_ATTR_MISSING",
              blame: "workflow",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: "所有带 * 必填类目属性均非空",
              actual: `存在未填必填属性 (${audit.missing.length} 项): ${detailStr}`,
              message: `存在未配置的必填属性: ${audit.missing.join("、")}`,
            });
          }
          return { ok: true, starredCount: audit?.starredCount || 0, configuredCount: summary.length, mutatedCount };
        }
        return { ok: true, configuredCount: summary.length, mutatedCount };
      }

      case "ensure_modal_entity": {
        const selectedSelector = String(params.selectedSelector || "");
        const alreadyBoundTexts = Array.isArray(params.alreadyBoundTexts)
          ? params.alreadyBoundTexts.map(String)
          : [];
        const alreadyBoundRegex = params.alreadyBoundRegex ? new RegExp(String(params.alreadyBoundRegex)) : null;
        const openButtonText = String(params.openButtonText || "");
        const rowMustInclude = Array.isArray(params.rowMustInclude) ? params.rowMustInclude.map(String) : [];
        const rowActionText = String(params.rowActionText || "");
        const rawOptionClicks = Array.isArray(params.optionClicks) ? params.optionClicks : [];
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
          (alreadyBoundTexts.length > 0 || alreadyBoundRegex) &&
          alreadyBoundTexts.every((sub) => String(existing).includes(sub)) &&
          (!alreadyBoundRegex || alreadyBoundRegex.test(String(existing)))
        ) {
          if (params.saveVerifyBindKey) {
            const rxHit = alreadyBoundRegex ? alreadyBoundRegex.exec(String(existing))?.[0] || "" : "";
            runtimeBinds.runtime[String(params.saveVerifyBindKey)] = [
              ...alreadyBoundTexts,
              ...(rxHit ? [rxHit] : []),
            ];
          }
          return { ok: true, skipped: true, boundText: clipBound(existing) };
        }

        const preModalInfo = await evalJs(
          `/* entity_pre_modal_count */
          const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
            const cls = (m.className || "") + " " + ((m.parentElement && m.parentElement.className) || "");
            if (/\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cls)) return false;
            const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
            const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
            const r = m.getBoundingClientRect();
            return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
          });
          return { modalCountBefore: modals.length };`,
          stepCtx,
        );
        const modalsBeforeCount =
          typeof preModalInfo?.modalCountBefore === "number" ? preModalInfo.modalCountBefore : 0;

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

        const rowNonce = `ent_${++nonceCounter}`;
        const rowDeadline = Date.now() + timeoutMs;
        let rowProbe = null;
        while (true) {
          rowProbe = await evalJs(
            `const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
              const cls = (m.className || "") + " " + ((m.parentElement && m.parentElement.className) || "");
              if (/\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cls)) return false;
              const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
              const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
              const r = m.getBoundingClientRect();
              return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
            });
            const before = ${modalsBeforeCount};
            if (before > 0 && modals.length <= before) {
              return { found: false, newModalMounted: false, modalCount: modals.length, modalsBeforeCount: before };
            }
            const top = modals[modals.length - 1] || document;
            const spinning = Boolean(top.querySelector && top.querySelector(".ant-spin-spinning, .ant-skeleton"));
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
            const rows = [...top.querySelectorAll("tbody tr")];
            const rowTexts = rows.map((r) => norm(r.innerText)).filter(Boolean);
            const must = ${JSON.stringify(rowMustInclude)};
            const wantAct = ${JSON.stringify(normalizeCjkText(rowActionText))};
            const hitRow = rows.find((tr) => {
              const t = norm(tr.innerText);
              return must.every((k) => t.includes(k));
            });
            if (!hitRow) {
              const emptyPlaceholderOnly =
                rowTexts.length === 0 ||
                (rowTexts.length === 1 && /^(?:暂无|无数据|加载中|loading|no data)/i.test(rowTexts[0]));
              return {
                found: false,
                newModalMounted: modals.length > before || before === 0,
                spinning,
                emptyPlaceholderOnly,
                rows: rowTexts.slice(0, 8),
              };
            }
            const btn = [...hitRow.querySelectorAll("button, a, [role='button']")].find(
              (b) => normBtn(b.innerText) === wantAct,
            );
            if (!btn) {
              return {
                found: false,
                newModalMounted: true,
                spinning,
                reason: "no_button",
                rowText: norm(hitRow.innerText),
              };
            }
            btn.setAttribute("data-pl-wf-act", ${JSON.stringify(rowNonce)});
            return { found: true, newModalMounted: true, rowText: norm(hitRow.innerText) };`,
            stepCtx,
          );
          if (rowProbe?.found || Date.now() >= rowDeadline) break;
          await sleepWithAbort(120, signal);
        }
        if (!rowProbe?.found) {
          if (rowProbe?.newModalMounted === false || rowProbe?.spinning === true) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTITY_MODAL_WAIT_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `新实体选择弹窗挂载并完成列表水合（当前前置弹窗数=${modalsBeforeCount}，操作按钮 "${rowActionText}"）`,
              actual: JSON.stringify(rowProbe),
              message: `等待实体选择弹窗及异步列表就绪超时`,
            });
          }
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

        const selectedOptions = [];
        const dynamicVerifySubstrings = [];
        for (const optSpec of rawOptionClicks) {
          if (optSpec && typeof optSpec === "object" && !Array.isArray(optSpec)) {
            const groupIdx = Math.max(0, Number(optSpec.radioGroupIndex) || 0);
            const preferList = Array.isArray(optSpec.prefer)
              ? optSpec.prefer.map((x) => String(x).trim()).filter(Boolean)
              : [];
            const radioNonce = `entopt_${++nonceCounter}`;
            const optDeadline = Date.now() + 5000;
            let radioProbe = null;
            while (true) {
              radioProbe = await evalJs(
                `const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
                  const cls = (m.className || "") + " " + ((m.parentElement && m.parentElement.className) || "");
                  if (/\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cls)) return false;
                  const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
                  const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
                  const r = m.getBoundingClientRect();
                  return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
                });
                const before = ${modalsBeforeCount};
                if (before > 0 && modals.length <= before) {
                  return { found: false, newModalMounted: false, modalCount: modals.length };
                }
                const top = modals[modals.length - 1] || document;
                const groups = [...top.querySelectorAll(".ant-radio-group, [role='radiogroup']")];
                const grp = groups[${groupIdx}] || null;
                if (!grp) return { found: false, groupCount: groups.length };
                const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
                const items = [
                  ...grp.querySelectorAll(
                    "label.ant-radio-wrapper:not(.ant-radio-wrapper-disabled), label.ant-radio-button-wrapper:not(.ant-radio-button-wrapper-disabled), [role='radio']:not([aria-disabled='true'])",
                  ),
                ];
                if (!items.length) return { found: false, groupCount: groups.length, available: [] };
                const entries = items
                  .map((el) => ({ el, text: norm(el.innerText || el.textContent) }))
                  .filter((e) => Boolean(e.text));
                if (!entries.length) return { found: false, groupCount: groups.length, available: [] };
                const prefer = ${JSON.stringify(preferList)};
                let hit = null;
                for (const p of prefer) {
                  hit = entries.find((e) => e.text === p) || null;
                  if (hit) break;
                }
                if (!hit && ${optSpec.allowFirstFallback !== false ? "true" : "false"}) {
                  hit = entries[0];
                }
                if (!hit) {
                  return { found: false, available: entries.map((e) => e.text) };
                }
                hit.el.setAttribute("data-pl-wf-act", ${JSON.stringify(radioNonce)});
                return { found: true, chosenText: hit.text, available: entries.map((e) => e.text) };`,
                stepCtx,
              );
              if (radioProbe?.found || Date.now() >= optDeadline) break;
              await sleepWithAbort(100, signal);
            }
            if (!radioProbe?.found) {
              throw new WorkflowError({
                code: "WORKFLOW_ENTITY_OPTION_CLICK_FAILED",
                blame: "workflow",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `单选组[${groupIdx}] 命中候选 ${JSON.stringify(preferList)}`,
                actual: JSON.stringify(radioProbe),
                message: `弹窗内单选组[${groupIdx}] 未找到可用选项`,
              });
            }
            await clickMarkedElement({
              markNonce: radioNonce,
              buttonText: radioProbe.chosenText,
              stepCtx,
              targetUrl: currentUrl,
            });
            selectedOptions.push(radioProbe.chosenText);
            if (optSpec.verifyPrefix) {
              dynamicVerifySubstrings.push(`${String(optSpec.verifyPrefix)}${radioProbe.chosenText}`);
            }
            continue;
          }

          const optText = String(optSpec);
          const strOptNonce = `entstropt_${++nonceCounter}`;
          const strOptDeadline = Date.now() + 5000;
          let strOptProbe = null;
          while (true) {
            strOptProbe = await evalJs(
              `/* entity_str_option_probe */
              const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
                const cls = (m.className || "") + " " + ((m.parentElement && m.parentElement.className) || "");
                if (/\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cls)) return false;
                const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
                const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
                const r = m.getBoundingClientRect();
                return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
              });
              const before = ${modalsBeforeCount};
              if (before > 0 && modals.length <= before) {
                return { found: false, newModalMounted: false, modalCount: modals.length };
              }
              const top = modals[modals.length - 1] || document;
              const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
              const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
              const want = ${JSON.stringify(normalizeCjkText(optText))};
              const cands = [
                ...top.querySelectorAll(
                  "label.ant-radio-wrapper:not(.ant-radio-wrapper-disabled), label.ant-radio-button-wrapper:not(.ant-radio-button-wrapper-disabled), [role='radio']:not([aria-disabled='true']), [role='option']:not([aria-disabled='true']), button:not([disabled])",
                ),
              ];
              const hit = cands.find((el) => {
                const raw = norm(el.innerText || el.textContent);
                return raw === ${JSON.stringify(optText.trim())} || normBtn(raw) === want;
              });
              if (!hit) {
                return {
                  found: false,
                  available: cands.map((el) => norm(el.innerText || el.textContent)).filter(Boolean).slice(0, 12),
                };
              }
              hit.setAttribute("data-pl-wf-act", ${JSON.stringify(strOptNonce)});
              return { found: true, matchedText: norm(hit.innerText || hit.textContent) };`,
              stepCtx,
            );
            if (strOptProbe === true || strOptProbe?.found || Date.now() >= strOptDeadline) break;
            await sleepWithAbort(100, signal);
          }
          if (strOptProbe === true) {
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
          } else {
            if (!strOptProbe?.found) {
              throw new WorkflowError({
                code: "WORKFLOW_ENTITY_OPTION_CLICK_FAILED",
                blame: "工具",
                stepIndex: stepCtx.stepIndex,
                stepId: stepCtx.stepId,
                op: stepCtx.op,
                expected: `顶层实体弹窗内点击选项 "${optText}"`,
                actual: JSON.stringify(strOptProbe),
                message: `点击选项失败: ${optText}`,
              });
            }
            await clickMarkedElement({
              markNonce: strOptNonce,
              buttonText: optText,
              stepCtx,
              targetUrl: currentUrl,
            });
          }
          selectedOptions.push(optText);
        }

        const confirmNonce = `entcfm_${++nonceCounter}`;
        const confirmDeadline = Date.now() + 4000;
        let confirmProbe = null;
        while (true) {
          confirmProbe = await evalJs(
            `/* entity_confirm_probe */
            const modals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
              const cls = (m.className || "") + " " + ((m.parentElement && m.parentElement.className) || "");
              if (/\\b(?:ant|el|rc)-[a-z0-9-]*-leave(?:-active|-to)?\\b/.test(cls)) return false;
              const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
              const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
              const r = m.getBoundingClientRect();
              return ws.display !== "none" && ws.visibility !== "hidden" && r.width > 0 && r.height > 0;
            });
            const before = ${modalsBeforeCount};
            if (before > 0 && modals.length <= before) {
              return { found: false, newModalMounted: false, modalCount: modals.length };
            }
            const top = modals[modals.length - 1] || document;
            const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
            const normBtn = (s) => norm(s).replace(/([\\u4e00-\\u9fff])\\s+(?=[\\u4e00-\\u9fff])/g, "$1");
            const want = ${JSON.stringify(normalizeCjkText(confirmText))};
            const btns = [...top.querySelectorAll("button:not([disabled]), [role='button']:not([aria-disabled='true'])")];
            const hit = btns.find((b) => normBtn(b.innerText || b.textContent) === want);
            if (!hit) {
              return { found: false, buttons: btns.map((b) => norm(b.innerText || b.textContent)).filter(Boolean).slice(0, 8) };
            }
            hit.setAttribute("data-pl-wf-act", ${JSON.stringify(confirmNonce)});
            return { found: true, matchedText: norm(hit.innerText || hit.textContent) };`,
            stepCtx,
          );
          if (confirmProbe === true || confirmProbe?.found || Date.now() >= confirmDeadline) break;
          await sleepWithAbort(100, signal);
        }
        if (confirmProbe === true) {
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
        } else {
          if (!confirmProbe?.found) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTITY_CONFIRM_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `顶层实体弹窗内点击确认按钮 "${confirmText}"`,
              actual: JSON.stringify(confirmProbe),
              message: `确认绑定失败: ${confirmText}`,
            });
          }
          await clickMarkedElement({
            markNonce: confirmNonce,
            buttonText: confirmText,
            stepCtx,
            targetUrl: currentUrl,
          });
        }

        const mustIncludeAfter = [...alreadyBoundTexts, ...dynamicVerifySubstrings];
        const bindDeadline = Date.now() + Math.min(timeoutMs, 8000);
        let boundAfter = "";
        let remainingAllModals = 0;
        while (true) {
          const postInfo = await evalJs(
            `/* entity_post_confirm_settle */
            const allModals = [...document.querySelectorAll(".ant-modal")].filter((m) => {
              const wrap = m.closest(".ant-modal-wrap") || m.parentElement;
              const ws = wrap ? getComputedStyle(wrap) : getComputedStyle(m);
              const ms = getComputedStyle(m);
              const r = m.getBoundingClientRect();
              return (
                ws.display !== "none" &&
                ws.visibility !== "hidden" &&
                ms.display !== "none" &&
                ms.visibility !== "hidden" &&
                r.width > 0 &&
                r.height > 0
              );
            });
            const boundText = [...document.querySelectorAll(${JSON.stringify(selectedSelector)})]
              .map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim())
              .join(" | ");
            return { boundText, allModalCount: allModals.length };`,
            stepCtx,
          );
          boundAfter = typeof postInfo === "string" ? postInfo : String(postInfo?.boundText || "");
          remainingAllModals =
            typeof postInfo?.allModalCount === "number" ? postInfo.allModalCount : modalsBeforeCount;
          const childModalClosed = modalsBeforeCount > 0 ? remainingAllModals <= modalsBeforeCount : remainingAllModals === 0;
          if (
            boundAfter &&
            childModalClosed &&
            mustIncludeAfter.every((sub) => String(boundAfter).includes(sub)) &&
            (!alreadyBoundRegex || alreadyBoundRegex.test(String(boundAfter)))
          ) {
            break;
          }
          if (Date.now() >= bindDeadline) {
            throw new WorkflowError({
              code: "WORKFLOW_ENTITY_VERIFY_FAILED",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `子弹窗彻底卸载（当前=${remainingAllModals}, 期望<=${modalsBeforeCount}）且已绑定区域包含 ${JSON.stringify(mustIncludeAfter)}${alreadyBoundRegex ? ` 且匹配 ${alreadyBoundRegex}` : ""}`,
              actual: clipBound(boundAfter) || "(空)",
              message: `绑定实体回读校验或子弹窗关闭等待失败`,
            });
          }
          await sleepWithAbort(120, signal);
        }
        if (params.saveVerifyBindKey) {
          runtimeBinds.runtime[String(params.saveVerifyBindKey)] = [...mustIncludeAfter];
        }
        return { ok: true, skipped: false, selectedOptions, boundText: clipBound(boundAfter) };
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

        let seenAlerts = [];
        if (params.waitModalsCount !== undefined) {
          const wantModals = Number(params.waitModalsCount);
          const modalSelector = String(params.modalSelector || ".ant-modal");
          const waitRes = await waitForModalsCountWithAlerts({
            wantModals,
            modalSelector,
            timeoutMs,
            actionLabel: text || selector,
            stepCtx,
          });
          seenAlerts = waitRes.seenAlerts || [];
        }
        return {
          ok: true,
          skipped: false,
          clicked: text || selector,
          ...(seenAlerts.length > 0 ? { alerts: seenAlerts } : {}),
        };
      }

      case "ensure_pending_recommendations": {
        const topmostModal = params.topmostModal !== false;
        const containerSelector = params.containerSelector ? String(params.containerSelector) : "";
        const cardButtonText = String(params.cardButtonText || "");
        const pendingText = String(params.pendingText || "");
        const acceptButtonText = String(params.acceptButtonText || "");
        const minConfirmedCards = Math.max(0, Number(params.minConfirmedCards ?? 1));
        const skipWhenUnmodifiedAndConfirmed = Boolean(params.skipWhenUnmodifiedAndConfirmed);
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 8000);

        const probe = await probeModalCardCounts({
          topmostModal,
          containerSelector,
          cardButtonText,
          pendingText,
          acceptButtonText,
          stepCtx,
        });
        if (!probe?.scopeFound) {
          throw new WorkflowError({
            code: "WORKFLOW_RECOMMENDATION_SCOPE_MISSING",
            blame: "workflow",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: topmostModal ? "顶层可见弹窗存在" : `容器存在: ${containerSelector}`,
            actual: "未找到目标容器",
            message: "待确认推荐检测容器不存在",
          });
        }

        if (
          skipWhenUnmodifiedAndConfirmed &&
          priorMutations === 0 &&
          probe.confirmedCount >= minConfirmedCards
        ) {
          return {
            ok: true,
            skipped: true,
            reason: "unmodified_and_confirmed",
            priorMutations,
            confirmedCount: probe.confirmedCount,
            pendingCount: probe.pendingCount,
            acceptVisible: probe.acceptVisible,
          };
        }

        if (!probe.acceptVisible) {
          return {
            ok: true,
            skipped: true,
            reason: "accept_button_not_visible",
            priorMutations,
            confirmedCount: probe.confirmedCount,
            pendingCount: probe.pendingCount,
          };
        }

        assertClickTargetSafe({
          labelText: acceptButtonText,
          domElementText: acceptButtonText,
          forbidClickTexts: directive.forbidClickTexts,
          settings,
          targetUrl: currentUrl,
          stepCtx,
        });

        const { parsed: cRes, text: cTxt } = await invokeRawTool(
          "click",
          { text: acceptButtonText },
          stepCtx,
        );
        if (!cRes || cRes.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_ACCEPT_RECOMMENDATION_FAILED",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `点击 "${acceptButtonText}" 确认待定推荐卡片`,
            actual: cTxt.slice(0, 350),
            message: `点击 "${acceptButtonText}" 失败`,
          });
        }

        const deadline = Date.now() + timeoutMs;
        let after = null;
        while (true) {
          after = await probeModalCardCounts({
            topmostModal,
            containerSelector,
            cardButtonText,
            pendingText,
            acceptButtonText,
            stepCtx,
          });
          if (after?.scopeFound && !after.acceptVisible && (!pendingText || !after.scopeHasPendingText)) {
            break;
          }
          if (Date.now() >= deadline) {
            throw new WorkflowError({
              code: "WORKFLOW_ACCEPT_RECOMMENDATION_VERIFY_TIMEOUT",
              blame: "工具",
              stepIndex: stepCtx.stepIndex,
              stepId: stepCtx.stepId,
              op: stepCtx.op,
              expected: `点击 "${acceptButtonText}" 后按钮消失且无 "${pendingText}" 待确认状态`,
              actual: JSON.stringify(after),
              message: `确认推荐后状态未收敛`,
            });
          }
          await sleepWithAbort(120, signal);
        }

        return {
          ok: true,
          skipped: false,
          clicked: acceptButtonText,
          priorMutations,
          confirmedCount: after.confirmedCount,
          pendingCount: after.pendingCount,
        };
      }

      case "commit_or_shortcircuit_modals": {
        const confirmText = String(params.confirmText || "确认");
        const cancelText = String(params.cancelText || "取消");
        const modalSelector = String(params.modalSelector || ".ant-modal");
        const singleShotKey = params.singleShotKey ? String(params.singleShotKey) : "";
        const shortCircuitWhenUnmodified = Boolean(params.shortCircuitWhenUnmodified);
        const topmostModal = params.topmostModal !== false;
        const containerSelector = params.containerSelector ? String(params.containerSelector) : "";
        const cardButtonText = String(params.cardButtonText || "");
        const pendingText = String(params.pendingText || "");
        const minConfirmedCards = Math.max(0, Number(params.minConfirmedCards ?? 1));
        const waitModalsCount = Number(params.waitModalsCount ?? 0);
        const maxCancelAttempts = Math.max(1, Number(params.maxCancelAttempts ?? 5));
        const timeoutMs = Math.max(1000, Number(params.timeoutMs) || 15000);

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

        if (shortCircuitWhenUnmodified && priorMutations === 0) {
          const probe = await probeModalCardCounts({
            topmostModal,
            containerSelector,
            cardButtonText,
            pendingText,
            acceptButtonText: "",
            stepCtx,
          });
          if (probe?.scopeFound && probe.confirmedCount >= minConfirmedCards) {
            assertClickTargetSafe({
              labelText: cancelText,
              domElementText: cancelText,
              forbidClickTexts: directive.forbidClickTexts,
              settings,
              targetUrl: currentUrl,
              stepCtx,
            });
            const closeRes = await closeModalsStack({
              modalSelector,
              cancelText,
              maxAttempts: maxCancelAttempts,
              settleMs: 1500,
              stepCtx,
              currentUrl,
            });
            runtimeBinds.runtime.wasModified = false;
            commitMeta = { mode: "idempotent_short_circuit", elapsedMs: Math.max(1, Date.now() - startedMs) };
            return {
              ok: true,
              mode: "idempotent_short_circuit",
              skippedConfirm: true,
              priorMutations,
              confirmedCount: probe.confirmedCount,
              pendingCount: probe.pendingCount,
              closedCount: closeRes.closedCount,
              remainingModals: closeRes.remainingModals,
            };
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

        const { parsed: cRes, text: cTxt } = await invokeRawTool(
          "click",
          { text: confirmText },
          stepCtx,
        );
        if (!cRes || cRes.ok !== true) {
          throw new WorkflowError({
            code: "WORKFLOW_COMMIT_CLICK_FAILED",
            blame: "工具",
            stepIndex: stepCtx.stepIndex,
            stepId: stepCtx.stepId,
            op: stepCtx.op,
            expected: `点击提交按钮 "${confirmText}" 成功`,
            actual: cTxt.slice(0, 350),
            message: `点击 "${confirmText}" 失败`,
          });
        }

        if (singleShotKey) executedSingleShots.add(singleShotKey);

        const waitRes = await waitForModalsCountWithAlerts({
          wantModals: waitModalsCount,
          modalSelector,
          timeoutMs,
          actionLabel: confirmText,
          stepCtx,
        });

        runtimeBinds.runtime.wasModified = true;
        commitMeta = { mode: "committed_via_confirm", elapsedMs: Math.max(1, Date.now() - startedMs) };

        return {
          ok: true,
          mode: "committed_via_confirm",
          skippedConfirm: false,
          clicked: confirmText,
          priorMutations,
          ...(waitRes.seenAlerts?.length > 0 ? { alerts: waitRes.seenAlerts } : {}),
        };
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

  function countStepMutations(op, out) {
    if (!out || typeof out !== "object") return 0;
    if (op === "ensure_select") {
      return Array.isArray(out.results)
        ? out.results.filter((r) => !r?.alreadySelected).length
        : 0;
    }
    if (op === "ensure_cascader" || op === "ensure_radio" || op === "ensure_modal_entity") {
      return out.skipped === false ? 1 : 0;
    }
    if (op === "fill_input") {
      if (Array.isArray(out.items)) {
        return out.items.reduce(
          (acc, it) => acc + (typeof it?.changed === "number" ? it.changed : it?.skipped === false ? 1 : 0),
          0,
        );
      }
      if (typeof out.changed === "number") return out.changed;
      return out.skipped === false ? 1 : 0;
    }
    if (op === "ensure_attr_fields" || op === "ensure_checkboxes") {
      return Number(out.mutatedCount) || 0;
    }
    return 0;
  }

  let executedSteps = 0;
  let skippedSteps = 0;
  let mutationsCount = 0;

  for (let i = 0; i < directive.steps.length; i += 1) {
    checkAbort(signal);
    const step = directive.steps[i];
    const stepIndex = i + 1;
    const stepCtx = { stepIndex, stepId: step.id, op: step.op };
    const stepStartMs = Date.now();
    let summaryArgs = { stepId: step.id };
    let startedEmitted = false;

    try {
      const shouldRun = evaluateWhenPredicate(step.when, runtimeBinds, stepCtx);
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

      const params = interpolateParams(step.params || {}, runtimeBinds, stepCtx);
      summaryArgs = summarizeStepArgs(step.id, params);
      onStepStart?.({ stepIndex, stepId: step.id, name: step.op, args: summaryArgs });
      startedEmitted = true;

      const preSnap = await checkEnvironmentAndUrl(directive, stepCtx);
      const out = await executeStepOp(step, params, stepCtx, preSnap?.url || "", mutationsCount);
      mutationsCount += countStepMutations(step.op, out);
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

      if (toolMap.has("screenshot")) {
        await sleepWithAbort(220, signal).catch(() => {});
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
    commitMode: commitMeta.mode,
    commitElapsedMs: commitMeta.elapsedMs,
    mutationsCount,
    targetSummary: String(runtimeBinds.runtime.targetSummary || ""),
    runtime: runtimeBinds.runtime,
    errorMessage: null,
    failure: null,
  };
}
