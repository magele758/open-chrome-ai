/**
 * Chrome-side skills: bundled SKILL.md + user shortcuts + authorized folder.
 * Folder loading lives in skill-folder.js (separate handle from 文稿夹).
 * Not Node skill routing; just loadable instruction packs for the loop.
 */

import { ensureSkillBody, loadFolderSkills } from "../skill-folder.js";

export function mergeSkills(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const skill of list || []) {
      const id = String(skill?.id || "").trim();
      if (!id) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(skill);
    }
  }
  return out;
}

export async function loadBundledSkillIndex() {
  try {
    const url = chrome.runtime.getURL("skills/index.json");
    const res = await fetch(url);
    if (!res.ok) return [];
    const index = await res.json();
    return (index.skills || [])
      .filter((item) => item?.id)
      .map((item) => ({
        id: item.id,
        name: item.name || item.id,
        when: item.when || "",
        body: "",
        source: "bundled",
      }));
  } catch {
    return [];
  }
}

export async function loadBundledSkills() {
  const extra = [];
  for (const item of await loadBundledSkillIndex()) {
    extra.push(await ensureSkillBody({ ...item }));
  }
  return extra;
}

export function shortcutsAsSkills(settings) {
  return (settings?.shortcuts || [])
    .filter((s) => s.label && s.prompt)
    .map((s) => ({
      id: `user:${s.id}`,
      name: s.label,
      when: `用户点了快捷问题「${s.label}」`,
      body: s.prompt,
    }));
}

export function skillCatalogText(skills) {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.id}：${s.name}${s.when ? `（${s.when}）` : ""}`);
  return `可用 skill（用 load_skill 加载完整说明）：\n${lines.join("\n")}`;
}

export function findSkill(skills, name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  const exact = (skills || []).find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
  if (exact) return exact;
  const suffix = (skills || []).filter((s) => {
    const id = s.id.toLowerCase();
    return id.endsWith(`/${key}`) || id.split("/").pop() === key;
  });
  return suffix.length === 1 ? suffix[0] : null;
}

export async function loadRuntimeSkills({ request = false, timeoutMs } = {}) {
  console.info("[pagelens] skill scan start");
  try {
    const bundled = await loadBundledSkillIndex();
    const folder = await loadFolderSkills({ request, timeoutMs });
    const skills = mergeSkills(bundled, folder.skills);
    console.info("[pagelens] skill scan done", skills.length);
    return { folder, skills };
  } catch (err) {
    console.error("[pagelens] skill scan", err);
    throw err;
  }
}
