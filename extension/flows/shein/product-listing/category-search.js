const maximumKeywords = 6;
const maximumCandidates = 16;
const maximumCachedCandidates = 12;
const maximumEntries = 96;
const retention = 90 * 24 * 60 * 60 * 1000;
const missCodes = new Set(["CATEGORY_SEARCH_NO_MATCH", "CATEGORY_SEARCH_EMPTY", "CATEGORY_SEARCH_UNCERTAIN"]);
const clean = value => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
const fold = value => clean(value).toLowerCase();
const list = value => Array.isArray(value) ? value : [value];
const pathKey = path => JSON.stringify(path.map(fold));
const validKeyword = value => Boolean(value && value.length <= 70 && !/[\u0000-\u001f\u007f]/u.test(value));
const validPath = value => Array.isArray(value) && value.length >= 2 && value.length <= 8 &&
  value.every(part => typeof part === "string" && clean(part) && clean(part).length <= 90);
const fail = (code, message) => ({ ok: false, code, message });

function keywords(values) {
  const unique = new Map();
  for (const value of values.map(clean).filter(validKeyword)) {
    if (!unique.has(fold(value))) unique.set(fold(value), value);
  }
  return [...unique.values()];
}

function storageKey(storeKey) {
  return /^(?:GS\d{4,20})$/iu.test(storeKey) ? `pagelens.shein.category-keywords.v2.${storeKey.toUpperCase()}` : "";
}

async function readEntries(storage, key) {
  if (!key || !storage?.get) return [];
  try {
    const data = (await storage.get(key))?.[key];
    const loaded = Array.isArray(data) ? data : [];
    const now = Date.now();
    return loaded.filter(entry => validKeyword(clean(entry?.keyword)) && validPath(entry?.path) &&
      Number.isFinite(entry?.learnedAt) && entry.learnedAt <= now && now - entry.learnedAt <= retention)
      .slice(0, maximumEntries);
  } catch {
    return [];
  }
}

async function remember(storage, key, keyword, path) {
  if (!key || !storage?.set || !validPath(path)) return;
  try {
    const current = await readEntries(storage, key);
    const entries = [{ keyword, path, learnedAt: Date.now() }, ...current.filter(entry => pathKey(entry.path) !== pathKey(path))];
    await storage.set({ [key]: entries.slice(0, maximumEntries) });
  } catch {
    // A browser storage quota error does not invalidate the seller's visible category receipt.
  }
}

/** Seed a manually selected or explicitly supplied category from its verified page receipt. */
export async function rememberVerifiedSheinCategory(storage, receipt) {
  const path = receipt?.selectedPath;
  const key = storageKey(clean(receipt?.storeKey));
  if (!receipt?.ok || !receipt.canAdvance || !key || !validPath(path)) return;
  const existing = await readEntries(storage, key);
  if (!existing.some(entry => pathKey(entry.path) === pathKey(path))) {
    await remember(storage, key, path.at(-1), path);
  }
}

