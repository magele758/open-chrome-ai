/** agentTokens 存在 chrome.storage.local 顶层（不在 settings 里，避免随设置导出/被 Agent 设置工具读到）。 */

import { createTokenRecord, normalizeTokenList, publicTokenInfo } from "./auth.js";

export const TOKENS_KEY = "agentTokens";

function area(storage) {
  return storage || globalThis.chrome?.storage?.local;
}

export async function loadAgentTokens(storage) {
  const store = area(storage);
  if (!store) return [];
  const got = await store.get(TOKENS_KEY);
  return normalizeTokenList(got?.[TOKENS_KEY]);
}

let tail = Promise.resolve();

/** 读-改-写串行化：同一页面里快速连点“新建/吊销”不会互相覆盖。 */
function mutate(storage, fn) {
  const run = tail.then(async () => saveAgentTokens(await fn(await loadAgentTokens(storage)), storage));
  tail = run.catch(() => {});
  return run;
}

async function saveAgentTokens(list, storage) {
  const next = normalizeTokenList(list);
  await area(storage).set({ [TOKENS_KEY]: next });
  return next;
}

/** 返回 { token（明文，只此一次）, info }。 */
export async function addAgentToken(spec, { storage, now = Date.now() } = {}) {
  const { token, record } = await createTokenRecord(spec, { now });
  await mutate(storage, (list) => [...list, record]);
  return { token, info: publicTokenInfo(record, now) };
}

export async function revokeAgentToken(id, { storage, now = Date.now() } = {}) {
  return mutate(storage, (list) => list.map((r) => (r.id === id && r.revokedAt == null ? { ...r, revokedAt: now } : r)));
}

export async function removeAgentToken(id, { storage } = {}) {
  return mutate(storage, (list) => list.filter((r) => r.id !== id));
}

export async function listAgentTokens({ storage, now = Date.now() } = {}) {
  return (await loadAgentTokens(storage)).map((r) => publicTokenInfo(r, now));
}
