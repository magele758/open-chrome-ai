/**
 * 确定性工作流参数绑定、占位符插值、条件谓词求值与纯数据变换（零业务语义、零动态 eval）。
 */

import { WorkflowError, normalizeSpaces } from "./errors.js";

const PLACEHOLDER_EXACT_RE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;
const PLACEHOLDER_GLOBAL_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

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

export function setBindValue(binds, keyPath, value) {
  const pathStr = String(keyPath || "").trim();
  if (!pathStr || !binds || typeof binds !== "object") return;
  const parts = pathStr.split(".").filter(Boolean);
  if (!parts.length) return;
  let cur = binds;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

export function interpolateParams(node, binds = {}, stepCtx = {}, { allowMissing = false } = {}) {
  if (node == null || typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node === "string") {
    const exact = PLACEHOLDER_EXACT_RE.exec(node);
    if (exact) {
      const hit = lookupBindValue(binds, exact[1]);
      if (!hit.found) {
        if (allowMissing) return undefined;
        throw new WorkflowError({
          code: "WORKFLOW_BIND_MISSING",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex || 0,
          stepId: stepCtx.stepId || "",
          op: stepCtx.op || "",
          expected: `binds 中存在已定义参数 "${exact[1]}"`,
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
        if (allowMissing) return "";
        throw new WorkflowError({
          code: "WORKFLOW_BIND_MISSING",
          blame: "workflow",
          stepIndex: stepCtx.stepIndex || 0,
          stepId: stepCtx.stepId || "",
          op: stepCtx.op || "",
          expected: `binds 中存在非空参数 "${key}"`,
          actual: `未定义占位符 "{{${key}}}"`,
          message: `未定义的工作流参数占位符: {{${key}}}`,
        });
      }
      if (typeof hit.value === "object") return JSON.stringify(hit.value);
      return String(hit.value);
    });
  }
  if (Array.isArray(node)) {
    return node.map((item) => interpolateParams(item, binds, stepCtx, { allowMissing }));
  }
  if (typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = interpolateParams(v, binds, stepCtx, { allowMissing });
    }
    return out;
  }
  return node;
}

export function evaluateWhenPredicate(whenExpr, binds = {}, stepCtx = {}) {
  if (whenExpr === undefined || whenExpr === null || whenExpr === "") return true;
  if (typeof whenExpr === "boolean") return whenExpr;

  if (typeof whenExpr === "object" && !Array.isArray(whenExpr)) {
    if (Array.isArray(whenExpr.all)) {
      return whenExpr.all.every((sub) => evaluateWhenPredicate(sub, binds, stepCtx));
    }
    if (Array.isArray(whenExpr.any)) {
      return whenExpr.any.some((sub) => evaluateWhenPredicate(sub, binds, stepCtx));
    }
    if (whenExpr.not !== undefined) {
      return !evaluateWhenPredicate(whenExpr.not, binds, stepCtx);
    }
    if (Array.isArray(whenExpr.equals) && whenExpr.equals.length === 2) {
      const [a, b] = whenExpr.equals.map((x) => interpolateParams(x, binds, stepCtx, { allowMissing: true }));
      return a === b;
    }
    if (Array.isArray(whenExpr.notEquals) && whenExpr.notEquals.length === 2) {
      const [a, b] = whenExpr.notEquals.map((x) => interpolateParams(x, binds, stepCtx, { allowMissing: true }));
      return a !== b;
    }
    if (whenExpr.nonEmpty !== undefined) {
      const v = interpolateParams(whenExpr.nonEmpty, binds, stepCtx, { allowMissing: true });
      if (Array.isArray(v)) return v.length > 0;
      return String(v ?? "").trim().length > 0;
    }
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_WHEN",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: "when 对象仅支持 all / any / not / equals / notEquals / nonEmpty",
      actual: JSON.stringify(whenExpr),
      message: "不支持的 when 条件对象结构",
    });
  }

  if (typeof whenExpr !== "string") {
    throw new WorkflowError({
      code: "WORKFLOW_INVALID_WHEN",
      blame: "workflow",
      stepIndex: stepCtx.stepIndex || 0,
      stepId: stepCtx.stepId || "",
      op: stepCtx.op || "",
      expected: 'when 为布尔值、对象组合条件或静态绑定布尔键名（如 "flag" 或 "!flag"）',
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
      expected: "静态布尔参数键名（仅允许字母数字下划线点号横杠）",
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

function normalizePathSeparators(value, sep = " / ") {
  return String(value ?? "")
    .replace(/\s*(?:->|\/|>|›)\s*/g, sep)
    .replace(/\s+/g, " ")
    .trim();
}

function isUniformList(arr, mode = "positive_number") {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = String(arr[0] ?? "").trim();
  if (!first) return false;
  if (mode === "non_neg_int") {
    return /^\d+$/.test(first) && arr.every((v) => String(v ?? "").trim() === first);
  }
  return /^\d+(?:\.\d+)?$/.test(first) && Number(first) > 0 && arr.every((v) => String(v ?? "").trim() === first);
}

/**
 * 执行纯数据变换（供 set_binds 原语使用），零 DOM 操作、零业务词。
 */
export function evaluateDataTransform(spec, binds = {}, stepCtx = {}) {
  if (spec == null || typeof spec === "number" || typeof spec === "boolean") return spec;
  if (typeof spec === "string") {
    return interpolateParams(spec, binds, stepCtx, { allowMissing: true });
  }
  if (Array.isArray(spec)) {
    return spec.map((item) => evaluateDataTransform(item, binds, stepCtx));
  }
  if (typeof spec !== "object") return spec;

  if (!spec.$op) {
    const out = {};
    for (const [k, v] of Object.entries(spec)) {
      out[k] = evaluateDataTransform(v, binds, stepCtx);
    }
    return out;
  }

  const op = String(spec.$op);
  if (op === "cond") {
    const condVal = evaluateDataTransform(spec.if, binds, stepCtx);
    return condVal
      ? evaluateDataTransform(spec.then, binds, stepCtx)
      : evaluateDataTransform(spec.else, binds, stepCtx);
  }
  if (op === "literal") {
    return interpolateParams(spec.value, binds, stepCtx, { allowMissing: true });
  }

  const resolved = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === "$op") continue;
    resolved[k] = evaluateDataTransform(v, binds, stepCtx);
  }

  switch (op) {
    case "get": {
      const hit = lookupBindValue(binds, String(resolved.path || ""));
      return hit.found ? hit.value : resolved.default;
    }

    case "coalesce": {
      const list = Array.isArray(resolved.values) ? resolved.values : [];
      for (const item of list) {
        if (item !== undefined && item !== null && item !== "") return item;
      }
      return resolved.default ?? "";
    }

    case "regex_extract": {
      const input = String(resolved.input ?? "");
      const re = new RegExp(String(resolved.pattern || ""), String(resolved.flags || ""));
      const m = re.exec(input);
      const grp = Number.isInteger(Number(resolved.group)) ? Number(resolved.group) : 0;
      if (!m || m[grp] === undefined) return resolved.default ?? "";
      return resolved.stripSpaces ? String(m[grp]).replace(/\s+/g, "") : String(m[grp]);
    }

    case "regex_test": {
      const input = String(resolved.input ?? "");
      if (!resolved.pattern) return false;
      const re = new RegExp(String(resolved.pattern), String(resolved.flags || ""));
      return re.test(input);
    }

    case "regex_replace": {
      let out = String(resolved.input ?? "");
      const rules = Array.isArray(resolved.rules)
        ? resolved.rules
        : [{ pattern: resolved.pattern, flags: resolved.flags ?? "g", replacement: resolved.replacement ?? "" }];
      for (const r of rules) {
        if (!r?.pattern) continue;
        out = out.replace(new RegExp(String(r.pattern), String(r.flags ?? "g")), String(r.replacement ?? ""));
      }
      return resolved.trim !== false ? normalizeSpaces(out) : out;
    }

    case "replace_substrings": {
      let out = String(resolved.input ?? "");
      const subs = Array.isArray(resolved.substrings) ? resolved.substrings : [];
      const rep = String(resolved.replacement ?? "");
      for (const sub of subs) {
        if (sub) out = out.split(String(sub)).join(rep);
      }
      return resolved.trim !== false ? normalizeSpaces(out) : out;
    }

    case "escape_regex_tokens": {
      const input = normalizeSpaces(resolved.input ?? "");
      if (!input) return "";
      const joiner = resolved.joinWith ?? "\\s*";
      return input
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(joiner);
    }

    case "normalize_path":
      return normalizePathSeparators(resolved.input, resolved.separator || " / ");

    case "contains_any": {
      const hay = String(resolved.input ?? "");
      const subs = Array.isArray(resolved.substrings) ? resolved.substrings : [];
      const hit = subs.find((s) => s && hay.includes(String(s)));
      return resolved.returnHit ? (hit ? String(hit) : "") : Boolean(hit);
    }

    case "filter_rows": {
      const rows = Array.isArray(resolved.rows) ? resolved.rows : [];
      const mustIncludeAll = (resolved.mustIncludeAll || []).map(String).filter(Boolean);
      const excludeAny = (resolved.excludeSubstrings || []).map(String).filter(Boolean);
      const invalidAny = (resolved.invalidSubstrings || []).map(String).filter(Boolean);
      const colEquals = resolved.cellEquals && typeof resolved.cellEquals === "object" ? resolved.cellEquals : null;
      const colOneOf = resolved.cellOneOf && typeof resolved.cellOneOf === "object" ? resolved.cellOneOf : null;
      const requireRegex = resolved.mustMatchRegex ? new RegExp(String(resolved.mustMatchRegex)) : null;
      const forbidRegex = resolved.notMatchRegex ? new RegExp(String(resolved.notMatchRegex)) : null;

      const matched = rows.filter((row) => {
        const text = String(row?.text ?? "");
        const links = String(row?.hrefs ?? "");
        const combined = `${text} ${links}`;
        if (excludeAny.some((ex) => combined.includes(ex))) return false;
        if (invalidAny.some((inv) => combined.includes(inv))) return false;
        if (mustIncludeAll.some((inc) => !combined.includes(inc))) return false;
        if (requireRegex && !requireRegex.test(combined)) return false;
        if (colEquals) {
          for (const [colKey, want] of Object.entries(colEquals)) {
            if (String(row?.namedCells?.[colKey] ?? "") !== String(want)) return false;
          }
        }
        if (colOneOf) {
          for (const [colKey, allowed] of Object.entries(colOneOf)) {
            const hasCol = row?.namedCells && Object.prototype.hasOwnProperty.call(row.namedCells, colKey);
            if (hasCol && Array.isArray(allowed) && !allowed.map(String).includes(String(row.namedCells[colKey] ?? ""))) {
              return false;
            }
            if (!hasCol && forbidRegex && forbidRegex.test(combined)) {
              return false;
            }
          }
        } else if (forbidRegex && forbidRegex.test(combined)) {
          return false;
        }
        return true;
      });

      return {
        count: matched.length,
        first: matched[0] || null,
        rows: matched,
      };
    }

    case "match_map_entry": {
      const mapObj = resolved.map && typeof resolved.map === "object" ? resolved.map : {};
      const order = Array.isArray(resolved.keysOrder) && resolved.keysOrder.length > 0
        ? resolved.keysOrder.filter((k) => Object.prototype.hasOwnProperty.call(mapObj, k))
        : Object.keys(mapObj);
      const textLow = String(resolved.text ?? "").toLowerCase();
      const kwField = String(resolved.keywordsField || "matchKeywords");
      const pathField = String(resolved.pathField || "");
      const altPathsField = String(resolved.altPathsField || "");
      const currentPathNorm = normalizePathSeparators(resolved.currentPath ?? "");

      const allAllowedPaths = new Set();
      if (pathField) {
        for (const k of order) {
          const entry = mapObj[k];
          if (entry?.[pathField]) allAllowedPaths.add(normalizePathSeparators(entry[pathField]));
          if (altPathsField && Array.isArray(entry?.[altPathsField])) {
            for (const p of entry[altPathsField]) {
              if (p) allAllowedPaths.add(normalizePathSeparators(p));
            }
          }
        }
      }

      const currentPathAllowed = !currentPathNorm || !pathField || allAllowedPaths.has(currentPathNorm);

      let matchedKey = "";
      let matchedEntry = null;
      for (const k of order) {
        const entry = mapObj[k];
        if (!entry || typeof entry !== "object") continue;
        const kws = Array.isArray(entry[kwField]) ? entry[kwField] : [];
        if (kws.some((kw) => kw && textLow.includes(String(kw).toLowerCase()))) {
          matchedKey = k;
          matchedEntry = entry;
          break;
        }
      }

      let entryPathMatchesCurrent = true;
      let resolvedPath = "";
      if (matchedEntry && pathField) {
        const entryPaths = new Set(
          [
            normalizePathSeparators(matchedEntry[pathField] || ""),
            ...(altPathsField && Array.isArray(matchedEntry[altPathsField])
              ? matchedEntry[altPathsField].map((x) => normalizePathSeparators(x))
              : []),
          ].filter(Boolean),
        );
        if (currentPathNorm && entryPaths.size > 0 && !entryPaths.has(currentPathNorm)) {
          entryPathMatchesCurrent = false;
        }
        resolvedPath =
          currentPathNorm && entryPaths.has(currentPathNorm)
            ? currentPathNorm
            : normalizePathSeparators(matchedEntry[pathField] || "");
      }

      return {
        found: Boolean(matchedEntry),
        key: matchedKey,
        entry: matchedEntry,
        configuredKeys: order,
        configuredKeysText: order.join("、") || "无",
        currentPathNorm,
        currentPathAllowed,
        entryPathMatchesCurrent,
        resolvedPath,
      };
    }

    case "dict_phrase_join": {
      const existing = normalizeSpaces(resolved.existing ?? "");
      const maxLen = Math.max(1, Number(resolved.maxLen) || 120);
      const forbidWords = (resolved.forbidWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
      const hasForbiddenWord = (str) => {
        const low = String(str || "").toLowerCase();
        return forbidWords.some((fw) => low.split(/[^a-z0-9]+/i).includes(fw) || low.includes(fw));
      };

      if (
        resolved.keepExistingAscii !== false &&
        existing.length > 0 &&
        /^[\x20-\x7E]+$/.test(existing) &&
        !hasForbiddenWord(existing)
      ) {
        return existing.length <= maxLen ? existing : existing.slice(0, maxLen).trim();
      }

      const srcText = String(resolved.sourceText ?? "");
      const tokens = [];
      const seenLower = new Set();
      const pushWords = (phrase) => {
        const clean = String(phrase ?? "")
          .replace(/[^\x20-\x7E]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!clean) return;
        for (const word of clean.split(" ")) {
          if (!word || hasForbiddenWord(word)) continue;
          const lw = word.toLowerCase();
          if (seenLower.has(lw)) continue;
          seenLower.add(lw);
          tokens.push(word);
        }
      };

      pushWords(resolved.prefix);
      const dict = Array.isArray(resolved.dictionary)
        ? resolved.dictionary
        : resolved.dictionary && typeof resolved.dictionary === "object"
          ? Object.entries(resolved.dictionary)
          : [];
      for (const pair of dict) {
        const [k, phrase] = Array.isArray(pair) ? pair : [pair?.key ?? pair?.from, pair?.value ?? pair?.to];
        if (k && srcText.includes(String(k))) pushWords(phrase);
      }
      pushWords(resolved.suffix);

      let built = tokens.join(" ").trim();
      if (!built) {
        built = String(resolved.fallback ?? "")
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

    case "uniform_value": {
      const list = Array.isArray(resolved.values) ? resolved.values : [];
      const mode = resolved.mode === "non_neg_int" ? "non_neg_int" : "positive_number";
      if (isUniformList(list, mode)) return String(list[0]).trim();
      return resolved.fallback ?? "";
    }

    case "ordered_dimensions_valid": {
      const lists = Array.isArray(resolved.lists) ? resolved.lists : [];
      if (lists.length === 0 || !lists.every((arr) => isUniformList(arr, "positive_number"))) {
        return false;
      }
      const descIndices = Array.isArray(resolved.nonIncreasingIndices) ? resolved.nonIncreasingIndices : [];
      for (let i = 0; i < descIndices.length - 1; i += 1) {
        const a = Number(lists[descIndices[i]]?.[0]);
        const b = Number(lists[descIndices[i + 1]]?.[0]);
        if (!(a >= b)) return false;
      }
      return true;
    }

    case "merge_unique": {
      const lists = Array.isArray(resolved.lists) ? resolved.lists : [];
      const out = [];
      for (const lst of lists) {
        for (const item of Array.isArray(lst) ? lst : [lst]) {
          const s = String(item ?? "").trim();
          if (s && !out.includes(s)) out.push(s);
        }
      }
      return resolved.limit ? out.slice(0, Number(resolved.limit)) : out;
    }

    case "filter_items": {
      const items = Array.isArray(resolved.items) ? resolved.items : [];
      return items.filter((item) => {
        if (resolved.where && typeof resolved.where === "object") {
          for (const [k, want] of Object.entries(resolved.where)) {
            if (item?.[k] !== want) return false;
          }
        }
        return true;
      });
    }

    case "pluck": {
      const items = Array.isArray(resolved.items) ? resolved.items : [];
      const field = String(resolved.field || "");
      const vals = items.map((it) => it?.[field]).filter((v) => v !== undefined && v !== null && v !== "");
      return resolved.unique ? [...new Set(vals)] : vals;
    }

    case "join": {
      const items = Array.isArray(resolved.items) ? resolved.items : [];
      const filtered = items.map((x) => normalizeSpaces(x)).filter(Boolean);
      if (filtered.length === 0) return resolved.emptyFallback ?? "";
      return filtered.join(String(resolved.separator ?? ", "));
    }

    case "count": {
      const items = resolved.items;
      if (Array.isArray(items)) return items.length;
      if (typeof items === "string") return items.length;
      return 0;
    }

    case "compare": {
      const a = resolved.left;
      const b = resolved.right;
      const cmp = String(resolved.operator || "===");
      if (cmp === "===" || cmp === "==") return a === b;
      if (cmp === "!==" || cmp === "!=") return a !== b;
      if (cmp === ">") return Number(a) > Number(b);
      if (cmp === ">=") return Number(a) >= Number(b);
      if (cmp === "<") return Number(a) < Number(b);
      if (cmp === "<=") return Number(a) <= Number(b);
      return false;
    }

    case "any":
      return (Array.isArray(resolved.values) ? resolved.values : []).some(Boolean);

    case "all":
      return (Array.isArray(resolved.values) ? resolved.values : []).every(Boolean);

    case "not":
      return !resolved.value;

    case "cond":
      return resolved.if ? resolved.then : resolved.else;

    case "plan_field_actions": {
      const fields = Array.isArray(resolved.fields) ? resolved.fields : [];
      const rules = Array.isArray(resolved.rules) ? resolved.rules : [];
      const preserveExisting = resolved.preserveExisting !== false;
      const plans = [];
      const expectedFields = [];
      const unplannedRequiredLabels = [];

      for (const field of fields) {
        if (!field || typeof field !== "object") continue;
        const rawLabel = String(field.label ?? "");
        const cleanLabel = String(field.cleanLabel ?? rawLabel);
        const starred = Boolean(field.starred);
        const selectedItems = Array.isArray(field.selectedItems) ? field.selectedItems.map(String).filter(Boolean) : [];
        const inputValues = Array.isArray(field.inputValues) ? field.inputValues.map(String).filter(Boolean) : [];
        const isFilled = Boolean(field.isFilled || selectedItems.length > 0 || inputValues.length > 0);
        const rule = rules.find(
          (r) => r?.labelIncludes && (cleanLabel.includes(String(r.labelIncludes)) || rawLabel.includes(String(r.labelIncludes))),
        );

        if (rule) {
          const kind = String(rule.kind || "select");
          if (preserveExisting && isFilled) {
            if (kind === "table_select_input") {
              const wantInput = String(rule.inputValue ?? "");
              const okSum = selectedItems.length > 0 && (!wantInput || inputValues.includes(wantInput));
              if (okSum) {
                expectedFields.push({
                  labelIncludes: String(rule.labelIncludes),
                  items: selectedItems,
                  inputs: inputValues,
                });
                continue;
              }
            } else {
              expectedFields.push({
                labelIncludes: String(rule.labelIncludes),
                ...(selectedItems.length > 0 ? { items: selectedItems } : { inputs: inputValues }),
              });
              continue;
            }
          }

          plans.push({
            cleanLabel,
            labelIncludes: String(rule.labelIncludes),
            kind,
            value: rule.value !== undefined ? String(rule.value) : "",
            selectValue: rule.selectValue !== undefined ? String(rule.selectValue) : "",
            inputValue: rule.inputValue !== undefined ? String(rule.inputValue) : "",
            addButtonText: rule.addButtonText ? String(rule.addButtonText) : "",
            needsAddRow: Number(field.selectCount || 0) === 0,
          });
          if (kind === "table_select_input") {
            expectedFields.push({
              labelIncludes: String(rule.labelIncludes),
              items: rule.selectValue ? [String(rule.selectValue)] : undefined,
              inputs: rule.inputValue !== undefined ? [String(rule.inputValue)] : undefined,
            });
          } else if (kind === "input") {
            expectedFields.push({
              labelIncludes: String(rule.labelIncludes),
              inputs: [String(rule.value ?? "")],
            });
          } else {
            expectedFields.push({
              labelIncludes: String(rule.labelIncludes),
              items: [String(rule.value ?? "")],
            });
          }
        } else if (starred) {
          if (isFilled) {
            expectedFields.push({
              labelIncludes: cleanLabel,
              ...(selectedItems.length > 0 ? { items: selectedItems } : { inputs: inputValues }),
            });
          } else {
            unplannedRequiredLabels.push(cleanLabel);
          }
        }
      }

      return {
        plans,
        hasPlans: plans.length > 0,
        expectedFields,
        unplannedRequiredLabels,
        hasUnplannedRequired: unplannedRequiredLabels.length > 0,
        unplannedRequiredText: unplannedRequiredLabels.join("、"),
      };
    }

    default:
      throw new WorkflowError({
        code: "WORKFLOW_UNKNOWN_TRANSFORM",
        blame: "workflow",
        stepIndex: stepCtx.stepIndex || 0,
        stepId: stepCtx.stepId || "",
        op: stepCtx.op || "set_binds",
        expected: "已注册的纯数据变换 $op",
        actual: op,
        message: `未知的数据变换算子: ${op}`,
      });
  }
}

export function applyBindTransforms(transforms = [], binds = {}, stepCtx = {}) {
  const summary = {};
  for (const entry of transforms) {
    if (!entry || typeof entry !== "object") continue;
    const target = String(entry.target || "").trim();
    if (!target) continue;
    const value = entry.expr !== undefined
      ? evaluateDataTransform(entry.expr, binds, stepCtx)
      : interpolateParams(entry.value, binds, stepCtx, { allowMissing: true });
    setBindValue(binds, target, value);
    summary[target] = Array.isArray(value)
      ? `[Array(${value.length})]`
      : value && typeof value === "object"
        ? `[Object(${Object.keys(value).slice(0, 6).join(",")})]`
        : value;
  }
  return summary;
}