function containsKeyword(facts, keyword) {
  if (/\p{Script=Han}/u.test(keyword)) return facts.includes(keyword);
  const escaped = keyword.replace(/[.*+?^$${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(facts);
}

/** The supplied page adapter is pinned to the active SHEIN category tab. */
export async function resolveSheinCategory({ callPage, input = {}, suggestKeywords, chooseCategory, chooseCachedCategory,
  storage, signal } = {}) {
  signal?.throwIfAborted();
  const requestedBrand = clean(input.shein?.brand ?? input.brand);
  const brand = /^(?:无品牌|nobrand|unbranded)$/iu.test(requestedBrand) ? "" : requestedBrand;
  const selected = await callPage({ kind: "inspect" });
  if (!selected.ok || selected.selectedPath?.length) return selected;

  const storeKey = clean(selected.storeKey);
  const cacheKey = storageKey(storeKey);
  const remembered = await readEntries(storage, cacheKey);
  const title = clean(input.title ?? input.englishTitle ?? input.shein?.englishTitle);
  const description = clean(input.description ?? input.englishDescription ?? input.shein?.englishDescription);
  const sourceCategories = [...list(input.category), ...list(input.shein?.category)];
  const sourcePaths = sourceCategories.map(value => clean(value).split(/\s*[>/›＞]\s*/u)).filter(validPath);
  const hints = [...list(input.categoryKeywords), ...list(input.shein?.categoryKeywords), ...list(input.categoryHint),
    ...sourceCategories.flatMap(value => clean(value).split(/\s*[>/›＞]\s*/u).slice(-2).reverse())];
  const facts = [title, description.slice(0, 2000), ...hints].map(fold).join(" ");
  const matched = remembered.filter(entry => containsKeyword(facts, fold(entry.keyword)))
    .sort((a, b) => b.keyword.length - a.keyword.length);
  const cached = matched.slice(0, 2).map(entry => entry.keyword);
  const specificTitle = /^(?:[A-Za-z0-9]+[ -])?\p{Script=Han}{2,8}$/u.test(title) ? [title] : [];
  const modelEvidence = { title, description, sourceCategories: keywords(sourceCategories), hints: keywords(hints), signal };
  const attempted = new Set();
  const candidatesByPath = new Map();
  const searchPage = request => callPage({ kind: "search", brand, sourcePaths, ...request,
    ...(cacheKey && { storeKey }) });
  const matchesLeaf = ({ keyword, path }) => fold(path.at(-1)) === fold(keyword);
  const rankedCandidates = () => [...candidatesByPath.values()].sort((a, b) => Number(matchesLeaf(b)) - Number(matchesLeaf(a)));
  const notConfirmed = () => fail("CATEGORY_NOT_CONFIRMED", "SHEIN 未回显识别出的末级分类，请核对当前分类。");

  function unresolved() {
    if (!candidatesByPath.size) {
      return fail("CATEGORY_SEARCH_NO_MATCH", "SHEIN 搜索未找到可用的末级分类，请核对商品分类。");
    }
    const suggestions = rankedCandidates().slice(0, 4).map(({ path }) => path);
    const names = [...new Set(suggestions.map(path => path.at(-1)))].join("、");
    return { ...fail("CATEGORY_SEARCH_UNCERTAIN", `SHEIN 返回了「${names}」等类目，请在分类页选择与商品匹配的末级分类。`),
      suggestions };
  }

  async function ask(model, candidates) {
    if (typeof model !== "function") return null;
    signal?.throwIfAborted();
    try {
      const result = await model({ ...modelEvidence, ...(candidates && { candidates: candidates.map(({ path }) => [...path]) }) });
      signal?.throwIfAborted();
      return result;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }

  async function selectCandidate(candidates, index) {
    signal?.throwIfAborted();
    const choice = Number.isInteger(index) && candidates[index];
    if (!choice) return null;
    const current = await callPage({ kind: "inspect" });
    if (!current.ok || current.selectedPath?.length) return current;
    if (clean(current.storeKey) !== storeKey) return fail("CATEGORY_STORE_CHANGED", "当前 SHEIN 店铺已切换，请重新开始商品流程。");
    signal?.throwIfAborted();
    const receipt = await searchPage({ keyword: choice.keyword, categoryPath: choice.path });
    signal?.throwIfAborted();
    if (!receipt.ok) return missCodes.has(receipt.code) ? null : receipt;
    if (!receipt.canAdvance || !validPath(receipt.selectedPath) || pathKey(receipt.selectedPath) !== pathKey(choice.path)) {
      return notConfirmed();
    }
    if (cacheKey && clean(receipt.storeKey) === storeKey) await remember(storage, cacheKey, choice.keyword, receipt.selectedPath);
    return receipt;
  }

  function addCandidates(paths, keyword) {
    for (const path of list(paths).filter(validPath).slice(0, maximumCandidates)) {
      const key = pathKey(path);
      if (!candidatesByPath.has(key) || matchesLeaf({ keyword, path })) candidatesByPath.set(key, { path, keyword });
    }
  }

  async function search(candidates, { probe = false } = {}) {
    for (const keyword of keywords(candidates)) {
      const key = fold(keyword);
      if (attempted.has(key)) continue;
      if (attempted.size === maximumKeywords) break;
      attempted.add(key);
      signal?.throwIfAborted();
      const cachedExactPaths = remembered.filter(entry => fold(entry.keyword) === key && matchesLeaf(entry));
      const receipt = await searchPage(probe ? { keyword, probe: true } :
        { keyword, preferredPath: cachedExactPaths.length === 1 ? cachedExactPaths[0].path : undefined });
      signal?.throwIfAborted();
      if (probe && receipt.ok) {
        addCandidates(receipt.suggestions, keyword);
        continue;
      }
      if (receipt.ok) {
        if (!receipt.canAdvance || !validPath(receipt.selectedPath)) return notConfirmed();
        if (cacheKey && clean(receipt.storeKey) === storeKey) await remember(storage, cacheKey, keyword, receipt.selectedPath);
        return receipt;
      }
      if (!missCodes.has(receipt.code)) return receipt;
      if (receipt.code === "CATEGORY_SEARCH_UNCERTAIN") addCandidates(receipt.suggestions, keyword);
    }
    return null;
  }

  if (typeof chooseCategory === "function") {
    const seen = new Set();
    const cacheCandidates = [...matched, ...remembered].filter(({ path }) => {
      const key = pathKey(path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, maximumCachedCandidates);
    const cachedDecision = cacheCandidates.length ? await ask(chooseCachedCategory, cacheCandidates) : null;
    const cachedReceipt = await selectCandidate(cacheCandidates, cachedDecision?.index);
    if (cachedReceipt) return cachedReceipt;

    let proposed = keywords(list(cachedDecision?.keywords));
    if (!proposed.length) {
      const suggestion = await ask(suggestKeywords);
      proposed = keywords(list(Array.isArray(suggestion) ? suggestion : suggestion?.keywords));
    }
    const interrupted = await search([...proposed.slice(0, 3), ...hints, ...specificTitle], { probe: true });
    if (interrupted) return interrupted;
    if (!candidatesByPath.size) {
      const lastChance = await search([title], { probe: true });
      if (lastChance) return lastChance;
    }
    const candidates = rankedCandidates().slice(0, maximumCandidates);
    if (!candidates.length) return unresolved();
    const index = await ask(chooseCategory, candidates);
    return (await selectCandidate(candidates, index)) || unresolved();
  }

  const direct = await search(keywords([...hints, ...cached, ...specificTitle]).slice(0, 3));
  if (direct) return direct;
  let suggested = [];
  if (typeof suggestKeywords === "function") {
    try {
      const result = await suggestKeywords({ title, description, sourceCategories: keywords(sourceCategories), signal });
      suggested = Array.isArray(result) ? result : result?.keywords ?? [];
    } catch (error) {
      signal?.throwIfAborted();
      const exactTitle = await search([title]);
      return exactTitle || (candidatesByPath.size ? unresolved() :
        fail("CATEGORY_MODEL_UNAVAILABLE", error?.message || "暂时无法生成商品分类关键词。"));
    }
  }
  const found = await search([...hints, ...list(suggested).slice(0, maximumKeywords), title]);
  return found || unresolved();
}
