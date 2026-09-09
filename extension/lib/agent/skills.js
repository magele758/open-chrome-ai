/**
 * Chrome-side skills: bundled SKILL.md + user shortcuts.
 * Not Node skill routing; just loadable instruction packs for the loop.
 */

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
  return skills.find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key) || null;
}
