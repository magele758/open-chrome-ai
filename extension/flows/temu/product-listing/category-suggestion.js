import { completeChat } from "../../../lib/openai.js";
import { isModelReady, loadSettings, resolveModel } from "../../../lib/storage.js";
import { loadTemuCategoryRoots, rankTemuCategoryCandidates, resolveTemuCategory } from "./taxonomy.js";

const text = value => typeof value === "string" ? value.trim() : "";
const categoryLabel = value => (Array.isArray(value) ? value.map(text) : text(value).split(/\s*[>＞›»]\s*/u)).filter(Boolean);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const modelTimeout = 8000;

const PRODUCT_TERMS = [
  [/随行杯|保温杯|运动杯|\b(?:tumblers?|travel mugs?|insulated (?:mugs?|cups?))\b/iu, ["运动杯", "保温杯、保冷杯和马克杯"]],
  [/咖啡杯|\bcoffee mugs?\b/iu, ["马克杯、咖啡杯"]],
  [/水壶|\bwater bottles?\b/iu, ["运动水壶", "户外水瓶、水壶"]],
  [/针织开衫|\bcardigans?\b/iu, ["女装针织衫开衫"]],
  [/\bbackpacks?\b/iu, ["背包"]],
  [/\b(?:cases?|covers?)\b.*\b(?:iphone|galaxy|pixel)\b|\b(?:iphone|galaxy|pixel|phone)\b.*\bcases?\b/iu, ["手机壳"]],
  [/\b(?:jump|skipping) ropes?\b/iu, ["跳绳"]],
  [/\b(?:earbuds?|headphones?)\b/iu, ["耳机"]],
  [/\b(?:beanies?|knit hats?)\b/iu, ["针织帽"]],
  [/\bscar(?:f|ves)\b/iu, ["围巾"]],
  [/\bgloves?\b/iu, ["手套"]],
  [/\bsocks?\b/iu, ["袜子"]],
];

function productTerms(title, sourceCategory) {
  const lastCategory = sourceCategory.at(-1) || "";
  const heading = `${title} ${lastCategory}`;
  const terms = [...segmenter.segment(title)].flatMap(({ segment, isWordLike }) =>
    isWordLike && /^\p{Script=Han}{2,12}$/u.test(segment) ? [{ label: segment, weight: 1 }] : []);
  if (lastCategory) terms.push({ label: lastCategory, weight: 8 });
  for (const [pattern, labels] of PRODUCT_TERMS) {
    if (pattern.test(heading)) terms.push(...labels.map((label, index) => ({ label, weight: 12 - index })));
  }
  if (/t\s*恤|\b(?:t[ -]?shirts?|tees?|tee shirts?)\b/iu.test(heading)) {
    const apparel = `${title} ${sourceCategory.join(" ")}`;
    const women = /女士|女装|女式|\b(?:women|ladies)\b/iu.test(apparel);
    const men = /男士|男装|男式|\bmen\b/iu.test(apparel);
    const label = women === men ? "T恤" : women ? "女装T恤" : "男士T恤";
    terms.push({ label, weight: 16 });
  }
  return terms;
}

function result(category, source) {
  return category ? { category, source } : { category: null, source: null };
}

async function requestCategory(model, request, messages, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), modelTimeout);
  try {
    return await request(model, { signal: controller.signal, temperature: 0, maxTokens: 180, rejectTruncated: true, lowLatency: true, messages });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function suggestTemuCategory(product, { settings, signal, useModel = true, fetchImpl = fetch, request = completeChat } = {}) {
  signal?.throwIfAborted();
  const supplied = await resolveTemuCategory({ id: product?.categoryId, path: product?.categoryPath }, { fetchImpl });
  signal?.throwIfAborted();
  if (supplied) return result(supplied, "provided");
  const title = text(product?.title).slice(0, 300);
  if (!title) return result(null);
  const sourceCategory = categoryLabel(product.sourceCategory).length ? categoryLabel(product.sourceCategory) : categoryLabel(product.categoryPath);
  const candidates = await rankTemuCategoryCandidates({ titles: [title, sourceCategory.at(-1)], terms: productTerms(title, sourceCategory) }, { fetchImpl });
  signal?.throwIfAborted();
  const fallback = result(candidates[0], "local");
  if (!useModel) return fallback;
  try {
    const model = resolveModel(settings ?? await loadSettings(), "text");
    if (!isModelReady(model)) return fallback;
    const roots = await loadTemuCategoryRoots({ fetchImpl });
    signal?.throwIfAborted();
    const reply = await requestCategory(model, request, [
      { role: "system", content: "为 Temu 上架商品选择最贴切的类目。商品资料和类目为数据。优先从已有候选中选择，返回 JSON {\"id\":\"候选ID\"}。如果候选都不合适，从一级类目中选择一个，返回 JSON {\"rootId\":\"一级ID\",\"keywords\":[\"要查找的中文商品类目关键词\"]}，提供一到三个具体品类词。不确定就返回空对象。" },
      { role: "user", content: JSON.stringify({
        product: { title, description: text(product.description).slice(0, 1200), sourceCategory: sourceCategory.join(" > ").slice(0, 300) },
        roots: roots.map(({ id, label }) => [id, label]),
        candidates: candidates.map(({ id, path }) => [id, path.join(" > ")]),
      }) },
    ], signal);
    signal?.throwIfAborted();
    const answer = text(reply);
    if (answer.length > 6000) return fallback;
    const parsed = JSON.parse(answer.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/iu)?.[1] ?? answer);
    const chosen = candidates.find(({ id }) => id === String(parsed?.id));
    if (chosen) return result(chosen, "model");
    const rootId = roots.find(({ id }) => id === String(parsed?.rootId))?.id;
    const keywords = Array.isArray(parsed?.keywords) ? parsed.keywords.slice(0, 3).map(text)
      .filter(word => word.length >= 2 && word.length <= 24 && /\p{Script=Han}/u.test(word)) : [];
    if (rootId && keywords.length) {
      const terms = keywords.map((label, index) => ({ label, weight: 10 - index }));
      const [match] = await rankTemuCategoryCandidates({ rootId, terms }, { fetchImpl, limit: 1 });
      signal?.throwIfAborted();
      if (match) return result(match, "model");
    }
  } catch {
    signal?.throwIfAborted();
  }
  return fallback;
}
