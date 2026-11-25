const kinds = new Set(["text", "number", "select", "checkbox"]);
const guarded = /认证|证书|合规|专利|品牌|生产商|生产日期|产地|原产|重量|承重|容量|价格|库存|条码|货号|成分比例|危险品|危险货物|过敏|许可证|医疗|条款|同意|电池|price|stock|inventory|origin|licen[sc]e|hazard|dangerous goods|certif|manufacturer|barcode|compliance|weight|capacity|brand|consent|battery|sku/iu;
const expiry = 14 * 24 * 60 * 60 * 1000;
const unique = values => [...new Set(values)];
const text = value => typeof value === "string" ? value.trim() : "";
const filled = value => typeof value === "boolean" || typeof value === "number" ||
  (Array.isArray(value) ? value.some(filled) : Boolean(text(value)));
const choices = value => unique((Array.isArray(value) ? value : []).map(text).filter(item => item && item.length <= 140)).slice(0, 140);

function storageKey(scope, field) {
  const category = scope?.categoryId || (Array.isArray(scope?.categoryPath) && scope.categoryPath.length ? scope.categoryPath : "");
  if (!scope?.platform || !scope.store || !category || !field?.section || !field.key) return "";
  return "listing.options.v1:" + JSON.stringify([scope.platform, scope.store, scope.market || "", category,
    field.section, field.key, field.type, Boolean(field.multiple), field.dependency || ""]);
}

/** Stores option hints only. Each category/field has its own key, so concurrent listings do not rewrite unrelated records. */
export function createListingFieldCache({ storage = globalThis.chrome?.storage?.local, now = Date.now } = {}) {
  return {
    async get(scope, field) {
      const key = storageKey(scope, field);
      if (!storage || !key) return [];
      try {
        const entry = (await storage.get(key))?.[key];
        if (entry?.at > now() - expiry) return choices(entry.options);
        if (entry) await storage.remove(key);
      } catch { /* Cache access never blocks a listing. */ }
      return [];
    },
    async set(scope, field, options) {
      const key = storageKey(scope, field);
      const value = choices(options);
      if (!storage || !key || !value.length) return;
      try { await storage.set({ [key]: { at: now(), options: value } }); } catch { /* The live page remains authoritative. */ }
    },
    async invalidate(scope, field) {
      const key = storageKey(scope, field);
      if (storage && key) try { await storage.remove(key); } catch { /* Revalidate live. */ }
    },
  };
}

export function isAdaptiveField(field, includeOptional = false) {
  return Boolean(field?.key && field.label && kinds.has(field.type) && !guarded.test(field.label) &&
    (field.error || (field.required || includeOptional) && !filled(field.value)));
}

const priority = field => field.error ? 2 : field.required ? 1 : 0;

function verifiedValue(field, raw) {
  if (field.type === "checkbox") return typeof raw === "boolean" ? raw : undefined;
  if (field.type === "select") {
    const values = unique((Array.isArray(raw) ? raw : [raw]).map(text));
    if (!values.length || !field.multiple && values.length !== 1 || !values.every(value => field.options.includes(value))) return;
    return field.multiple ? values : values[0];
  }
  if (field.type === "number") {
    const value = typeof raw === "number" ? raw : /^-?\d+(?:\.\d+)?$/u.test(text(raw)) ? Number(raw) : NaN;
    if (Number.isFinite(value) && (field.min == null || value >= field.min) && (field.max == null || value <= field.max)) return value;
    return;
  }
  const value = text(raw);
  if (["englishTitle", "englishDescription"].includes(field.key) && (!/[a-z]/iu.test(value) || /\p{Script=Han}/u.test(value))) return;
  if (value && value.length <= Math.min(field.maxLength || 500, 500)) return value;
}

/** Runs at most two batched planning rounds, with a live readback after each write. */
export async function recoverListingFields({ scope, snapshot, read, readOptions, apply, suggest, cache = createListingFieldCache(),
  includeOptional = false, signal, onPhase } = {}) {
  const items = [];
  const receipts = [];
  const attempted = new Map();
  const refresh = new Set();
  let state = snapshot;
  for (let round = 0; round < 2; round++) {
    signal?.throwIfAborted();
    if (!state?.ok) break;
    const available = (state.fields || []).filter(field => {
      const previous = attempted.get(field.key);
      return isAdaptiveField(field, includeOptional) &&
        (!previous || includeOptional && previous.emptyOptions && previous.dependency !== field.dependency);
    });
    if (includeOptional) available.sort((a, b) => priority(b) - priority(a));
    const candidates = available.slice(0, 24);
    if (!candidates.length) break;
    const fields = [];
    for (const field of candidates) {
      signal?.throwIfAborted();
      const attempt = { dependency: field.dependency, emptyOptions: false };
      attempted.set(field.key, attempt);
      if (field.type !== "select") { fields.push(field); continue; }
      const cached = refresh.delete(field.key) ? [] : await cache.get(scope, field);
      const options = cached.length ? cached : choices(await readOptions(field));
      attempt.emptyOptions = options.length === 0;
      if (!cached.length && options.length) await cache.set(scope, field, options);
      if (options.length) fields.push({ ...field, options, cached: Boolean(cached.length) });
    }
    if (!fields.length) {
      if (!includeOptional) break;
      continue;
    }
    onPhase?.();
    const proposed = await suggest(fields);
    signal?.throwIfAborted();
    const values = Object.fromEntries(fields.flatMap(field => {
      const value = verifiedValue(field, Object.hasOwn(proposed || {}, field.key) ? proposed[field.key] : undefined);
      return value === undefined ? [] : [[field.key, value]];
    }));
    if (includeOptional) {
      for (const field of fields) {
        if (field.cached && priority(field) && !Object.hasOwn(values, field.key)) {
          refresh.add(field.key);
          attempted.delete(field.key);
        }
      }
    }
    if (!Object.keys(values).length) {
      if (!includeOptional) break;
      continue;
    }
    const result = await apply(values);
    if (!result?.ok) return { state: result, items, issues: receipts };
    items.push(...(result.items || []));
    receipts.push(...(result.issues || []).filter(issue => Object.hasOwn(values, issue.key)));
    for (const field of fields.filter(field => field.cached)) {
      if (result.issues?.some(issue => issue.key === field.key && ["OPTION_MISSING", "OPTION_AMBIGUOUS"].includes(issue.code))) {
        await cache.invalidate(scope, field);
        attempted.delete(field.key);
      }
    }
    state = await read();
  }
  const unresolved = new Set((state?.fields || []).filter(field => field.error ||
    (field.required || includeOptional) && !filled(field.value)).map(field => field.key));
  return { state, items, issues: receipts.filter(issue => unresolved.has(issue.key)) };
}
