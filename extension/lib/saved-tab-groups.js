/**
 * PageLens 插件内「已保存标签组」持久化存储（chrome.storage.local）。
 * 与 Chrome 原生保存组（Sync Data/LevelDB）互补：支持零系统权限、跨会话的完整增删改查与一键收纳/恢复。
 */

import { isHttpUrl } from "./chrome.js";

export const SAVED_GROUPS_KEY = "savedTabGroups";
export const SAVED_GROUPS_USE_HELPER_KEY = "savedGroupsUseHelper";
export const MAX_SAVED_GROUPS = 200;
export const MAX_TABS_PER_GROUP = 100;
const MAX_TITLE = 64;

const VALID_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

let writeTail = Promise.resolve();

function serialize(fn) {
  // A side panel in another window or the service worker can update the same
  // storage array concurrently. Keep the entire read/modify/write under one lock.
  if (globalThis.navigator?.locks) return navigator.locks.request(SAVED_GROUPS_KEY, fn);
  const next = writeTail.then(fn, fn);
  writeTail = next.catch(() => {});
  return next;
}

function defaultStorage() {
  return globalThis.chrome?.storage?.local || null;
}

export async function isSavedGroupsHelperEnabled(storage = defaultStorage()) {
  try {
    const prefs = await storage?.get(SAVED_GROUPS_USE_HELPER_KEY);
    return prefs?.[SAVED_GROUPS_USE_HELPER_KEY] === true;
  } catch {
    return false;
  }
}

