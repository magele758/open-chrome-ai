const STORAGE_KEY = "pl.temu.productAttributeOptions.v1";
const ATTRIBUTE_KEY = /^productProperties\[\d+\]$/u;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 100;
const MAX_OPTION_COUNT = 100;
const MAX_CACHE_LENGTH = 350_000;

// All listing runs in a panel share the write queue.
let pending = Promise.resolve();

function cacheKey({ site, categoryPath } = {}, field) {
  if (!ATTRIBUTE_KEY.test(field?.key) || typeof field?.label !== "string" || !field.label ||
      (typeof site !== "string" && !Number.isFinite(site)) || !String(site).trim() ||
      !Array.isArray(categoryPath) || !categoryPath.length || categoryPath.length > 12 ||
      categoryPath.some(part => typeof part !== "string" || !part.trim())) return null;
  return JSON.stringify([String(site).trim(), categoryPath.map(part => part.trim()), field.key, field.label]);
}

function cleanOptions(options) {
  if (!Array.isArray(options) || !options.length || options.length > MAX_OPTION_COUNT) return undefined;
  if (options.some(option => typeof option?.label !== "string" || typeof option.value !== "string" ||
      !option.label.trim() || !option.value.trim() || option.label.length > 500 || option.value.length > 1000)) return undefined;
  return options.map(({ label, value, aliases, disabled }) => ({
    label, value,
    ...(Array.isArray(aliases) && { aliases: aliases.filter(alias => typeof alias === "string" && alias.length <= 500).slice(0, 12) }),
    ...(disabled === true && { disabled: true }),
  }));
}

export function createTemuOptionCache({ storage = globalThis.chrome?.storage?.local, now = Date.now } = {}) {
  const isFresh = ({ savedAt } = {}) => Number.isFinite(savedAt) && savedAt <= now() && now() - savedAt < MAX_AGE_MS;

  async function entries() {
    const result = (await storage?.get(STORAGE_KEY))?.[STORAGE_KEY];
    return Array.isArray(result) ? result.filter(entry => entry && typeof entry.key === "string" && isFresh(entry)) : [];
  }

  return {
    async read(scope, field) {
      const key = cacheKey(scope, field);
      if (!key) return undefined;
      try {
        await pending;
        return cleanOptions((await entries()).find(entry => entry.key === key)?.options);
      } catch {
        return undefined;
      }
    },
    async write(scope, field, observed) {
      const key = cacheKey(scope, field);
      const options = cleanOptions(observed);
      if (!key || !options || !storage) return;
      pending = pending.then(async () => {
        const newest = { key, options, savedAt: now() };
        const prior = (await entries()).filter(entry => entry.key !== key);
        const next = [];
        let length = 2;
        for (const entry of [newest, ...prior].slice(0, MAX_ENTRIES)) {
          length += JSON.stringify(entry).length + 1;
          if (length > MAX_CACHE_LENGTH) break;
          next.push(entry);
        }
        if (next.length) await storage.set({ [STORAGE_KEY]: next });
      }).catch(() => {});
      await pending;
    },
  };
}
