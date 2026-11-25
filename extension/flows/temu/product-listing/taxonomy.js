const DATA = new URL("./taxonomy/", import.meta.url);
const caches = new WeakMap();
const text = value => typeof value === "string" ? value.trim() : Number.isSafeInteger(value) ? String(value) : "";
const key = value => text(value).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const searchParts = value => text(value).normalize("NFKC").toLowerCase().split(/[\p{P}\p{S}\s]+/u).filter(Boolean);
const categoryOption = ([id, label, children]) => ({ id: String(id), label, leaf: !children?.length });

function resource(file, fetchImpl, decode) {
  const cache = caches.get(fetchImpl) ?? new Map();
  caches.set(fetchImpl, cache);
  if (!cache.has(file)) {
    const pending = (async () => {
      const response = await fetchImpl(new URL(file, DATA));
      if (!response.ok) throw new Error("无法加载插件内置的 Temu 目录。");
      return decode(response);
    })().catch(error => {
      cache.delete(file);
      throw error;
    });
    cache.set(file, pending);
  }
  return cache.get(file);
}

function unpackLeaves(node, prefix = [], ancestors = [], leaves = []) {
  const [id, label, children] = node;
  const path = [...prefix, label];
  const ids = [...ancestors, String(id)];
  if (children?.length) {
    for (const child of children) unpackLeaves(child, path, ids, leaves);
  } else {
    leaves.push({ id: String(id), path, ids, name: key(label), full: key(path.join(" ")) });
  }
  return leaves;
}

const readJson = response => response.json();
async function readCategory(response) {
  return { tree: await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json() };
}

export async function loadTemuCategoryRoots({ fetchImpl = fetch } = {}) {
  const roots = await resource("roots.json", fetchImpl, readJson);
  return roots.map(([id, label, leaf]) => ({ id: String(id), label, leaf: leaf === true }));
}

export async function loadTemuCategoryChildren(ancestorIds, { fetchImpl = fetch } = {}) {
  const [rootId, ...children] = ancestorIds.map(text);
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  if (!ancestorIds.length) return roots;
  if (!roots.some(root => root.id === rootId)) return [];
  const { tree } = await resource(`category-${rootId}.json.gz`, fetchImpl, readCategory);
  const node = children.reduce((parent, id) => parent?.[2]?.find(child => String(child[0]) === id), tree);
  return (node?.[2] ?? []).map(categoryOption);
}

async function loadLeaves(roots, fetchImpl) {
  const branches = await Promise.all(roots.map(({ id }) => resource(`category-${id}.json.gz`, fetchImpl, readCategory)));
  return branches.map(branch => branch.leaves ??= unpackLeaves(branch.tree));
}

function copyCategory({ id, path, ids }, withIds = true) {
  return { id, path: [...path], ...(withIds && { ids: [...ids] }) };
}

function rank(entry, value, tokens) {
  if (entry.id === value) return 6;
  if (entry.full === value) return 5;
  if (entry.name === value) return 4;
  if (entry.name.startsWith(value)) return 3;
  if (entry.name.includes(value)) return 2;
  return tokens.every(part => entry.full.includes(part)) ? 1 : 0;
}

export async function searchTemuCategories(query, { rootId, limit = 30, fetchImpl = fetch, withIds = false } = {}) {
  const value = key(query);
  const max = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 30;
  if ((!value && !rootId) || !max) return [];
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  let selected = rootId == null ? roots : roots.filter(root => root.id === String(rootId));
  if (rootId == null) {
    // A full breadcrumb starts with its top-level label, so it needs only one shard.
    const matchingRoots = roots.filter(root => value.startsWith(key(root.label)));
    if (matchingRoots.length) selected = matchingRoots;
  }
  const branches = await loadLeaves(selected, fetchImpl);
  const tokens = searchParts(query);
  const matches = [];
  for (const branch of branches) {
    for (const entry of branch) {
      const score = value ? rank(entry, value, tokens) : 1;
      if (score) matches.push({ entry, score });
    }
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, max)
    .map(({ entry }) => copyCategory(entry, withIds));
}

export async function resolveTemuCategory({ id, path } = {}, { fetchImpl = fetch } = {}) {
  const names = Array.isArray(path) ? path.map(text).filter(Boolean) : text(path).split(/\s*[>＞›»]\s*/u).filter(Boolean);
  const categoryId = text(id);
  if (!categoryId && !names.length) return null;
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  const branch = names.length ? roots.filter(root => key(root.label) === key(names[0])) : roots;
  const branches = await loadLeaves(branch, fetchImpl);
  for (const entries of branches) {
    const match = entries.find(entry => (!categoryId || entry.id === categoryId) &&
      (!names.length || names.length === entry.path.length && names.every((name, index) => key(name) === key(entry.path[index]))));
    if (match) return copyCategory(match);
  }
  return null;
}

export async function rankTemuCategoryCandidates({ titles = [], terms = [], rootId } = {}, { fetchImpl = fetch, limit = 24 } = {}) {
  const headings = titles.map(key).filter(Boolean);
  const hints = terms.map(({ label, weight }) => ({ value: key(label), weight })).filter(({ value }) => value.length >= 2);
  if (!headings.length && !hints.length) return [];
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  const branches = await loadLeaves(rootId ? roots.filter(root => root.id === text(rootId)) : roots, fetchImpl);
  const matches = [];
  for (const entries of branches) {
    for (const entry of entries) {
      let score = entry.name.length >= 2 && headings.some(title => title.includes(entry.name)) ? 5 + Math.min(8, entry.name.length) : 0;
      for (const { value, weight } of hints) {
        if (entry.name === value) score = Math.max(score, weight + 6);
        else if (entry.name.includes(value)) score = Math.max(score, weight + 2);
      }
      if (score) matches.push({ score, entry });
    }
  }
  return matches.sort((left, right) => right.score - left.score || left.entry.path.length - right.entry.path.length)
    .slice(0, limit).map(({ entry }) => copyCategory(entry));
}

export async function loadTemuOrigins({ fetchImpl = fetch } = {}) {
  const rows = await resource("origins.json", fetchImpl, readJson);
  return rows.map(([country, aliases, regions]) => ({ country, aliases: [...aliases], regions: [...regions] }));
}

export function resolveTemuOrigin(origins, { country, region } = {}) {
  const name = key(country);
  if (!name) return null;
  const normalizedCountry = name === "中国" ? "中国大陆" : name;
  const entry = origins.find(({ country, aliases }) => [country, ...aliases].some(alias => key(alias) === normalizedCountry));
  if (!entry) return null;
  const normalizedRegion = value => key(value).replace(/(?:壮族自治区|维吾尔自治区|回族自治区|自治区|省|市)$/u, "");
  const nameOfRegion = normalizedRegion(region);
  const matchedRegion = nameOfRegion && entry.regions.find(candidate => normalizedRegion(candidate) === nameOfRegion);
  return { country: entry.country, ...(matchedRegion && { region: matchedRegion }) };
}