function makeId() {
  if (typeof crypto?.randomUUID === "function") return `stg_${crypto.randomUUID().slice(0, 12)}`;
  return `stg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeSavedTitle(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

export function normalizeSavedColor(raw, fallback = "blue") {
  const c = String(raw || "").trim().toLowerCase();
  return VALID_COLORS.has(c) ? c : fallback;
}

export function normalizeSavedTabs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_TABS_PER_GROUP) break;
    const url = typeof item === "string" ? item.trim() : String(item?.url || "").trim();
    if (!isHttpUrl(url)) continue;
    const title = typeof item === "string" ? "" : String(item?.title || "").replace(/\s+/g, " ").trim().slice(0, 160);
    out.push({ url, title });
  }
  return out;
}

export function normalizeSavedGroupRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const tabs = normalizeSavedTabs(raw.tabs);
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : createdAt;
  return {
    id,
    title: normalizeSavedTitle(raw.title),
    color: normalizeSavedColor(raw.color, "grey"),
    tabs,
    tabCount: tabs.length,
    createdAt,
    updatedAt,
    source: "pagelens",
  };
}

export async function loadSavedTabGroups(storage = defaultStorage()) {
  if (!storage || typeof storage.get !== "function") return [];
  const data = await storage.get(SAVED_GROUPS_KEY);
  const raw = data?.[SAVED_GROUPS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSavedGroupRecord).filter(Boolean);
}

async function persistSavedTabGroups(list, storage = defaultStorage()) {
  if (!storage || typeof storage.set !== "function") throw new Error("chrome.storage.local 不可用。");
  const clean = list.slice(0, MAX_SAVED_GROUPS).map((g) => ({
    id: g.id,
    title: g.title,
    color: g.color,
    tabs: g.tabs,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));
  await storage.set({ [SAVED_GROUPS_KEY]: clean });
}

export async function listSavedTabGroups({ query, color, storage = defaultStorage() } = {}) {
  const all = await loadSavedTabGroups(storage);
  const needle = String(query || "").trim().toLowerCase();
  const colorFilter = String(color || "").trim().toLowerCase();
  return all.filter((g) => {
    if (colorFilter && g.color !== colorFilter) return false;
    if (needle) {
      const hay = `${g.title} ${g.tabs.map((t) => `${t.title} ${t.url}`).join(" ")}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export async function getSavedTabGroup(id, { storage = defaultStorage() } = {}) {
  const target = String(id || "").trim();
  if (!target) return null;
  const all = await loadSavedTabGroups(storage);
  return all.find((g) => g.id === target) || null;
}

export async function saveTabGroupRecord({ id, title, color, tabs }, { storage = defaultStorage(), now = () => Date.now() } = {}) {
  const cleanTabs = normalizeSavedTabs(tabs);
  if (!cleanTabs.length) throw new Error("至少需要一个有效的 http(s) 标签 URL 才能保存标签组。");
  const cleanTitle = normalizeSavedTitle(title);
  if (!cleanTitle) throw new Error("保存标签组需要提供标题（title）。");
  const cleanColor = normalizeSavedColor(color, "blue");

  return serialize(async () => {
    const all = await loadSavedTabGroups(storage);
    const ts = now();
    const targetId = String(id || "").trim();
    const idx = targetId ? all.findIndex((g) => g.id === targetId) : -1;
    let record;
    if (idx >= 0) {
      record = normalizeSavedGroupRecord({
        ...all[idx],
        title: cleanTitle,
        color: cleanColor,
        tabs: cleanTabs,
        updatedAt: ts,
      });
      all[idx] = record;
    } else {
      if (all.length >= MAX_SAVED_GROUPS) throw new Error(`已保存标签组数量已达上限（${MAX_SAVED_GROUPS}）。`);
      record = normalizeSavedGroupRecord({
        id: targetId || makeId(),
        title: cleanTitle,
        color: cleanColor,
        tabs: cleanTabs,
        createdAt: ts,
        updatedAt: ts,
      });
      all.unshift(record);
    }
    await persistSavedTabGroups(all, storage);
    return { record, replaced: idx >= 0 };
  });
}

export async function updateSavedTabGroupRecord(
  id,
  { title, color, tabs, addTabs, removeUrls } = {},
  { storage = defaultStorage(), now = () => Date.now() } = {},
) {
  const targetId = String(id || "").trim();
  if (!targetId) throw new Error("需要提供已保存标签组的 id。");

  return serialize(async () => {
    const all = await loadSavedTabGroups(storage);
    const idx = all.findIndex((g) => g.id === targetId);
    if (idx < 0) throw new Error(`找不到已保存标签组：${targetId}`);
    const prev = all[idx];
    let nextTabs = prev.tabs.slice();
    if (tabs !== undefined) {
      nextTabs = normalizeSavedTabs(tabs);
    }
    if (Array.isArray(addTabs) && addTabs.length) {
      const additions = normalizeSavedTabs(addTabs);
      nextTabs = [...nextTabs, ...additions].slice(0, MAX_TABS_PER_GROUP);
    }
    if (Array.isArray(removeUrls) && removeUrls.length) {
      const drop = new Set(removeUrls.map((u) => String(u || "").trim()).filter(Boolean));
      nextTabs = nextTabs.filter((t) => !drop.has(t.url));
    }
    if (!nextTabs.length) throw new Error("更新后的标签组至少要保留一个有效的 http(s) URL（如需删除请用 delete_saved_tab_group）。");

    const nextTitle = title !== undefined ? normalizeSavedTitle(title) : prev.title;
    if (!nextTitle) throw new Error("标签组标题不能为空。");
    const nextColor = color !== undefined ? normalizeSavedColor(color, prev.color) : prev.color;

    const record = normalizeSavedGroupRecord({
      ...prev,
      title: nextTitle,
      color: nextColor,
      tabs: nextTabs,
      updatedAt: now(),
    });
    all[idx] = record;
    await persistSavedTabGroups(all, storage);
    return record;
  });
}

export async function deleteSavedTabGroupRecord(id, { storage = defaultStorage() } = {}) {
  const targetId = String(id || "").trim();
  if (!targetId) throw new Error("需要提供已保存标签组的 id。");

  return serialize(async () => {
    const all = await loadSavedTabGroups(storage);
    const idx = all.findIndex((g) => g.id === targetId);
    if (idx < 0) throw new Error(`找不到已保存标签组：${targetId}`);
    const [removed] = all.splice(idx, 1);
    await persistSavedTabGroups(all, storage);
    return removed;
  });
}
