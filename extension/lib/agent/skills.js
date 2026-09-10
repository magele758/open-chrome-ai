/**
 * Chrome-side skills: bundled SKILL.md + user shortcuts + authorized folder.
 * Folder loading lives in skill-folder.js (separate handle from 文稿夹).
 * Not Node skill routing; just loadable instruction packs for the loop.
 */

import { loadFolderSkills } from "../skill-folder.js";

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

export async function loadBundledSkills() {
  const extra = [];
  try {
    const url = chrome.runtime.getURL("skills/index.json");
    const res = await fetch(url);
    if (res.ok) {
      const index = await res.json();
      for (const item of index.skills || []) {
        const mdUrl = chrome.runtime.getURL(`skills/${item.id}/SKILL.md`);
        const md = await fetch(mdUrl).then((r) => (r.ok ? r.text() : "")).catch(() => "");
        if (md) extra.push({ id: item.id, name: item.name || item.id, when: item.when || "", body: md });
      }
    }
  } catch {
    /* packaged files optional */
  }
  const seen = new Set();
  const out = [];
  for (const s of extra) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
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

export async function loadRuntimeSkills({ request = false } = {}) {
  const bundled = await loadBundledSkills();
  const folder = await loadFolderSkills({ request });
  return {
    folder,
    skills: mergeSkills(bundled, folder.skills),
  };
}
